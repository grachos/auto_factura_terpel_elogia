// Pantalla de facturar de Silogtran: Financiero.Factura.Automatica_111 (PRADO). Mapa en docs/silogtran-facturacion.md.
// Este módulo SOLO lee y llena el formulario en memoria; el envío de «Facturar Remesas» vive aparte y está protegido.
import * as cheerio from 'cheerio';
import type { PradoPage } from './prado.js';

export const P = 'ctl0$MainModule$';

export interface InvoiceParams {
  costCenter: string;
  client: string;
  printableName: string;
  seller: string;
  paymentDays: string;
  paymentCity: string;
  currency: string;
  paymentMethod: string;
  invoiceType: string;
  divide: 'SI' | 'NO';
  maxRemesas: string;
  withholding: string; // «RETENCION EN LA FUENTE - 1 %»
  observation: string;
  purchaseOrder: string;
  requireImage: boolean;
}

export const DEFAULT_INVOICE_PARAMS: InvoiceParams = {
  costCenter: 'PRINCIPAL', client: 'ORGANIZACION TERPEL S.A', printableName: 'ORGANIZACION TERPEL S.A', seller: 'CS', paymentDays: '15',
  paymentCity: 'SANTA MARTA', currency: 'PESOS', paymentMethod: 'CUENTA CORRIENTE', invoiceType: 'CLIENTES', divide: 'NO', maxRemesas: '30',
  withholding: 'RETENCION EN LA FUENTE', observation: '', purchaseOrder: '', requireImage: false,
};

export interface FillStep { step: string; ok: boolean; detail?: unknown }

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 %]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Elige la opción de un select por su texto y la deja en `prado.fields`. */
function setSelect(prado: PradoPage, name: string, text: string, steps: FillStep[], label: string): boolean {
  const $ = cheerio.load(prado.html);
  const opt = $(`select[name="${name}"] option`).toArray().find((o) => norm($(o).text()) === norm(text));
  if (!opt) { steps.push({ step: `${label}: opción «${text}»`, ok: false, detail: { options: $(`select[name="${name}"] option`).toArray().map((o) => $(o).text().trim()).slice(0, 20) } }); return false; }
  prado.fields[name] = $(opt).attr('value') ?? $(opt).text();
  steps.push({ step: `${label}: «${text}»`, ok: true });
  return true;
}

async function pickSuggestion(prado: PradoPage, name: string, query: string, wanted: string, steps: FillStep[], label: string, exactOnly = true): Promise<boolean> {
  const sugg = await prado.suggest(name, query);
  const hit = sugg.filter((s) => s.cells.some((c) => norm(c) === norm(wanted)) || (!exactOnly && s.cells.some((c) => norm(c).includes(norm(wanted)))));
  steps.push({ step: `${label}: autocompletado`, ok: hit.length === 1, detail: { suggestions: sugg.length, matches: hit.length, cells: sugg.slice(0, 6).map((s) => s.cells.slice(0, 4)), attrKeys: Object.keys(sugg[0]?.attrs ?? {}) } });
  if (hit.length !== 1) return false;
  prado.select(hit[0] as { attrs: Record<string, string> });
  return true;
}

/** Llena la configuración de la factura (en memoria; no envía nada). Devuelve true si todo quedó consistente. */
export async function fillInvoiceForm(prado: PradoPage, p: InvoiceParams, steps: FillStep[]): Promise<boolean> {
  let ok = true;
  ok = (await pickSuggestion(prado, `${P}cliente_codigo`, p.client.slice(0, 12), p.client, steps, 'Cliente')) && ok;
  prado.fields[`${P}nombreimprimible`] = p.printableName;
  ok = setSelect(prado, `${P}vendedor_codigo`, p.seller, steps, 'Vendedor') && ok;
  prado.fields[`${P}dias_vencimiento`] = p.paymentDays;
  ok = setSelect(prado, `${P}moneda_codigo`, p.currency, steps, 'Moneda') && ok;
  ok = setSelect(prado, `${P}forpag_codigo`, p.paymentMethod, steps, 'Forma de pago') && ok;
  ok = setSelect(prado, `${P}tipfac_codigo`, p.invoiceType, steps, 'Tipo de factura') && ok;
  ok = setSelect(prado, `${P}division`, p.divide, steps, 'Dividir valor entre remesas') && ok;
  prado.fields[`${P}numeroremesa`] = p.maxRemesas;
  prado.fields[`${P}observacion`] = p.observation;
  prado.fields[`${P}factura_ordencompra`] = p.purchaseOrder;
  if (p.requireImage) prado.fields[`${P}requiereimagen_check`] = 'on'; else delete prado.fields[`${P}requiereimagen_check`];
  const city = prado.fields[`${P}ciudad_codigo_pago`] ?? '';
  if (norm(city) !== norm(p.paymentCity)) ok = (await pickSuggestion(prado, `${P}ciudad_codigo_pago`, p.paymentCity, p.paymentCity, steps, 'Ciudad de pago', false)) && ok;
  else steps.push({ step: 'Ciudad de pago: ya viene por defecto', ok: true });
  // La retefuente viene del cliente (campos ocultos impuesto_retefuente_*): se verifica en el ensayo, no se elige a mano.
  return ok;
}

export interface ListingRowRaw {
  ctl: string; remesa: string; vehiculo: string | null; fecha: string | null; cumplida: string | null; tipo: string | null; origen: string | null; destino: string | null;
  producto: string | null; peso: string | null; unidades: string | null; descripcion: string | null; tarifaCliente: string | null; tarifa: string | null; otros: string | null;
  total: string | null; checkbox: string | null;
}

const ROW_FIELD = /^ctl0\$MainModule\$porFacturar\$(ctl\d+)\$(\w+)$/;

/** Filas del listado «porFacturar» (incluye inputs deshabilitados: peso y tarifa_cliente). */
export function parseInvoiceListing(html: string): ListingRowRaw[] {
  const $ = cheerio.load(html);
  const rows = new Map<string, Record<string, string>>();
  $('input, textarea').each((_, el) => {
    const $el = $(el);
    const m = ROW_FIELD.exec($el.attr('name') ?? '');
    if (!m) return;
    const r = rows.get(m[1] as string) ?? {};
    r[m[2] as string] = (el as { tagName: string }).tagName === 'textarea' ? $el.text().trim() : ($el.attr('value') ?? '').trim();
    rows.set(m[1] as string, r);
  });
  return [...rows.entries()].map(([ctl, r]) => ({
    ctl, remesa: r.remesa1 ?? '', vehiculo: r.vehiculo ?? null, fecha: r.fecha ?? null, cumplida: r.estado_remesa ?? null, tipo: r.tiporemesa ?? null, origen: r.origen ?? null,
    destino: r.destino ?? null, producto: r.observacion ?? null, peso: r.peso ?? null, unidades: r.unidades ?? null, descripcion: r.descripcion_remesa ?? null,
    tarifaCliente: r.tarifa_cliente ?? null, tarifa: r.tarifa ?? null, otros: r.otros ?? null, total: r.total ?? null, checkbox: Object.keys(r).includes('valido') ? `${P}porFacturar$${ctl}$valido` : null,
  }));
}

/** Retefuente que el cliente trae configurada (campos ocultos tras elegir el cliente). */
export function readWithholding(prado: PradoPage): { name: string; percent: string } {
  return { name: prado.fields[`${P}impuesto_retefuente_nombre`] ?? '', percent: prado.fields[`${P}impuesto_retefuente_porcentaje`] ?? '' };
}
