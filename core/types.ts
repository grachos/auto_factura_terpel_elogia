// Tipos compartidos entre API y UI (solo tipos; sin dependencias).
export type Role = 'operator' | 'admin' | 'viewer';
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
  loadingPlantFlag: string | null;
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
}

export interface PublicConfigDto {
  authMode: 'demo' | 'supabase';
  mailSource: string;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  demoUsers: { email: string; role: Role }[];
}

export interface ApiErrorDto {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
