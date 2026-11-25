import { audit } from '../audit.js';
import type { Db, Queryable } from '../db/types.js';
import { sqlState } from '../db/types.js';
import { AppError } from '../errors.js';
import { log } from '../logger.js';
import type { StorageAdapter } from '../storage/types.js';
import type {
  DifferenceDto, FilterKeyDto, FilterModeDto, MatchFilterDto, PlaceAliasDto, ReconParamsDto, ReconResultDto, ReconRunDetailDto,
  ReconRunDto, ReconSettingsDto, ReconStatus, ReconStepDto, SilogRecordDto, TraceStepDto,
} from '../types.js';
import { RULES_VERSION, reconcile } from './engine.js';
import type { EngineParams, FilterConfig, SilogCandidate, TerpelInput } from './engine.js';
import { addDays, normalizePlace } from './normalize.js';
import { SilogtranError, dedupeAndFilter } from './silogtran.js';
import type { SilogtranSource } from './silogtran.js';

export interface ReconDeps {
  db: Db;
  storage: StorageAdapter;
  silog: SilogtranSource | null;
  defaultNit?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const SYNC_CHUNK_DAYS = 7;
const RECONCILE_BATCH = 150;
const MAX_RANGE_DAYS = 62;

export function isUuid(v: string | undefined): v is string {
  return !!v && UUID.test(v);
}

// ---- Parámetros -------------------------------------------------------------------------------
export async function loadSettings(q: Queryable, defaultNit = '830095213'): Promise<ReconSettingsDto> {
  const r = await q.query<{ window_days: number; lookback_days: number; terpel_nit: string }>(
    'select window_days, lookback_days, terpel_nit from reconciliation_settings limit 1',
  );
  const row = r.rows[0];
  return row
    ? { windowDays: row.window_days, lookbackDays: row.lookback_days, terpelNit: row.terpel_nit }
    : { windowDays: 10, lookbackDays: 15, terpelNit: defaultNit };
}

export async function loadFilters(q: Queryable): Promise<MatchFilterDto[]> {
  const r = await q.query<{ key: FilterKeyDto; position: number; active: boolean; mode: FilterModeDto }>(
    'select key, position, active, mode from match_filters order by position, key',
  );
  return r.rows;
}

export async function loadAliases(q: Queryable): Promise<PlaceAliasDto[]> {
  const r = await q.query<{ id: string; silog_name: string; terpel_name: string }>(
    'select id, silog_name, terpel_name from place_aliases order by terpel_norm, silog_norm',
  );
  return r.rows.map((a) => ({ id: a.id, silogName: a.silog_name, terpelName: a.terpel_name }));
}

export async function getParams(q: Queryable, defaultNit?: string): Promise<ReconParamsDto> {
  return { filters: await loadFilters(q), aliases: await loadAliases(q), settings: await loadSettings(q, defaultNit) };
}

async function engineParams(q: Queryable): Promise<EngineParams> {
  const filters: FilterConfig[] = await loadFilters(q);
  const settings = await loadSettings(q);
  const al = await q.query<{ silog_norm: string; terpel_norm: string }>('select silog_norm, terpel_norm from place_aliases');
  return { filters, windowDays: settings.windowDays, aliases: new Map(al.rows.map((a) => [a.silog_norm, a.terpel_norm])) };
}

export async function saveFilters(db: Db, actor: string, input: MatchFilterDto[]): Promise<MatchFilterDto[]> {
  const keys: FilterKeyDto[] = ['driver', 'plate', 'route', 'date'];
  if (input.length !== 4 || !keys.every((k) => input.some((f) => f.key === k))) {
    throw new AppError(400, 'INVALID_FIELD', 'Debe enviar los cuatro filtros: conductor, placa, ruta y fecha');
  }
  for (const f of input) {
    if (f.mode !== 'exclusive' && f.mode !== 'preferred') throw new AppError(400, 'INVALID_FIELD', 'Modo de filtro inválido');
    if (typeof f.active !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Activación de filtro inválida');
  }
  // El orden se toma de la posición en la lista recibida (se renumera 1..4).
  const ordered = [...input].sort((a, b) => a.position - b.position);
  await db.transaction(async (tx) => {
    for (let i = 0; i < ordered.length; i += 1) {
      const f = ordered[i] as MatchFilterDto;
      await tx.query('update match_filters set position=$2, active=$3, mode=$4, updated_by=$5, updated_at=now() where key=$1', [f.key, i + 1, f.active, f.mode, actor]);
    }
    await audit(tx, actor, 'match_filters.update', 'match_filters', 'all', { filters: ordered.map((f, i) => ({ key: f.key, position: i + 1, active: f.active, mode: f.mode })) });
  });
  return loadFilters(db);
}

export async function saveSettings(db: Db, actor: string, s: ReconSettingsDto): Promise<ReconSettingsDto> {
  const int = (v: unknown, name: string, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new AppError(400, 'INVALID_FIELD', `Campo inválido: ${name}`);
    return v;
  };
  const windowDays = int(s.windowDays, 'windowDays', 60);
  const lookbackDays = int(s.lookbackDays, 'lookbackDays', 90);
  const nit = typeof s.terpelNit === 'string' ? s.terpelNit.replace(/\D+/g, '') : '';
  if (nit.length < 5 || nit.length > 15) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: terpelNit');
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into reconciliation_settings (id, window_days, lookback_days, terpel_nit, updated_by) values (true,$1,$2,$3,$4)
       on conflict (id) do update set window_days=$1, lookback_days=$2, terpel_nit=$3, updated_by=$4, updated_at=now()`,
      [windowDays, lookbackDays, nit, actor],
    );
    await audit(tx, actor, 'recon_settings.update', 'reconciliation_settings', 'singleton', { windowDays, lookbackDays });
  });
  return loadSettings(db);
}

function aliasNames(silogName: unknown, terpelName: unknown): { sn: string; tn: string; silogNorm: string; terpelNorm: string } {
  if (typeof silogName !== 'string' || typeof terpelName !== 'string' || silogName.length > 120 || terpelName.length > 120) {
    throw new AppError(400, 'INVALID_FIELD', 'Nombres de lugar inválidos');
  }
  const silogNorm = normalizePlace(silogName);
  const terpelNorm = normalizePlace(terpelName);
  if (!silogNorm || !terpelNorm) throw new AppError(400, 'INVALID_FIELD', 'Nombres de lugar inválidos');
  return { sn: silogName.trim(), tn: terpelName.trim(), silogNorm, terpelNorm };
}

export async function upsertAlias(db: Db, actor: string, silogName: unknown, terpelName: unknown, id?: string): Promise<PlaceAliasDto> {
  const a = aliasNames(silogName, terpelName);
  try {
    const r = id
      ? await db.query<{ id: string }>(
          `update place_aliases set silog_name=$2, terpel_name=$3, silog_norm=$4, terpel_norm=$5 where id=$1 returning id`,
          [id, a.sn, a.tn, a.silogNorm, a.terpelNorm],
        )
      : await db.query<{ id: string }>(
          `insert into place_aliases (silog_name, terpel_name, silog_norm, terpel_norm, created_by) values ($1,$2,$3,$4,$5)
           on conflict (silog_norm) do update set silog_name=excluded.silog_name, terpel_name=excluded.terpel_name, terpel_norm=excluded.terpel_norm
           returning id`,
          [a.sn, a.tn, a.silogNorm, a.terpelNorm, actor],
        );
    const row = r.rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Equivalencia no encontrada');
    await audit(db, actor, id ? 'place_alias.update' : 'place_alias.upsert', 'place_alias', row.id, { silog: a.silogNorm, terpel: a.terpelNorm });
    return { id: row.id, silogName: a.sn, terpelName: a.tn };
  } catch (e) {
    if (sqlState(e) === '23505') throw new AppError(409, 'ALIAS_EXISTS', 'Ya existe una equivalencia para ese nombre de Silogtran');
    throw e;
  }
}

export async function deleteAlias(db: Db, actor: string, id: string): Promise<void> {
  const r = await db.query('delete from place_aliases where id=$1 returning id', [id]);
  if (r.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Equivalencia no encontrada');
  await audit(db, actor, 'place_alias.delete', 'place_alias', id, {});
}

// ---- Sincronización del snapshot --------------------------------------------------------------
export interface SyncChunkResult {
  dateFrom: string;
  dateTo: string;
  rowsTotal: number;
  rowsKept: number;
  durationMs: number;
}

function requireSilog(deps: ReconDeps): SilogtranSource {
  if (!deps.silog) {
    throw new AppError(409, 'SILOG_NOT_CONFIGURED', 'Silogtran no está configurado: faltan las variables SILOG_BASE_URL, SILOG_USER y SILOG_PASSWORD en el servidor');
  }
  return deps.silog;
}

function silogAppError(e: unknown): AppError {
  if (e instanceof SilogtranError) {
    const status = e.code === 'LOGIN_FAILED' ? 502 : 504;
    return new AppError(status, `SILOG_${e.code}`, e.message);
  }
  return new AppError(502, 'SILOG_ERROR', 'Error al consultar Silogtran');
}

/** Trae UN tramo corto de fechas y lo guarda por upsert (idempotente). Solo lectura contra Silogtran. */
export async function syncChunk(deps: ReconDeps, dateFrom: string, dateTo: string, runId: string | null): Promise<SyncChunkResult> {
  const source = requireSilog(deps);
  const settings = await loadSettings(deps.db, deps.defaultNit);
  const started = Date.now();
  let rows: Record<string, unknown>[];
  try {
    rows = await source.fetchReport(dateFrom, dateTo);
  } catch (e) {
    const err = silogAppError(e);
    await deps.db.query(
      `insert into silogtran_sync_log (run_id, date_from, date_to, duration_ms, status, error_code) values ($1,$2,$3,$4,'failed',$5)`,
      [runId, dateFrom, dateTo, Date.now() - started, err.code],
    );
    log('silog.sync_failed', { runId, code: err.code });
    throw err;
  }
  const { kept, total } = dedupeAndFilter(rows, settings.terpelNit);
  await deps.db.transaction(async (tx) => {
    if (kept.length > 0) {
      await tx.query(
        `insert into silogtran_records (manifest, remesa_code, dispatch_date, delivery_date, plate, plate_normalized, trailer_plate,
           driver_name, driver_document, client, client_nit, origin_city, destination_city, remesa_weight, net_load_weight, rate,
           freight_dispatch, total_remesa, additional_value, status, remesa_status, invoice)
         select manifest, remesa_code, dispatch_date, delivery_date, plate, plate_normalized, trailer_plate,
           driver_name, driver_document, client, client_nit, origin_city, destination_city, remesa_weight, net_load_weight, rate,
           freight_dispatch, total_remesa, additional_value, status, remesa_status, invoice
         from jsonb_to_recordset($1::jsonb) as t(
           manifest text, remesa_code text, dispatch_date date, delivery_date date, plate text, plate_normalized text, trailer_plate text,
           driver_name text, driver_document text, client text, client_nit text, origin_city text, destination_city text,
           remesa_weight numeric, net_load_weight numeric, rate numeric, freight_dispatch numeric, total_remesa numeric,
           additional_value numeric, status text, remesa_status text, invoice text)
         on conflict (manifest, remesa_code) do update set
           dispatch_date=excluded.dispatch_date, delivery_date=excluded.delivery_date, plate=excluded.plate,
           plate_normalized=excluded.plate_normalized, trailer_plate=excluded.trailer_plate, driver_name=excluded.driver_name,
           driver_document=excluded.driver_document, client=excluded.client, client_nit=excluded.client_nit,
           origin_city=excluded.origin_city, destination_city=excluded.destination_city, remesa_weight=excluded.remesa_weight,
           net_load_weight=excluded.net_load_weight, rate=excluded.rate, freight_dispatch=excluded.freight_dispatch,
           total_remesa=excluded.total_remesa, additional_value=excluded.additional_value, status=excluded.status,
           remesa_status=excluded.remesa_status, invoice=excluded.invoice, synced_at=now()`,
        [JSON.stringify(kept)],
      );
    }
    await tx.query(
      `insert into silogtran_sync_log (run_id, date_from, date_to, rows_total, rows_kept, duration_ms, status) values ($1,$2,$3,$4,$5,$6,'ok')`,
      [runId, dateFrom, dateTo, total, kept.length, Date.now() - started],
    );
  });
  const durationMs = Date.now() - started;
  log('silog.sync_chunk', { runId, rows: total, kept: kept.length, ms: durationMs });
  return { dateFrom, dateTo, rowsTotal: total, rowsKept: kept.length, durationMs };
}

function validateRange(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== 'string' || typeof to !== 'string' || !DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new AppError(400, 'INVALID_RANGE', 'Fechas inválidas (use AAAA-MM-DD)');
  }
  if (from > to) throw new AppError(400, 'INVALID_RANGE', 'La fecha inicial no puede ser posterior a la final');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new AppError(400, 'INVALID_RANGE', `El rango no puede superar ${MAX_RANGE_DAYS} días`);
  }
  return { from, to };
}

/** Sincroniza un tramo manual: devuelve el siguiente cursor (null al terminar). */
export async function syncStep(deps: ReconDeps, dateFrom: unknown, dateTo: unknown, cursor: unknown, actor: string): Promise<{ chunk: SyncChunkResult; nextCursor: string | null }> {
  const { from, to } = validateRange(dateFrom, dateTo);
  const start = typeof cursor === 'string' && DATE.test(cursor) && cursor >= from && cursor <= to ? cursor : from;
  const end = addDays(start, SYNC_CHUNK_DAYS - 1) < to ? addDays(start, SYNC_CHUNK_DAYS - 1) : to;
  const chunk = await syncChunk(deps, start, end, null);
  await audit(deps.db, actor, 'silogtran.sync', 'silogtran_sync', `${start}..${end}`, { rows: chunk.rowsKept });
  return { chunk, nextCursor: end < to ? addDays(end, 1) : null };
}

// ---- Ejecución de conciliación ------------------------------------------------------------------
interface RunRow {
  id: string; requested_by: string; date_from: string | Date; date_to: string | Date; sync_enabled: boolean; lookback_days: number;
  window_days: number; rules_version: string; status: ReconRunDto['status']; sync_cursor: string | Date | null; sync_end: string | Date | null;
  reconcile_offset: number; total_services: number; exact: number; with_differences: number; ambiguous: number; no_match: number;
  insufficient: number; export_status: ReconRunDto['exportStatus']; error_code: string | null; created_at: Date; finished_at: Date | null;
}

const d10 = (v: string | Date | null): string | null => (v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

function runDto(r: RunRow): ReconRunDto {
  return {
    id: r.id, dateFrom: d10(r.date_from) as string, dateTo: d10(r.date_to) as string, syncEnabled: r.sync_enabled,
    lookbackDays: r.lookback_days, windowDays: r.window_days, rulesVersion: r.rules_version, status: r.status,
    syncCursor: d10(r.sync_cursor), syncEnd: d10(r.sync_end), reconcileOffset: r.reconcile_offset, totalServices: r.total_services,
    exact: r.exact, withDifferences: r.with_differences, ambiguous: r.ambiguous, noMatch: r.no_match, insufficient: r.insufficient,
    exportStatus: r.export_status, errorCode: r.error_code, createdAt: new Date(r.created_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

const RUN_COLS = `id, requested_by, to_char(date_from,'YYYY-MM-DD') as date_from, to_char(date_to,'YYYY-MM-DD') as date_to, sync_enabled, lookback_days,
  window_days, rules_version, status, to_char(sync_cursor,'YYYY-MM-DD') as sync_cursor, to_char(sync_end,'YYYY-MM-DD') as sync_end,
  reconcile_offset, total_services, exact, with_differences, ambiguous, no_match, insufficient, export_status, error_code, created_at, finished_at`;

export async function getReconRun(q: Queryable, id: string): Promise<ReconRunDto> {
  const r = await q.query<RunRow>(`select ${RUN_COLS} from reconciliation_runs where id=$1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'RUN_NOT_FOUND', 'Conciliación no encontrada');
  return runDto(r.rows[0]);
}

export async function listReconRuns(q: Queryable, limit = 30): Promise<ReconRunDto[]> {
  const r = await q.query<RunRow>(`select ${RUN_COLS} from reconciliation_runs order by created_at desc limit $1`, [limit]);
  return r.rows.map(runDto);
}

export async function createReconRun(deps: ReconDeps, input: { actor: string; dateFrom: unknown; dateTo: unknown; sync?: boolean }): Promise<ReconRunDto> {
  const { from, to } = validateRange(input.dateFrom, input.dateTo);
  const sync = input.sync !== false;
  if (sync) requireSilog(deps);
  const settings = await loadSettings(deps.db, deps.defaultNit);
  try {
    const syncFrom = addDays(from, -settings.lookbackDays);
    const r = await deps.db.query<{ id: string }>(
      `insert into reconciliation_runs (requested_by, date_from, date_to, sync_enabled, lookback_days, window_days, rules_version, status, sync_cursor, sync_end)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [input.actor, from, to, sync, settings.lookbackDays, settings.windowDays, RULES_VERSION, sync ? 'syncing' : 'reconciling', sync ? syncFrom : null, sync ? to : null],
    );
    const id = r.rows[0]?.id as string;
    await audit(deps.db, input.actor, 'reconciliation.create', 'reconciliation_run', id, { from, to, sync });
    return await getReconRun(deps.db, id);
  } catch (e) {
    if (sqlState(e) === '23505') {
      const active = await deps.db.query<{ id: string }>(`select id from reconciliation_runs where status in ('pending','syncing','reconciling') limit 1`);
      throw new AppError(409, 'ACTIVE_RUN_EXISTS', 'Ya hay una conciliación activa. Reanúdela o espere a que termine.', { runId: active.rows[0]?.id ?? null });
    }
    throw e;
  }
}

interface ServiceRow {
  service_id: string; authorization_id: string; transport_number: string; service_date: string; driver_code: string | null;
  route: string | null; plate_normalized: string | null; transport_volume: string | null; net_value: string | null;
  resolved_record_id: string | null; prev_authorization_id: string | null;
}

const SERVICE_SELECT = `
  select s.id as service_id, a.id as authorization_id, a.transport_number, to_char(a.service_date,'YYYY-MM-DD') as service_date, a.driver_code, a.route,
         a.plate_normalized, a.transport_volume::text as transport_volume, a.net_value::text as net_value,
         r.resolved_record_id, r.authorization_id as prev_authorization_id
    from services s
    join authorizations a on a.id = s.current_authorization_id
    left join reconciliation_results r on r.service_id = s.id`;

interface CandRow {
  id: string; dispatch_date: string | null; plate_normalized: string | null; driver_document: string | null; origin_city: string | null;
  destination_city: string | null; remesa_weight: string | null; total_remesa: string | null;
}

async function loadCandidates(q: Queryable, nit: string, from: string, to: string): Promise<SilogCandidate[]> {
  const r = await q.query<CandRow>(
    `select id, to_char(dispatch_date,'YYYY-MM-DD') as dispatch_date, plate_normalized, driver_document, origin_city, destination_city,
            remesa_weight::text as remesa_weight, total_remesa::text as total_remesa
       from silogtran_records
      where client_nit = $1 and upper(coalesce(status,'')) <> 'ANULADO' and dispatch_date between $2 and $3`,
    [nit.replace(/\D+/g, ''), from, to],
  );
  return r.rows.map((c) => ({
    id: c.id, dispatchDate: c.dispatch_date, plateNormalized: c.plate_normalized, driverDocument: c.driver_document,
    originCity: c.origin_city, destinationCity: c.destination_city, remesaWeight: c.remesa_weight, totalRemesa: c.total_remesa,
  }));
}

async function reconcileRows(tx: Queryable, runId: string, rows: ServiceRow[], params: EngineParams, candidates: SilogCandidate[]): Promise<void> {
  for (const s of rows) {
    const t: TerpelInput = {
      driverCode: s.driver_code, route: s.route, serviceDate: s.service_date, plateNormalized: s.plate_normalized,
      transportVolume: s.transport_volume, netValue: s.net_value,
    };
    const manualId = s.prev_authorization_id === s.authorization_id ? s.resolved_record_id : null;
    const res = reconcile(t, candidates, params, manualId);
    await tx.query(
      `insert into reconciliation_results (service_id, run_id, authorization_id, transport_number, service_date, status, chosen_record_id,
         candidate_ids, filter_trace, differences, reason, rules_version, computed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9::jsonb,$10::jsonb,$11,$12,now())
       on conflict (service_id) do update set run_id=excluded.run_id, authorization_id=excluded.authorization_id,
         transport_number=excluded.transport_number, service_date=excluded.service_date, status=excluded.status,
         chosen_record_id=excluded.chosen_record_id, candidate_ids=excluded.candidate_ids, filter_trace=excluded.filter_trace,
         differences=excluded.differences, reason=excluded.reason, rules_version=excluded.rules_version, computed_at=now(),
         resolved_record_id = case when reconciliation_results.authorization_id = excluded.authorization_id then reconciliation_results.resolved_record_id else null end,
         resolved_by = case when reconciliation_results.authorization_id = excluded.authorization_id then reconciliation_results.resolved_by else null end,
         resolved_at = case when reconciliation_results.authorization_id = excluded.authorization_id then reconciliation_results.resolved_at else null end`,
      [
        s.service_id, runId, s.authorization_id, s.transport_number, s.service_date, res.status, res.chosenId,
        `{${res.candidateIds.join(',')}}`, JSON.stringify(res.trace), JSON.stringify(res.differences), res.reason, RULES_VERSION,
      ],
    );
  }
}

/** Avanza UNA unidad de trabajo (un tramo de Silogtran o un lote de servicios). Cada paso < 25 s. */
export async function stepReconRun(deps: ReconDeps, runId: string, actor: string, exportFn: (deps: ReconDeps, runId: string, actor: string) => Promise<void>): Promise<ReconStepDto> {
  const claimed = await deps.db.query<RunRow>(
    `update reconciliation_runs set lease_until = now() + interval '60 seconds'
      where id=$1 and status in ('pending','syncing','reconciling','failed') and (lease_until is null or lease_until < now())
      returning ${RUN_COLS}`,
    [runId],
  );
  const row = claimed.rows[0];
  if (!row) {
    const ex = await deps.db.query<{ status: string }>('select status from reconciliation_runs where id=$1', [runId]);
    if (!ex.rows[0]) throw new AppError(404, 'RUN_NOT_FOUND', 'Conciliación no encontrada');
    if (ex.rows[0].status === 'completed') return { run: await getReconRun(deps.db, runId), done: true, retryAfterMs: null, message: null };
    throw new AppError(409, 'RUN_LEASED', 'La conciliación está siendo procesada por otro paso. Reintente en unos segundos.');
  }
  const release = (status: string, code: string | null): Promise<unknown> =>
    deps.db.query('update reconciliation_runs set status=$2, error_code=$3, lease_until=null where id=$1', [runId, status, code]);
  const from = d10(row.date_from) as string;
  const to = d10(row.date_to) as string;
  let status: string = row.status === 'failed' ? (row.error_code?.startsWith('SILOG_') ? 'syncing' : 'reconciling') : row.status;

  if (status === 'pending') status = row.sync_enabled ? 'syncing' : 'reconciling';

  if (status === 'syncing') {
    const cursor = d10(row.sync_cursor) as string;
    const end = d10(row.sync_end) as string;
    const chunkEnd = addDays(cursor, SYNC_CHUNK_DAYS - 1) < end ? addDays(cursor, SYNC_CHUNK_DAYS - 1) : end;
    try {
      await syncChunk(deps, cursor, chunkEnd, runId);
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError(502, 'SILOG_ERROR', 'Error al consultar Silogtran');
      const fatal = err.code === 'SILOG_NOT_CONFIGURED' || err.code === 'SILOG_LOGIN_FAILED';
      await release(fatal ? 'failed' : 'syncing', err.code);
      return { run: await getReconRun(deps.db, runId), done: false, retryAfterMs: fatal ? null : 1500, message: err.message };
    }
    const next = chunkEnd < end ? addDays(chunkEnd, 1) : null;
    await deps.db.query(
      `update reconciliation_runs set sync_cursor=$2, status=$3, lease_until=null, error_code=null where id=$1`,
      [runId, next ?? row.sync_cursor, next ? 'syncing' : 'reconciling'],
    );
    return { run: await getReconRun(deps.db, runId), done: false, retryAfterMs: null, message: null };
  }

  // reconciling
  try {
    const cnt = await deps.db.query<{ n: number }>(
      `select count(*)::int as n from services s join authorizations a on a.id = s.current_authorization_id where a.service_date between $1 and $2`,
      [from, to],
    );
    const total = cnt.rows[0]?.n ?? 0;
    const params = await engineParams(deps.db);
    const settings = await loadSettings(deps.db, deps.defaultNit);
    const batch = await deps.db.query<ServiceRow>(
      `${SERVICE_SELECT} where a.service_date between $1 and $2 order by a.transport_number, s.id limit $3 offset $4`,
      [from, to, RECONCILE_BATCH, row.reconcile_offset],
    );
    const candidates = await loadCandidates(deps.db, settings.terpelNit, addDays(from, -row.lookback_days), to);
    const useParams: EngineParams = { ...params, windowDays: row.window_days };
    const newOffset = row.reconcile_offset + batch.rows.length;
    const finished = batch.rows.length < RECONCILE_BATCH || newOffset >= total;
    await deps.db.transaction(async (tx) => {
      await reconcileRows(tx, runId, batch.rows, useParams, candidates);
      await tx.query(`update reconciliation_runs set reconcile_offset=$2, total_services=$3, status='reconciling', lease_until=null, error_code=null where id=$1`, [runId, newOffset, total]);
      if (finished) {
        await tx.query(
          `update reconciliation_runs set status='completed', finished_at=now(),
             exact=(select count(*) from reconciliation_results r where r.service_date between $2 and $3 and r.status='EXACT'),
             with_differences=(select count(*) from reconciliation_results r where r.service_date between $2 and $3 and r.status='MATCH_WITH_DIFFERENCES'),
             ambiguous=(select count(*) from reconciliation_results r where r.service_date between $2 and $3 and r.status='AMBIGUOUS'),
             no_match=(select count(*) from reconciliation_results r where r.service_date between $2 and $3 and r.status='NO_MATCH'),
             insufficient=(select count(*) from reconciliation_results r where r.service_date between $2 and $3 and r.status='INSUFFICIENT_DATA')
           where id=$1`,
          [runId, from, to],
        );
      }
    });
    log('recon.step', { runId, processed: batch.rows.length, done: finished });
  } catch (e) {
    await release('reconciling', 'STEP_ERROR');
    log('recon.step_error', { runId, state: sqlState(e) });
    return { run: await getReconRun(deps.db, runId), done: false, retryAfterMs: 1000, message: 'Fallo temporal al conciliar; se reintenta' };
  }
  const run = await getReconRun(deps.db, runId);
  if (run.status === 'completed') {
    await exportFn(deps, runId, actor);
    return { run: await getReconRun(deps.db, runId), done: true, retryAfterMs: null, message: null };
  }
  return { run, done: false, retryAfterMs: null, message: null };
}

// ---- Resultados ---------------------------------------------------------------------------------
interface ResultRow {
  id: string; transport_number: string; service_date: string; status: ReconStatus; reason: string | null; rules_version: string;
  chosen_record_id: string | null; candidate_ids: string[]; filter_trace: TraceStepDto[]; differences: DifferenceDto[];
  resolved_record_id: string | null; resolved_by: string | null; resolved_at: Date | null;
  route: string | null; plate: string | null; driver_code: string | null; driver_name: string | null; volume: string | null; net_value: string | null;
}

interface RecRow {
  id: string; manifest: string; remesa_code: string; dispatch_date: string | null; delivery_date: string | null; plate: string | null;
  driver_name: string | null; driver_document: string | null; origin_city: string | null; destination_city: string | null;
  remesa_weight: string | null; net_load_weight: string | null; rate: string | null; total_remesa: string | null; status: string | null;
  remesa_status: string | null; invoice: string | null;
}

function recDto(r: RecRow): SilogRecordDto {
  return {
    id: r.id, manifest: r.manifest, remesaCode: r.remesa_code, dispatchDate: r.dispatch_date, deliveryDate: r.delivery_date, plate: r.plate,
    driverName: r.driver_name, driverDocument: r.driver_document, origin: r.origin_city, destination: r.destination_city,
    remesaWeight: r.remesa_weight, netLoadWeight: r.net_load_weight, rate: r.rate, totalRemesa: r.total_remesa, status: r.status,
    remesaStatus: r.remesa_status, invoice: r.invoice,
  };
}

const RESULT_SELECT = `
  select r.id, r.transport_number, to_char(r.service_date,'YYYY-MM-DD') as service_date, r.status, r.reason, r.rules_version,
         r.chosen_record_id, r.candidate_ids, r.filter_trace, r.differences, r.resolved_record_id, r.resolved_by, r.resolved_at,
         a.route, a.plate, a.driver_code, a.driver_name, a.transport_volume::text as volume, a.net_value::text as net_value
    from reconciliation_results r join authorizations a on a.id = r.authorization_id`;

async function toResultDtos(q: Queryable, rows: ResultRow[]): Promise<ReconResultDto[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.chosen_record_id) ids.add(r.chosen_record_id);
    for (const c of r.candidate_ids) ids.add(c);
  }
  const recs = new Map<string, SilogRecordDto>();
  if (ids.size > 0) {
    const rr = await q.query<RecRow>(
      `select id, manifest, remesa_code, to_char(dispatch_date,'YYYY-MM-DD') as dispatch_date, to_char(delivery_date,'YYYY-MM-DD') as delivery_date,
              plate, driver_name, driver_document, origin_city, destination_city, remesa_weight::text as remesa_weight,
              net_load_weight::text as net_load_weight, rate::text as rate, total_remesa::text as total_remesa, status, remesa_status, invoice
         from silogtran_records where id = any($1::uuid[])`,
      [[...ids]],
    );
    for (const r of rr.rows) recs.set(r.id, recDto(r));
  }
  return rows.map((r) => ({
    id: r.id, transportNumber: r.transport_number, serviceDate: r.service_date, status: r.status, reason: r.reason, rulesVersion: r.rules_version,
    terpel: { route: r.route, plate: r.plate, driverCode: r.driver_code, driverName: r.driver_name, volume: r.volume, netValue: r.net_value },
    silog: r.chosen_record_id ? (recs.get(r.chosen_record_id) ?? null) : null,
    candidates: r.candidate_ids.map((c) => recs.get(c)).filter((x): x is SilogRecordDto => !!x),
    trace: r.filter_trace, differences: r.differences,
    manual: r.resolved_record_id !== null, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  }));
}

export async function listResults(q: Queryable, runId: string, status?: string | null, limit = 1000): Promise<ReconResultDto[]> {
  const run = await getReconRun(q, runId);
  const params: unknown[] = [run.dateFrom, run.dateTo];
  let where = 'where r.service_date between $1 and $2';
  if (status) {
    params.push(status);
    where += ` and r.status = $${params.length}`;
  }
  params.push(limit);
  const r = await q.query<ResultRow>(`${RESULT_SELECT} ${where} order by r.service_date, r.transport_number limit $${params.length}`, params);
  return toResultDtos(q, r.rows);
}

export async function getReconDetail(q: Queryable, runId: string): Promise<ReconRunDetailDto> {
  return { run: await getReconRun(q, runId), results: await listResults(q, runId) };
}

async function getResult(q: Queryable, resultId: string): Promise<ReconResultDto> {
  const r = await q.query<ResultRow>(`${RESULT_SELECT} where r.id = $1`, [resultId]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Resultado no encontrado');
  return (await toResultDtos(q, r.rows))[0] as ReconResultDto;
}

/** Recalcula UN servicio con los parámetros actuales (usa el snapshot existente). */
async function reconcileOne(db: Db, resultId: string): Promise<void> {
  const cur = await db.query<{ service_id: string; run_id: string }>('select service_id, run_id from reconciliation_results where id=$1', [resultId]);
  const c = cur.rows[0];
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Resultado no encontrado');
  const rows = await db.query<ServiceRow>(`${SERVICE_SELECT} where s.id = $1`, [c.service_id]);
  const row = rows.rows[0];
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Servicio no encontrado');
  const settings = await loadSettings(db);
  const params = await engineParams(db);
  const cands = await loadCandidates(db, settings.terpelNit, addDays(row.service_date, -settings.lookbackDays), row.service_date);
  await db.transaction((tx) => reconcileRows(tx, c.run_id, [row], params, cands));
}

export async function resolveResult(db: Db, actor: string, resultId: string, recordId: unknown): Promise<ReconResultDto> {
  if (!isUuid(typeof recordId === 'string' ? recordId : undefined)) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: recordId');
  const cur = await db.query<{ candidate_ids: string[]; status: string }>('select candidate_ids, status from reconciliation_results where id=$1', [resultId]);
  const r = cur.rows[0];
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Resultado no encontrado');
  if (!r.candidate_ids.includes(recordId as string)) {
    throw new AppError(400, 'NOT_A_CANDIDATE', 'El registro elegido no es uno de los candidatos de este servicio');
  }
  await db.query('update reconciliation_results set resolved_record_id=$2, resolved_by=$3, resolved_at=now() where id=$1', [resultId, recordId, actor]);
  await reconcileOne(db, resultId);
  await audit(db, actor, 'reconciliation.resolve', 'reconciliation_result', resultId, { recordId });
  return getResult(db, resultId);
}

/** "Agregar equivalencia" desde la bandeja: guarda el alias y concilia de nuevo ese servicio. */
export async function addAliasAndReconcile(db: Db, actor: string, resultId: string, silogName: unknown, terpelName: unknown): Promise<ReconResultDto> {
  await getResult(db, resultId);
  await upsertAlias(db, actor, silogName, terpelName);
  await reconcileOne(db, resultId);
  await audit(db, actor, 'reconciliation.reconcile_one', 'reconciliation_result', resultId, { reason: 'alias' });
  return getResult(db, resultId);
}

export { getResult as getReconResult };
