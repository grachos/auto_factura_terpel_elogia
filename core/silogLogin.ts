import { audit } from './audit.js';
import {
  MAX_IP_FAILS, MAX_USER_FAILS, UNIFORM_LOGIN_MESSAGE, APP_SESSION_SECONDS, blockedSeconds, clearFailures, ipKey, issueAppToken, recordFailure,
  sessionSecret, userKey,
} from './appAuth.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { log } from './logger.js';
import type { AppRole } from './permissions.js';
import { permissionsOf } from './permissions.js';

export interface SilogLoginInput {
  usuario: unknown;
  clave: unknown;
  ip: string;
}

interface Row { id: string; silog_user: string; display_name: string | null; company: string | null; role: AppRole; active: boolean; session_version: number }

function uniform(): AppError {
  return new AppError(401, 'BAD_CREDENTIALS', UNIFORM_LOGIN_MESSAGE);
}

/**
 * Ingreso con usuario de Silogtran. Orden deliberado:
 * 1) configuración, 2) formato, 3) bloqueo por intentos (BD), 4) usuario registrado y activo, 5) clave contra Silogtran.
 * La clave nunca se guarda ni se registra.
 */
export async function silogLogin(ctx: AppContext, input: SilogLoginInput): Promise<{ token: string; expiresInSeconds: number; user: { id: string; role: AppRole; displayName: string | null; silogUser: string; permissions: string[] } }> {
  sessionSecret(ctx.config.security.appSessionSecret); // 503 claro si falta
  if (!ctx.silogAuth) throw new AppError(503, 'SILOG_NOT_CONFIGURED', 'Silogtran no está configurado: falta SILOG_BASE_URL en el servidor');
  if (typeof input.usuario !== 'string' || typeof input.clave !== 'string') throw uniform();
  const usuario = input.usuario.trim().toLowerCase();
  if (usuario === '' || usuario.length > 120 || input.clave === '' || input.clave.length > 200) throw uniform();

  const uk = userKey(usuario);
  const ik = ipKey(input.ip);
  const wait = await blockedSeconds(ctx.db, [uk, ik]);
  if (wait > 0) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos. Espere unos minutos antes de intentar de nuevo.', { retryAfterSeconds: wait });
  }

  const fail = async (reason: string): Promise<never> => {
    await recordFailure(ctx.db, uk, MAX_USER_FAILS);
    await recordFailure(ctx.db, ik, MAX_IP_FAILS);
    await audit(ctx.db, null, 'auth.silog_login_failed', 'login', 'silogtran', { reason });
    log('auth.silog_login_failed', { reason });
    throw uniform();
  };

  const r = await ctx.db.query<Row>(
    `select id, silog_user, display_name, company, role, active, session_version from app_users where silog_user = $1`,
    [usuario],
  );
  const user = r.rows[0];
  if (!user || !user.active) return fail('not_registered_or_inactive'); // no se llama a Silogtran

  const res = await ctx.silogAuth.login(usuario, input.clave);
  if (!res.ok) {
    if (res.reason === 'unavailable') throw new AppError(502, 'SILOG_UNAVAILABLE', 'No se pudo contactar a Silogtran. Intente de nuevo en un momento.');
    return fail('bad_password');
  }

  await clearFailures(ctx.db, uk);
  const displayName = res.name ?? user.display_name;
  await ctx.db.query(
    `update app_users set last_login_at = now(), display_name = coalesce($2, display_name), company = coalesce($3, company), updated_at = now() where id = $1`,
    [user.id, res.name, res.company],
  );
  await audit(ctx.db, user.id, 'auth.silog_login', 'app_user', user.id, {});
  log('auth.silog_login', { userId: user.id });
  const token = await issueAppToken(ctx.config.security.appSessionSecret, { id: user.id, role: user.role, silogUser: user.silog_user, sessionVersion: user.session_version });
  return { token, expiresInSeconds: APP_SESSION_SECONDS, user: { id: user.id, role: user.role, displayName, silogUser: user.silog_user, permissions: permissionsOf(user.role) } };
}
