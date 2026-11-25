// Estado de un formulario PRADO: campos que un navegador enviaría, callbacks y autocompletado (SOLO lectura aquí).
// Se ejecuta dentro de client.enqueue(); no encola por sí mismo.
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import type { SilogWebClient, WebResponse } from './client.js';

const ACTIONS_RE = /<!--X-PRADO-ACTIONS-->([\s\S]*?)<!--\/\/X-PRADO-ACTIONS-->/;
const PAGESTATE_RE = /<!--X-PRADO-PAGESTATE-->([\s\S]*?)<!--\/\/X-PRADO-PAGESTATE-->/;

export class PradoPage {
  url = '';
  html = '';
  action = '';
  fields: Record<string, string> = {};
  ids = new Map<string, string>();

  constructor(private readonly client: SilogWebClient, page: WebResponse) {
    this.load(page);
  }

  load(page: WebResponse): void {
    this.url = page.url;
    this.html = page.text;
    const f = formFields(page.text);
    this.action = new URL(f.action ?? page.url, page.url).href;
    this.fields = f.data;
    this.ids = new Map();
    const $ = cheerio.load(page.text);
    $('[id][name]').each((_, el) => { const a = (el as { attribs: Record<string, string> }).attribs; this.ids.set((a.id as string).toLowerCase(), a.name as string); });
  }

  /** Postback (envío del formulario). SOLO se usa para la búsqueda de solo lectura; el diagnóstico nunca lo usa con Grabar. */
  async postback(target: string, extra: Record<string, string> = {}): Promise<WebResponse> {
    const page = await this.client.request(this.action, { method: 'POST', form: { ...this.fields, PRADO_POSTBACK_TARGET: target, ...extra } });
    this.load(page);
    return page;
  }

  /** Callback PRADO genérico (TEventTriggeredCallback); devuelve el texto de respuesta y los campos actualizados. */
  async callback(target: string): Promise<{ text: string; applied: string[] }> {
    const res = await this.client.request(this.action, { method: 'POST', form: { ...this.fields, PRADO_CALLBACK_TARGET: target, PRADO_CALLBACK_PARAMETER: 'null' } });
    return { text: res.text, applied: this.applyCallback(res.text) };
  }

  applyCallback(text: string): string[] {
    const applied: string[] = [];
    const ps = PAGESTATE_RE.exec(text);
    if (ps) this.fields.PRADO_PAGESTATE = ps[1] as string;
    const m = ACTIONS_RE.exec(text);
    if (!m) return applied;
    let actions: unknown[] = [];
    try { actions = JSON.parse(m[1] as string) as unknown[]; } catch { return applied; }
    for (const a of actions) {
      const set = (a as Record<string, unknown[] | undefined> | null)?.['Prado.Element.setValue'];
      if (!set) continue;
      const name = this.ids.get(String(set[0]).toLowerCase());
      if (name && name in this.fields) { this.fields[name] = String(set[1]); applied.push(name); }
    }
    return applied;
  }

  /** Sugerencias de CAutoComplete (callback de lectura). */
  async suggest(name: string, text: string): Promise<{ attrs: Record<string, string>; cells: string[] }[]> {
    this.fields[name] = text;
    const res = await this.client.request(this.action, {
      method: 'POST',
      form: { ...this.fields, PRADO_CALLBACK_TARGET: name, PRADO_POSTBACK_TARGET: name, PRADO_CALLBACK_PARAMETER: JSON.stringify([text, 0, '__CAutoComplete_onSuggest__']) },
    });
    this.applyCallback(res.text);
    const $ = cheerio.load(res.text);
    return $('li[title="false"]').toArray().map((li) => {
      const { title: _t, ...attrs } = (li as { attribs: Record<string, string> }).attribs;
      return { attrs, cells: $(li).find('td').toArray().map((td) => $(td).text().replace(/\s+/g, ' ').trim()) };
    });
  }

  /** Copia los atributos de una sugerencia a los campos (como haría el navegador). */
  select(result: { attrs: Record<string, string> }): void {
    for (const [attr, value] of Object.entries(result.attrs)) {
      const isHidden = attr.endsWith('_idhidden');
      const base = this.ids.get(isHidden ? attr.slice(0, -'_idhidden'.length) : attr);
      const name = isHidden && base ? `${base}$IDHidden` : base;
      if (name && name in this.fields) this.fields[name] = value;
    }
  }
}
