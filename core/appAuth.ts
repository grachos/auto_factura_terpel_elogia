import { createHash } from 'node:crypto';
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import type { Db, Queryable } from './db/types.js';
import { AppError } from './errors.js';
import type { AppRole } from './permissions.js';

export const APP_ISSUER = 'autofactura-app';
export const APP_SESSION_SECONDS = 8 * 3600;
export const MAX_USER_FAILS = 5;
export const MAX_IP_FAILS = 20;
export const WINDOW_MINUTES = 15;
export const UNIFORM_LOGIN_MESSAGE = 'Usuario o contraseña incorrectos, o el usuario no tiene acceso a esta aplicación';

export function sessionSecret(secret: string | undefined | null): Uint8Array {
  if (!secret || secret.length < 32) {
    throw new AppError(503, 'SESSION_NOT_CONFIGURED', 'Falta APP_SESSION_SECRET (mínimo 32 caracteres) en el servidor: el ingreso con usuario de Silogtran no está disponible');
  }
  return new TextEncoder().encode(secret);
}

export async function issueAppToken(secret: string | undefined | null, u: { id: string; role: AppRole; silogUser: string; sessionVersion: number }): Promise<string> {
  return new SignJWT({ typ: 'app', role: u.role, su: u.silogUser, sv: u.sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.id)
    .setIssuer(APP_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${APP_SESSION_SECONDS}s`)
    .sign(sessionSecret(secret));
}

/** true si el token declara ser un token propio de la app (sin verificar firma). */
export function isAppToken(token: string): boolean {
  try {
    return decodeJwt(token).typ === 'app';
  } catch {
    return false;
  }
}

export interface AppSessionClaims {
  id: string;
  sessionVersion: number;
}

export async function verifyAppToken(secret: string | undefined | null, token: string): Promise<AppSessionClaims | null> {
  let key: Uint8Array;
  try {
    key = sessionSecret(secret);
  } catch {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: APP_ISSUER });
    if (payload.typ !== 'app' || typeof payload.sub !== 'string' || typeof payload.sv !== 'number') return null;
    return { id: payload.sub, sessionVersion: payload.sv };
  } catch {
    return null;
  }
}

// ---- Límite de intentos persistido en BD ----------------------------------------------------------
const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 40);
export const userKey = (u: string): string => `u:${hash(u.trim().toLowerCase())}`;
export const ipKey = (ip: string): string => `i:${hash(ip)}`;

/** Segundos de bloqueo vigentes (0 = libre). Se evalúa ANTES de llamar a Silogtran. */
export async function blockedSeconds(q: Queryable, keys: string[]): Promise<number> {
  const r = await q.query<{ secs: number }>(
    `select coalesce(max(ceil(extract(epoch from (blocked_until - now())))), 0)::int as secs
       from login_attempts where key = any($1::text[]) and blocked_until > now()`,
    [keys],
  );
  return r.rows[0]?.secs ?? 0;
}

export async function recordFailure(db: Db, key: string, max: number): Promise<void> {
  await db.query(
    `insert into login_attempts (key, window_start, fail_count) values ($1, now(), 1)
     on conflict (key) do update set
       fail_count = case when login_attempts.window_start < now() - ($3 || ' minutes')::interval then 1 else login_attempts.fail_count + 1 end,
       window_start = case when login_attempts.window_start < now() - ($3 || ' minutes')::interval then now() else login_attempts.window_start end,
       blocked_until = case
         when (case when login_attempts.window_start < now() - ($3 || ' minutes')::interval then 1 else login_attempts.fail_count + 1 end) >= $2
         then now() + ($3 || ' minutes')::interval else login_attempts.blocked_until end`,
    [key, max, String(WINDOW_MINUTES)],
  );
}

export async function clearFailures(db: Db, key: string): Promise<void> {
  await db.query('delete from login_attempts where key = $1', [key]);
}
