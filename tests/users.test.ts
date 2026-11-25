import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ISSUER } from '../core/appAuth.js';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { decryptSecret, encryptSecret, parseEncryptionKey } from '../core/crypto.js';
import { handleRequest } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import { ALL_ROLES, PERMISSION_ROLES, can, permissionsOf } from '../core/permissions.js';
import type { AppRole, Permission } from '../core/permissions.js';
import { MockSilogAuth, SilogApiAuth } from '../core/silogAuth.js';
import { createUser, updateUser } from '../core/users.js';
import type { MeDto } from '../core/types.js';
import { newDb } from './helpers.js';

const KEY = 'a1'.repeat(32);
const SESSION_SECRET = 'secreto-de-sesion-de-prueba-0123456789-abcdef';
const PASS_ANA = 'Clave-Ana-9981';
const SERVICE_PASS = 'Clave-Servicio-4417';

describe('cifrado AES-256-GCM', () => {
  it('ida y vuelta con formato versionado; nunca texto plano', () => {
    const blob = encryptSecret('mi-clave-secreta', 'id-1', KEY);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob).not.toContain('mi-clave-secreta');
    expect(decryptSecret(blob, 'id-1', KEY)).toBe('mi-clave-secreta');
    expect(encryptSecret('mi-clave-secreta', 'id-1', KEY)).not.toBe(blob); // IV aleatorio
  });
  it('AAD distinta, clave distinta o blob alterado no descifran', () => {
    const blob = encryptSecret('x', 'id-1', KEY);
    expect(() => decryptSecret(blob, 'id-2', KEY)).toThrow();
    expect(() => decryptSecret(blob, 'id-1', 'b2'.repeat(32))).toThrow();
    const parts = blob.split(':');
    parts[3] = Buffer.from('otro').toString('base64url');
    expect(() => decryptSecret(parts.join(':'), 'id-1', KEY)).toThrow();
    expect(() => decryptSecret('v9:a:b:c', 'id-1', KEY)).toThrow();
  });
  it('clave faltante o inválida falla claro', () => {
    for (const bad of [undefined, '', 'corta', 'zz'.repeat(32), 'a1'.repeat(31)]) {
      expect(() => parseEncryptionKey(bad)).toThrow(/ENCRYPTION_KEY/);
    }
    expect(() => encryptSecret('x', 'id', '')).toThrow();
  });
});

describe('matriz de permisos', () => {
  const expected: Record<Permission, AppRole[]> = {
    'results.view': ['admin', 'facturacion', 'operator', 'viewer'],
    'import.run': ['admin', 'facturacion', 'operator'],
    'recon.run': ['admin', 'facturacion', 'operator'],
    'recon.resolve': ['admin', 'facturacion', 'operator'],
    'params.view': ['admin', 'facturacion'],
    'params.edit': ['admin'],
    'users.manage': ['admin'],
    'credentials.manage': ['admin'],
    'mail.config': ['admin'],
  };
  it('coincide con la decisión del negocio', () => {
    for (const p of Object.keys(expected) as Permission[]) {
      expect(PERMISSION_ROLES[p].slice().sort(), p).toEqual(expected[p].slice().sort());
      for (const r of ALL_ROLES) expect(can(r, p)).toBe(expected[p].includes(r));
    }
    expect(permissionsOf('facturacion')).not.toContain('users.manage');
    expect(permissionsOf('facturacion')).not.toContain('params.edit');
    expect(permissionsOf('viewer')).toEqual(['results.view']);
  });
});

describe('cliente de login por API de Silogtran', () => {
  it('lee nombre y empresa; distingue clave mala de servicio caído; nunca filtra la clave', async () => {
    let body = '';
    const ok = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ success: true, data: { token: 't', usuario: { usuario_nombre: 'Ana Ficticia', empresa_nombre: 'EMPRESA X' } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new SilogApiAuth('https://silog.example/api', ok).login('ana', 'p@ss&1');
    expect(r).toEqual({ ok: true, name: 'Ana Ficticia', company: 'EMPRESA X' });
    expect(body).toBe('usuario_login=ana&usuario_password=p%40ss%261');
    const bad = (async () => new Response('{"success":false,"msg":"x"}', { status: 200 })) as unknown as typeof fetch;
    expect(await new SilogApiAuth('https://s', bad).login('a', 'b')).toEqual({ ok: false, reason: 'bad_credentials' });
    const down = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    expect(await new SilogApiAuth('https://s', down).login('a', 'b')).toEqual({ ok: false, reason: 'unavailable' });
    const e500 = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await new SilogApiAuth('https://s', e500).login('a', 'b')).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('usuarios, ingreso con Silogtran y credenciales (API)', () => {
  let ctx: AppContext;
  let mock: MockSilogAuth;
  const logs: string[] = [];
  const tok: Record<string, string> = {};
  const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleRequest(ctx, { method, path, query: {}, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
  const j = <T>(r: { json?: unknown }): T => r.json as T;
  const silog = (usuario: string, clave: string, ip = '10.0.0.1') => call('POST', '/api/auth/silog-login', undefined, { usuario, clave }, { 'x-forwarded-for': ip });
  const me = async (t: string): Promise<{ status: number; me?: MeDto }> => {
    const r = await call('GET', '/api/me', t);
    return { status: r.status, me: r.status === 200 ? j<MeDto>(r) : undefined };
  };

  beforeAll(async () => {
    setLogSink((l) => logs.push(l));
    ctx = await createContext({
      AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afu-')), DEMO_JWT_SECRET: 'demo-local',
      ENCRYPTION_KEY: KEY, APP_SESSION_SECRET: SESSION_SECRET, SILOG_SOURCE: 'none',
    });
    mock = new MockSilogAuth({ 'ana.fact': PASS_ANA, 'beto.op': 'Clave-Beto', 'carla.admin': 'Clave-Carla', 'dani.view': 'Clave-Dani' });
    ctx.silogAuth = mock;
    for (const [k, e] of [['admin', 'admin@demo.local'], ['op', 'operador@demo.local'], ['view', 'lector@demo.local'], ['fact', 'facturacion@demo.local']] as const) {
      tok[k] = j<{ token: string }>(await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' })).token;
    }
  });
  afterAll(async () => {
    setLogSink(() => undefined);
    await ctx.db.close();
  });

  it('solo el administrador ve y administra usuarios y credenciales (matriz por API)', async () => {
    for (const k of ['op', 'view', 'fact']) {
      for (const [m, p, b] of [
        ['GET', '/api/users', undefined], ['POST', '/api/users', { silogUser: 'x', role: 'viewer' }], ['GET', '/api/service-credentials', undefined],
        ['PUT', '/api/service-credentials/adjust', { silogUser: 'x', password: 'y' }], ['POST', '/api/service-credentials/adjust/test', undefined],
      ] as const) expect((await call(m, p, tok[k], b)).status, `${k} ${m} ${p}`).toBe(403);
    }
    expect((await call('GET', '/api/users', tok.admin)).status).toBe(200);
    const mm = await me(tok.fact as string);
    expect(mm.me?.role).toBe('facturacion');
    expect(mm.me?.permissions).toContain('params.view');
    expect(mm.me?.permissions).not.toContain('params.edit');
    expect((await me(tok.view as string)).me?.permissions).toEqual(['results.view']);
    // facturación importa/concilia pero no edita parámetros
    expect((await call('GET', '/api/mail-config', tok.fact)).status).toBe(403);
    expect((await call('PUT', '/api/match-filters', tok.fact, { filters: [] })).status).toBe(403);
    expect((await call('GET', '/api/runs', tok.view)).status).toBe(200);
    expect((await call('POST', '/api/runs', tok.view, { dateFrom: '2026-01-01', dateTo: '2026-01-02' })).status).toBe(403);
  });

  it('alta de usuarios, validaciones y duplicados; roles', async () => {
    const mk = async (u: string, role: string) => call('POST', '/api/users', tok.admin, { silogUser: u, role, displayName: `Nombre ${u}` });
    expect((await mk('Ana.Fact', 'facturacion')).status).toBe(201);
    expect((await mk('ana.fact', 'facturacion')).status).toBe(409); // minúsculas: único
    expect((await mk('beto.op', 'operator')).status).toBe(201);
    expect((await mk('carla.admin', 'admin')).status).toBe(201);
    expect((await mk('dani.view', 'viewer')).status).toBe(201);
    expect((await mk('x y', 'viewer')).status).toBe(400);
    expect((await mk('ok', 'superuser')).status).toBe(400);
    const list = j<{ users: { silogUser: string }[] }>(await call('GET', '/api/users', tok.admin)).users;
    expect(list.map((u) => u.silogUser)).toEqual(['ana.fact', 'beto.op', 'carla.admin', 'dani.view']);
  });

  it('ingreso: mismo mensaje para usuario inexistente, inactivo y clave mala; sin llamar a Silogtran si no está registrado', async () => {
    const before = mock.calls;
    const ghost = await silog('no.existe', 'lo-que-sea');
    expect(ghost.status).toBe(401);
    expect(mock.calls).toBe(before); // no se llamó a Silogtran
    const bad = await silog('ana.fact', 'mala', '10.0.0.2');
    expect(bad.status).toBe(401);
    expect(mock.calls).toBe(before + 1);
    expect(j(bad)).toEqual(j(ghost));
    const users = j<{ users: { id: string; silogUser: string }[] }>(await call('GET', '/api/users', tok.admin)).users;
    const dani = users.find((u) => u.silogUser === 'dani.view') as { id: string };
    await call('PUT', `/api/users/${dani.id}`, tok.admin, { active: false });
    const inactive = await silog('dani.view', 'Clave-Dani', '10.0.0.3');
    expect(inactive.status).toBe(401);
    expect(j(inactive)).toEqual(j(ghost));
    await call('PUT', `/api/users/${dani.id}`, tok.admin, { active: true });
    // vacía o larga se rechazan pronto, sin llamar a Silogtran
    const c0 = mock.calls;
    expect((await silog('ana.fact', '')).status).toBe(401);
    expect((await silog('ana.fact', 'x'.repeat(500))).status).toBe(401);
    expect(mock.calls).toBe(c0);
  });

  it('ingreso correcto: token propio, /me, nombre guardado, ambos tipos de token conviven, sin cache', async () => {
    const r = await silog('ana.fact', PASS_ANA, '10.0.1.1');
    expect(r.status).toBe(200);
    expect(r.headers?.['Cache-Control']).toBe('no-store');
    const t = j<{ token: string }>(r).token;
    const m = await me(t);
    expect(m.me).toMatchObject({ role: 'facturacion', loginKind: 'silogtran', silogUser: 'ana.fact', displayName: 'Persona ana.fact' });
    expect(m.me?.permissions).toContain('recon.run');
    expect((await me(tok.admin as string)).me?.loginKind).toBe('supabase'); // ingreso por correo sigue vivo
    expect((await call('GET', '/api/users', t)).status).toBe(403);
    expect((await call('GET', '/api/recon-params', t)).status).toBe(200);
    const u = (await ctx.db.query<{ last_login_at: Date | null; company: string }>(`select last_login_at, company from app_users where silog_user='ana.fact'`)).rows[0];
    expect(u?.last_login_at).not.toBeNull();
    expect(u?.company).toBe('EMPRESA FICTICIA');
  });

  it('token manipulado, firmado con otra clave, vencido o de otro tipo: 401', async () => {
    const good = j<{ token: string }>(await silog('beto.op', 'Clave-Beto', '10.0.2.1')).token;
    expect((await me(good)).status).toBe(200);
    const [h, p, s] = good.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.role = 'admin';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect((await me(forged)).status).toBe(401);
    const id = payload.sub as string;
    const mk = (secret: string, exp: string | number) =>
      new SignJWT({ typ: 'app', role: 'admin', su: 'beto.op', sv: 1 }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuer(APP_ISSUER).setIssuedAt().setExpirationTime(exp).sign(new TextEncoder().encode(secret));
    expect((await me(await mk('otra-clave-distinta-de-treinta-y-dos-bytes!!', '1h'))).status).toBe(401);
    expect((await me(await mk(SESSION_SECRET, Math.floor(Date.now() / 1000) - 60))).status).toBe(401); // vencido
    expect((await me(await mk(SESSION_SECRET, '1h'))).status).toBe(200); // control: bien firmado y vigente
  });

  it('desactivar o cambiar el rol surte efecto en la SIGUIENTE petición; logout revoca', async () => {
    const users = j<{ users: { id: string; silogUser: string }[] }>(await call('GET', '/api/users', tok.admin)).users;
    const beto = users.find((u) => u.silogUser === 'beto.op') as { id: string };
    const t = j<{ token: string }>(await silog('beto.op', 'Clave-Beto', '10.0.3.1')).token;
    expect((await call('GET', '/api/recon-params', t)).status).toBe(403); // operador no ve parámetros
    await call('PUT', `/api/users/${beto.id}`, tok.admin, { role: 'facturacion' });
    expect((await call('GET', '/api/recon-params', t)).status).toBe(200); // mismo token, rol nuevo
    await call('PUT', `/api/users/${beto.id}`, tok.admin, { role: 'viewer' });
    expect((await call('POST', '/api/runs', t, { dateFrom: '2026-01-01', dateTo: '2026-01-02' })).status).toBe(403);
    await call('PUT', `/api/users/${beto.id}`, tok.admin, { active: false });
    expect((await me(t)).status).toBe(401);
    await call('PUT', `/api/users/${beto.id}`, tok.admin, { active: true });
    expect((await me(t)).status).toBe(401); // el token anterior no revive al reactivar
    const t2 = j<{ token: string }>(await silog('beto.op', 'Clave-Beto', '10.0.3.2')).token;
    expect((await me(t2)).status).toBe(200);
    expect((await call('POST', '/api/auth/logout', t2)).status).toBe(200);
    expect((await me(t2)).status).toBe(401);
  });

  it('bloqueo por intentos persistido en BD, evaluado ANTES de llamar a Silogtran', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 5; i += 1) expect((await silog('carla.admin', `mala-${i}`, ip)).status).toBe(401);
    const calls = mock.calls;
    const blocked = await call('POST', '/api/auth/silog-login', undefined, { usuario: 'carla.admin', clave: 'Clave-Carla' }, { 'x-forwarded-for': '10.8.8.8' });
    expect(blocked.status).toBe(429); // bloqueo por usuario aunque venga de otra IP y con la clave correcta
    expect(Number(blocked.headers?.['Retry-After'])).toBeGreaterThan(0);
    expect(mock.calls).toBe(calls); // no se llamó a Silogtran
    const rows = await ctx.db.query<{ key: string; fail_count: number }>('select key, fail_count from login_attempts');
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toContain('carla');
    // al vencer la ventana vuelve a permitir
    await ctx.db.query(`update login_attempts set blocked_until = now() - interval '1 minute', window_start = now() - interval '20 minutes'`);
    expect((await silog('carla.admin', 'Clave-Carla', '10.8.8.8')).status).toBe(200);
  });

  it('límite por IP: muchos usuarios distintos desde la misma IP se bloquean', async () => {
    const ip = '10.7.7.7';
    for (let i = 0; i < 20; i += 1) await silog(`fantasma${i}`, 'x', ip);
    expect((await silog('ana.fact', PASS_ANA, ip)).status).toBe(429);
  });

  it('Silogtran caído: 502 claro y no cuenta como intento fallido', async () => {
    mock.down = true;
    for (let i = 0; i < 7; i += 1) expect((await silog('ana.fact', PASS_ANA, '10.6.6.6')).status).toBe(502);
    mock.down = false;
    expect((await silog('ana.fact', PASS_ANA, '10.6.6.6')).status).toBe(200);
  });

  it('protección del administrador: no puede quitarse el rol ni desactivarse; siempre queda un admin', async () => {
    const carla = (j<{ users: { id: string; silogUser: string }[] }>(await call('GET', '/api/users', tok.admin)).users).find((u) => u.silogUser === 'carla.admin') as { id: string };
    const t = j<{ token: string }>(await silog('carla.admin', 'Clave-Carla', '10.5.5.5')).token;
    const self1 = await call('PUT', `/api/users/${carla.id}`, t, { active: false });
    expect(self1.status).toBe(409);
    expect(j<{ error: { code: string } }>(self1).error.code).toBe('SELF_LOCKOUT');
    expect((await call('PUT', `/api/users/${carla.id}`, t, { role: 'operator' })).status).toBe(409);
    // otro admin sí puede cambiarla
    expect((await call('PUT', `/api/users/${carla.id}`, tok.admin, { role: 'operator' })).status).toBe(200);
    await call('PUT', `/api/users/${carla.id}`, tok.admin, { role: 'admin' });
  });

  it('último administrador (sin otros admins de ningún tipo) no se puede degradar', async () => {
    const db = await newDb();
    const a = await createUser(db, 'sistema', { silogUser: 'unico', role: 'admin' });
    await expect(updateUser(db, 'otra-persona', a.id, { role: 'viewer' })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(updateUser(db, 'otra-persona', a.id, { active: false })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await createUser(db, 'sistema', { silogUser: 'segundo', role: 'admin' });
    expect((await updateUser(db, 'otra-persona', a.id, { role: 'viewer' })).role).toBe('viewer');
    await db.close();
  });

  it('contraseña guardada: cifrada, nunca devuelta, probar conexión, sin secretos en BD/API/logs/auditoría', async () => {
    const users = j<{ users: { id: string; silogUser: string }[] }>(await call('GET', '/api/users', tok.admin)).users;
    const ana = users.find((u) => u.silogUser === 'ana.fact') as { id: string };
    const put = await call('PUT', `/api/users/${ana.id}/credential`, tok.admin, { password: PASS_ANA });
    expect(put.status).toBe(200);
    expect(j<{ hasStoredPassword: boolean }>(put).hasStoredPassword).toBe(true);
    const raw = (await ctx.db.query<{ password_enc: string }>('select password_enc from silog_credentials')).rows[0]?.password_enc as string;
    expect(raw.startsWith('v1:')).toBe(true);
    expect(raw).not.toContain(PASS_ANA);
    const test = await call('POST', `/api/users/${ana.id}/credential/test`, tok.admin);
    expect(test.status).toBe(200);
    expect(j<{ ok: boolean }>(test).ok).toBe(true);
    // reemplazar por una clave que Silogtran rechaza: la prueba falla sin exponer datos
    await call('PUT', `/api/users/${ana.id}/credential`, tok.admin, { password: 'otra-clave-mala' });
    expect(j<{ ok: boolean }>(await call('POST', `/api/users/${ana.id}/credential/test`, tok.admin)).ok).toBe(false);
    const row = (await ctx.db.query<{ last_test_ok: boolean }>('select last_test_ok from silog_credentials')).rows[0];
    expect(row?.last_test_ok).toBe(false);
    // cuenta de servicio de ajustes
    expect((await call('PUT', '/api/service-credentials/otro', tok.admin, { silogUser: 'u', password: 'p' })).status).toBe(400);
    const svc = await call('PUT', '/api/service-credentials/adjust', tok.admin, { silogUser: 'ana.fact', password: SERVICE_PASS });
    expect(svc.status).toBe(200);
    expect(j<{ ok: boolean }>(await call('POST', '/api/service-credentials/adjust/test', tok.admin)).ok).toBe(false); // el mock solo conoce la clave de ana.fact
    const listed = j<{ credentials: { purpose: string; saved: boolean; silogUser: string | null }[] }>(svc).credentials;
    expect(listed.find((c) => c.purpose === 'adjust')).toMatchObject({ saved: true, silogUser: 'ana.fact' });
    expect(listed.find((c) => c.purpose === 'invoice')).toMatchObject({ saved: false });
    // ninguna respuesta, fila de usuarios, auditoría ni log contiene secretos
    const everything = JSON.stringify([
      put.json, svc.json, (await call('GET', '/api/users', tok.admin)).json, (await call('GET', '/api/service-credentials', tok.admin)).json,
      (await ctx.db.query('select * from audit_log')).rows, logs,
    ]);
    for (const secret of [PASS_ANA, SERVICE_PASS, 'otra-clave-mala', KEY, SESSION_SECRET, 'Clave-Beto', 'Clave-Carla']) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/password_enc|v1:/);
    const actions = (await ctx.db.query<{ action: string }>('select action from audit_log')).rows.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['app_user.create', 'app_user.update', 'silog_credential.save', 'silog_credential.test', 'auth.silog_login', 'auth.silog_login_failed', 'auth.logout']));
    // la clave descifra con su AAD y no con otra
    const cred = (await ctx.db.query<{ id: string; password_enc: string }>(`select id, password_enc from silog_credentials where purpose='adjust'`)).rows[0] as { id: string; password_enc: string };
    expect(decryptSecret(cred.password_enc, cred.id, KEY)).toBe(SERVICE_PASS);
    expect(() => decryptSecret(cred.password_enc, 'otro-id', KEY)).toThrow();
    // quitar contraseña
    expect(j<{ hasStoredPassword: boolean }>(await call('DELETE', `/api/users/${ana.id}/credential`, tok.admin)).hasStoredPassword).toBe(false);
    expect((await call('POST', `/api/users/${ana.id}/credential/test`, tok.admin)).status).toBe(404);
  });

  it('sin ENCRYPTION_KEY / APP_SESSION_SECRET / base URL: errores claros (no 500) y el ingreso por correo sigue', async () => {
    const bare = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afb-')), DEMO_JWT_SECRET: 'demo-local', SILOG_SOURCE: 'none' });
    const c = (m: string, p: string, t?: string, b?: unknown) => handleRequest(bare, { method: m, path: p, query: {}, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b });
    const admin = j<{ token: string }>(await c('POST', '/api/auth/demo-login', undefined, { email: 'admin@demo.local', password: 'demo' })).token;
    const created = j<{ id: string }>(await c('POST', '/api/users', admin, { silogUser: 'x1', role: 'viewer' }));
    const lg = await c('POST', '/api/auth/silog-login', undefined, { usuario: 'x1', clave: 'demo' });
    expect(lg.status).toBe(503);
    expect(j<{ error: { code: string } }>(lg).error.code).toBe('SESSION_NOT_CONFIGURED');
    const sv = await c('PUT', `/api/users/${created.id}/credential`, admin, { password: 'abc' });
    expect(sv.status).toBe(503);
    expect(j<{ error: { code: string } }>(sv).error.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    expect((await bare.db.query('select * from silog_credentials')).rowCount).toBe(0); // no tocó nada
    expect((await c('GET', '/api/me', admin)).status).toBe(200);
    expect(j<{ silogLogin: boolean }>(await c('GET', '/api/config')).silogLogin).toBe(false);
    await bare.db.close();
    const badKey = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afk-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: 'zz', SILOG_SOURCE: 'none' });
    const a2 = j<{ token: string }>(await handleRequest(badKey, { method: 'POST', path: '/api/auth/demo-login', query: {}, headers: {}, body: { email: 'admin@demo.local', password: 'demo' } })).token;
    const u2 = j<{ id: string }>(await handleRequest(badKey, { method: 'POST', path: '/api/users', query: {}, headers: { authorization: `Bearer ${a2}` }, body: { silogUser: 'x2', role: 'viewer' } }));
    const r2 = await handleRequest(badKey, { method: 'PUT', path: `/api/users/${u2.id}/credential`, query: {}, headers: { authorization: `Bearer ${a2}` }, body: { password: 'abc' } });
    expect(j<{ error: { code: string } }>(r2).error.code).toBe('ENCRYPTION_KEY_INVALID');
    await badKey.db.close();
  });
});
