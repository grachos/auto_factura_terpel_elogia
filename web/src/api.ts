import type {
  ApiErrorDto, MailConfigDto, MatchFilterDto, MeDto, PlaceAliasDto, PublicConfigDto, ReconParamsDto, ReconResultDto, ReconRunDetailDto,
  ReconRunDto, ReconSettingsDto, ReconStepDto, RunDetailDto, RunDto, StepResultDto,
} from '../../core/types';

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
  // Fase 2
  listRecon: () => request<{ runs: ReconRunDto[] }>('GET', '/api/reconciliations'),
  createRecon: (dateFrom: string, dateTo: string, sync = true) => request<ReconRunDto>('POST', '/api/reconciliations', { dateFrom, dateTo, sync }),
  stepRecon: (id: string) => request<ReconStepDto>('POST', `/api/reconciliations/${id}/step`),
  reconDetail: (id: string) => request<ReconRunDetailDto>('GET', `/api/reconciliations/${id}`),
  reconExportUrl: (id: string) => request<{ url: string }>('GET', `/api/reconciliations/${id}/export/url`),
  reconRegenerate: (id: string) => request<{ status: 'ready' | 'failed' }>('POST', `/api/reconciliations/${id}/export`),
  resolveResult: (id: string, recordId: string) => request<ReconResultDto>('POST', `/api/reconciliation-results/${id}/resolve`, { recordId }),
  addAlias: (id: string, silogName: string, terpelName: string) => request<ReconResultDto>('POST', `/api/reconciliation-results/${id}/alias`, { silogName, terpelName }),
  reconParams: () => request<ReconParamsDto>('GET', '/api/recon-params'),
  saveFilters: (filters: MatchFilterDto[]) => request<{ filters: MatchFilterDto[] }>('PUT', '/api/match-filters', { filters }),
  saveSettings: (s: ReconSettingsDto) => request<ReconSettingsDto>('PUT', '/api/recon-settings', s),
  createAlias: (silogName: string, terpelName: string) => request<PlaceAliasDto>('POST', '/api/place-aliases', { silogName, terpelName }),
  updateAlias: (id: string, silogName: string, terpelName: string) => request<PlaceAliasDto>('PUT', `/api/place-aliases/${id}`, { silogName, terpelName }),
  deleteAlias: (id: string) => request<{ ok: true }>('DELETE', `/api/place-aliases/${id}`),
};
