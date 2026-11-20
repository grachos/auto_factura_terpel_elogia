import { HTMLElement, NodeType, parse as parseHtml } from 'node-html-parser';
import type { Node as HtmlNode } from 'node-html-parser';
import { parseServiceDate } from './dates.js';
import { normalizeDecimal } from './decimal.js';

export const PARSER_VERSION = '1.0.0';
export const BLOCK_MARKER = 'esta es la informacion del servicio';

export type FieldKey =
  | 'transport_number'
  | 'remission_number'
  | 'expense_number'
  | 'service_date'
  | 'loading_plant'
  | 'purchase_doc'
  | 'service_entry_sheet'
  | 'net_value_currency'
  | 'plate'
  | 'route'
  | 'transport_volume'
  | 'rate'
  | 'driver_code'
  | 'driver_name';

interface FieldDef {
  key: FieldKey;
  labels: string[];
  required: boolean;
}

/** Etiquetas de la plantilla (se comparan sin tildes, sin mayúsculas, con ":" y espacios opcionales). */
export const FIELD_DEFS: FieldDef[] = [
  { key: 'transport_number', labels: ['Número de transporte', 'Nro de transporte', 'No. de transporte'], required: true },
  { key: 'remission_number', labels: ['Número de remisión', 'Nro de remisión', 'No. de remisión'], required: false },
  { key: 'expense_number', labels: ['Número de gasto', 'Nro de gasto', 'No. de gasto'], required: false },
  { key: 'service_date', labels: ['Fecha del servicio', 'Fecha de servicio'], required: true },
  { key: 'loading_plant', labels: ['Planta de cargue'], required: false },
  { key: 'purchase_doc', labels: ['Documento de compras o contrato', 'Documento de compras'], required: false },
  { key: 'service_entry_sheet', labels: ['Hoja de entrada de servicio', 'Hoja de entrada de servicios'], required: false },
  { key: 'net_value_currency', labels: ['Valor neto y moneda', 'Valor neto'], required: true },
  { key: 'plate', labels: ['Placa del vehículo', 'Placa'], required: true },
  { key: 'route', labels: ['Ruta'], required: false },
  { key: 'transport_volume', labels: ['Volumen del transporte', 'Volumen'], required: true },
  { key: 'rate', labels: ['Tarifa'], required: false },
  { key: 'driver_code', labels: ['Código del conductor', 'Codigo conductor'], required: false },
  { key: 'driver_name', labels: ['Nombre del conductor', 'Conductor'], required: false },
];

export interface ParseIssue {
  code:
    | 'TEMPLATE_BLOCK_NOT_FOUND'
    | 'MISSING_FIELD'
    | 'EMPTY_REQUIRED_FIELD'
    | 'AMBIGUOUS_DECIMAL'
    | 'INVALID_DECIMAL'
    | 'INVALID_DATE';
  severity: 'warning' | 'error';
  field: FieldKey | null;
  detail: string;
}

export interface ParsedAuthorization {
  parserVersion: string;
  templateVariant: 'html-table' | 'html-text' | 'plain-text';
  parseStatus: 'ok' | 'incomplete' | 'error';
  blockFound: boolean;
  transportNumber: string | null;
  remissionNumber: string | null;
  expenseNumber: string | null;
  serviceDate: string | null;
  serviceDateRaw: string | null;
  loadingPlant: string | null;
  loadingPlantFlag: string | null;
  purchaseDoc: string | null;
  serviceEntrySheet: string | null;
  netValue: string | null;
  netValueRaw: string | null;
  currency: string | null;
  plate: string | null;
  plateNormalized: string | null;
  route: string | null;
  transportVolume: string | null;
  transportVolumeRaw: string | null;
  transportVolumeUnit: string | null;
  unitStatus: 'pending_confirmation';
  rate: string | null;
  rateRaw: string | null;
  driverCode: string | null;
  driverName: string | null;
  /** raw por campo: null = etiqueta ausente; '' = presente vacía. */
  rawFields: Record<string, string | null>;
  issues: ParseIssue[];
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'tr', 'table', 'tbody', 'thead', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'hr',
]);

/** HTML → texto con saltos de línea por bloque y tabulador por celda. */
export function htmlToText(html: string): string {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const out: string[] = [];
  const walk = (node: HtmlNode): void => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      out.push(node.text.replace(/\s+/g, ' '));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = (node.tagName ?? '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'noscript') return;
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push('\n');
    for (const child of node.childNodes) walk(child);
    if (tag === 'td' || tag === 'th') out.push('\t');
    if (block) out.push('\n');
  };
  walk(root);
  return decodeEntities(out.join(''));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ');
}

interface Stripped {
  text: string;
  /** índice en la línea original por cada carácter de `text` */
  map: number[];
}

function stripAccentsWithMap(line: string): Stripped {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const base = (line[i] ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const ch of base) {
      chars.push(ch);
      map.push(i);
    }
  }
  return { text: chars.join(''), map };
}

function labelRegex(label: string): RegExp {
  const stripped = label.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const body = stripped
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`^\\s*${body}\\s*[:：]?(?=\\s|$|\\t)`, 'i');
}

const LABEL_MATCHERS: { key: FieldKey; re: RegExp; len: number }[] = FIELD_DEFS.flatMap((d) =>
  d.labels.map((l) => ({ key: d.key, re: labelRegex(l), len: l.length })),
).sort((a, b) => b.len - a.len);

function cleanValue(s: string): string {
  return s.replace(/[\t ]+/g, ' ').trim();
}

function extractFields(lines: string[]): Record<FieldKey, string | null> {
  const result = Object.fromEntries(FIELD_DEFS.map((d) => [d.key, null])) as Record<FieldKey, string | null>;
  for (const line of lines) {
    const { text, map } = stripAccentsWithMap(line);
    for (const m of LABEL_MATCHERS) {
      if (result[m.key] !== null) continue;
      const hit = m.re.exec(text);
      if (!hit) continue;
      const endStripped = hit[0].length;
      const origStart = endStripped >= map.length ? line.length : (map[endStripped] ?? line.length);
      result[m.key] = cleanValue(line.slice(origStart));
      break;
    }
  }
  return result;
}

function nz(s: string | null): string | null {
  return s === null || s === '' ? null : s;
}

function splitAmountCurrency(raw: string): { amount: string; currency: string | null } {
  const t = raw.trim();
  const trailing = /^(.*?)[\s]*([A-Za-z]{3})$/.exec(t);
  if (trailing && /\d/.test(trailing[1] ?? '')) return { amount: (trailing[1] ?? '').trim(), currency: (trailing[2] ?? '').toUpperCase() };
  const leading = /^([A-Za-z]{3})[\s]*(.*)$/.exec(t);
  if (leading && /\d/.test(leading[2] ?? '')) return { amount: (leading[2] ?? '').trim(), currency: (leading[1] ?? '').toUpperCase() };
  return { amount: t, currency: null };
}

export interface ParseInput {
  contentType: 'html' | 'text';
  content: string;
}

export function parseAuthorization(input: ParseInput): ParsedAuthorization {
  const isHtml = input.contentType === 'html';
  const text = isHtml ? htmlToText(input.content) : input.content.replace(/\r\n?/g, '\n');
  const variant: ParsedAuthorization['templateVariant'] = !isHtml
    ? 'plain-text'
    : /<t[dh][\s>]/i.test(input.content)
      ? 'html-table'
      : 'html-text';

  const allLines = text.split('\n');
  const markerIdx = allLines.findIndex((l) => stripAccentsWithMap(l).text.toLowerCase().includes(BLOCK_MARKER));
  const issues: ParseIssue[] = [];
  const empty = Object.fromEntries(FIELD_DEFS.map((d) => [d.key, null])) as Record<FieldKey, string | null>;

  const base: ParsedAuthorization = {
    parserVersion: PARSER_VERSION,
    templateVariant: variant,
    parseStatus: 'error',
    blockFound: markerIdx >= 0,
    transportNumber: null,
    remissionNumber: null,
    expenseNumber: null,
    serviceDate: null,
    serviceDateRaw: null,
    loadingPlant: null,
    loadingPlantFlag: null,
    purchaseDoc: null,
    serviceEntrySheet: null,
    netValue: null,
    netValueRaw: null,
    currency: null,
    plate: null,
    plateNormalized: null,
    route: null,
    transportVolume: null,
    transportVolumeRaw: null,
    transportVolumeUnit: null,
    unitStatus: 'pending_confirmation',
    rate: null,
    rateRaw: null,
    driverCode: null,
    driverName: null,
    rawFields: empty,
    issues,
  };

  if (markerIdx < 0) {
    issues.push({
      code: 'TEMPLATE_BLOCK_NOT_FOUND',
      severity: 'error',
      field: null,
      detail: 'No se encontró el bloque "Esta es la información del servicio"',
    });
    return base;
  }

  const raw = extractFields(allLines.slice(markerIdx + 1));
  base.rawFields = raw;

  for (const def of FIELD_DEFS) {
    const v = raw[def.key];
    if (v === null) {
      issues.push({
        code: 'MISSING_FIELD',
        severity: def.required ? 'error' : 'warning',
        field: def.key,
        detail: 'Etiqueta ausente en el correo',
      });
    } else if (v === '' && def.required) {
      issues.push({ code: 'EMPTY_REQUIRED_FIELD', severity: 'error', field: def.key, detail: 'Campo obligatorio vacío' });
    }
  }

  base.transportNumber = nz(raw.transport_number);
  base.remissionNumber = nz(raw.remission_number);
  base.expenseNumber = nz(raw.expense_number);
  base.loadingPlant = nz(raw.loading_plant);
  base.loadingPlantFlag = base.loadingPlant && /(^|[^A-Za-z0-9])9P([^A-Za-z0-9]|$)/i.test(base.loadingPlant) ? '9P' : null;
  base.purchaseDoc = nz(raw.purchase_doc);
  base.serviceEntrySheet = nz(raw.service_entry_sheet);
  base.route = nz(raw.route);
  base.driverCode = nz(raw.driver_code);
  base.driverName = nz(raw.driver_name);
  base.plate = nz(raw.plate);
  base.plateNormalized = base.plate ? base.plate.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;

  base.serviceDateRaw = raw.service_date;
  if (nz(raw.service_date)) {
    base.serviceDate = parseServiceDate(raw.service_date ?? '');
    if (!base.serviceDate) {
      issues.push({ code: 'INVALID_DATE', severity: 'error', field: 'service_date', detail: 'La fecha no tiene formato DD.MM.AAAA válido' });
    }
  }

  const decimalField = (key: FieldKey, rawVal: string | null): string | null => {
    const r = normalizeDecimal(rawVal);
    if (r.status === 'ambiguous') {
      issues.push({ code: 'AMBIGUOUS_DECIMAL', severity: 'error', field: key, detail: 'Número ambiguo (separador de miles o decimales); no se interpreta' });
    } else if (r.status === 'invalid') {
      issues.push({ code: 'INVALID_DECIMAL', severity: 'error', field: key, detail: 'Número con formato no válido' });
    }
    return r.value;
  };

  base.netValueRaw = raw.net_value_currency;
  if (nz(raw.net_value_currency)) {
    const { amount, currency } = splitAmountCurrency(raw.net_value_currency ?? '');
    base.netValue = decimalField('net_value_currency', amount);
    base.currency = currency;
    if (!currency) {
      issues.push({ code: 'EMPTY_REQUIRED_FIELD', severity: 'error', field: 'net_value_currency', detail: 'No se identificó la moneda' });
    }
  }
  base.transportVolumeRaw = raw.transport_volume;
  base.transportVolume = decimalField('transport_volume', raw.transport_volume);
  base.rateRaw = raw.rate;
  base.rate = decimalField('rate', raw.rate);

  if (!base.transportNumber) base.parseStatus = 'error';
  else if (issues.some((i) => i.severity === 'error')) base.parseStatus = 'incomplete';
  else base.parseStatus = 'ok';
  return base;
}
