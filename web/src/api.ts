import type {
  AdjustSettingsDto, ApplyPreviewDto, AssistedPlanDto, AssistedRunDetailDto, AssistedRunDto, ProposalDto, ProposalEventDto, RehearsalDto, WriterStatusDto,
  ApiErrorDto, MailConfigDto, MatchFilterDto, MeDto, PlaceAliasDto, PublicConfigDto, ReconParamsDto, ReconResultDto, ReconRunDetailDto,
  ManualCandidateDto, InvoiceDto, InvoicePlanDto, InvoiceRehearsalDto, InvoiceRunDetailDto, InvoiceRunDto, InvoiceSettingsDto,
  ReconRunDto, ReconSettingsDto, ReconStepDto, RunDetailDto, RunDto, StepResultDto,
} from '../../core/types';

export interface AppUserDto {
  id: string; silogUser: string; displayName: string | null; company: string | null; role: string; active: boolean;
  lastLoginAt: string | null; hasStoredPassword: boolean; credentialUpdatedAt: string | null; lastTestAt: string | null; lastTestOk: boolean | null;
}
export interface ServiceCredentialDto {
  purpose: 'adjust' | 'invoice'; saved: boolean; silogUser: string | null; updatedAt: string | null; lastTestAt: string | null; lastTestOk: boolean | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type TokenGetter = () => Promise<string | null>;
let getToken: TokenGetter = async () => null;
let onUnauthorized: () => void = () => undefined;

export function configureAuth(tokenGetter: TokenGetter, unauthorized: () => void): void {
  getToken = tokenGetter;
  onUnauthorized = unauthorized;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (json as ApiErrorDto | null)?.error;
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Error inesperado', e?.details);
  }
  return json as T;
}

export const api = {
  config: () => request<PublicConfigDto>('GET', '/api/config'),
  demoLogin: (email: string, password: string) => request<{ token: string }>('POST', '/api/auth/demo-login', { email, password }),
  me: () => request<MeDto>('GET', '/api/me'),
  listRuns: () => request<{ runs: RunDto[] }>('GET', '/api/runs'),
  createRun: (dateFrom: string, dateTo: string) => request<RunDto>('POST', '/api/runs', { dateFrom, dateTo }),
  step: (id: string) => request<StepResultDto>('POST', `/api/runs/${id}/step`),
  detail: (id: string) => request<RunDetailDto>('GET', `/api/runs/${id}`),
  regenerate: (id: string) => request<{ status: 'ready' | 'failed' }>('POST', `/api/runs/${id}/export`),
  exportUrl: (id: string) => request<{ url: string; expiresInSeconds: number }>('GET', `/api/runs/${id}/export/url`),
  getMailConfig: () => request<MailConfigDto>('GET', '/api/mail-config'),
  saveMailConfig: (c: Omit<MailConfigDto, 'id'>) => request<MailConfigDto>('PUT', '/api/mail-config', c),
  silogLogin: (usuario: string, clave: string) => request<{ token: string; expiresInSeconds: number }>('POST', '/api/auth/silog-login', { usuario, clave }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  listUsers: () => request<{ users: AppUserDto[] }>('GET', '/api/users'),
  createUser: (silogUser: string, role: string, displayName?: string) => request<AppUserDto>('POST', '/api/users', { silogUser, role, displayName }),
  updateUser: (id: string, patch: { role?: string; active?: boolean; displayName?: string }) => request<AppUserDto>('PUT', `/api/users/${id}`, patch),
  saveUserPassword: (id: string, password: string) => request<AppUserDto>('PUT', `/api/users/${id}/credential`, { password }),
  deleteUserPassword: (id: string) => request<AppUserDto>('DELETE', `/api/users/${id}/credential`),
  testUserPassword: (id: string) => request<{ ok: boolean; testedAt: string }>('POST', `/api/users/${id}/credential/test`),
  serviceCredentials: () => request<{ credentials: ServiceCredentialDto[] }>('GET', '/api/service-credentials'),
  saveServiceCredential: (purpose: string, silogUser: string, password: string) => request<{ credentials: ServiceCredentialDto[] }>('PUT', `/api/service-credentials/${purpose}`, { silogUser, password }),
  testServiceCredential: (purpose: string) => request<{ ok: boolean; testedAt: string }>('POST', `/api/service-credentials/${purpose}/test`),
  // Fase 3
  generateProposals: (runId: string) => request<{ created: number; refreshed: number; unchanged: number; needsReview: number; staled: number; total: number }>('POST', `/api/reconciliations/${runId}/adjustments/generate`),
  listProposals: (runId: string, status?: string) => request<{ proposals: ProposalDto[]; writerKind: string; simulated: boolean }>('GET', `/api/adjustments?runId=${runId}${status ? `&status=${status}` : ''}`),
  proposalDetail: (id: string) => request<{ proposal: ProposalDto; events: ProposalEventDto[] }>('GET', `/api/adjustments/${id}`),
  simulateProposal: (id: string) => request<ApplyPreviewDto>('POST', `/api/adjustments/${id}/simulate`),
  approveProposal: (id: string) => request<ProposalDto>('POST', `/api/adjustments/${id}/approve`),
  rejectProposal: (id: string) => request<ProposalDto>('POST', `/api/adjustments/${id}/reject`, {}),
  applyProposal: (id: string) => request<ProposalDto>('POST', `/api/adjustments/${id}/apply`),
  checkProposal: (id: string) => request<ProposalDto>('POST', `/api/adjustments/${id}/check`),
  applyBatch: (ids: string[]) => request<{ results: { id: string; ok: boolean; status?: string; code?: string; message?: string }[] }>('POST', '/api/adjustments/apply-batch', { ids }),
  adjustSettings: () => request<AdjustSettingsDto>('GET', '/api/adjustments/settings'),
  saveAdjustSettings: (s: Partial<AdjustSettingsDto> & { confirmAll?: boolean }) => request<AdjustSettingsDto>('PUT', '/api/adjustments/settings', s),
  writerStatus: () => request<WriterStatusDto>('GET', '/api/adjustments/writer-status'),
  rehearseProposal: (id: string, real = false) => request<RehearsalDto>('POST', `/api/adjustments/${id}/rehearse`, real ? { real: true } : {}),
  revertProposal: (id: string) => request<ProposalDto>('POST', `/api/adjustments/${id}/revert`),
  discardSimulated: () => request<{ discarded: number }>('POST', '/api/adjustments/discard-simulated'),
  exportAdjustments: (runId: string) => request<{ url: string; rows: number }>('POST', '/api/adjustments/export', { runId }),
  assistedPlan: (reconRunId: string) => request<AssistedPlanDto>('POST', `/api/reconciliations/${reconRunId}/assisted/plan`),
  assistedCreate: (reconRunId: string, proposalIds: string[]) => request<AssistedRunDetailDto>('POST', '/api/assisted-runs', { reconRunId, proposalIds, confirm: true }),
  assistedStep: (id: string, resume = false) => request<AssistedRunDetailDto>('POST', `/api/assisted-runs/${id}/step`, resume ? { resume: true } : {}),
  assistedGet: (id: string) => request<AssistedRunDetailDto>('GET', `/api/assisted-runs/${id}`),
  assistedList: (reconRunId: string) => request<{ runs: AssistedRunDto[] }>('GET', `/api/assisted-runs?reconRunId=${reconRunId}`),
  assistedExport: (id: string) => request<{ url: string }>('POST', `/api/assisted-runs/${id}/export`),
  // Fase 4a: facturación
  invoicePlan: (reconRunId: string) => request<InvoicePlanDto>('POST', `/api/reconciliations/${reconRunId}/invoices/plan`),
  invoiceView: (reconRunId: string) => request<InvoicePlanDto>('GET', `/api/reconciliations/${reconRunId}/invoices/view`),
  invoiceSettings: () => request<InvoiceSettingsDto>('GET', '/api/invoices/settings'),
  saveInvoiceSettings: (s: Partial<InvoiceSettingsDto> & { confirmAll?: boolean }) => request<InvoiceSettingsDto>('PUT', '/api/invoices/settings', s),
  invoiceRehearse: (id: string) => request<InvoiceRehearsalDto>('POST', `/api/invoices/${id}/rehearse`),
  invoiceIssue: (id: string) => request<InvoiceDto>('POST', `/api/invoices/${id}/issue`, { confirm: true }),
  invoiceCheck: (id: string) => request<InvoiceDto>('POST', `/api/invoices/${id}/check`),
  invoiceList: (status?: string) => request<{ invoices: InvoiceDto[] }>('GET', `/api/invoices${status ? `?status=${status}` : ''}`),
  invoiceRunCreate: (reconRunId: string, invoiceIds: string[]) => request<InvoiceRunDetailDto>('POST', '/api/invoice-runs', { reconRunId, invoiceIds, confirm: true }),
  invoiceRunStep: (id: string, resume = false) => request<InvoiceRunDetailDto>('POST', `/api/invoice-runs/${id}/step`, resume ? { resume: true } : {}),
  invoiceRunGet: (id: string) => request<InvoiceRunDetailDto>('GET', `/api/invoice-runs/${id}`),
  invoiceRunList: (reconRunId: string) => request<{ runs: InvoiceRunDto[] }>('GET', `/api/invoice-runs?reconRunId=${reconRunId}`),
  invoiceRunExport: (id: string) => request<{ url: string }>('POST', `/api/invoice-runs/${id}/export`),
  // Fase 2
  listRecon: () => request<{ runs: ReconRunDto[] }>('GET', '/api/reconciliations'),
  createRecon: (dateFrom: string, dateTo: string, sync = true) => request<ReconRunDto>('POST', '/api/reconciliations', { dateFrom, dateTo, sync }),
  stepRecon: (id: string) => request<ReconStepDto>('POST', `/api/reconciliations/${id}/step`),
  reconDetail: (id: string) => request<ReconRunDetailDto>('GET', `/api/reconciliations/${id}`),
  reconExportUrl: (id: string) => request<{ url: string }>('GET', `/api/reconciliations/${id}/export/url`),
  reconRegenerate: (id: string) => request<{ status: 'ready' | 'failed' }>('POST', `/api/reconciliations/${id}/export`),
  manualCandidates: (id: string, q: string) => request<{ candidates: ManualCandidateDto[] }>('GET', `/api/reconciliation-results/${id}/manual-candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  assignManual: (id: string, recordId: string, reason: string, reassign = false) => request<ReconResultDto>('POST', `/api/reconciliation-results/${id}/assign`, { recordId, reason, reassign }),
  unassignManual: (id: string) => request<ReconResultDto>('POST', `/api/reconciliation-results/${id}/unassign`),
  resolveResult: (id: string, recordId: string) => request<ReconResultDto>('POST', `/api/reconciliation-results/${id}/resolve`, { recordId }),
  addAlias: (id: string, silogName: string, terpelName: string) => request<ReconResultDto>('POST', `/api/reconciliation-results/${id}/alias`, { silogName, terpelName }),
  reconParams: () => request<ReconParamsDto>('GET', '/api/recon-params'),
  saveFilters: (filters: MatchFilterDto[]) => request<{ filters: MatchFilterDto[] }>('PUT', '/api/match-filters', { filters }),
  saveSettings: (s: ReconSettingsDto) => request<ReconSettingsDto>('PUT', '/api/recon-settings', s),
  createAlias: (silogName: string, terpelName: string) => request<PlaceAliasDto>('POST', '/api/place-aliases', { silogName, terpelName }),
  updateAlias: (id: string, silogName: string, terpelName: string) => request<PlaceAliasDto>('PUT', `/api/place-aliases/${id}`, { silogName, terpelName }),
  deleteAlias: (id: string) => request<{ ok: true }>('DELETE', `/api/place-aliases/${id}`),
};
