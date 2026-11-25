import { audit } from './audit.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import type { Db } from './db/types.js';
import { sqlState } from './db/types.js';
import { AppError } from './errors.js';
import { log } from './logger.js';
import { ALL_ROLES } from './permissions.js';
import type { AppRole } from './permissions.js';
import type { SilogAuthClient } from './silogAuth.js';

export type CredentialPurpose = 'adjust' | 'invoice';
export const PURPOSES: CredentialPurpose[] = ['adjust', 'invoice'];

export interface AppUserDto {
  id: string;
  silogUser: string;
  displayName: string | null;
  company: string | null;
  role: AppRole;
  active: boolean;
  lastLoginAt: string | null;
  hasStoredPassword: boolean;
  credentialUpdatedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
}

export interface ServiceCredentialDto {
  purpose: CredentialPurpose;
  saved: boolean;
  silogUser: string | null;
  updatedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
}

export interface SecretsConfig {
  encryptionKey: string;
}

interface UserRow {
  id: string; silog_user: string; display_name: string | null; company: string | null; role: AppRole; active: boolean;
  last_login_at: Date | null; cred_id: string | null; cred_updated_at: Date | null; last_test_at: Date | null; last_test_ok: boolean | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

const USER_SELECT = `select u.id, u.silog_user, u.display_name, u.company, u.role, u.active, u.last_login_at,
    c.id as cred_id, c.updated_at as cred_updated_at, c.last_test_at, c.last_test_ok
  from app_users u left join silog_credentials c on c.user_id = u.id`;

function toDto(r: UserRow): AppUserDto {
  return {
    id: r.id, silogUser: r.silog_user, displayName: r.display_name, company: r.company, role: r.role, active: r.active,
    lastLoginAt: iso(r.last_login_at), hasStoredPassword: r.cred_id !== null, credentialUpdatedAt: iso(r.cred_updated_at),
    lastTestAt: iso(r.last_test_at), lastTestOk: r.last_test_ok,
  };
}

export async function listUsers(db: Db): Promise<AppUserDto[]> {
  return (await db.query<UserRow>(`${USER_SELECT} order by u.silog_user`)).rows.map(toDto);
}

async function getUser(db: Db, id: string): Promise<AppUserDto> {
  const r = await db.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');
  return toDto(r.rows[0]);
}

function parseRole(v: unknown): AppRole {
  if (typeof v !== 'string' || !ALL_ROLES.includes(v as AppRole)) throw new AppError(400, 'INVALID_FIELD', 'Rol inválido');
  return v as AppRole;
}

function parseSilogUser(v: unknown): string {
  if (typeof v !== 'string') throw new AppError(400, 'INVALID_FIELD', 'Usuario de Silogtran inválido');
  const s = v.trim().toLowerCase();
  if (s.length < 1 || s.length > 120 || /\s/.test(s)) throw new AppError(400, 'INVALID_FIELD', 'Usuario de Silogtran inválido');
  return s;
}

function parseSecret(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200) throw new AppError(400, 'INVALID_FIELD', 'Contraseña inválida');
  return v;
}

/** Administradores activos que quedarían tras el cambio (app_users + admins de Supabase). */
async function otherActiveAdmins(db: Db, exceptUserId: string): Promise<number> {
  const a = await db.query<{ n: number }>(`select count(*)::int as n from app_users where role='admin' and active and id <> $1`, [exceptUserId]);
  const b = await db.query<{ n: number }>(`select count(*)::int as n from user_roles where role='admin'`);
  return (a.rows[0]?.n ?? 0) + (b.rows[0]?.n ?? 0);
}

export async function createUser(db: Db, actor: string, input: { silogUser: unknown; role: unknown; displayName?: unknown }): Promise<AppUserDto> {
  const silogUser = parseSilogUser(input.silogUser);
  const role = parseRole(input.role);
  const displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 120) : null;
  try {
    const r = await db.query<{ id: string }>(
      `insert into app_users (silog_user, display_name, role, created_by) values ($1,$2,$3,$4) returning id`,
      [silogUser, displayName, role, actor],
    );
    const id = r.rows[0]?.id as string;
    await audit(db, actor, 'app_user.create', 'app_user', id, { role });
    return await getUser(db, id);
  } catch (e) {
    if (sqlState(e) === '23505') throw new AppError(409, 'USER_EXISTS', 'Ya existe un usuario con ese nombre de Silogtran');
    throw e;
  }
}

export async function updateUser(db: Db, actor: string, id: string, input: { role?: unknown; active?: unknown; displayName?: unknown }): Promise<AppUserDto> {
  const cur = await getUser(db, id);
  const role = input.role === undefined ? cur.role : parseRole(input.role);
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: active');
  const active = input.active === undefined ? cur.active : (input.active as boolean);
  const displayName = input.displayName === undefined ? cur.displayName : typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 120) : null;
  const losesAdmin = cur.role === 'admin' && cur.active && (role !== 'admin' || !active);
  if (losesAdmin) {
    if (id === actor) throw new AppError(409, 'SELF_LOCKOUT', 'No puede desactivarse ni quitarse el rol de administrador a sí mismo');
    if ((await otherActiveAdmins(db, id)) < 1) throw new AppError(409, 'LAST_ADMIN', 'Debe quedar al menos un administrador activo');
  }
  const bump = cur.active && !active;
  await db.query(
    `update app_users set role=$2, active=$3, display_name=$4, session_version = session_version + $5, updated_at=now() where id=$1`,
    [id, role, active, displayName, bump ? 1 : 0],
  );
  await audit(db, actor, 'app_user.update', 'app_user', id, { role, active, roleChanged: role !== cur.role, activeChanged: active !== cur.active });
  return getUser(db, id);
}

// ---- Credenciales cifradas ---------------------------------------------------------------------------
async function upsertCredential(db: Db, secrets: SecretsConfig, owner: { userId: string } | { purpose: CredentialPurpose }, silogUser: string, password: string, actor: string): Promise<string> {
  // La clave se valida ANTES de tocar la base de datos.
  const existing = 'userId' in owner
    ? await db.query<{ id: string }>('select id from silog_credentials where user_id = $1', [owner.userId])
    : await db.query<{ id: string }>('select id from silog_credentials where purpose = $1', [owner.purpose]);
  const id = existing.rows[0]?.id ?? (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0]?.id as string;
  const enc = encryptSecret(password, id, secrets.encryptionKey);
  if (existing.rows[0]) {
    await db.query(
      `update silog_credentials set silog_user=$2, password_enc=$3, updated_by=$4, updated_at=now(), last_test_at=null, last_test_ok=null where id=$1`,
      [id, silogUser, enc, actor],
    );
  } else {
    await db.query(
      `insert into silog_credentials (id, user_id, purpose, silog_user, password_enc, updated_by) values ($1,$2,$3,$4,$5,$6)`,
      [id, 'userId' in owner ? owner.userId : null, 'purpose' in owner ? owner.purpose : null, silogUser, enc, actor],
    );
  }
  return id;
}

export async function saveUserPassword(db: Db, secrets: SecretsConfig, actor: string, userId: string, password: unknown): Promise<AppUserDto> {
  const user = await getUser(db, userId);
  const id = await upsertCredential(db, secrets, { userId }, user.silogUser, parseSecret(password), actor);
  await audit(db, actor, 'silog_credential.save', 'silog_credential', id, { owner: 'user', userId });
  return getUser(db, userId);
}

export async function deleteUserPassword(db: Db, actor: string, userId: string): Promise<AppUserDto> {
  await getUser(db, userId);
  const r = await db.query<{ id: string }>('delete from silog_credentials where user_id = $1 returning id', [userId]);
  if (r.rows[0]) await audit(db, actor, 'silog_credential.delete', 'silog_credential', r.rows[0].id, { owner: 'user', userId });
  return getUser(db, userId);
}

async function testCredential(db: Db, secrets: SecretsConfig, client: SilogAuthClient | null, credId: string, actor: string): Promise<{ ok: boolean; testedAt: string }> {
  if (!client) throw new AppError(503, 'SILOG_NOT_CONFIGURED', 'Silogtran no está configurado: falta SILOG_BASE_URL en el servidor');
  const r = await db.query<{ silog_user: string; password_enc: string }>('select silog_user, password_enc from silog_credentials where id = $1', [credId]);
  const row = r.rows[0];
  if (!row) throw new AppError(404, 'NOT_FOUND', 'No hay una contraseña guardada');
  const plain = decryptSecret(row.password_enc, credId, secrets.encryptionKey);
  const res = await client.login(row.silog_user, plain);
  if (!res.ok && res.reason === 'unavailable') throw new AppError(502, 'SILOG_UNAVAILABLE', 'No se pudo contactar a Silogtran. Intente de nuevo.');
  await db.query('update silog_credentials set last_test_at=now(), last_test_ok=$2 where id=$1', [credId, res.ok]);
  await audit(db, actor, 'silog_credential.test', 'silog_credential', credId, { ok: res.ok });
  log('credential.test', { ok: res.ok });
  const t = await db.query<{ at: Date }>('select last_test_at as at from silog_credentials where id = $1', [credId]);
  return { ok: res.ok, testedAt: new Date(t.rows[0]?.at as Date).toISOString() };
}

export async function testUserCredential(db: Db, secrets: SecretsConfig, client: SilogAuthClient | null, actor: string, userId: string): Promise<{ ok: boolean; testedAt: string }> {
  const c = await db.query<{ id: string }>('select id from silog_credentials where user_id = $1', [userId]);
  if (!c.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Este usuario no tiene contraseña guardada');
  return testCredential(db, secrets, client, c.rows[0].id, actor);
}

export async function listServiceCredentials(db: Db): Promise<ServiceCredentialDto[]> {
  const r = await db.query<{ purpose: CredentialPurpose; silog_user: string; updated_at: Date; last_test_at: Date | null; last_test_ok: boolean | null }>(
    'select purpose, silog_user, updated_at, last_test_at, last_test_ok from silog_credentials where purpose is not null',
  );
  return PURPOSES.map((p) => {
    const x = r.rows.find((y) => y.purpose === p);
    return { purpose: p, saved: !!x, silogUser: x?.silog_user ?? null, updatedAt: iso(x?.updated_at ?? null), lastTestAt: iso(x?.last_test_at ?? null), lastTestOk: x?.last_test_ok ?? null };
  });
}

export function parsePurpose(v: unknown): CredentialPurpose {
  if (typeof v !== 'string' || !PURPOSES.includes(v as CredentialPurpose)) throw new AppError(400, 'INVALID_FIELD', 'Propósito de credencial inválido');
  return v as CredentialPurpose;
}

export async function saveServiceCredential(db: Db, secrets: SecretsConfig, actor: string, purpose: CredentialPurpose, input: { silogUser: unknown; password: unknown }): Promise<ServiceCredentialDto[]> {
  const silogUser = typeof input.silogUser === 'string' ? input.silogUser.trim() : '';
  if (silogUser.length < 1 || silogUser.length > 120) throw new AppError(400, 'INVALID_FIELD', 'Usuario de Silogtran inválido');
  const id = await upsertCredential(db, secrets, { purpose }, silogUser, parseSecret(input.password), actor);
  await audit(db, actor, 'silog_credential.save', 'silog_credential', id, { owner: 'service', purpose });
  return listServiceCredentials(db);
}

export async function testServiceCredential(db: Db, secrets: SecretsConfig, client: SilogAuthClient | null, actor: string, purpose: CredentialPurpose): Promise<{ ok: boolean; testedAt: string }> {
  const c = await db.query<{ id: string }>('select id from silog_credentials where purpose = $1', [purpose]);
  if (!c.rows[0]) throw new AppError(404, 'NOT_FOUND', 'La cuenta de servicio aún no tiene credencial guardada');
  return testCredential(db, secrets, client, c.rows[0].id, actor);
}
