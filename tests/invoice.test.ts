import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { handleRequest } from '../core/http/router.js';
import { MockInvoiceWriter } from '../core/invoice/writer.js';
import type { InvoiceOutcome, InvoiceRehearsalResult, InvoiceRequest, InvoiceWriter } from '../core/invoice/writer.js';
import { checkListing } from '../core/silog/web/invoiceWriter.js';
import { parseInvoiceListing } from '../core/silog/web/invoice.js';
import { DEFAULT_INVOICE_SETTINGS, cleanProduct, renderObservation, validateObservationTemplate } from '../core/invoice/service.js';
import { setLogSink } from '../core/logger.js';
import { MockSilogtranSource } from '../core/recon/silogtran.js';
import type { InvoiceDto, InvoicePlanDto, InvoiceRunDetailDto, InvoiceSettingsDto } from '../core/types.js';
import { TERPEL_NIT, silogRow } from '../fixtures/silogtran.js';

/** Escritor "real" de pruebas: no toca ninguna red; al emitir marca la factura en el informe simulado. */
class FakeWebWriter implements InvoiceWriter {
  readonly kind = 'web' as const;
  readonly simulated = false;
  inner = new MockInvoiceWriter();
  mode: 'ok' | 'uncertain' | 'noinvoice' | 'throw' = 'ok';
  issueCalls: string[] = [];
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async rehearse(req: InvoiceRequest): Promise<InvoiceRehearsalResult> { return { ...(await this.inner.rehearse(req)), simulated: false }; }
  async issue(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.issueCalls.push(req.remesaCode);
    if (this.mode === 'throw') throw new Error('boom');
    if (this.mode === 'uncertain') return { outcome: 'uncertain', detail: 'sin respuesta' };
    if (this.mode === 'ok') for (const r of this.rows) if (String(r.remesa_codigo) === String(Number(req.remesaCode))) r.factura = `FE-${req.remesaCode}`;
    return { outcome: 'submitted', invoiceNumber: null };
  }
}

describe('facturación 4a', () => {
  let ctx: AppContext;
  let reconId = '';
  const tok: Record<string, string> = {};
  let seq = 0;
  const rows: Record<string, unknown>[] = [];
  const call = (m: string, p: string, t?: string, b?: unknown, query: Record<string, string> = {}) => handleRequest(ctx, { method: m, path: p, query, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b });
  const j = <T>(r: { json?: unknown }): T => r.json as T;

  async function seed(o: { t: string; date: string; driver: string; vol: number; value: number; sheet?: string | null }): Promise<void> {
    seq += 1;
    const db = ctx.db;
    const msg = await db.query<{ id: string }>(`insert into source_messages (mailbox, graph_immutable_id, internet_message_id, received_at) values ('m@x',$1,$1,now()) returning id`, [`g${seq}`]);
    const svc = await db.query<{ id: string }>(`insert into services (business_key, transport_number, version_count) values ($1,$1,1) returning id`, [o.t]);
    const au = await db.query<{ id: string }>(
      `insert into authorizations (message_id, service_id, version, parse_status, parser_version, transport_number, expense_number, service_date, route, plate_normalized, transport_volume, net_value, driver_code, service_entry_sheet)
       values ($1,$2,1,'ok','t',$3,$4,$5,'C1-AAA - BBB','PLA001',$6,$7,$8,$9) returning id`,
      [msg.rows[0]?.id, svc.rows[0]?.id, o.t, `G${o.t}`, o.date, o.vol, o.value, o.driver, o.sheet === undefined ? `HOJA${seq}` : o.sheet],
    );
    await db.query('update services set current_authorization_id=$2 where id=$1', [svc.rows[0]?.id, au.rows[0]?.id]);
  }
  const sRow = (code: number, driver: string, date: string, weight: number, total: string, extra: Record<string, unknown> = {}) =>
    silogRow({ cliente_nit: TERPEL_NIT, manifiesto: `M${code}`, remesa_codigo: code, fecha: date, conductor_documento: driver, placa: 'PLA001', ciudad_origen_remesa: 'AAA', ciudad_destino_remesa: 'BBB', remesa_peso: weight, total_remesa: total, remesa_tarifa: '100', ...extra });

  const plan = async (t = 'fact'): Promise<InvoicePlanDto> => j<InvoicePlanDto>(await call('POST', `/api/reconciliations/${reconId}/invoices/plan`, tok[t]));
  const settings = async (b: Record<string, unknown>) => call('PUT', '/api/invoices/settings', tok.admin, b);
  async function runToEnd(id: string): Promise<InvoiceRunDetailDto> {
    let d = j<InvoiceRunDetailDto>(await call('POST', `/api/invoice-runs/${id}/step`, tok.fact, {}));
    for (let i = 0; i < 20 && d.run.status === 'running'; i += 1) d = j<InvoiceRunDetailDto>(await call('POST', `/api/invoice-runs/${id}/step`, tok.fact, {}));
    return d;
  }
  const byRemesa = (p: InvoicePlanDto, code: string): InvoiceDto => p.eligible.find((e) => e.remesaCode === code) as InvoiceDto;

  beforeAll(async () => {
    setLogSink(() => undefined);
    ctx = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afi-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: 'a1'.repeat(32), APP_SESSION_SECRET: 'x'.repeat(40), SILOG_SOURCE: 'none' });
    ctx.invoiceVerifyDelayMs = 0;
    for (const [k, e] of [['admin', 'admin@demo.local'], ['fact', 'facturacion@demo.local'], ['op', 'operador@demo.local'], ['view', 'lector@demo.local']] as const) {
      tok[k] = j<{ token: string }>(await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' })).token;
    }
    // E1-E4 exactas y completas; X1 volumen 0; X2 sin hoja; X3 ya facturada en el informe; X4 sin coincidencia; X5 con diferencias sin ajuste
    await seed({ t: 'T-E1', date: '2026-11-17', driver: '0000000011', vol: 10000, value: 1000000 });
    await seed({ t: 'T-E2', date: '2026-11-18', driver: '0000000012', vol: 20000, value: 2000000 });
    await seed({ t: 'T-E3', date: '2026-11-19', driver: '0000000013', vol: 5000, value: 500000 });
    await seed({ t: 'T-E4', date: '2026-11-19', driver: '0000000014', vol: 4000, value: 400000 });
    await seed({ t: 'T-X1', date: '2026-11-20', driver: '0000000015', vol: 0, value: 700 });
    await seed({ t: 'T-X2', date: '2026-11-20', driver: '0000000016', vol: 3000, value: 300000, sheet: null });
    await seed({ t: 'T-X3', date: '2026-11-21', driver: '0000000017', vol: 6000, value: 600000 });
    await seed({ t: 'T-X4', date: '2026-11-21', driver: '0000000018', vol: 100, value: 100 });
    await seed({ t: 'T-X5', date: '2026-11-22', driver: '0000000019', vol: 7000, value: 700000 });
    rows.push(
      sRow(1, '11', '2026-11-17', 10000, '1000000'), sRow(2, '12', '2026-11-18', 20000, '2000000'), sRow(3, '13', '2026-11-19', 5000, '500000'), sRow(4, '14', '2026-11-19', 4000, '400000'),
      sRow(5, '15', '2026-11-20', 100, '700'), sRow(6, '16', '2026-11-20', 3000, '300000'), sRow(7, '17', '2026-11-21', 6000, '600000', { factura: 'F-77' }), sRow(9, '19', '2026-11-22', 6900, '690000'),
    );
    ctx.silog = new MockSilogtranSource(rows);
    const c = await call('POST', '/api/reconciliations', tok.fact, { dateFrom: '2026-11-17', dateTo: '2026-11-25' });
    reconId = j<{ id: string }>(c).id;
    for (let i = 0; i < 30; i += 1) if (j<{ done: boolean }>(await call('POST', `/api/reconciliations/${reconId}/step`, tok.fact)).done) break;
  });
  afterAll(async () => ctx.db.close());

  it('observación: producto sin guiones, plantilla por defecto reproduce el ejemplo y se trunca a 176', () => {
    expect(cleanProduct('  B-100 ')).toBe('B-100'); // verbatim: el guion y las mayúsculas se conservan
    expect(cleanProduct('b-100')).toBe('b-100');
    const v = { product: 'B-100', origin: 'CARTAGENA', destination: 'MALAMBO', transport: '6008613622', serviceEntrySheet: '1005579437', remesa: '1' };
    const def = 'SERVICIO DE TRANSPORTE {product} {origin} - {destination} {transport} {serviceEntrySheet}';
    expect(renderObservation(def, v)).toEqual({ text: 'SERVICIO DE TRANSPORTE B-100 CARTAGENA - MALAMBO 6008613622 1005579437', truncated: false });
    const long = renderObservation(def, { ...v, origin: 'X'.repeat(200) });
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(176);
    expect(() => validateObservationTemplate('hola {nada}')).toThrow();
  });

  it('roles: operador y lector reciben 403; facturación y admin operan; solo admin configura', async () => {
    for (const k of ['op', 'view']) {
      expect((await call('POST', `/api/reconciliations/${reconId}/invoices/plan`, tok[k])).status, k).toBe(403);
      expect((await call('GET', '/api/invoices', tok[k])).status).toBe(403);
      expect((await call('GET', '/api/invoices/settings', tok[k])).status).toBe(403);
      expect((await call('POST', '/api/invoice-runs', tok[k], {})).status).toBe(403);
    }
    expect((await call('GET', '/api/invoices', undefined)).status).toBe(401);
    expect((await call('GET', '/api/invoices/settings', tok.fact)).status).toBe(200);
    expect((await call('PUT', '/api/invoices/settings', tok.fact, { seller: 'X' })).status).toBe(403);
    expect((await settings({ seller: 'VENDEDOR PRUEBA' })).status).toBe(200);
  });

  it('plan: elegibles todas marcadas y excluidas con motivo; sin efectos sobre Silogtran', async () => {
    const w = ctx.invoiceWriter as MockInvoiceWriter;
    const p = await plan();
    expect(p.writer).toMatchObject({ mode: 'mock', simulated: true });
    expect(p.eligible.map((e) => e.transportNumber).sort()).toEqual(['T-E1', 'T-E2', 'T-E3', 'T-E4']);
    expect(byRemesa(p, '1')).toMatchObject({ terpelValue: '1000000', status: 'eligible' });
    expect(byRemesa(p, '1').observation).toBe('SERVICIO DE TRANSPORTE B-100 AAA - BBB T-E1 HOJA1');
    const cat = (c: string) => p.excluded.filter((e) => e.category === c).map((e) => e.transportNumber);
    expect(cat('volume_zero')).toEqual(['T-X1']);
    expect(cat('incomplete')).toEqual(['T-X2']);
    expect(cat('already_invoiced')).toEqual(['T-X3']);
    expect(cat('no_match')).toEqual(['T-X4']);
    expect(cat('adjustment_pending')).toEqual(['T-X5']);
    expect(p.excluded.every((e) => e.reason.length > 5)).toBe(true);
    expect(w.rehearsals).toHaveLength(0);
    expect(w.issued).toHaveLength(0);
    expect((await plan()).eligible.map((e) => e.id).sort()).toEqual(p.eligible.map((e) => e.id).sort()); // idempotente
  });

  it('ensayo, regla crítica y emisión individual simulada; doble clic no duplica', async () => {
    const w = ctx.invoiceWriter as MockInvoiceWriter;
    const p = await plan();
    const e1 = byRemesa(p, '1');
    expect((await call('POST', `/api/invoices/${e1.id}/issue`, tok.fact, { confirm: true })).status).toBe(409); // sin ensayo
    const rhr = await call('POST', `/api/invoices/${e1.id}/rehearse`, tok.fact);
    const rh = j<{ allChecksOk: boolean }>(rhr);
    expect(rh.allChecksOk).toBe(true);
    expect((await call('POST', `/api/invoices/${e1.id}/issue`, tok.fact, {})).status).toBe(400); // sin confirm
    const [a, b] = await Promise.all([call('POST', `/api/invoices/${e1.id}/issue`, tok.fact, { confirm: true }), call('POST', `/api/invoices/${e1.id}/issue`, tok.fact, { confirm: true })]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect(w.issued.filter((x) => x.remesaCode === '1')).toHaveLength(1);
    const det = j<{ invoice: InvoiceDto; events: unknown[] }>(await call('GET', `/api/invoices/${e1.id}`, tok.fact));
    expect(det.invoice).toMatchObject({ status: 'simulated', simulated: true });
    expect(det.invoice.invoiceNumber).toMatch(/^SIM-/);
    expect((await call('POST', `/api/invoices/${e1.id}/issue`, tok.fact, { confirm: true })).status).toBe(409);
    // regla crítica: otro flete en el listado => se omite con motivo
    const e2 = byRemesa(p, '2');
    w.freightOverride.set('2', '1999999');
    const r2 = j<{ allChecksOk: boolean; checks: { name: string; ok: boolean }[] }>(await call('POST', `/api/invoices/${e2.id}/rehearse`, tok.fact));
    expect(r2.allChecksOk).toBe(false);
    expect(r2.checks.some((c) => !c.ok && /REGLA CR/.test(c.name))).toBe(true);
    const d2 = j<{ invoice: InvoiceDto }>(await call('GET', `/api/invoices/${e2.id}`, tok.fact)).invoice;
    expect(d2).toMatchObject({ status: 'skipped', reviewCode: 'FREIGHT_MISMATCH' });
    w.freightOverride.clear();
  });

  it('corrida: una factura por remesa, omite las que incumplen y termina con informe .xlsx', async () => {
    const w = ctx.invoiceWriter as MockInvoiceWriter;
    const p = await plan();
    const ids = p.eligible.filter((e) => ['skipped', 'eligible', 'rehearsed'].includes(e.status)).map((e) => e.id);
    expect(ids).toHaveLength(3);
    w.freightOverride.set('3', '1');
    expect((await call('POST', '/api/invoice-runs', tok.fact, { reconRunId: reconId, invoiceIds: ids, confirm: false })).status).toBe(400);
    const created = j<InvoiceRunDetailDto>(await call('POST', '/api/invoice-runs', tok.fact, { reconRunId: reconId, invoiceIds: ids, confirm: true }));
    expect(created.run).toMatchObject({ total: 3, pending: 3, simulated: true });
    expect((await call('POST', '/api/invoice-runs', tok.fact, { reconRunId: reconId, invoiceIds: ids, confirm: true })).status).toBe(409); // una corrida activa
    const d = await runToEnd(created.run.id);
    expect(d.run).toMatchObject({ status: 'completed', issued: 2, skipped: 1, pending: 0 });
    expect(d.items.find((i) => i.remesaCode === '3')?.reason).toMatch(/ensayo/i);
    expect(w.issued.map((x) => x.remesaCode).filter((c) => c === '2' || c === '4').sort()).toEqual(['2', '4']);
    expect(w.issued.filter((x) => x.remesaCode === '1')).toHaveLength(1); // nunca dos veces
    const ex = j<{ url: string }>(await call('POST', `/api/invoice-runs/${created.run.id}/export`, tok.fact));
    const u = new URL(ex.url, 'http://x');
    const file = await call('GET', '/api/files', undefined, undefined, Object.fromEntries(u.searchParams.entries()));
    expect(file.status).toBe(200);
    const buf = (file as unknown as { file: { data: Buffer; filename: string } }).file;
    expect(buf.filename).toMatch(/^facturacion-/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf.data as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Resumen', 'Facturadas', 'Omitidas e inciertas', 'Excluidas del plan']);
    w.freightOverride.clear();
  });

  it('un cambio de observación/producto invalida el ensayo anterior y exige uno nuevo', async () => {
    const p = await plan();
    const e = p.eligible.find((x) => x.status === 'rehearsed' || x.status === 'eligible') as InvoiceDto;
    expect(e).toBeTruthy();
    await call('POST', `/api/invoices/${e.id}/rehearse`, tok.fact);
    await ctx.db.query(`update invoices set observation = 'SERVICIO DE TRANSPORTE B100 X', product = 'B100' where id = $1`, [e.id]); // como un ensayo viejo
    const again = await plan();
    const row = again.eligible.find((x) => x.id === e.id) as InvoiceDto;
    expect(row.status).toBe('eligible'); // vuelve a exigir ensayo
    expect(row.observation).toMatch(/B-100/);
    expect(row.product).toBe('B-100');
  });

  it('vista GET sin efectos: carga lo ya trabajado (simuladas, omitidas) y las excluidas con motivo', async () => {
    const before = (await ctx.db.query<{ n: number }>('select count(*)::int as n from invoice_events')).rows[0]?.n;
    const r = await call('GET', `/api/reconciliations/${reconId}/invoices/view`, tok.fact);
    expect(r.status).toBe(200);
    const v = j<InvoicePlanDto>(r);
    expect(v.eligible.map((e) => e.status)).toContain('simulated');
    expect(v.excluded.length).toBeGreaterThan(0);
    expect(v.unplanned).toBe(0);
    expect((await ctx.db.query<{ n: number }>('select count(*)::int as n from invoice_events')).rows[0]?.n).toBe(before); // sin efectos
    expect((await call('GET', `/api/reconciliations/${reconId}/invoices/view`, tok.op)).status).toBe(403);
  });

  it('escritor real: lista permitida, ensayo obligatorio, lote desactivado por defecto, parada ante incierto y reanudación', async () => {
    await ctx.db.query(`insert into silog_credentials (purpose, silog_user, password_enc) values ('adjust','facturador','x')`);
    const fake = new FakeWebWriter(rows);
    ctx.invoiceWebWriter = fake;
    expect((await settings({ writerMode: 'web', writerAllowlist: ['3'] })).status).toBe(200);
    const st = j<InvoiceSettingsDto>(await call('GET', '/api/invoices/settings', tok.admin));
    expect(st).toMatchObject({ writerMode: 'web', batchEnabled: false, writerAllowAll: false });
    const p = await plan();
    expect(p.writer).toMatchObject({ mode: 'web', simulated: false });
    expect(p.eligible.map((e) => e.remesaCode)).toEqual(['3']);
    expect(p.excluded.some((e) => e.category === 'not_allowed')).toBe(true);
    const e3 = byRemesa(p, '3');
    // fuera de la lista: ni ensayo ni emisión
    const notAllowed = (await call('GET', '/api/invoices', tok.fact)).json as { invoices: InvoiceDto[] };
    const e4 = notAllowed.invoices.find((i) => i.remesaCode === '4') as InvoiceDto;
    expect((await call('POST', `/api/invoices/${e4.id}/rehearse`, tok.fact)).status).toBe(409);
    expect((await call('POST', `/api/invoices/${e4.id}/issue`, tok.fact, { confirm: true })).status).toBe(409);
    // sin ensayo no emite
    const r0 = await call('POST', `/api/invoices/${e3.id}/issue`, tok.fact, { confirm: true });
    expect(j<{ error: { code: string } }>(r0).error.code).toBe('REHEARSAL_REQUIRED');
    expect(fake.issueCalls).toHaveLength(0);
    // lote real bloqueado hasta que el admin lo active
    const blocked = await call('POST', '/api/invoice-runs', tok.fact, { reconRunId: reconId, invoiceIds: [e3.id], confirm: true });
    expect(j<{ error: { code: string } }>(blocked).error.code).toBe('BATCH_DISABLED');
    // incierto => queda incierto, no se reintenta a ciegas
    await call('POST', `/api/invoices/${e3.id}/rehearse`, tok.fact);
    fake.mode = 'uncertain';
    const u = j<{ status: string }>(await call('POST', `/api/invoices/${e3.id}/issue`, tok.fact, { confirm: true }));
    expect(u.status).toBe('uncertain');
    expect((await call('POST', `/api/invoices/${e3.id}/issue`, tok.fact, { confirm: true })).status).toBe(409);
    expect(fake.issueCalls).toEqual(['3']);
    // consultar estado sin evidencia: sigue incierto; con factura en el informe: emitida
    expect(j<{ status: string }>(await call('POST', `/api/invoices/${e3.id}/check`, tok.fact)).status).toBe('uncertain');
    rows.find((r) => r.remesa_codigo === 3)!.factura = 'FE-3';
    expect(j<{ status: string; invoiceNumber: string }>(await call('POST', `/api/invoices/${e3.id}/check`, tok.fact))).toMatchObject({ status: 'issued', invoiceNumber: 'FE-3' });
    expect((await call('POST', `/api/invoices/${e3.id}/resolve`, tok.fact, { outcome: 'issued', invoiceNumber: '1', note: 'x' })).status).toBe(403);
    // lote real: activado → la corrida se detiene ante un resultado incierto y se reanuda después
    rows.find((r) => r.remesa_codigo === 3)!.factura = null;
    expect((await settings({ batchEnabled: true, writerAllowlist: ['2', '4'] })).status).toBe(200);
    const p2 = await plan();
    expect(p2.eligible.map((e) => e.remesaCode).sort()).toContain('2');
    const ids = p2.eligible.filter((e) => ['2', '4'].includes(e.remesaCode) && ['eligible', 'rehearsed', 'skipped', 'failed'].includes(e.status)).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    fake.mode = 'uncertain';
    const run = j<InvoiceRunDetailDto>(await call('POST', '/api/invoice-runs', tok.fact, { reconRunId: reconId, invoiceIds: ids, confirm: true }));
    const halted = j<InvoiceRunDetailDto>(await call('POST', `/api/invoice-runs/${run.run.id}/step`, tok.fact, {}));
    expect(halted.run.status).toBe('halted');
    expect(halted.run.pending).toBeGreaterThanOrEqual(0);
    expect((await call('POST', `/api/invoice-runs/${run.run.id}/step`, tok.fact, {})).status).toBe(409); // no avanza sin reanudar
    expect(fake.issueCalls.length).toBe(2); // una sola emisión adicional: se detuvo
  });
  it('reanudación: tras la parada, reanudar explícitamente factura las pendientes sin repetir la incierta', async () => {
    const fake = ctx.invoiceWebWriter as FakeWebWriter;
    const runs = j<{ runs: { id: string; status: string }[] }>(await call('GET', '/api/invoice-runs', tok.fact)).runs;
    const halted = runs.find((r) => r.status === 'halted');
    expect(halted).toBeTruthy();
    const before = fake.issueCalls.length;
    fake.mode = 'ok';
    const d = j<InvoiceRunDetailDto>(await call('POST', `/api/invoice-runs/${halted?.id}/step`, tok.fact, { resume: true }));
    expect(d.run.status).toBe('completed');
    expect(d.run.pending).toBe(0);
    expect(d.items.filter((i) => i.result === 'halted')).toHaveLength(1);
    const issued = d.items.filter((i) => i.result === 'issued');
    expect(issued.every((i) => /^FE-/.test(i.invoiceNumber ?? ''))).toBe(true); // número leído del informe
    expect(fake.issueCalls.length - before).toBe(d.items.length - 1); // la incierta no se reintenta
  });

  it('Automatica_111 sintético: el listado se interpreta y la regla crítica se cumple/viola', () => {
    const html = (total: string) => `<form>
      <input name="ctl0$MainModule$porFacturar$ctl1$remesa1" value="0101229798" disabled />
      <input name="ctl0$MainModule$porFacturar$ctl1$vehiculo" value="ABC123" />
      <input name="ctl0$MainModule$porFacturar$ctl1$estado_remesa" value="SI" />
      <input name="ctl0$MainModule$porFacturar$ctl1$observacion" value="B100" />
      <input name="ctl0$MainModule$porFacturar$ctl1$peso" value="10194" />
      <input name="ctl0$MainModule$porFacturar$ctl1$tarifa_cliente" value="162" />
      <input name="ctl0$MainModule$porFacturar$ctl1$tarifa" value="${total}" />
      <input name="ctl0$MainModule$porFacturar$ctl1$otros" value="0" />
      <input name="ctl0$MainModule$porFacturar$ctl1$total" value="${total}" />
      <input type="checkbox" name="ctl0$MainModule$porFacturar$ctl1$valido" /></form>`;
    const rows = parseInvoiceListing(html('1651428'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remesa: '0101229798', peso: '10194', tarifaCliente: '162', total: '1651428', checkbox: 'ctl0$MainModule$porFacturar$ctl1$valido' });
    const s = DEFAULT_INVOICE_SETTINGS;
    const req: InvoiceRequest = {
      remesaCode: '101229798', transportNumber: '6008613622', expectedFreight: '1651428', observation: 'SERVICIO DE TRANSPORTE B-100 A - B 6008613622 1005579437', purchaseOrder: '6008613622', product: 'B-100',
      params: { costCenter: s.costCenter, client: s.client, printableName: s.printableName, seller: s.seller, paymentDays: s.paymentDays, paymentCity: s.paymentCity, currency: s.currency, paymentMethod: s.paymentMethod, invoiceType: s.invoiceType, divide: s.divide, maxRemesas: s.maxRemesas, withholdingPercent: s.withholdingPercent },
    };
    const pct = String(s.withholdingPercent);
    const good = checkListing(req, rows, pct, true, true, null, 'B-100');
    expect(good.checks.filter((c) => !c.ok)).toEqual([]);
    expect(good.checks.find((c) => /REGLA CR/.test(c.name))?.ok).toBe(true);
    expect(good.checks.find((c) => /\(Home_111\) y usado/.test(c.name))?.ok).toBe(true);
    const info = good.checks.find((c) => /Home_111 vs\./.test(c.name));
    expect(info?.ok).toBe(true); // informativo: el listado trae B100 y no bloquea
    expect(info?.detail).toMatch(/DIFIEREN/);
    expect(checkListing(req, rows, pct, true, true, null, null).checks.find((c) => /\(Home_111\) y usado/.test(c.name))?.ok).toBe(false); // sin producto de Home no pasa
    expect(checkListing(req, rows, pct, true, true, null, 'B100').checks.find((c) => /\(Home_111\) y usado/.test(c.name))?.ok).toBe(false); // distinto al de la observación
    const bad = checkListing(req, parseInvoiceListing(html('1651429')), pct, true, true);
    expect(bad.checks.find((c) => /REGLA CR/.test(c.name))?.ok).toBe(false);
  });
});
