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
  /** Escritor de ajustes: mock = MODO SIMULADO (Silogtran no se modifica). */
  writerKind: 'mock' | 'web';
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

// ---- Fase 3: ajustes de tarifa ---------------------------------------------------------------------
export type ProposalStatus =
  | 'proposed' | 'needs_review' | 'approved' | 'applying' | 'applied' | 'simulated_applied' | 'failed' | 'uncertain'
  | 'verification_failed' | 'rejected' | 'stale' | 'discarded';

export interface ProposalLineDto {
  field: 'pesoRemesa' | 'cantidadRemesa' | 'nuevaTarifa' | 'totalRemesa';
  label: string;
  current: string | null; // null = no disponible en el informe
  proposed: string | null;
  rule: string;
}

export interface ProposalDto {
  id: string;
  transportNumber: string;
  expenseNumber: string | null;
  serviceDate: string;
  status: ProposalStatus;
  reviewCode: string | null;
  reviewDetail: string | null;
  remesaCode: string | null;
  manifest: string | null;
  weightSource: 'terpel' | 'silogtran' | null;
  gallons: string | null;
  tariff: string | null;
  currentWeight: string | null;
  currentTotal: string | null;
  targetValue: string | null;
  reason: string | null;
  lines: ProposalLineDto[];
  simulated: boolean;
  writerKind: string | null;
  accountUser: string | null;
  generatedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  verification: Record<string, unknown> | null;
  lastError: string | null;
  autoEligible: boolean;
  autoReasons: string[];
  autoAllowed: boolean;
  rulesVersion: string;
  updatedAt: string;
  kind: 'adjust' | 'reversal';
  reversalOf: string | null;
  quantity: string | null;
  /** Valores anteriores de la pantalla, guardados antes de grabar (para revertir). */
  reversalValues: ScreenValuesDto | null;
}

export interface ProposalEventDto {
  id: number;
  at: string;
  actor: string | null;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  simulated: boolean;
  detail: Record<string, unknown>;
}

export interface AdjustSettingsDto {
  reasonTemplate: string;
  autoEnabled: boolean;
  /** Modo efectivo del escritor: mock (simulado) o web (escritura REAL). */
  writerMode: 'mock' | 'web';
  /** Códigos de remesa permitidos para la escritura real (sin ceros a la izquierda). */
  writerAllowlist: string[];
  /** Si true, la escritura real se permite en cualquier remesa (exige confirmación explícita al activarlo). */
  writerAllowAll: boolean;
}

export interface WriterStatusDto {
  mode: 'mock' | 'web';
  simulated: boolean;
  allowAll: boolean;
  allowlist: string[];
}

export interface ScreenValuesDto { peso: string; cantidad: string; tarifa: string }

export interface RehearsalDto {
  proposalId: string;
  simulated: boolean;
  writerKind: string;
  payload: { remesaCode: string; reason: string; pesoRemesa: string; cantidadRemesa: string; nuevaTarifa: string };
  /** Valores anteriores de la pantalla (reversa). */
  before: ScreenValuesDto | null;
  checks: { name: string; ok: boolean; detail?: string }[];
  allChecksOk: boolean;
  wouldPostGrabar: false;
}

export interface ApplyPreviewDto {
  proposalId: string;
  simulated: boolean;
  writerKind: string;
  accountUser: string | null;
  accountConfigured: boolean;
  blocked: string | null;
  payload: { remesaCode: string; reason: string; pesoRemesa: string; cantidadRemesa: string; nuevaTarifa: string } | null;
}

// ---- Modo asistido -----------------------------------------------------------------------------------
export type AssistedCategory = 'terpel_pending' | 'ambiguous' | 'no_match' | 'insufficient' | 'already_adjusted' | 'needs_review' | 'not_allowed' | 'applied' | 'attention' | 'not_eligible';

export interface AssistedExcludedDto { category: AssistedCategory; transportNumber: string; remesaCode: string | null; reason: string; proposalId: string | null }

export interface AssistedPlanItemDto {
  proposalId: string;
  transportNumber: string;
  remesaCode: string | null;
  status: ProposalStatus;
  current: { peso: string | null; cantidad: string | null; tarifa: string | null; total: string | null };
  proposed: { peso: string | null; cantidad: string | null; tarifa: string | null; total: string | null };
}

export interface AssistedPlanDto {
  reconRunId: string;
  writer: WriterStatusDto;
  eligible: AssistedPlanItemDto[];
  excluded: AssistedExcludedDto[];
  generated: { created: number; refreshed: number; unchanged: number; needsReview: number; staled: number; total: number } | null;
}

export type AssistedItemResult = 'pending' | 'applied' | 'skipped' | 'halted' | 'failed';

export interface AssistedItemDto {
  position: number;
  proposalId: string;
  transportNumber: string | null;
  remesaCode: string | null;
  result: AssistedItemResult;
  reason: string | null;
  before: ScreenValuesDto | null;
  after: ScreenValuesDto | null;
  reversal: ScreenValuesDto | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AssistedRunDto {
  id: string;
  reconRunId: string;
  status: 'running' | 'completed' | 'halted';
  writerMode: string;
  simulated: boolean;
  total: number;
  applied: number;
  skipped: number;
  pending: number;
  haltedReason: string | null;
  excluded: AssistedExcludedDto[];
  exportReady: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface AssistedRunDetailDto { run: AssistedRunDto; items: AssistedItemDto[]; done: boolean }

// ---- Fase 4a: facturación -------------------------------------------------------------------------------
export type InvoiceStatus = 'eligible' | 'rehearsed' | 'issuing' | 'issued' | 'failed' | 'uncertain' | 'verification_failed' | 'skipped' | 'simulated' | 'discarded';

export interface InvoiceSettingsDto {
  costCenter: string; client: string; printableName: string; seller: string; paymentDays: number; paymentCity: string; currency: string; paymentMethod: string;
  invoiceType: string; divide: 'SI' | 'NO'; maxRemesas: number; withholdingPercent: number; observationTemplate: string;
  writerMode: 'mock' | 'web'; writerAllowlist: string[]; writerAllowAll: boolean; batchEnabled: boolean;
}

export interface InvoiceWriterStatusDto { mode: 'mock' | 'web'; simulated: boolean; allowAll: boolean; allowlist: string[]; batchEnabled: boolean }

export interface InvoiceAmountsDto { freight: string; withholding: string; total: string }

export interface InvoiceListingDto {
  remesa: string; plate: string | null; date: string | null; delivered: string | null; pesoNeto: string | null; unidades: string | null; tarifaCliente: string | null;
  tarifa: string | null; total: string | null; otros: string | null; origin: string | null; destination: string | null; product: string | null; description: string | null;
  /** Observación que la pantalla traía antes de escribir la nuestra (si trae alguna). */
  preloadedObservation?: string | null;
}

export interface InvoiceDto {
  id: string; remesaCode: string; transportNumber: string; plate: string | null; serviceDate: string; terpelValue: string; expectedFreight: string;
  status: InvoiceStatus; reviewCode: string | null; reviewDetail: string | null; valuesBefore: Record<string, unknown> | null; valuesAfter: Record<string, unknown> | null;
  invoiceNumber: string | null; accountUser: string | null; writerKind: string | null; simulated: boolean; observation: string | null; product: string | null; issuedBy: string | null;
  issuedAt: string | null; lastError: string | null; updatedAt: string;
}

export interface InvoiceExcludedDto { category: string; transportNumber: string; remesaCode: string | null; reason: string }

export interface InvoicePlanDto { reconRunId: string; writer: InvoiceWriterStatusDto; eligible: InvoiceDto[]; excluded: InvoiceExcludedDto[] }

export interface InvoiceRehearsalDto {
  invoiceId: string; simulated: boolean; writerKind: string; listing: InvoiceListingDto | null; amounts: InvoiceAmountsDto | null; observation: string; purchaseOrder: string;
  checks: { name: string; ok: boolean; detail?: string }[]; allChecksOk: boolean; wouldIssue: false;
}

export type InvoiceItemResult = 'pending' | 'issued' | 'skipped' | 'halted' | 'failed';

export interface InvoiceRunItemDto {
  position: number; invoiceId: string; remesaCode: string | null; transportNumber: string | null; result: InvoiceItemResult; reason: string | null;
  invoiceNumber: string | null; amounts: InvoiceAmountsDto | null; startedAt: string | null; finishedAt: string | null;
}

export interface InvoiceRunDto {
  id: string; reconRunId: string; status: 'running' | 'completed' | 'halted'; writerMode: string; simulated: boolean; total: number; issued: number; skipped: number;
  pending: number; haltedReason: string | null; excluded: InvoiceExcludedDto[]; exportReady: boolean; createdAt: string; finishedAt: string | null;
}

export interface InvoiceRunDetailDto { run: InvoiceRunDto; items: InvoiceRunItemDto[]; done: boolean }
