import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSilogtranWriter } from '../core/adjust/writer.js';
import type { RehearsalResult, TariffChange } from '../core/adjust/writer.js';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { handleRequest } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import { MockSilogtranSource } from '../core/recon/silogtran.js';
import type { AssistedPlanDto, AssistedRunDetailDto, ProposalDto } from '../core/types.js';
import { TERPEL_NIT, silogRow } from '../fixtures/silogtran.js';

/** Escritor simulado que hace fallar el ensayo de ciertas remesas. */
class PickyWriter extends MockSilogtranWriter {
  failRehearsal = new Set<string>();
  rehearsals = 0;
  override async rehearse(change: TariffChange): Promise<RehearsalResult> {
    this.rehearsals += 1;
    const base = await super.rehearse(change);
    return this.failRehearsal.has(change.remesaCode) ? { ...base, checks: [{ name: 'valores reales iguales a los del ensayo', ok: false, detail: 'cambiaron' }] } : base;
  }
}

describe('modo asistido de ajustes', () => {
  let ctx: AppContext;
  let writer: PickyWriter;
  let reconId = '';
  const tok: Record<string, string> = {};
  let seq = 0;
  const call = (m: string, p: string, t?: string, b?: unknown, query: Record<string, string> = {}) => handleRequest(ctx, { method: m, path: p, query, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b });
  const j = <T>(r: { json?: unknown }): T => r.json as T;

  async function seedService(o: { t: string; date: string; driver: string; vol: number; value: number; route?: string }): Promise<void> {
    seq += 1;
    const db = ctx.db;
    const msg = await db.query<{ id: string }>(`insert into source_messages (mailbox, graph_immutable_id, internet_message_id, received_at) values ('m@x',$1,$1,now()) returning id`, [`g${seq}`]);
    const svc = await db.query<{ id: string }>(`insert into services (business_key, transport_number, version_count) values ($1,$1,1) returning id`, [o.t]);
    const au = await db.query<{ id: string }>(
      `insert into authorizations (message_id, service_id, version, parse_status, parser_version, transport_number, expense_number, service_date, route, plate_normalized, transport_volume, net_value, driver_code)
       values ($1,$2,1,'ok','t',$3,$4,$5,$6,'PLA001',$7,$8,$9) returning id`,
      [msg.rows[0]?.id, svc.rows[0]?.id, o.t, `G${o.t}`, o.date, o.route ?? 'C1-AAA - BBB', o.vol, o.value, o.driver],
    );
    await db.query('update services set current_authorization_id=$2 where id=$1', [svc.rows[0]?.id, au.rows[0]?.id]);
  }
  const sRow = (code: number, driver: string, date: string, weight: number, total: string, rate = '100', extra: Record<string, unknown> = {}) =>
    silogRow({ cliente_nit: TERPEL_NIT, manifiesto: `M${code}`, remesa_codigo: code, fecha: date, conductor_documento: driver, placa: 'PLA001', ciudad_origen_remesa: 'AAA', ciudad_destino_remesa: 'BBB', remesa_peso: weight, total_remesa: total, remesa_tarifa: rate, ...extra });

  const plan = async (): Promise<AssistedPlanDto> => j<AssistedPlanDto>(await call('POST', `/api/reconciliations/${reconId}/assisted/plan`, tok.fact));
  const create = async (ids: string[], confirm = true) => call('POST', '/api/assisted-runs', tok.fact, { reconRunId: reconId, proposalIds: ids, confirm });
  async function runToEnd(id: string, body: Record<string, unknown> = {}): Promise<AssistedRunDetailDto> {
    let d = j<AssistedRunDetailDto>(await call('POST', `/api/assisted-runs/${id}/step`, tok.fact, body));
    for (let i = 0; i < 20 && d.run.status === 'running'; i += 1) d = j<AssistedRunDetailDto>(await call('POST', `/api/assisted-runs/${id}/step`, tok.fact, body));
    return d;
  }

  beforeAll(async () => {
    setLogSink(() => undefined);
    ctx = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afa-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: 'a1'.repeat(32), APP_SESSION_SECRET: 'x'.repeat(40), SILOG_SOURCE: 'none' });
    writer = new PickyWriter();
    ctx.writer = writer;
    for (const [k, e] of [['admin', 'admin@demo.local'], ['fact', 'facturacion@demo.local'], ['op', 'operador@demo.local'], ['view', 'lector@demo.local']] as const) {
      tok[k] = j<{ token: string }>(await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' })).token;
    }
    // 4 elegibles (A-D), 1 tarifa no exacta, 1 ya ajustado, 1 ambiguo, 1 sin coincidencia, 1 volumen 0 (Terpel debe corregir)
    await seedService({ t: 'T-A', date: '2026-11-17', driver: '0000000011', vol: 10487, value: 2464445 });
    await seedService({ t: 'T-B', date: '2026-11-18', driver: '0000000012', vol: 10174, value: 6694492 });
    await seedService({ t: 'T-C', date: '2026-11-19', driver: '0000000013', vol: 9984, value: 2346240 });
    await seedService({ t: 'T-D', date: '2026-11-19', driver: '0000000014', vol: 4000, value: 1000000 });
    await seedService({ t: 'T-N', date: '2026-11-20', driver: '0000000016', vol: 3000, value: 2740000 });
    await seedService({ t: 'T-ADJ', date: '2026-11-20', driver: '0000000017', vol: 5000, value: 1000000 });
    await seedService({ t: 'T-AMB', date: '2026-11-20', driver: '0000000018', vol: 100, value: 100 });
    await seedService({ t: 'T-NM', date: '2026-11-21', driver: '0000000019', vol: 100, value: 100 });
    await seedService({ t: 'T-Z', date: '2026-11-21', driver: '0000000020', vol: 0, value: 500 });
    ctx.silog = new MockSilogtranSource([
      sRow(1, '11', '2026-11-15', 10460, '2464445'), sRow(2, '12', '2026-11-16', 10122, '6694492'), sRow(3, '13', '2026-11-17', 9979, '2735616'),
      sRow(4, '14', '2026-11-17', 3990, '900000'), sRow(5, '16', '2026-11-18', 2990, '2700000'),
      // ya ajustado: peso, cantidad y tarifa (rate) ya son los esperados (5000 y 200)
      sRow(6, '17', '2026-11-18', 5000, '999999', '200'),
      sRow(7, '18', '2026-11-18', 90, '90'), sRow(8, '18', '2026-11-18', 91, '91'), // misma fecha: ambiguo de verdad
      sRow(9, '20', '2026-11-19', 777, '400'),
    ]);
    const c = await call('POST', '/api/reconciliations', tok.fact, { dateFrom: '2026-11-17', dateTo: '2026-11-25' });
    reconId = j<{ id: string }>(c).id;
    for (let i = 0; i < 30; i += 1) if (j<{ done: boolean }>(await call('POST', `/api/reconciliations/${reconId}/step`, tok.fact)).done) break;
  });
  afterAll(async () => ctx.db.close());

  it('permisos y confirmación obligatoria', async () => {
    for (const k of ['op', 'view']) {
      expect((await call('POST', `/api/reconciliations/${reconId}/assisted/plan`, tok[k])).status, `${k} plan`).toBe(403);
      expect((await call('POST', '/api/assisted-runs', tok[k], { reconRunId: reconId, proposalIds: ['x'], confirm: true })).status).toBe(403);
      expect((await call('POST', '/api/assisted-runs/00000000-0000-4000-8000-000000000001/step', tok[k])).status).toBe(403);
    }
    expect((await call('POST', `/api/reconciliations/${reconId}/assisted/plan`, undefined)).status).toBe(401);
    expect((await call('GET', '/api/assisted-runs', tok.view)).status).toBe(200); // ver: todos
    const p = await plan();
    expect((await create([p.eligible[0]?.proposalId as string], false)).status).toBe(400);
    const noConfirm = await call('POST', '/api/assisted-runs', tok.fact, { reconRunId: reconId, proposalIds: [p.eligible[0]?.proposalId], confirm: 'true' });
    expect(j<{ error: { code: string } }>(noConfirm).error.code).toBe('CONFIRM_REQUIRED');
    expect((await create([])).status).toBe(400);
    expect((await create(['00000000-0000-4000-8000-000000000001'])).status).toBe(400); // no elegible
  });

  it('plan: elegibles con valores actuales→propuestos y excluidas con motivo legible; sin efectos sobre Silogtran', async () => {
    const p = await plan();
    expect(p.writer).toMatchObject({ mode: 'mock', simulated: true });
    expect(p.eligible.map((e) => e.transportNumber)).toEqual(['T-A', 'T-B', 'T-C', 'T-D']);
    expect(p.eligible[0]).toMatchObject({ remesaCode: '1', current: { peso: '10460', tarifa: '100' }, proposed: { peso: '10487', cantidad: '10487', tarifa: '235', total: '2464445' } });
    const by = (c: string) => p.excluded.filter((e) => e.category === c).map((e) => e.transportNumber);
    expect(by('needs_review')).toEqual(['T-N']);
    expect(by('already_adjusted')).toEqual(['T-ADJ']);
    expect(by('terpel_pending')).toEqual(['T-Z']);
    expect(by('ambiguous')).toEqual(['T-AMB']);
    expect(by('no_match')).toEqual(['T-NM']);
    expect(p.excluded.every((e) => e.reason.length > 5)).toBe(true);
    expect(writer.calls).toHaveLength(0);
    const again = await plan(); // idempotente
    expect(again.eligible.length).toBe(4);
    expect(again.generated).toMatchObject({ created: 0 });
  });

  it('corrida feliz: aprueba, ensaya y aplica varias (SIMULADO); un paso por vez; no duplica; reporte', async () => {
    const p = await plan();
    const ids = p.eligible.slice(0, 3).map((e) => e.proposalId);
    const created = await create(ids);
    expect(created.status).toBe(201);
    const run = j<AssistedRunDetailDto>(created).run;
    expect(run).toMatchObject({ status: 'running', total: 3, pending: 3, simulated: true, writerMode: 'mock' });
    // una sola corrida activa
    expect((await create([p.eligible[3]?.proposalId as string])).status).toBe(409);
    // un ítem por paso (presupuesto 0 = prueba) y reanudable
    const s1 = j<AssistedRunDetailDto>(await call('POST', `/api/assisted-runs/${run.id}/step`, tok.fact, { budgetMs: 0 }));
    expect(s1.run).toMatchObject({ status: 'running', applied: 1, pending: 2 });
    const done = await runToEnd(run.id);
    expect(done.run).toMatchObject({ status: 'completed', applied: 3, skipped: 0, pending: 0, exportReady: true });
    expect(done.items.map((i) => i.result)).toEqual(['applied', 'applied', 'applied']);
    expect(done.items[0]).toMatchObject({ transportNumber: 'T-A', remesaCode: '1', after: { peso: '10487', cantidad: '10487', tarifa: '235' } });
    expect(writer.calls).toHaveLength(3); // una escritura (simulada) por propuesta, nunca dos
    // propuestas: aprobadas por el actor con evento 'assisted'
    const ps = j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId: reconId })).proposals;
    expect(ps.filter((x) => x.status === 'simulated_applied').map((x) => x.transportNumber).sort()).toEqual(['T-A', 'T-B', 'T-C']);
    const ev = j<{ events: { event: string }[] }>(await call('GET', `/api/adjustments/${ids[0]}`, tok.fact)).events.map((e) => e.event);
    expect(ev).toEqual(expect.arrayContaining(['approved', 'assisted', 'rehearsed', 'apply_started', 'simulated_applied']));
    // volver a pasar el paso no reejecuta nada
    const again = j<AssistedRunDetailDto>(await call('POST', `/api/assisted-runs/${run.id}/step`, tok.fact));
    expect(again.done).toBe(true);
    expect(writer.calls).toHaveLength(3);
    // las ya aplicadas no pueden volver a una corrida
    expect((await create([ids[0] as string])).status).toBe(400);
    const aud = (await ctx.db.query<{ action: string }>(`select action from audit_log where action like 'assisted.%'`)).rows.map((a) => a.action);
    expect(aud).toEqual(expect.arrayContaining(['assisted.plan', 'assisted.start', 'assisted.approve', 'assisted.finish', 'assisted.export']));
  });

  it('reporte .xlsx: resumen, aplicadas con antes→después, omitidas y secciones; sin datos sensibles', async () => {
    const run = (j<{ runs: { id: string }[] }>(await call('GET', '/api/assisted-runs', tok.view, undefined, { reconRunId: reconId })).runs)[0] as { id: string };
    const exp = await call('POST', `/api/assisted-runs/${run.id}/export`, tok.view);
    expect(exp.status).toBe(200);
    const path = (await ctx.db.query<{ export_path: string }>('select export_path from assisted_runs where id = $1', [run.id])).rows[0]?.export_path as string;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await ctx.storage.get(path)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen', 'Aplicadas', 'Omitidas y detenidas', 'Excluidas del plan']);
    const text = JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
    expect(text).toContain('Pendiente (fase 4, no implementada)');
    expect(text).toContain('SIMULADO');
    expect(text).toContain('Pendiente de Terpel (volumen 0)');
    expect(text).toContain('Ambiguo');
    expect(text).toContain('Ya ajustado');
    const applied = wb.getWorksheet('Aplicadas');
    expect(applied?.rowCount).toBe(4); // encabezado + 3
    expect(String(applied?.getRow(2).getCell(4).value)).toContain('peso 10487, cantidad 10487, tarifa 235');
    expect(text).not.toMatch(/password|cookie|0000000011/i);
  });

  it('ensayo fallido: se OMITE (nada se escribe) y la corrida continúa', async () => {
    // T-D queda elegible; se agregan otras dos descartando y reproponiendo las simuladas
    await call('POST', '/api/adjustments/discard-simulated', tok.admin);
    const p = await plan();
    expect(p.eligible.map((e) => e.transportNumber)).toEqual(['T-A', 'T-B', 'T-C', 'T-D']);
    writer.failRehearsal = new Set(['2']);
    const before = writer.calls.length;
    const run = j<AssistedRunDetailDto>(await create(p.eligible.map((e) => e.proposalId))).run;
    const done = await runToEnd(run.id);
    expect(done.run).toMatchObject({ status: 'completed', applied: 3, skipped: 1, pending: 0 });
    const skipped = done.items.find((i) => i.result === 'skipped');
    expect(skipped).toMatchObject({ transportNumber: 'T-B' });
    expect(skipped?.reason).toMatch(/El ensayo no pasó/);
    expect(writer.calls.length - before).toBe(3); // solo se escribió lo de las otras 3
    writer.failRehearsal = new Set();
    // la omitida queda aprobada (sin escribir) y vuelve al plan para un nuevo intento
    const again = await plan();
    expect(again.eligible.map((e) => e.transportNumber)).toEqual(['T-B']);
    expect(again.eligible[0]?.status).toBe('approved');
  });

  it('resultado incierto tras grabar: DETIENE la corrida, deja el resto sin tocar; reanudar continúa', async () => {
    await call('POST', '/api/adjustments/discard-simulated', tok.admin);
    const p = await plan();
    const ids = p.eligible.map((e) => e.proposalId);
    expect(ids.length).toBe(4);
    writer.mode = 'timeout';
    const calls0 = writer.calls.length;
    const run = j<AssistedRunDetailDto>(await create(ids)).run;
    const first = j<AssistedRunDetailDto>(await call('POST', `/api/assisted-runs/${run.id}/step`, tok.fact));
    expect(first.run).toMatchObject({ status: 'halted', applied: 0, pending: 3 });
    expect(first.run.haltedReason).toMatch(/uncertain/);
    expect(first.items.map((i) => i.result)).toEqual(['halted', 'pending', 'pending', 'pending']);
    expect(writer.calls.length - calls0).toBe(1); // el resto quedó sin tocar
    const untouched = j<{ proposals: ProposalDto[] }>(await call('GET', '/api/adjustments', tok.fact, undefined, { runId: reconId })).proposals.filter((x) => ids.slice(1).includes(x.id));
    expect(untouched.length).toBe(3);
    expect(untouched.every((x) => x.status === 'proposed' || x.status === 'approved')).toBe(true); // ni aplicadas ni en curso
    // sin reanudar explícitamente no avanza
    const blocked = await call('POST', `/api/assisted-runs/${run.id}/step`, tok.fact);
    expect(blocked.status).toBe(409);
    expect(j<{ error: { code: string } }>(blocked).error.code).toBe('RUN_HALTED');
    // reanudar: el ítem detenido queda detenido; el resto continúa (el escritor ya responde bien)
    writer.mode = 'success';
    const done = await runToEnd(run.id, { resume: true });
    expect(done.run.status).toBe('completed');
    expect(done.items.map((i) => i.result)).toEqual(['halted', 'applied', 'applied', 'applied']);
    expect((await call('POST', `/api/assisted-runs/${run.id}/step`, tok.view)).status).toBe(403);
  });

  it('reanudación tras un corte: un ítem cortado a mitad (applying vencido) detiene en vez de reintentar; lo ya aplicado no se repite', async () => {
    await call('POST', '/api/adjustments/discard-simulated', tok.admin);
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status in ('uncertain')`);
    const p = await plan();
    const ids = p.eligible.map((e) => e.proposalId);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const cr = await create(ids.slice(0, 3));
    expect(JSON.stringify(cr.json).slice(0, 300)).toContain('running');
    const run = j<AssistedRunDetailDto>(cr).run;
    await call('POST', `/api/assisted-runs/${run.id}/step`, tok.fact, { budgetMs: 0 }); // primer ítem aplicado
    // el navegador se cerró: el 2.º ítem quedó 'applying' con lease vencido y la corrida con lease vencido
    await ctx.db.query(`update adjustment_proposals set status = 'applying', lease_until = now() - interval '1 minute' where id = $1`, [ids[1]]);
    await ctx.db.query(`update assisted_runs set lease_until = now() - interval '1 minute' where id = $1`, [run.id]);
    const calls = writer.calls.length;
    const after = j<AssistedRunDetailDto>(await call('POST', `/api/assisted-runs/${run.id}/step`, tok.fact));
    expect(after.run.status).toBe('halted');
    expect(after.items.map((i) => i.result)).toEqual(['applied', 'halted', 'pending']);
    expect(writer.calls.length).toBe(calls); // no se reescribió nada
  });

  it('modo web: solo remesas permitidas; las demás se excluyen con motivo y no se pueden confirmar', async () => {
    await ctx.db.query(`update adjustment_proposals set status = 'discarded' where status in ('uncertain','simulated_applied','halted','applying','failed')`);
    await ctx.db.query(`update adjustment_settings set writer_mode = 'web', writer_allowlist = '{2}', writer_allow_all = false`);
    const p = await plan();
    expect(p.writer).toMatchObject({ mode: 'web', simulated: false, allowlist: ['2'] });
    expect(p.eligible.map((e) => e.remesaCode)).toEqual(['2']);
    expect(p.excluded.filter((e) => e.category === 'not_allowed').length).toBeGreaterThanOrEqual(1);
    const notAllowed = p.excluded.find((e) => e.category === 'not_allowed');
    expect(notAllowed?.reason).toMatch(/lista de remesas permitidas/);
    const bad = await create([notAllowed?.proposalId as string]);
    expect(bad.status).toBe(400);
    expect(writer.calls.length).toBeGreaterThan(0);
    await ctx.db.query(`update adjustment_settings set writer_mode = null, writer_allowlist = '{}'`);
  });
});
