import type { InvoiceAmountsDto, InvoiceListingDto } from '../types.js';

export interface InvoiceParamsLike {
  costCenter: string; client: string; printableName: string; seller: string; paymentDays: number; paymentCity: string; currency: string; paymentMethod: string;
  invoiceType: string; divide: 'SI' | 'NO'; maxRemesas: number; withholdingPercent: number;
}

/** Lo que se factura: UNA factura por remesa. */
export interface InvoiceRequest {
  remesaCode: string;
  transportNumber: string;
  /** Valor neto de Terpel: el flete a facturar (antes de impuestos) debe ser IDÉNTICO. */
  expectedFreight: string;
  observation: string;
  /** Orden de compra = número de transporte de Terpel. */
  purchaseOrder: string;
  /** Producto normalizado usado en la observación (para compararlo con el que lista Silogtran). */
  product: string;
  params: InvoiceParamsLike;
}

export interface WriterCheck { name: string; ok: boolean; detail?: string }

export interface InvoiceRehearsalResult {
  simulated: boolean;
  listing: InvoiceListingDto | null;
  amounts: InvoiceAmountsDto | null;
  checks: WriterCheck[];
  wouldIssue: false;
}

export type InvoiceOutcome =
  | { outcome: 'submitted'; detail?: string; listing?: InvoiceListingDto; amounts?: InvoiceAmountsDto; invoiceNumber?: string | null } // Silogtran aceptó el envío (hay que verificar)
  | { outcome: 'rejected' | 'stale'; detail: string; listing?: InvoiceListingDto } // CERTEZA de que no se emitió
  | { outcome: 'uncertain'; detail: string; listing?: InvoiceListingDto }; // respuesta perdida o ambigua

export interface InvoiceWriteContext { actor: string | null }

export interface InvoiceWriter {
  readonly kind: 'mock' | 'web';
  /** true: nada de lo que se "emite" toca Silogtran. */
  readonly simulated: boolean;
  /** Ensayo: abre la pantalla, llena, lista la remesa y LEE los valores. NUNCA emite. */
  rehearse(req: InvoiceRequest, ctx?: InvoiceWriteContext): Promise<InvoiceRehearsalResult>;
  /** Emisión (protegida por el servicio: modo real, lista permitida, ensayo vigente y confirmación). */
  issue(req: InvoiceRequest, ctx?: InvoiceWriteContext): Promise<InvoiceOutcome>;
}

const freightText = (v: string): string => v;

/** Cálculo de importes (centavos exactos): retefuente = flete × % (2 decimales, mitad hacia arriba). */
export function computeAmounts(freight: string, percent: number): InvoiceAmountsDto | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(freight);
  if (!m) return null;
  const cents = BigInt(m[1] as string) * 100n + BigInt(((m[2] ?? '') + '00').slice(0, 2));
  const pm = BigInt(Math.round(percent * 1000)); // milésimas de punto porcentual
  const w = (cents * pm + 50_000n) / 100_000n; // cents × pct/100 redondeado
  const fmt = (c: bigint): string => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
  return { freight: freightText(freight), withholding: fmt(w), total: fmt(cents - w) };
}

/** Escritor simulado para demo y pruebas: no contacta a Silogtran. */
export class MockInvoiceWriter implements InvoiceWriter {
  readonly kind = 'mock' as const;
  readonly simulated = true;
  mode: 'success' | 'reject' | 'timeout' = 'success';
  /** Hace que el listado muestre otro flete (para probar la regla crítica). */
  freightOverride = new Map<string, string>();
  rehearsals: string[] = [];
  issued: InvoiceRequest[] = [];
  private seq = 0;

  async rehearse(req: InvoiceRequest): Promise<InvoiceRehearsalResult> {
    this.rehearsals.push(req.remesaCode);
    const freight = this.freightOverride.get(req.remesaCode) ?? req.expectedFreight;
    const amounts = computeAmounts(freight, req.params.withholdingPercent);
    const listing: InvoiceListingDto = {
      remesa: req.remesaCode, plate: 'SIM001', date: null, delivered: 'SI', pesoNeto: null, unidades: null, tarifaCliente: null, tarifa: freight, total: freight, otros: '0',
      origin: null, destination: null, product: null, description: null,
    };
    const ok = freight === req.expectedFreight;
    return {
      simulated: true, listing, amounts, wouldIssue: false,
      checks: [
        { name: 'escritor simulado: no se contacta a Silogtran', ok: true },
        { name: 'REGLA CRÍTICA: el flete a facturar es idéntico al valor neto de Terpel', ok, detail: ok ? undefined : `Silogtran muestra ${freight} y Terpel ${req.expectedFreight}` },
      ],
    };
  }

  async issue(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.issued.push(req);
    if (this.mode === 'reject') return { outcome: 'rejected', detail: 'Rechazada por Silogtran (simulado)' };
    if (this.mode === 'timeout') return { outcome: 'uncertain', detail: 'Sin respuesta de Silogtran (simulado)' };
    this.seq += 1;
    return { outcome: 'submitted', invoiceNumber: `SIM-${String(this.seq).padStart(5, '0')}`, amounts: computeAmounts(req.expectedFreight, req.params.withholdingPercent) ?? undefined };
  }
}
