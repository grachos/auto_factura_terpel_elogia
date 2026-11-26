import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { handleRequest } from '../core/http/router.js';
import { setLogSink } from '../core/logger.js';
import { MockSilogtranSource } from '../core/recon/silogtran.js';
import { TERPEL_NIT, silogRow } from '../fixtures/silogtran.js';

describe('asignación uno a uno (recon-1.4.0)', () => {
  let ctx: AppContext;
  let tok = '';
  let seq = 0;
  const call = (m: string, p: string, t?: string, b?: unknown) => handleRequest(ctx, { method: m, path: p, query: {}, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b });

  async function seed(o: { t: string; date: string; driver: string; plate: string; vol: number; value: number }): Promise<void> {
    seq += 1;
    const db = ctx.db;
    const msg = await db.query<{ id: string }>(`insert into source_messages (mailbox, graph_immutable_id, internet_message_id, received_at) values ('m@x',$1,$1,now()) returning id`, [`g${seq}`]);
    const svc = await db.query<{ id: string }>(`insert into services (business_key, transport_number, version_count) values ($1,$1,1) returning id`, [o.t]);
    const au = await db.query<{ id: string }>(
      `insert into authorizations (message_id, service_id, version, parse_status, parser_version, transport_number, expense_number, service_date, route, plate_normalized, transport_volume, net_value, driver_code)
       values ($1,$2,1,'ok','t',$3,$4,$5,'C1-SANTA MARTA - CARTAGENA',$6,$7,$8,$9) returning id`,
      [msg.rows[0]?.id, svc.rows[0]?.id, o.t, `G${o.t}`, o.date, o.plate, o.vol, o.value, o.driver],
    );
    await db.query('update services set current_authorization_id=$2 where id=$1', [svc.rows[0]?.id, au.rows[0]?.id]);
  }
  const rec = (code: number, plate: string, total: string, date: string, driver: string) =>
    silogRow({ cliente_nit: TERPEL_NIT, manifiesto: `M${code}`, remesa_codigo: code, fecha: date, conductor_documento: driver, placa: plate, ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'CARTAGENA', remesa_peso: 9983, total_remesa: total, remesa_tarifa: '235' });

  beforeAll(async () => {
    setLogSink(() => undefined);
    ctx = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'afs-')), DEMO_JWT_SECRET: 'demo-local', ENCRYPTION_KEY: 'a1'.repeat(32), APP_SESSION_SECRET: 'x'.repeat(40), SILOG_SOURCE: 'none' });
    tok = ((await call('POST', '/api/auth/demo-login', undefined, { email: 'facturacion@demo.local', password: 'demo' })).json as { token: string }).token;
    // Caso real: la remesa 101229386 es de KNL061 (6008613622); 6008613621 (KUS142) no tiene registro propio y su valor coincide con el total del registro.
    await seed({ t: '6008613621', date: '2026-11-19', driver: '1084727163', plate: 'KUS142', vol: 9982, value: 2345770 });
    await seed({ t: '6008613622', date: '2026-11-19', driver: '1084727163', plate: 'KNL061', vol: 9983, value: 2346005 });
    // Empate real: dos servicios, misma placa, mismo conductor, un único registro.
    await seed({ t: 'T-D1', date: '2026-11-21', driver: '2222', plate: 'AAA111', vol: 5000, value: 1000 });
    await seed({ t: 'T-D2', date: '2026-11-21', driver: '2222', plate: 'AAA111', vol: 5000, value: 1000 });
    // Coincidencia débil: placa distinta y valor distinto.
    await seed({ t: 'T-W', date: '2026-11-22', driver: '3333', plate: 'WWW333', vol: 4000, value: 500 });
    // Servicio normal.
    await seed({ t: 'T-OK', date: '2026-11-23', driver: '4444', plate: 'OKA444', vol: 4000, value: 800 });
    ctx.silog = new MockSilogtranSource([
      rec(101229386, 'KNL061', '2345770', '2026-11-19', '1084727163'),
      rec(7001, 'AAA111', '1000', '2026-11-21', '2222'),
      rec(7002, 'OTR999', '777', '2026-11-22', '3333'),
      rec(7003, 'OKA444', '800', '2026-11-23', '4444'),
    ]);
    const c = await call('POST', '/api/reconciliations', tok, { dateFrom: '2026-11-19', dateTo: '2026-11-25' });
    const id = (c.json as { id: string }).id;
    for (let i = 0; i < 30; i += 1) if ((await call('POST', `/api/reconciliations/${id}/step`, tok)).json && ((await call('GET', `/api/reconciliations/${id}`, tok)).json as { run: { status: string } }).run.status === 'completed') break;
  });
  afterAll(async () => ctx.db.close());

  const result = async (t: string) => (await ctx.db.query<{ status: string; chosen_record_id: string | null; reason: string; reason_code: string | null }>(`select status, chosen_record_id, reason, reason_code from reconciliation_results where transport_number = $1`, [t])).rows[0];

  it('el caso real: la remesa queda con el servicio de la placa y el otro pasa a NO_MATCH con motivo', async () => {
    const win = await result('6008613622');
    const lose = await result('6008613621');
    expect(win?.status).not.toBe('NO_MATCH');
    expect(win?.chosen_record_id).toBeTruthy();
    expect(lose).toMatchObject({ status: 'NO_MATCH', chosen_record_id: null, reason_code: 'RECORD_TAKEN' });
    expect(lose?.reason).toMatch(/ya corresponde a otro servicio de Terpel/);
    expect(lose?.reason).toMatch(/6008613622/);
  });

  it('ningún registro queda elegido por dos servicios', async () => {
    const dup = await ctx.db.query(`select chosen_record_id from reconciliation_results where chosen_record_id is not null and status in ('EXACT','MATCH_WITH_DIFFERENCES') group by 1 having count(*) > 1`);
    expect(dup.rows).toHaveLength(0);
  });

  it('empate real: todos los empatados quedan AMBIGUOUS', async () => {
    expect((await result('T-D1'))?.status).toBe('AMBIGUOUS');
    expect((await result('T-D2'))?.status).toBe('AMBIGUOUS');
  });

  it('coincidencia débil (placa ignorada, valor distinto) queda para revisión; la normal sigue elegible', async () => {
    expect(await result('T-W')).toMatchObject({ status: 'AMBIGUOUS', reason_code: 'WEAK_PLATE_IGNORED', chosen_record_id: null });
    expect((await result('T-OK'))?.status).toBe('EXACT');
  });

  it('versión de reglas recon-1.4.0', async () => {
    const r = await ctx.db.query<{ rules_version: string }>(`select distinct rules_version from reconciliation_results`);
    expect(r.rows.map((x) => x.rules_version)).toEqual(['recon-1.4.0']);
  });
});
