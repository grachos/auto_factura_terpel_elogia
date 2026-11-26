import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import type { Db } from '../core/db/types.js';
import { handleRequest } from '../core/http/router.js';
import { RECON_COLUMNS, compareReconWorkbook } from '../core/recon/excel.js';
import { compareRecord, reconcile } from '../core/recon/engine.js';
import type { EngineParams, FilterConfig, SilogCandidate, TerpelInput } from '../core/recon/engine.js';
import {
  addDays, daysBetween, normalizeDocument, normalizePlace, normalizePlate, parseTerpelRoute, toNumber,
} from '../core/recon/normalize.js';
import { MockSilogtranSource, SilogtranApiSource, SilogtranError, dedupeAndFilter } from '../core/recon/silogtran.js';
import { createReconRun, getReconDetail, listResults, loadFilters, stepReconRun, syncChunk } from '../core/recon/service.js';
import type { ReconDeps } from '../core/recon/service.js';
import { generateReconExport } from '../core/recon/excel.js';
import type { ReconResultDto } from '../core/types.js';
import { TERPEL_NIT, repeated, silogRow } from '../fixtures/silogtran.js';
import { MemoryStorage, newDb } from './helpers.js';

// ---- Normalizadores -----------------------------------------------------------------------------
describe('normalizadores', () => {
  it('cédula sin ceros a la izquierda ni símbolos', () => {
    expect(normalizeDocument('0012345678')).toBe('12345678');
    expect(normalizeDocument('12.345.678')).toBe('12345678');
    expect(normalizeDocument('D-0001')).toBe('1');
    expect(normalizeDocument('000')).toBeNull();
    expect(normalizeDocument(null)).toBeNull();
  });
  it('placa y lugares', () => {
    expect(normalizePlate(' abc-123 ')).toBe('ABC123');
    expect(normalizePlace('  Cúcuta  ')).toBe('CUCUTA');
    expect(normalizePlace('Puerto   Berrío')).toBe('PUERTO BERRIO');
    expect(normalizePlace('')).toBeNull();
  });
  it('parser de ruta de Terpel', () => {
    expect(parseTerpelRoute('C40434-SANTA MARTA - BARRANCABERMEJA')).toEqual({ code: 'C40434', origin: 'SANTA MARTA', destination: 'BARRANCABERMEJA' });
    expect(parseTerpelRoute('Ficticia Norte - Ficticia Sur')).toEqual({ code: null, origin: 'FICTICIA NORTE', destination: 'FICTICIA SUR' });
    expect(parseTerpelRoute('C1-BOGOTA-MEDELLIN')).toEqual({ code: 'C1', origin: 'BOGOTA', destination: 'MEDELLIN' });
    expect(parseTerpelRoute('SOLO UN LUGAR')).toBeNull();
    expect(parseTerpelRoute('')).toBeNull();
    expect(parseTerpelRoute(null)).toBeNull();
  });
  it('números y fechas', () => {
    expect(toNumber('10460')).toBe(10460);
    expect(toNumber('1234.56')).toBe(1234.56);
    expect(toNumber(null)).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(daysBetween('2026-11-17', '2026-11-20')).toBe(3);
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });
});

// ---- Motor ---------------------------------------------------------------------------------------
const FILTERS: FilterConfig[] = [
  { key: 'driver', position: 1, active: true, mode: 'exclusive' },
  { key: 'plate', position: 2, active: true, mode: 'preferred' },
  { key: 'route', position: 3, active: true, mode: 'exclusive' },
  { key: 'date', position: 4, active: true, mode: 'exclusive' },
];
const params = (over: Partial<EngineParams> = {}): EngineParams => ({
  filters: FILTERS, windowDays: 10, aliases: new Map([['LIZAMA', 'BARRANCABERMEJA']]), ...over,
});
const terpel = (o: Partial<TerpelInput> = {}): TerpelInput => ({
  driverCode: '0000000099', route: 'C1-SANTA MARTA - BARRANCABERMEJA', serviceDate: '2026-11-20', plateNormalized: 'AAA111',
  transportVolume: '10075', netValue: '4312100', ...o,
});
let cid = 0;
const cand = (o: Partial<SilogCandidate> = {}): SilogCandidate => {
  cid += 1;
  return {
    id: `c${cid}`, dispatchDate: '2026-11-18', plateNormalized: 'AAA111', driverDocument: '99', originCity: 'SANTA MARTA',
    destinationCity: 'LIZAMA', remesaWeight: '10075', totalRemesa: '4312100', ...o,
  };
};

describe('motor de cascada', () => {
  it('EXACT con alias de lugar y traza', () => {
    const r = reconcile(terpel(), [cand(), cand({ driverDocument: '5' })], params());
    expect(r.status).toBe('EXACT');
    expect(r.trace.map((t) => [t.filter, t.before, t.after])).toEqual([['driver', 2, 1], ['plate', 1, 1], ['route', 1, 1], ['date', 1, 1]]);
  });
  it('diferencias ajustables de volumen y valor; placa solo informativa', () => {
    const c = cand({ remesaWeight: '10000', totalRemesa: '4000000', plateNormalized: 'BBB222' });
    const r = reconcile(terpel(), [c], params());
    expect(r.status).toBe('MATCH_WITH_DIFFERENCES');
    expect(r.differences.map((d) => [d.field, d.severity])).toEqual([['volume', 'adjustable'], ['value', 'adjustable'], ['plate', 'info']]);
    // placa preferente: se ignora (no excluye) y queda como diferencia informativa
    expect(r.trace[1]).toMatchObject({ filter: 'plate', skipped: true, reason: 'would_empty' });
  });
  it('solo placa distinta => EXACT', () => {
    const r = reconcile(terpel(), [cand({ plateNormalized: 'ZZZ999' })], params());
    expect(r.status).toBe('EXACT');
    expect(r.differences.some((d) => d.field === 'plate' && d.severity === 'info')).toBe(true);
  });
  it('volumen 0 no se compara', () => {
    const r = reconcile(terpel({ transportVolume: '0' }), [cand({ remesaWeight: '777' })], params({ zeroVolumeMode: 'reconcile_always' }));
    expect(r.status).toBe('EXACT');
    expect(compareRecord(terpel({ transportVolume: 0 }), cand({ remesaWeight: 5 }))).toEqual([]);
  });
  it('varios candidatos con fechas distintas: elige el despacho más cercano a la fecha de Terpel', () => {
    const r = reconcile(terpel(), [cand({ id: 'lejos' }), cand({ id: 'cerca', dispatchDate: '2026-11-19' }), cand({ id: 'mas-lejos', dispatchDate: '2026-11-13' })], params());
    expect(r.status).toBe('EXACT');
    expect(r.chosenId).toBe('cerca');
    expect(r.reason).toContain('más cercano');
    expect(r.trace.at(-1)).toMatchObject({ filter: 'date', before: 3, after: 1, reason: 'closest_date' });
  });
  it('placa preferente que lleva a NO_MATCH se omite y reencuentra el registro con otra placa', () => {
    const viejo = cand({ id: 'viejo', dispatchDate: '2026-10-29' }); // misma placa, ruta, pero fuera de ventana
    const bueno = cand({ id: 'bueno', dispatchDate: '2026-11-18', plateNormalized: 'ZZZ999' });
    const r = reconcile(terpel(), [viejo, bueno], params());
    expect(r.chosenId).toBe('bueno');
    expect(r.differences.some((d) => d.field === 'plate')).toBe(true);
    expect(r.trace.find((s) => s.filter === 'plate')).toMatchObject({ skipped: true, reason: 'fallback' });
  });
  it('AMBIGUOUS con dos viajes del mismo conductor y ruta en la misma fecha (nunca elige)', () => {
    const r = reconcile(terpel(), [cand({ dispatchDate: '2026-11-19' }), cand({ dispatchDate: '2026-11-19' })], params());
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.chosenId).toBeNull();
    expect(r.candidateIds).toHaveLength(2);
    const manual = reconcile(terpel(), [cand({ id: 'x1', dispatchDate: '2026-11-19' }), cand({ id: 'x2', dispatchDate: '2026-11-19' })], params(), 'x2');
    expect(manual.chosenId).toBe('x2');
    expect(manual.status).toBe('EXACT');
  });
  it('filtro excluyente deja 0 => NO_MATCH; ventana de fechas', () => {
    expect(reconcile(terpel(), [cand({ driverDocument: '7' })], params()).status).toBe('NO_MATCH');
    expect(reconcile(terpel(), [cand({ dispatchDate: '2026-11-21' })], params()).status).toBe('NO_MATCH'); // despacho posterior al descargue
    expect(reconcile(terpel(), [cand({ dispatchDate: '2026-11-10' })], params()).status).toBe('EXACT'); // 10 días
    expect(reconcile(terpel(), [cand({ dispatchDate: '2026-11-09' })], params()).status).toBe('NO_MATCH'); // 11 días
    expect(reconcile(terpel(), [cand({ dispatchDate: '2026-11-09' })], params({ windowDays: 12 })).status).toBe('EXACT');
    expect(reconcile(terpel(), [], params()).status).toBe('NO_MATCH');
  });
  it('sin alias la ruta no coincide', () => {
    expect(reconcile(terpel(), [cand()], params({ aliases: new Map() })).status).toBe('NO_MATCH');
  });
  it('INSUFFICIENT_DATA sin cédula, ruta o fecha', () => {
    expect(reconcile(terpel({ driverCode: null }), [cand()], params()).status).toBe('INSUFFICIENT_DATA');
    expect(reconcile(terpel({ route: 'sin formato' }), [cand()], params()).status).toBe('INSUFFICIENT_DATA');
    expect(reconcile(terpel({ serviceDate: null }), [cand()], params()).status).toBe('INSUFFICIENT_DATA');
  });
  it('orden, activación y modo de los filtros', () => {
    // placa excluyente: ahora una placa distinta da NO_MATCH
    const strict = FILTERS.map((f) => (f.key === 'plate' ? { ...f, mode: 'exclusive' as const } : f));
    expect(reconcile(terpel(), [cand({ plateNormalized: 'ZZZ' })], params({ filters: strict })).status).toBe('NO_MATCH');
    // placa inactiva: queda registrada como omitida
    const off = FILTERS.map((f) => (f.key === 'plate' ? { ...f, active: false } : f));
    const r = reconcile(terpel(), [cand({ plateNormalized: 'ZZZ' })], params({ filters: off }));
    expect(r.trace.find((t) => t.filter === 'plate')).toMatchObject({ skipped: true, reason: 'inactive' });
    // reordenar: fecha primero
    const reordered = [{ ...FILTERS[3] as FilterConfig, position: 0 }, ...FILTERS.slice(0, 3)];
    const r2 = reconcile(terpel(), [cand(), cand({ dispatchDate: '2026-11-25' })], params({ filters: reordered }));
    expect(r2.trace[0]).toMatchObject({ filter: 'date', before: 2, after: 1 });
    // ruta inactiva ya no exige ruta en Terpel
    const noRoute = FILTERS.map((f) => (f.key === 'route' ? { ...f, active: false } : f));
    expect(reconcile(terpel({ route: null }), [cand()], params({ filters: noRoute })).status).toBe('EXACT');
  });
});

// ---- Fuente Silogtran ------------------------------------------------------------------------------
describe('fuente Silogtran', () => {
  it('deduplica filas repetidas, descarta por NIT y conserva ANULADO como estado', () => {
    const base = silogRow({ manifiesto: 'M1', remesa_codigo: 1 });
    const rows = [
      ...repeated(base, 3),
      silogRow({ manifiesto: 'M2', remesa_codigo: 2, cliente_nit: '900123456' }),
      silogRow({ manifiesto: 'M3', remesa_codigo: 3, estado: 'ANULADO' }),
      { ...silogRow({ manifiesto: 'M4', remesa_codigo: 4 }), conductor_documento: '00045', remesa_peso: '10460', total_remesa: 2464445 },
    ];
    const { kept, total } = dedupeAndFilter(rows, TERPEL_NIT);
    expect(total).toBe(rows.length);
    expect(kept.map((k) => k.manifest).sort()).toEqual(['M1', 'M3', 'M4']);
    expect(kept.find((k) => k.manifest === 'M3')?.status).toBe('ANULADO');
    const m4 = kept.find((k) => k.manifest === 'M4');
    expect(m4).toMatchObject({ driver_document: '45', remesa_weight: 10460, total_remesa: 2464445 });
  });

  it('API: login, token crudo sin Bearer, re-login ante 401 y error claro sin credenciales', async () => {
    const seen: { url: string; auth: string | null; body: string | null }[] = [];
    let logins = 0;
    let reportCalls = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: headers.Authorization ?? null, body: typeof init.body === 'string' ? init.body : null });
      if (url.includes('Seguridad.login')) {
        logins += 1;
        return new Response(JSON.stringify({ success: true, data: { token: `tok${logins}` } }), { status: 200 });
      }
      reportCalls += 1;
      if (reportCalls === 1) return new Response('{"success":false}', { status: 401 });
      return new Response(JSON.stringify({ success: true, data: [{ manifiesto: 'M1' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const src = new SilogtranApiSource({ baseUrl: 'https://silog.example/api', user: 'u', password: 'p@ss', fetchFn });
    const rows = await src.fetchReport('2026-11-01', '2026-11-03');
    expect(rows).toHaveLength(1);
    expect(logins).toBe(2);
    const reports = seen.filter((s) => s.url.includes('InformeGeneral'));
    expect(reports[0]?.url).toContain('fecha_inicial=2026-11-01&fecha_final=2026-11-03');
    expect(reports.map((r) => r.auth)).toEqual(['tok1', 'tok2']);
    expect(seen.find((s) => s.url.includes('login'))?.body).toContain('usuario_login=u');
  });

  it('API: errores claros, sin filtrar credenciales', async () => {
    const bad = (async () => new Response('{"success":false,"msg":"x"}', { status: 200 })) as unknown as typeof fetch;
    const src = new SilogtranApiSource({ baseUrl: 'https://silog.example/api', user: 'usuario-secreto', password: 'clave-secreta', fetchFn: bad });
    const err = await src.fetchReport('2026-11-01', '2026-11-02').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SilogtranError);
    expect((err as SilogtranError).code).toBe('LOGIN_FAILED');
    expect((err as SilogtranError).message).not.toMatch(/clave-secreta|usuario-secreto/);
    const down = (async () => { throw new Error('ECONNRESET clave-secreta'); }) as unknown as typeof fetch;
    const e2 = await new SilogtranApiSource({ baseUrl: 'https://s.example', user: 'u', password: 'clave-secreta', fetchFn: down }).fetchReport('2026-11-01', '2026-11-02').catch((e: unknown) => e);
    expect((e2 as SilogtranError).code).toBe('NETWORK');
    expect((e2 as SilogtranError).message).not.toContain('clave-secreta');
    const always401 = (async (url: string) => (url.includes('login') ? new Response('{"success":true,"data":{"token":"t"}}') : new Response('', { status: 401 }))) as unknown as typeof fetch;
    const e3 = await new SilogtranApiSource({ baseUrl: 'https://s.example', user: 'u', password: 'p', fetchFn: always401 }).fetchReport('2026-11-01', '2026-11-02').catch((e: unknown) => e);
    expect((e3 as SilogtranError).code).toBe('LOGIN_FAILED');
  });
});

// ---- Servicio con BD (PGlite + migraciones reales) --------------------------------------------------
let seq = 0;
async function seedService(db: Db, o: { transport: string; date: string; driver: string | null; route: string | null; plate: string; volume: number | null; value: number | null }): Promise<string> {
  seq += 1;
  const msg = await db.query<{ id: string }>(
    `insert into source_messages (mailbox, graph_immutable_id, internet_message_id, received_at) values ('m@x', $1, $1, now()) returning id`,
    [`g${seq}-${o.transport}`],
  );
  const svc = await db.query<{ id: string }>(`insert into services (business_key, transport_number, version_count) values ($1,$1,1) returning id`, [o.transport]);
  const au = await db.query<{ id: string }>(
    `insert into authorizations (message_id, service_id, version, parse_status, parser_version, transport_number, service_date, route, plate_normalized,
        transport_volume, net_value, driver_code, driver_name)
     values ($1,$2,1,'ok','t',$3,$4,$5,$6,$7,$8,$9,'CONDUCTOR FICTICIO') returning id`,
    [msg.rows[0]?.id, svc.rows[0]?.id, o.transport, o.date, o.route, o.plate, o.volume, o.value, o.driver],
  );
  await db.query('update services set current_authorization_id=$2 where id=$1', [svc.rows[0]?.id, au.rows[0]?.id]);
  return svc.rows[0]?.id as string;
}

/** Reproduce con datos inventados los 6 casos reales (mismas formas). */
async function seedSixCases(db: Db): Promise<Record<string, unknown>[]> {
  const base = { cliente_nit: TERPEL_NIT };
  await seedService(db, { transport: 'T-A', date: '2026-11-17', driver: '0000000011', route: 'C1-SANTA MARTA - CARTAGENA', plate: 'AAA001', volume: 10487, value: 2464445 });
  await seedService(db, { transport: 'T-B', date: '2026-11-18', driver: '0000000012', route: 'C2-SANTA MARTA - LA PINTADA', plate: 'AAA002', volume: 10174, value: 6694492 });
  await seedService(db, { transport: 'T-C', date: '2026-11-23', driver: '0000000013', route: 'C2-SANTA MARTA - LA PINTADA', plate: 'AAA003', volume: 0, value: 6700414 });
  await seedService(db, { transport: 'T-D', date: '2026-11-20', driver: '0000000014', route: 'C3-SANTA MARTA - BARRANCABERMEJA', plate: 'AAA004', volume: 10075, value: 4312100 });
  await seedService(db, { transport: 'T-E', date: '2026-11-20', driver: '0000000015', route: 'C1-SANTA MARTA - CARTAGENA', plate: 'AAA005', volume: 9984, value: 2346240 });
  await seedService(db, { transport: 'T-F', date: '2026-11-21', driver: '0000000016', route: 'C3-SANTA MARTA - BARRANCABERMEJA', plate: 'AAA006', volume: 0, value: 4453353 });
  return [
    ...repeated(silogRow({ ...base, manifiesto: 'MA', remesa_codigo: 1, fecha: '2026-11-15', conductor_documento: '11', placa: 'AAA001', ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'CARTAGENA', remesa_peso: 10460, total_remesa: '2464445' }), 3),
    silogRow({ ...base, manifiesto: 'MB', remesa_codigo: 2, fecha: '2026-11-16', conductor_documento: '12', placa: 'AAA002', ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'LA PINTADA', remesa_peso: 10122, total_remesa: '6694492' }),
    silogRow({ ...base, manifiesto: 'MC', remesa_codigo: 3, fecha: '2026-11-20', conductor_documento: '13', placa: 'AAA003', ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'LA PINTADA', remesa_peso: 9000, total_remesa: '6700414' }),
    silogRow({ ...base, manifiesto: 'MD', remesa_codigo: 4, fecha: '2026-11-19', conductor_documento: '14', placa: 'AAA004', ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'LIZAMA', remesa_peso: 10075, total_remesa: '4312100' }),
    silogRow({ ...base, manifiesto: 'ME', remesa_codigo: 5, fecha: '2026-11-18', conductor_documento: '15', placa: 'AAA005', ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'CARTAGENA', remesa_peso: 9979, total_remesa: '2735616' }),
    silogRow({ ...base, manifiesto: 'MX', remesa_codigo: 6, fecha: '2026-11-19', conductor_documento: '99', placa: 'AAA009' }), // otro conductor: ruido
    silogRow({ ...base, manifiesto: 'MY', remesa_codigo: 7, fecha: '2026-11-19', conductor_documento: '14', placa: 'AAA004', ciudad_origen_remesa: 'SANTA MARTA', ciudad_destino_remesa: 'LIZAMA', estado: 'ANULADO' }),
  ];
}

async function runAll(deps: ReconDeps, runId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const r = await stepReconRun(deps, runId, 'tester', async (d, id, a) => void (await generateReconExport(d, id, a)));
    if (r.done) return;
    if (r.run.status === 'failed') throw new Error(`fallo ${r.run.errorCode}`);
  }
  throw new Error('no terminó');
}

const byTransport = (rs: ReconResultDto[], t: string): ReconResultDto => rs.find((r) => r.transportNumber === t) as ReconResultDto;

describe('conciliación (BD)', () => {
  let db: Db;
  let storage: MemoryStorage;
  let source: MockSilogtranSource;
  let deps: ReconDeps;
  beforeAll(async () => {
    db = await newDb();
    storage = new MemoryStorage();
    source = new MockSilogtranSource(await seedSixCases(db));
    deps = { db, storage, silog: source };
    await db.query(`update reconciliation_settings set zero_volume_mode = 'reconcile_always'`); // los 6 casos se calibraron con este modo
  });
  afterAll(async () => db.close());

  it('los 6 casos: sync por tramos, resultados, trazas y Excel que concuerda con la BD', async () => {
    const run = await createReconRun(deps, { actor: 'u1', dateFrom: '2026-11-17', dateTo: '2026-11-25' });
    expect(run.status).toBe('syncing');
    await runAll(deps, run.id);
    // lookback 15 días: 2026-11-02 .. 2026-11-25 en tramos de 7 días
    expect(source.calls.map((c) => c.from)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);

    const results = await listResults(db, run.id);
    expect(results).toHaveLength(6);
    const a = byTransport(results, 'T-A');
    expect(a.status).toBe('MATCH_WITH_DIFFERENCES');
    expect(a.differences.map((d) => d.field)).toEqual(['volume']);
    expect(a.differences[0]).toMatchObject({ terpel: 10487, silogtran: 10460, severity: 'adjustable' });
    expect(a.trace.map((t) => t.after)).toEqual([1, 1, 1, 1]); // filas repetidas ya deduplicadas
    expect(byTransport(results, 'T-B').differences.map((d) => d.field)).toEqual(['volume']);
    expect(byTransport(results, 'T-C').status).toBe('EXACT'); // volumen 0 no se compara
    const d = byTransport(results, 'T-D');
    expect(d.status).toBe('EXACT'); // alias Lizama = Barrancabermeja
    expect(d.silog?.manifest).toBe('MD');
    const e = byTransport(results, 'T-E');
    expect(e.differences.map((x) => [x.field, x.terpel, x.silogtran])).toEqual([['volume', 9984, 9979], ['value', 2346240, 2735616]]);
    const f = byTransport(results, 'T-F');
    expect(f.status).toBe('NO_MATCH');
    expect(f.reason).toMatch(/conductor/);

    const detail = await getReconDetail(db, run.id);
    expect(detail.run).toMatchObject({ status: 'completed', exact: 2, withDifferences: 3, noMatch: 1, totalServices: 6, exportStatus: 'ready' });

    const stored = await db.query<{ export_path: string }>('select export_path from reconciliation_runs where id=$1', [run.id]);
    const file = await storage.get(stored.rows[0]?.export_path as string);
    expect(await compareReconWorkbook(file, results)).toEqual([]);
    expect(RECON_COLUMNS.length).toBeGreaterThan(20);
  });

  it('idempotencia: sync repetido no duplica y reconciliar de nuevo da lo mismo', async () => {
    const before = await db.query<{ n: number }>('select count(*)::int as n from silogtran_records');
    await syncChunk(deps, '2026-11-02', '2026-11-08', null);
    await syncChunk(deps, '2026-11-09', '2026-11-25', null);
    expect((await db.query<{ n: number }>('select count(*)::int as n from silogtran_records')).rows[0]?.n).toBe(before.rows[0]?.n);
    const before2 = await listResults(db, (await db.query<{ id: string }>('select id from reconciliation_runs limit 1')).rows[0]?.id as string);
    const run2 = await createReconRun(deps, { actor: 'u1', dateFrom: '2026-11-17', dateTo: '2026-11-25', sync: false });
    await runAll(deps, run2.id);
    const after = await listResults(db, run2.id);
    expect(after.map((r) => [r.transportNumber, r.status])).toEqual(before2.map((r) => [r.transportNumber, r.status]));
    expect((await db.query<{ n: number }>('select count(*)::int as n from reconciliation_results')).rows[0]?.n).toBe(6);
  });

  it('solo una conciliación activa a la vez', async () => {
    const r1 = await createReconRun(deps, { actor: 'u1', dateFrom: '2026-11-17', dateTo: '2026-11-18', sync: false });
    await expect(createReconRun(deps, { actor: 'u1', dateFrom: '2026-11-17', dateTo: '2026-11-18', sync: false })).rejects.toMatchObject({ code: 'ACTIVE_RUN_EXISTS' });
    await runAll(deps, r1.id);
  });

  it('error de Silogtran: reintentable, sin perder progreso', async () => {
    const r = await createReconRun(deps, { actor: 'u1', dateFrom: '2026-11-17', dateTo: '2026-11-18' });
    source.failNext = 1;
    const s1 = await stepReconRun(deps, r.id, 'u1', async () => undefined);
    expect(s1.message).toMatch(/no respondió/);
    expect(s1.run.status).toBe('syncing');
    await runAll(deps, r.id);
    expect((await getReconDetail(db, r.id)).run.status).toBe('completed');
  });

  it('sin Silogtran configurado el error es claro', async () => {
    await expect(createReconRun({ db, storage, silog: null }, { actor: 'u', dateFrom: '2026-11-01', dateTo: '2026-11-02' })).rejects.toMatchObject({ code: 'SILOG_NOT_CONFIGURED' });
  });

  it('filtros por defecto sembrados', async () => {
    expect((await loadFilters(db)).map((f) => [f.key, f.mode])).toEqual([['driver', 'exclusive'], ['plate', 'preferred'], ['route', 'exclusive'], ['date', 'exclusive']]);
  });
});

// ---- API: roles, auditoría, resolución manual y alias -----------------------------------------------
describe('API de conciliación', () => {
  let ctx: AppContext;
  let tokens: Record<string, string>;
  const call = (method: string, path: string, token?: string, body?: unknown, query: Record<string, string> = {}) =>
    handleRequest(ctx, { method, path, query, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  const json = <T>(r: { json?: unknown }): T => r.json as T;

  beforeAll(async () => {
    ctx = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'af2-')), DEMO_JWT_SECRET: 's-local', SILOG_SOURCE: 'none' });
    tokens = {};
    for (const [k, e] of [['op', 'operador@demo.local'], ['admin', 'admin@demo.local'], ['viewer', 'lector@demo.local'], ['fact', 'facturacion@demo.local']] as const) {
      const r = await call('POST', '/api/auth/demo-login', undefined, { email: e, password: 'demo' });
      tokens[k] = (json<{ token: string }>(r)).token;
    }
    ctx.silog = new MockSilogtranSource(await seedAmbiguous(ctx.db));
  });
  afterAll(async () => ctx.db.close());

  async function seedAmbiguous(db: Db): Promise<Record<string, unknown>[]> {
    await seedService(db, { transport: 'T-AMB', date: '2026-11-20', driver: '0000000021', route: 'C1-BUCARAMANGA - CUCUTA', plate: 'BBB001', volume: 5000, value: 100 });
    await seedService(db, { transport: 'T-ALI', date: '2026-11-20', driver: '0000000022', route: 'C1-BUCARAMANGA - CUCUTA', plate: 'BBB002', volume: 5000, value: 100 });
    const b = { cliente_nit: TERPEL_NIT, ciudad_origen_remesa: 'BUCARAMANGA', ciudad_destino_remesa: 'CUCUTA', remesa_peso: 5000, total_remesa: '100' };
    return [
      silogRow({ ...b, manifiesto: 'N1', remesa_codigo: 1, fecha: '2026-11-19', conductor_documento: '21', placa: 'BBB001' }),
      silogRow({ ...b, manifiesto: 'N2', remesa_codigo: 2, fecha: '2026-11-19', conductor_documento: '21', placa: 'BBB001' }),
      silogRow({ ...b, manifiesto: 'N3', remesa_codigo: 3, fecha: '2026-11-19', conductor_documento: '22', placa: 'BBB002', ciudad_destino_remesa: 'VILLA NUEVA DEL ROSARIO' }),
    ];
  }

  async function runViaApi(): Promise<string> {
    const c = await call('POST', '/api/reconciliations', tokens.op, { dateFrom: '2026-11-19', dateTo: '2026-11-21' });
    expect(c.status).toBe(201);
    const id = json<{ id: string }>(c).id;
    for (let i = 0; i < 50; i += 1) {
      const s = await call('POST', `/api/reconciliations/${id}/step`, tokens.op);
      expect(s.status).toBe(200);
      if (json<{ done: boolean }>(s).done) break;
    }
    return id;
  }

  it('sin sesión 401; lector no concilia; operador no edita parámetros', async () => {
    expect((await call('GET', '/api/reconciliations')).status).toBe(401);
    expect((await call('POST', '/api/reconciliations', tokens.viewer, { dateFrom: '2026-11-19', dateTo: '2026-11-21' })).status).toBe(403);
    expect((await call('GET', '/api/recon-params', tokens.viewer)).status).toBe(403); // ver parámetros: solo admin y facturación
    expect((await call('GET', '/api/recon-params', tokens.op)).status).toBe(403);
    expect((await call('GET', '/api/recon-params', tokens.fact)).status).toBe(200);
    expect((await call('PUT', '/api/recon-settings', tokens.fact, { windowDays: 5, lookbackDays: 5, terpelNit: '830095213' })).status).toBe(403);
    for (const [m, p, b] of [
      ['PUT', '/api/match-filters', { filters: [] }], ['PUT', '/api/recon-settings', { windowDays: 5, lookbackDays: 5, terpelNit: '830095213' }],
      ['POST', '/api/place-aliases', { silogName: 'A', terpelName: 'B' }], ['DELETE', '/api/place-aliases/00000000-0000-4000-8000-000000000001', undefined],
    ] as const) {
      expect((await call(m, p, tokens.op, b)).status, `${m} ${p}`).toBe(403);
    }
    expect((await call('POST', '/api/reconciliations', tokens.admin, { dateFrom: '2026-13-01', dateTo: '2026-11-21' })).status).toBe(400);
  });

  it('AMBIGUOUS -> elección manual auditada; NO_MATCH por ruta -> agregar equivalencia re-concilia', async () => {
    const id = await runViaApi();
    const list = json<{ results: ReconResultDto[] }>(await call('GET', `/api/reconciliations/${id}/results`, tokens.viewer)).results;
    const amb = byTransport(list, 'T-AMB');
    expect(amb.status).toBe('AMBIGUOUS');
    expect(amb.candidates).toHaveLength(2);
    expect(amb.silog).toBeNull();
    const ali = byTransport(list, 'T-ALI');
    expect(ali.status).toBe('NO_MATCH');
    expect(ali.trace.find((t) => t.after === 0)?.filter).toBe('route');
    const filtered = json<{ results: ReconResultDto[] }>(await call('GET', `/api/reconciliations/${id}/results`, tokens.viewer, undefined, { status: 'AMBIGUOUS' })).results;
    expect(filtered.map((r) => r.transportNumber)).toEqual(['T-AMB']);

    // un registro que no es candidato se rechaza
    const bad = await call('POST', `/api/reconciliation-results/${amb.id}/resolve`, tokens.op, { recordId: ali.id });
    expect(bad.status).toBe(400);
    expect((await call('POST', `/api/reconciliation-results/${amb.id}/resolve`, tokens.viewer, { recordId: amb.candidates[0]?.id })).status).toBe(403);
    const pick = amb.candidates.find((c) => c.manifest === 'N2') as { id: string };
    const res = await call('POST', `/api/reconciliation-results/${amb.id}/resolve`, tokens.op, { recordId: pick.id });
    expect(res.status).toBe(200);
    const resolved = json<ReconResultDto>(res);
    expect(resolved).toMatchObject({ status: 'EXACT', manual: true });
    expect(resolved.silog?.manifest).toBe('N2');
    expect(resolved.resolvedBy).toBeTruthy();

    // operador no agrega equivalencias; admin sí
    expect((await call('POST', `/api/reconciliation-results/${ali.id}/alias`, tokens.op, { silogName: 'Villa Nueva del Rosario', terpelName: 'Cúcuta' })).status).toBe(403);
    const al = await call('POST', `/api/reconciliation-results/${ali.id}/alias`, tokens.admin, { silogName: 'Villa Nueva del Rosario', terpelName: 'Cúcuta' });
    expect(al.status).toBe(200);
    expect(json<ReconResultDto>(al)).toMatchObject({ status: 'EXACT' });

    // la resolución manual se conserva al reconciliar de nuevo
    const id2 = await runViaApi();
    const again = byTransport(json<{ results: ReconResultDto[] }>(await call('GET', `/api/reconciliations/${id2}/results`, tokens.viewer)).results, 'T-AMB');
    expect(again).toMatchObject({ status: 'EXACT', manual: true });

    const audits = await ctx.db.query<{ action: string }>(`select action from audit_log where action like 'reconciliation.%' or action like 'place_alias.%'`);
    const actions = audits.rows.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['reconciliation.create', 'reconciliation.resolve', 'place_alias.upsert', 'reconciliation.reconcile_one']));
  });

  it('admin edita filtros, alias y ajustes (con auditoría) y se aplican', async () => {
    const p = json<{ filters: { key: string; position: number; active: boolean; mode: string }[]; aliases: { id: string; silogName: string }[] }>(await call('GET', '/api/recon-params', tokens.admin));
    expect(p.aliases.map((a) => a.silogName)).toEqual(expect.arrayContaining(['Lizama', 'Chimitá']));
    const changed = p.filters.map((f) => (f.key === 'plate' ? { ...f, mode: 'exclusive' } : f));
    const put = await call('PUT', '/api/match-filters', tokens.admin, { filters: changed });
    expect(put.status).toBe(200);
    expect(json<{ filters: { key: string; mode: string }[] }>(put).filters.find((f) => f.key === 'plate')?.mode).toBe('exclusive');
    expect((await call('PUT', '/api/match-filters', tokens.admin, { filters: [{ key: 'driver', position: 1, active: true, mode: 'exclusive' }] })).status).toBe(400);
    expect((await call('PUT', '/api/recon-settings', tokens.admin, { windowDays: 'x', lookbackDays: 5, terpelNit: '830095213' })).status).toBe(400);
    const st = await call('PUT', '/api/recon-settings', tokens.admin, { windowDays: 6, lookbackDays: 20, terpelNit: '830.095.213' });
    expect(json<{ windowDays: number; terpelNit: string; zeroVolumeMode: string }>(st)).toMatchObject({ windowDays: 6, terpelNit: '830095213', zeroVolumeMode: 'ignore' });
    expect((await call('PUT', '/api/recon-settings', tokens.admin, { windowDays: 6, lookbackDays: 20, terpelNit: '830095213', zeroVolumeMode: 'otro' })).status).toBe(400);
    expect((await call('PUT', '/api/recon-settings', tokens.op, { windowDays: 6, lookbackDays: 20, terpelNit: '830095213', zeroVolumeMode: 'reconcile_always' })).status).toBe(403);
    const zm = await call('PUT', '/api/recon-settings', tokens.admin, { windowDays: 6, lookbackDays: 20, terpelNit: '830095213', zeroVolumeMode: 'reconcile_always' });
    expect(json<{ zeroVolumeMode: string }>(zm).zeroVolumeMode).toBe('reconcile_always');
    await call('PUT', '/api/recon-settings', tokens.admin, { windowDays: 6, lookbackDays: 20, terpelNit: '830095213', zeroVolumeMode: 'ignore' });
    const zaud = await ctx.db.query<{ data: { zeroVolumeMode?: string } }>(`select data from audit_log where action='recon_settings.update'`);
    expect(zaud.rows.some((a) => a.data.zeroVolumeMode === 'reconcile_always')).toBe(true);
    const created = json<{ id: string }>(await call('POST', '/api/place-aliases', tokens.admin, { silogName: 'Sitio Uno', terpelName: 'Sitio Dos' }));
    expect((await call('POST', '/api/place-aliases', tokens.admin, { silogName: 'sitio  uno', terpelName: 'Otro' })).status).toBe(201); // upsert por nombre normalizado
    expect((await call('DELETE', `/api/place-aliases/${created.id}`, tokens.admin)).status).toBe(200);
    expect((await call('DELETE', `/api/place-aliases/${created.id}`, tokens.admin)).status).toBe(404);
    const acts = (await ctx.db.query<{ action: string }>(`select action from audit_log where action in ('match_filters.update','recon_settings.update','place_alias.delete')`)).rows.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['match_filters.update', 'recon_settings.update', 'place_alias.delete']));
  });

  it('Excel descargable por URL firmada y sync manual por tramos', async () => {
    const id = (await ctx.db.query<{ id: string }>(`select id from reconciliation_runs where status='completed' order by created_at desc limit 1`)).rows[0]?.id as string;
    const url = await call('GET', `/api/reconciliations/${id}/export/url`, tokens.viewer);
    expect(url.status).toBe(200);
    const sync = await call('POST', '/api/silogtran/sync', tokens.op, { dateFrom: '2026-11-01', dateTo: '2026-11-20' });
    expect(sync.status).toBe(200);
    expect(json<{ nextCursor: string | null }>(sync).nextCursor).toBe('2026-11-08');
    expect((await call('POST', '/api/silogtran/sync', tokens.viewer, { dateFrom: '2026-11-01', dateTo: '2026-11-20' })).status).toBe(403);
  });

  it('config pública indica la fuente de Silogtran y nunca expone credenciales', async () => {
    const c = json<Record<string, unknown>>(await call('GET', '/api/config'));
    expect(c.silogSource).toBe('mock');
    expect(JSON.stringify(c)).not.toMatch(/SILOG_|password/i);
    const none = await createContext({ AUTH_MODE: 'demo', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'af3-')), DEMO_JWT_SECRET: 's', SILOG_SOURCE: 'none' });
    expect(none.silog).toBeNull();
    await none.db.close();
  });
});

// ---- Solo CUMPLIDO y volumen 0 parametrizable ------------------------------------------------------------
describe('volumen 0 de Terpel (3 modos x valor coincide / no coincide / volumen > 0)', () => {
  const zero = (o: Partial<TerpelInput> = {}) => terpel({ transportVolume: '0', ...o });
  const run = (t: TerpelInput, c: SilogCandidate, mode: 'ignore' | 'reconcile_if_value_matches' | 'reconcile_always') =>
    reconcile(t, [c], params({ zeroVolumeMode: mode }));

  it('ignore (defecto): volumen 0 => INSUFFICIENT_DATA ZERO_VOLUME_IGNORED, sin ajuste, aunque el valor coincida', () => {
    for (const c of [cand(), cand({ totalRemesa: '1' })]) {
      const r = run(zero(), c, 'ignore');
      expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', reasonCode: 'ZERO_VOLUME_IGNORED', reason: 'Volumen 0: se espera corrección de Terpel', chosenId: null, weightSource: null, differences: [] });
    }
    expect(reconcile(zero(), [cand()], params()).reasonCode).toBe('ZERO_VOLUME_IGNORED'); // sin parámetro = ignore
    const gt = run(terpel(), cand(), 'ignore');
    expect(gt).toMatchObject({ status: 'EXACT', weightSource: 'terpel', reasonCode: null });
  });

  it('reconcile_if_value_matches', () => {
    expect(run(zero(), cand(), 'reconcile_if_value_matches')).toMatchObject({ status: 'EXACT', weightSource: 'silogtran' });
    const bad = run(zero(), cand({ totalRemesa: '4312101' }), 'reconcile_if_value_matches');
    expect(bad).toMatchObject({ status: 'INSUFFICIENT_DATA', reasonCode: 'ZERO_VOLUME_VALUE_MISMATCH', chosenId: null, weightSource: null });
    expect(bad.differences.every((d) => d.severity !== 'adjustable')).toBe(true);
    expect(run(terpel(), cand({ totalRemesa: '4312101' }), 'reconcile_if_value_matches')).toMatchObject({ status: 'MATCH_WITH_DIFFERENCES', weightSource: 'terpel' });
    expect(run(terpel(), cand(), 'reconcile_if_value_matches')).toMatchObject({ status: 'EXACT', weightSource: 'terpel' });
  });

  it('reconcile_always', () => {
    expect(run(zero(), cand({ remesaWeight: '1' }), 'reconcile_always')).toMatchObject({ status: 'EXACT', weightSource: 'silogtran' });
    const diff = run(zero(), cand({ totalRemesa: '4312101' }), 'reconcile_always');
    expect(diff).toMatchObject({ status: 'MATCH_WITH_DIFFERENCES', weightSource: 'silogtran' });
    expect(diff.differences.map((d) => d.field)).toEqual(['value']);
    expect(run(terpel(), cand({ totalRemesa: '4312101', remesaWeight: '1' }), 'reconcile_always').differences.map((d) => d.field)).toEqual(['volume', 'value']);
  });
});

describe('solo registros CUMPLIDO', () => {
  it('sync: ACTIVO/ANULADO no entran al snapshot; un registro guardado que pasa a ANULADO deja de ser candidato (sin borrarse)', async () => {
    const db = await newDb();
    await seedService(db, { transport: 'T-X', date: '2026-11-20', driver: '0000000031', route: 'C1-AAA - BBB', plate: 'CCC001', volume: 100, value: 500 });
    const row = { cliente_nit: TERPEL_NIT, ciudad_origen_remesa: 'AAA', ciudad_destino_remesa: 'BBB', conductor_documento: '31', placa: 'CCC001', remesa_peso: 100, total_remesa: '500', fecha: '2026-11-19' };
    const rows = [
      silogRow({ ...row, manifiesto: 'X1', remesa_codigo: 1, estado: 'ACTIVO' }),
      silogRow({ ...row, manifiesto: 'X2', remesa_codigo: 2, estado: 'ANULADO' }),
      silogRow({ ...row, manifiesto: 'X3', remesa_codigo: 3, estado: 'CUMPLIDO' }),
    ];
    const src = new MockSilogtranSource(rows);
    const deps2: ReconDeps = { db, storage: new MemoryStorage(), silog: src };
    await syncChunk(deps2, '2026-11-19', '2026-11-19', null);
    expect((await db.query<{ manifest: string }>('select manifest from silogtran_records order by manifest')).rows.map((r) => r.manifest)).toEqual(['X3']);
    const r1 = await createReconRun(deps2, { actor: 'u', dateFrom: '2026-11-20', dateTo: '2026-11-20', sync: false });
    await runAll(deps2, r1.id);
    expect((await listResults(db, r1.id))[0]).toMatchObject({ status: 'EXACT' });
    // el mismo registro ahora ANULADO en Silogtran: se actualiza el estado, no se borra, y deja de ser candidato
    rows[2] = { ...(rows[2] as Record<string, unknown>), estado: 'ANULADO' };
    await syncChunk({ ...deps2, silog: new MockSilogtranSource(rows) }, '2026-11-19', '2026-11-19', null);
    expect((await db.query<{ status: string }>(`select status from silogtran_records where manifest='X3'`)).rows[0]?.status).toBe('ANULADO');
    // una fila guardada con otro estado se ignora al conciliar aunque exista en la tabla
    await db.query(`insert into silogtran_records (manifest, remesa_code, dispatch_date, client_nit, status) values ('Z','9','2026-11-19','${TERPEL_NIT}','ACTIVO')`);
    const r2 = await createReconRun(deps2, { actor: 'u', dateFrom: '2026-11-20', dateTo: '2026-11-20', sync: false });
    await runAll(deps2, r2.id);
    expect((await listResults(db, r2.id))[0]).toMatchObject({ status: 'NO_MATCH' });
    await db.close();
  });

  it('servicio con volumen 0 en BD: modo por defecto ignore, y el modo se persiste con motivo y origen del peso', async () => {
    const db = await newDb();
    await seedService(db, { transport: 'T-Z', date: '2026-11-20', driver: '0000000041', route: 'C1-AAA - BBB', plate: 'DDD001', volume: 0, value: 500 });
    const rows = [silogRow({ cliente_nit: TERPEL_NIT, manifiesto: 'Z1', remesa_codigo: 1, fecha: '2026-11-19', ciudad_origen_remesa: 'AAA', ciudad_destino_remesa: 'BBB', conductor_documento: '41', placa: 'DDD001', total_remesa: '500', remesa_peso: 77 })];
    const d: ReconDeps = { db, storage: new MemoryStorage(), silog: new MockSilogtranSource(rows) };
    const go = async (): Promise<ReconResultDto> => {
      const r = await createReconRun(d, { actor: 'u', dateFrom: '2026-11-20', dateTo: '2026-11-20' });
      await runAll(d, r.id);
      return (await listResults(db, r.id))[0] as ReconResultDto;
    };
    expect(await go()).toMatchObject({ status: 'INSUFFICIENT_DATA', reasonCode: 'ZERO_VOLUME_IGNORED', weightSource: null });
    await db.query(`update reconciliation_settings set zero_volume_mode='reconcile_if_value_matches'`);
    expect(await go()).toMatchObject({ status: 'EXACT', reasonCode: null, weightSource: 'silogtran' });
    await db.query(`update reconciliation_settings set zero_volume_mode='reconcile_always'`);
    expect(await go()).toMatchObject({ status: 'EXACT', weightSource: 'silogtran' });
    await db.close();
  });
});
