// Escritor web de la pantalla de facturar (Financiero.Factura.Automatica_111).
// SEGURIDAD: el ensayo (rehearse) nunca envía «Facturar Remesas»; solo `issue` lo hace y el servicio solo lo llama con modo real,
// remesa permitida, ensayo vigente y confirmación. Un único método (postFacturar) envía el botón. Jamás se reintenta.
import { computeAmounts } from '../../invoice/writer.js';
import type { InvoiceOutcome, InvoiceRehearsalResult, InvoiceRequest, InvoiceWriteContext, InvoiceWriter, WriterCheck } from '../../invoice/writer.js';
import { log } from '../../logger.js';
import type { InvoiceAmountsDto, InvoiceListingDto } from '../../types.js';
import type { SilogWebClient } from './client.js';
import { INVOICE_PAGE } from './diagnostic.js';
import { SilogWebError } from './errors.js';
import { fillInvoiceForm, parseInvoiceListing, readWithholding, P } from './invoice.js';
import type { FillStep, InvoiceParams, ListingRowRaw } from './invoice.js';
import { PradoPage } from './prado.js';
import { homeNumber } from './remesa.js';
import { openWebSession } from './session.js';
import type { WebWriterDeps } from './writer.js';

const FACTURAR_TIMEOUT_MS = 45_000;
const MAX_OBSERVATION = 176;

const num = (v: string | null | undefined): string | null => homeNumber(v ?? '');
const sameNum = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;

function toParams(req: InvoiceRequest): InvoiceParams {
  const p = req.params;
  return {
    costCenter: p.costCenter, client: p.client, printableName: p.printableName, seller: p.seller, paymentDays: String(p.paymentDays), paymentCity: p.paymentCity,
    currency: p.currency, paymentMethod: p.paymentMethod, invoiceType: p.invoiceType, divide: p.divide, maxRemesas: String(p.maxRemesas), withholding: 'RETENCION EN LA FUENTE',
    observation: req.observation, purchaseOrder: req.purchaseOrder, requireImage: false,
  };
}

const listingDto = (r: ListingRowRaw): InvoiceListingDto => ({
  remesa: r.remesa, plate: r.vehiculo, date: r.fecha, delivered: r.cumplida, pesoNeto: num(r.peso), unidades: num(r.unidades), tarifaCliente: num(r.tarifaCliente), tarifa: num(r.tarifa),
  total: num(r.total), otros: num(r.otros), origin: r.origen, destination: r.destino, product: r.producto, description: r.descripcion,
});

interface Prepared { prado: PradoPage; row: ListingRowRaw | null; checks: WriterCheck[]; listing: InvoiceListingDto | null; amounts: InvoiceAmountsDto | null; facturar: { target: string; lock: string | null } | null }

/** Reglas del ensayo sobre lo que Silogtran LISTÓ. Devuelve las comprobaciones (todas deben ser ok para facturar). */
export function checkListing(req: InvoiceRequest, rows: ListingRowRaw[], withholdingPercent: string, fillOk: boolean, hasFacturar: boolean, preloadedObservation: string | null = null): { checks: WriterCheck[]; row: ListingRowRaw | null; amounts: InvoiceAmountsDto | null } {
  const checks: WriterCheck[] = [];
  checks.push({ name: 'configuración del cliente completa (cliente, vendedor, moneda, forma de pago, tipo)', ok: fillOk });
  const wantPct = String(req.params.withholdingPercent);
  checks.push({ name: `retefuente del cliente = ${wantPct} %`, ok: num(withholdingPercent) === num(wantPct), detail: `Silogtran trae ${withholdingPercent || 'ninguna'}` });
  const wanted = req.remesaCode.replace(/\D/g, '').replace(/^0+/, '');
  const row = rows.length === 1 && (rows[0] as ListingRowRaw).remesa.replace(/\D/g, '').replace(/^0+/, '') === wanted ? (rows[0] as ListingRowRaw) : null;
  checks.push({ name: 'el listado devuelve exactamente la remesa pedida', ok: !!row, detail: row ? undefined : `${rows.length} fila(s) en el listado` });
  if (!row) return { checks, row: null, amounts: null };
  checks.push({ name: 'remesa cumplida', ok: (row.cumplida ?? '').toUpperCase() === 'SI' });
  const total = num(row.total);
  const tarifa = num(row.tarifa);
  const exact = sameNum(total, req.expectedFreight) && sameNum(tarifa, req.expectedFreight);
  checks.push({ name: 'REGLA CRÍTICA: el flete a facturar es IDÉNTICO al valor neto de Terpel', ok: exact, detail: exact ? undefined : `Silogtran lista ${total ?? '—'} (tarifa ${tarifa ?? '—'}) y Terpel ${req.expectedFreight}` });
  checks.push({ name: 'sin otros conceptos ni valores adicionales', ok: (num(row.otros) ?? '0') === '0', detail: `otros ${row.otros ?? '—'}` });
  const peso = num(row.peso);
  const tc = num(row.tarifaCliente);
  if (peso && tc && total) {
    const calc = (BigInt(peso.split('.')[0] as string) * BigInt(tc.split('.')[0] as string)).toString();
    const integers = !peso.includes('.') && !tc.includes('.');
    checks.push({ name: 'peso neto cumplido × tarifa cliente = total de la fila', ok: !integers || calc === total, detail: integers && calc !== total ? `${peso} × ${tc} = ${calc} y la fila dice ${total}` : undefined });
  } else checks.push({ name: 'peso neto cumplido × tarifa cliente = total de la fila', ok: true, detail: 'no se pudo recalcular (dato ausente)' });
  checks.push({ name: `observación ≤ ${MAX_OBSERVATION} caracteres y no vacía`, ok: req.observation.trim().length > 0 && req.observation.length <= MAX_OBSERVATION });
  // Informativo (se reporta por remesa): observación/descripción/producto que Silogtran propone frente a lo generado.
  const normP = (v: string | null): string => (v ?? '').toUpperCase().replace(/[-\s]/g, '');
  checks.push({ name: 'observación generada vs. la que Silogtran trae precargada (informativo)', ok: true, detail: `generada «${req.observation}»; precargada «${preloadedObservation ?? ''}»` });
  checks.push({ name: 'producto de la observación vs. «Observación» del listado de Silogtran (informativo)', ok: true, detail: `observación usa «${req.product}»; el listado trae «${row.producto ?? ''}»${normP(row.producto) === normP(req.product) ? ' (coinciden)' : ' (DIFIEREN)'}` });
  checks.push({ name: 'descripción de la remesa precargada por Silogtran (informativo)', ok: true, detail: row.descripcion ?? '' });
  checks.push({ name: 'botón «Facturar Remesas» presente (no se pulsa en el ensayo)', ok: hasFacturar });
  return { checks, row, amounts: total ? computeAmounts(total, req.params.withholdingPercent) : null };
}

export class SilogtranWebInvoiceWriter implements InvoiceWriter {
  readonly kind = 'web' as const;
  readonly simulated = false;
  constructor(private readonly deps: WebWriterDeps) {}

  private async open(actor: string | null) {
    const cred = await this.deps.db.query<{ purpose: string }>(`select purpose from silog_credentials where purpose in ('invoice','adjust') order by (purpose = 'invoice') desc limit 1`);
    const purpose = (cred.rows[0]?.purpose ?? 'adjust') as 'invoice' | 'adjust';
    return openWebSession({ db: this.deps.db, encryptionKey: this.deps.encryptionKey, baseUrl: this.deps.baseUrl, waf: this.deps.waf, fetchFn: this.deps.fetchFn?.() }, purpose, actor);
  }

  /** GET + configuración + «Listar Remesas» (solo lectura). */
  private async prepare(client: SilogWebClient, req: InvoiceRequest): Promise<Prepared> {
    const page = await client.request(INVOICE_PAGE);
    if (page.text.includes('ctl0$MainModule$BtnIngresar')) throw new SilogWebError('WEB_BAD_PAGE', 'Silogtran devolvió el login en lugar de la pantalla de facturar (sesión expirada o sin permiso)');
    const prado = new PradoPage(client, page);
    const listBtn = `${P}ListarRemesas`;
    const commas = `${P}listadocumento`;
    if (!(commas in prado.fields)) throw new SilogWebError('WEB_BAD_PAGE', 'La pantalla de facturar no tiene «Búsqueda Por Comas»');
    const steps: FillStep[] = [];
    const preloaded = (prado.fields[`${P}observacion`] ?? '').trim() || null;
    const fillOk = await fillInvoiceForm(prado, toParams(req), steps);
    prado.fields[commas] = req.remesaCode.replace(/\D/g, '').padStart(10, '0');
    const lock = Object.keys(prado.fields).find((k) => /IDLockHidden_.*ListarRemesas$/i.test(k));
    const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [listBtn]: 'Listar Remesas' };
    if (lock) extra[lock] = 'true';
    const res = await prado.postback('', extra);
    if (res.text.includes('ctl0$MainModule$BtnIngresar')) throw new SilogWebError('WEB_BAD_PAGE', 'La sesión expiró al listar la remesa');
    const rows = parseInvoiceListing(res.text);
    const hasFacturar = `${P}FacturarRemesas` in prado.fields || res.text.includes(`name="${P}FacturarRemesas"`);
    const checked = checkListing(req, rows, readWithholding(prado).percent, fillOk, hasFacturar, preloaded);
    const fLock = Object.keys(prado.fields).find((k) => /IDLockHidden_.*FacturarRemesas$/i.test(k)) ?? null;
    return { prado, row: checked.row, checks: checked.checks, listing: checked.row ? { ...listingDto(checked.row), preloadedObservation: preloaded } : null, amounts: checked.amounts, facturar: hasFacturar ? { target: `${P}FacturarRemesas`, lock: fLock } : null };
  }

  async rehearse(req: InvoiceRequest, ctx: InvoiceWriteContext = { actor: null }): Promise<InvoiceRehearsalResult> {
    const s = await this.open(ctx.actor);
    try {
      const prep = await s.client.enqueue(() => this.prepare(s.client, req));
      return { simulated: false, listing: prep.listing, amounts: prep.amounts, checks: prep.checks, wouldIssue: false };
    } finally {
      await s.close();
    }
  }

  async issue(req: InvoiceRequest, ctx: InvoiceWriteContext = { actor: null }): Promise<InvoiceOutcome> {
    const s = await this.open(ctx.actor); // si falla aquí NO se emitió nada
    try {
      return await s.client.enqueue(async () => {
        const prep = await this.prepare(s.client, req);
        const failed = prep.checks.filter((c) => !c.ok);
        if (failed.length > 0 || !prep.row || !prep.facturar) {
          return { outcome: 'stale', detail: `No se factura: ${failed.map((c) => c.detail ? `${c.name} (${c.detail})` : c.name).join('; ') || 'falta el botón Facturar'}`, listing: prep.listing ?? undefined } as InvoiceOutcome;
        }
        if (prep.row.checkbox) prep.prado.fields[prep.row.checkbox] = 'on'; // Seleccionar la fila a facturar
        const sent = await this.postFacturar(s.client, prep);
        if (sent.kind === 'lost') return { outcome: 'uncertain', detail: sent.detail, listing: prep.listing ?? undefined };
        if (sent.html.includes('ctl0$MainModule$BtnIngresar')) return { outcome: 'uncertain', detail: 'La sesión expiró al facturar: puede haberse emitido', listing: prep.listing ?? undefined };
        const text = sent.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 6 && l.length < 220 && /factur|error|no se pudo|guardad|generad|exito|éxito/i.test(l));
        const number = /factura\D{0,25}(\d{3,})/i.exec(text.join(' | '))?.[1] ?? null;
        log('silog_web.facturar', { lines: text.length });
        return { outcome: 'submitted', invoiceNumber: number, detail: text.slice(0, 4).join(' | '), listing: prep.listing ?? undefined, amounts: prep.amounts ?? undefined };
      });
    } finally {
      await s.close();
    }
  }

  /** ÚNICO punto que envía «Facturar Remesas». Sin reintentos: si la petición se pierde, el resultado es incierto. */
  private async postFacturar(client: SilogWebClient, prep: Prepared): Promise<{ kind: 'ok'; html: string } | { kind: 'lost'; detail: string }> {
    if (!prep.facturar) return { kind: 'lost', detail: 'No hay botón Facturar Remesas' }; // no se envía nada
    const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [prep.facturar.target]: 'Facturar Remesas' };
    if (prep.facturar.lock) extra[prep.facturar.lock] = 'true';
    try {
      const res = await client.request(prep.prado.action, { method: 'POST', form: { ...prep.prado.fields, PRADO_POSTBACK_TARGET: '', ...extra }, timeoutMs: FACTURAR_TIMEOUT_MS });
      return { kind: 'ok', html: res.text };
    } catch (e) {
      return { kind: 'lost', detail: `Se perdió la respuesta al facturar (${e instanceof SilogWebError ? e.code : 'error'}); puede haberse emitido` };
    }
  }
}
