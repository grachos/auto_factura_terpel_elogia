import { normalizeDocument, normalizePlate, toDateOnly, toNumber } from './normalize.js';

/** Silogtran es SOLO LECTURA: esta interfaz no expone ninguna operación de escritura. */
export interface SilogtranSource {
  readonly kind: 'api' | 'mock';
  fetchReport(dateFrom: string, dateTo: string): Promise<Record<string, unknown>[]>;
}

export class SilogtranError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'LOGIN_FAILED' | 'TIMEOUT' | 'HTTP_ERROR' | 'BAD_RESPONSE' | 'NETWORK',
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export interface SilogtranApiOptions {
  baseUrl: string;
  user: string;
  password: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class SilogtranApiSource implements SilogtranSource {
  readonly kind = 'api' as const;
  private token: string | null = null;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: SilogtranApiOptions) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.doFetch = opts.fetchFn ?? fetch;
  }

  private async http(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new SilogtranError('TIMEOUT', 'Silogtran no respondió a tiempo');
      throw new SilogtranError('NETWORK', 'No se pudo conectar con Silogtran');
    }
  }

  private async login(): Promise<string> {
    const res = await this.http(`${this.opts.baseUrl}?api=servicio.Seguridad.login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario_login: this.opts.user, usuario_password: this.opts.password }).toString(),
    });
    type LoginJson = { success?: boolean; data?: { token?: string } };
    let json = null as LoginJson | null;
    try {
      json = (await res.json()) as LoginJson;
    } catch {
      /* respuesta no JSON */
    }
    const token = json?.data?.token;
    if (!res.ok || !json?.success || typeof token !== 'string' || token === '') {
      throw new SilogtranError('LOGIN_FAILED', 'Silogtran rechazó el inicio de sesión (revise SILOG_USER/SILOG_PASSWORD)', res.status);
    }
    this.token = token;
    return token;
  }

  async fetchReport(dateFrom: string, dateTo: string): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = this.token ?? (await this.login());
      const url = `${this.opts.baseUrl}?api=servicio.Manifiesto.InformeGeneral&fecha_inicial=${dateFrom}&fecha_final=${dateTo}`;
      const res = await this.http(url, { method: 'GET', headers: { Authorization: token } }); // token crudo, sin "Bearer"
      if (res.status === 401 || res.status === 403) {
        this.token = null; // vencido: nuevo login y un reintento
        continue;
      }
      if (!res.ok) throw new SilogtranError('HTTP_ERROR', `Silogtran respondió con error HTTP ${res.status}`, res.status);
      type ReportJson = { success?: boolean; data?: unknown };
      let json = null as ReportJson | null;
      try {
        json = (await res.json()) as ReportJson;
      } catch {
        throw new SilogtranError('BAD_RESPONSE', 'Respuesta de Silogtran no válida');
      }
      if (!json || json.success !== true || !Array.isArray(json.data)) {
        throw new SilogtranError('BAD_RESPONSE', 'Silogtran devolvió una respuesta sin datos válidos');
      }
      return json.data as Record<string, unknown>[];
    }
    throw new SilogtranError('LOGIN_FAILED', 'Silogtran rechazó el token tras iniciar sesión de nuevo', 401);
  }
}

/** Datos SINTÉTICOS para pruebas y modo demo (sin credenciales). */
export class MockSilogtranSource implements SilogtranSource {
  readonly kind = 'mock' as const;
  calls: { from: string; to: string }[] = [];
  failNext = 0;
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async fetchReport(dateFrom: string, dateTo: string): Promise<Record<string, unknown>[]> {
    this.calls.push({ from: dateFrom, to: dateTo });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new SilogtranError('TIMEOUT', 'Silogtran no respondió a tiempo');
    }
    return this.rows.filter((r) => {
      const f = toDateOnly(r.fecha);
      return f !== null && f >= dateFrom && f <= dateTo;
    });
  }
}

export interface SilogRecordInput {
  manifest: string;
  remesa_code: string;
  dispatch_date: string | null;
  delivery_date: string | null;
  plate: string | null;
  plate_normalized: string | null;
  trailer_plate: string | null;
  driver_name: string | null;
  driver_document: string | null;
  client: string | null;
  client_nit: string | null;
  origin_city: string | null;
  destination_city: string | null;
  remesa_weight: number | null;
  net_load_weight: number | null;
  rate: number | null;
  freight_dispatch: number | null;
  total_remesa: number | null;
  additional_value: number | null;
  status: string | null;
  remesa_status: string | null;
  invoice: string | null;
}

const text = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const nitDigits = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).replace(/\D+/g, '') || null);

export function normalizeSilogRow(raw: Record<string, unknown>): SilogRecordInput | null {
  const manifest = text(raw.manifiesto);
  const remesa = text(raw.remesa_codigo);
  if (!manifest || !remesa) return null;
  return {
    manifest,
    remesa_code: remesa,
    dispatch_date: toDateOnly(raw.fecha),
    delivery_date: toDateOnly(raw.fecha_entrega),
    plate: text(raw.placa),
    plate_normalized: normalizePlate(raw.placa),
    trailer_plate: text(raw.trailer_placa),
    driver_name: text(raw.conductor),
    driver_document: normalizeDocument(raw.conductor_documento),
    client: text(raw.cliente),
    client_nit: nitDigits(raw.cliente_nit),
    origin_city: text(raw.ciudad_origen_remesa),
    destination_city: text(raw.ciudad_destino_remesa),
    remesa_weight: toNumber(raw.remesa_peso),
    net_load_weight: toNumber(raw.peso_neto_cargue),
    rate: toNumber(raw.remesa_tarifa),
    freight_dispatch: toNumber(raw.fleteremesa_despacho),
    total_remesa: toNumber(raw.total_remesa),
    additional_value: toNumber(raw.valor_adicional_remesa),
    status: text(raw.estado)?.toUpperCase() ?? null,
    remesa_status: text(raw.estado_remesa),
    invoice: text(raw.factura),
  };
}

/** Deduplica por (manifiesto, remesa) y filtra por NIT del cliente. ANULADO se conserva con su estado (se excluye al conciliar). */
export function dedupeAndFilter(rows: Record<string, unknown>[], clientNit: string): { kept: SilogRecordInput[]; total: number } {
  const nit = nitDigits(clientNit);
  const map = new Map<string, SilogRecordInput>();
  for (const raw of rows) {
    const rec = normalizeSilogRow(raw);
    if (!rec || rec.client_nit !== nit) continue;
    const key = `${rec.manifest}\u0000${rec.remesa_code}`;
    const prev = map.get(key);
    // Las repeticiones solo difieren en numero_cumplido_rndc; si alguna es ANULADO prevalece.
    if (!prev || (rec.status === 'ANULADO' && prev.status !== 'ANULADO')) map.set(key, rec);
  }
  return { kept: [...map.values()], total: rows.length };
}
