import { createHash, randomUUID } from 'node:crypto';
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db/types.js';
import { sqlState } from '../db/types.js';
import { AppError } from '../errors.js';
import { log } from '../logger.js';
import { normalizePlace } from '../recon/normalize.js';
import { dedupeAndFilter } from '../recon/silogtran.js';
import type { SilogtranSource } from '../recon/silogtran.js';
import { loadSettings as loadReconSettings } from '../recon/service.js';
import type { HomeReader } from '../adjust/service.js';
import { SilogWebError } from '../silog/web/errors.js';
import type { RemesaState } from '../silog/web/remesa.js';
import type { StorageAdapter } from '../storage/types.js';
import type {
  InvoiceAmountsDto, InvoiceDto, InvoiceExcludedDto, InvoicePlanDto, InvoiceRehearsalDto, InvoiceSettingsDto, InvoiceStatus, InvoiceWriterStatusDto,
} from '../types.js';
import { computeAmounts } from './writer.js';
import type { InvoiceRequest, InvoiceWriter } from './writer.js';

export const INVOICE_RULES_VERSION = 'invoice-1.0.0';
const MAX_OBSERVATION = 176;

export interface InvoiceDeps {
  db: Db;
  storage: StorageAdapter;
  silog: SilogtranSource | null;
  writer: InvoiceWriter;
  allow?: { all: boolean; list: string[] };
  batchEnabled?: boolean;
  /** Lectura de la consulta de la remesa (producto). */
  homeReader?: HomeReader | null;
  /** Espera entre lecturas del informe tras emitir (por defecto 3 s; las pruebas usan 0). */
  verifyDelayMs?: number;
}

// ---- Máquina de estados ----------------------------------------------------------------------------------
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  eligible: ['rehearsed', 'skipped', 'discarded'],
  rehearsed: ['issuing', 'skipped', 'discarded', 'eligible'],
  skipped: ['eligible', 'rehearsed'],
  issuing: ['issued', 'simulated', 'failed', 'uncertain', 'verification_failed', 'rehearsed', 'skipped'],
  failed: ['issuing', 'skipped', 'eligible', 'rehearsed'],
  uncertain: ['issued', 'failed', 'verification_failed'],
  issued: [],
  verification_failed: [],
  simulated: ['discarded'],
  discarded: ['eligible'],
};
export const canInvoiceTransition = (from: InvoiceStatus, to: InvoiceStatus): boolean => INVOICE_TRANSITIONS[from].includes(to);

// ---- Parámetros -------------------------------------------------------------------------------------------
const PLACEHOLDERS = ['product', 'origin', 'destination', 'transport', 'serviceEntrySheet', 'remesa'];
export function validateObservationTemplate(t: unknown): string {
  if (typeof t !== 'string' || t.trim() === '') throw new AppError(400, 'INVALID_FIELD', 'La plantilla de observación no puede estar vacía');
  const s = t.trim();
  // eslint-disable-next-line no-control-regex
  if (s.length > 140 || /[\u0000-\u001f]/.test(s)) throw new AppError(400, 'INVALID_FIELD', 'La plantilla de observación es demasiado larga o tiene caracteres de control');
  for (const f of s.match(/\{[^}]*\}/g) ?? []) {
    if (!PLACEHOLDERS.includes(f.slice(1, -1))) throw new AppError(400, 'INVALID_PLACEHOLDER', `Marcador no permitido ${f}. Permitidos: ${PLACEHOLDERS.map((x) => `{${x}}`).join(', ')}`);
  }
  if (s.replace(/\{[^}]*\}/g, '').match(/[{}]/)) throw new AppError(400, 'INVALID_PLACEHOLDER', 'Llaves sin cerrar en la plantilla');
  return s;
}

/** Producto TAL CUAL lo muestra la consulta de la remesa (Home_111): solo se recortan los espacios extremos y se colapsan los múltiples. NO se tocan guiones ni mayúsculas. */
export const cleanProduct = (raw: string | null | undefined): string => (raw ?? '').replace(/\s+/g, ' ').trim();

/** Observación en mayúsculas con espacios simples; se trunca a 176 caracteres en límite de palabra (devuelve el aviso). */
export function renderObservation(template: string, v: { product: string; origin: string; destination: string; transport: string; serviceEntrySheet: string | null; remesa: string }): { text: string; truncated: boolean } {
  const val: Record<string, string> = { product: v.product, origin: v.origin.toUpperCase(), destination: v.destination.toUpperCase(), transport: v.transport.toUpperCase(), serviceEntrySheet: (v.serviceEntrySheet ?? '').toUpperCase(), remesa: v.remesa };
  // El texto fijo de la plantilla va en mayúsculas; el producto se inserta verbatim.
  const full = template.split(/(\{[^}]*\})/).map((part) => (/^\{[^}]*\}$/.test(part) ? (val[part.slice(1, -1)] ?? '') : part.toUpperCase())).join('').replace(/\s+/g, ' ').trim();
  if (full.length <= MAX_OBSERVATION) return { text: full, truncated: false };
  const cut = full.slice(0, MAX_OBSERVATION);
  const sp = cut.lastIndexOf(' ');
  return { text: (sp > 100 ? cut.slice(0, sp) : cut).trim(), truncated: true };
}

interface SettingsRow {
  cost_center: string; client: string; printable_name: string; seller: string; payment_days: number; payment_city: string; currency: string; payment_method: string;
  invoice_type: string; divide: 'SI' | 'NO'; max_remesas: number; withholding_percent: string; observation_template: string; writer_mode: 'mock' | 'web' | null;
  writer_allowlist: string[]; writer_allow_all: boolean; batch_enabled: boolean;
}

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettingsDto = {
  costCenter: 'PRINCIPAL', client: 'ORGANIZACION TERPEL S.A', printableName: 'ORGANIZACION TERPEL S.A', seller: 'CS', paymentDays: 15, paymentCity: 'SANTA MARTA', currency: 'PESOS',
  paymentMethod: 'CUENTA CORRIENTE', invoiceType: 'CLIENTES', divide: 'NO', maxRemesas: 30, withholdingPercent: 1,
  observationTemplate: 'SERVICIO DE TRANSPORTE {product} {origin} - {destination} {transport} {serviceEntrySheet}', writerMode: 'mock', writerAllowlist: [], writerAllowAll: false, batchEnabled: false,
};

export async function getInvoiceSettings(q: Queryable): Promise<InvoiceSettingsDto> {
  const r = await q.query<SettingsRow>(
    `select cost_center, client, printable_name, seller, payment_days, payment_city, currency, payment_method, invoice_type, divide, max_remesas, withholding_percent::text as withholding_percent,
            observation_template, writer_mode, writer_allowlist, writer_allow_all, batch_enabled from invoice_settings limit 1`,
  );
  const x = r.rows[0];
  if (!x) return DEFAULT_INVOICE_SETTINGS;
  return {
    costCenter: x.cost_center, client: x.client, printableName: x.printable_name, seller: x.seller, paymentDays: x.payment_days, paymentCity: x.payment_city, currency: x.currency,
    paymentMethod: x.payment_method, invoiceType: x.invoice_type, divide: x.divide, maxRemesas: x.max_remesas, withholdingPercent: Number(x.withholding_percent),
    observationTemplate: x.observation_template, writerMode: x.writer_mode ?? 'mock', writerAllowlist: x.writer_allowlist, writerAllowAll: x.writer_allow_all, batchEnabled: x.batch_enabled,
  };
}

export const invoiceWriterStatus = (s: InvoiceSettingsDto): InvoiceWriterStatusDto => ({ mode: s.writerMode, simulated: s.writerMode !== 'web', allowAll: s.writerAllowAll, allowlist: s.writerAllowlist, batchEnabled: s.batchEnabled });

const normRemesa = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const text = (v: unknown, name: string, max = 80): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new AppError(400, 'INVALID_FIELD', `Campo inválido: ${name}`);
  return v.trim();
};

export async function saveInvoiceSettings(db: Db, actor: string, input: Record<string, unknown>): Promise<InvoiceSettingsDto> {
  const cur = await getInvoiceSettings(db);
  const pick = <T>(k: string, fn: (v: unknown) => T, d: T): T => (input[k] === undefined ? d : fn(input[k]));
  const int = (name: string, min: number, max: number) => (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new AppError(400, 'INVALID_FIELD', `Campo inválido: ${name}`);
    return v;
  };
  const next: InvoiceSettingsDto = {
    costCenter: pick('costCenter', (v) => text(v, 'costCenter'), cur.costCenter), client: pick('client', (v) => text(v, 'client'), cur.client),
    printableName: pick('printableName', (v) => text(v, 'printableName'), cur.printableName), seller: pick('seller', (v) => text(v, 'seller'), cur.seller),
    paymentDays: pick('paymentDays', int('paymentDays', 0, 365), cur.paymentDays), paymentCity: pick('paymentCity', (v) => text(v, 'paymentCity'), cur.paymentCity),
    currency: pick('currency', (v) => text(v, 'currency'), cur.currency), paymentMethod: pick('paymentMethod', (v) => text(v, 'paymentMethod'), cur.paymentMethod),
    invoiceType: pick('invoiceType', (v) => text(v, 'invoiceType'), cur.invoiceType),
    divide: pick('divide', (v) => { if (v !== 'SI' && v !== 'NO') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: divide'); return v; }, cur.divide),
    maxRemesas: pick('maxRemesas', int('maxRemesas', 1, 100), cur.maxRemesas),
    withholdingPercent: pick('withholdingPercent', (v) => { if (typeof v !== 'number' || !(v >= 0 && v <= 20)) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: withholdingPercent'); return v; }, cur.withholdingPercent),
    observationTemplate: pick('observationTemplate', validateObservationTemplate, cur.observationTemplate),
    writerMode: pick('writerMode', (v) => { if (v !== 'mock' && v !== 'web') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: writerMode'); return v; }, cur.writerMode),
    writerAllowlist: pick('writerAllowlist', (v) => {
      if (!Array.isArray(v) || v.length > 500) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: writerAllowlist');
      return [...new Set(v.map((x) => { if (typeof x !== 'string' || !/^\d{1,12}$/.test(x.trim())) throw new AppError(400, 'INVALID_FIELD', 'Cada remesa permitida debe ser numérica'); return normRemesa(x); }).filter(Boolean))];
    }, cur.writerAllowlist),
    writerAllowAll: pick('writerAllowAll', (v) => { if (typeof v !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: writerAllowAll'); return v; }, cur.writerAllowAll),
    batchEnabled: pick('batchEnabled', (v) => { if (typeof v !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: batchEnabled'); return v; }, cur.batchEnabled),
  };
  if (next.writerAllowAll && !cur.writerAllowAll && input.confirmAll !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Permitir la emisión real en TODAS las remesas exige confirmación explícita (confirmAll=true)');
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into invoice_settings (id, cost_center, client, printable_name, seller, payment_days, payment_city, currency, payment_method, invoice_type, divide, max_remesas, withholding_percent,
         observation_template, writer_mode, writer_allowlist, writer_allow_all, batch_enabled, updated_by)
       values (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16,$17,$18)
       on conflict (id) do update set cost_center=$1, client=$2, printable_name=$3, seller=$4, payment_days=$5, payment_city=$6, currency=$7, payment_method=$8, invoice_type=$9, divide=$10,
         max_remesas=$11, withholding_percent=$12, observation_template=$13, writer_mode=$14, writer_allowlist=$15::text[], writer_allow_all=$16, batch_enabled=$17, updated_by=$18, updated_at=now()`,
      [next.costCenter, next.client, next.printableName, next.seller, next.paymentDays, next.paymentCity, next.currency, next.paymentMethod, next.invoiceType, next.divide, next.maxRemesas,
        next.withholdingPercent, next.observationTemplate, next.writerMode, `{${next.writerAllowlist.join(',')}}`, next.writerAllowAll, next.batchEnabled, actor],
    );
    await audit(tx, actor, 'invoice_settings.update', 'invoice_settings', 'singleton', {
      writerMode: next.writerMode, allowlist: next.writerAllowlist, allowAll: next.writerAllowAll, batchEnabled: next.batchEnabled,
      writerChanged: next.writerMode !== cur.writerMode || next.writerAllowAll !== cur.writerAllowAll || next.writerAllowlist.join() !== cur.writerAllowlist.join() || next.batchEnabled !== cur.batchEnabled,
    });
  });
  return getInvoiceSettings(db);
}

// ---- Filas ---------------------------------------------------------------------------------------------------
interface InvoiceRow {
  id: string; service_id: string; authorization_id: string; record_id: string | null; remesa_code: string; transport_number: string; plate: string | null; service_date: string;
  terpel_value: string; observation: string | null; product: string | null; status: InvoiceStatus; review_code: string | null; review_detail: string | null; values_before: Record<string, unknown> | null;
  values_after: Record<string, unknown> | null; invoice_number: string | null; account_user: string | null; writer_kind: string | null; simulated: boolean; idempotency_key: string;
  issued_by: string | null; issued_at: Date | null; lease_until: Date | null; last_error: string | null; updated_at: Date;
}
const COLS = `id, service_id, authorization_id, record_id, remesa_code, transport_number, plate, to_char(service_date,'YYYY-MM-DD') as service_date, terpel_value::text as terpel_value, observation, product,
  status, review_code, review_detail, values_before, values_after, invoice_number, account_user, writer_kind, simulated, idempotency_key, issued_by, issued_at, lease_until, last_error, updated_at`;

const dec = (v: string): string => v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export const toInvoiceDto = (r: InvoiceRow): InvoiceDto => ({
  id: r.id, remesaCode: r.remesa_code, transportNumber: r.transport_number, plate: r.plate, serviceDate: r.service_date, terpelValue: dec(r.terpel_value), expectedFreight: dec(r.terpel_value),
  status: r.status, reviewCode: r.review_code, reviewDetail: r.review_detail, valuesBefore: r.values_before, valuesAfter: r.values_after, invoiceNumber: r.invoice_number,
  accountUser: r.account_user, writerKind: r.writer_kind, simulated: r.simulated, observation: r.observation, product: r.product, issuedBy: r.issued_by, issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
  lastError: r.last_error, updatedAt: new Date(r.updated_at).toISOString(),
});

export async function loadInvoice(q: Queryable, id: string): Promise<InvoiceRow> {
  const r = await q.query<InvoiceRow>(`select ${COLS} from invoices where id = $1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Factura no encontrada');
  return r.rows[0];
}
export const getInvoice = async (q: Queryable, id: string): Promise<InvoiceDto> => toInvoiceDto(await loadInvoice(q, id));

export async function getInvoiceEvents(q: Queryable, id: string): Promise<{ id: number; at: string; actor: string | null; event: string; fromStatus: string | null; toStatus: string | null; simulated: boolean; detail: Record<string, unknown> }[]> {
  const r = await q.query<{ id: string; at: Date; actor: string | null; event: string; from_status: string | null; to_status: string | null; simulated: boolean; detail: Record<string, unknown> }>(
    'select id, at, actor, event, from_status, to_status, simulated, detail from invoice_events where invoice_id = $1 order by id', [id],
  );
  return r.rows.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), actor: e.actor, event: e.event, fromStatus: e.from_status, toStatus: e.to_status, simulated: e.simulated, detail: e.detail }));
}

export async function addInvoiceEvent(q: Queryable, id: string, actor: string | null, event: string, from: string | null, to: string | null, simulated: boolean, detail: Record<string, unknown> = {}): Promise<void> {
  await q.query(`insert into invoice_events (invoice_id, actor, event, from_status, to_status, simulated, detail) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [id, actor, event, from, to, simulated, JSON.stringify(detail)]);
}

const SETTABLE = new Set(['review_code', 'review_detail', 'values_before', 'values_after', 'invoice_number', 'account_user', 'writer_kind', 'simulated', 'issued_by', 'issued_at', 'lease_until', 'last_error', 'observation', 'product']);

/** Transición atómica (compare-and-set sobre el estado) + evento en la misma transacción. */
export async function moveInvoice(db: Db, id: string, froms: InvoiceStatus[], to: InvoiceStatus, actor: string | null, event: string, set: Record<string, unknown> = {}, detail: Record<string, unknown> = {}): Promise<InvoiceRow | null> {
  for (const f of froms) if (!canInvoiceTransition(f, to)) throw new Error(`Transición inválida ${f} -> ${to}`);
  const cols = Object.keys(set);
  for (const c of cols) if (!SETTABLE.has(c)) throw new Error(`Columna no permitida ${c}`);
  const json = (c: string): boolean => c === 'values_before' || c === 'values_after';
  const sets = cols.map((c, i) => `${c} = $${i + 4}${json(c) ? '::jsonb' : ''}`);
  return db.transaction(async (tx) => {
    const prev = await tx.query<{ status: InvoiceStatus }>('select status from invoices where id = $1 for update', [id]);
    const from = prev.rows[0]?.status;
    if (!from || !froms.includes(from)) return null;
    const vals = cols.map((c) => (json(c) && set[c] !== null ? JSON.stringify(set[c]) : set[c]));
    const r = await tx.query<InvoiceRow>(`update invoices set status = $2, updated_at = now()${sets.length ? `, ${sets.join(', ')}` : ''} where id = $1 and status = $3 returning ${COLS}`, [id, to, from, ...vals]);
    const row = r.rows[0];
    if (!row) return null;
    await addInvoiceEvent(tx, id, actor, event, from, to, row.simulated, detail);
    return row;
  });
}

// ---- Plan / elegibilidad ---------------------------------------------------------------------------------------
interface CandRow {
  service_id: string; rid: string; rstatus: string; reason_code: string | null; sd: string; authorization_id: string; chosen_record_id: string | null; transport_number: string;
  net_value: string | null; vol: string | null; entry_sheet: string | null; route: string | null; remesa_code: string | null; plate: string | null; sstatus: string | null; invoice: string | null;
  client_nit: string | null; adj_status: string | null; origin: string | null; destination: string | null;
}

const EXCLUDED_TEXT: Record<string, string> = {
  volume_zero: 'Volumen 0 en Terpel: se espera corrección de Terpel', ambiguous: 'Varios despachos candidatos: elija uno en la bandeja de revisión',
  no_match: 'Sin registro en Silogtran (puede no estar despachado aún)', insufficient: 'Datos insuficientes para conciliar', adjustment_pending: 'Tiene diferencias y su ajuste no está aplicado y verificado',
  already_invoiced: 'Ya facturada', not_cumplido: 'El registro de Silogtran no está CUMPLIDO', incomplete: 'Faltan datos para facturar (hoja de entrada de servicio, valor o ruta)',
  not_terpel: 'El cliente del registro no es Terpel', not_allowed: 'Fuera de la lista de remesas permitidas para emisión real', attention: 'Hay una factura en curso o con resultado incierto',
};

export async function computeInvoicePlan(deps: InvoiceDeps, reconRunId: string, view = false): Promise<Omit<InvoicePlanDto, 'eligible'> & { candidates: (CandRow & { observation: string; product: string; warning: string | null })[] }> {
  const run = await deps.db.query<{ from: string; to: string; status: string }>(
    `select to_char(date_from,'YYYY-MM-DD') as "from", to_char(date_to,'YYYY-MM-DD') as "to", status from reconciliation_runs where id = $1`, [reconRunId],
  );
  const rr = run.rows[0];
  if (!rr) throw new AppError(404, 'RUN_NOT_FOUND', 'Conciliación no encontrada');
  if (rr.status !== 'completed') throw new AppError(409, 'RUN_NOT_COMPLETED', 'La conciliación aún no termina');
  const settings = await getInvoiceSettings(deps.db);
  const nit = (await loadReconSettings(deps.db)).terpelNit.replace(/\D/g, '');
  const rows = await deps.db.query<CandRow>(
    `select r.service_id, r.id as rid, r.status as rstatus, r.reason_code, to_char(r.service_date,'YYYY-MM-DD') as sd, r.authorization_id, r.chosen_record_id, a.transport_number,
            a.net_value::text as net_value, a.transport_volume::text as vol, a.service_entry_sheet as entry_sheet, a.route, s.remesa_code, s.plate, s.origin_city as origin, s.destination_city as destination, s.status as sstatus, s.invoice, s.client_nit,
            (select p.status from adjustment_proposals p where p.service_id = r.service_id and p.kind = 'adjust' and p.status not in ('stale','discarded','misapplied') order by p.created_at desc limit 1) as adj_status
       from reconciliation_results r join authorizations a on a.id = r.authorization_id left join silogtran_records s on s.id = r.chosen_record_id
      where r.service_date between $1 and $2 order by r.service_date, a.transport_number`, [rr.from, rr.to],
  );
  const active = await deps.db.query<{ remesa_code: string; status: string }>(`select remesa_code, status from invoices where status in ('issuing','issued','uncertain','verification_failed')`);
  const activeBy = new Map(active.rows.map((a) => [normRemesa(a.remesa_code), a.status]));
  const excluded: InvoiceExcludedDto[] = [];
  const candidates: (CandRow & { observation: string; product: string; warning: string | null })[] = [];
  const dupRemesa = new Set(
    rows.rows.filter((r) => r.remesa_code).map((r) => normRemesa(r.remesa_code)).filter((c, i, a) => a.indexOf(c) !== a.lastIndexOf(c)),
  );
  // Producto desde la CONSULTA de la remesa (Home_111), con la cuenta web (lectura).
  const wantHome = [...new Set(rows.rows.filter((r) => r.remesa_code && r.chosen_record_id && ['EXACT', 'MATCH_WITH_DIFFERENCES'].includes(r.rstatus)).map((r) => r.remesa_code as string))];
  const homes = deps.homeReader && !view ? await deps.homeReader.readMany(wantHome, null, 40_000) : new Map<string, RemesaState | { error: string }>();
  const ex = (category: string, r: CandRow, extra?: string): void => {
    excluded.push({ category, transportNumber: r.transport_number, remesaCode: r.remesa_code, reason: `${EXCLUDED_TEXT[category] ?? category}${extra ? `: ${extra}` : ''}` });
  };
  for (const r of rows.rows) {
    if (r.rstatus === 'AMBIGUOUS') { ex('ambiguous', r); continue; }
    if (r.rstatus === 'INSUFFICIENT_DATA') { ex(r.reason_code?.startsWith('ZERO_VOLUME') ? 'volume_zero' : 'insufficient', r); continue; }
    if (r.rstatus === 'NO_MATCH' || !r.chosen_record_id || !r.remesa_code) { ex('no_match', r); continue; }
    if (!(Number(r.vol) > 0)) { ex('volume_zero', r); continue; }
    if ((r.client_nit ?? '').replace(/\D/g, '') !== nit) { ex('not_terpel', r); continue; }
    if ((r.sstatus ?? '').toUpperCase() !== 'CUMPLIDO') { ex('not_cumplido', r); continue; }
    const act = activeBy.get(normRemesa(r.remesa_code));
    if ((r.invoice ?? '') !== '' || act === 'issued') { ex('already_invoiced', r, r.invoice ? `factura ${r.invoice}` : undefined); continue; }
    if (act) { ex('attention', r, `estado ${act}`); continue; }
    if (r.rstatus !== 'EXACT' && r.adj_status !== 'applied') { ex('adjustment_pending', r, r.adj_status ? `ajuste en estado ${r.adj_status}` : 'sin ajuste'); continue; }
    const nv = (r.net_value ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const home = homes.get(r.remesa_code);
    const product = cleanProduct(home && !('error' in home) ? home.producto : null);
    const missing = [
      !product && !view ? (home && 'error' in home ? `producto (no se pudo leer la consulta: ${home.error})` : 'producto') : null, !(r.origin ?? '').trim() ? 'origen' : null, !(r.destination ?? '').trim() ? 'destino' : null,
      !r.transport_number ? 'número de transporte' : null, !r.entry_sheet ? 'hoja de entrada de servicio' : null, !/^\d+(\.\d+)?$/.test(nv) || Number(nv) <= 0 ? 'valor neto' : null,
    ].filter(Boolean);
    if (missing.length > 0) { ex('incomplete', r, `falta ${missing.join(', ')}`); continue; }
    if (dupRemesa.has(normRemesa(r.remesa_code))) { ex('ambiguous', r, 'la remesa está asignada a más de un servicio de Terpel'); continue; }
    if (deps.writer.kind === 'web' && !deps.allow?.all && !deps.allow?.list.includes(normRemesa(r.remesa_code))) { ex('not_allowed', r); continue; }
    const obs = renderObservation(settings.observationTemplate, { product, origin: (r.origin ?? '').trim().toUpperCase(), destination: (r.destination ?? '').trim().toUpperCase(), transport: r.transport_number, serviceEntrySheet: r.entry_sheet, remesa: r.remesa_code });
    const observation = obs.text;
    const warning = obs.truncated ? `Observación truncada a ${MAX_OBSERVATION} caracteres` : null;
    candidates.push({ ...r, net_value: nv, observation, product, warning } as CandRow & { observation: string; product: string; warning: string | null });
  }
  return { reconRunId, writer: invoiceWriterStatus({ ...settings, writerMode: deps.writer.kind === 'web' ? 'web' : 'mock' }), excluded, candidates };
}

const keyOf = (c: { service_id: string; authorization_id: string; remesa_code: string | null; net_value: string | null }): string =>
  createHash('sha256').update(`inv|${c.service_id}|${c.authorization_id}|${normRemesa(c.remesa_code)}|${c.net_value}`).digest('hex');

/** Plan sin efectos sobre Silogtran: crea (idempotente) las filas `eligible` para las remesas elegibles. */
export async function buildInvoicePlan(deps: InvoiceDeps, reconRunId: string, actor: string): Promise<InvoicePlanDto> {
  const plan = await computeInvoicePlan(deps, reconRunId);
  const eligible: InvoiceDto[] = [];
  for (const c of plan.candidates) {
    const key = keyOf(c);
    const ex = await deps.db.query<{ id: string; status: InvoiceStatus }>('select id, status from invoices where idempotency_key = $1', [key]);
    let id = ex.rows[0]?.id;
    if (!id) {
      id = randomUUID();
      await deps.db.transaction(async (tx) => {
        await tx.query(
          `insert into invoices (id, service_id, authorization_id, recon_result_id, record_id, remesa_code, transport_number, plate, service_date, terpel_value, observation, product, review_detail, status, idempotency_key, generated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$15,$12,'eligible',$13,$14)`,
          [id, c.service_id, c.authorization_id, c.rid, c.chosen_record_id, c.remesa_code, c.transport_number, c.plate, c.sd, c.net_value, c.observation, c.warning, key, actor, c.product],
        );
        await addInvoiceEvent(tx, id as string, actor, 'planned', null, 'eligible', false, { rules: INVOICE_RULES_VERSION });
      });
    } else if (['eligible', 'rehearsed', 'failed'].includes(ex.rows[0]?.status as string)) {
      // Refresca observación/producto (p. ej. tras una corrección de reglas); un ensayo previo con otro contenido deja de ser vigente.
      const cur = await loadInvoice(deps.db, id);
      if (cur.observation !== c.observation || cur.product !== c.product) {
        if (cur.status === 'rehearsed') await moveInvoice(deps.db, id, ['rehearsed'], 'eligible', actor, 'replanned', { observation: c.observation, product: c.product, review_detail: c.warning }, { note: 'cambió la observación o el producto: se exige un nuevo ensayo' });
        else await deps.db.query('update invoices set observation = $2, product = $3, review_detail = $4, updated_at = now() where id = $1', [id, c.observation, c.product, c.warning]);
      }
    } else if (ex.rows[0]?.status === 'simulated' && deps.writer.kind === 'web') {
      // Una factura SIMULADA no cuenta como emitida: con el escritor real vuelve a ser elegible.
      await moveInvoice(deps.db, id, ['simulated'], 'discarded', actor, 'simulation_discarded', {}, { note: 'simulación descartada al planificar con escritor real' });
      await moveInvoice(deps.db, id, ['discarded'], 'eligible', actor, 'replanned', { observation: c.observation, product: c.product, invoice_number: null, simulated: false, values_after: null, review_code: null, review_detail: c.warning });
    } else if (['skipped', 'discarded'].includes(ex.rows[0]?.status as string)) {
      await moveInvoice(deps.db, id, [ex.rows[0]?.status as InvoiceStatus], 'eligible', actor, 'replanned', { observation: c.observation, product: c.product, review_code: null, review_detail: c.warning });
    }
    eligible.push(await getInvoice(deps.db, id));
  }
  await audit(deps.db, actor, 'invoice.plan', 'reconciliation_run', reconRunId, { eligible: eligible.length, excluded: plan.excluded.length, writer: plan.writer.mode });
  return { reconRunId, writer: plan.writer, eligible, excluded: plan.excluded };
}

/** Vista SIN efectos (GET): facturas ya existentes del rango de la conciliación (cualquier estado) + excluidas con motivo + cuántas elegibles faltan por planificar. No lee Home_111. */
export async function viewInvoicePlan(deps: InvoiceDeps, reconRunId: string): Promise<InvoicePlanDto> {
  const plan = await computeInvoicePlan(deps, reconRunId, true);
  const run = await deps.db.query<{ from: string; to: string }>(`select to_char(date_from,'YYYY-MM-DD') as "from", to_char(date_to,'YYYY-MM-DD') as "to" from reconciliation_runs where id = $1`, [reconRunId]);
  const rr = run.rows[0];
  await sweepInvoiceLeases(deps.db);
  const rows = await deps.db.query<InvoiceRow>(`select ${COLS} from invoices where service_date between $1 and $2 and status <> 'discarded' order by service_date, transport_number`, [rr?.from, rr?.to]);
  let unplanned = 0;
  for (const c of plan.candidates) {
    const ex = await deps.db.query('select 1 from invoices where idempotency_key = $1', [keyOf(c)]);
    if (ex.rowCount === 0) unplanned += 1;
  }
  return { reconRunId, writer: plan.writer, eligible: rows.rows.map(toInvoiceDto), excluded: plan.excluded, unplanned };
}

// ---- Ensayo / emisión -------------------------------------------------------------------------------------------
async function billingAccount(db: Db): Promise<string | null> {
  const r = await db.query<{ silog_user: string }>(`select silog_user from silog_credentials where purpose in ('invoice','adjust') order by (purpose = 'invoice') desc limit 1`);
  return r.rows[0]?.silog_user ?? null;
}

const hashOf = (r: InvoiceRequest): string => createHash('sha256').update(JSON.stringify([normRemesa(r.remesaCode), r.expectedFreight, r.observation, r.purchaseOrder, r.product, r.params])).digest('hex');

async function requestOf(db: Db, row: InvoiceRow): Promise<InvoiceRequest> {
  const s = await getInvoiceSettings(db);
  return {
    remesaCode: row.remesa_code, transportNumber: row.transport_number, expectedFreight: dec(row.terpel_value), observation: row.observation ?? '', purchaseOrder: row.transport_number, product: row.product ?? '',
    params: { costCenter: s.costCenter, client: s.client, printableName: s.printableName, seller: s.seller, paymentDays: s.paymentDays, paymentCity: s.paymentCity, currency: s.currency, paymentMethod: s.paymentMethod, invoiceType: s.invoiceType, divide: s.divide, maxRemesas: s.maxRemesas, withholdingPercent: s.withholdingPercent },
  };
}

function checkAllowed(deps: InvoiceDeps, row: InvoiceRow): void {
  if (deps.writer.kind !== 'web') return;
  if (!deps.allow?.all && !deps.allow?.list.includes(normRemesa(row.remesa_code))) {
    throw new AppError(409, 'REMESA_NOT_ALLOWED', `La remesa ${row.remesa_code} no está en la lista de remesas permitidas para emisión real (Facturación → Parámetros)`);
  }
}

async function readRecord(deps: InvoiceDeps, row: InvoiceRow): Promise<{ status: string | null; invoice: string | null } | null> {
  if (!deps.silog) throw new AppError(409, 'SILOG_NOT_CONFIGURED', 'Silogtran (lectura) no está configurado: no se puede verificar el registro');
  const rec = await deps.db.query<{ dispatch_date: string; manifest: string }>(`select to_char(dispatch_date,'YYYY-MM-DD') as dispatch_date, manifest from silogtran_records where id = $1`, [row.record_id]);
  const r = rec.rows[0];
  if (!r) return null;
  let raw;
  try { raw = await deps.silog.fetchReport(r.dispatch_date, r.dispatch_date); } catch { throw new AppError(502, 'SILOG_UNAVAILABLE', 'No se pudo releer el registro en Silogtran'); }
  const { kept } = dedupeAndFilter(raw, (await loadReconSettings(deps.db)).terpelNit);
  const f = kept.find((k) => k.manifest === r.manifest && normRemesa(k.remesa_code) === normRemesa(row.remesa_code));
  return f ? { status: f.status, invoice: f.invoice } : null;
}

const checksText = (cs: { name: string; ok: boolean; detail?: string }[]): string => cs.filter((c) => !c.ok).map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name)).join('; ');

/** Ensayo: abre la pantalla, llena, lista y LEE; NUNCA emite. Si pasa → `rehearsed`; si incumple una regla → `skipped` con el motivo. */
export async function rehearseInvoice(deps: InvoiceDeps, actor: string, id: string): Promise<InvoiceRehearsalDto> {
  const row = await loadInvoice(deps.db, id);
  if (!['eligible', 'rehearsed', 'failed', 'skipped'].includes(row.status)) throw new AppError(409, 'INVALID_TRANSITION', `No se ensaya una factura en estado ${row.status}`);
  checkAllowed(deps, row);
  if (deps.writer.kind === 'web' && !(await billingAccount(deps.db))) throw new AppError(409, 'INVOICE_ACCOUNT_NOT_CONFIGURED', 'No hay cuenta de facturación configurada (Usuarios → Cuenta de ajustes/facturación)');
  const req = await requestOf(deps.db, row);
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  // Del informe solo se exige: registro CUMPLIDO y sin factura.
  if (deps.silog) {
    const rec = await readRecord(deps, row);
    const bad = !rec ? 'el registro ya no aparece' : rec.status !== 'CUMPLIDO' ? 'ya no está CUMPLIDO' : rec.invoice ? `ya tiene factura ${rec.invoice}` : null;
    checks.push({ name: 'registro del informe vigente (CUMPLIDO y sin factura)', ok: !bad, detail: bad ?? undefined });
  } else checks.push({ name: 'registro del informe vigente', ok: false, detail: 'Silogtran (lectura) no está configurado' });
  const res = await deps.writer.rehearse(req, { actor });
  checks.push(...res.checks);
  const allChecksOk = checks.every((c) => c.ok);
  const values = { listing: res.listing, amounts: res.amounts };
  const detail = { payloadHash: hashOf(req), allChecksOk, checks, writer: deps.writer.kind, observation: req.observation };
  if (allChecksOk) {
    if (row.status === 'rehearsed') await addInvoiceEvent(deps.db, id, actor, 'rehearsed', 'rehearsed', 'rehearsed', res.simulated, detail);
    else await moveInvoice(deps.db, id, ['eligible', 'failed', 'skipped'], 'rehearsed', actor, 'rehearsed', { values_before: values, review_code: null, review_detail: null }, detail);
    if (row.status === 'rehearsed') await deps.db.query('update invoices set values_before = $2::jsonb, updated_at = now() where id = $1', [id, JSON.stringify(values)]);
  } else {
    const critical = checks.some((c) => !c.ok && /REGLA CR/.test(c.name));
    const from = row.status;
    if (from === 'skipped') await addInvoiceEvent(deps.db, id, actor, 'rehearsal_failed', 'skipped', 'skipped', res.simulated, detail);
    else await moveInvoice(deps.db, id, [from], 'skipped', actor, 'rehearsal_failed', { values_before: values, review_code: critical ? 'FREIGHT_MISMATCH' : 'CHECKS_FAILED', review_detail: checksText(checks) }, detail);
  }
  await audit(deps.db, actor, 'invoice.rehearse', 'invoice', id, { ok: allChecksOk, writer: deps.writer.kind });
  return { invoiceId: id, simulated: res.simulated, writerKind: deps.writer.kind, listing: res.listing, amounts: res.amounts, observation: req.observation, purchaseOrder: req.purchaseOrder, checks, allChecksOk, wouldIssue: false };
}

async function lastRehearsal(db: Db, id: string, hash: string): Promise<boolean> {
  const r = await db.query<{ detail: { payloadHash?: string; allChecksOk?: boolean; writer?: string } }>(
    `select detail from invoice_events where invoice_id = $1 and event = 'rehearsed' and at > now() - interval '24 hours' order by id desc limit 1`, [id],
  );
  const d = r.rows[0]?.detail;
  return !!d && d.writer === 'web' && d.payloadHash === hash && d.allChecksOk === true;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Emite UNA factura. Real solo con modo web + remesa permitida + ensayo vigente + confirmación; idempotente (compare-and-set + índice único). */
export async function issueInvoice(deps: InvoiceDeps, actor: string, id: string, confirm: unknown): Promise<InvoiceDto> {
  if (confirm !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Hay que confirmar explícitamente la emisión (confirm=true)');
  await sweepInvoiceLeases(deps.db);
  const row = await loadInvoice(deps.db, id);
  if (row.status === 'uncertain') throw new AppError(409, 'UNCERTAIN', 'La emisión anterior quedó con resultado incierto: use "Consultar estado" antes de reintentar');
  if (['issued', 'simulated'].includes(row.status)) throw new AppError(409, 'ALREADY_ISSUED', 'Esta remesa ya fue facturada: no se factura dos veces');
  checkAllowed(deps, row);
  const account = await billingAccount(deps.db);
  if (deps.writer.kind === 'web' && !account) throw new AppError(409, 'INVOICE_ACCOUNT_NOT_CONFIGURED', 'No hay cuenta de facturación configurada (Usuarios → Cuenta de ajustes/facturación)');
  const req = await requestOf(deps.db, row);
  if (deps.writer.kind === 'web' && !(await lastRehearsal(deps.db, id, hashOf(req)))) {
    throw new AppError(409, 'REHEARSAL_REQUIRED', 'Antes de la emisión real hay que hacer el ensayo de esta factura (sin cambios) y que pase todas las comprobaciones');
  }
  const prev = row.status;
  const claimed = await moveInvoice(deps.db, id, ['rehearsed', 'failed'], 'issuing', actor, 'issue_started', {
    lease_until: new Date(Date.now() + 120_000).toISOString(), issued_by: actor, writer_kind: deps.writer.kind, account_user: account, simulated: deps.writer.simulated,
  }, { writer: deps.writer.kind, account });
  if (!claimed) {
    const cur = (await loadInvoice(deps.db, id)).status;
    if (cur === 'issuing') throw new AppError(409, 'ALREADY_ISSUING', 'Esta factura ya se está emitiendo');
    if (['issued', 'simulated'].includes(cur)) throw new AppError(409, 'ALREADY_ISSUED', 'Esta remesa ya fue facturada: no se factura dos veces');
    throw new AppError(409, 'INVALID_TRANSITION', `No se puede emitir una factura en estado ${cur}; primero el ensayo`);
  }
  const revert = async (event: string, detail: Record<string, unknown>): Promise<void> => {
    await moveInvoice(deps.db, id, ['issuing'], prev === 'failed' ? 'failed' : 'rehearsed', actor, event, { lease_until: null }, detail);
  };
  // 1) Releer el informe: CUMPLIDO y sin factura.
  let rec;
  try { rec = await readRecord(deps, claimed); } catch (e) { await revert('precheck_failed', { code: e instanceof AppError ? e.code : 'ERROR' }); throw e; }
  const why = !rec ? 'El registro ya no aparece en Silogtran' : rec.status !== 'CUMPLIDO' ? 'El registro ya no está CUMPLIDO' : rec.invoice ? `La remesa ya tiene factura ${rec.invoice}` : null;
  if (why) {
    await moveInvoice(deps.db, id, ['issuing'], 'skipped', actor, 'stale', { lease_until: null, review_code: 'STALE', review_detail: why, last_error: why }, { reason: why });
    return getInvoice(deps.db, id);
  }
  // 2) Emitir (nunca con reintento ciego).
  let out;
  try {
    out = await deps.writer.issue(req, { actor });
  } catch (e) {
    await revert('writer_unavailable', { code: e instanceof AppError || e instanceof SilogWebError ? e.code : 'ERROR' });
    throw e instanceof SilogWebError ? new AppError(e.status, e.code, e.message) : e;
  }
  if (out.outcome === 'stale') await moveInvoice(deps.db, id, ['issuing'], 'skipped', actor, 'stale', { lease_until: null, review_code: 'CHECKS_FAILED', review_detail: out.detail, last_error: out.detail }, { detail: out.detail });
  else if (out.outcome === 'rejected') await moveInvoice(deps.db, id, ['issuing'], 'failed', actor, 'rejected', { lease_until: null, last_error: out.detail }, { detail: out.detail });
  else if (out.outcome === 'uncertain') await moveInvoice(deps.db, id, ['issuing'], 'uncertain', actor, 'uncertain', { lease_until: null, last_error: out.detail }, { detail: out.detail });
  else await finalizeIssued(deps, actor, claimed, (out as { invoiceNumber?: string | null }).invoiceNumber ?? null, (out as { amounts?: InvoiceAmountsDto }).amounts ?? null, (out as { detail?: string }).detail ?? null);
  await audit(deps.db, actor, 'invoice.issue', 'invoice', id, { simulated: deps.writer.simulated, outcome: out.outcome, writer: deps.writer.kind });
  return getInvoice(deps.db, id);
}

/** Tras enviar: el escritor simulado queda `simulated`; el real se verifica en el informe (invoice no nulo); cualquier duda = `uncertain`. */
async function finalizeIssued(deps: InvoiceDeps, actor: string, row: InvoiceRow, parsed: string | null, amounts: InvoiceAmountsDto | null, detail: string | null): Promise<void> {
  const now = new Date().toISOString();
  if (deps.writer.simulated) {
    await moveInvoice(deps.db, row.id, ['issuing'], 'simulated', actor, 'simulated', { lease_until: null, issued_at: now, invoice_number: parsed, values_after: { amounts, note: 'simulado: Silogtran no fue modificado' } }, { note: 'simulado' });
    return;
  }
  const delay = deps.verifyDelayMs ?? 3000;
  let invoice: string | null = null;
  for (let i = 0; i < 3 && !invoice; i += 1) {
    if (i > 0) await sleep(delay);
    try { invoice = (await readRecord(deps, row))?.invoice ?? null; } catch { invoice = null; }
  }
  if (invoice) {
    await moveInvoice(deps.db, row.id, ['issuing', 'uncertain'], 'issued', actor, 'issued', { lease_until: null, issued_at: now, invoice_number: invoice, values_after: { amounts, invoice, source: 'informe', message: detail } }, { invoice, parsed });
  } else {
    await moveInvoice(deps.db, row.id, ['issuing'], 'uncertain', actor, 'uncertain', { lease_until: null, last_error: 'Silogtran aceptó el envío pero el informe aún no muestra la factura: verifique antes de reintentar', invoice_number: parsed }, { detail, parsed });
  }
}

/** Resuelve un `uncertain` CONSULTANDO el informe (factura no nula = emitida). Sin evidencia sigue incierto. */
export async function checkInvoice(deps: InvoiceDeps, actor: string, id: string): Promise<InvoiceDto> {
  await sweepInvoiceLeases(deps.db);
  const row = await loadInvoice(deps.db, id);
  if (row.status !== 'uncertain') throw new AppError(409, 'INVALID_TRANSITION', `Solo se consulta el estado de facturas inciertas (estado ${row.status})`);
  const rec = await readRecord(deps, row);
  if (rec?.invoice) await moveInvoice(deps.db, id, ['uncertain'], 'issued', actor, 'checked_issued', { invoice_number: rec.invoice, issued_at: new Date().toISOString(), values_after: { invoice: rec.invoice, source: 'informe' } }, { invoice: rec.invoice });
  else await addInvoiceEvent(deps.db, id, actor, 'check_unknown', 'uncertain', 'uncertain', row.simulated, { note: 'El informe no muestra factura: sin evidencia de emisión (verifique en Silogtran)' });
  await audit(deps.db, actor, 'invoice.check', 'invoice', id, { found: !!rec?.invoice });
  return getInvoice(deps.db, id);
}

/** Resolución manual (solo admin) tras verificar en Silogtran: queda auditada. */
export async function resolveInvoice(db: Db, actor: string, id: string, input: { outcome: unknown; invoiceNumber?: unknown; note?: unknown }): Promise<InvoiceDto> {
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
  if (note === '') throw new AppError(400, 'INVALID_FIELD', 'Indique la nota de la verificación manual');
  if (input.outcome === 'issued') {
    const num = typeof input.invoiceNumber === 'string' ? input.invoiceNumber.trim().slice(0, 40) : '';
    if (!num) throw new AppError(400, 'INVALID_FIELD', 'Indique el número de factura');
    if (!(await moveInvoice(db, id, ['uncertain'], 'issued', actor, 'manual_resolution', { invoice_number: num, issued_at: new Date().toISOString() }, { outcome: 'issued', note }))) throw new AppError(409, 'INVALID_TRANSITION', 'Solo se resuelven facturas inciertas');
  } else if (input.outcome === 'not_issued') {
    if (!(await moveInvoice(db, id, ['uncertain'], 'failed', actor, 'manual_resolution', { last_error: 'Verificado manualmente: no se emitió' }, { outcome: 'not_issued', note }))) throw new AppError(409, 'INVALID_TRANSITION', 'Solo se resuelven facturas inciertas');
  } else throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: outcome');
  await audit(db, actor, 'invoice.manual_resolution', 'invoice', id, { outcome: input.outcome });
  return getInvoice(db, id);
}

export async function sweepInvoiceLeases(db: Db): Promise<void> {
  const r = await db.query<{ id: string }>(`select id from invoices where status = 'issuing' and lease_until < now()`);
  for (const x of r.rows) await moveInvoice(db, x.id, ['issuing'], 'uncertain', null, 'lease_expired', { lease_until: null }, { note: 'La emisión quedó sin respuesta: consulte el estado antes de reintentar' });
}

export async function listInvoices(q: Queryable, filter: { status?: string | null; from?: string; to?: string }): Promise<InvoiceDto[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.from && filter.to) { params.push(filter.from, filter.to); where.push('service_date between $1 and $2'); }
  if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  const r = await q.query<InvoiceRow>(`select ${COLS} from invoices ${where.length ? `where ${where.join(' and ')}` : ''} order by service_date, transport_number limit 2000`, params);
  return r.rows.map(toInvoiceDto);
}

export { computeAmounts, sqlState, log, normalizePlace };
