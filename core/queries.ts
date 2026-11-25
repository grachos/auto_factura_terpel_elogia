import type { Queryable } from './db/types.js';
import { AppError } from './errors.js';
import type { ExportDto, IssueDto, MailConfigDto, Outcome, ResultRowDto, RunDetailDto, RunDto } from './types.js';

const RUN_SELECT = `
  select r.id, c.mailbox, r.status, r.date_from_local::text as date_from_local, r.date_to_local::text as date_to_local,
         r.utc_start, r.utc_end_exclusive, r.pages_processed, r.found, r.imported, r.duplicates, r.needs_review,
         r.ignored, r.export_status, r.error_code, r.created_at, r.started_at, r.finished_at
    from import_runs r join mail_configs c on c.id = r.mail_config_id`;

interface RunRow {
  id: string;
  mailbox: string;
  status: RunDto['status'];
  date_from_local: string;
  date_to_local: string;
  utc_start: Date;
  utc_end_exclusive: Date;
  pages_processed: number;
  found: number;
  imported: number;
  duplicates: number;
  needs_review: number;
  ignored: number;
  export_status: RunDto['exportStatus'];
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toRunDto(r: RunRow): RunDto {
  return {
    id: r.id,
    mailbox: r.mailbox,
    status: r.status,
    dateFromLocal: r.date_from_local,
    dateToLocal: r.date_to_local,
    utcStart: new Date(r.utc_start).toISOString(),
    utcEndExclusive: new Date(r.utc_end_exclusive).toISOString(),
    pagesProcessed: r.pages_processed,
    found: r.found,
    imported: r.imported,
    duplicates: r.duplicates,
    needsReview: r.needs_review,
    ignored: r.ignored,
    exportStatus: r.export_status,
    errorCode: r.error_code,
    createdAt: iso(r.created_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export async function getRunDto(q: Queryable, id: string): Promise<RunDto> {
  const r = await q.query<RunRow>(`${RUN_SELECT} where r.id = $1`, [id]);
  if (!r.rows[0]) throw new AppError(404, 'RUN_NOT_FOUND', 'Ejecución no encontrada');
  return toRunDto(r.rows[0]);
}

export async function listRunDtos(q: Queryable, limit = 50): Promise<RunDto[]> {
  const r = await q.query<RunRow>(`${RUN_SELECT} order by r.created_at desc limit $1`, [limit]);
  return r.rows.map(toRunDto);
}

export interface BatchRow {
  business_key: string;
  transport_number: string;
  version_count: number;
  version: number | null;
  outcome: Outcome;
  parse_status: string;
  template_variant: string | null;
  parser_version: string;
  remission_number: string | null;
  expense_number: string | null;
  service_date: string | null;
  loading_plant: string | null;
  purchase_doc: string | null;
  service_entry_sheet: string | null;
  net_value: string | null;
  net_value_raw: string | null;
  currency: string | null;
  plate: string | null;
  plate_normalized: string | null;
  route: string | null;
  transport_volume: string | null;
  transport_volume_raw: string | null;
  transport_volume_unit: string | null;
  unit_status: string;
  rate: string | null;
  rate_raw: string | null;
  driver_code: string | null;
  driver_name: string | null;
  received_at: Date;
  issue_count: number;
}

/**
 * Servicios del lote: los vinculados a los mensajes de la ejecución (importados, duplicados o en revisión),
 * con la versión vigente de cada uno. Una fila por servicio. Es la base de la hoja "Servicios" y de la UI.
 */
export async function getBatchRows(q: Queryable, runId: string): Promise<BatchRow[]> {
  const r = await q.query<BatchRow>(
    `with batch as (
       select a.service_id,
              case when bool_or(rm.outcome in ('needs_review','parse_error')) then 'needs_review'
                   when bool_or(rm.outcome = 'imported') then 'imported'
                   else 'duplicate' end as outcome
         from run_messages rm
         join authorizations a on a.message_id = rm.message_id
        where rm.run_id = $1 and a.service_id is not null
        group by a.service_id)
     select s.business_key, s.transport_number, s.version_count, a.version, b.outcome,
            a.parse_status, a.template_variant, a.parser_version,
            a.remission_number, a.expense_number, a.service_date::text as service_date,
            a.loading_plant, a.purchase_doc, a.service_entry_sheet,
            a.net_value::text as net_value, a.net_value_raw, a.currency, a.plate, a.plate_normalized, a.route,
            a.transport_volume::text as transport_volume, a.transport_volume_raw, a.transport_volume_unit, a.unit_status,
            a.rate::text as rate, a.rate_raw, a.driver_code, a.driver_name, m.received_at,
            (select count(*)::int from import_issues i
               join authorizations ia on ia.id = i.authorization_id
              where i.run_id = $1 and ia.service_id = s.id) as issue_count
       from batch b
       join services s on s.id = b.service_id
       join authorizations a on a.id = s.current_authorization_id
       join source_messages m on m.id = a.message_id
      order by s.business_key`,
    [runId],
  );
  return r.rows;
}

export interface IssueRow {
  id: string;
  code: string;
  severity: 'info' | 'warning' | 'error';
  field: string | null;
  detail: string | null;
  business_key: string | null;
  message_id: string | null;
}

export async function getRunIssues(q: Queryable, runId: string): Promise<IssueRow[]> {
  const r = await q.query<IssueRow>(
    `select i.id, i.code, i.severity, i.field, i.detail, i.message_id, s.business_key
       from import_issues i
       left join authorizations a on a.id = i.authorization_id
       left join services s on s.id = a.service_id
      where i.run_id = $1
      order by case i.severity when 'error' then 0 when 'warning' then 1 else 2 end, i.created_at, i.id`,
    [runId],
  );
  return r.rows;
}

export async function getRunExports(q: Queryable, runId: string): Promise<(ExportDto & { storagePath: string | null })[]> {
  const r = await q.query<{
    id: string; status: 'ready' | 'failed'; row_count: number | null; issue_count: number | null;
    sha256: string | null; generated_at: Date; storage_path: string | null;
  }>(
    `select id, status, row_count, issue_count, sha256, generated_at, storage_path
       from export_files where run_id = $1 order by generated_at desc, id`,
    [runId],
  );
  return r.rows.map((x) => ({
    id: x.id, status: x.status, rowCount: x.row_count, issueCount: x.issue_count, sha256: x.sha256,
    generatedAt: new Date(x.generated_at).toISOString(), storagePath: x.storage_path,
  }));
}

export async function getRunDetail(q: Queryable, runId: string): Promise<RunDetailDto> {
  const run = await getRunDto(q, runId);
  const rows = await getBatchRows(q, runId);
  const issues = await getRunIssues(q, runId);
  const exportsList = (await getRunExports(q, runId)).map(({ storagePath: _p, ...rest }) => rest);
  const outcomes: Record<string, number> = {};
  const oc = await q.query<{ outcome: string; n: number }>(
    `select outcome, count(*)::int as n from run_messages where run_id = $1 group by outcome`,
    [runId],
  );
  for (const o of oc.rows) outcomes[o.outcome] = o.n;
  const results: ResultRowDto[] = rows.map((r) => ({
    businessKey: r.business_key,
    transportNumber: r.transport_number,
    version: r.version,
    versionCount: r.version_count,
    outcome: r.outcome,
    parseStatus: r.parse_status,
    serviceDate: r.service_date,
    plate: r.plate,
    route: r.route,
    netValue: r.net_value,
    currency: r.currency,
    transportVolumeRaw: r.transport_volume_raw,
    transportVolume: r.transport_volume,
    issueCount: r.issue_count,
  }));
  return {
    run,
    results,
    issues: issues.map((i) => ({ id: i.id, code: i.code, severity: i.severity, field: i.field, detail: i.detail, businessKey: i.business_key }) satisfies IssueDto),
    exports: exportsList,
    outcomes,
  };
}

interface ConfigRow {
  id: string;
  mailbox: string;
  allowed_sender: string;
  subject_pattern: string;
  require_dmarc_pass: boolean;
  business_key_strategy: 'transport_number' | 'transport_expense';
  allowed_forwarders: string[];
}

export async function getMailConfigDto(q: Queryable): Promise<MailConfigDto> {
  const r = await q.query<ConfigRow>(
    `select id, mailbox, allowed_sender, subject_pattern, require_dmarc_pass, business_key_strategy, allowed_forwarders
       from mail_configs where active order by updated_at desc limit 1`,
  );
  const c = r.rows[0];
  if (!c) throw new AppError(404, 'MAIL_CONFIG_MISSING', 'No hay configuración de buzón');
  return {
    id: c.id, mailbox: c.mailbox, allowedSender: c.allowed_sender, subjectPattern: c.subject_pattern,
    requireDmarcPass: c.require_dmarc_pass, businessKeyStrategy: c.business_key_strategy,
    allowedForwarders: c.allowed_forwarders ?? [],
  };
}
