import { createHash } from 'node:crypto';
import { buildBusinessKey } from './businessKey.js';
import type { BusinessKeyStrategy } from './businessKey.js';
import { utcRangeForLocalDates, DateRangeError } from './dates.js';
import type { Db, Queryable } from './db/types.js';
import { sqlState } from './db/types.js';
import { AppError } from './errors.js';
import { audit } from './audit.js';
import { generateExport } from './excel.js';
import { log } from './logger.js';
import type { MailMessage, MailSource } from './mail/types.js';
import { CursorExpiredError, MailSourceError, ThrottledError } from './mail/types.js';
import { parseAuthorization } from './parser.js';
import type { ParsedAuthorization } from './parser.js';
import { dmarcStatus, evaluateSenderTrust, subjectMatches } from './subject.js';
import type { StorageAdapter } from './storage/types.js';
import type { Outcome, RunDto, StepResultDto } from './types.js';
import { getRunDto } from './queries.js';

export interface OrchestratorDeps {
  db: Db;
  mail: MailSource;
  storage: StorageAdapter;
  leaseSeconds?: number;
  /** Solo pruebas: se invoca tras procesar cada mensaje dentro de la transacción de la página. */
  afterMessage?: (indexInPage: number) => void | Promise<void>;
}

export interface MailConfigRow {
  id: string;
  mailbox: string;
  allowed_sender: string;
  subject_pattern: string;
  require_dmarc_pass: boolean;
  business_key_strategy: BusinessKeyStrategy;
  allowed_forwarders: string[];
}

export async function getActiveMailConfig(q: Queryable): Promise<MailConfigRow> {
  const r = await q.query<MailConfigRow>(
    `select id, mailbox, allowed_sender, subject_pattern, require_dmarc_pass, business_key_strategy, allowed_forwarders
       from mail_configs where active order by updated_at desc limit 1`,
  );
  const row = r.rows[0];
  if (!row) throw new AppError(409, 'MAIL_CONFIG_MISSING', 'No hay configuración de buzón activa');
  return row;
}

export async function createRun(
  deps: OrchestratorDeps,
  input: { actor: string; dateFrom: string; dateTo: string },
): Promise<RunDto> {
  let range;
  try {
    range = utcRangeForLocalDates(input.dateFrom, input.dateTo);
  } catch (e) {
    if (e instanceof DateRangeError) throw new AppError(400, 'INVALID_RANGE', e.message);
    throw e;
  }
  const cfg = await getActiveMailConfig(deps.db);
  try {
    const r = await deps.db.query<{ id: string }>(
      `insert into import_runs (mail_config_id, requested_by, date_from_local, date_to_local, utc_start, utc_end_exclusive)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [cfg.id, input.actor, input.dateFrom, input.dateTo, range.utcStart.toISOString(), range.utcEndExclusive.toISOString()],
    );
    const id = r.rows[0]?.id as string;
    await audit(deps.db, input.actor, 'run.create', 'import_run', id, { from: input.dateFrom, to: input.dateTo });
    log('run.created', { runId: id });
    return await getRunDto(deps.db, id);
  } catch (e) {
    if (sqlState(e) === '23505') {
      const active = await deps.db.query<{ id: string }>(
        `select id from import_runs where mail_config_id = $1 and status in ('pending','running','paused') limit 1`,
        [cfg.id],
      );
      throw new AppError(409, 'ACTIVE_RUN_EXISTS', 'Ya hay una importación activa para este buzón. Reanúdela o espere a que termine.', {
        runId: active.rows[0]?.id ?? null,
      });
    }
    throw e;
  }
}

interface RunRow {
  id: string;
  mail_config_id: string;
  status: string;
  cursor_next_link: string | null;
  utc_start: Date;
  utc_end_exclusive: Date;
}

/** Procesa UNA página (< 20 s). Reanudable: el cursor se guarda en la misma transacción que la página. */
export async function stepRun(deps: OrchestratorDeps, runId: string, actor: string): Promise<StepResultDto> {
  const leaseSeconds = deps.leaseSeconds ?? 60;

  let claimed: RunRow | undefined;
  try {
    const r = await deps.db.query<RunRow>(
      `update import_runs
          set status = 'running', lease_until = now() + ($2 || ' seconds')::interval,
              started_at = coalesce(started_at, now()), finished_at = null
        where id = $1 and status in ('pending','running','paused','failed')
          and (lease_until is null or lease_until < now())
        returning id, mail_config_id, status, cursor_next_link, utc_start, utc_end_exclusive`,
      [runId, String(leaseSeconds)],
    );
    claimed = r.rows[0];
  } catch (e) {
    if (sqlState(e) === '23505') {
      throw new AppError(409, 'ACTIVE_RUN_EXISTS', 'Ya hay otra importación activa para este buzón', { runId });
    }
    throw e;
  }

  if (!claimed) {
    const existing = await deps.db.query<{ status: string }>('select status from import_runs where id = $1', [runId]);
    if (!existing.rows[0]) throw new AppError(404, 'RUN_NOT_FOUND', 'Ejecución no encontrada');
    if (existing.rows[0].status === 'completed') {
      return { run: await getRunDto(deps.db, runId), done: true, retryAfterMs: null };
    }
    throw new AppError(409, 'RUN_LEASED', 'La ejecución está siendo procesada por otro paso. Reintente en unos segundos.');
  }

  const cfgRes = await deps.db.query<MailConfigRow>(
    `select id, mailbox, allowed_sender, subject_pattern, require_dmarc_pass, business_key_strategy, allowed_forwarders
       from mail_configs where id = $1`,
    [claimed.mail_config_id],
  );
  const cfg = cfgRes.rows[0] as MailConfigRow;

  const release = async (status: string, errorCode: string | null, cursorReset = false): Promise<void> => {
    await deps.db.query(
      `update import_runs set status = $2, error_code = $3, lease_until = null,
              cursor_next_link = case when $4 then null else cursor_next_link end
        where id = $1`,
      [runId, status, errorCode, cursorReset],
    );
  };

  let page;
  try {
    page = await deps.mail.fetchPage({
      mailbox: cfg.mailbox,
      utcStart: new Date(claimed.utc_start),
      utcEndExclusive: new Date(claimed.utc_end_exclusive),
      cursor: claimed.cursor_next_link,
    });
  } catch (e) {
    if (e instanceof ThrottledError) {
      await release('paused', 'THROTTLED');
      log('run.throttled', { runId, retryAfterMs: e.retryAfterMs });
      return { run: await getRunDto(deps.db, runId), done: false, retryAfterMs: e.retryAfterMs };
    }
    if (e instanceof CursorExpiredError) {
      await release('running', 'CURSOR_EXPIRED', true);
      log('run.cursor_expired', { runId });
      return { run: await getRunDto(deps.db, runId), done: false, retryAfterMs: 0 };
    }
    if (e instanceof MailSourceError) {
      await release('failed', e.code);
      log('run.failed', { runId, code: e.code, http: e.httpStatus });
      return { run: await getRunDto(deps.db, runId), done: false, retryAfterMs: null };
    }
    await release('paused', 'SOURCE_ERROR');
    log('run.source_error', { runId });
    return { run: await getRunDto(deps.db, runId), done: false, retryAfterMs: 1000 };
  }

  const nextCursor = page.nextCursor;
  try {
    await deps.db.transaction(async (tx) => {
      for (let i = 0; i < page.messages.length; i += 1) {
        await processMessage(tx, runId, cfg, page.messages[i] as MailMessage);
        if (deps.afterMessage) await deps.afterMessage(i);
      }
      await tx.query(
        `update import_runs set
            cursor_next_link = $2,
            pages_processed = pages_processed + 1,
            status = case when $2::text is null then 'completed' else 'running' end,
            finished_at = case when $2::text is null then now() else null end,
            lease_until = null, error_code = null, error_detail = null,
            found = (select count(*) from run_messages where run_id = $1),
            imported = (select count(*) from run_messages where run_id = $1 and outcome = 'imported'),
            duplicates = (select count(*) from run_messages where run_id = $1 and outcome = 'duplicate'),
            needs_review = (select count(*) from run_messages where run_id = $1 and outcome in ('needs_review','parse_error')),
            ignored = (select count(*) from run_messages where run_id = $1 and outcome in ('ignored_sender','ignored_subject'))
          where id = $1`,
        [runId, nextCursor],
      );
    });
  } catch (e) {
    // La transacción de la página se revirtió completa: nada quedó a medias.
    await release('paused', 'STEP_ERROR');
    log('run.step_error', { runId, state: sqlState(e), constraint: (e as { constraint?: string }).constraint ?? null });
    return { run: await getRunDto(deps.db, runId), done: false, retryAfterMs: 1000 };
  }

  log('run.step', { runId, messages: page.messages.length, done: nextCursor === null });

  if (nextCursor === null) {
    await generateExport(deps, runId, actor);
    return { run: await getRunDto(deps.db, runId), done: true, retryAfterMs: null };
  }
  return { run: await getRunDto(deps.db, runId), done: false, retryAfterMs: null };
}

/** Bucle de pasos (worker local / demo). */
export async function runToCompletion(
  deps: OrchestratorDeps,
  runId: string,
  actor: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxSteps = 10_000,
): Promise<RunDto> {
  for (let i = 0; i < maxSteps; i += 1) {
    const r = await stepRun(deps, runId, actor);
    if (r.done) return r.run;
    if (r.run.status === 'failed') return r.run;
    if (r.retryAfterMs) await sleep(r.retryAfterMs);
  }
  throw new Error('Se superó el máximo de pasos');
}

interface Issue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  field: string | null;
  detail: string;
}

async function processMessage(tx: Queryable, runId: string, cfg: MailConfigRow, msg: MailMessage): Promise<void> {
  const subj = subjectMatches(msg.subject, cfg.subject_pattern);
  const trust = evaluateSenderTrust({
    from: msg.from, sender: msg.sender, allowedSender: cfg.allowed_sender,
    allowedForwarders: cfg.allowed_forwarders ?? [], isForward: subj.isForward, body: msg.bodyContent,
  });
  const allowed = trust.trusted;
  const dmarc = dmarcStatus(msg.authenticationResults);
  const bodySha = createHash('sha256').update(msg.bodyContent).digest('hex');
  const ignored = !subj.matches || (!allowed && !subj.isForward);
  const untrusted = !ignored && (!allowed || (cfg.require_dmarc_pass && dmarc !== 'pass'));

  const ins = await tx.query<{ id: string }>(
    `insert into source_messages
       (mailbox, graph_immutable_id, internet_message_id, conversation_id, from_address, sender_address,
        subject, received_at, is_forward, auth_results, body_content_type, body_sha256, first_run_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict do nothing
     returning id`,
    [
      cfg.mailbox, msg.id, msg.internetMessageId, msg.conversationId, msg.from, msg.sender, msg.subject,
      msg.receivedDateTime, subj.isForward, msg.authenticationResults, msg.bodyContentType, bodySha, runId,
    ],
  );

  let messageId = ins.rows[0]?.id;
  if (!messageId) {
    const ex = await tx.query<{ id: string }>(
      `select id from source_messages where mailbox = $1 and (graph_immutable_id = $2 or internet_message_id = $3) limit 1`,
      [cfg.mailbox, msg.id, msg.internetMessageId],
    );
    messageId = ex.rows[0]?.id as string;
    // Ya procesado en ESTA ejecución (página reprocesada tras reinicio de cursor): no cuenta de nuevo.
    const seen = await tx.query(`select 1 from run_messages where run_id = $1 and message_id = $2`, [runId, messageId]);
    if (seen.rowCount > 0) return;
    await tx.query(`insert into run_messages (run_id, message_id, outcome) values ($1,$2,'duplicate')`, [runId, messageId]);
    return;
  }

  const setOutcome = async (outcome: Outcome): Promise<void> => {
    await tx.query(`insert into run_messages (run_id, message_id, outcome) values ($1,$2,$3)`, [runId, messageId, outcome]);
  };
  const addIssues = async (issues: Issue[], authorizationId: string | null): Promise<void> => {
    for (const i of issues) {
      await tx.query(
        `insert into import_issues (run_id, message_id, authorization_id, code, severity, field, detail)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, messageId, authorizationId, i.code, i.severity, i.field, i.detail],
      );
    }
  };

  if (ignored) {
    await setOutcome(subj.matches ? 'ignored_sender' : 'ignored_subject');
    return;
  }

  // Se conserva el cuerpo crudo (tabla sin SELECT para operadores) para revisión y reproceso.
  await tx.query(`insert into source_message_bodies (message_id, body_raw) values ($1,$2)`, [messageId, msg.bodyContent]);

  if (untrusted) {
    const issues: Issue[] = [];
    if (!allowed) {
      issues.push({ code: 'SENDER_NOT_ALLOWED', severity: 'warning', field: null, detail: 'Reenvío de un remitente no permitido; requiere revisión manual' });
    }
    if (cfg.require_dmarc_pass && dmarc !== 'pass') {
      issues.push({ code: 'DMARC_NOT_PASS', severity: 'warning', field: null, detail: `DMARC no verificado (${dmarc})` });
    }
    await addIssues(issues, null);
    await setOutcome('needs_review');
    return;
  }

  const parsed = parseAuthorization({ contentType: msg.bodyContentType, content: msg.bodyContent });
  const issues: Issue[] = parsed.issues.map((i) => ({ code: i.code, severity: i.severity, field: i.field, detail: i.detail }));
  if (trust.reason === 'internal_forward') {
    issues.push({
      code: 'FORWARDED_BY_INTERNAL_ACCOUNT', severity: 'info', field: null,
      detail: `Reenviado por ${msg.from ?? 'cuenta desconocida'}; el remitente original de Terpel se leyó del texto citado "De:" (no autenticado)`,
    });
  }
  const key = parsed.parseStatus === 'error' ? null : buildBusinessKey(cfg.business_key_strategy, parsed);
  if (parsed.parseStatus !== 'error' && key === null) {
    issues.push({ code: 'MISSING_BUSINESS_KEY', severity: 'error', field: null, detail: 'No se pudo construir la clave de negocio' });
  }

  const received = new Date(msg.receivedDateTime);

  if (key === null) {
    const authId = await insertAuthorization(tx, messageId, null, null, parsed, parsed.parseStatus === 'ok' ? 'error' : parsed.parseStatus);
    await addIssues(issues, authId);
    await setOutcome('parse_error');
    return;
  }

  // Servicio: una sola fila por clave de negocio.
  const insSvc = await tx.query<{ id: string }>(
    `insert into services (business_key, transport_number) values ($1,$2) on conflict (business_key) do nothing returning id`,
    [key, parsed.transportNumber],
  );
  let serviceId = insSvc.rows[0]?.id;
  if (!serviceId) {
    serviceId = (await tx.query<{ id: string }>(`select id from services where business_key = $1`, [key])).rows[0]?.id as string;
  }
  const svc = (
    await tx.query<{ version_count: number; current_authorization_id: string | null }>(
      `update services set version_count = version_count + 1, updated_at = now() where id = $1
       returning version_count, current_authorization_id`,
      [serviceId],
    )
  ).rows[0] as { version_count: number; current_authorization_id: string | null };
  const version = svc.version_count;
  const prevId = svc.current_authorization_id;

  const authId = await insertAuthorization(tx, messageId, serviceId, version, parsed, parsed.parseStatus);

  if (prevId) {
    const diff = await diffAuthorizations(tx, prevId, authId);
    if (diff.length > 0) {
      issues.push({
        code: 'CORRECTED_AUTHORIZATION',
        severity: 'warning',
        field: null,
        detail: `Nueva versión ${version} con valores distintos en: ${diff.join(', ')}. Revisar cuál es la vigente.`,
      });
    } else {
      issues.push({ code: 'RESENT_AUTHORIZATION', severity: 'info', field: null, detail: `Reenvío idéntico (versión ${version})` });
    }
    const prevReceived = (
      await tx.query<{ received_at: Date }>(
        `select m.received_at from authorizations a join source_messages m on m.id = a.message_id where a.id = $1`,
        [prevId],
      )
    ).rows[0]?.received_at;
    if (!prevReceived || received.getTime() >= new Date(prevReceived).getTime()) {
      await tx.query(`update services set current_authorization_id = $2 where id = $1`, [serviceId, authId]);
    }
  } else {
    await tx.query(`update services set current_authorization_id = $2 where id = $1`, [serviceId, authId]);
    if (subj.isForward && trust.reason !== 'internal_forward') {
      issues.push({ code: 'FORWARDED_MESSAGE', severity: 'info', field: null, detail: 'Mensaje reenviado (RV:/FW:) sin versión previa' });
    }
  }

  await addIssues(issues, authId);
  const review = issues.some((i) => i.severity !== 'info');
  await setOutcome(review ? 'needs_review' : 'imported');
}

async function insertAuthorization(
  tx: Queryable,
  messageId: string,
  serviceId: string | null,
  version: number | null,
  p: ParsedAuthorization,
  status: string,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into authorizations
       (message_id, service_id, version, parse_status, parser_version, template_variant,
        transport_number, remission_number, expense_number, service_date, service_date_raw,
        loading_plant, loading_plant_flag, purchase_doc, service_entry_sheet,
        net_value, net_value_raw, currency, plate, plate_normalized, route,
        transport_volume, transport_volume_raw, transport_volume_unit, unit_status,
        rate, rate_raw, driver_code, driver_name, raw_fields)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb)
     returning id`,
    [
      messageId, serviceId, version, status, p.parserVersion, p.templateVariant,
      p.transportNumber, p.remissionNumber, p.expenseNumber, p.serviceDate, p.serviceDateRaw,
      p.loadingPlant, p.loadingPlantFlag, p.purchaseDoc, p.serviceEntrySheet,
      p.netValue, p.netValueRaw, p.currency, p.plate, p.plateNormalized, p.route,
      p.transportVolume, p.transportVolumeRaw, p.transportVolumeUnit, p.unitStatus,
      p.rate, p.rateRaw, p.driverCode, p.driverName, JSON.stringify(p.rawFields),
    ],
  );
  return r.rows[0]?.id as string;
}

const COMPARED_FIELDS = [
  'remission_number', 'expense_number', 'service_date', 'loading_plant', 'purchase_doc', 'service_entry_sheet',
  'net_value', 'currency', 'plate_normalized', 'route', 'transport_volume', 'rate', 'driver_code', 'driver_name',
] as const;

/** Compara dos versiones en SQL (numeric/fecha canónicos) y devuelve los NOMBRES de campos distintos. */
async function diffAuthorizations(tx: Queryable, prevId: string, newId: string): Promise<string[]> {
  const cols = COMPARED_FIELDS.map((f) => `(a.${f} is distinct from b.${f}) as ${f}`).join(', ');
  const r = await tx.query<Record<string, boolean>>(
    `select ${cols} from authorizations a, authorizations b where a.id = $1 and b.id = $2`,
    [prevId, newId],
  );
  const row = r.rows[0] ?? {};
  return COMPARED_FIELDS.filter((f) => row[f] === true);
}
