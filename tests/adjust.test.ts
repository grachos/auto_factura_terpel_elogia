import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareAdjustWorkbook, flatten } from '../core/adjust/excel.js';
import { ALL_STATUSES, TRANSITIONS, _moveForTests, autoEligibility, canTransition, renderReason, validateTemplate } from '../core/adjust/service.js';
import { computeTariff, normalizeNumberString } from '../core/adjust/tariff.js';
import { MockSilogtranWriter } from '../core/adjust/writer.js';
import type { ChangeStateResult, RehearsalResult, SilogtranWriter, TariffChange, WriterOutcome } from '../core/adjust/writer.js';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import type { Db } from '../core/db/types.js';
import { handleRequest } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import { MockSilogtranSource } from '../core/recon/silogtran.js';
import type { ProposalDto, ProposalEventDto, ProposalStatus } from '../core/types.js';
import { TERPEL_NIT, silogRow } from '../fixtures/silogtran.js';

describe('tarifa exacta (BigInt, sin float)', () => {
  const t = (v: unknown, g: unknown) => computeTariff(v, g);
  it('casos reales (sintéticos equivalentes)', () => {
    expect(t('2464445', '10487')).toMatchObject({ ok: true, tariff: '235' });
    expect(t('6694492.0000', '10174.0000')).toMatchObject({ ok: true, tariff: '658', gallons: '10174', value: '6694492' });
    expect(t(2346240, 9984)).toMatchObject({ ok: true, tariff: '235' });
  });
  it('límites de 12 caracteres con 3 y 4 enteros', () => {
    expect(t('12312345678', '100000000')).toMatchObject({ ok: true, tariff: '123.12345678' }); // 12 caracteres
    expect(t('12341234567', '10000000')).toMatchObject({ ok: true, tariff: '1234.1234567' }); // 12 caracteres
    expect(t('123123456789', '1000000000')).toMatchObject({ ok: false, code: 'TARIFF_TOO_LONG' }); // 13
    expect(t('1', '16384')).toMatchObject({ ok: false, code: 'TARIFF_TOO_LONG' }); // exacto pero 16 caracteres
  });
  it('enteras, decimales cortos, repetentes, ceros, enormes y sin float', () => {
    expect(t('1000', '4')).toMatchObject({ ok: true, tariff: '250' });
    expect(t('1', '2')).toMatchObject({ ok: true, tariff: '0.5' });
    expect(t('1', '3')).toMatchObject({ ok: false, code: 'TARIFF_NOT_EXACT' });
    expect(t('2740000', '3000')).toMatchObject({ ok: false, code: 'TARIFF_NOT_EXACT' });
    expect(t('0.3', '0.1')).toMatchObject({ ok: true, tariff: '3' }); // con float daría 2.9999999999999996
    expect(t('99999999999999999999', '99999999999999999999')).toMatchObject({ ok: true, tariff: '1' });
    expect(t('99999999999999999999999999', '1')).toMatchObject({ ok: false, code: 'TARIFF_TOO_LONG' });
    for (const bad of [[0, 5], [5, 0], ['-5', '2'], ['5', '-2'], ['', '2'], [null, 2], ['2', undefined], ['abc', '2'], ['1e3', '2'], ['1,5', '2'], ['.5', '1'], [Number.NaN, 2]]) {
      expect(t(bad[0], bad[1]), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(normalizeNumberString('10487.0000')).toBe('10487');
    expect(normalizeNumberString('0.5000')).toBe('0.5');
  });
  it('tarifa × galones == valor, siempre', () => {
    for (const [v, g] of [['2464445', '10487'], ['6694492', '10174'], ['999', '8'], ['7', '8']] as const) {
      const r = t(v, g);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const [ti, tf = ''] = r.tariff.split('.');
        const scaled = BigInt(ti + tf) * BigInt(g);
        expect(scaled * 1n).toBe(BigInt(v) * 10n ** BigInt(tf.length));
      }
    }
  });
});

describe('razón de cambio', () => {
  it('plantilla validada y renderizada', () => {
    expect(validateTemplate('Ajuste transporte {transport}, gasto {expense}')).toContain('{transport}');
    expect(() => validateTemplate('Hola {otro}')).toThrow(/Marcador no permitido/);
    expect(() => validateTemplate('Hola {transport')).toThrow();
    expect(() => validateTemplate('')).toThrow();
    expect(() => validateTemplate('x'.repeat(201))).toThrow();
    expect(renderReason('T {transport} G {expense}', { transport: '600', expense: null, remesa: null, manifest: null })).toBe('T 600 G s/n');
  });
});

describe('máquina de estados', () => {
  it('tabla: ninguna transición hacia sí misma; terminales sin salida; todas las inválidas rechazadas', () => {
    for (const f of ALL_STATUSES) for (const to of ALL_STATUSES) {
      expect(canTransition(f, to), `${f}->${to}`).toBe(TRANSITIONS[f].includes(to));
    }
    for (const t of ['applied', 'verification_failed', 'rejected'] as ProposalStatus[]) expect(TRANSITIONS[t]).toEqual([]);
    expect(TRANSITIONS.simulated_applied).toEqual(['discarded']);
    expect(canTransition('proposed', 'applied')).toBe(false);
    expect(canTransition('approved', 'applied')).toBe(false);
    expect(canTransition('uncertain', 'applying')).toBe(false); // nunca reintento ciego
  });
  it('move() rechaza en código las transiciones fuera de la tabla', async () => {
    await expect(_moveForTests({} as Db, 'x', ['proposed'], 'applied', null, 'x')).rejects.toThrow(/Transición inválida/);
    await expect(_moveForTests({} as Db, 'x', ['uncertain'], 'applying', null, 'x')).rejects.toThrow(/Transición inválida/);
  });
});

describe('elegibilidad para automático (gancho)', () => {
  const base = { resultStatus: 'MATCH_WITH_DIFFERENCES', candidateCount: 1, differences: [{ severity: 'adjustable' }], weightSource: 'terpel' as const, terpelVolume: '100', tariffOk: true, recordStatus: 'CUMPLIDO', invoice: null, complete: true };
  it('cumple todas las condiciones o explica por qué no', () => {
    expect(autoEligibility(base)).toEqual({ eligible: true, reasons: [] });
    expect(autoEligibility({ ...base, candidateCount: 2 }).eligible).toBe(false);
    expect(autoEligibility({ ...base, differences: [{ severity: 'adjustable' }, { severity: 'info' }] }).eligible).toBe(false);
    expect(autoEligibility({ ...base, terpelVolume: '0' }).eligible).toBe(false);
    expect(autoEligibility({ ...base, terpelVolume: '0', weightSource: 'silogtran' }).eligible).toBe(true);
    expect(autoEligibility({ ...base, tariffOk: false }).eligible).toBe(false);
    expect(autoEligibility({ ...base, recordStatus: 'ACTIVO' }).eligible).toBe(false);
    expect(autoEligibility({ ...base, invoice: 'F-1' }).eligible).toBe(false);
    expect(autoEligibility({ ...base, complete: false }).eligible).toBe(false);
  });
});

// ---- Flujo completo por API (PGlite + migraciones reales) -----------------------------------------------
/** Escritor de prueba NO simulado que sí modifica la fuente de lectura (para probar la verificación posterior). */
class RealisticTestWriter implements SilogtranWriter {
  readonly kind = 'mock' as const;
  readonly simulated = false;
  calls: TariffChange[] = [];
  honest = true;
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async changeTariff(c: TariffChange): Promise<WriterOutcome> {
    this.calls.push(c);
    if (!this.honest) return { outcome: 'verification_failed', detail: 'La consulta de la remesa no coincide (simulado)' };
    const row = this.rows.find((r) => String(r.remesa_codigo) === c.remesaCode);
    if (row) { row.remesa_peso = Number(c.pesoRemesa); row.total_remesa = String(Number(c.pesoRemesa) * Number(c.nuevaTarifa)); }
    return { outcome: 'applied' };
  }
  async rehearse(c: TariffChange): Promise<RehearsalResult> { return { simulated: false, payload: c, before: null, checks: [], wouldPostGrabar: false }; }
  async getChangeState(): Promise<ChangeStateResult> { return { state: 'unknown' }; }
}

describe('ajustes de tarifa (API)', () => {
  let ctx: AppContext;
  let rows: Record<string, unknown>[];
  let mockWriter: MockSilogtranWriter;
  const tok: Record<string, string> = {};
  let runId = '';
  let seq = 0;
  const call = (method: string, path: string, token?: string, body?: unknown, query: Record<string, string> = {}) =>
    handleRequest(ctx, { method, path, query, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  const j = <T>(r: { json?: unknown }): T => r.json as T;
  const list = async (status?: string): Promise<ProposalDto[]> =>
    j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId, ...(status ? { status } : {}) })).proposals;
  const byT = async (t: string): Promise<ProposalDto> => (await list()).find((p) => p.transportNumber === t && p.status !== 'stale') as ProposalDto;

  async function seedService(o: { t: string; date: string; driver: string; vol: number; value: number; expense?: string }): Promise<void> {
    seq += 1;
    const db = ctx.db;
    const msg = await db.query<{ id: string }>(`insert into source_messages (mailbox, graph_immutable_id, internet_message_id, received_at) values ('m@x',$1,$1,now()) returning id`, [`g${seq}`]);
    const svc = await db.query<{ id: string }>(`insert into services (business_key, transport_number, version_count) values ($1,$1,1) returning id`, [o.t]);
    const au = await db.query<{ id: string }>(
      `insert into authorizations (message_id, service_id, version, parse_status, parser_version, transport_number, expense_number, service_date, route, plate_normalized, transport_volume, net_value, driver_code)
       values ($1,$2,1,'ok','t',$3,$4,$5,'C1-AAA - BBB','PLA001',$6,$7,$8) returning id`,
      [msg.rows[0]?.id, svc.rows[0]?.id, o.t, o.expense ?? `G${o.t}`, o.date, o.vol, o.value, o.driver],
    );
    await db.query('update services set current_authorization_id=$2 where id=$1', [svc.rows[0]?.id, au.rows[0]?.id]);
  }
  const sRow = (code: number, driver: string, date: string, weight: number, total: string, extra: Record<string, unknown> = {}) =>
    silogRow({ cliente_nit: TERPEL_NIT, manifiesto: `M${code}`, remesa_codigo: code, fecha: date, conductor_documento: driver, placa: 'PLA001', ciudad_origen_remesa: 'AAA', ciudad_destino_remesa: 'BBB', remesa_peso: weight, total_remesa: total, remesa_tarifa: '100', ...extra });

  async function reconcile(from: string, to: string): Promise<string> {
    const c = await call('POST', '/api/reconciliations', tok.fact, { dateFrom: from, dateTo: to });
    const id = j<{ id: string }>(c).id;
    for (let i = 0; i < 30; i += 1) if (j<{ done: boolean }>(await call('POST', `/api/reconciliations/${id}/step`, tok.fact)).done) break;
    return id;
  }
  const generate = async (): Promise<{ created: number; refreshed: number; unchanged: number; needsReview: number; staled: number; total: number }> =>
    j(await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok.fact));

  beforeAll(async () => {
    setLogSink(() => undefined);
    ctx = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afj-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: 'a1'.repeat(32), APP_SESSION_SECRET: 'x'.repeat(40), SILOG_SOURCE: 'none' });
    for (const [k, e] of [['admin', 'admin@demo.local'], ['op', 'operador@demo.local'], ['view', 'lector@demo.local'], ['fact', 'facturacion@demo.local']] as const) {
      tok[k] = j<{ token: string }>(await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' })).token;
    }
    await ctx.db.query(`update reconciliation_settings set zero_volume_mode = 'reconcile_always'`);
    await seedService({ t: 'T-A', date: '2026-11-17', driver: '0000000011', vol: 10487, value: 2464445 });
    await seedService({ t: 'T-B', date: '2026-11-18', driver: '0000000012', vol: 10174, value: 6694492 });
    await seedService({ t: 'T-E', date: '2026-11-20', driver: '0000000015', vol: 9984, value: 2346240 });
    await seedService({ t: 'T-N', date: '2026-11-20', driver: '0000000016', vol: 3000, value: 2740000 }); // no exacta
    await seedService({ t: 'T-L', date: '2026-11-20', driver: '0000000017', vol: 16384, value: 1 }); // demasiado larga
    await seedService({ t: 'T-Z', date: '2026-11-21', driver: '0000000018', vol: 0, value: 5000000 }); // volumen 0: peso de Silogtran
    await seedService({ t: 'T-X', date: '2026-11-21', driver: '0000000019', vol: 100, value: 1000 }); // exacto: sin propuesta
    rows = [
      sRow(1, '11', '2026-11-15', 10460, '2460000'),
      sRow(2, '12', '2026-11-16', 10122, '6690000'),
      sRow(3, '15', '2026-11-18', 9979, '2735616'),
      sRow(4, '16', '2026-11-18', 2990, '2700000'),
      sRow(5, '17', '2026-11-18', 16000, '2'),
      sRow(6, '18', '2026-11-19', 10000, '4000000'),
      sRow(7, '19', '2026-11-19', 100, '1000'),
    ];
    ctx.silog = new MockSilogtranSource(rows);
    mockWriter = new MockSilogtranWriter();
    ctx.writer = mockWriter;
    runId = await reconcile('2026-11-17', '2026-11-25');
  });
  afterAll(async () => ctx.db.close());

  it('genera propuestas: 3 reales exactas + zero-volume + 2 en revisión; idempotente', async () => {
    const s = await generate();
    expect(s).toMatchObject({ created: 6, needsReview: 2, total: 6 });
    const ps = await list();
    expect(ps.map((p) => p.transportNumber)).toEqual(['T-A', 'T-B', 'T-E', 'T-L', 'T-N', 'T-Z']);
    const a = ps.find((p) => p.transportNumber === 'T-A') as ProposalDto;
    expect(a).toMatchObject({ status: 'proposed', tariff: '235', gallons: '10487', currentWeight: '10460', currentTotal: '2460000', targetValue: '2464445', weightSource: 'terpel', simulated: false });
    expect(a.lines.map((l) => [l.field, l.current, l.proposed])).toEqual([
      ['pesoRemesa', '10460', '10487'], ['cantidadRemesa', '10460', '10487'], ['nuevaTarifa', '100', '235'], ['totalRemesa', '2460000', '2464445'],
    ]);
    expect(a.reason).toBe('Ajuste según autorización de pago Terpel, transporte T-A, gasto GT-A');
    expect(ps.find((p) => p.transportNumber === 'T-B')).toMatchObject({ tariff: '658', gallons: '10174' });
    expect(ps.find((p) => p.transportNumber === 'T-E')).toMatchObject({ tariff: '235', gallons: '9984', currentTotal: '2735616', targetValue: '2346240' });
    expect(ps.find((p) => p.transportNumber === 'T-N')).toMatchObject({ status: 'needs_review', reviewCode: 'TARIFF_NOT_EXACT', tariff: null });
    expect(ps.find((p) => p.transportNumber === 'T-L')).toMatchObject({ status: 'needs_review', reviewCode: 'TARIFF_TOO_LONG' });
    expect(ps.find((p) => p.transportNumber === 'T-Z')).toMatchObject({ status: 'proposed', weightSource: 'silogtran', gallons: '10000', tariff: '500', targetValue: '5000000' });
    // idempotente
    const again = await generate();
    expect(again).toMatchObject({ created: 0, unchanged: 6, staled: 0 });
    expect((await list()).length).toBe(6);
    // elegibilidad informada, pero el automático está apagado
    expect(a.autoEligible).toBe(true);
    expect(a.autoAllowed).toBe(false);
  });

  it('permisos: facturación aprueba y aplica; operador y lector no; parámetros solo admin', async () => {
    const a = await byT('T-A');
    for (const k of ['op', 'view']) {
      expect((await call('POST', `/api/reconciliations/${runId}/adjustments/generate`, tok[k])).status).toBe(403);
      expect((await call('POST', `/api/adjustments/${a.id}/approve`, tok[k])).status).toBe(403);
      expect((await call('POST', `/api/adjustments/${a.id}/apply`, tok[k])).status).toBe(403);
      expect((await call('POST', `/api/adjustments/${a.id}/simulate`, tok[k])).status).toBe(403);
      expect((await call('POST', '/api/adjustments/apply-batch', tok[k], { ids: [a.id] })).status).toBe(403);
      expect((await call('GET', '/api/adjustments', tok[k], undefined, { runId })).status).toBe(200); // ver: todos
    }
    expect((await call('PUT', '/api/adjustments/settings', tok.fact, { autoEnabled: true })).status).toBe(403);
    expect((await call('POST', '/api/adjustments/discard-simulated', tok.fact)).status).toBe(403);
    expect((await call('GET', '/api/adjustments', undefined, undefined, { runId })).status).toBe(401);
  });

  it('needs_review no se puede aprobar ni aplicar; simular muestra el envío exacto sin cambiar estado', async () => {
    const n = await byT('T-N');
    expect((await call('POST', `/api/adjustments/${n.id}/approve`, tok.fact)).status).toBe(409);
    expect((await call('POST', `/api/adjustments/${n.id}/apply`, tok.fact)).status).toBe(409);
    const a = await byT('T-A');
    const sim = j<{ simulated: boolean; payload: Record<string, string>; blocked: string | null }>(await call('POST', `/api/adjustments/${a.id}/simulate`, tok.fact));
    expect(sim.simulated).toBe(true);
    expect(sim.payload).toEqual({ remesaCode: '1', reason: a.reason, pesoRemesa: '10487', cantidadRemesa: '10487', nuevaTarifa: '235', valorTotal: '2464445' });
    expect((await byT('T-A')).status).toBe('proposed');
    expect(mockWriter.calls).toHaveLength(0);
    // aplicar sin aprobar: transición inválida
    expect((await call('POST', `/api/adjustments/${a.id}/apply`, tok.fact)).status).toBe(409);
    expect((await call('POST', `/api/adjustments/${a.id}/approve`, tok.fact)).status).toBe(200);
    expect((await call('POST', `/api/adjustments/${a.id}/approve`, tok.fact)).status).toBe(409); // ya aprobada
  });

  it('aplicar con el escritor MOCK: simulated_applied (nunca applied), línea de tiempo, sin doble aplicación', async () => {
    const a = await byT('T-A');
    const [r1, r2] = await Promise.all([call('POST', `/api/adjustments/${a.id}/apply`, tok.fact), call('POST', `/api/adjustments/${a.id}/apply`, tok.fact)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]); // concurrencia: gana uno solo
    expect(mockWriter.calls).toHaveLength(1);
    const p = await byT('T-A');
    expect(p).toMatchObject({ status: 'simulated_applied', simulated: true, writerKind: 'mock', approvedBy: expect.any(String), appliedBy: expect.any(String) });
    expect(p.verification).toMatchObject({ skipped: true });
    expect(JSON.stringify(p)).not.toMatch(/password/i);
    const third = await call('POST', `/api/adjustments/${a.id}/apply`, tok.fact);
    expect(third.status).toBe(409);
    expect(j<{ error: { code: string } }>(third).error.code).toBe('ALREADY_APPLIED');
    expect(mockWriter.calls).toHaveLength(1);
    const detail = j<{ events: ProposalEventDto[] }>(await call('GET', `/api/adjustments/${a.id}`, tok.view));
    expect(detail.events.map((e) => e.event)).toEqual(['generated', 'approved', 'apply_started', 'simulated_applied']);
    expect(detail.events.at(-1)).toMatchObject({ fromStatus: 'applying', toStatus: 'simulated_applied', simulated: true });
    // el registro real no cambió (el lector de Silogtran no se tocó)
    expect(rows[0]?.remesa_peso).toBe(10460);
  });

  it('stale: si Silogtran cambió (o ya hay factura) no se escribe', async () => {
    const b = await byT('T-B');
    await call('POST', `/api/adjustments/${b.id}/approve`, tok.fact);
    (rows[1] as Record<string, unknown>).factura = 'FAC-1';
    const calls = mockWriter.calls.length;
    const r = await call('POST', `/api/adjustments/${b.id}/apply`, tok.fact);
    expect(j<ProposalDto>(r).status).toBe('stale');
    expect(mockWriter.calls).toHaveLength(calls);
    (rows[1] as Record<string, unknown>).factura = null;
    const ev = j<{ events: ProposalEventDto[] }>(await call('GET', `/api/adjustments/${b.id}`, tok.fact)).events;
    expect(ev.at(-1)?.event).toBe('stale');
    // regenerar la devuelve a propuesta (los valores siguen iguales)
    expect(await generate()).toMatchObject({ refreshed: 1, created: 0 });
    expect((await list()).find((p) => p.transportNumber === 'T-B')?.status).toBe('proposed');
  });

  it('rechazo y conflicto del escritor: failed (certeza de no aplicado) y reintento permitido', async () => {
    const e = await byT('T-E');
    await call('POST', `/api/adjustments/${e.id}/approve`, tok.fact);
    mockWriter.mode = 'reject';
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${e.id}/apply`, tok.fact)).status).toBe('failed');
    mockWriter.mode = 'conflict';
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${e.id}/apply`, tok.fact)).status).toBe('failed');
    mockWriter.mode = 'success';
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${e.id}/apply`, tok.fact)).status).toBe('simulated_applied');
  });

  it('incierto: no hay reintento ciego; se consulta el estado y recién entonces se puede reintentar', async () => {
    const z = await byT('T-Z');
    await call('POST', `/api/adjustments/${z.id}/approve`, tok.fact);
    mockWriter.mode = 'timeout';
    const before = mockWriter.calls.length;
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${z.id}/apply`, tok.fact)).status).toBe('uncertain');
    const retry = await call('POST', `/api/adjustments/${z.id}/apply`, tok.fact);
    expect(retry.status).toBe(409); // no se reintenta a ciegas
    expect(mockWriter.calls.length).toBe(before + 1);
    // consulta: el cambio NO llegó => failed (certeza) => reintento posible
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${z.id}/check`, tok.fact)).status).toBe('failed');
    mockWriter.mode = 'timeout';
    mockWriter.timeoutAppliesChange = true;
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${z.id}/apply`, tok.fact)).status).toBe('uncertain');
    // consulta: SÍ llegó => se completa sin volver a escribir
    const n = mockWriter.calls.length;
    expect(j<ProposalDto>(await call('POST', `/api/adjustments/${z.id}/check`, tok.fact)).status).toBe('simulated_applied');
    expect(mockWriter.calls.length).toBe(n);
    mockWriter.mode = 'success';
    mockWriter.timeoutAppliesChange = false;
    expect((await call('POST', `/api/adjustments/${z.id}/check`, tok.fact)).status).toBe(409); // solo para inciertas
  });

  it('lote seleccionado: cada propuesta con su propio resultado', async () => {
    const [n, l] = [await byT('T-N'), await byT('T-L')];
    const e = await byT('T-E');
    const r = j<{ results: { id: string; ok: boolean; code?: string }[] }>(await call('POST', '/api/adjustments/apply-batch', tok.fact, { ids: [n.id, l.id, e.id] }));
    expect(r.results.map((x) => [x.ok, x.code])).toEqual([[false, 'NEEDS_REVIEW'], [false, 'NEEDS_REVIEW'], [false, 'ALREADY_APPLIED']]);
    expect((await call('POST', '/api/adjustments/apply-batch', tok.fact, { ids: [] })).status).toBe(400);
    expect((await call('POST', '/api/adjustments/apply-batch', tok.fact, { ids: ['x'] })).status).toBe(400);
  });

  it('regenerar con valores distintos deja la anterior obsoleta; rechazo; plantilla de razón (solo admin)', async () => {
    // cambia el valor de Terpel de T-N: pasa a tarifa exacta
    await ctx.db.query(`update authorizations set net_value = 3000000 where transport_number = 'T-N'`);
    const s = await generate();
    expect(s.created).toBe(1);
    expect(s.staled).toBe(1);
    const all = await list();
    expect(all.filter((p) => p.transportNumber === 'T-N').map((p) => p.status).sort()).toEqual(['proposed', 'stale']);
    const n = (await list()).find((p) => p.transportNumber === 'T-N' && p.status === 'proposed') as ProposalDto;
    expect(n.tariff).toBe('1000');
    expect((await call('POST', `/api/adjustments/${n.id}/reject`, tok.fact, { reason: 'prueba' })).status).toBe(200);
    expect((await call('POST', `/api/adjustments/${n.id}/approve`, tok.fact)).status).toBe(409);
    expect((await call('PUT', '/api/adjustments/settings', tok.admin, { reasonTemplate: 'Cambio {nada}' })).status).toBe(400);
    expect((await call('PUT', '/api/adjustments/settings', tok.admin, { reasonTemplate: 'Ajuste Terpel {transport} / {expense}' })).status).toBe(200);
    await ctx.db.query(`update authorizations set net_value = 2740000 where transport_number = 'T-N'`);
  });

  it('descartar simulaciones (admin) deja el historial y permite proponer de nuevo', async () => {
    const before = (await list('simulated_applied')).length;
    expect(before).toBeGreaterThan(0);
    const r = j<{ discarded: number }>(await call('POST', '/api/adjustments/discard-simulated', tok.admin));
    expect(r.discarded).toBe(before);
    expect((await list('simulated_applied')).length).toBe(0);
    expect((await list('discarded')).length).toBe(before);
    const ev = (await ctx.db.query<{ event: string }>(`select event from adjustment_events where event = 'discarded'`)).rowCount;
    expect(ev).toBe(before);
    await generate();
    expect((await list('discarded')).length).toBe(0);
    const aud = (await ctx.db.query<{ action: string }>('select action from audit_log')).rows.map((a) => a.action);
    expect(aud).toEqual(expect.arrayContaining(['adjustment.generate', 'adjustment.approve', 'adjustment.apply', 'adjustment.simulate', 'adjustment.discard_simulated', 'adjust_settings.update']));
  });

  it('modo web: cuenta de ajustes y lista de remesas permitidas obligatorias; nada cambia de estado', async () => {
    await ctx.db.query(`update adjustment_settings set writer_mode = 'web'`);
    const a = await byT('T-A');
    await call('POST', `/api/adjustments/${a.id}/approve`, tok.fact);
    const noAcc = await call('POST', `/api/adjustments/${a.id}/apply`, tok.fact);
    expect(j<{ error: { code: string } }>(noAcc).error.code).toBe('ADJUST_ACCOUNT_NOT_CONFIGURED');
    expect((await byT('T-A')).status).toBe('approved');
    await ctx.db.query(`insert into silog_credentials (purpose, silog_user, password_enc) values ('adjust','cuenta.ajustes','v1:x:y:z')`);
    const blocked = await call('POST', `/api/adjustments/${a.id}/apply`, tok.fact);
    expect(blocked.status).toBe(409);
    expect(j<{ error: { code: string } }>(blocked).error.code).toBe('REMESA_NOT_ALLOWED');
    expect(j<{ error: { code: string } }>(await call('POST', `/api/adjustments/${a.id}/rehearse`, tok.fact)).error.code).toBe('REMESA_NOT_ALLOWED');
    expect((await byT('T-A')).status).toBe('approved');
    const sim = j<{ simulated: boolean; accountUser: string; blocked: string }>(await call('POST', `/api/adjustments/${a.id}/simulate`, tok.fact));
    expect(sim).toMatchObject({ simulated: false, accountUser: 'cuenta.ajustes', blocked: 'REMESA_NOT_ALLOWED' });
    expect(j<{ mode: string; simulated: boolean }>(await call('GET', '/api/adjustments/writer-status', tok.view))).toMatchObject({ mode: 'web', simulated: false });
    await ctx.db.query(`update adjustment_settings set writer_mode = null`);
    await ctx.db.query(`delete from silog_credentials`);
  });

  it('escritor no simulado: verificación en la consulta de la remesa (applied) y verification_failed si no coincide', async () => {
    const real = new RealisticTestWriter(rows);
    ctx.writer = real;
    const a = await byT('T-A'); // sigue aprobada
    const ok = j<ProposalDto>(await call('POST', `/api/adjustments/${a.id}/apply`, tok.fact));
    expect(ok).toMatchObject({ status: 'applied', simulated: false });
    expect(ok.verification).toMatchObject({ ok: true, source: 'home_111' });
    expect(rows[0]?.remesa_peso).toBe(10487);
    // segunda: el escritor "dice" aplicar pero Silogtran no cambió => verification_failed
    real.honest = false;
    const b = await byT('T-B');
    await call('POST', `/api/adjustments/${b.id}/approve`, tok.fact);
    const bad = j<ProposalDto>(await call('POST', `/api/adjustments/${b.id}/apply`, tok.fact));
    expect(bad.status).toBe('verification_failed');
    expect(bad.verification).toMatchObject({ ok: false });
    expect((await call('POST', `/api/adjustments/${b.id}/apply`, tok.fact)).status).toBe(409);
    ctx.writer = mockWriter;
  });

  it('Excel concuerda con la BD y marca lo simulado', async () => {
    const exp = j<{ url: string; rows: number }>(await call('POST', '/api/adjustments/export', tok.fact, { runId }));
    expect(exp.rows).toBeGreaterThan(0);
    const path = (await ctx.db.query<{ storage_path: string }>('select storage_path from adjustment_exports order by generated_at desc limit 1')).rows[0]?.storage_path as string;
    const file = await ctx.storage.get(path);
    const ps = await list();
    expect(await compareAdjustWorkbook(file, ps)).toEqual([]);
    expect(flatten(ps).length).toBe(ps.reduce((n, p) => n + p.lines.length, 0));
    expect(ps.some((p) => p.simulated)).toBe(true);
  });

  it('parámetro adjustments_auto_enabled gobierna autoAllowed (sin orquestador)', async () => {
    expect((await call('PUT', '/api/adjustments/settings', tok.admin, { autoEnabled: true })).status).toBe(200);
    const z = await byT('T-Z');
    expect(z.autoEligible).toBe(true);
    expect(z.autoAllowed).toBe(true);
    expect((await byT('T-L')).autoAllowed).toBe(false);
    await call('PUT', '/api/adjustments/settings', tok.admin, { autoEnabled: false });
    expect((await byT('T-Z')).autoAllowed).toBe(false);
  });

  it('config pública: el escritor es mock (banner de modo simulado)', async () => {
    expect(j<{ writerKind: string }>(await call('GET', '/api/config')).writerKind).toBe('mock');
  });

  it('si el servicio ya no tiene diferencias (total igual), al regenerar su propuesta queda obsoleta; si vuelve a tenerlas, se repropone', async () => {
    const l = await byT('T-L');
    expect(l.status).toBe('needs_review');
    await ctx.db.query(`update reconciliation_results set status = 'EXACT' where transport_number = 'T-L'`);
    const s1 = await generate();
    expect(s1.staled).toBeGreaterThanOrEqual(1);
    expect((await list('stale')).some((p) => p.transportNumber === 'T-L')).toBe(true);
    const ev = j<{ events: ProposalEventDto[] }>(await call('GET', `/api/adjustments/${l.id}`, tok.fact)).events;
    expect(ev.at(-1)).toMatchObject({ event: 'superseded', toStatus: 'stale' });
    await ctx.db.query(`update reconciliation_results set status = 'MATCH_WITH_DIFFERENCES' where transport_number = 'T-L'`);
    await generate();
    expect((await list()).find((p) => p.transportNumber === 'T-L' && p.status !== 'stale')).toMatchObject({ status: 'needs_review' });
  });
});
