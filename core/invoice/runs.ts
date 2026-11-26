// Corrida de facturación por pasos: UNA factura por remesa, una a una, reanudable, con parada ante cualquier resultado incierto.
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db/types.js';
import { sqlState } from '../db/types.js';
import { AppError } from '../errors.js';
import { log } from '../logger.js';
import { SilogWebError } from '../silog/web/errors.js';
import type { InvoiceAmountsDto, InvoiceItemResult, InvoiceRunDetailDto, InvoiceRunDto, InvoiceRunItemDto } from '../types.js';
import { computeInvoicePlan, getInvoice, getInvoiceSettings, issueInvoice, loadInvoice, rehearseInvoice } from './service.js';
import type { InvoiceDeps } from './service.js';

const SYSTEMIC = new Set([
  'WEB_LOGIN_REJECTED', 'WEB_LOGIN_PASSWORD_CHANGE_REQUIRED', 'WEB_LOGIN_2FA_NOT_SUPPORTED', 'WEB_WAF_FAILED', 'WEB_UNREACHABLE', 'WEB_NOT_CONFIGURED', 'INVOICE_ACCOUNT_NOT_CONFIGURED',
  'ENCRYPTION_NOT_CONFIGURED', 'ENCRYPTION_KEY_INVALID', 'SILOG_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE',
]);
const errCode = (e: unknown): string => (e instanceof AppError || e instanceof SilogWebError ? e.code : 'ERROR');
const errText = (e: unknown): string => (e instanceof AppError || e instanceof SilogWebError ? `${e.code}: ${e.message}` : 'Error inesperado');

interface RunRow {
  id: string; recon_run_id: string; status: InvoiceRunDto['status']; writer_mode: string; simulated: boolean; total: number; issued: number; skipped: number; pending: number;
  halted_reason: string | null; excluded: InvoiceRunDto['excluded']; export_path: string | null; created_at: Date; finished_at: Date | null;
}
const RUN_COLS = 'id, recon_run_id, status, writer_mode, simulated, total, issued, skipped, pending, halted_reason, excluded, export_path, created_at, finished_at';
const runDto = (r: RunRow): InvoiceRunDto => ({
  id: r.id, reconRunId: r.recon_run_id, status: r.status, writerMode: r.writer_mode, simulated: r.simulated, total: r.total, issued: r.issued, skipped: r.skipped, pending: r.pending,
  haltedReason: r.halted_reason, excluded: r.excluded, exportReady: !!r.export_path, createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
});

async function loadRun(q: Queryable, id: string): Promise<RunRow> {
  const r = await q.query<RunRow>(`select ${RUN_COLS} from invoice_runs where id = $1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Corrida de facturación no encontrada');
  return r.rows[0];
}

interface ItemRow {
  id: string; position: number; invoice_id: string; remesa_code: string | null; transport_number: string | null; result: InvoiceItemResult; reason: string | null;
  invoice_number: string | null; amounts: InvoiceAmountsDto | null; started_at: Date | null; finished_at: Date | null;
}
const ITEM_COLS = 'id, position, invoice_id, remesa_code, transport_number, result, reason, invoice_number, amounts, started_at, finished_at';

export async function getInvoiceRun(q: Queryable, id: string): Promise<InvoiceRunDetailDto> {
  const run = await loadRun(q, id);
  const items = await q.query<ItemRow>(`select ${ITEM_COLS} from invoice_run_items where run_id = $1 order by position`, [id]);
  const dto: InvoiceRunItemDto[] = items.rows.map((i) => ({
    position: i.position, invoiceId: i.invoice_id, remesaCode: i.remesa_code, transportNumber: i.transport_number, result: i.result, reason: i.reason, invoiceNumber: i.invoice_number,
    amounts: i.amounts, startedAt: i.started_at ? new Date(i.started_at).toISOString() : null, finishedAt: i.finished_at ? new Date(i.finished_at).toISOString() : null,
  }));
  return { run: runDto(run), items: dto, done: run.status === 'completed' };
}

export async function listInvoiceRuns(q: Queryable, reconRunId?: string): Promise<InvoiceRunDto[]> {
  const r = await q.query<RunRow>(`select ${RUN_COLS} from invoice_runs ${reconRunId ? 'where recon_run_id = $1' : ''} order by created_at desc limit 20`, reconRunId ? [reconRunId] : []);
  return r.rows.map(runDto);
}

/** Crea la corrida con EXACTAMENTE las facturas confirmadas. Con escritor real exige `batch_enabled` (la primera real debe ser individual). */
export async function createInvoiceRun(deps: InvoiceDeps, actor: string, input: { reconRunId: unknown; invoiceIds: unknown; confirm: unknown }): Promise<InvoiceRunDetailDto> {
  if (input.confirm !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Hay que confirmar explícitamente la emisión (confirm=true)');
  if (typeof input.reconRunId !== 'string') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: reconRunId');
  const ids = input.invoiceIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((x) => typeof x === 'string') || new Set(ids).size !== ids.length) {
    throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: invoiceIds (1 a 200 identificadores distintos)');
  }
  if (deps.writer.kind === 'web' && !deps.batchEnabled) throw new AppError(409, 'BATCH_DISABLED', 'La facturación en lote con escritor real está desactivada: un administrador debe activar «Facturar todas» (la primera factura real debe ser individual)');
  const plan = await computeInvoicePlan(deps, input.reconRunId);
  const okRemesas = new Set(plan.candidates.map((c) => (c.remesa_code ?? '').replace(/^0+/, '')));
  const rows: { id: string; remesa_code: string; transport_number: string; status: string }[] = [];
  const bad: string[] = [];
  for (const id of ids as string[]) {
    let row;
    try { row = await loadInvoice(deps.db, id); } catch { bad.push(id); continue; }
    if (!['eligible', 'rehearsed', 'failed'].includes(row.status) || !okRemesas.has(row.remesa_code.replace(/^0+/, ''))) bad.push(id);
    else rows.push({ id, remesa_code: row.remesa_code, transport_number: row.transport_number, status: row.status });
  }
  if (bad.length > 0) throw new AppError(400, 'NOT_ELIGIBLE', `${bad.length} factura(s) ya no son elegibles: vuelva a generar el plan`, { invoiceIds: bad });
  void (await getInvoiceSettings(deps.db));
  try {
    const runId = await deps.db.transaction(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into invoice_runs (recon_run_id, requested_by, writer_mode, simulated, total, pending, excluded) values ($1,$2,$3,$4,$5,$5,$6::jsonb) returning id`,
        [input.reconRunId, actor, deps.writer.kind, deps.writer.simulated, rows.length, JSON.stringify(plan.excluded)],
      );
      const id = r.rows[0]?.id as string;
      let pos = 1;
      for (const x of rows) {
        await tx.query(`insert into invoice_run_items (run_id, position, invoice_id, remesa_code, transport_number) values ($1,$2,$3,$4,$5)`, [id, pos, x.id, x.remesa_code, x.transport_number]);
        pos += 1;
      }
      return id;
    });
    await audit(deps.db, actor, 'invoice_run.start', 'invoice_run', runId, { total: rows.length, writer: deps.writer.kind, simulated: deps.writer.simulated });
    log('invoice_run.start', { runId, total: rows.length });
    return await getInvoiceRun(deps.db, runId);
  } catch (e) {
    if (sqlState(e) === '23505') throw new AppError(409, 'INVOICE_RUN_ACTIVE', 'Ya hay una corrida de facturación en curso: reanúdela o espere a que termine');
    throw e;
  }
}

async function recount(db: Db, runId: string): Promise<void> {
  await db.query(
    `update invoice_runs set issued = (select count(*) from invoice_run_items where run_id = $1 and result = 'issued'), skipped = (select count(*) from invoice_run_items where run_id = $1 and result = 'skipped'),
       pending = (select count(*) from invoice_run_items where run_id = $1 and result = 'pending'), updated_at = now() where id = $1`, [runId],
  );
}

type Outcome = { kind: 'issued' | 'skipped' | 'halted'; reason: string | null; number?: string | null; amounts?: InvoiceAmountsDto | null };

async function processItem(deps: InvoiceDeps, actor: string, item: ItemRow): Promise<Outcome> {
  const db = deps.db;
  let inv = await getInvoice(db, item.invoice_id);
  const amountsOf = (i: typeof inv): InvoiceAmountsDto | null => ((i.valuesAfter as { amounts?: InvoiceAmountsDto } | null)?.amounts ?? (i.valuesBefore as { amounts?: InvoiceAmountsDto } | null)?.amounts ?? null);
  if (inv.status === 'issued' || inv.status === 'simulated') return { kind: 'issued', reason: 'Ya estaba facturada (no se factura dos veces)', number: inv.invoiceNumber, amounts: amountsOf(inv) };
  if (['issuing', 'uncertain', 'failed', 'verification_failed'].includes(inv.status)) return { kind: 'halted', reason: `La factura quedó en estado «${inv.status}»: consulte el estado antes de continuar` };
  if (!['eligible', 'rehearsed', 'skipped'].includes(inv.status)) return { kind: 'skipped', reason: `La factura ya no es elegible (estado ${inv.status})` };
  try {
    const rh = await rehearseInvoice(deps, actor, inv.id);
    if (!rh.allChecksOk) return { kind: 'skipped', reason: `El ensayo no pasó: ${rh.checks.filter((c) => !c.ok).map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name)).join('; ')}` };
  } catch (e) {
    return SYSTEMIC.has(errCode(e)) || !(e instanceof AppError || e instanceof SilogWebError) ? { kind: 'halted', reason: `Error en el ensayo: ${errText(e)}` } : { kind: 'skipped', reason: `El ensayo falló: ${errText(e)}` };
  }
  try {
    inv = await issueInvoice(deps, actor, inv.id, true);
  } catch (e) {
    return SYSTEMIC.has(errCode(e)) || !(e instanceof AppError || e instanceof SilogWebError) ? { kind: 'halted', reason: `Error al emitir: ${errText(e)}` } : { kind: 'skipped', reason: `No se emitió (nada se facturó): ${errText(e)}` };
  }
  if (inv.status === 'issued' || inv.status === 'simulated') {
    return { kind: 'issued', reason: inv.simulated ? 'Facturación SIMULADA (Silogtran no se modificó)' : 'Factura emitida y verificada en el informe', number: inv.invoiceNumber, amounts: amountsOf(inv) };
  }
  if (inv.status === 'skipped') return { kind: 'skipped', reason: `No se facturó: ${inv.reviewDetail ?? inv.lastError ?? 'cambió el estado de la remesa'}` };
  return { kind: 'halted', reason: `Resultado «${inv.status}» al intentar emitir${inv.lastError ? `: ${inv.lastError}` : ''}` };
}

export async function stepInvoiceRun(deps: InvoiceDeps, actor: string, runId: string, opts: { budgetMs?: number; resume?: boolean } = {}, onFinish?: (runId: string) => Promise<void>): Promise<InvoiceRunDetailDto> {
  const budget = Math.max(0, opts.budgetMs ?? 20_000);
  const run = await loadRun(deps.db, runId);
  if (run.status === 'completed') return getInvoiceRun(deps.db, runId);
  if (run.status === 'halted') {
    if (!opts.resume) throw new AppError(409, 'RUN_HALTED', `La corrida está detenida: ${run.halted_reason ?? ''}. Resuelva el problema y reanude explícitamente.`);
    const r = await deps.db.query(`update invoice_runs set status = 'running', halted_reason = null, updated_at = now() where id = $1 and status = 'halted' returning id`, [runId]);
    if (r.rowCount === 0) throw new AppError(409, 'INVOICE_RUN_ACTIVE', 'Ya hay otra corrida de facturación activa');
    await audit(deps.db, actor, 'invoice_run.resume', 'invoice_run', runId, {});
  }
  const claim = await deps.db.query(`update invoice_runs set lease_until = now() + interval '90 seconds' where id = $1 and status = 'running' and (lease_until is null or lease_until < now()) returning id`, [runId]);
  if (claim.rowCount === 0) throw new AppError(409, 'RUN_LEASED', 'La corrida está siendo procesada por otro paso. Reintente en unos segundos.');
  const started = Date.now();
  let halted = false;
  try {
    for (;;) {
      const next = await deps.db.query<ItemRow>(`select ${ITEM_COLS} from invoice_run_items where run_id = $1 and result = 'pending' order by position limit 1`, [runId]);
      const item = next.rows[0];
      if (!item) break;
      if (Date.now() - started >= budget && budget > 0) break;
      await deps.db.query('update invoice_run_items set started_at = now() where id = $1', [item.id]);
      await deps.db.query(`update invoice_runs set lease_until = now() + interval '90 seconds' where id = $1`, [runId]);
      let out: Outcome;
      try { out = await processItem(deps, actor, item); } catch (e) { out = { kind: 'halted', reason: `Error inesperado: ${errText(e)}` }; }
      await deps.db.query(
        `update invoice_run_items set result = $2, reason = $3, invoice_number = $4, amounts = $5::jsonb, finished_at = now() where id = $1`,
        [item.id, out.kind, out.reason, out.number ?? null, JSON.stringify(out.amounts ?? null)],
      );
      await recount(deps.db, runId);
      if (out.kind === 'halted') {
        halted = true;
        await deps.db.query(`update invoice_runs set status = 'halted', halted_reason = $2, lease_until = null, updated_at = now() where id = $1`, [runId, `Remesa ${item.remesa_code ?? ''} (transporte ${item.transport_number ?? ''}): ${out.reason ?? ''}`.slice(0, 400)]);
        await audit(deps.db, actor, 'invoice_run.halt', 'invoice_run', runId, { invoiceId: item.invoice_id });
        break;
      }
      if (budget === 0) break;
    }
    if (!halted) {
      const left = await deps.db.query<{ n: number }>(`select count(*)::int as n from invoice_run_items where run_id = $1 and result = 'pending'`, [runId]);
      if ((left.rows[0]?.n ?? 0) === 0) {
        await deps.db.query(`update invoice_runs set status = 'completed', finished_at = now(), lease_until = null, updated_at = now() where id = $1`, [runId]);
        await audit(deps.db, actor, 'invoice_run.finish', 'invoice_run', runId, {});
        if (onFinish) await onFinish(runId);
      }
    }
  } finally {
    await deps.db.query(`update invoice_runs set lease_until = null where id = $1 and lease_until is not null`, [runId]);
  }
  if (halted && onFinish) await onFinish(runId);
  return getInvoiceRun(deps.db, runId);
}
