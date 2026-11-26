// Escritor REAL de «Procedimiento de Cambio Tarifa» (docs/silogtran-cambio-tarifa.md).
// Seguridad: un ÚNICO método (postGrabar) envía Grabar y solo changeTariff lo llama; el ensayo (rehearse) nunca lo hace.
// La verificación se hace en la página de CONSULTA de la remesa (Home_111); el informe de Silogtran no refleja estos campos.
import { normalizeNumberString } from '../../adjust/tariff.js';
import type {
  ChangeStateResult, FieldCheck, RehearsalCheck, RehearsalResult, ScreenValues, SilogtranWriter, TariffChange, WriteContext, WriterOutcome,
} from '../../adjust/writer.js';
import type { Db } from '../../db/types.js';
import { log } from '../../logger.js';
import type { SilogWebClient } from './client.js';
import { describePage, TARIFF_PAGE } from './diagnostic.js';
import { SilogWebError } from './errors.js';
import { PradoPage } from './prado.js';
import { readRemesaHome } from './remesa.js';
import type { RemesaState } from './remesa.js';
import { openWebSession } from './session.js';
import type { WafSolver } from './waf.js';

const P = 'ctl0$MainModule$';
const GRABAR_TIMEOUT_MS = 40_000;
const ROW_RE = /^ctl0\$MainModule\$ItemsRemesa\$(ctl\d+)\$(anterior_peso|anterior_cantidad|anterior_tarifa|nuevo_peso|nuevo_cantidad|nueva_tarifa)$/;

export interface WebWriterDeps {
  db: Db;
  encryptionKey: string;
  baseUrl: string;
  waf: WafSolver | null;
  fetchFn?: () => typeof fetch | undefined;
}

export type GrabarVerdict = 'success' | 'error' | 'ambiguous';

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
};
/** Decodifica entidades HTML comunes (&eacute;, &nbsp;, &#233;, &#xE9;...). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, n: string) => ENTITIES[n] ?? m);
}
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SUCCESS_RE = /la remesa\s*#?\s*\d+\s+fue actualizad[oa] con exito/;
const GENERIC_OK_RE = /(registro|cambio|tarifa|remesa).{0,40}(guardad|grabad|actualizad)|guardad[oa] con exito|se (ha )?(guard|grab|actualiz)/;
const ERROR_RE = /error|no se pudo|no se puede|invalid|obligatori|ya existe/;

/** Clasifica la respuesta de Grabar tras decodificar entidades. Todo lo desconocido es 'ambiguous' (nunca éxito). */
export function classifyGrabarResponse(html: string): { verdict: GrabarVerdict; lines: string[] } {
  const decoded = decodeEntities(html);
  const text = decoded.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/\\[nrt]/g, '\n').split(/[\n"']/);
  const lines: string[] = [];
  for (const raw of text) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (l.length > 6 && l.length < 220 && (GENERIC_OK_RE.test(fold(l)) || ERROR_RE.test(fold(l)) || SUCCESS_RE.test(fold(l)))) lines.push(l.replace(/\b\d{7,}\b/g, '#').slice(0, 160));
  }
  const uniq = [...new Set(lines)];
  const folded = uniq.map(fold);
  const exact = folded.some((l) => SUCCESS_RE.test(l.replace(/#/g, '0')) || /la remesa\s*#\s*fue actualizad[oa] con exito/.test(l));
  const err = folded.some((l) => ERROR_RE.test(l) && !SUCCESS_RE.test(l.replace(/#/g, '0')) && !/la remesa\s*#\s*fue actualizad/.test(l));
  const ok = exact || folded.some((l) => GENERIC_OK_RE.test(l));
  return { verdict: ok && !err ? 'success' : err && !ok ? 'error' : 'ambiguous', lines: uniq.slice(0, 6) };
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normalizeNumberString(a ?? null);
  const y = normalizeNumberString(b ?? null);
  return x !== null && y !== null && x === y;
};
const sameValues = (a: ScreenValues, b: ScreenValues): boolean => same(a.peso, b.peso) && same(a.cantidad, b.cantidad) && same(a.tarifa, b.tarifa);
export const toValues = (s: RemesaState): ScreenValues => ({ peso: s.peso, cantidad: s.pesoBruto, tarifa: s.tarifa, flete: s.flete });
const wantOf = (c: TariffChange): ScreenValues => ({ peso: c.pesoRemesa, cantidad: c.cantidadRemesa, tarifa: c.nuevaTarifa });

/** Detalle por campo de una lectura de Home_111 contra lo esperado. */
export function fieldChecks(now: ScreenValues, want: ScreenValues, valorTotal?: string | null): Record<string, FieldCheck> {
  const out: Record<string, FieldCheck> = {
    peso: { expected: want.peso, actual: now.peso, ok: same(now.peso, want.peso) },
    cantidad: { expected: want.cantidad, actual: now.cantidad, ok: same(now.cantidad, want.cantidad) },
    tarifa: { expected: want.tarifa, actual: now.tarifa, ok: same(now.tarifa, want.tarifa) },
  };
  if (valorTotal) out.flete = { expected: valorTotal, actual: now.flete ?? null, ok: same(now.flete, valorTotal) }; // informativo
  return out;
}

interface Row { ctl: string; names: Record<string, string> }

function rows(prado: PradoPage): Row[] {
  const byCtl = new Map<string, Row>();
  for (const name of Object.keys(prado.fields)) {
    const m = ROW_RE.exec(name);
    if (!m) continue;
    const r = byCtl.get(m[1] as string) ?? { ctl: m[1] as string, names: {} };
    r.names[m[2] as string] = name;
    byCtl.set(m[1] as string, r);
  }
  return [...byCtl.values()];
}

interface Prepared { prado: PradoPage; row: Row; before: ScreenValues; checks: RehearsalCheck[]; grabar: { target: string | null; hasUuid: boolean; hasLock: boolean }; lockName: string | null }

class NotWritable extends Error {
  constructor(readonly outcome: 'rejected' | 'stale', readonly detail: string, readonly before?: ScreenValues, readonly checks: RehearsalCheck[] = []) { super(detail); }
}

export class SilogtranWebWriter implements SilogtranWriter {
  readonly kind = 'web' as const;
  readonly simulated = false;
  constructor(private readonly deps: WebWriterDeps) {}

  private open(actor: string | null) {
    return openWebSession({ db: this.deps.db, encryptionKey: this.deps.encryptionKey, baseUrl: this.deps.baseUrl, waf: this.deps.waf, fetchFn: this.deps.fetchFn?.() }, 'adjust', actor);
  }

  /** Lee Home_111 (valores reales), GET + autocompletado exacto + razón + Buscar; deja los 3 campos nuevos fijados. NO graba. */
  private async prepare(client: SilogWebClient, change: TariffChange, expectedBefore: ScreenValues | null | undefined, withFields: boolean): Promise<Prepared> {
    const checks: RehearsalCheck[] = [];
    const home = await readRemesaHome(client, change.remesaCode, true);
    const before = toValues(home);
    checks.push({ name: 'valores reales de la remesa leídos en la consulta (Home_111)', ok: true, detail: `peso ${before.peso}, cantidad (peso bruto) ${before.cantidad}, tarifa ${before.tarifa}, flete ${before.flete}` });
    if (expectedBefore) {
      const ok = sameValues(before, expectedBefore);
      checks.push({ name: 'valores reales iguales a los del ensayo', ok });
      if (!ok) throw new NotWritable('stale', 'Los valores reales de la remesa cambiaron desde el ensayo', before, checks);
    }
    if (withFields && sameValues(before, wantOf(change))) {
      checks.push({ name: 'la remesa aún no tiene los valores nuevos', ok: false });
      throw new NotWritable('stale', 'La remesa ya tiene esos valores (ya ajustado)', before, checks);
    }

    const page = await client.request(TARIFF_PAGE);
    const st = describePage(page.text);
    if (st.looksLikeLogin) throw new SilogWebError('WEB_BAD_PAGE', 'Silogtran devolvió el login en lugar de la pantalla de cambio de tarifa (sesión expirada o sin permiso)');
    const prado = new PradoPage(client, page);
    const codeField = `${P}remesa_codigo`;
    const noteField = `${P}cambiotarifa_nota`;
    const searchBtn = `${P}buscar`;
    if (!(codeField in prado.fields) || !(noteField in prado.fields)) throw new SilogWebError('WEB_BAD_PAGE', 'La pantalla no tiene los campos Remesa o Razón de cambio esperados');
    checks.push({ name: 'pantalla con campos esperados', ok: true });

    const wanted = change.remesaCode.replace(/\D/g, '').replace(/^0+/, '');
    const sugg = await prado.suggest(codeField, change.remesaCode.replace(/\D/g, '').padStart(10, '0'));
    const exact = sugg.filter((s) => Object.values(s.attrs).some((v) => v.replace(/\D/g, '').replace(/^0+/, '') === wanted && /^\d+$/.test(v.replace(/^0+/, '') || '0')) || s.cells.some((c) => c.replace(/\D/g, '').replace(/^0+/, '') === wanted && /^\d+$/.test(c)));
    if (exact.length !== 1) throw new NotWritable('rejected', exact.length === 0 ? 'La remesa no aparece en el autocompletado de Silogtran' : 'Varias coincidencias para la remesa: no se escribe', before, checks);
    checks.push({ name: 'remesa encontrada con coincidencia exacta', ok: true });
    prado.select(exact[0] as { attrs: Record<string, string> });
    prado.fields[noteField] = change.reason;

    const lockName = Object.keys(prado.fields).find((k) => /IDLockHidden_.*buscar$/.test(k)) ?? null;
    const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [searchBtn]: 'Buscar' };
    if (lockName) extra[lockName] = 'true';
    const res = await prado.postback('', extra);
    if (describePage(res.text).looksLikeLogin) throw new SilogWebError('WEB_BAD_PAGE', 'La sesión expiró durante la búsqueda');

    const rs = rows(prado);
    if (rs.length !== 1) throw new NotWritable('rejected', `La búsqueda devolvió ${rs.length} ítems; se esperaba exactamente 1`, before, checks);
    const row = rs[0] as Row;
    for (const k of ['anterior_peso', 'anterior_cantidad', 'anterior_tarifa', 'nuevo_peso', 'nuevo_cantidad', 'nueva_tarifa']) {
      if (!row.names[k]) throw new SilogWebError('WEB_BAD_PAGE', `Falta el campo ${k} en la tabla de ítems`);
    }
    checks.push({ name: 'un solo ítem en la pantalla de cambio', ok: true });

    if (withFields) {
      // Validación del lado servidor que Silogtran no hace: todo se comprueba aquí antes de fijar los campos.
      const okFmt = /^\d+(\.\d+)?$/.test(change.pesoRemesa) && /^\d+(\.\d+)?$/.test(change.cantidadRemesa) && /^\d+(\.\d+)?$/.test(change.nuevaTarifa) && change.nuevaTarifa.length <= 12 && change.reason.trim().length > 0 && change.reason.length <= 200;
      checks.push({ name: 'formato de peso, cantidad, tarifa (punto, ≤ 12 caracteres) y razón', ok: okFmt });
      if (!okFmt) throw new NotWritable('rejected', 'Los valores a enviar no cumplen el formato esperado', before, checks);
      prado.fields[row.names.nuevo_peso as string] = change.pesoRemesa;
      prado.fields[row.names.nuevo_cantidad as string] = change.cantidadRemesa;
      prado.fields[row.names.nueva_tarifa as string] = change.nuevaTarifa;
      prado.fields[noteField] = change.reason;
      checks.push({ name: 'campos nuevos fijados', ok: true });
    }
    const pageNow = describePage(prado.html);
    const grabarCtl = pageNow.controls.find((c) => c.type === 'submit' && /\$grabar$/.test(c.name ?? ''));
    const lock = Object.keys(prado.fields).find((k) => /IDLockHidden_.*grabar$/.test(k)) ?? null;
    const hasUuid = typeof prado.fields[`${P}grabar_uuid`] === 'string' && (prado.fields[`${P}grabar_uuid`] as string).length > 0;
    checks.push({ name: 'botón Grabar y token grabar_uuid presentes', ok: !!grabarCtl && hasUuid, detail: !hasUuid ? 'grabar_uuid vacío' : undefined });
    return { prado, row, before, checks, grabar: { target: grabarCtl?.name ?? null, hasUuid, hasLock: !!lock }, lockName: lock };
  }

  async rehearse(change: TariffChange, ctx: WriteContext = { actor: null }): Promise<RehearsalResult> {
    const s = await this.open(ctx.actor);
    try {
      const prep = await s.client.enqueue(() => this.prepare(s.client, change, ctx.expectedBefore, true)).catch((e: unknown) => {
        if (e instanceof NotWritable) return { before: e.before ?? null, checks: [...e.checks, { name: e.detail, ok: false }] as RehearsalCheck[], grabar: undefined };
        throw e;
      });
      return { simulated: false, payload: change, before: prep.before ?? null, checks: prep.checks, wouldPostGrabar: false, grabar: prep.grabar };
    } finally {
      await s.close();
    }
  }

  async changeTariff(change: TariffChange, ctx: WriteContext = { actor: null }): Promise<WriterOutcome> {
    const s = await this.open(ctx.actor); // si falla aquí NO se escribió nada
    try {
      return await s.client.enqueue(async () => {
        let prep: Prepared;
        try {
          prep = await this.prepare(s.client, change, ctx.expectedBefore, true);
        } catch (e) {
          if (e instanceof NotWritable) return { outcome: e.outcome, detail: e.detail, before: e.before } as WriterOutcome;
          throw e; // errores previos al grabado: nada se escribió
        }
        if (prep.checks.some((c) => !c.ok)) return { outcome: 'rejected', detail: 'Falló una comprobación previa al grabado', before: prep.before };
        const sent = await this.postGrabar(s.client, prep); // el ÚNICO envío de Grabar
        if (sent.kind === 'lost') return { outcome: 'uncertain', detail: sent.detail, before: prep.before };
        const verdict = classifyGrabarResponse(sent.html);
        log('silog_web.grabar', { verdict: verdict.verdict });
        let after: ScreenValues | null = null;
        try {
          after = toValues(await readRemesaHome(s.client, change.remesaCode, true)); // verificación en la consulta de la remesa
        } catch {
          after = null; // no se pudo releer: incierto
        }
        const want = wantOf(change);
        const matches = !!after && sameValues(after, want);
        const fields = after ? fieldChecks(after, want, change.valorTotal) : undefined;
        const said = verdict.lines.join(' | ') || 'sin mensaje';
        if (verdict.verdict === 'success' && matches) return { outcome: 'applied', before: prep.before, after: after as ScreenValues, detail: `${said}; verificado en la consulta de la remesa` };
        if (verdict.verdict === 'success' && after && !matches) {
          return { outcome: 'verification_failed', before: prep.before, after, detail: `Silogtran dijo éxito pero la consulta no coincide: ${JSON.stringify(fields)}` };
        }
        if (matches) return { outcome: 'uncertain', before: prep.before, detail: `Los valores cambiaron pero el mensaje de Silogtran no es el esperado (${verdict.verdict}): ${said}` };
        if (after && sameValues(after, prep.before) && verdict.verdict === 'error') return { outcome: 'rejected', before: prep.before, detail: `Silogtran no aplicó el cambio: ${said}` };
        return { outcome: 'uncertain', before: prep.before, detail: `No se pudo confirmar el resultado de Grabar (${verdict.verdict}): ${said}` };
      });
    } finally {
      await s.close();
    }
  }

  /** ÚNICO punto que envía Grabar. Sin reintentos: si la petición se pierde, el resultado es incierto. */
  private async postGrabar(client: SilogWebClient, prep: Prepared): Promise<{ kind: 'ok'; html: string } | { kind: 'lost'; detail: string }> {
    const target = prep.grabar.target;
    if (!target) return { kind: 'lost', detail: 'No hay botón Grabar' }; // no se envía nada
    const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [target]: 'Grabar' };
    if (prep.lockName) extra[prep.lockName] = 'true';
    try {
      const res = await client.request(prep.prado.action, { method: 'POST', form: { ...prep.prado.fields, PRADO_POSTBACK_TARGET: '', ...extra }, timeoutMs: GRABAR_TIMEOUT_MS });
      return { kind: 'ok', html: res.text };
    } catch (e) {
      return { kind: 'lost', detail: `Se perdió la respuesta de Grabar (${e instanceof SilogWebError ? e.code : 'error'}); puede haberse grabado` };
    }
  }

  /** Lee Home_111 y compara por campo: aplicado / no aplicado / desconocido (con detalle de lo parcial). Solo lectura. */
  async getChangeState(_remesa: string, change: TariffChange, ctx: WriteContext = { actor: null }): Promise<ChangeStateResult> {
    const s = await this.open(ctx.actor);
    try {
      let now: ScreenValues;
      try {
        now = toValues(await readRemesaHome(s.client, change.remesaCode));
      } catch (e) {
        return { state: 'unknown', detail: e instanceof SilogWebError ? `No se pudo leer la remesa (${e.code})` : 'No se pudo leer la remesa' };
      }
      const want = wantOf(change);
      const fields = fieldChecks(now, want, change.valorTotal);
      if (sameValues(now, want)) return { state: 'applied', fields };
      if (ctx.expectedBefore && sameValues(now, ctx.expectedBefore)) return { state: 'not_applied', fields };
      const partial = ['peso', 'cantidad', 'tarifa'].some((k) => (fields[k] as FieldCheck).ok);
      return { state: 'unknown', fields, detail: partial ? 'Cambio parcial o mezcla de valores: revise la consulta de la remesa' : 'Los valores no coinciden ni con los nuevos ni con los anteriores' };
    } finally {
      await s.close();
    }
  }
}
