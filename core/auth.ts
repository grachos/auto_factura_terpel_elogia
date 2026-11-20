import { randomBytes } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import type { Db } from './db/types.js';
import type { Role } from './types.js';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthVerifier {
  readonly mode: 'demo' | 'supabase';
  verify(token: string): Promise<AuthUser | null>;
  /** Solo existe en modo demo. */
  demoLogin?(email: string, password: string): Promise<{ token: string; user: AuthUser } | null>;
}

/** Valida el JWT de Supabase Auth (HS256 con secreto, o JWKS para claves asimétricas). */
export function createSupabaseVerifier(opts: { url: string; jwtSecret: string }): AuthVerifier {
  const secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : null;
  const jwks = !secret && opts.url ? createRemoteJWKSet(new URL(`${opts.url.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`)) : null;
  return {
    mode: 'supabase',
    async verify(token) {
      try {
        const { payload } = secret
          ? await jwtVerify(token, secret, { algorithms: ['HS256'] })
          : jwks
            ? await jwtVerify(token, jwks)
            : (() => {
                throw new Error('sin configuración de verificación JWT');
              })();
        if (typeof payload.sub !== 'string' || payload.role === 'anon') return null;
        return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
      } catch {
        return null;
      }
    },
  };
}

export const DEMO_USERS: { id: string; email: string; role: Role }[] = [
  { id: '00000000-0000-4000-8000-0000000000a1', email: 'operador@demo.local', role: 'operator' },
  { id: '00000000-0000-4000-8000-0000000000a2', email: 'admin@demo.local', role: 'admin' },
  { id: '00000000-0000-4000-8000-0000000000a3', email: 'lector@demo.local', role: 'viewer' },
];
export const DEMO_PASSWORD = 'demo';

export async function seedDemoUsers(db: Db): Promise<void> {
  for (const u of DEMO_USERS) {
    await db.query(`insert into auth.users (id, email) values ($1,$2) on conflict do nothing`, [u.id, u.email]);
    await db.query(`insert into user_roles (user_id, role) values ($1,$2) on conflict (user_id) do nothing`, [u.id, u.role]);
  }
}

/** Modo demo: usuarios ficticios y tokens HS256 locales. Pasa por el mismo camino de verificación y roles. */
export function createDemoVerifier(secretValue?: string): AuthVerifier {
  const secret = new TextEncoder().encode(secretValue || randomBytes(32).toString('hex'));
  return {
    mode: 'demo',
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: 'autofactura-demo' });
        return typeof payload.sub === 'string' ? { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null } : null;
      } catch {
        return null;
      }
    },
    async demoLogin(email, password) {
      const user = DEMO_USERS.find((u) => u.email === email.trim().toLowerCase());
      if (!user || password !== DEMO_PASSWORD) return null;
      const token = await new SignJWT({ email: user.email })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuer('autofactura-demo')
        .setExpirationTime('8h')
        .sign(secret);
      return { token, user: { id: user.id, email: user.email } };
    },
  };
}

export async function getUserRole(db: Db, userId: string): Promise<Role | null> {
  const r = await db.query<{ role: Role }>('select role from user_roles where user_id = $1', [userId]);
  return r.rows[0]?.role ?? null;
}
