import { createHash, randomUUID } from 'node:crypto';
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db/types.js';
import { AppError } from '../errors.js';
import { SilogWebError } from '../silog/web/errors.js';
import { log } from '../logger.js';
import { dedupeAndFilter } from '../recon/silogtran.js';
import type { SilogRecordInput, SilogtranSource } from '../recon/silogtran.js';
import { loadSettings } from '../recon/service.js';
import type { StorageAdapter } from '../storage/types.js';
import type {
  AdjustSettingsDto, ApplyPreviewDto, ProposalDto, ProposalEventDto, ProposalLineDto, ProposalStatus, RehearsalDto, WriterStatusDto,
} from '../types.js';
import { computeTariff, normalizeNumberString } from './tariff.js';
import type { RehearsalResult, ScreenValues, SilogtranWriter, TariffChange } from './writer.js';

export const ADJUST_RULES_VERSION = 'adjust-1.0.0';

export interface AdjustDeps {
  db: Db;
  storage: StorageAdapter;
  silog: SilogtranSource | null;
  writer: SilogtranWriter;
  /** Espera entre relecturas del informe tras escribir (por defecto 4 s; las pruebas usan 0). */
  verifyDelayMs?: number;
  /** Remesas permitidas para la escritura real (se evalúa solo si writer.kind === 'web'). */
  allow?: { all: boolean; list: string[] };
}

// ---- Máquina de estados ----------------------------------------------------------------------------
export const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  proposed: ['approved', 'rejected', 'stale', 'needs_review'],
  needs_review: ['proposed', 'rejected', 'stale'],
  approved: ['applying', 'rejected', 'stale'],
  applying: ['applied', 'simulated_applied', 'failed', 'uncertain', 'verification_failed', 'stale', 'approved'],
  failed: ['applying', 'rejected', 'stale'],
  uncertain: ['applied', 'simulated_applied', 'verification_failed', 'failed'],
  verification_failed: [],
  applied: [],
  simulated_applied: ['discarded'],
  rejected: [],
  stale: ['proposed', 'needs_review', 'rejected'],
  discarded: ['proposed', 'needs_review'],
};
export const ALL_STATUSES = Object.keys(TRANSITIONS) as ProposalStatus[];
export const canTransition = (from: ProposalStatus, to: ProposalStatus): boolean => TRANSITIONS[from].includes(to);

// ---- Parámetros ------------------------------------------------------------------------------------
const PLACEHOLDERS = ['transport', 'expense', 'remesa', 'manifest'];
export const MAX_REASON = 200;

export function validateTemplate(t: unknown): string {
  if (typeof t !== 'string' || t.trim() === '') throw new AppError(400, 'INVALID_FIELD', 'La razón de cambio no puede estar vacía');
  const s = t.trim();
  if (s.length > MAX_REASON) throw new AppError(400, 'INVALID_FIELD', `La razón de cambio no puede superar ${MAX_REASON} caracteres`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) throw new AppError(400, 'INVALID_FIELD', 'La razón de cambio no admite caracteres de control');
  const found = s.match(/\{[^}]*\}/g) ?? [];
  for (const f of found) {
    if (!PLACEHOLDERS.includes(f.slice(1, -1))) {
      throw new AppError(400, 'INVALID_PLACEHOLDER', `Marcador no permitido ${f}. Permitidos: ${PLACEHOLDERS.map((x) => `{${x}}`).join(', ')}`);
    }
  }
  if (s.replace(/\{[^}]*\}/g, '').match(/[{}]/)) throw new AppError(400, 'INVALID_PLACEHOLDER', 'Llaves sin cerrar en la razón de cambio');
  return s;
}

export function renderReason(template: string, v: { transport: string; expense: string | null; remesa: string | null; manifest: string | null }): string {
  const out = template
    .replace(/\{transport\}/g, v.transport)
    .replace(/\{expense\}/g, v.expense ?? 's/n')
    .replace(/\{remesa\}/g, v.remesa ?? '')
    .replace(/\{manifest\}/g, v.manifest ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.slice(0, MAX_REASON);
}

const normRemesa = (v: string): string => v.replace(/\D/g, '').replace(/^0+/, '');
const DEFAULT_TEMPLATE = 'Ajuste según autorización de pago Terpel, transporte {transport}, gasto {expense}';

export async function getAdjustSettings(q: Queryable, envMode: 'mock' | 'web' = 'mock'): Promise<AdjustSettingsDto> {
  const r = await q.query<{ reason_template: string; auto_enabled: boolean; writer_mode: 'mock' | 'web' | null; writer_allowlist: string[]; writer_allow_all: boolean }>(
    'select reason_template, auto_enabled, writer_mode, writer_allowlist, writer_allow_all from adjustment_settings limit 1',
  );
  const row = r.rows[0];
  return {
    reasonTemplate: row?.reason_template ?? DEFAULT_TEMPLATE, autoEnabled: row?.auto_enabled ?? false,
    writerMode: row?.writer_mode ?? envMode, writerAllowlist: row?.writer_allowlist ?? [], writerAllowAll: row?.writer_allow_all ?? false,
  };
}

export const writerStatus = (s: AdjustSettingsDto): WriterStatusDto => ({ mode: s.writerMode, simulated: s.writerMode !== 'web', allowAll: s.writerAllowAll, allowlist: s.writerAllowlist });

export async function saveAdjustSettings(
  db: Db, actor: string, input: { reasonTemplate?: unknown; autoEnabled?: unknown; writerMode?: unknown; writerAllowlist?: unknown; writerAllowAll?: unknown; confirmAll?: unknown }, envMode: 'mock' | 'web' = 'mock',
): Promise<AdjustSettingsDto> {
  const cur = await getAdjustSettings(db, envMode);
  const tpl = input.reasonTemplate === undefined ? cur.reasonTemplate : validateTemplate(input.reasonTemplate);
  if (input.autoEnabled !== undefined && typeof input.autoEnabled !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: autoEnabled');
  const auto = input.autoEnabled === undefined ? cur.autoEnabled : (input.autoEnabled as boolean);
  if (input.writerMode !== undefined && input.writerMode !== 'mock' && input.writerMode !== 'web') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: writerMode');
  const mode = (input.writerMode as 'mock' | 'web' | undefined) ?? cur.writerMode;
  let list = cur.writerAllowlist;
  if (input.writerAllowlist !== undefined) {
    if (!Array.isArray(input.writerAllowlist) || input.writerAllowlist.length > 200) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: writerAllowlist');
    list = [...new Set(input.writerAllowlist.map((x) => {
      if (typeof x !== 'string' || !/^\d{1,12}$/.test(x.trim())) throw new AppError(400, 'INVALID_FIELD', 'Cada remesa permitida debe ser un código numérico de hasta 12 dígitos');
      return normRemesa(x);
    }).filter(Boolean))];
  }
  if (input.writerAllowAll !== undefined && typeof input.writerAllowAll !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: writerAllowAll');
  const all = (input.writerAllowAll as boolean | undefined) ?? cur.writerAllowAll;
  if (all && !cur.writerAllowAll && input.confirmAll !== true) {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Permitir la escritura real en TODAS las remesas exige confirmación explícita (confirmAll=true)');
  }
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into adjustment_settings (id, reason_template, auto_enabled, writer_mode, writer_allowlist, writer_allow_all, updated_by) values (true,$1,$2,$3,$4::text[],$5,$6)
       on conflict (id) do update set reason_template=$1, auto_enabled=$2, writer_mode=$3, writer_allowlist=$4::text[], writer_allow_all=$5, updated_by=$6, updated_at=now()`,
      [tpl, auto, mode, `{${list.join(',')}}`, all, actor],
    );
    await audit(tx, actor, 'adjust_settings.update', 'adjustment_settings', 'singleton', {
      autoEnabled: auto, templateChanged: tpl !== cur.reasonTemplate, writerMode: mode, allowlist: list, allowAll: all,
      writerChanged: mode !== cur.writerMode || all !== cur.writerAllowAll || list.join() !== cur.writerAllowlist.join(),
    });
  });
  return getAdjustSettings(db, envMode);
}

// ---- Filas y DTO -------------------------------------------------------------------------------------
interface ProposalRow {
  id: string; service_id: string; authorization_id: string; recon_result_id: string | null; record_id: string | null; service_date: string;
  transport_number: string; expense_number: string | null; remesa_code: string | null; manifest: string | null; status: ProposalStatus;
  review_code: string | null; review_detail: string | null; weight_source: 'terpel' | 'silogtran' | null; gallons: string | null; tariff: string | null;
  current_weight: string | null; current_total: string | null; target_value: string | null; reason: string | null; lines: ProposalLineDto[];
  idempotency_key: string; rules_version: string; auto_eligible: boolean; auto_reasons: string[]; simulated: boolean; writer_kind: string | null;
  account_user: string | null; generated_by: string | null; approved_by: string | null; approved_at: Date | null; applied_by: string | null;
  applied_at: Date | null; lease_until: Date | null; verification: Record<string, unknown> | null; last_error: string | null; updated_at: Date;
  kind: 'adjust' | 'reversal'; reversal_of: string | null; quantity: string | null; reversal_values: ScreenValues | null;
}

const COLS = `id, service_id, authorization_id, recon_result_id, record_id, to_char(service_date,'YYYY-MM-DD') as service_date, transport_number,
  expense_number, remesa_code, manifest, status, review_code, review_detail, weight_source, gallons::text as gallons, tariff,
  current_weight::text as current_weight, current_total::text as current_total, target_value::text as target_value, reason, lines,
  idempotency_key, rules_version, auto_eligible, auto_reasons, simulated, writer_kind, account_user, generated_by, approved_by, approved_at,
  applied_by, applied_at, lease_until, verification, last_error, updated_at, kind, reversal_of, quantity::text as quantity, reversal_values`;

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const clean = (v: string | null): string | null => (v === null ? null : normalizeNumberString(v));

function toDto(r: ProposalRow, autoEnabled: boolean): ProposalDto {
  return {
    id: r.id, transportNumber: r.transport_number, expenseNumber: r.expense_number, serviceDate: r.service_date, status: r.status,
    reviewCode: r.review_code, reviewDetail: r.review_detail, remesaCode: r.remesa_code, manifest: r.manifest, weightSource: r.weight_source,
    gallons: clean(r.gallons), tariff: r.tariff, currentWeight: clean(r.current_weight), currentTotal: clean(r.current_total),
    targetValue: clean(r.target_value), reason: r.reason, lines: r.lines, simulated: r.simulated, writerKind: r.writer_kind,
    accountUser: r.account_user, generatedBy: r.generated_by, approvedBy: r.approved_by, approvedAt: iso(r.approved_at), appliedBy: r.applied_by,
    appliedAt: iso(r.applied_at), verification: r.verification, lastError: r.last_error, autoEligible: r.auto_eligible, autoReasons: r.auto_reasons,
    autoAllowed: r.auto_eligible && autoEnabled, rulesVersion: r.rules_version, updatedAt: new Date(r.updated_at).toISOString(),
    kind: r.kind, reversalOf: r.reversal_of, quantity: clean(r.quantity), reversalValues: r.reversal_values,
  };
}

async function loadRow(q: Queryable, id: string): Promise<ProposalRow> {
  const r = await q.query<ProposalRow>(`select ${COLS} from adjustment_proposals where id = $1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Propuesta no encontrada');
  return r.rows[0];
}

export async function getProposal(q: Queryable, id: string): Promise<ProposalDto> {
  const s = await getAdjustSettings(q);
  return toDto(await loadRow(q, id), s.autoEnabled);
}

export async function getEvents(q: Queryable, id: string): Promise<ProposalEventDto[]> {
  const r = await q.query<{ id: string; at: Date; actor: string | null; event: string; from_status: string | null; to_status: string | null; simulated: boolean; detail: Record<string, unknown> }>(
    'select id, at, actor, event, from_status, to_status, simulated, detail from adjustment_events where proposal_id = $1 order by id',
    [id],
  );
  return r.rows.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), actor: e.actor, event: e.event, fromStatus: e.from_status, toStatus: e.to_status, simulated: e.simulated, detail: e.detail }));
}

export async function listProposals(q: Queryable, filter: { runFrom?: string; runTo?: string; status?: string | null }): Promise<ProposalDto[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.runFrom && filter.runTo) {
    params.push(filter.runFrom, filter.runTo);
    where.push(`service_date between $1 and $2`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  const s = await getAdjustSettings(q);
  const r = await q.query<ProposalRow>(`select ${COLS} from adjustment_proposals ${where.length ? `where ${where.join(' and ')}` : ''} order by service_date, transport_number, created_at limit 2000`, params);
  return r.rows.map((x) => toDto(x, s.autoEnabled));
}

async function addEvent(q: Queryable, proposalId: string, actor: string | null, event: string, from: string | null, to: string | null, simulated: boolean, detail: Record<string, unknown> = {}): Promise<void> {
  await q.query(
    `insert into adjustment_events (proposal_id, actor, event, from_status, to_status, simulated, detail) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [proposalId, actor, event, from, to, simulated, JSON.stringify(detail)],
  );
}

const SETTABLE = new Set([
  'approved_by', 'approved_at', 'applied_by', 'applied_at', 'lease_until', 'simulated', 'writer_kind', 'account_user', 'verification', 'last_error',
  'review_code', 'review_detail', 'reversal_values',
]);

/** Transición atómica (compare-and-set sobre el estado) + evento en la misma transacción. null = otra petición ganó. */
async function move(
  db: Db, id: string, froms: ProposalStatus[], to: ProposalStatus, actor: string | null, event: string,
  set: Record<string, unknown> = {}, detail: Record<string, unknown> = {},
): Promise<ProposalRow | null> {
  for (const f of froms) if (!canTransition(f, to)) throw new Error(`Transición inválida ${f} -> ${to}`);
  const cols = Object.keys(set);
  for (const c of cols) if (!SETTABLE.has(c)) throw new Error(`Columna no permitida ${c}`);
  const sets = cols.map((c, i) => `${c} = $${i + 4}${c === 'verification' || c === 'reversal_values' ? '::jsonb' : ''}`);
  return db.transaction(async (tx) => {
    const prev = await tx.query<{ status: ProposalStatus }>('select status from adjustment_proposals where id = $1 for update', [id]);
    const from = prev.rows[0]?.status;
    if (!from || !froms.includes(from)) return null;
    const vals = cols.map((c) => ((c === 'verification' || c === 'reversal_values') && set[c] !== null ? JSON.stringify(set[c]) : set[c]));
    const r = await tx.query<ProposalRow>(
      `update adjustment_proposals set status = $2, updated_at = now()${sets.length ? `, ${sets.join(', ')}` : ''}
        where id = $1 and status = $3 returning ${COLS}`,
      [id, to, from, ...vals],
    );
    const row = r.rows[0];
    if (!row) return null;
    await addEvent(tx, id, actor, event, from, to, row.simulated, detail);
    return row;
  });
}

// ---- Elegibilidad para automático (gancho; sin orquestador) ----------------------------------------------
export interface EligibilityInput {
  resultStatus: string;
  candidateCount: number;
  differences: { severity: string }[];
  weightSource: 'terpel' | 'silogtran' | null;
  terpelVolume: string | null;
  tariffOk: boolean;
  recordStatus: string | null;
  invoice: string | null;
  complete: boolean;
}

export function autoEligibility(i: EligibilityInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.resultStatus !== 'MATCH_WITH_DIFFERENCES') reasons.push('El resultado no es "con diferencias"');
  if (i.candidateCount !== 1) reasons.push('No hay un único despacho candidato');
  if (i.differences.some((d) => d.severity !== 'adjustable')) reasons.push('Hay diferencias que no son ajustables');
  if (!(Number(i.terpelVolume) > 0) && i.weightSource !== 'silogtran') reasons.push('Volumen de Terpel en 0 sin conciliación por valor');
  if (!i.tariffOk) reasons.push('La tarifa no es exacta');
  if ((i.recordStatus ?? '').toUpperCase() !== 'CUMPLIDO') reasons.push('El registro de Silogtran no está CUMPLIDO');
  if (i.invoice) reasons.push('El registro ya tiene factura');
  if (!i.complete) reasons.push('Faltan datos');
  return { eligible: reasons.length === 0, reasons };
}

// ---- Generación ---------------------------------------------------------------------------------------
interface SourceRow {
  rid: string; service_id: string; authorization_id: string; service_date: string; transport_number: string; weight_source: 'terpel' | 'silogtran' | null;
  candidate_ids: string[]; differences: { severity: string }[]; chosen_record_id: string; expense_number: string | null; vol: string | null; nv: string | null;
  remesa_code: string; manifest: string; rw: string | null; tr: string | null; rate: string | null; sstatus: string | null; invoice: string | null;
}

const keyOf = (serviceId: string, authId: string, gallons: string, tariff: string, value: string): string =>
  createHash('sha256').update(`${serviceId}|${authId}|${gallons}|${tariff}|${value}`).digest('hex');

export interface GenerateSummary { created: number; refreshed: number; unchanged: number; needsReview: number; staled: number; total: number }

export async function generateProposals(deps: AdjustDeps, runId: string, actor: string): Promise<GenerateSummary> {
  const db = deps.db;
  const run = await db.query<{ from: string; to: string; status: string }>(
    `select to_char(date_from,'YYYY-MM-DD') as "from", to_char(date_to,'YYYY-MM-DD') as "to", status from reconciliation_runs where id=$1`, [runId],
  );
  const rr = run.rows[0];
  if (!rr) throw new AppError(404, 'RUN_NOT_FOUND', 'Conciliación no encontrada');
  if (rr.status !== 'completed') throw new AppError(409, 'RUN_NOT_COMPLETED', 'La conciliación aún no termina');
  const settings = await getAdjustSettings(db);
  const rows = await db.query<SourceRow>(
    `select r.id as rid, r.service_id, r.authorization_id, to_char(r.service_date,'YYYY-MM-DD') as service_date, r.transport_number, r.weight_source,
            r.candidate_ids, r.differences, r.chosen_record_id, a.expense_number, a.transport_volume::text as vol, a.net_value::text as nv,
            s.remesa_code, s.manifest, s.remesa_weight::text as rw, s.total_remesa::text as tr, s.rate::text as rate, s.status as sstatus, s.invoice
       from reconciliation_results r
       join authorizations a on a.id = r.authorization_id
       join silogtran_records s on s.id = r.chosen_record_id
      where r.service_date between $1 and $2 and r.status = 'MATCH_WITH_DIFFERENCES'
      order by r.service_date, r.transport_number`,
    [rr.from, rr.to],
  );
  const sum: GenerateSummary = { created: 0, refreshed: 0, unchanged: 0, needsReview: 0, staled: 0, total: rows.rows.length };
  for (const s of rows.rows) {
    const weightSource = s.weight_source ?? 'terpel';
    const gallonsRaw = weightSource === 'silogtran' ? s.rw : s.vol;
    const t = computeTariff(s.nv, gallonsRaw);
    let reviewCode: string | null = null;
    let reviewDetail: string | null = null;
    if (!t.ok) { reviewCode = t.code; reviewDetail = t.detail; }
    else if ((s.sstatus ?? '').toUpperCase() !== 'CUMPLIDO') { reviewCode = 'NOT_CUMPLIDO'; reviewDetail = 'El registro de Silogtran ya no está CUMPLIDO'; }
    else if (s.invoice) { reviewCode = 'ALREADY_INVOICED'; reviewDetail = 'El registro de Silogtran ya tiene factura'; }
    const gallons = t.ok ? t.gallons : normalizeNumberString(gallonsRaw);
    const target = normalizeNumberString(s.nv);
    const reason = renderReason(settings.reasonTemplate, { transport: s.transport_number, expense: s.expense_number, remesa: s.remesa_code, manifest: s.manifest });
    const curW = normalizeNumberString(s.rw);
    const curT = normalizeNumberString(s.tr);
    const lines: ProposalLineDto[] = [
      { field: 'pesoRemesa', label: 'Peso Remesa', current: curW, proposed: gallons, rule: weightSource === 'silogtran' ? 'Volumen de Terpel en 0: se conserva el peso de Silogtran' : 'Peso Remesa = galones indicados por Terpel' },
      { field: 'cantidadRemesa', label: 'Cantidad Remesa', current: null, proposed: gallons, rule: 'Cantidad Remesa = Peso Remesa (el valor actual no está disponible en el informe)' },
      { field: 'nuevaTarifa', label: 'Nueva Tarifa', current: normalizeNumberString(s.rate), proposed: t.ok ? t.tariff : null, rule: 'Valor neto de Terpel ÷ galones, decimal exacto de hasta 12 caracteres (punto decimal)' },
      { field: 'totalRemesa', label: 'Total de la remesa', current: curT, proposed: target, rule: 'El total debe quedar idéntico al valor neto de Terpel (tarifa × galones, sin tolerancia)' },
    ];
    const elig = autoEligibility({
      resultStatus: 'MATCH_WITH_DIFFERENCES', candidateCount: s.candidate_ids.length, differences: s.differences, weightSource, terpelVolume: s.vol,
      tariffOk: t.ok, recordStatus: s.sstatus, invoice: s.invoice, complete: !!(s.remesa_code && s.transport_number && gallons && target),
    });
    const key = keyOf(s.service_id, s.authorization_id, gallons ?? '-', t.ok ? t.tariff : `x:${reviewCode}`, target ?? '-');
    const status: ProposalStatus = reviewCode ? 'needs_review' : 'proposed';
    if (reviewCode) sum.needsReview += 1;
    await db.transaction(async (tx) => {
      const ex = await tx.query<{ id: string; status: ProposalStatus }>('select id, status from adjustment_proposals where idempotency_key = $1 for update', [key]);
      const found = ex.rows[0];
      if (found) {
        if (['proposed', 'needs_review', 'stale', 'discarded'].includes(found.status)) {
          await tx.query(
            `update adjustment_proposals set status=$2, review_code=$3, review_detail=$4, lines=$5::jsonb, reason=$6, auto_eligible=$7, auto_reasons=$8::jsonb,
                    current_weight=$9, current_total=$10, updated_at=now() where id=$1`,
            [found.id, status, reviewCode, reviewDetail, JSON.stringify(lines), reason, elig.eligible, JSON.stringify(elig.reasons), curW, curT],
          );
          if (found.status !== status) await addEvent(tx, found.id, actor, 'regenerated', found.status, status, false, { reviewCode });
          sum.refreshed += found.status !== status ? 1 : 0;
          sum.unchanged += found.status !== status ? 0 : 1;
        } else sum.unchanged += 1; // aprobadas, aplicadas, rechazadas, etc.: se respetan
        return;
      }
      // Otras propuestas vivas del mismo servicio con valores distintos quedan obsoletas.
      const old = await tx.query<{ id: string; status: ProposalStatus }>(
        `select id, status from adjustment_proposals where service_id = $1 and status in ('proposed','needs_review','approved','failed') for update`, [s.service_id],
      );
      for (const o of old.rows) {
        await tx.query(`update adjustment_proposals set status='stale', updated_at=now() where id=$1`, [o.id]);
        await addEvent(tx, o.id, actor, 'superseded', o.status, 'stale', false, { reason: 'Nueva propuesta con valores distintos' });
        sum.staled += 1;
      }
      const id = randomUUID();
      await tx.query(
        `insert into adjustment_proposals (id, service_id, authorization_id, recon_result_id, record_id, service_date, transport_number, expense_number, remesa_code, manifest,
           status, review_code, review_detail, weight_source, gallons, tariff, current_weight, current_total, target_value, reason, lines, idempotency_key,
           rules_version, auto_eligible, auto_reasons, generated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25::jsonb,$26)`,
        [id, s.service_id, s.authorization_id, s.rid, s.chosen_record_id, s.service_date, s.transport_number, s.expense_number, s.remesa_code, s.manifest,
          status, reviewCode, reviewDetail, weightSource, gallons, t.ok ? t.tariff : null, curW, curT, target, reason, JSON.stringify(lines), key,
          ADJUST_RULES_VERSION, elig.eligible, JSON.stringify(elig.reasons), actor],
      );
      await addEvent(tx, id, actor, 'generated', null, status, false, { reviewCode, weightSource });
      sum.created += 1;
    });
  }
  await audit(db, actor, 'adjustment.generate', 'reconciliation_run', runId, { ...sum });
  log('adjust.generate', { runId, created: sum.created, needsReview: sum.needsReview });
  return sum;
}

// ---- Acciones --------------------------------------------------------------------------------------------
export async function approveProposal(db: Db, actor: string, id: string): Promise<ProposalDto> {
  const row = await loadRow(db, id);
  if (row.status === 'needs_review') throw new AppError(409, 'NEEDS_REVIEW', `La propuesta requiere revisión (${row.review_code}) y no se puede aprobar`);
  const r = await move(db, id, ['proposed'], 'approved', actor, 'approved', { approved_by: actor, approved_at: new Date().toISOString() });
  if (!r) throw new AppError(409, 'INVALID_TRANSITION', `No se puede aprobar una propuesta en estado ${row.status}`);
  await audit(db, actor, 'adjustment.approve', 'adjustment_proposal', id, {});
  return getProposal(db, id);
}

export async function rejectProposal(db: Db, actor: string, id: string, reason?: unknown): Promise<ProposalDto> {
  const row = await loadRow(db, id);
  const why = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  const r = await move(db, id, ['proposed', 'needs_review', 'approved', 'failed'], 'rejected', actor, 'rejected', {}, why ? { reason: why } : {});
  if (!r) throw new AppError(409, 'INVALID_TRANSITION', `No se puede rechazar una propuesta en estado ${row.status}`);
  await audit(db, actor, 'adjustment.reject', 'adjustment_proposal', id, {});
  return getProposal(db, id);
}

async function adjustAccount(db: Db): Promise<string | null> {
  const r = await db.query<{ silog_user: string }>(`select silog_user from silog_credentials where purpose = 'adjust'`);
  return r.rows[0]?.silog_user ?? null;
}

function changeOf(p: ProposalRow): TariffChange {
  return { remesaCode: p.remesa_code as string, reason: p.reason as string, pesoRemesa: clean(p.gallons) as string, cantidadRemesa: (clean(p.quantity) ?? clean(p.gallons)) as string, nuevaTarifa: p.tariff as string };
}

/** Qué se enviaría exactamente. No escribe ni cambia estado. */
export async function simulateProposal(deps: AdjustDeps, actor: string, id: string): Promise<ApplyPreviewDto> {
  const p = await loadRow(deps.db, id);
  const account = await adjustAccount(deps.db);
  let blocked: string | null = null;
  if (p.status === 'needs_review') blocked = `Requiere revisión (${p.review_code})`;
  else if (!['proposed', 'approved', 'failed'].includes(p.status)) blocked = `Estado ${p.status}: no se aplicaría`;
  else if (deps.writer.kind === 'web' && !account) blocked = 'ADJUST_ACCOUNT_NOT_CONFIGURED';
  else if (deps.writer.kind === 'web' && !deps.allow?.all && !deps.allow?.list.includes(normRemesa(p.remesa_code ?? ''))) blocked = 'REMESA_NOT_ALLOWED';
  await audit(deps.db, actor, 'adjustment.simulate', 'adjustment_proposal', id, {});
  return {
    proposalId: id, simulated: deps.writer.simulated, writerKind: deps.writer.kind, accountUser: account, accountConfigured: !!account, blocked,
    payload: p.tariff && p.remesa_code ? changeOf(p) : null,
  };
}

async function readFresh(deps: AdjustDeps, p: ProposalRow): Promise<SilogRecordInput | null> {
  if (!deps.silog) throw new AppError(409, 'SILOG_NOT_CONFIGURED', 'Silogtran (lectura) no está configurado: no se puede verificar el registro');
  const rec = await deps.db.query<{ dispatch_date: string; client_nit: string }>(
    `select to_char(dispatch_date,'YYYY-MM-DD') as dispatch_date, client_nit from silogtran_records where id = $1`, [p.record_id],
  );
  const r = rec.rows[0];
  if (!r) return null;
  let raw;
  try {
    raw = await deps.silog.fetchReport(r.dispatch_date, r.dispatch_date);
  } catch {
    throw new AppError(502, 'SILOG_UNAVAILABLE', 'No se pudo releer el registro en Silogtran');
  }
  const { kept } = dedupeAndFilter(raw, (await loadSettings(deps.db)).terpelNit);
  return kept.find((k) => k.manifest === p.manifest && k.remesa_code === p.remesa_code) ?? null;
}

const same = (a: unknown, b: unknown): boolean => {
  const x = normalizeNumberString(a === null || a === undefined ? null : String(a));
  const y = normalizeNumberString(b === null || b === undefined ? null : String(b));
  return x !== null && y !== null && x === y;
};

function verify(fresh: SilogRecordInput | null, p: ProposalRow): { ok: boolean; weight: unknown; total: unknown } {
  return { ok: !!fresh && same(fresh.remesa_weight, p.gallons) && same(fresh.total_remesa, p.target_value), weight: fresh?.remesa_weight ?? null, total: fresh?.total_remesa ?? null };
}

export interface ApplyOutcome { proposal: ProposalDto }

const sha = (o: unknown): string => createHash('sha256').update(JSON.stringify(o)).digest('hex');
export const payloadHash = (c: TariffChange): string => sha([c.remesaCode.replace(/\D/g, '').replace(/^0+/, ''), c.reason, c.pesoRemesa, c.cantidadRemesa, c.nuevaTarifa]);

/** Pasa a 'uncertain' las aplicaciones cuyo lease venció (la petición se cortó a mitad de camino). */
export async function sweepExpiredLeases(db: Db): Promise<void> {
  const r = await db.query<{ id: string }>(`select id from adjustment_proposals where status = 'applying' and lease_until < now()`);
  for (const x of r.rows) await move(db, x.id, ['applying'], 'uncertain', null, 'lease_expired', { lease_until: null }, { note: 'La aplicación quedó sin respuesta: consulte el estado antes de reintentar' });
}

function checkAllowed(deps: AdjustDeps, p: ProposalRow): void {
  if (deps.writer.kind !== 'web') return;
  const code = normRemesa(p.remesa_code ?? '');
  if (!deps.allow?.all && !deps.allow?.list.includes(code)) {
    throw new AppError(409, 'REMESA_NOT_ALLOWED', `La remesa ${p.remesa_code ?? ''} no está en la lista de remesas permitidas para escritura real (Parámetros → Ajustes)`);
  }
}

async function lastRehearsal(db: Db, id: string, hash: string): Promise<{ before: ScreenValues | null } | null> {
  const r = await db.query<{ detail: { payloadHash?: string; before?: ScreenValues | null; allChecksOk?: boolean; writer?: string } }>(
    `select detail from adjustment_events where proposal_id = $1 and event = 'rehearsed' and at > now() - interval '24 hours' order by id desc limit 1`, [id],
  );
  const d = r.rows[0]?.detail;
  return d && d.writer === 'web' && d.payloadHash === hash && d.allChecksOk ? { before: d.before ?? null } : null;
}

/** Ensayo: todos los pasos menos Grabar. Registra el evento `rehearsed` y NO cambia el estado de la propuesta. */
export async function rehearseProposal(deps: AdjustDeps, actor: string, id: string): Promise<RehearsalDto> {
  const p = await loadRow(deps.db, id);
  if (!p.tariff || !p.remesa_code || p.status === 'needs_review') throw new AppError(409, 'NEEDS_REVIEW', 'La propuesta requiere revisión: no se puede ensayar');
  if (!['proposed', 'approved', 'failed'].includes(p.status)) throw new AppError(409, 'INVALID_TRANSITION', `No se ensaya una propuesta en estado ${p.status}`);
  checkAllowed(deps, p);
  const change = changeOf(p);
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  // (a) El registro del informe sigue siendo el esperado (CUMPLIDO, sin factura, mismos valores).
  if (deps.silog) {
    const fresh = await readFresh(deps, p);
    const why = staleWhy(fresh, p);
    checks.push({ name: 'registro del informe vigente (CUMPLIDO, sin factura, mismos valores)', ok: !why, detail: why ?? undefined });
  } else checks.push({ name: 'registro del informe vigente', ok: false, detail: 'Silogtran (lectura) no está configurado' });
  // (b) Pantalla: todos los pasos menos Grabar.
  const res: RehearsalResult = await deps.writer.rehearse(change, { actor });
  checks.push(...res.checks);
  const allChecksOk = checks.every((c) => c.ok);
  await addEvent(deps.db, id, actor, 'rehearsed', p.status, p.status, res.simulated, { payloadHash: payloadHash(change), payload: change, before: res.before, checks, allChecksOk, writer: deps.writer.kind });
  await audit(deps.db, actor, 'adjustment.rehearse', 'adjustment_proposal', id, { ok: allChecksOk, writer: deps.writer.kind });
  return { proposalId: id, simulated: res.simulated, writerKind: deps.writer.kind, payload: change, before: res.before, checks, allChecksOk, wouldPostGrabar: false };
}

function staleWhy(fresh: SilogRecordInput | null, claimed: ProposalRow): string | null {
  return !fresh ? 'El registro ya no aparece en Silogtran'
    : fresh.status !== 'CUMPLIDO' ? 'El registro ya no está CUMPLIDO'
    : fresh.invoice ? 'El registro ya tiene factura'
    : !same(fresh.remesa_weight, claimed.current_weight) || !same(fresh.total_remesa, claimed.current_total) ? 'Los valores de Silogtran cambiaron desde la propuesta'
    : null;
}

/** Aplica UNA propuesta aprobada. Idempotente: el compare-and-set a 'applying' deja pasar a una sola petición. */
export async function applyProposal(deps: AdjustDeps, actor: string, id: string): Promise<ApplyOutcome> {
  const db = deps.db;
  await sweepExpiredLeases(db);
  const before = await loadRow(db, id);
  if (before.status === 'uncertain') throw new AppError(409, 'UNCERTAIN', 'La aplicación quedó con resultado incierto: use "Consultar estado" antes de reintentar');
  const account = await adjustAccount(db);
  if (deps.writer.kind === 'web' && !account) {
    throw new AppError(409, 'ADJUST_ACCOUNT_NOT_CONFIGURED', 'No hay cuenta de ajustes configurada (Usuarios → Cuenta de ajustes)');
  }
  if (!before.tariff || !before.remesa_code || before.status === 'needs_review') {
    throw new AppError(409, 'NEEDS_REVIEW', 'La propuesta requiere revisión y no se puede aplicar');
  }
  checkAllowed(deps, before);
  let expectedBefore: ScreenValues | null = null;
  if (deps.writer.kind === 'web') {
    const rh = await lastRehearsal(db, id, payloadHash(changeOf(before)));
    if (!rh) throw new AppError(409, 'REHEARSAL_REQUIRED', 'Antes de la escritura real hay que hacer el ensayo de esta propuesta (sin cambios pendientes) y que pase todas las comprobaciones');
    expectedBefore = rh.before;
  }
  const prev = before.status;
  const claimed = await move(db, id, ['approved', 'failed'], 'applying', actor, 'apply_started', {
    lease_until: new Date(Date.now() + 120_000).toISOString(), applied_by: actor, writer_kind: deps.writer.kind, account_user: account, simulated: deps.writer.simulated,
  }, { writer: deps.writer.kind, account });
  if (!claimed) {
    const cur = (await loadRow(db, id)).status;
    if (cur === 'applying') throw new AppError(409, 'ALREADY_APPLYING', 'Esta propuesta ya se está aplicando');
    if (cur === 'applied' || cur === 'simulated_applied') throw new AppError(409, 'ALREADY_APPLIED', 'Este cambio ya fue aplicado: no se aplica dos veces');
    throw new AppError(409, 'INVALID_TRANSITION', `No se puede aplicar una propuesta en estado ${cur}; debe estar aprobada`);
  }
  const revert = async (event: string, detail: Record<string, unknown>): Promise<void> => {
    await move(db, id, ['applying'], prev === 'failed' ? 'failed' : 'approved', actor, event, { lease_until: null }, detail);
  };

  // 1) Releer en Silogtran: debe seguir CUMPLIDO, sin factura y con los valores de la propuesta.
  let fresh: SilogRecordInput | null;
  try {
    fresh = await readFresh(deps, claimed);
  } catch (e) {
    await revert('precheck_failed', { code: e instanceof AppError ? e.code : 'ERROR' });
    throw e;
  }
  const staleReason = claimed.kind === 'reversal' ? null : staleWhy(fresh, claimed);
  if (staleReason) {
    await move(db, id, ['applying'], 'stale', actor, 'stale', { lease_until: null, last_error: staleReason }, { reason: staleReason });
    return { proposal: await getProposal(db, id) };
  }

  // 2) Escribir (nunca con reintento ciego).
  let result;
  try {
    result = await deps.writer.changeTariff(changeOf(claimed), { actor, expectedBefore });
  } catch (e) {
    await revert('writer_unavailable', { code: e instanceof AppError || e instanceof SilogWebError ? e.code : 'ERROR' });
    throw e instanceof SilogWebError ? new AppError(e.status, e.code, e.message) : e;
  }
  const reversal = 'before' in result && result.before ? { reversal_values: result.before } : {};
  if (result.outcome === 'stale') {
    await move(db, id, ['applying'], 'stale', actor, 'stale', { lease_until: null, last_error: result.detail, ...reversal }, { reason: result.detail, before: result.before ?? null });
  } else if (result.outcome === 'rejected' || result.outcome === 'conflict') {
    await move(db, id, ['applying'], 'failed', actor, result.outcome, { lease_until: null, last_error: result.detail, ...reversal }, { detail: result.detail });
  } else if (result.outcome === 'uncertain') {
    await move(db, id, ['applying'], 'uncertain', actor, 'uncertain', { lease_until: null, last_error: result.detail, ...reversal }, { detail: result.detail, before: result.before ?? null });
  } else {
    if (reversal.reversal_values) await db.query('update adjustment_proposals set reversal_values = $2::jsonb where id = $1', [id, JSON.stringify(reversal.reversal_values)]);
    await finalizeApplied(deps, actor, { ...claimed, reversal_values: (reversal.reversal_values as ScreenValues | undefined) ?? claimed.reversal_values });
  }
  await audit(db, actor, 'adjustment.apply', 'adjustment_proposal', id, { simulated: deps.writer.simulated, outcome: result.outcome, writer: deps.writer.kind });
  return { proposal: await getProposal(db, id) };
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function finalizeApplied(deps: AdjustDeps, actor: string, p: ProposalRow): Promise<void> {
  const now = new Date().toISOString();
  if (deps.writer.simulated) {
    await move(deps.db, p.id, ['applying', 'uncertain'], 'simulated_applied', actor, 'simulated_applied', {
      lease_until: null, applied_at: now, verification: { skipped: true, note: 'simulado: Silogtran no fue modificado' },
    }, { note: 'simulado' });
    return;
  }
  if (p.kind === 'reversal') {
    // La reversa se verifica en la pantalla (el informe no tiene un valor de referencia estable).
    const st = await deps.writer.getChangeState(p.remesa_code as string, changeOf(p), { actor, expectedBefore: null });
    await move(deps.db, p.id, ['applying', 'uncertain'], st === 'applied' ? 'applied' : 'verification_failed', actor, st === 'applied' ? 'applied' : 'verification_failed', {
      lease_until: null, applied_at: now, verification: { screen: st }, ...(st === 'applied' ? {} : { last_error: 'No se pudo confirmar la reversa en la pantalla' }),
    }, { screen: st });
    return;
  }
  // Informe: hasta 3 lecturas separadas por unos segundos (el informe puede tardar en reflejar el cambio).
  const delay = deps.verifyDelayMs ?? 4000;
  let v = verify(await readFresh(deps, p), p);
  for (let i = 0; i < 2 && !v.ok; i += 1) {
    await sleep(delay);
    v = verify(await readFresh(deps, p), p);
  }
  if (v.ok) {
    await move(deps.db, p.id, ['applying', 'uncertain'], 'applied', actor, 'applied', { lease_until: null, applied_at: now, verification: { ok: true } }, { weight: v.weight, total: v.total });
  } else {
    await move(deps.db, p.id, ['applying', 'uncertain'], 'verification_failed', actor, 'verification_failed', {
      lease_until: null, applied_at: now, verification: { ok: false, weight: v.weight, total: v.total }, last_error: 'La verificación posterior no coincide: no se factura',
    }, { weight: v.weight, total: v.total });
  }
}

/** Resuelve un 'uncertain' CONSULTANDO el estado antes de cualquier reintento. */
export async function checkUncertain(deps: AdjustDeps, actor: string, id: string): Promise<ProposalDto> {
  await sweepExpiredLeases(deps.db);
  const p = await loadRow(deps.db, id);
  if (p.status !== 'uncertain') throw new AppError(409, 'INVALID_TRANSITION', `Solo se consulta el estado de propuestas inciertas (estado ${p.status})`);
  const state = await deps.writer.getChangeState(p.remesa_code as string, changeOf(p), { actor, expectedBefore: p.reversal_values });
  if (state === 'applied') await finalizeApplied(deps, actor, p);
  else if (state === 'not_applied') await move(deps.db, id, ['uncertain'], 'failed', actor, 'checked_not_applied', { last_error: 'Confirmado: el cambio no se aplicó' }, {});
  else await addEvent(deps.db, id, actor, 'check_unknown', 'uncertain', 'uncertain', p.simulated, {});
  await audit(deps.db, actor, 'adjustment.check', 'adjustment_proposal', id, { state });
  return getProposal(deps.db, id);
}

/** Crea una propuesta de REVERSA (valores anteriores de la pantalla) sujeta a aprobación como cualquier otra. */
export async function revertProposal(deps: AdjustDeps, actor: string, id: string): Promise<ProposalDto> {
  const o = await loadRow(deps.db, id);
  if (o.kind !== 'adjust') throw new AppError(409, 'NOT_REVERTIBLE', 'Una reversa no se revierte');
  if (o.simulated || !['applied', 'verification_failed', 'uncertain'].includes(o.status)) throw new AppError(409, 'NOT_REVERTIBLE', 'Solo se revierten ajustes REALES aplicados (o con verificación fallida/incierta)');
  const rv = o.reversal_values;
  if (!rv) throw new AppError(409, 'NO_REVERSAL_VALUES', 'No hay valores anteriores guardados para revertir');
  const key = sha(['rev', o.id]);
  const ex = await deps.db.query<{ id: string }>('select id from adjustment_proposals where idempotency_key = $1', [key]);
  if (ex.rows[0]) return getProposal(deps.db, ex.rows[0].id);
  const peso = normalizeNumberString(rv.peso);
  const cant = normalizeNumberString(rv.cantidad);
  const tar = normalizeNumberString(rv.tarifa);
  const bad = !peso || !cant || !tar || tar.length > 12;
  const reason = `Reversa de ajuste de tarifa, transporte ${o.transport_number}`.slice(0, MAX_REASON);
  const lines: ProposalLineDto[] = [
    { field: 'pesoRemesa', label: 'Peso Remesa', current: normalizeNumberString(o.gallons), proposed: peso, rule: 'Reversa: peso anterior de la pantalla' },
    { field: 'cantidadRemesa', label: 'Cantidad Remesa', current: normalizeNumberString(o.gallons), proposed: cant, rule: 'Reversa: cantidad anterior de la pantalla' },
    { field: 'nuevaTarifa', label: 'Nueva Tarifa', current: o.tariff, proposed: tar, rule: 'Reversa: tarifa anterior de la pantalla' },
    { field: 'totalRemesa', label: 'Total de la remesa', current: normalizeNumberString(o.target_value), proposed: null, rule: 'Se recalcula en Silogtran con los valores anteriores' },
  ];
  const newId = randomUUID();
  await deps.db.transaction(async (tx) => {
    await tx.query(
      `insert into adjustment_proposals (id, service_id, authorization_id, recon_result_id, record_id, service_date, transport_number, expense_number, remesa_code, manifest,
         status, review_code, review_detail, weight_source, gallons, quantity, tariff, current_weight, current_total, target_value, reason, lines, idempotency_key,
         rules_version, generated_by, kind, reversal_of)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,'reversal',$26)`,
      [newId, o.service_id, o.authorization_id, o.recon_result_id, o.record_id, o.service_date, o.transport_number, o.expense_number, o.remesa_code, o.manifest,
        bad ? 'needs_review' : 'proposed', bad ? 'INVALID_INPUT' : null, bad ? 'Valores anteriores ilegibles' : null, null, peso, cant, tar, normalizeNumberString(o.gallons), normalizeNumberString(o.target_value), null, reason,
        JSON.stringify(lines), key, ADJUST_RULES_VERSION, actor, o.id],
    );
    await addEvent(tx, newId, actor, 'generated', null, bad ? 'needs_review' : 'proposed', false, { reversalOf: o.id, restores: rv });
    await addEvent(tx, o.id, actor, 'reversal_created', o.status, o.status, false, { reversalProposal: newId, restores: rv });
  });
  await audit(deps.db, actor, 'adjustment.revert', 'adjustment_proposal', id, { reversal: newId });
  return getProposal(deps.db, newId);
}

export interface BatchResult { id: string; ok: boolean; status?: ProposalStatus; code?: string; message?: string }

export async function applyBatch(deps: AdjustDeps, actor: string, ids: string[]): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const id of ids) {
    try {
      const r = await applyProposal(deps, actor, id);
      out.push({ id, ok: r.proposal.status === 'applied' || r.proposal.status === 'simulated_applied', status: r.proposal.status });
    } catch (e) {
      if (e instanceof AppError) out.push({ id, ok: false, code: e.code, message: e.message });
      else out.push({ id, ok: false, code: 'INTERNAL', message: 'Error interno' });
    }
  }
  return out;
}

/** Acción de admin: descarta las aplicaciones simuladas (queda el historial). */
export async function discardSimulated(db: Db, actor: string): Promise<number> {
  const ids = await db.query<{ id: string }>(`select id from adjustment_proposals where status = 'simulated_applied'`);
  let n = 0;
  for (const r of ids.rows) {
    if (await move(db, r.id, ['simulated_applied'], 'discarded', actor, 'discarded', {}, { note: 'simulación descartada' })) n += 1;
  }
  await audit(db, actor, 'adjustment.discard_simulated', 'adjustment_proposal', 'all', { count: n });
  return n;
}

export { move as _moveForTests };
