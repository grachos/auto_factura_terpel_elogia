import { randomUUID } from 'node:crypto';
import { audit } from '../../audit.js';
import { decryptSecret, encryptSecret } from '../../crypto.js';
import type { Db } from '../../db/types.js';
import { AppError } from '../../errors.js';
import { log } from '../../logger.js';
import { SilogWebClient } from './client.js';
import { SilogWebError } from './errors.js';
import type { WafSolver } from './waf.js';

export interface WebSessionDeps {
  db: Db;
  encryptionKey: string;
  baseUrl: string;
  waf: WafSolver | null;
  fetchFn?: typeof fetch;
}

const LOCK_SECONDS = 120;

export type WebPurpose = 'adjust' | 'invoice';

export interface OpenedSession {
  client: SilogWebClient;
  reused: boolean;
  /** Persiste las cookies (cifradas) y libera el bloqueo. Llamar SIEMPRE (finally). */
  close(): Promise<void>;
}

/**
 * Abre una sesión web con la cuenta de servicio `purpose`:
 * bloquea (no hay dos logins simultáneos de la misma cuenta), reutiliza las cookies cifradas si siguen sirviendo y,
 * si no, hace login (la contraseña se descifra solo en memoria). Máximo UN reintento y solo ante errores transitorios.
 */
export async function openWebSession(deps: WebSessionDeps, purpose: WebPurpose, actor: string | null): Promise<OpenedSession> {
  if (!deps.baseUrl) throw new AppError(503, 'SILOG_NOT_CONFIGURED', 'Falta SILOG_BASE_URL en el servidor');
  const cred = await deps.db.query<{ id: string; silog_user: string; password_enc: string }>(
    'select id, silog_user, password_enc from silog_credentials where purpose = $1', [purpose],
  );
  const c = cred.rows[0];
  if (!c) throw new AppError(409, 'ADJUST_ACCOUNT_NOT_CONFIGURED', 'No hay cuenta de servicio configurada (Usuarios → Cuenta de ajustes)');
  const password = decryptSecret(c.password_enc, c.id, deps.encryptionKey); // solo en memoria

  const owner = randomUUID();
  await deps.db.query(`insert into silog_web_sessions (purpose) values ($1) on conflict (purpose) do nothing`, [purpose]);
  const got = await deps.db.query(
    `update silog_web_sessions set lock_owner = $2, lock_until = now() + ($3 || ' seconds')::interval
      where purpose = $1 and (lock_until is null or lock_until < now()) returning id`,
    [purpose, owner, String(LOCK_SECONDS)],
  );
  if (got.rowCount === 0) throw new SilogWebError('WEB_SESSION_BUSY', 'La cuenta de servicio ya tiene una sesión en uso. Intente de nuevo en un momento.', 409);

  const client = new SilogWebClient({ baseUrl: deps.baseUrl, waf: deps.waf, fetchFn: deps.fetchFn });
  const release = async (code: string | null): Promise<void> => {
    await deps.db.query(`update silog_web_sessions set lock_owner = null, lock_until = null, last_error_code = $3, updated_at = now() where purpose = $1 and lock_owner = $2`, [purpose, owner, code]);
  };
  try {
    const row = await deps.db.query<{ id: string; cookies_enc: string | null }>('select id, cookies_enc from silog_web_sessions where purpose = $1', [purpose]);
    const sid = row.rows[0]?.id as string;
    let reused = false;
    if (row.rows[0]?.cookies_enc) {
      try {
        client.importCookies(JSON.parse(decryptSecret(row.rows[0].cookies_enc, sid, deps.encryptionKey)) as Record<string, string>);
        reused = await client.isLoggedIn();
      } catch (e) {
        if (e instanceof AppError) client.importCookies(null); // cookies ilegibles: se descartan
        else if (e instanceof SilogWebError && e.code !== 'WEB_WAF_FAILED') client.importCookies(null);
        else if (e instanceof SilogWebError) throw e;
        reused = false;
      }
    }
    let loggedIn = reused;
    if (!reused) {
      for (let attempt = 0; attempt < 2 && !loggedIn; attempt += 1) {
        try {
          await client.login(c.silog_user, password);
          loggedIn = true;
        } catch (e) {
          const transient = e instanceof SilogWebError && (e.code === 'WEB_UNREACHABLE' || e.code === 'WEB_HTTP_ERROR');
          if (!transient || attempt === 1) throw e; // rechazo, cambio de clave, 2FA, WAF: sin reintento
        }
      }
      await deps.db.query('update silog_web_sessions set last_login_at = now() where id = $1', [sid]);
    }
    await audit(deps.db, actor, 'silog_web.session', 'silog_web_session', sid, { purpose, reused });
    log('silog_web.session', { purpose, reused });
    return {
      client, reused,
      close: async () => {
        try {
          const enc = encryptSecret(JSON.stringify(client.exportCookies()), sid, deps.encryptionKey);
          await deps.db.query(`update silog_web_sessions set cookies_enc = $2, cookies_updated_at = now() where id = $1`, [sid, enc]);
        } finally {
          await release(null);
        }
      },
    };
  } catch (e) {
    try {
      // Conserva solo las cookies del WAF (resolver el reto es lo costoso); nunca la sesión de un login fallido.
      if (client.wafSolved) {
        const waf = Object.fromEntries(Object.entries(client.exportCookies()).filter(([k]) => k.toLowerCase().startsWith('aws-waf')));
        const sid = (await deps.db.query<{ id: string }>('select id from silog_web_sessions where purpose = $1', [purpose])).rows[0]?.id;
        if (sid) await deps.db.query('update silog_web_sessions set cookies_enc = $2, cookies_updated_at = now() where id = $1', [sid, encryptSecret(JSON.stringify(waf), sid, deps.encryptionKey)]);
      }
    } finally {
      await release(e instanceof SilogWebError ? e.code : 'ERROR');
    }
    throw e;
  }
}
