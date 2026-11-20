import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../core/config.js';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { handleRequest } from '../core/http/router.js';
import type { HttpResponse } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import type { MailConfigDto, MeDto, RunDetailDto, RunDto, StepResultDto } from '../core/types.js';

let ctx: AppContext;
const logs: string[] = [];

async function call(method: string, path: string, opts: { token?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<HttpResponse> {
  return handleRequest(ctx, {
    method,
    path,
    query: opts.query ?? {},
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: opts.body,
  });
}

async function login(email: string): Promise<string> {
  const r = await call('POST', '/api/auth/demo-login', { body: { email, password: 'demo' } });
  expect(r.status).toBe(200);
  return (r.json as { token: string }).token;
}

describe('API (despachador común Fastify/Vercel)', () => {
  let operator: string;
  let viewer: string;
  let admin: string;

  beforeAll(async () => {
    setLogSink((l) => logs.push(l));
    ctx = await createContext({
      AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'af-')), DEMO_JWT_SECRET: 'secreto-de-prueba-local',
    });
    operator = await login('operador@demo.local');
    viewer = await login('lector@demo.local');
    admin = await login('admin@demo.local');
  });
  afterAll(async () => {
    setLogSink(() => undefined);
    await ctx.db.close();
  });

  it('criterio 11: sin sesión no hay acceso (ni con token inválido)', async () => {
    for (const [m, p] of [['GET', '/api/runs'], ['POST', '/api/runs'], ['GET', '/api/me'], ['GET', '/api/mail-config'], ['POST', '/api/runs/x/step']] as const) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
    }
    expect((await call('GET', '/api/runs', { token: 'no-es-un-jwt' })).status).toBe(401);
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('00000000-0000-4000-8000-0000000000a2').setIssuer('autofactura-demo').sign(new TextEncoder().encode('otro-secreto'));
    expect((await call('GET', '/api/me', { token: forged })).status).toBe(401);
    expect((await call('GET', '/api/health')).status).toBe(200);
  });

  it('criterio 11: roles — lector solo lee; operador no cambia configuración; admin sí', async () => {
    expect(((await call('GET', '/api/me', { token: viewer })).json as MeDto).role).toBe('viewer');
    expect((await call('POST', '/api/runs', { token: viewer, body: { dateFrom: '2026-01-01', dateTo: '2026-01-31' } })).status).toBe(403);
    expect((await call('GET', '/api/runs', { token: viewer })).status).toBe(200);
    const cfg = (await call('GET', '/api/mail-config', { token: operator })).json as MailConfigDto;
    const put = { ...cfg, subjectPattern: 'otro patrón' };
    expect((await call('PUT', '/api/mail-config', { token: operator, body: put })).status).toBe(403);
    expect((await call('PUT', '/api/mail-config', { token: viewer, body: put })).status).toBe(403);
    const r = await call('PUT', '/api/mail-config', { token: admin, body: { ...cfg, subjectPattern: cfg.subjectPattern } });
    expect(r.status).toBe(200);
    expect((await call('PUT', '/api/mail-config', { token: admin, body: { ...cfg, mailbox: 'no-es-correo' } })).status).toBe(400);
  });

  it('validaciones de entrada', async () => {
    expect((await call('POST', '/api/runs', { token: operator, body: { dateFrom: '2026-02-01', dateTo: '2026-01-01' } })).status).toBe(400);
    expect((await call('POST', '/api/runs', { token: operator, body: { dateFrom: 5 } })).status).toBe(400);
    expect((await call('POST', '/api/runs', { token: operator, body: 'texto' })).status).toBe(400);
    expect((await call('GET', '/api/runs/no-uuid', { token: operator })).status).toBe(400);
    expect((await call('GET', '/api/ruta-inexistente', { token: operator })).status).toBe(404);
  });

  it('flujo completo: crear, avanzar por pasos, ver resultados, descargar Excel firmado', async () => {
    const created = await call('POST', '/api/runs', { token: operator, body: { dateFrom: '2026-01-01', dateTo: '2026-01-31' } });
    expect(created.status).toBe(201);
    const run = created.json as RunDto;
    // una segunda ejecución activa para el mismo buzón es rechazada, con el id de la activa
    const dup = await call('POST', '/api/runs', { token: operator, body: { dateFrom: '2026-01-01', dateTo: '2026-01-31' } });
    expect(dup.status).toBe(409);
    expect((dup.json as { error: { details: { runId: string } } }).error.details.runId).toBe(run.id);

    let last: StepResultDto | undefined;
    let sawThrottle = false;
    for (let i = 0; i < 30; i += 1) {
      const s = await call('POST', `/api/runs/${run.id}/step`, { token: operator });
      expect(s.status).toBe(200);
      last = s.json as StepResultDto;
      if (last.retryAfterMs) sawThrottle = true;
      if (last.done) break;
    }
    expect(sawThrottle).toBe(true);
    expect(last?.run).toMatchObject({ status: 'completed', found: 16, exportStatus: 'ready', imported: 9, needsReview: 5, ignored: 2 });

    const detail = (await call('GET', `/api/runs/${run.id}`, { token: viewer })).json as RunDetailDto;
    expect(detail.results).toHaveLength(10);
    expect(detail.issues.length).toBeGreaterThan(0);
    expect(detail.exports[0]?.status).toBe('ready');
    expect(detail.results.find((r) => r.businessKey === '000123')?.transportNumber).toBe('000123');
    expect(detail.results.find((r) => r.businessKey === '000124')?.loadingPlantFlag).toBe('9P');
    // el DTO no expone cuerpos de correo
    expect(JSON.stringify(detail)).not.toContain('Cordial saludo');

    const link = await call('GET', `/api/runs/${run.id}/export/url`, { token: viewer });
    expect(link.status).toBe(200);
    const { url, expiresInSeconds } = link.json as { url: string; expiresInSeconds: number };
    expect(expiresInSeconds).toBe(300);
    const u = new URL(url, 'http://x');
    const q = Object.fromEntries(u.searchParams.entries());
    const file = await call('GET', u.pathname, { query: q });
    expect(file.status).toBe(200);
    expect(file.file?.data.subarray(0, 2).toString()).toBe('PK'); // .xlsx es un zip
    expect((await call('GET', u.pathname, { query: { ...q, sig: 'x'.repeat(q.sig!.length) } })).status).toBe(403);
    expect((await call('GET', u.pathname, { query: { ...q, exp: '1' } })).status).toBe(403);
    expect((await call('GET', u.pathname, { query: { ...q, p: '../../etc/passwd' } })).status).toBe(403);

    // Regenerar desde el lote
    const regen = await call('POST', `/api/runs/${run.id}/export`, { token: operator });
    expect(regen.status).toBe(200);
    expect((regen.json as { status: string }).status).toBe('ready');
    expect((await call('POST', `/api/runs/${run.id}/export`, { token: viewer })).status).toBe(403);
    const detail2 = (await call('GET', `/api/runs/${run.id}`, { token: viewer })).json as RunDetailDto;
    expect(detail2.exports.filter((e) => e.status === 'ready')).toHaveLength(2);

    // Los logs no contienen cuerpos, tokens ni nombres de conductor
    const all = logs.join('\n');
    expect(all).toContain('"event":"http"');
    expect(all).not.toMatch(/Conductor|Cordial saludo|Bearer|eyJ/);
  });
});

describe('modo Supabase (JWT) y modo demo bloqueado', () => {
  it('verifica JWT HS256 de Supabase, rechaza anon y no ofrece demo-login', async () => {
    const secret = 'secreto-jwt-de-prueba-supabase-0123456789';
    const sctx = await createContext({ PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'af-')), SUPABASE_JWT_SECRET: secret });
    expect(sctx.auth.mode).toBe('supabase');
    const uid = '44444444-4444-4444-8444-444444444444';
    await sctx.db.query(`insert into auth.users (id, email) values ($1,'a@b.c')`, [uid]);
    await sctx.db.query(`insert into user_roles (user_id, role) values ($1,'operator')`, [uid]);
    const key = new TextEncoder().encode(secret);
    const good = await new SignJWT({ role: 'authenticated', email: 'a@b.c' }).setProtectedHeader({ alg: 'HS256' }).setSubject(uid).setExpirationTime('1h').sign(key);
    const anon = await new SignJWT({ role: 'anon' }).setProtectedHeader({ alg: 'HS256' }).setSubject(uid).setExpirationTime('1h').sign(key);
    const expired = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject(uid).setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(key);
    const noRole = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject('55555555-5555-4555-8555-555555555555').setExpirationTime('1h').sign(key);
    const req = (token: string, path = '/api/me', method = 'GET') => handleRequest(sctx, { method, path, query: {}, headers: { authorization: `Bearer ${token}` }, body: {} });
    expect((await req(good)).status).toBe(200);
    expect((await req(anon)).status).toBe(401);
    expect((await req(expired)).status).toBe(401);
    expect((await req(noRole)).status).toBe(403);
    expect((await handleRequest(sctx, { method: 'POST', path: '/api/auth/demo-login', query: {}, headers: {}, body: { email: 'operador@demo.local', password: 'demo' } })).status).toBe(404);
    const pub = (await handleRequest(sctx, { method: 'GET', path: '/api/config', query: {}, headers: {}, body: undefined })).json as { demoUsers: unknown[] };
    expect(pub.demoUsers).toEqual([]);
    await sctx.db.close();
  });

  it('el modo demo exige AUTH_MODE=demo explícito y no corre en producción de Vercel', () => {
    expect(loadConfig({}).authMode).toBe('supabase');
    expect(loadConfig({ AUTH_MODE: 'demo' }).authMode).toBe('demo');
    expect(() => loadConfig({ AUTH_MODE: 'demo', VERCEL_ENV: 'production' })).toThrow();
  });
});
