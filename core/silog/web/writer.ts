// Escritor REAL de «Procedimiento de Cambio Tarifa» (docs/silogtran-cambio-tarifa.md).
// Seguridad: un ÚNICO método (postGrabar) envía Grabar y solo changeTariff lo llama; el ensayo (rehearse) nunca lo hace.
import { normalizeNumberString } from '../../adjust/tariff.js';
import type { RehearsalCheck, RehearsalResult, ScreenValues, SilogtranWriter, TariffChange, WriteContext, WriterOutcome } from '../../adjust/writer.js';
import type { Db } from '../../db/types.js';
import { log } from '../../logger.js';
import type { SilogWebClient } from './client.js';
import { describePage, TARIFF_PAGE } from './diagnostic.js';
import { SilogWebError } from './errors.js';
import { PradoPage } from './prado.js';
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

/** Clasifica la respuesta de Grabar. Cualquier cosa desconocida es 'ambiguous' (nunca éxito). */
export function classifyGrabarResponse(html: string): { verdict: GrabarVerdict; lines: string[] } {
  const st = describePage(html);
  const lines = [...new Set([...st.messages, ...st.labels.filter((l) => /guard|grab|actualiz|error|inv[aá]lid|no se/i.test(l))])];
  const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n');
  for (const l of bodyText.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 6 && x.length < 220)) {
    if (/guardad|grabad|actualizad|con [eé]xito|exitos|error|no se pudo|no se puede|inv[aá]lid|obligatori|ya existe/i.test(l)) lines.push(l.slice(0, 160));
  }
  const uniq = [...new Set(lines)];
  const err = uniq.some((l) => /error|no se pudo|no se puede|inv[aá]lid|obligatori|ya existe/i.test(l));
  const ok = uniq.some((l) => /(registro|cambio|tarifa|remesa).{0,40}(guardad|grabad|actualizad)|guardad[oa] con [eé]xito|se (ha )?(guard|grab|actualiz)/i.test(l));
  return { verdict: ok && !err ? 'success' : err && !ok ? 'error' : 'ambiguous', lines: uniq.slice(0, 6) };
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normalizeNumberString(a ?? null);
  const y = normalizeNumberString(b ?? null);
  return x !== null && y !== null && x === y;
};
const sameValues = (a: ScreenValues, b: ScreenValues): boolean => same(a.peso, b.peso) && same(a.cantidad, b.cantidad) && same(a.tarifa, b.tarifa);

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
const beforeOf = (prado: PradoPage, r: Row): ScreenValues => ({
  peso: prado.fields[r.names.anterior_peso as string] ?? '', cantidad: prado.fields[r.names.anterior_cantidad as string] ?? '', tarifa: prado.fields[r.names.anterior_tarifa as string] ?? '',
});

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

  /** GET + autocompletado exacto + razón + Buscar + lectura de anterior_*; deja los 3 campos nuevos fijados. NO graba. */
  private async prepare(client: SilogWebClient, change: TariffChange, expectedBefore: ScreenValues | null | undefined, withFields: boolean): Promise<Prepared> {
    const checks: RehearsalCheck[] = [];
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
    if (exact.length !== 1) throw new NotWritable('rejected', exact.length === 0 ? 'La remesa no aparece en el autocompletado de Silogtran' : 'Varias coincidencias para la remesa: no se escribe');
    checks.push({ name: 'remesa encontrada con coincidencia exacta', ok: true });
    prado.select(exact[0] as { attrs: Record<string, string> });
    prado.fields[noteField] = change.reason;

    const lockName = Object.keys(prado.fields).find((k) => /IDLockHidden_.*buscar$/.test(k)) ?? null;
    const extra: Record<string, string> = { PRADO_POSTBACK_PARAMETER: '', [searchBtn]: 'Buscar' };
    if (lockName) extra[lockName] = 'true';
    const res = await prado.postback('', extra);
    if (describePage(res.text).looksLikeLogin) throw new SilogWebError('WEB_BAD_PAGE', 'La sesión expiró durante la búsqueda');

    const rs = rows(prado);
    if (rs.length !== 1) throw new NotWritable('rejected', `La búsqueda devolvió ${rs.length} ítems; se esperaba exactamente 1`);
    const row = rs[0] as Row;
    for (const k of ['anterior_peso', 'anterior_cantidad', 'anterior_tarifa', 'nuevo_peso', 'nuevo_cantidad', 'nueva_tarifa']) {
      if (!row.names[k]) throw new SilogWebError('WEB_BAD_PAGE', `Falta el campo ${k} en la tabla de ítems`);
    }
    const before = beforeOf(prado, row);
    checks.push({ name: 'un solo ítem con valores anteriores legibles', ok: normalizeNumberString(before.peso) !== null && normalizeNumberString(before.tarifa) !== null, detail: `peso ${before.peso}, cantidad ${before.cantidad}, tarifa ${before.tarifa}` });
    if (expectedBefore && !sameValues(before, expectedBefore)) {
      checks.push({ name: 'valores anteriores iguales a los del ensayo', ok: false });
      throw new NotWritable('stale', 'Los valores anteriores de la pantalla cambiaron desde el ensayo', before, checks);
    }
    if (expectedBefore) checks.push({ name: 'valores anteriores iguales a los del ensayo', ok: true });

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
          after = await this.readBack(s.client, change);
        } catch {
          after = null; // no se pudo releer: incierto
        }
        const want: ScreenValues = { peso: change.pesoRemesa, cantidad: change.cantidadRemesa, tarifa: change.nuevaTarifa };
        if (after && sameValues(after, want)) {
          return verdict.verdict === 'success'
            ? { outcome: 'applied', before: prep.before, detail: verdict.lines.join(' | ') }
            : { outcome: 'uncertain', before: prep.before, detail: `Los valores cambiaron pero el mensaje de Silogtran no es el esperado (${verdict.verdict}): ${verdict.lines.join(' | ') || 'sin mensaje'}` };
        }
        if (after && sameValues(after, prep.before) && verdict.verdict === 'error') {
          return { outcome: 'rejected', before: prep.before, detail: `Silogtran no aplicó el cambio: ${verdict.lines.join(' | ')}` };
        }
        return { outcome: 'uncertain', before: prep.before, detail: `No se pudo confirmar el resultado de Grabar (${verdict.verdict}): ${verdict.lines.join(' | ') || 'sin mensaje'}` };
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

  /** Vuelve a buscar la remesa (sin fijar campos) y lee los valores que la pantalla muestra ahora. */
  private async readBack(client: SilogWebClient, change: TariffChange): Promise<ScreenValues> {
    const prep = await this.prepare(client, { ...change, reason: change.reason }, null, false);
    return prep.before;
  }

  async getChangeState(_remesa: string, change: TariffChange, ctx: WriteContext = { actor: null }): Promise<'applied' | 'not_applied' | 'unknown'> {
    const s = await this.open(ctx.actor);
    try {
      return await s.client.enqueue(async () => {
        let now: ScreenValues;
        try {
          now = await this.readBack(s.client, change);
        } catch {
          return 'unknown' as const;
        }
        const want: ScreenValues = { peso: change.pesoRemesa, cantidad: change.cantidadRemesa, tarifa: change.nuevaTarifa };
        if (sameValues(now, want)) return 'applied' as const;
        if (ctx.expectedBefore && sameValues(now, ctx.expectedBefore)) return 'not_applied' as const;
        return 'unknown' as const;
      });
    } finally {
      await s.close();
    }
  }
}
