import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import type { Db } from '../core/db/types.js';
import { handleRequest } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import { MockSilogtranSource } from '../core/recon/silogtran.js';
import { SilogtranWebWriter, classifyGrabarResponse, decodeEntities } from '../core/silog/web/writer.js';
import { homeNumber, parseRemesaHome } from '../core/silog/web/remesa.js';
import { describeRemesaHome } from '../core/silog/web/diagnostic.js';
import type { ProposalDto, ProposalEventDto, RehearsalDto } from '../core/types.js';
import { saveServiceCredential } from '../core/users.js';
import { TERPEL_NIT, silogRow } from '../fixtures/silogtran.js';
import { newDb } from './helpers.js';

const KEY = 'cd'.repeat(32);
const SECRET = 'secreto-de-sesion-de-prueba-0123456789-abcdef';
const BASE = 'https://silog.example';
const PASS = 'Clave-Servicio-5521';
const P = 'ctl0$MainModule$';
const REMESA = 101228393;
const CODE10 = '0101228393';

const html = (b: string, status = 200, headers: Record<string, string> = {}): Response => new Response(b, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const loginHtml = `<html><body><form method="post" action="./index.php?page=LoginPage"><input type="hidden" name="PRADO_PAGESTATE" value="a"/><input name="${P}Usuario"/><input type="password" name="${P}Clave"/><input type="submit" name="${P}BtnIngresar" value="Iniciar Sesion"/></form></body></html>`;
const costHtml = `<html><body><form method="post" action="./index.php?page=LoginPage"><input type="hidden" name="PRADO_PAGESTATE" value="a"/><select name="${P}centrocosto"><option value="7">Centro</option></select><input type="submit" id="ctl0_MainModule_BtnContinuar" name="${P}BtnContinuar" value="Continuar"/></form></body></html>`;

type GrabarMode = 'success' | 'ambiguous' | 'error' | 'lost' | 'lost_noapply';
interface Screen { peso: string; cantidad: string; tarifa: string }
interface Fake {
  fetch: typeof fetch;
  screen: Screen;
  mode: GrabarMode;
  found: boolean;
  items: number;
  expireAtBuscar: boolean;
  uuidSeq: number;
  /** Columna «Cantidad» de la consulta: cantidad ORIGINAL de la solicitud (el cambio de tarifa no la modifica). */
  solicitada: string;
  homeBroken: boolean;
  noEffect: boolean;
  grabarPosts: URLSearchParams[];
  allPosts: URLSearchParams[];
  onApply?: (s: Screen) => void;
}

function fake(): Fake {
  const f: Fake = {
    screen: { peso: '10500', cantidad: '10500', tarifa: '235' }, mode: 'success', found: true, items: 1, expireAtBuscar: false, uuidSeq: 1, solicitada: '10500', homeBroken: false, noEffect: false,
    grabarPosts: [], allPosts: [], fetch: undefined as unknown as typeof fetch,
  };
  let loggedIn = false;
  const itemRows = (): string => Array.from({ length: f.items }, (_, i) => `<tr><td>1</td><td>${i + 1}</td><td>Cliente X</td><td>GALON</td><td>${f.screen.peso}</td>
    <td><input type="text" name="${P}ItemsRemesa$ctl${i}$nuevo_cantidad" value="${f.solicitada}"/><input type="hidden" name="${P}ItemsRemesa$ctl${i}$anterior_cantidad" value="${f.solicitada}"/></td>
    <td><input type="text" name="${P}ItemsRemesa$ctl${i}$nueva_tarifa" value="${f.screen.tarifa}"/><input type="hidden" name="${P}ItemsRemesa$ctl${i}$anterior_tarifa" value="${f.screen.tarifa}"/>
    <input type="text" name="${P}ItemsRemesa$ctl${i}$nuevo_peso" value="${f.screen.peso}"/><input type="hidden" name="${P}ItemsRemesa$ctl${i}$anterior_peso" value="${f.screen.peso}"/></td></tr>`).join('');
  const page = (searched: boolean, msg = ''): string => `<html><head><title>Silogtran - Remesa_003</title></head><body><form method="post" action="/index.php?page=Despacho.Remesa_003.CambioTarifa_105">
    <input type="hidden" name="PRADO_PAGESTATE" value="ps"/><input type="hidden" name="PRADO_POSTBACK_TARGET" value=""/>
    <input type="text" id="ctl0_MainModule_remesa_codigo" name="${P}remesa_codigo" value="" ${searched ? 'disabled' : ''}/><input type="hidden" name="${P}remesa_codigo$IDHidden" value=""/>
    <textarea id="ctl0_MainModule_cambiotarifa_nota" name="${P}cambiotarifa_nota"></textarea>
    ${searched ? `<input type="submit" id="ctl0_MainModule_grabar" name="${P}grabar" value="Grabar"/><input type="hidden" name="${P}IDLockHidden_ctl0_MainModule_grabar" value=""/>
      <table>${itemRows()}</table>` : `<input type="submit" id="ctl0_MainModule_buscar" name="${P}buscar" value="Buscar"/><input type="hidden" name="${P}IDLockHidden_ctl0_MainModule_buscar" value=""/>`}
    <input type="hidden" name="${P}grabar_uuid" value="U${f.uuidSeq}"/><span id="ctl0_MainModule_mensaje">${msg}</span>
    <script>new Prado.WebUI.CAutoComplete({'ID':'ctl0_MainModule_remesa_codigo','EventTarget':'${P}remesa_codigo'});</script></form></body></html>`;
  const money = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const homePage = (): string => `<html><body><span id="ctl0_MainModule_tarifa_cliente">${f.screen.tarifa}</span>
    <input type="text" id="ctl0_MainModule_remesa_flete" name="${P}remesa_flete" value="${money(Math.round(Number(f.screen.peso) * Number(f.screen.tarifa)))}"/>
    <input type="hidden" id="ctl0_MainModule_remesa_flete_hidden" name="${P}remesa_flete_hidden" value=""/>
    <table id="ctl0_MainModule_ItemsRemesa"><tr><th>Borrar</th><th>Editar</th><th>Cantidad</th><th>Producto</th><th>Empaque</th><th>Unidad Medida</th><th>Peso</th><th>Peso Bruto</th><th>Volumen</th><th>Descripcion</th><th>Remision</th><th>Despacho</th><th>Valorizacion</th><th>Valor Declarado</th></tr>
    <tr><td>Borrar</td><td>Editar</td><td>${f.solicitada}</td><td>B-100</td><td>GRANEL LIQUIDO</td><td></td><td>${f.screen.peso}</td><td>${f.screen.cantidad}</td><td>0</td><td>B-100</td><td></td><td>DESPACHO</td><td>0</td><td>0</td></tr></table></body></html>`;
  f.fetch = (async (u: URL | string, init?: RequestInit) => {
    const url = new URL(String(u));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const q = url.search;
    const cookie = String((init?.headers as Record<string, string>)?.cookie ?? '');
    if (method === 'GET' && q.includes('page=LoginPage')) return html(loginHtml, 200, { 'set-cookie': 'PHPSESSID=s1; path=/' });
    if (method === 'POST' && q.includes('page=LoginPage')) {
      const p = new URLSearchParams(body);
      if (p.get('PRADO_POSTBACK_TARGET') === `${P}BtnContinuar`) { loggedIn = true; return html('<html>Inicio</html>'); }
      return p.get(`${P}Clave`) === PASS ? html(costHtml) : html(loginHtml);
    }
    const authed = loggedIn && cookie.includes('PHPSESSID');
    if (method === 'GET' && q.includes('Home_111')) return authed && !f.homeBroken ? html(homePage()) : html(f.homeBroken ? '<html>sin tabla</html>' : loginHtml);
    if (method === 'GET' && q.includes('CambioTarifa_105')) return authed ? html(page(false)) : html(loginHtml);
    if (method === 'GET') return authed ? html('<html>Inicio</html>') : html(loginHtml);
    if (method === 'POST' && q.includes('CambioTarifa_105')) {
      if (!authed) return html(loginHtml);
      const p = new URLSearchParams(body);
      f.allPosts.push(p);
      if (p.get('PRADO_CALLBACK_TARGET')) {
        return html(f.found ? `<li title="false" ctl0_mainmodule_remesa_codigo="${CODE10}" ctl0_mainmodule_remesa_codigo_idhidden="55"><table><tr><td>${CODE10}</td><td>x</td></tr></table></li>` : '');
      }
      if (p.get(`${P}grabar`) !== null) {
        f.grabarPosts.push(p);
        const apply = (): void => {
          if (f.noEffect) return;
          f.screen = { peso: p.get(`${P}ItemsRemesa$ctl0$nuevo_peso`) as string, cantidad: p.get(`${P}ItemsRemesa$ctl0$nuevo_cantidad`) as string, tarifa: p.get(`${P}ItemsRemesa$ctl0$nueva_tarifa`) as string };
          f.onApply?.(f.screen);
          f.uuidSeq += 1;
        };
        if (f.mode === 'lost') { apply(); throw new Error('socket hang up'); }
        if (f.mode === 'lost_noapply') throw new Error('socket hang up');
        if (f.mode === 'success') { apply(); return html(page(false, 'La remesa #0101228393 fue actualizado con &eacute;xito!')); }
        if (f.mode === 'ambiguous') { apply(); return html(page(false, 'Proceso terminado.')); }
        return html(page(true, 'Error: la tarifa no es válida.'));
      }
      if (p.get(`${P}buscar`) !== null) {
        if (f.expireAtBuscar) { loggedIn = false; return html(loginHtml); }
        return html(page(true));
      }
    }
    return html('');
  }) as unknown as typeof fetch;
  return f;
}

const CHANGE = { remesaCode: String(REMESA), reason: 'Ajuste según autorización de pago Terpel, transporte T1, gasto G1', pesoRemesa: '10487', cantidadRemesa: '10487', nuevaTarifa: '235' };

describe('clasificación del mensaje de Grabar', () => {
  it('texto real de Silogtran, con entidades HTML y en cualquier contenedor', () => {
    const real = 'La remesa #0101228393 fue actualizado con &eacute;xito!';
    expect(classifyGrabarResponse(`<span id="ctl0_MainModule_mensaje">${real}</span>`).verdict).toBe('success');
    expect(classifyGrabarResponse('<span>La remesa #0101228393 fue actualizado con éxito!</span>').verdict).toBe('success');
    // La página trae identificadores de ruta con «Error» que no son mensajes de error.
    const withIds = '<script>var k=["Basicos.Error.Buscar","Basicos.Error.Home","Basicos.PlanosMinisterio_2011.ArchivoErrores","Despacho.Manifiesto_003.InformeErroresMinisterio"];</script><span>La remesa #101229389 fue actualizado con &eacute;xito!</span>';
    expect(classifyGrabarResponse(withIds).verdict).toBe('success');
    expect(classifyGrabarResponse('<span>Error: no se pudo grabar la remesa</span>').verdict).toBe('error');
    expect(classifyGrabarResponse('<span>LA REMESA #0101228393 FUE ACTUALIZADO CON EXITO!</span>').verdict).toBe('success');
    expect(classifyGrabarResponse('<span>La remesa #0101228393 fue actualizado con &#233;xito!</span>').verdict).toBe('success');
    expect(classifyGrabarResponse(`<script>alert("${real}");</script><p>x</p>`).verdict).toBe('success'); // dentro de un script
    expect(classifyGrabarResponse('<span>La&nbsp;remesa #0101228393 fue actualizado con &eacute;xito!</span>').verdict).toBe('success');
    expect(decodeEntities('&eacute;&nbsp;&amp;&#233;&#xE9;&desconocida;')).toBe('é &éé&desconocida;');
    expect(classifyGrabarResponse('<span>Operación completada</span>').verdict).toBe('ambiguous'); // desconocido: nunca éxito
  });
  it('solo el mensaje de éxito conocido es éxito; todo lo demás es ambiguo o error', () => {
    expect(classifyGrabarResponse('<span id="ctl0_MainModule_mensaje">El registro ha sido guardado.</span>').verdict).toBe('success');
    expect(classifyGrabarResponse('<span id="ctl0_MainModule_mensaje">Proceso terminado.</span>').verdict).toBe('ambiguous');
    expect(classifyGrabarResponse('<html><body>nada</body></html>').verdict).toBe('ambiguous');
    expect(classifyGrabarResponse('<span id="ctl0_MainModule_mensaje">Error: la tarifa no es válida.</span>').verdict).toBe('error');
    expect(classifyGrabarResponse('<span id="ctl0_MainModule_mensaje">El registro ha sido guardado. Error al enviar correo</span>').verdict).toBe('ambiguous');
  });
});

describe('consulta de la remesa (Home_111): parseo por encabezados', () => {
  const page = (cols: [string, string][], tarifa = '<span id="ctl0_MainModule_tarifa_cliente">235</span>', flete = '<input type="text" id="ctl0_MainModule_remesa_flete" name="ctl0$MainModule$remesa_flete" value="2,464,445"/>') =>
    `<html><body>${tarifa}${flete}<table id="ctl0_MainModule_ItemsRemesa"><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr><tr>${cols.map((c) => `<td>${c[1]}</td>`).join('')}</tr></table></body></html>`;
  const real: [string, string][] = [['Borrar', 'Borrar'], ['Editar', 'Editar'], ['Cantidad', '10500'], ['Producto', 'B-100'], ['Empaque', 'GRANEL LIQUIDO'], ['Unidad Medida', ''], ['Peso', '10487'], ['Peso Bruto', '10487'], ['Volumen', '0'], ['Descripcion', 'B-100'], ['Remision', ''], ['Despacho', 'DESPACHO'], ['Valorizacion', '0'], ['Valor Declarado', '0']];
  it('lee Peso, Peso Bruto, Cantidad (solicitada), tarifa_cliente y remesa_flete (comas de miles)', () => {
    expect(parseRemesaHome(page(real))).toEqual({ peso: '10487', pesoBruto: '10487', cantidadSolicitada: '10500', volumen: '0', tarifa: '235', flete: '2464445' });
  });
  it('por NOMBRE de columna: otro orden de columnas da lo mismo', () => {
    const shuffled = [real[6], real[2], real[7], real[0], real[8]] as [string, string][];
    expect(parseRemesaHome(page(shuffled))).toMatchObject({ peso: '10487', pesoBruto: '10487', cantidadSolicitada: '10500' });
    const swapped = real.map((c) => (c[0] === 'Peso' ? ['Peso', '10400'] : c)) as [string, string][];
    expect(parseRemesaHome(page(swapped))).toMatchObject({ peso: '10400', pesoBruto: '10487' }); // parcialmente cambiada: se distingue
  });
  it('página no legible: errores claros, sin asumir valores', () => {
    expect(() => parseRemesaHome('<html>nada</html>')).toThrow(/tabla de ítems/);
    expect(() => parseRemesaHome(page(real.filter((c) => c[0] !== 'Peso Bruto')))).toThrow(/columnas/);
    expect(() => parseRemesaHome(page(real.map((c) => (c[0] === 'Peso' ? ['Peso', 'abc'] : c)) as [string, string][]))).toThrow(/numéricos/);
    expect(() => parseRemesaHome(page(real, '<span id="ctl0_MainModule_x">235</span>'))).toThrow(/tarifa_cliente/);
    expect(() => parseRemesaHome(page(real, undefined, ''))).toThrow(/remesa_flete/);
    expect(() => parseRemesaHome('<form><input name="ctl0$MainModule$BtnIngresar"/></form>')).toThrow(/login/);
  });
  it('el diagnóstico describe la consulta (tabla por encabezados y campos de tarifa/flete)', () => {
    const d = describeRemesaHome(page(real));
    expect(d.tables[0]?.headers).toContain('Peso Bruto');
    expect(d.tables[0]?.rows[0]?.[6]).toBe('10487');
    expect(d.fields.map((x) => x.id)).toEqual(expect.arrayContaining(['ctl0_MainModule_tarifa_cliente', 'ctl0_MainModule_remesa_flete']));
  });
  it('números con comas de miles y decimales', () => {
    expect(homeNumber('2,464,445')).toBe('2464445');
    expect(homeNumber('10487.0')).toBe('10487');
    expect(homeNumber('1,234.50')).toBe('1234.5');
    expect(homeNumber('1,5')).toBeNull();
    expect(homeNumber('')).toBeNull();
  });
});

describe('SilogtranWebWriter (HTML sintético fiel al mapa de la pantalla)', () => {
  let db: Db;
  let f: Fake;
  const writer = () => new SilogtranWebWriter({ db, encryptionKey: KEY, baseUrl: BASE, waf: null, fetchFn: () => f.fetch });
  beforeAll(async () => {
    setLogSink(() => undefined);
    db = await newDb();
    await saveServiceCredential(db, { encryptionKey: KEY }, 'admin', 'adjust', { silogUser: 'cuenta', password: PASS });
  });
  afterAll(async () => db.close());

  it('ensayo: secuencia correcta, devuelve lo que se enviaría y la reversa, y JAMÁS emite el postback de grabar', async () => {
    f = fake();
    const r = await writer().rehearse(CHANGE, { actor: 'u' });
    expect(r.before).toMatchObject({ peso: '10500', cantidad: '10500', tarifa: '235' });
    expect(r.payload).toEqual(CHANGE);
    expect(r.wouldPostGrabar).toBe(false);
    expect(r.grabar).toEqual({ target: `${P}grabar`, hasUuid: true, hasLock: true });
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(f.grabarPosts).toHaveLength(0);
    expect(f.allPosts.some((p) => p.get(`${P}grabar`) !== null || /grabar/i.test(p.get('PRADO_POSTBACK_TARGET') ?? ''))).toBe(false);
    expect(f.screen).toEqual({ peso: '10500', cantidad: '10500', tarifa: '235' }); // nada cambió
    // orden: autocompletado y luego Buscar
    expect(f.allPosts.map((p) => (p.get('PRADO_CALLBACK_TARGET') ? 'suggest' : p.get(`${P}buscar`) ? 'buscar' : 'otro'))).toEqual(['suggest', 'buscar']);
    const bp = f.allPosts[1] as URLSearchParams;
    expect(bp.get(`${P}cambiotarifa_nota`)).toBe(CHANGE.reason);
    expect(bp.get(`${P}remesa_codigo$IDHidden`)).toBe('55');
  });

  it('grabado correcto: UN solo grabar con los valores, IDLock y grabar_uuid de la página; reversa guardada', async () => {
    f = fake();
    const out = await writer().changeTariff(CHANGE, { actor: 'u' });
    expect(out).toMatchObject({ outcome: 'applied', before: { peso: '10500', cantidad: '10500', tarifa: '235' } });
    expect(f.grabarPosts).toHaveLength(1);
    const g = f.grabarPosts[0] as URLSearchParams;
    expect(g.get(`${P}ItemsRemesa$ctl0$nuevo_peso`)).toBe('10487');
    expect(g.get(`${P}ItemsRemesa$ctl0$nuevo_cantidad`)).toBe('10487');
    expect(g.get(`${P}ItemsRemesa$ctl0$nueva_tarifa`)).toBe('235');
    expect(g.get(`${P}cambiotarifa_nota`)).toBe(CHANGE.reason);
    expect(g.get(`${P}IDLockHidden_ctl0_MainModule_grabar`)).toBe('true');
    expect(g.get(`${P}grabar_uuid`)).toBe('U1');
    expect(g.get(`${P}ItemsRemesa$ctl0$anterior_peso`)).toBe('10500');
    expect(f.screen).toEqual({ peso: '10487', cantidad: '10487', tarifa: '235' });
  });

  it('mensaje desconocido o ambiguo: nunca éxito (uncertain); el estado consultado confirma que se aplicó; sin reintento', async () => {
    f = fake();
    f.mode = 'ambiguous';
    const w = writer();
    const out = await w.changeTariff(CHANGE, { actor: 'u' });
    expect(out.outcome).toBe('uncertain');
    expect(f.grabarPosts).toHaveLength(1);
    expect((await w.getChangeState(CHANGE.remesaCode, CHANGE, { actor: 'u', expectedBefore: { peso: '10500', cantidad: '10500', tarifa: '235' } })).state).toBe('applied');
    expect(f.grabarPosts).toHaveLength(1); // consultar no graba
  });

  it('respuesta perdida: uncertain, un solo grabar; consulta distingue aplicado de no aplicado', async () => {
    f = fake();
    f.mode = 'lost';
    const w = writer();
    expect((await w.changeTariff(CHANGE, { actor: 'u' })).outcome).toBe('uncertain');
    expect(f.grabarPosts).toHaveLength(1);
    expect((await w.getChangeState(CHANGE.remesaCode, CHANGE, { actor: 'u' })).state).toBe('applied');
    f = fake();
    f.mode = 'lost_noapply';
    const w2 = writer();
    expect((await w2.changeTariff(CHANGE, { actor: 'u' })).outcome).toBe('uncertain');
    expect((await w2.getChangeState(CHANGE.remesaCode, CHANGE, { actor: 'u', expectedBefore: { peso: '10500', cantidad: '10500', tarifa: '235' } })).state).toBe('not_applied');
    expect(f.grabarPosts).toHaveLength(1);
  });

  it('getChangeState: aplicado / no aplicado / parcial con detalle por campo / página ilegible', async () => {
    const before = { peso: '10500', cantidad: '10500', tarifa: '235' };
    f = fake();
    const w = writer();
    expect(await w.getChangeState(CHANGE.remesaCode, CHANGE, { actor: 'u', expectedBefore: before })).toMatchObject({ state: 'not_applied' });
    f.screen = { peso: '10487', cantidad: '10487', tarifa: '235' };
    const ok = await w.getChangeState(CHANGE.remesaCode, { ...CHANGE, valorTotal: '2464445' }, { actor: 'u', expectedBefore: before });
    expect(ok.state).toBe('applied');
    expect(ok.fields?.flete).toMatchObject({ ok: true, actual: '2464445' });
    f.screen = { peso: '10487', cantidad: '10500', tarifa: '235' }; // solo el peso cambió
    const partial = await w.getChangeState(CHANGE.remesaCode, CHANGE, { actor: 'u', expectedBefore: before });
    expect(partial.state).toBe('unknown');
    expect(partial.fields).toMatchObject({ peso: { ok: true }, cantidad: { ok: false, expected: '10487', actual: '10500' } });
    expect(partial.detail).toMatch(/parcial/);
    f.homeBroken = true;
    expect(await w.getChangeState(CHANGE.remesaCode, CHANGE, { actor: 'u' })).toMatchObject({ state: 'unknown' });
    expect(f.grabarPosts).toHaveLength(0);
  });

  it('éxito reconocido con el texto real y verificado en la consulta, aunque el informe no cambie', async () => {
    f = fake();
    const out = await writer().changeTariff({ ...CHANGE, valorTotal: '2464445' }, { actor: 'u' });
    expect(out).toMatchObject({ outcome: 'applied', after: { peso: '10487', cantidad: '10487', tarifa: '235', flete: '2464445' } });
  });

  it('la remesa ya tiene los valores: no se graba (ya ajustado)', async () => {
    f = fake();
    f.screen = { peso: '10487', cantidad: '10487', tarifa: '235' };
    expect(await writer().changeTariff(CHANGE, { actor: 'u' })).toMatchObject({ outcome: 'stale', detail: expect.stringMatching(/ya ajustado/) });
    expect(f.grabarPosts).toHaveLength(0);
  });

  it('error explícito sin efecto: rejected (certeza)', async () => {
    f = fake();
    f.mode = 'error';
    const out = await writer().changeTariff(CHANGE, { actor: 'u' });
    expect(out).toMatchObject({ outcome: 'rejected' });
    expect(f.screen.peso).toBe('10500');
  });

  it('los valores anteriores cambiaron entre el ensayo y el grabado: abortar sin grabar', async () => {
    f = fake();
    const out = await writer().changeTariff(CHANGE, { actor: 'u', expectedBefore: { peso: '10400', cantidad: '10500', tarifa: '235' } });
    expect(out.outcome).toBe('stale');
    expect(f.grabarPosts).toHaveLength(0);
    expect(await writer().changeTariff(CHANGE, { actor: 'u', expectedBefore: { peso: '10500.0000', cantidad: '10500', tarifa: '235.00' } })).toMatchObject({ outcome: 'applied' }); // igualdad numérica
  });

  it('remesa sin coincidencia, varios ítems, tarifa demasiado larga, sesión expirada: no se graba', async () => {
    f = fake(); f.found = false;
    expect((await writer().changeTariff(CHANGE, { actor: 'u' })).outcome).toBe('rejected');
    f = fake(); f.items = 2;
    expect((await writer().changeTariff(CHANGE, { actor: 'u' })).outcome).toBe('rejected');
    f = fake();
    expect((await writer().changeTariff({ ...CHANGE, nuevaTarifa: '123.123456789' }, { actor: 'u' })).outcome).toBe('rejected');
    expect((await writer().changeTariff({ ...CHANGE, nuevaTarifa: '1,5' }, { actor: 'u' })).outcome).toBe('rejected');
    f = fake(); f.expireAtBuscar = true;
    await expect(writer().changeTariff(CHANGE, { actor: 'u' })).rejects.toMatchObject({ code: 'WEB_BAD_PAGE' });
    expect(f.grabarPosts).toHaveLength(0);
  });

  it('una sola sesión a la vez: el segundo escritor simultáneo no graba', async () => {
    f = fake();
    const w = writer();
    const [a, b] = await Promise.allSettled([w.changeTariff(CHANGE, { actor: 'u' }), w.changeTariff(CHANGE, { actor: 'u' })]);
    const ok = [a, b].filter((x) => x.status === 'fulfilled');
    expect(ok.length).toBe(1);
    expect([a, b].find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'WEB_SESSION_BUSY' } });
    expect(f.grabarPosts).toHaveLength(1);
  });
});

// ---- Servicio + API con el escritor real simulado por HTML ---------------------------------------------------
describe('aplicar con escritor real (servicio, API, lista de permitidas, ensayo, reversa)', () => {
  let ctx: AppContext;
  let f: Fake;
  let rows: Record<string, unknown>[];
  const tok: Record<string, string> = {};
  const call = (m: string, p: string, t?: string, b?: unknown, query: Record<string, string> = {}) => handleRequest(ctx, { method: m, path: p, query, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b });
  const j = <T>(r: { json?: unknown }): T => r.json as T;
  const prop = async (kind?: string): Promise<ProposalDto> => {
    const all = j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals;
    return all.find((p) => (kind ? p.kind === kind : p.kind === 'adjust')) as ProposalDto;
  };
  let runId = '';

  beforeAll(async () => {
    setLogSink(() => undefined);
    ctx = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afr-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: KEY, APP_SESSION_SECRET: SECRET, SILOG_SOURCE: 'none', SILOG_BASE_URL: `${BASE}/index.php`, SILOG_USER: 'x', SILOG_PASSWORD: 'y' });
    f = fake();
    ctx.webFetch = f.fetch;
    for (const [k, e] of [['admin', 'admin@demo.local'], ['fact', 'facturacion@demo.local'], ['op', 'operador@demo.local'], ['view', 'lector@demo.local']] as const) {
      tok[k] = j<{ token: string }>(await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' })).token;
    }
    await call('PUT', '/api/service-credentials/adjust', tok.admin, { silogUser: 'cuenta', password: PASS });
    const db = ctx.db;
    const msg = await db.query<{ id: string }>(`insert into source_messages (mailbox, graph_immutable_id, internet_message_id, received_at) values ('m@x','g1','g1',now()) returning id`);
    const svc = await db.query<{ id: string }>(`insert into services (business_key, transport_number, version_count) values ('6008602767','6008602767',1) returning id`);
    const au = await db.query<{ id: string }>(
      `insert into authorizations (message_id, service_id, version, parse_status, parser_version, transport_number, expense_number, service_date, route, plate_normalized, transport_volume, net_value, driver_code)
       values ($1,$2,1,'ok','t','6008602767','4500000001','2026-11-17','C1-AAA - BBB','PLA001',10487,2464445,'0000000011') returning id`, [msg.rows[0]?.id, svc.rows[0]?.id]);
    await db.query('update services set current_authorization_id=$2 where id=$1', [svc.rows[0]?.id, au.rows[0]?.id]);
    rows = [silogRow({ cliente_nit: TERPEL_NIT, manifiesto: 'M1', remesa_codigo: REMESA, fecha: '2026-11-15', conductor_documento: '11', placa: 'PLA001', ciudad_origen_remesa: 'AAA', ciudad_destino_remesa: 'BBB', remesa_peso: 10460, total_remesa: '2460000' })];
    // El informe de Silogtran NO refleja el peso/cantidad que cambia este ajuste: nunca se modifica en las pruebas.
    ctx.silog = new MockSilogtranSource(rows);
    const c = await call('POST', '/api/reconciliations', tok.fact, { dateFrom: '2026-11-17', dateTo: '2026-11-17' });
    runId = j<{ id: string }>(c).id;
    for (let i = 0; i < 30; i += 1) if (j<{ done: boolean }>(await call('POST', `/api/reconciliations/${runId}/step`, tok.fact)).done) break;
    const g = await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
    expect(j<{ created: number }>(g).created).toBe(1);
  });
  afterAll(async () => ctx.db.close());

  it('modo mock por defecto: nada real se escribe (ni un POST a Silogtran web)', async () => {
    const p = await prop();
    expect(p).toMatchObject({ status: 'proposed', tariff: '235', gallons: '10487' });
    await call('POST', `/api/adjustments/${p.id}/approve`, tok.fact);
    expect((await call('POST', `/api/adjustments/${p.id}/rehearse`, tok.fact)).status).toBe(200);
    expect(f.allPosts).toHaveLength(0);
    expect(j<{ mode: string; simulated: boolean }>(await call('GET', '/api/adjustments/writer-status', tok.view))).toMatchObject({ mode: 'mock', simulated: true });
    // se descarta lo simulado para seguir con el flujo real
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact)).status).toBe('simulated_applied');
    expect(f.allPosts).toHaveLength(0);
    await call('POST', '/api/adjustments/discard-simulated', tok.admin);
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
  });

  it('modo y lista de remesas: solo admin; "todas" exige confirmación; auditado', async () => {
    const body = { writerMode: 'web', writerAllowlist: ['0101228393'] };
    for (const k of ['fact', 'op', 'view']) expect((await call('PUT', '/api/adjustments/settings', tok[k], body)).status, k).toBe(403);
    expect((await call('PUT', '/api/adjustments/settings', tok.admin, { writerMode: 'otro' })).status).toBe(400);
    expect((await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowlist: ['abc'] })).status).toBe(400);
    expect((await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowAll: true })).status).toBe(400);
    expect(j<{ error: { code: string } }>(await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowAll: true })).error.code).toBe('CONFIRM_REQUIRED');
    const okAll = await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowAll: true, confirmAll: true });
    expect(j<{ writerAllowAll: boolean }>(okAll).writerAllowAll).toBe(true);
    await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowAll: false });
    const r = await call('PUT', '/api/adjustments/settings', tok.admin, body);
    expect(j<{ writerMode: string; writerAllowlist: string[] }>(r)).toMatchObject({ writerMode: 'web', writerAllowlist: ['101228393'] });
    const aud = (await ctx.db.query<{ data: { writerChanged?: boolean; writerMode?: string } }>(`select data from audit_log where action = 'adjust_settings.update'`)).rows;
    expect(aud.some((a) => a.data.writerChanged && a.data.writerMode === 'web')).toBe(true);
    expect(j<{ mode: string; simulated: boolean; allowlist: string[] }>(await call('GET', '/api/adjustments/writer-status', tok.op))).toMatchObject({ mode: 'web', simulated: false, allowlist: ['101228393'] });
  });

  it('remesa fuera de la lista: bloqueada, sin escribir', async () => {
    await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowlist: ['999'] });
    const p = await prop();
    await call('POST', `/api/adjustments/${p.id}/approve`, tok.fact);
    const r = await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact);
    expect(j<{ error: { code: string } }>(r).error.code).toBe('REMESA_NOT_ALLOWED');
    expect(f.allPosts).toHaveLength(0);
    await call('PUT', '/api/adjustments/settings', tok.admin, { writerAllowlist: ['0101228393'] });
  });

  it('sin ensayo previo no hay escritura real; el ensayo no cambia el estado y registra rehearsed', async () => {
    const p = await prop();
    expect(p.status).toBe('approved');
    const r = await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact);
    expect(j<{ error: { code: string } }>(r).error.code).toBe('REHEARSAL_REQUIRED');
    expect(f.allPosts).toHaveLength(0);
    const rh = j<RehearsalDto>(await call('POST', `/api/adjustments/${p.id}/rehearse`, tok.fact));
    expect(rh).toMatchObject({ simulated: false, allChecksOk: true, wouldPostGrabar: false, before: { peso: '10500', cantidad: '10500', tarifa: '235' } });
    expect(rh.payload).toMatchObject({ pesoRemesa: '10487', cantidadRemesa: '10487', nuevaTarifa: '235', reason: 'Ajuste según autorización de pago Terpel, transporte 6008602767, gasto 4500000001' });
    expect(f.grabarPosts).toHaveLength(0);
    expect((await prop()).status).toBe('approved');
    const ev = j<{ events: ProposalEventDto[] }>(await call('GET', `/api/adjustments/${p.id}`, tok.fact)).events;
    expect(ev.filter((e) => e.event === 'rehearsed' && (e.detail as { writer?: string }).writer === 'web')).toHaveLength(1);
    expect(ev.at(-1)?.detail).not.toHaveProperty('password');
    for (const k of ['op', 'view']) expect((await call('POST', `/api/adjustments/${p.id}/rehearse`, tok[k])).status).toBe(403);
  });

  it('los anteriores cambian entre el ensayo y el grabado: stale y sin grabar', async () => {
    const p = await prop();
    f.screen = { peso: '10400', cantidad: '10500', tarifa: '235' };
    const r = j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact));
    expect(r.status).toBe('stale');
    expect(f.grabarPosts).toHaveLength(0);
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact); // la devuelve a propuesta
    const again = await prop();
    expect(again.status).toBe('proposed');
    await call('POST', `/api/adjustments/${again.id}/approve`, tok.fact);
    await call('POST', `/api/adjustments/${again.id}/rehearse`, tok.fact);
  });

  it('aplicación real: doble clic/concurrencia = un solo grabar; se verifica en la consulta de la remesa, NO en el informe; reversa guardada', async () => {
    const p = await prop();
    const [a, b] = await Promise.all([call('POST', `/api/adjustments/${p.id}/apply`, tok.fact), call('POST', `/api/adjustments/${p.id}/apply`, tok.fact)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(f.grabarPosts).toHaveLength(1);
    const done = await prop();
    expect(done).toMatchObject({ status: 'applied', simulated: false, writerKind: 'web', reversalValues: { peso: '10500', cantidad: '10500', tarifa: '235' } });
    expect(done.verification).toMatchObject({ ok: true, source: 'home_111' });
    expect(f.screen).toEqual({ peso: '10487', cantidad: '10487', tarifa: '235' });
    expect((rows[0] as Record<string, unknown>).remesa_peso).toBe(10460); // el informe no cambia y no se exige que cambie
    const third = await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact);
    expect(j<{ error: { code: string } }>(third).error.code).toBe('ALREADY_APPLIED');
    expect(f.grabarPosts).toHaveLength(1);
    const ev = j<{ events: ProposalEventDto[] }>(await call('GET', `/api/adjustments/${p.id}`, tok.fact)).events;
    expect(ev.map((e) => e.event)).toEqual(expect.arrayContaining(['generated', 'approved', 'rehearsed', 'apply_started', 'applied']));
  });

  it('reversa: propuesta con los valores anteriores, aprobación y ensayo como cualquier otra; idempotente', async () => {
    const p = await prop();
    for (const k of ['op', 'view']) expect((await call('POST', `/api/adjustments/${p.id}/revert`, tok[k])).status).toBe(403);
    const r1 = j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/revert`, tok.fact));
    expect(r1).toMatchObject({ kind: 'reversal', status: 'proposed', reversalOf: p.id, gallons: '10500', quantity: '10500', tariff: '235' });
    expect(r1.lines.map((l) => l.proposed)).toEqual(['10500', '10500', '235', null]);
    const r2 = j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/revert`, tok.fact));
    expect(r2.id).toBe(r1.id);
    expect((await call('POST', `/api/adjustments/${r1.id}/apply`, tok.fact)).status).toBe(409); // sin aprobar
    await call('POST', `/api/adjustments/${r1.id}/approve`, tok.fact);
    const rh = j<RehearsalDto>(await call('POST', `/api/adjustments/${r1.id}/rehearse`, tok.fact));
    expect(rh.payload).toMatchObject({ pesoRemesa: '10500', cantidadRemesa: '10500', nuevaTarifa: '235' });
    expect(rh.before).toMatchObject({ peso: '10487', cantidad: '10487', tarifa: '235' });
    const done = j<ProposalDto>(await call('POST', `/api/adjustments/${r1.id}/apply`, tok.fact));
    expect(done.status).toBe('applied');
    expect(f.screen).toEqual({ peso: '10500', cantidad: '10500', tarifa: '235' });
    expect(f.grabarPosts).toHaveLength(2);
    expect((await call('POST', `/api/adjustments/${r1.id}/revert`, tok.fact)).status).toBe(409); // una reversa no se revierte
  });

  it('Grabar dice éxito pero la consulta de la remesa no coincide: verification_failed (no se factura)', async () => {
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status = 'applied'`);
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
    const p = (j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.kind === 'adjust' && x.status === 'proposed') as ProposalDto;
    await call('POST', `/api/adjustments/${p.id}/approve`, tok.fact);
    await call('POST', `/api/adjustments/${p.id}/rehearse`, tok.fact);
    f.noEffect = true; // éxito en el mensaje pero Silogtran no guardó los valores
    const r = j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact));
    f.noEffect = false;
    expect(r.status).toBe('verification_failed');
    expect(r.verification).toMatchObject({ ok: false, source: 'home_111' });
  });

  it('respuesta perdida: uncertain, sin reintento ciego; "Consultar estado" lo resuelve', async () => {
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status = 'verification_failed'`);
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
    const p = (j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.kind === 'adjust' && x.status === 'proposed') as ProposalDto;
    await call('POST', `/api/adjustments/${p.id}/approve`, tok.fact);
    const dbg = await call('POST', `/api/adjustments/${p.id}/rehearse`, tok.fact);
    expect(j<RehearsalDto>(dbg).checks.filter((c) => !c.ok)).toEqual([]);
    f.mode = 'lost';
    const before = f.grabarPosts.length;
    const lostRes = await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact);
    expect(JSON.stringify(lostRes.json).slice(0, 300)).toContain('uncertain');
    const retry = await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact);
    expect(retry.status).toBe(409);
    expect(j<{ error: { code: string } }>(retry).error.code).toBe('UNCERTAIN');
    expect(f.grabarPosts.length).toBe(before + 1);
    const checked = j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/check`, tok.fact));
    expect(checked.status).toBe('applied');
    expect(f.grabarPosts.length).toBe(before + 1);
  });

  it('Consultar estado usa el escritor con el que se aplicó, aunque el modo guardado ya sea simulado', async () => {
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status in ('applied','uncertain','verification_failed','proposed','approved')`);
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
    const p = (j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.kind === 'adjust' && x.status === 'proposed') as ProposalDto;
    await call('POST', `/api/adjustments/${p.id}/approve`, tok.fact);
    await call('POST', `/api/adjustments/${p.id}/rehearse`, tok.fact);
    f.mode = 'ambiguous'; // mensaje no reconocido: uncertain, pero Silogtran SÍ aplicó
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact)).status).toBe('uncertain');
    f.mode = 'success';
    await call('PUT', '/api/adjustments/settings', tok.admin, { writerMode: 'mock' }); // el admin ya restableció el modo
    const checked = j<ProposalDto>(await call('POST', `/api/adjustments/${p.id}/check`, tok.fact));
    expect(checked.status).toBe('applied'); // NO 'failed' por haber consultado a un escritor simulado
    expect(checked.simulated).toBe(false);
    expect(checked.verification).toMatchObject({ ok: true, source: 'home_111' });
    await call('PUT', '/api/adjustments/settings', tok.admin, { writerMode: 'web' });
  });

  it('una aplicación cortada (lease vencido) queda uncertain, nunca se reintenta sola', async () => {
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status in ('applied','uncertain') and kind = 'adjust'`);
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
    const p = (j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.kind === 'adjust' && x.status === 'proposed') as ProposalDto;
    await ctx.db.query(`update adjustment_proposals set status = 'applying', lease_until = now() - interval '1 minute' where id = $1`, [p.id]);
    const r = await call('POST', `/api/adjustments/${p.id}/apply`, tok.fact);
    expect(r.status).toBe(409);
    expect((j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.id === p.id)?.status).toBe('uncertain');
  });

  it('la cuenta guardada se usa descifrada solo en memoria: nada en claro en BD, auditoría ni respuestas', async () => {
    const all = JSON.stringify([(await ctx.db.query('select * from audit_log')).rows, (await ctx.db.query('select * from adjustment_events')).rows, (await ctx.db.query('select cookies_enc from silog_web_sessions')).rows]);
    for (const secret of [PASS, 'PHPSESSID', KEY, SECRET]) expect(all, secret).not.toContain(secret);
  });

  it('ensayo contra la pantalla REAL aunque el modo guardado sea simulado: no graba y queda como ensayo válido', async () => {
    await call('PUT', '/api/adjustments/settings', tok.admin, { writerMode: 'mock' });
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status in ('applied','uncertain','verification_failed')`);
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
    const p = (j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.kind === 'adjust' && x.status === 'proposed') as ProposalDto;
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    const posts0 = f.grabarPosts.length;
    const r = j<RehearsalDto>(await call('POST', `/api/adjustments/${p.id}/rehearse`, tok.fact, { real: true }));
    expect(r).toMatchObject({ simulated: false, writerKind: 'web', allChecksOk: true, before: { peso: '10500', cantidad: '10500', tarifa: '235' } });
    expect(f.grabarPosts).toHaveLength(posts0);
    expect(j<{ mode: string }>(await call('GET', '/api/adjustments/writer-status', tok.fact)).mode).toBe('mock'); // el modo no cambió
  });


  it('al generar: «ya ajustado» no propone ajuste y CURRENT_VALUES_UNAVAILABLE no asume nada', async () => {
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status in ('applied','uncertain','verification_failed','proposed','approved')`);
    const gen = async (): Promise<ProposalDto> => {
      await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact);
      return (j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId })).proposals).find((x) => x.kind === 'adjust' && x.status !== 'stale' && x.status !== 'discarded') as ProposalDto;
    };
    f.screen = { peso: '10487', cantidad: '10487', tarifa: '235' };
    const done = await gen();
    expect(done).toMatchObject({ status: 'needs_review', reviewCode: 'ALREADY_ADJUSTED' });
    expect((await call('POST', `/api/adjustments/${done.id}/approve`, tok.fact)).status).toBe(409);
    f.homeBroken = true;
    const unavailable = await gen();
    f.homeBroken = false;
    expect(unavailable).toMatchObject({ status: 'needs_review', reviewCode: 'CURRENT_VALUES_UNAVAILABLE', currentWeight: null });
    f.screen = { peso: '10500', cantidad: '10500', tarifa: '235' };
    const normal = await gen();
    expect(normal).toMatchObject({ status: 'proposed', currentWeight: '10500', currentTotal: '2467500' }); // valores reales de la consulta, no del informe (10460 / 2.464.445)
    expect(normal.lines.map((l) => l.current)).toEqual(['10500', '10500', '235', '2467500']);
  });
});
