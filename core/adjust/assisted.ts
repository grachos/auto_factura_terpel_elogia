// Modo asistido: tras una conciliación, un solo flujo (con confirmación humana) aprueba, ensaya y aplica las propuestas elegibles.
// Plan (sin efectos) -> corrida confirmada con exactamente esos ids -> pasos con presupuesto de tiempo -> reporte.
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db/types.js';
import { sqlState } from '../db/types.js';
import { AppError } from '../errors.js';
import { log } from '../logger.js';
import { SilogWebError } from '../silog/web/errors.js';
import type {
  AssistedCategory, AssistedExcludedDto, AssistedItemDto, AssistedItemResult, AssistedPlanDto, AssistedPlanItemDto, AssistedRunDetailDto, AssistedRunDto,
  ProposalDto, ScreenValuesDto,
} from '../types.js';
import {
  addEvent, applyProposal, approveProposal, generateProposals, getAdjustSettings, getProposal, listProposals, rehearseProposal, writerStatus,
} from './service.js';
import type { AdjustDeps } from './service.js';

const normRemesa = (v: string | null): string => (v ?? '').replace(/\D/g, '').replace(/^0+/, '');

/** Errores de infraestructura: si ocurren, seguir solo repetiría el fallo (se detiene la corrida). */
const SYSTEMIC = new Set([
  'WEB_LOGIN_REJECTED', 'WEB_LOGIN_PASSWORD_CHANGE_REQUIRED', 'WEB_LOGIN_2FA_NOT_SUPPORTED', 'WEB_WAF_FAILED', 'WEB_UNREACHABLE', 'WEB_NOT_CONFIGURED',
  'ADJUST_ACCOUNT_NOT_CONFIGURED', 'ENCRYPTION_NOT_CONFIGURED', 'ENCRYPTION_KEY_INVALID', 'SILOG_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE', 'WRITER_NOT_IMPLEMENTED',
]);

const REVIEW_TEXT: Record<string, string> = {
  CURRENT_VALUES_UNAVAILABLE: 'No se pudieron leer los valores reales de la remesa en Silogtran (no se asumen)',
  ALREADY_ADJUSTED: 'Ya ajustado: peso, cantidad y tarifa reales ya son los esperados',
  TARIFF_NOT_EXACT: 'La tarifa (valor ÷ galones) no es un decimal exacto',
  TARIFF_TOO_LONG: 'La tarifa exacta no cabe en 12 caracteres',
  INVALID_INPUT: 'Galones o valor inválidos',
  NOT_CUMPLIDO: 'El registro de Silogtran ya no está CUMPLIDO',
  ALREADY_INVOICED: 'El registro de Silogtran ya tiene factura',
};

interface ReconRow { transport_number: string; status: string; reason_code: string | null; reason: string | null }

// ---- Plan ---------------------------------------------------------------------------------------------
export async function computePlan(deps: AdjustDeps, reconRunId: string): Promise<Omit<AssistedPlanDto, 'generated'>> {
  const run = await deps.db.query<{ from: string; to: string; status: string }>(
    `select to_char(date_from,'YYYY-MM-DD') as "from", to_char(date_to,'YYYY-MM-DD') as "to", status from reconciliation_runs where id = $1`, [reconRunId],
  );
  const rr = run.rows[0];
  if (!rr) throw new AppError(404, 'RUN_NOT_FOUND', 'Conciliación no encontrada');
  if (rr.status !== 'completed') throw new AppError(409, 'RUN_NOT_COMPLETED', 'La conciliación aún no termina');
  const settings = await getAdjustSettings(deps.db);
  const writer = writerStatus({ ...settings, writerMode: deps.writer.kind === 'web' ? 'web' : 'mock' });
  const proposals = (await listProposals(deps.db, { runFrom: rr.from, runTo: rr.to })).filter((p) => p.kind === 'adjust');
  const eligible: AssistedPlanItemDto[] = [];
  const excluded: AssistedExcludedDto[] = [];
  const ex = (category: AssistedCategory, p: ProposalDto, reason: string): void => {
    excluded.push({ category, transportNumber: p.transportNumber, remesaCode: p.remesaCode, reason, proposalId: p.id });
  };
  // Una propuesta viva por servicio: ignora las obsoletas/descartadas cuando hay otra vigente.
  const live = proposals.filter((p) => !['stale', 'discarded'].includes(p.status) || !proposals.some((q) => q.transportNumber === p.transportNumber && q.id !== p.id && !['stale', 'discarded'].includes(q.status)));
  for (const p of live) {
    const line = (f: string): { current: string | null; proposed: string | null } => {
      const l = p.lines.find((x) => x.field === f);
      return { current: l?.current ?? null, proposed: l?.proposed ?? null };
    };
    if (p.status === 'applied' || p.status === 'simulated_applied') { ex('applied', p, p.status === 'applied' ? 'Ya aplicada' : 'Ya aplicada en modo simulado (descártela para reproponer)'); continue; }
    if (p.reviewCode === 'ALREADY_ADJUSTED') { ex('already_adjusted', p, REVIEW_TEXT.ALREADY_ADJUSTED as string); continue; }
    if (p.status === 'needs_review') { ex('needs_review', p, REVIEW_TEXT[p.reviewCode ?? ''] ?? p.reviewDetail ?? 'Requiere revisión'); continue; }
    if (['rejected', 'stale', 'discarded', 'failed', 'uncertain', 'verification_failed', 'applying'].includes(p.status)) { ex('attention', p, `Estado «${p.status}»: requiere atención antes de reintentar`); continue; }
    if (!p.autoEligible) { ex('not_eligible', p, `No cumple las condiciones del modo asistido: ${p.autoReasons.join('; ') || 'revisión manual'}`); continue; }
    if (deps.writer.kind === 'web' && !deps.allow?.all && !deps.allow?.list.includes(normRemesa(p.remesaCode))) {
      ex('not_allowed', p, 'La remesa no está en la lista de remesas permitidas para escritura real'); continue;
    }
    eligible.push({
      proposalId: p.id, transportNumber: p.transportNumber, remesaCode: p.remesaCode, status: p.status,
      current: { peso: line('pesoRemesa').current, cantidad: line('cantidadRemesa').current, tarifa: line('nuevaTarifa').current, total: line('totalRemesa').current },
      proposed: { peso: line('pesoRemesa').proposed, cantidad: line('cantidadRemesa').proposed, tarifa: line('nuevaTarifa').proposed, total: line('totalRemesa').proposed },
    });
  }
  // Servicios de la conciliación que ni siquiera llegaron a propuesta.
  const rs = await deps.db.query<ReconRow>(
    `select transport_number, status, reason_code, reason from reconciliation_results where service_date between $1 and $2 and status in ('AMBIGUOUS','NO_MATCH','INSUFFICIENT_DATA') order by transport_number`,
    [rr.from, rr.to],
  );
  for (const r of rs.rows) {
    const category: AssistedCategory = r.status === 'AMBIGUOUS' ? 'ambiguous' : r.status === 'NO_MATCH' ? 'no_match' : r.reason_code === 'ZERO_VOLUME_IGNORED' || r.reason_code === 'ZERO_VOLUME_VALUE_MISMATCH' ? 'terpel_pending' : 'insufficient';
    const reason = category === 'terpel_pending' ? 'Volumen 0 en Terpel: se espera corrección de Terpel' : category === 'ambiguous' ? 'Varios despachos candidatos: elija uno en la bandeja de revisión' : category === 'no_match' ? 'Sin registro en Silogtran (puede no estar despachado aún)' : (r.reason ?? 'Datos insuficientes');
    excluded.push({ category, transportNumber: r.transport_number, remesaCode: null, reason, proposalId: null });
  }
  return { reconRunId, writer, eligible, excluded };
}

export async function buildPlan(deps: AdjustDeps, reconRunId: string, actor: string): Promise<AssistedPlanDto> {
  const generated = await generateProposals(deps, reconRunId, actor); // reutiliza la generación (idempotente)
  const plan = await computePlan(deps, reconRunId);
  await audit(deps.db, actor, 'assisted.plan', 'reconciliation_run', reconRunId, { eligible: plan.eligible.length, excluded: plan.excluded.length, writer: plan.writer.mode });
  return { ...plan, generated };
}

// ---- Corrida --------------------------------------------------------------------------------------------
interface RunRow {
  id: string; recon_run_id: string; requested_by: string; status: AssistedRunDto['status']; writer_mode: string; simulated: boolean; total: number; applied: number;
  skipped: number; pending: number; halted_reason: string | null; excluded: AssistedExcludedDto[]; export_path: string | null; lease_until: Date | null; created_at: Date; finished_at: Date | null;
}
const RUN_COLS = 'id, recon_run_id, requested_by, status, writer_mode, simulated, total, applied, skipped, pending, halted_reason, excluded, export_path, lease_until, created_at, finished_at';

const runDto = (r: RunRow): AssistedRunDto => ({
  id: r.id, reconRunId: r.recon_run_id, status: r.status, writerMode: r.writer_mode, simulated: r.simulated, total: r.total, applied: r.applied, skipped: r.skipped,
  pending: r.pending, haltedReason: r.halted_reason, excluded: r.excluded, exportReady: !!r.export_path, createdAt: new Date(r.created_at).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
});

async function loadRun(q: Queryable, id: string): Promise<RunRow> {
  const r = await q.query<RunRow>(`select ${RUN_COLS} from assisted_runs where id = $1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Corrida asistida no encontrada');
  return r.rows[0];
}

interface ItemRow {
  id: string; position: number; proposal_id: string; remesa_code: string | null; transport_number: string | null; result: AssistedItemResult; reason: string | null;
  before_values: ScreenValuesDto | null; after_values: ScreenValuesDto | null; reversal_values: ScreenValuesDto | null; started_at: Date | null; finished_at: Date | null;
}

export async function getAssistedRun(q: Queryable, id: string): Promise<AssistedRunDetailDto> {
  const run = await loadRun(q, id);
  const items = await q.query<ItemRow>(
    `select id, position, proposal_id, remesa_code, transport_number, result, reason, before_values, after_values, reversal_values, started_at, finished_at from assisted_run_items where run_id = $1 order by position`, [id],
  );
  const dto: AssistedItemDto[] = items.rows.map((i) => ({
    position: i.position, proposalId: i.proposal_id, transportNumber: i.transport_number, remesaCode: i.remesa_code, result: i.result, reason: i.reason,
    before: i.before_values, after: i.after_values, reversal: i.reversal_values, startedAt: i.started_at ? new Date(i.started_at).toISOString() : null,
    finishedAt: i.finished_at ? new Date(i.finished_at).toISOString() : null,
  }));
  return { run: runDto(run), items: dto, done: run.status === 'completed' };
}

export async function listAssistedRuns(q: Queryable, reconRunId?: string): Promise<AssistedRunDto[]> {
  const r = await q.query<RunRow>(`select ${RUN_COLS} from assisted_runs ${reconRunId ? 'where recon_run_id = $1' : ''} order by created_at desc limit 20`, reconRunId ? [reconRunId] : []);
  return r.rows.map(runDto);
}

/** Crea la corrida con EXACTAMENTE los ids confirmados (todos deben seguir siendo elegibles). */
export async function createAssistedRun(deps: AdjustDeps, actor: string, input: { reconRunId: unknown; proposalIds: unknown; confirm: unknown }): Promise<AssistedRunDetailDto> {
  if (input.confirm !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Hay que confirmar explícitamente que se escribirá en Silogtran (confirm=true)');
  if (typeof input.reconRunId !== 'string') throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: reconRunId');
  const ids = input.proposalIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((x) => typeof x === 'string') || new Set(ids).size !== ids.length) {
    throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: proposalIds (1 a 200 identificadores distintos)');
  }
  const plan = await computePlan(deps, input.reconRunId);
  const byId = new Map(plan.eligible.map((e) => [e.proposalId, e]));
  const bad = (ids as string[]).filter((id) => !byId.has(id));
  if (bad.length > 0) throw new AppError(400, 'NOT_ELIGIBLE', `${bad.length} propuesta(s) ya no son elegibles para el modo asistido: vuelva a generar el plan`, { proposalIds: bad });
  const settings = await getAdjustSettings(deps.db);
  void settings;
  try {
    const runId = await deps.db.transaction(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into assisted_runs (recon_run_id, requested_by, writer_mode, simulated, total, pending, excluded) values ($1,$2,$3,$4,$5,$5,$6::jsonb) returning id`,
        [input.reconRunId, actor, deps.writer.kind, deps.writer.simulated, ids.length, JSON.stringify(plan.excluded)],
      );
      const id = r.rows[0]?.id as string;
      let pos = 1;
      for (const pid of ids as string[]) {
        const e = byId.get(pid) as AssistedPlanItemDto;
        await tx.query(`insert into assisted_run_items (run_id, position, proposal_id, remesa_code, transport_number) values ($1,$2,$3,$4,$5)`, [id, pos, pid, e.remesaCode, e.transportNumber]);
        pos += 1;
      }
      return id;
    });
    await audit(deps.db, actor, 'assisted.start', 'assisted_run', runId, { total: ids.length, writer: deps.writer.kind, simulated: deps.writer.simulated });
    log('assisted.start', { runId, total: ids.length });
    return await getAssistedRun(deps.db, runId);
  } catch (e) {
    if (sqlState(e) === '23505') throw new AppError(409, 'ASSISTED_RUN_ACTIVE', 'Ya hay una corrida asistida en curso: reanúdela o espere a que termine');
    throw e;
  }
}

const scr = (v: { peso: string | null; cantidad: string | null; tarifa: string | null } | null | undefined): ScreenValuesDto | null =>
  v && v.peso !== null && v.cantidad !== null && v.tarifa !== null ? { peso: v.peso, cantidad: v.cantidad, tarifa: v.tarifa } : null;

async function recount(db: Db, runId: string): Promise<void> {
  await db.query(
    `update assisted_runs set
       applied = (select count(*) from assisted_run_items where run_id = $1 and result = 'applied'),
       skipped = (select count(*) from assisted_run_items where run_id = $1 and result = 'skipped'),
       pending = (select count(*) from assisted_run_items where run_id = $1 and result = 'pending'), updated_at = now() where id = $1`, [runId],
  );
}

async function finishItem(db: Db, itemId: string, result: AssistedItemResult, reason: string | null, extra: { before?: ScreenValuesDto | null; after?: ScreenValuesDto | null; reversal?: ScreenValuesDto | null } = {}): Promise<void> {
  await db.query(
    `update assisted_run_items set result = $2, reason = $3, before_values = $4::jsonb, after_values = $5::jsonb, reversal_values = $6::jsonb, finished_at = now() where id = $1`,
    [itemId, result, reason, JSON.stringify(extra.before ?? null), JSON.stringify(extra.after ?? null), JSON.stringify(extra.reversal ?? null)],
  );
}

const errCode = (e: unknown): string => (e instanceof AppError || e instanceof SilogWebError ? e.code : 'ERROR');
const errText = (e: unknown): string => (e instanceof AppError || e instanceof SilogWebError ? `${e.code}: ${e.message}` : 'Error inesperado');

type Outcome = { kind: 'applied' | 'skipped' | 'halted'; reason: string | null; before?: ScreenValuesDto | null; after?: ScreenValuesDto | null; reversal?: ScreenValuesDto | null };

async function processItem(deps: AdjustDeps, actor: string, runId: string, item: ItemRow): Promise<Outcome> {
  const db = deps.db;
  let p = await getProposal(db, item.proposal_id);
  // Reanudación: si la propuesta ya avanzó (otra corrida/paso previo cortado), se respeta su estado real.
  if (p.status === 'applied' || p.status === 'simulated_applied') return { kind: 'applied', reason: 'Ya estaba aplicada (no se aplica dos veces)', before: p.reversalValues ? scr(p.reversalValues) : null, after: scr({ peso: p.gallons, cantidad: p.quantity ?? p.gallons, tarifa: p.tariff }), reversal: p.reversalValues ? scr(p.reversalValues) : null };
  if (['applying', 'uncertain', 'failed', 'verification_failed'].includes(p.status)) return { kind: 'halted', reason: `La propuesta quedó en estado «${p.status}»: consulte el estado antes de continuar` };
  if (!['proposed', 'approved'].includes(p.status) || p.reviewCode) return { kind: 'skipped', reason: `La propuesta ya no es elegible (estado ${p.status}${p.reviewCode ? `, ${p.reviewCode}` : ''})` };

  // 1) Aprobar (como el actor; queda evento y auditoría 'assisted').
  if (p.status === 'proposed') {
    try {
      await approveProposal(db, actor, p.id);
    } catch (e) {
      return SYSTEMIC.has(errCode(e)) || !(e instanceof AppError) ? { kind: 'halted', reason: errText(e) } : { kind: 'skipped', reason: errText(e) };
    }
    await addEvent(db, p.id, actor, 'assisted', 'proposed', 'approved', deps.writer.simulated, { runId, step: 'approve' });
    await audit(db, actor, 'assisted.approve', 'adjustment_proposal', p.id, { runId });
  }
  // 2) Ensayo: todos los pasos menos Grabar. Si falla, NO se escribió nada: se omite y se continúa.
  try {
    const rh = await rehearseProposal(deps, actor, p.id);
    if (!rh.allChecksOk) return { kind: 'skipped', reason: `El ensayo no pasó: ${rh.checks.filter((c) => !c.ok).map((c) => c.detail ? `${c.name} (${c.detail})` : c.name).join('; ')}` };
  } catch (e) {
    return SYSTEMIC.has(errCode(e)) || !(e instanceof AppError || e instanceof SilogWebError) ? { kind: 'halted', reason: `Error en el ensayo: ${errText(e)}` } : { kind: 'skipped', reason: `El ensayo falló: ${errText(e)}` };
  }
  // 3) Aplicar con el escritor configurado (mismo servicio y máquina de estados de siempre).
  try {
    p = (await applyProposal(deps, actor, p.id)).proposal;
  } catch (e) {
    return SYSTEMIC.has(errCode(e)) || !(e instanceof AppError || e instanceof SilogWebError) ? { kind: 'halted', reason: `Error al aplicar: ${errText(e)}` } : { kind: 'skipped', reason: `No se aplicó (nada se escribió): ${errText(e)}` };
  }
  void runId; void item;
  if (p.status === 'applied' || p.status === 'simulated_applied') {
    return { kind: 'applied', reason: p.simulated ? 'Aplicada en modo SIMULADO (Silogtran no se modificó)' : 'Aplicada y verificada en la consulta de la remesa', before: scr(p.reversalValues) ?? scr({ peso: p.lines.find((l) => l.field === 'pesoRemesa')?.current ?? null, cantidad: p.lines.find((l) => l.field === 'cantidadRemesa')?.current ?? null, tarifa: p.lines.find((l) => l.field === 'nuevaTarifa')?.current ?? null }), after: scr({ peso: p.gallons, cantidad: p.quantity ?? p.gallons, tarifa: p.tariff }), reversal: p.simulated ? null : scr(p.reversalValues) };
  }
  if (p.status === 'stale') return { kind: 'skipped', reason: `Obsoleta, no se escribió: ${p.lastError ?? 'la remesa cambió'}` };
  return { kind: 'halted', reason: `Resultado «${p.status}» tras intentar grabar${p.lastError ? `: ${p.lastError}` : ''}` };
}

export interface StepOptions { budgetMs?: number; resume?: boolean }

/** Procesa propuestas en orden con presupuesto de tiempo. Reanudable e idempotente (lease; applyProposal es compare-and-set). */
export async function stepAssistedRun(deps: AdjustDeps, actor: string, runId: string, opts: StepOptions = {}, onFinish?: (runId: string) => Promise<void>): Promise<AssistedRunDetailDto> {
  const budget = Math.max(0, opts.budgetMs ?? 20_000);
  let run = await loadRun(deps.db, runId);
  if (run.status === 'completed') return getAssistedRun(deps.db, runId);
  if (run.status === 'halted') {
    if (!opts.resume) throw new AppError(409, 'RUN_HALTED', `La corrida está detenida: ${run.halted_reason ?? ''}. Resuelva el problema y reanude explícitamente.`);
    const r = await deps.db.query(`update assisted_runs set status = 'running', halted_reason = null, updated_at = now() where id = $1 and status = 'halted' returning id`, [runId]);
    if (r.rowCount === 0) throw new AppError(409, 'ASSISTED_RUN_ACTIVE', 'Ya hay otra corrida asistida activa');
    await audit(deps.db, actor, 'assisted.resume', 'assisted_run', runId, {});
  }
  const claim = await deps.db.query(`update assisted_runs set lease_until = now() + interval '90 seconds' where id = $1 and status = 'running' and (lease_until is null or lease_until < now()) returning id`, [runId]);
  if (claim.rowCount === 0) throw new AppError(409, 'RUN_LEASED', 'La corrida está siendo procesada por otro paso. Reintente en unos segundos.');
  const started = Date.now();
  let halted = false;
  try {
    for (;;) {
      const next = await deps.db.query<ItemRow>(
        `select id, position, proposal_id, remesa_code, transport_number, result, reason, before_values, after_values, reversal_values, started_at, finished_at from assisted_run_items where run_id = $1 and result = 'pending' order by position limit 1`, [runId],
      );
      const item = next.rows[0];
      if (!item) break;
      if (Date.now() - started >= budget && budget > 0) break; // el resto en el siguiente paso
      await deps.db.query('update assisted_run_items set started_at = now() where id = $1', [item.id]);
      await deps.db.query(`update assisted_runs set lease_until = now() + interval '90 seconds' where id = $1`, [runId]);
      let out: Outcome;
      try {
        out = await processItem(deps, actor, runId, item);
      } catch (e) {
        out = { kind: 'halted', reason: `Error inesperado: ${errText(e)}` };
      }
      await finishItem(deps.db, item.id, out.kind === 'applied' ? 'applied' : out.kind === 'skipped' ? 'skipped' : 'halted', out.reason, { before: out.before, after: out.after, reversal: out.reversal });
      await recount(deps.db, runId);
      if (out.kind === 'halted') {
        halted = true;
        await deps.db.query(`update assisted_runs set status = 'halted', halted_reason = $2, lease_until = null, updated_at = now() where id = $1`, [runId, `Remesa ${item.remesa_code ?? ''} (transporte ${item.transport_number ?? ''}): ${out.reason ?? ''}`.slice(0, 400)]);
        await audit(deps.db, actor, 'assisted.halt', 'assisted_run', runId, { proposalId: item.proposal_id });
        log('assisted.halt', { runId });
        break;
      }
      if (budget === 0) break; // prueba: un ítem por paso
    }
    if (!halted) {
      const left = await deps.db.query<{ n: number }>(`select count(*)::int as n from assisted_run_items where run_id = $1 and result = 'pending'`, [runId]);
      if ((left.rows[0]?.n ?? 0) === 0) {
        await deps.db.query(`update assisted_runs set status = 'completed', finished_at = now(), lease_until = null, updated_at = now() where id = $1`, [runId]);
        await audit(deps.db, actor, 'assisted.finish', 'assisted_run', runId, {});
        if (onFinish) await onFinish(runId);
      } else await deps.db.query('update assisted_runs set lease_until = null where id = $1', [runId]);
    }
  } finally {
    await deps.db.query(`update assisted_runs set lease_until = null where id = $1 and lease_until is not null`, [runId]);
  }
  run = await loadRun(deps.db, runId);
  if (run.status === 'halted' && onFinish) await onFinish(runId); // el reporte también se entrega cuando se detiene
  return getAssistedRun(deps.db, runId);
}
