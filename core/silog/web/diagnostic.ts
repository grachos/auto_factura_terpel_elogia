// Diagnóstico de SOLO LECTURA de la pantalla «Procedimiento de Cambio Tarifa».
// Nunca envía un submit que persista: la etapa 1 es un GET; la etapa 2 solo usa callbacks de lectura
// (autocompletado y TEventTriggeredCallback del control Remesa) y descarta cualquier destino que parezca Grabar.
import * as cheerio from 'cheerio';
import { SilogWebError } from './errors.js';
import type { SilogWebClient } from './client.js';
import { PradoPage } from './prado.js';

export const TARIFF_PAGE = 'index.php?page=Despacho.Remesa_003.CambioTarifa_105';

export interface ControlInfo {
  tag: string; type: string | null; name: string | null; id: string | null; disabled: boolean; readOnly: boolean; checked: boolean | null;
  maxLength: number | null; options: number | null;
}
export interface WidgetInfo { cls: string; id: string | null; eventTarget: string | null; eventName: string | null; validationGroup: string | null; controlToValidate: string | null; errorMessage: string | null }
export interface TableInfo { id: string | null; headers: string[]; bodyRows: number; inputs: { name: string | null; id: string | null; type: string | null; disabled: boolean; readOnly: boolean }[] }
export interface PageStructure {
  title: string; formAction: string | null; formMethod: string | null;
  controls: ControlInfo[]; widgets: WidgetInfo[]; autoCompletes: string[]; tables: TableInfo[];
  labels: string[]; messages: string[]; validators: WidgetInfo[]; looksLikeLogin: boolean;
}

const redact = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/\b\d{7,}\b/g, '#').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<correo>').slice(0, 160);
const pick = (body: string, key: string): string | null => new RegExp(`'${key}'\\s*:\\s*'([^']*)'`).exec(body)?.[1] ?? null;

export function describePage(html: string): PageStructure {
  const $ = cheerio.load(html);
  const form = $('form').first();
  const controls: ControlInfo[] = [];
  form.find('input, select, textarea, button').each((_, el) => {
    const $el = $(el);
    const tag = (el as { tagName: string }).tagName;
    const type = $el.attr('type')?.toLowerCase() ?? null;
    if (tag === 'input' && type === 'hidden' && /^PRADO_/.test($el.attr('name') ?? '')) return; // estado interno de PRADO
    controls.push({
      tag, type, name: $el.attr('name') ?? null, id: $el.attr('id') ?? null, disabled: $el.is('[disabled]'), readOnly: $el.is('[readonly]'),
      checked: type === 'checkbox' || type === 'radio' ? $el.is('[checked]') : null,
      maxLength: $el.attr('maxlength') ? Number($el.attr('maxlength')) : null, options: tag === 'select' ? $el.find('option').length : null,
    });
  });
  const widgets: WidgetInfo[] = [];
  for (const m of html.matchAll(/Prado\.WebUI\.(\w+)\(\{([^;]*?)\}\);/g)) {
    const body = m[2] as string;
    widgets.push({
      cls: m[1] as string, id: pick(body, 'ID') ?? pick(body, 'ControlID'), eventTarget: pick(body, 'EventTarget'), eventName: pick(body, 'EventName') ?? pick(body, 'Event'),
      validationGroup: pick(body, 'ValidationGroup'), controlToValidate: pick(body, 'ControlToValidate'), errorMessage: pick(body, 'ErrorMessage'),
    });
  }
  for (const m of html.matchAll(/new\s+Prado\.WebUI\.(\w+)\(\{([^;]*?)\}\)/g)) {
    const body = m[2] as string;
    const id = pick(body, 'ID');
    if (!widgets.some((w) => w.cls === m[1] && w.id === id)) {
      widgets.push({ cls: m[1] as string, id, eventTarget: pick(body, 'EventTarget'), eventName: pick(body, 'EventName'), validationGroup: pick(body, 'ValidationGroup'), controlToValidate: pick(body, 'ControlToValidate'), errorMessage: pick(body, 'ErrorMessage') });
    }
  }
  const tables: TableInfo[] = $('table').toArray().map((t) => {
    const $t = $(t);
    let headers = $t.find('th').toArray().map((h) => redact($(h).text()));
    if (headers.length === 0) headers = $t.find('tr').first().find('td').toArray().map((h) => redact($(h).text()));
    return {
      id: $t.attr('id') ?? null, headers: headers.filter(Boolean), bodyRows: Math.max($t.find('tr').length - 1, 0),
      inputs: $t.find('input, select, textarea').toArray().map((i) => ({ name: $(i).attr('name') ?? null, id: $(i).attr('id') ?? null, type: $(i).attr('type') ?? null, disabled: $(i).is('[disabled]'), readOnly: $(i).is('[readonly]') })),
    };
  }).filter((t) => t.headers.length > 0 || t.inputs.length > 0);
  const labels = [...new Set($('label, span[id*="Label"], legend').toArray().map((l) => redact($(l).text())).filter((t) => t.length > 1))].slice(0, 60);
  const messages = [...new Set($('[id*="ensaje"], [id*="Error"], [class*="error"]').toArray().map((l) => redact($(l).text())).filter(Boolean))].slice(0, 20);
  return {
    title: redact($('title').first().text()), formAction: form.attr('action') ?? null, formMethod: form.attr('method') ?? null, controls,
    widgets: widgets.filter((w) => !w.controlToValidate), autoCompletes: widgets.filter((w) => /AutoComplete/i.test(w.cls)).map((w) => w.id ?? '?'),
    tables, labels, messages, validators: widgets.filter((w) => w.controlToValidate), looksLikeLogin: html.includes('ctl0$MainModule$BtnIngresar'),
  };
}

export interface Step { step: string; ok: boolean; detail?: unknown }
export interface AfterSearch { controls: ControlInfo[]; tables: TableInfo[]; widgets: WidgetInfo[]; messages: string[]; validators: WidgetInfo[] }
export interface DiagnosticResult {
  page: string; reused: boolean; steps: Step[]; structure: PageStructure | null;
  home?: HomeDescription;
  lookup: { requested: boolean; steps: Step[]; tables: TableInfo[]; numericFields: { name: string; value: string | null; disabled: boolean; readOnly: boolean }[]; afterSearch: AfterSearch | null } | null;
}

/** Solo el botón «Buscar» (lectura) puede enviarse; jamás Grabar ni nada que persista. */
export const isSearchButton = (c: { type: string | null; name: string | null; id: string | null }): boolean =>
  c.type === 'submit' && /buscar/i.test(`${c.id ?? ''} ${c.name ?? ''}`) && !/grabar|guardar|save|generar|aceptar|eliminar|anular/i.test(`${c.id ?? ''} ${c.name ?? ''}`);

const UNSAFE = /grabar|guardar|save|submit|btn|button|generar|aceptar|eliminar|anular/i;
export const isSafeTarget = (t: string | null): t is string => !!t && !UNSAFE.test(t);

function htmlFragments(text: string): string[] {
  const out: string[] = [];
  const m = /<!--X-PRADO-ACTIONS-->([\s\S]*?)<!--\/\/X-PRADO-ACTIONS-->/.exec(text);
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.includes('<')) out.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (m) { try { walk(JSON.parse(m[1] as string)); } catch { /* sin acciones */ } }
  if (/<table/i.test(text)) out.push(text);
  return out;
}

/** Valores numéricos de peso/cantidad/tarifa (no son datos personales) y estructura de tablas en fragmentos HTML. */
export function summarizeFragments(frags: string[]): { tables: TableInfo[]; numeric: { name: string; value: string | null; disabled: boolean; readOnly: boolean }[] } {
  const tables: TableInfo[] = [];
  const numeric: { name: string; value: string | null; disabled: boolean; readOnly: boolean }[] = [];
  for (const f of frags) {
    const st = describePage(`<form>${f}</form>`);
    tables.push(...st.tables);
    const $ = cheerio.load(`<form>${f}</form>`);
    $('input, select, textarea').each((_, el) => {
      const $el = $(el);
      const name = $el.attr('name') ?? $el.attr('id') ?? '';
      if (!/peso|cantidad|tarifa|valor|total/i.test(name)) return;
      const raw = ($el.attr('value') ?? $el.text() ?? '').trim();
      numeric.push({ name, value: /^-?[\d.,]+$/.test(raw) ? raw : raw === '' ? '' : null, disabled: $el.is('[disabled]'), readOnly: $el.is('[readonly]') });
    });
  }
  return { tables, numeric };
}

/**
 * Etapa 1: GET de la pantalla y su estructura. Etapa 2 (opcional): casilla/campo Remesa con pasos de lectura.
 * Cada paso se reporta. No hay ningún POST a botones y nunca se pulsa Grabar.
 */
export async function runDiagnostic(client: SilogWebClient, opts: { lookup: boolean; search?: boolean; home?: boolean; remesa: string; reused: boolean }): Promise<DiagnosticResult> {
  const steps: Step[] = [];
  const page = await client.enqueue(() => client.request(TARIFF_PAGE));
  const structure = describePage(page.text);
  if (structure.looksLikeLogin) throw new SilogWebError('WEB_BAD_PAGE', 'Silogtran devolvió la pantalla de login en lugar de la pantalla de cambio de tarifa (sesión no válida o sin permiso)');
  steps.push({ step: 'GET pantalla de cambio de tarifa', ok: true, detail: { controls: structure.controls.length, widgets: structure.widgets.length, tables: structure.tables.length } });
  const result: DiagnosticResult = { page: TARIFF_PAGE, reused: opts.reused, steps, structure, lookup: null };
  if (opts.home) {
    // Página de CONSULTA (solo GET): lo que Silogtran guarda de verdad para la remesa.
    const hp = await client.enqueue(() => client.request(`${HOME_PAGE}${opts.remesa.padStart(10, '0')}`));
    result.home = describeRemesaHome(hp.text);
    steps.push({ step: 'GET página de consulta de la remesa (Home_111)', ok: true, detail: { tables: result.home.tables.length, fields: result.home.fields.length } });
  }
  if (!opts.lookup && !opts.search) return result;

  const lookupSteps: Step[] = [];
  const tables: TableInfo[] = [];
  const numericFields: { name: string; value: string | null; disabled: boolean; readOnly: boolean }[] = [];
  result.lookup = { requested: true, steps: lookupSteps, tables, numericFields, afterSearch: null };
  await client.enqueue(async () => {
    const prado = new PradoPage(client, page);
    const isRemesa = (s: string | null | undefined): boolean => !!s && /remesa/i.test(s) && !/razon|raz[oó]n|grabar|btn/i.test(s);
    const ac = structure.widgets.find((w) => /AutoComplete/i.test(w.cls) && isRemesa(w.id));
    const chk = structure.controls.find((c) => c.type === 'checkbox' && isRemesa(c.id ?? c.name));
    const input = structure.controls.find((c) => c.type !== 'checkbox' && c.type !== 'hidden' && c.tag === 'input' && isRemesa(c.id ?? c.name));
    lookupSteps.push({ step: 'identificar controles Remesa', ok: !!(ac || input), detail: { autoComplete: ac?.id ?? null, checkbox: chk?.id ?? null, input: input?.id ?? null } });
    if (!ac && !input) return;

    const triggersFor = (id: string): { target: string; event: string | null }[] =>
      structure.widgets.filter((w) => w.cls === 'TEventTriggeredCallback' && w.id === id && isSafeTarget(w.eventTarget)).map((w) => ({ target: w.eventTarget as string, event: w.eventName }));
    const runTriggers = async (id: string, label: string): Promise<void> => {
      for (const t of triggersFor(id)) {
        try {
          const r = await prado.callback(t.target);
          const sum = summarizeFragments(htmlFragments(r.text));
          tables.push(...sum.tables);
          numericFields.push(...sum.numeric);
          lookupSteps.push({ step: `callback de lectura (${label})`, ok: true, detail: { event: t.event, target: t.target, fieldsUpdated: r.applied.length, tablesFound: sum.tables.length } });
        } catch (e) {
          lookupSteps.push({ step: `callback de lectura (${label})`, ok: false, detail: { target: t.target, error: e instanceof SilogWebError ? e.code : 'ERROR' } });
          if (!(e instanceof SilogWebError) || e.code !== 'WEB_HTTP_ERROR') throw e;
        }
      }
    };

    if (chk?.name) {
      prado.fields[chk.name] = 'on'; // marcar la casilla localmente (como el navegador) y disparar sus callbacks de lectura
      lookupSteps.push({ step: 'marcar casilla Remesa (local)', ok: true });
      if (chk.id) await runTriggers(chk.id, 'casilla Remesa');
    }
    const field = ac?.id ? (prado.ids.get(ac.id.toLowerCase()) ?? input?.name ?? null) : (input?.name ?? null);
    if (!field) { lookupSteps.push({ step: 'resolver nombre del campo Remesa', ok: false }); return; }
    if (ac) {
      const sugg = await prado.suggest(field, opts.remesa);
      lookupSteps.push({ step: 'autocompletar remesa (callback de lectura)', ok: true, detail: { suggestions: sugg.length, cellsPerRow: sugg[0]?.cells.length ?? 0, attrKeys: Object.keys(sugg[0]?.attrs ?? {}) } });
      if (sugg[0]) { prado.select(sugg[0]); lookupSteps.push({ step: 'seleccionar primera sugerencia (local)', ok: true }); }
    } else {
      prado.fields[field] = opts.remesa;
      lookupSteps.push({ step: 'escribir código de remesa (local)', ok: true });
    }
    const id = ac?.id ?? input?.id ?? null;
    if (id) await runTriggers(id, 'campo Remesa');
    if (opts.search) {
      const btn = structure.controls.find(isSearchButton);
      const note = structure.controls.find((c) => c.tag === 'textarea');
      const lock = structure.controls.find((c) => c.type === 'hidden' && /^ctl0\$MainModule\$IDLockHidden_/.test(c.name ?? '') && /buscar/i.test(c.name ?? ''));
      if (!btn?.name) { lookupSteps.push({ step: 'botón Buscar (envío de solo lectura)', ok: false, detail: 'no se encontró un botón de búsqueda' }); }
      else {
        if (note?.name) prado.fields[note.name] = 'diagnostico de solo lectura'; // el validador de PRADO exige la razón; no se graba nada
        const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [btn.name]: 'Buscar' };
        if (lock?.name) extra[lock.name] = 'true';
        const resp = await prado.postback('', extra);
        const after = describePage(resp.text);
        const sum = summarizeFragments([resp.text]);
        result.lookup!.afterSearch = { controls: after.controls, tables: after.tables, widgets: after.widgets, messages: after.messages, validators: after.validators };
        numericFields.push(...sum.numeric.filter((n) => !numericFields.some((x) => x.name === n.name)));
        lookupSteps.push({ step: 'botón Buscar (envío de solo lectura, sin Grabar)', ok: true, detail: { tables: after.tables.length, controls: after.controls.length, messages: after.messages.length } });
      }
    }
    // Estructura final de lo que la página tiene ahora (sin enviar nada).
    const sumPage = summarizeFragments([prado.html]);
    numericFields.push(...sumPage.numeric.filter((n) => !numericFields.some((x) => x.name === n.name)));
  });
  return result;
}

export const HOME_PAGE = 'index.php?page=Despacho.Remesa_003.Home_111&remesa_codigo=';

export interface HomeTable { id: string | null; headers: string[]; rows: string[][] }
export interface HomeDescription { tables: HomeTable[]; fields: { id: string | null; name: string | null; tag: string; value: string | null }[] }

const cellText = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, 80);

/** Estructura de la página de CONSULTA de la remesa (Home_111): tabla de ítems por encabezado y campos de tarifa/flete. Solo lectura. */
export function describeRemesaHome(html: string): HomeDescription {
  const $ = cheerio.load(html);
  const tables: HomeTable[] = [];
  $('table').each((_, t) => {
    const $t = $(t);
    const id = $t.attr('id') ?? null;
    if (!(id && /ItemsRemesa/i.test(id))) return;
    const headers = $t.find('th').toArray().map((h) => cellText($(h).text()));
    const rows = $t.find('tr').toArray().map((r) => $(r).find('td').toArray().map((c) => cellText($(c).text()))).filter((r) => r.length > 0);
    tables.push({ id, headers, rows });
  });
  const fields: HomeDescription['fields'] = [];
  $('input, span, td, select, textarea').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id') ?? null;
    const name = $el.attr('name') ?? null;
    if (!/tarifa_cliente|remesa_flete/i.test(`${id ?? ''} ${name ?? ''}`)) return;
    const tag = (el as { tagName: string }).tagName;
    if (tag === 'td' && !id) return;
    fields.push({ id, name, tag, value: tag === 'input' ? ($el.attr('value') ?? '') : cellText($el.text()) });
  });
  return { tables, fields };
}

export const INVOICE_PAGE = 'index.php?page=Financiero.Factura.Automatica_111';

export interface InvoiceControl {
  tag: string; type: string | null; name: string | null; id: string | null; value: string | null; checked: boolean | null; disabled: boolean; readOnly: boolean;
  options?: { value: string; text: string; selected: boolean }[];
}
export interface InvoicePageMap {
  title: string; formAction: string | null; controls: InvoiceControl[]; labelled: { id: string; text: string }[]; tables: HomeTable[]; widgets: WidgetInfo[];
}

/** Mapa de la pantalla de facturar (solo lectura): controles con valor por defecto, selects con opciones, textos de totales y tablas. */
export function describeInvoicePage(html: string): InvoicePageMap {
  const $ = cheerio.load(html);
  const form = $('form').first();
  const controls: InvoiceControl[] = [];
  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const tag = (el as { tagName: string }).tagName;
    const type = $el.attr('type')?.toLowerCase() ?? null;
    const name = $el.attr('name') ?? null;
    if (name && /^PRADO_(PAGESTATE|POSTBACK|CALLBACK)/.test(name)) return;
    const c: InvoiceControl = {
      tag, type, name, id: $el.attr('id') ?? null, value: tag === 'textarea' ? $el.text().slice(0, 200) : tag === 'select' ? null : ($el.attr('value') ?? '').slice(0, 120),
      checked: type === 'checkbox' || type === 'radio' ? $el.is('[checked]') : null, disabled: $el.is('[disabled]'), readOnly: $el.is('[readonly]'),
    };
    if (tag === 'select') c.options = $el.find('option').toArray().slice(0, 40).map((o) => ({ value: $(o).attr('value') ?? '', text: $(o).text().trim().slice(0, 60), selected: $(o).is('[selected]') }));
    controls.push(c);
  });
  const labelled = $('span[id], td[id], div[id]').toArray()
    .filter((e) => /flete|total|impuesto|otros|retefuente|retelca|mensaje|error/i.test($(e).attr('id') ?? ''))
    .map((e) => ({ id: $(e).attr('id') as string, text: $(e).text().replace(/\s+/g, ' ').trim().slice(0, 120) }))
    .filter((x) => x.text !== '').slice(0, 40);
  const tables: HomeTable[] = [];
  $('table').each((_, t) => {
    const $t = $(t);
    const headers = $t.find('th').toArray().map((h) => cellText($(h).text())).filter(Boolean);
    const rows = $t.find('tr').toArray().map((r) => $(r).children('td').toArray().map((c) => cellText($(c).text()))).filter((r) => r.length > 4 && r.some(Boolean));
    if (headers.length > 4 || (rows.length > 0 && rows.length <= 40 && /Remesa/i.test($t.text().slice(0, 400)) && rows[0] && rows[0].length >= 8)) tables.push({ id: $t.attr('id') ?? null, headers, rows: rows.slice(0, 5) });
  });
  const widgets: WidgetInfo[] = [];
  for (const m of html.matchAll(/Prado\.WebUI\.(\w+)\(\{([^;]*?)\}\);/g)) {
    const body = m[2] as string;
    widgets.push({ cls: m[1] as string, id: pick(body, 'ID') ?? pick(body, 'ControlID'), eventTarget: pick(body, 'EventTarget'), eventName: pick(body, 'EventName') ?? pick(body, 'Event'), validationGroup: pick(body, 'ValidationGroup'), controlToValidate: pick(body, 'ControlToValidate'), errorMessage: null });
  }
  return { title: redact($('title').first().text()), formAction: form.attr('action') ?? null, controls, labelled, tables, widgets };
}

/** Solo el botón «Listar Remesas» puede enviarse en el diagnóstico (jamás Facturar, Preview, Total ni Limpiar). */
export const isListButton = (c: { type: string | null; name: string | null; id: string | null; value: string | null }): boolean =>
  c.type === 'submit' && /listar/i.test(`${c.id ?? ''} ${c.name ?? ''} ${c.value ?? ''}`) && !/factur|preview|total|limpiar|emit|generar|grabar/i.test(`${c.id ?? ''} ${c.name ?? ''} ${c.value ?? ''}`);

export interface InvoiceDiagnostic { steps: Step[]; before: InvoicePageMap; after: InvoicePageMap | null }

export async function runInvoiceDiagnostic(client: SilogWebClient, remesa: string): Promise<InvoiceDiagnostic> {
  const steps: Step[] = [];
  const page = await client.enqueue(() => client.request(INVOICE_PAGE));
  if (page.text.includes('ctl0$MainModule$BtnIngresar')) throw new SilogWebError('WEB_BAD_PAGE', 'Silogtran devolvió el login en lugar de la pantalla de facturar (sesión expirada o sin permiso)');
  const before = describeInvoicePage(page.text);
  steps.push({ step: 'GET pantalla de facturar', ok: true, detail: { controls: before.controls.length, tables: before.tables.length } });
  const out: InvoiceDiagnostic = { steps, before, after: null };
  const comas = before.controls.find((c) => c.tag === 'textarea' && /coma/i.test(`${c.id ?? ''} ${c.name ?? ''}`)) ?? null;
  const listar = before.controls.find(isListButton) ?? null;
  steps.push({ step: 'identificar «Búsqueda Por Comas» y «Listar Remesas»', ok: !!(comas?.name && listar?.name), detail: { textarea: comas?.id ?? null, button: listar?.name ?? null } });
  if (!comas?.name || !listar?.name) return out;
  await client.enqueue(async () => {
    const prado = new PradoPage(client, page);
    prado.fields[comas.name as string] = remesa.padStart(10, '0');
    const lock = Object.keys(prado.fields).find((k) => /IDLockHidden_.*listar/i.test(k));
    const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [listar.name as string]: listar.value && listar.value !== '' ? listar.value : 'Listar Remesas' };
    if (lock) extra[lock] = 'true';
    const res = await prado.postback('', extra);
    out.after = describeInvoicePage(res.text);
    steps.push({ step: 'botón «Listar Remesas» (solo lectura; sin Facturar)', ok: true, detail: { tables: out.after.tables.length } });
  });
  return out;
}
