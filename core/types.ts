// Tipos compartidos entre API y UI (solo tipos; sin dependencias).
export type Role = 'operator' | 'admin' | 'viewer' | 'facturacion';
export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';
export type ExportStatus = 'pending' | 'ready' | 'failed';
export type Outcome = 'imported' | 'duplicate' | 'needs_review' | 'ignored_sender' | 'ignored_subject' | 'parse_error';

export interface RunDto {
  id: string;
  mailbox: string;
  status: RunStatus;
  dateFromLocal: string;
  dateToLocal: string;
  utcStart: string;
  utcEndExclusive: string;
  pagesProcessed: number;
  found: number;
  imported: number;
  duplicates: number;
  needsReview: number;
  ignored: number;
  exportStatus: ExportStatus;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StepResultDto {
  run: RunDto;
  done: boolean;
  retryAfterMs: number | null;
}

export interface ResultRowDto {
  businessKey: string;
  transportNumber: string;
  version: number | null;
  versionCount: number;
  outcome: Outcome;
  parseStatus: string | null;
  serviceDate: string | null;
  plate: string | null;
  route: string | null;
  netValue: string | null;
  currency: string | null;
  transportVolumeRaw: string | null;
  transportVolume: string | null;
  issueCount: number;
}

export interface IssueDto {
  id: string;
  code: string;
  severity: 'info' | 'warning' | 'error';
  field: string | null;
  detail: string | null;
  businessKey: string | null;
}

export interface ExportDto {
  id: string;
  status: 'ready' | 'failed';
  rowCount: number | null;
  issueCount: number | null;
  sha256: string | null;
  generatedAt: string;
}

export interface RunDetailDto {
  run: RunDto;
  results: ResultRowDto[];
  issues: IssueDto[];
  exports: ExportDto[];
  /** Resumen de resultados por mensaje (incluye ignorados). */
  outcomes: Record<string, number>;
}

export interface MailConfigDto {
  id: string;
  mailbox: string;
  allowedSender: string;
  subjectPattern: string;
  requireDmarcPass: boolean;
  businessKeyStrategy: 'transport_number' | 'transport_expense';
  allowedForwarders: string[];
}

export interface MeDto {
  id: string;
  email: string | null;
  role: Role;
  /** Permisos efectivos (matriz central en core/permissions.ts). */
  permissions: string[];
  displayName: string | null;
  silogUser: string | null;
  loginKind: 'supabase' | 'silogtran';
}

export interface PublicConfigDto {
  authMode: 'demo' | 'supabase';
  mailSource: string;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  demoUsers: { email: string; role: Role }[];
  silogSource: 'api' | 'mock' | 'none';
  /** El ingreso con usuario de Silogtran está disponible (base URL y APP_SESSION_SECRET configurados). */
  silogLogin: boolean;
}

export interface ApiErrorDto {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ---- Fase 2: conciliación con Silogtran ----------------------------------------------------
export type ReconStatus = 'EXACT' | 'MATCH_WITH_DIFFERENCES' | 'AMBIGUOUS' | 'NO_MATCH' | 'INSUFFICIENT_DATA';
export type ReconRunStatus = 'pending' | 'syncing' | 'reconciling' | 'completed' | 'failed';
export type FilterKeyDto = 'driver' | 'plate' | 'route' | 'date';
export type FilterModeDto = 'exclusive' | 'preferred';

export interface ReconRunDto {
  id: string;
  dateFrom: string;
  dateTo: string;
  syncEnabled: boolean;
  lookbackDays: number;
  windowDays: number;
  rulesVersion: string;
  status: ReconRunStatus;
  syncCursor: string | null;
  syncEnd: string | null;
  reconcileOffset: number;
  totalServices: number;
  exact: number;
  withDifferences: number;
  ambiguous: number;
  noMatch: number;
  insufficient: number;
  exportStatus: ExportStatus;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ReconStepDto {
  run: ReconRunDto;
  done: boolean;
  retryAfterMs: number | null;
  /** Mensaje claro (sin datos sensibles) cuando el paso falló. */
  message: string | null;
}

export interface TraceStepDto {
  filter: FilterKeyDto;
  before: number;
  after: number;
  mode: FilterModeDto;
  skipped: boolean;
  reason?: string;
}

export interface DifferenceDto {
  field: string;
  terpel: string | number | null;
  silogtran: string | number | null;
  severity: 'adjustable' | 'info';
  note?: string;
}

export interface SilogRecordDto {
  id: string;
  manifest: string;
  remesaCode: string;
  dispatchDate: string | null;
  deliveryDate: string | null;
  plate: string | null;
  driverName: string | null;
  driverDocument: string | null;
  origin: string | null;
  destination: string | null;
  remesaWeight: string | null;
  netLoadWeight: string | null;
  rate: string | null;
  totalRemesa: string | null;
  status: string | null;
  remesaStatus: string | null;
  invoice: string | null;
}

export interface ReconResultDto {
  id: string;
  transportNumber: string;
  serviceDate: string;
  status: ReconStatus;
  reason: string | null;
  reasonCode: string | null;
  weightSource: 'terpel' | 'silogtran' | null;
  rulesVersion: string;
  terpel: {
    route: string | null;
    plate: string | null;
    driverCode: string | null;
    driverName: string | null;
    volume: string | null;
    netValue: string | null;
  };
  silog: SilogRecordDto | null;
  candidates: SilogRecordDto[];
  trace: TraceStepDto[];
  differences: DifferenceDto[];
  manual: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface MatchFilterDto {
  key: FilterKeyDto;
  position: number;
  active: boolean;
  mode: FilterModeDto;
}

export interface PlaceAliasDto {
  id: string;
  silogName: string;
  terpelName: string;
}

export interface ReconSettingsDto {
  windowDays: number;
  lookbackDays: number;
  terpelNit: string;
  zeroVolumeMode: 'ignore' | 'reconcile_if_value_matches' | 'reconcile_always';
}

export interface ReconParamsDto {
  filters: MatchFilterDto[];
  aliases: PlaceAliasDto[];
  settings: ReconSettingsDto;
}

export interface ReconRunDetailDto {
  run: ReconRunDto;
  results: ReconResultDto[];
}
