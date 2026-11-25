import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { decryptSecret } from '../core/crypto.js';
import type { Db } from '../core/db/types.js';
import { handleRequest } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import { SilogWebClient } from '../core/silog/web/client.js';
import { describePage, isSafeTarget, isSearchButton, runDiagnostic, summarizeFragments } from '../core/silog/web/diagnostic.js';
import { openWebSession } from '../core/silog/web/session.js';
import { HttpWafSolver, signWafRequest, verifyWafRequest } from '../core/silog/web/waf.js';
import type { WafSolver } from '../core/silog/web/waf.js';
import { saveServiceCredential } from '../core/users.js';
import { newDb } from './helpers.js';

const KEY = 'ab'.repeat(32);
const SECRET = 'secreto-de-sesion-de-prueba-0123456789-abcdef';
const BASE = 'https://silog.example';
const PASS = 'Clave-Servicio-8812';

const P = 'ctl0$MainModule$';
const loginHtml = (err = ''): string => `<html><body><form method="post" action="./index.php?page=LoginPage"><input type="hidden" name="PRADO_PAGESTATE" value="abc"/>
  <input name="${P}Usuario" id="ctl0_MainModule_Usuario"/><input type="password" name="${P}Clave"/><input type="submit" name="${P}BtnIngresar" value="Iniciar Sesion"/>
  <span id="ctl0_MainModule_ErrorPanel">${err}</span></form></body></html>`;
const costHtml = `<html><body><form method="post" action="./index.php?page=LoginPage"><input type="hidden" name="PRADO_PAGESTATE" value="abc"/>
  <select name="${P}centrocosto"><option value="">Seleccione</option><option value="7">Centro Uno</option><option value="8">Centro Dos</option></select>
  <input type="submit" id="ctl0_MainModule_BtnContinuar" name="${P}BtnContinuar" value="Continuar"/></form></body></html>`;
const homeHtml = '<html><body><h1>Inicio</h1></body></html>';
const changeHtml = `<html><body><form method="post" action="./x"><input type="password" name="${P}NuevaClave"/></form></body></html>`;
const twoFaHtml = `<html><body><form method="post" action="./x"><input name="${P}verification_code"/></form></body></html>`;

const tariffHtml = `<html><head><title>Cambio Tarifa</title></head><body><form method="post" action="./index.php?page=Despacho.Remesa_003.CambioTarifa_105">
<input type="hidden" name="PRADO_PAGESTATE" value="zzz"/><input type="hidden" name="PRADO_POSTBACK_TARGET" value=""/>
<table><tr><td>Remesa:</td><td><input type="text" id="ctl0_MainModule_remesa_codigo" name="ctl0$MainModule$remesa_codigo" value="9999999999"/>
<input type="hidden" id="ctl0_MainModule_remesa_codigo_IDHidden" name="ctl0$MainModule$remesa_codigo$IDHidden" value=""/></td><td>Razón de cambio:</td>
<td><textarea id="ctl0_MainModule_cambiotarifa_nota" name="ctl0$MainModule$cambiotarifa_nota"></textarea></td></tr></table>
<input type="submit" id="ctl0_MainModule_buscar" name="ctl0$MainModule$buscar" value="Buscar"/>
<input type="hidden" id="ctl0_MainModule_IDLockHidden_ctl0_MainModule_buscar" name="ctl0$MainModule$IDLockHidden_ctl0_MainModule_buscar" value=""/>
<table><tr><th>Solicitud</th><th>Item</th><th>Cliente</th><th>Tipo Tarifa</th><th>Peso Remesa</th><th>Cantidad Remesa</th><th>Nueva Tarifa</th></tr></table>
<script>new Prado.WebUI.CAutoComplete({'ID':'ctl0_MainModule_remesa_codigo','EventTarget':'ctl0$MainModule$remesa_codigo'});
new Prado.WebUI.TButton({'ID':'ctl0_MainModule_buscar','EventTarget':'ctl0$MainModule$buscar','ValidationGroup':'Requeridos'});
new Prado.WebUI.CRequiredFieldValidator({'ID':'ctl0_MainModule_ctl2','ControlToValidate':'ctl0_MainModule_cambiotarifa_nota','ValidationGroup':'Requeridos'});</script>
</form></body></html>`;
const resultHtml = tariffHtml.replace('<th>Nueva Tarifa</th></tr></table>', `<th>Nueva Tarifa</th></tr><tr><td>1</td><td>1</td><td>Cliente X</td><td>GALON</td><td>10460</td><td><input name="ctl0$MainModule$ctl9$cantidad" value="10460"/></td><td><input name="ctl0$MainModule$ctl9$tarifa" value="235"/></td></tr></table><input type="submit" name="ctl0$MainModule$grabar" value="Grabar"/>`);

interface FakeOpts { user: string; password: string; page?: 'ok' | 'change' | '2fa'; waf?: boolean }
function fakeSilog(o: FakeOpts): { fetch: typeof fetch; log: { method: string; url: string; body: string }[]; posts: () => number } {
  const log: { method: string; url: string; body: string }[] = [];
  let wafOk = !o.waf;
  let loggedIn = false;
  const html = (b: string, status = 200, headers: Record<string, string> = {}): Response => new Response(b, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  const f = (async (u: URL | string, init?: RequestInit) => {
    const url = new URL(String(u));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    log.push({ method, url: url.pathname + url.search, body });
    const cookie = String((init?.headers as Record<string, string>)?.cookie ?? '');
    if (!wafOk && !cookie.includes('aws-waf-token=')) return new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } });
    wafOk = true;
    const q = url.search;
    if (method === 'GET' && q.includes('page=LoginPage')) return html(loginHtml(), 200, { 'set-cookie': 'PHPSESSID=s1; path=/' });
    if (method === 'POST' && q.includes('page=LoginPage')) {
      const p = new URLSearchParams(body);
      if (p.get(`${P}BtnContinuar`) !== null || p.get('PRADO_POSTBACK_TARGET') === `${P}BtnContinuar`) { if (p.get(`${P}centrocosto`) === '7') { loggedIn = true; return html(homeHtml); } return html(costHtml); }
      if (p.get(`${P}Usuario`) !== o.user || p.get(`${P}Clave`) !== o.password) return html(loginHtml('Credenciales inválidas'));
      if (o.page === 'change') return html(changeHtml);
      if (o.page === '2fa') return html(twoFaHtml);
      return html(costHtml);
    }
    if (method === 'POST' && q.includes('CambioTarifa_105')) {
      const p = new URLSearchParams(body);
      if (p.get('PRADO_CALLBACK_TARGET')) return html('<li title="false" ctl0_mainmodule_remesa_codigo="0101228393" ctl0_mainmodule_remesa_codigo_idhidden="55"><table><tr><td>0101228393</td></tr></table></li>');
      if (p.get('ctl0$MainModule$buscar') !== null) return html(resultHtml);
      return html('');
    }
    if (method === 'GET' && q.includes('CambioTarifa_105')) return loggedIn && cookie.includes('PHPSESSID') ? html(tariffHtml) : html(loginHtml());
    if (method === 'GET') return loggedIn && cookie.includes('PHPSESSID') ? html(homeHtml) : html(loginHtml());
    return html('', 200);
  }) as unknown as typeof fetch;
  return { fetch: f, log, posts: () => log.filter((l) => l.method === 'POST').length };
}

describe('cliente web de Silogtran (HTML sintético de la forma real)', () => {
  it('login con centro de costo (el primero), cookies exportables y sesión reutilizable', async () => {
    const s = fakeSilog({ user: 'cuenta', password: PASS });
    const c = new SilogWebClient({ baseUrl: BASE, fetchFn: s.fetch });
    await c.login('cuenta', PASS);
    expect(c.costCenter).toBe('Centro Uno');
    expect(await c.isLoggedIn()).toBe(true);
    const c2 = new SilogWebClient({ baseUrl: BASE, fetchFn: s.fetch });
    c2.importCookies(c.exportCookies());
    expect(await c2.isLoggedIn()).toBe(true);
    expect(await new SilogWebClient({ baseUrl: BASE, fetchFn: s.fetch }).isLoggedIn()).toBe(false);
  });
  it('errores claros: rechazo, cambio de contraseña pendiente y 2FA; sin filtrar la clave', async () => {
    const run = async (o: FakeOpts, pass = PASS) => new SilogWebClient({ baseUrl: BASE, fetchFn: fakeSilog(o).fetch }).login('cuenta', pass).catch((e: unknown) => e as { code: string; message: string });
    const rej = await run({ user: 'cuenta', password: 'otra' });
    expect(rej).toMatchObject({ code: 'WEB_LOGIN_REJECTED' });
    expect(await run({ user: 'cuenta', password: PASS, page: 'change' })).toMatchObject({ code: 'WEB_LOGIN_PASSWORD_CHANGE_REQUIRED' });
    expect(await run({ user: 'cuenta', password: PASS, page: '2fa' })).toMatchObject({ code: 'WEB_LOGIN_2FA_NOT_SUPPORTED' });
    for (const r of [rej]) expect(JSON.stringify(r)).not.toContain(PASS);
    const down = (async () => { throw new Error(`boom ${PASS}`); }) as unknown as typeof fetch;
    const e = (await new SilogWebClient({ baseUrl: BASE, fetchFn: down }).login('cuenta', PASS).catch((x: unknown) => x)) as { code: string; message: string };
    expect(e.code).toBe('WEB_UNREACHABLE');
    expect(e.message).not.toContain(PASS);
  });
  it('reto WAF: resuelve una vez con el solver y reutiliza las cookies; sin solver o si sigue bloqueando, error claro', async () => {
    const s = fakeSilog({ user: 'cuenta', password: PASS, waf: true });
    let solved = 0;
    const solver: WafSolver = { solve: async () => { solved += 1; return { 'aws-waf-token': 'tok', 'aws-waf-x': 'y', otra: 'no' }; } };
    const c = new SilogWebClient({ baseUrl: BASE, fetchFn: s.fetch, waf: solver });
    await c.login('cuenta', PASS);
    expect(solved).toBe(1);
    expect(Object.keys(c.exportCookies())).not.toContain('otra');
    await c.isLoggedIn();
    expect(solved).toBe(1);
    const none = new SilogWebClient({ baseUrl: BASE, fetchFn: fakeSilog({ user: 'u', password: 'p', waf: true }).fetch });
    expect(await none.login('u', 'p').catch((e: unknown) => e)).toMatchObject({ code: 'WEB_WAF_FAILED' });
    const bad: WafSolver = { solve: async () => ({ 'aws-waf-token': '' }) };
    const always = (async () => new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } })) as unknown as typeof fetch;
    expect(await new SilogWebClient({ baseUrl: BASE, fetchFn: always, waf: bad }).isLoggedIn().catch((e: unknown) => e)).toMatchObject({ code: 'WEB_WAF_FAILED' });
  });
  it('las peticiones se serializan (cola)', async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active -= 1; return new Response(homeHtml, { headers: { 'content-type': 'text/html' } }); }) as unknown as typeof fetch;
    const c = new SilogWebClient({ baseUrl: BASE, fetchFn: slow });
    await Promise.all([c.isLoggedIn(), c.isLoggedIn(), c.isLoggedIn()]);
    expect(maxActive).toBe(1);
  });
  it('no sigue redirecciones fuera de Silogtran (no filtra cookies)', async () => {
    const redir = (async () => new Response('', { status: 302, headers: { location: 'https://otro.example/x' } })) as unknown as typeof fetch;
    expect(await new SilogWebClient({ baseUrl: BASE, fetchFn: redir }).isLoggedIn().catch((e: unknown) => e)).toMatchObject({ code: 'WEB_REDIRECT_BLOCKED' });
  });
});

describe('firma de la función del WAF', () => {
  it('HMAC con marca de tiempo reciente; rechaza firmas ajenas, vencidas o sin secreto', () => {
    const now = Date.now();
    const sig = signWafRequest(SECRET, now);
    expect(verifyWafRequest(SECRET, String(now), sig, now)).toBe(true);
    expect(verifyWafRequest(SECRET, String(now), sig, now + 61_000)).toBe(false);
    expect(verifyWafRequest('otro-secreto-de-treinta-y-dos-bytes-xxxxxxxx', String(now), sig, now)).toBe(false);
    expect(verifyWafRequest(SECRET, String(now), 'zz', now)).toBe(false);
    expect(verifyWafRequest(SECRET, undefined, sig, now)).toBe(false);
    expect(verifyWafRequest('', String(now), sig, now)).toBe(false);
  });
  it('HttpWafSolver firma la petición y devuelve solo cookies; falla con mensaje claro', async () => {
    let seen: Record<string, string> = {};
    const f = (async (_u: string, init: RequestInit) => { seen = init.headers as Record<string, string>; return new Response(JSON.stringify({ ok: true, cookies: { 'aws-waf-token': 't' } })); }) as unknown as typeof fetch;
    expect(await new HttpWafSolver('https://x/api/silog-waf', SECRET, f).solve('https://x/login')).toEqual({ 'aws-waf-token': 't' });
    expect(verifyWafRequest(SECRET, seen['x-waf-timestamp'], seen['x-waf-signature'])).toBe(true);
    const bad = (async () => new Response('{"ok":false,"code":"FORBIDDEN"}', { status: 403 })) as unknown as typeof fetch;
    await expect(new HttpWafSolver('https://x', SECRET, bad).solve('u')).rejects.toMatchObject({ code: 'WEB_WAF_FAILED' });
  });
  it('la función api/silog-waf rechaza peticiones sin firma válida (403) sin lanzar Chromium', async () => {
    const mod = await import('../api/silog-waf.js');
    const res = { status: 0, body: '', writeHead(s: number) { this.status = s; }, end(b: string) { this.body = b; } };
    await mod.default({ method: 'POST', headers: {} } as never, res as never);
    expect(res.status).toBe(403);
    await mod.default({ method: 'GET', headers: {} } as never, res as never);
    expect(res.status).toBe(403);
  });
});

describe('sesión web reutilizable (cifrada) y bloqueo', () => {
  let db: Db;
  beforeAll(async () => {
    setLogSink(() => undefined);
    db = await newDb();
    await saveServiceCredential(db, { encryptionKey: KEY }, 'admin', 'adjust', { silogUser: 'cuenta', password: PASS });
  });
  afterAll(async () => db.close());
  const deps = (f: typeof fetch, waf: WafSolver | null = null) => ({ db, encryptionKey: KEY, baseUrl: BASE, waf, fetchFn: f });

  it('login, guarda cookies cifradas, la segunda vez reutiliza sin hacer login; nada en claro', async () => {
    const s = fakeSilog({ user: 'cuenta', password: PASS });
    const a = await openWebSession(deps(s.fetch), 'adjust', 'u1');
    expect(a.reused).toBe(false);
    await a.close();
    const stored = (await db.query<{ id: string; cookies_enc: string }>('select id, cookies_enc from silog_web_sessions')).rows[0] as { id: string; cookies_enc: string };
    expect(stored.cookies_enc.startsWith('v1:')).toBe(true);
    expect(stored.cookies_enc).not.toContain('PHPSESSID');
    expect(JSON.parse(decryptSecret(stored.cookies_enc, stored.id, KEY))).toHaveProperty('PHPSESSID');
    expect(() => decryptSecret(stored.cookies_enc, 'otro', KEY)).toThrow();
    const posts = s.posts();
    const b = await openWebSession(deps(s.fetch), 'adjust', 'u1');
    expect(b.reused).toBe(true);
    expect(s.posts()).toBe(posts); // sin nuevo login
    await b.close();
    expect(JSON.stringify((await db.query('select * from audit_log')).rows)).not.toContain(PASS);
  });
  it('rotación: cada cierre re-cifra con IV nuevo', async () => {
    const s = fakeSilog({ user: 'cuenta', password: PASS });
    const before = (await db.query<{ cookies_enc: string }>('select cookies_enc from silog_web_sessions')).rows[0]?.cookies_enc;
    const x = await openWebSession(deps(s.fetch), 'adjust', null);
    await x.close();
    const after = (await db.query<{ cookies_enc: string }>('select cookies_enc from silog_web_sessions')).rows[0]?.cookies_enc;
    expect(after).not.toBe(before);
  });
  it('no hay dos sesiones simultáneas de la misma cuenta; se libera al cerrar', async () => {
    const s = fakeSilog({ user: 'cuenta', password: PASS });
    const a = await openWebSession(deps(s.fetch), 'adjust', null);
    await expect(openWebSession(deps(s.fetch), 'adjust', null)).rejects.toMatchObject({ code: 'WEB_SESSION_BUSY' });
    await a.close();
    const again = await openWebSession(deps(s.fetch), 'adjust', null);
    await again.close();
  });
  it('error de login libera el bloqueo, no guarda sesión y no reintenta en bucle', async () => {
    await db.query(`update silog_web_sessions set cookies_enc = null`);
    const s = fakeSilog({ user: 'cuenta', password: 'otra-clave' });
    await expect(openWebSession(deps(s.fetch), 'adjust', null)).rejects.toMatchObject({ code: 'WEB_LOGIN_REJECTED' });
    expect(s.posts()).toBe(1); // un solo intento de login
    const row = (await db.query<{ lock_until: Date | null; last_error_code: string; cookies_enc: string | null }>('select lock_until, last_error_code, cookies_enc from silog_web_sessions')).rows[0];
    expect(row).toMatchObject({ lock_until: null, last_error_code: 'WEB_LOGIN_REJECTED', cookies_enc: null });
  });
  it('conserva solo las cookies del WAF tras un login fallido', async () => {
    const s = fakeSilog({ user: 'cuenta', password: 'otra-clave', waf: true });
    const solver: WafSolver = { solve: async () => ({ 'aws-waf-token': 'tok' }) };
    await expect(openWebSession(deps(s.fetch, solver), 'adjust', null)).rejects.toMatchObject({ code: 'WEB_LOGIN_REJECTED' });
    const r = (await db.query<{ id: string; cookies_enc: string }>('select id, cookies_enc from silog_web_sessions')).rows[0] as { id: string; cookies_enc: string };
    expect(Object.keys(JSON.parse(decryptSecret(r.cookies_enc, r.id, KEY)))).toEqual(['aws-waf-token']);
  });
  it('sin cuenta de servicio guardada: error claro', async () => {
    const empty = await newDb();
    await expect(openWebSession({ db: empty, encryptionKey: KEY, baseUrl: BASE, waf: null }, 'adjust', null)).rejects.toMatchObject({ code: 'ADJUST_ACCOUNT_NOT_CONFIGURED' });
    await empty.close();
  });
});

describe('diagnóstico (estructura de la pantalla)', () => {
  it('describe controles, widgets, autocompletado, tablas, etiquetas y validadores; sin valores', () => {
    const st = describePage(tariffHtml);
    expect(st.controls.map((c) => c.id)).toEqual(expect.arrayContaining(['ctl0_MainModule_remesa_codigo', 'ctl0_MainModule_cambiotarifa_nota', 'ctl0_MainModule_buscar']));
    expect(st.controls.find((c) => c.id === 'ctl0_MainModule_remesa_codigo')).not.toHaveProperty('value');
    expect(JSON.stringify(st)).not.toContain('9999999999'); // el valor del campo no se devuelve
    expect(st.autoCompletes).toEqual(['ctl0_MainModule_remesa_codigo']);
    expect(st.widgets.find((w) => w.cls === 'TButton')).toMatchObject({ eventTarget: 'ctl0$MainModule$buscar', validationGroup: 'Requeridos' });
    expect(st.tables.some((t) => t.headers.join('|') === 'Solicitud|Item|Cliente|Tipo Tarifa|Peso Remesa|Cantidad Remesa|Nueva Tarifa')).toBe(true);
    expect(st.validators[0]).toMatchObject({ controlToValidate: 'ctl0_MainModule_cambiotarifa_nota', validationGroup: 'Requeridos' });
    expect(st.looksLikeLogin).toBe(false);
    expect(describePage(loginHtml()).looksLikeLogin).toBe(true);
  });
  it('destinos inseguros (Grabar, botones) se descartan; nunca se hace POST a botones', async () => {
    expect(isSafeTarget('ctl0$MainModule$cargar')).toBe(true);
    for (const t of ['ctl0$MainModule$Grabar', 'ctl0$MainModule$btnGrabarCb', 'ctl0$x$BtnAceptar', null]) expect(isSafeTarget(t as string)).toBe(false);
    expect(isSearchButton({ type: 'submit', name: 'ctl0$MainModule$buscar', id: 'x' })).toBe(true);
    expect(isSearchButton({ type: 'submit', name: 'ctl0$MainModule$grabar', id: 'x' })).toBe(false);
    expect(isSearchButton({ type: 'submit', name: 'ctl0$MainModule$buscar_y_grabar', id: 'x' })).toBe(false);
    const s = fakeSilog({ user: 'cuenta', password: PASS });
    const c = new SilogWebClient({ baseUrl: BASE, fetchFn: s.fetch });
    await c.login('cuenta', PASS);
    const before = s.log.length;
    const r = await runDiagnostic(c, { lookup: true, remesa: '0101228393', reused: false });
    const posts = s.log.slice(before).filter((l) => l.method === 'POST');
    expect(r.lookup?.steps.map((x) => x.step)).toEqual(expect.arrayContaining(['identificar controles Remesa', 'autocompletar remesa (callback de lectura)']));
    expect(posts.length).toBe(1); // solo el callback de autocompletado
    for (const p of posts) {
      const f = new URLSearchParams(p.body);
      expect(f.get('PRADO_CALLBACK_TARGET'), 'solo callbacks de lectura').not.toBeNull();
      expect(f.get('PRADO_POSTBACK_TARGET')).not.toMatch(/grabar/i);
    }
    // con la bandera de búsqueda: un envío del botón Buscar (lectura), jamás Grabar
    const before2 = s.log.length;
    const r2 = await runDiagnostic(c, { lookup: true, search: true, remesa: '0101228393', reused: false });
    const posts2 = s.log.slice(before2).filter((l) => l.method === 'POST').map((l) => new URLSearchParams(l.body));
    expect(posts2.length).toBe(2);
    expect(posts2[1]?.get('ctl0$MainModule$buscar')).toBe('Buscar');
    for (const f of posts2) expect([...f.keys()].some((k) => /grabar/i.test(k)) && f.get('ctl0$MainModule$grabar') !== null).toBe(false);
    const after = r2.lookup?.afterSearch;
    expect(after?.tables.some((t) => t.inputs.some((i) => /cantidad/.test(i.name ?? '')))).toBe(true);
    expect(after?.controls.some((x) => /grabar/i.test(x.name ?? ''))).toBe(true); // se observa el botón, nunca se envía
    expect(r2.lookup?.numericFields).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ctl0$MainModule$ctl9$tarifa', value: '235' })]));
  });
  it('resumen de fragmentos: valores numéricos de peso/cantidad/tarifa', () => {
    const s = summarizeFragments([`<table><tr><th>Peso</th></tr><tr><td><input name="x$peso" value="10460" readonly/><input name="x$tarifa" value="235"/><input name="x$nombre" value="Pepe"/></td></tr></table>`]);
    expect(s.numeric).toEqual([{ name: 'x$peso', value: '10460', disabled: false, readOnly: true }, { name: 'x$tarifa', value: '235', disabled: false, readOnly: false }]);
  });
});

describe('endpoint de diagnóstico (admin)', () => {
  let ctx: AppContext;
  const tok: Record<string, string> = {};
  const call = (m: string, p: string, t?: string, b?: unknown) => handleRequest(ctx, { method: m, path: p, query: {}, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b });
  const j = <T>(r: { json?: unknown }): T => r.json as T;
  beforeAll(async () => {
    ctx = await createContext({
      AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afw-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: KEY,
      APP_SESSION_SECRET: SECRET, SILOG_BASE_URL: `${BASE}/index.php`, SILOG_USER: 'x', SILOG_PASSWORD: 'y',
    });
    ctx.webFetch = fakeSilog({ user: 'cuenta', password: PASS }).fetch;
    for (const [k, e] of [['admin', 'admin@demo.local'], ['fact', 'facturacion@demo.local'], ['op', 'operador@demo.local'], ['view', 'lector@demo.local']] as const) {
      tok[k] = j<{ token: string }>(await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' })).token;
    }
  });
  afterAll(async () => ctx.db.close());

  it('solo admin: facturación, operador y lector reciben 403; sin sesión 401', async () => {
    expect((await call('POST', '/api/admin/silog-web/diagnostic', undefined, {})).status).toBe(401);
    for (const k of ['fact', 'op', 'view']) expect((await call('POST', '/api/admin/silog-web/diagnostic', tok[k], {})).status, k).toBe(403);
  });
  it('sin cuenta de ajustes guardada: error claro', async () => {
    const r = await call('POST', '/api/admin/silog-web/diagnostic', tok.admin, {});
    expect(r.status).toBe(409);
    expect(j<{ error: { code: string } }>(r).error.code).toBe('ADJUST_ACCOUNT_NOT_CONFIGURED');
  });
  it('con la cuenta guardada devuelve la estructura, audita y NUNCA expone cookies, claves ni valores', async () => {
    expect((await call('PUT', '/api/service-credentials/adjust', tok.admin, { silogUser: 'cuenta', password: PASS })).status).toBe(200);
    const r = await call('POST', '/api/admin/silog-web/diagnostic', tok.admin, { lookup: true });
    expect(r.status).toBe(200);
    const out = j<{ ok: boolean; structure: { tables: { headers: string[] }[] }; lookup: { steps: { step: string }[] } }>(r);
    expect(out.ok).toBe(true);
    expect(out.structure.tables.flatMap((t) => t.headers)).toContain('Nueva Tarifa');
    expect(out.lookup.steps.length).toBeGreaterThan(0);
    const text = JSON.stringify(r.json) + JSON.stringify((await ctx.db.query('select * from audit_log')).rows);
    for (const secret of [PASS, 'PHPSESSID', 'aws-waf', KEY, SECRET, '9999999999']) expect(text, secret).not.toContain(secret);
    const acts = (await ctx.db.query<{ action: string }>(`select action from audit_log where action like 'silog_web.%'`)).rows.map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['silog_web.diagnostic', 'silog_web.session']));
    expect((await call('POST', '/api/admin/silog-web/diagnostic', tok.admin, { remesa: 'abc' })).status).toBe(400);
  });
  it('errores de Silogtran web se devuelven con código claro y sin reintento en bucle', async () => {
    const f = fakeSilog({ user: 'cuenta', password: PASS, page: 'change' });
    ctx.webFetch = f.fetch;
    await ctx.db.query(`update silog_web_sessions set cookies_enc = null`);
    const r = await call('POST', '/api/admin/silog-web/diagnostic', tok.admin, {});
    expect(j<{ error: { code: string } }>(r).error.code).toBe('WEB_LOGIN_PASSWORD_CHANGE_REQUIRED');
    expect(f.posts()).toBe(1);
  });
});
