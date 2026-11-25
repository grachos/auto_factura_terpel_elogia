// Cliente HTTP del sitio web de Silogtran (PRADO/PHP, renderizado en servidor). Portado del enfoque de
// grachos/auto_despachos_silogtran: login por formulario + centro de costo, cookie jar exportable, cola serializada
// (PRADO guarda estado por sesión) y reto AWS WAF resuelto por un WafSolver. NUNCA registra cuerpos, cookies ni claves.
import * as cheerio from 'cheerio';
import { SilogWebError } from './errors.js';
import type { WafSolver } from './waf.js';

export const LOGIN_PAGE = 'index.php?page=LoginPage';
const HOME_CHECK_PAGE = 'index.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const P = 'ctl0$MainModule$';

export const isLoginPage = (html: string): boolean => html.includes(`${P}BtnIngresar`);

export function decode(buf: Buffer, contentType = ''): string {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      /* continúa */
    }
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8; // Silogtran suele servir latin1 sin declararlo
}

/** Campos que un navegador enviaría en un postback PRADO (sin botones). */
export function formFields(html: string): { $: cheerio.CheerioAPI; action: string | undefined; data: Record<string, string> } {
  const $ = cheerio.load(html);
  const form = $('form').first();
  if (!form.length) throw new SilogWebError('WEB_BAD_PAGE', 'La página no contiene un formulario');
  const data: Record<string, string> = {};
  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name || $el.is('[disabled]')) return;
    const type = ($el.attr('type') ?? '').toLowerCase();
    const tag = (el as { tagName?: string }).tagName;
    if (tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && !$el.is('[checked]')) return;
    if (tag === 'select') {
      const sel = $el.find('option[selected]').first();
      const op = sel.length ? sel : $el.find('option').first();
      data[name] = op.attr('value') ?? op.text();
    } else if (tag === 'textarea') data[name] = $el.text();
    else data[name] = $el.attr('value') ?? '';
  });
  return { $, action: form.attr('action'), data };
}

export interface WebResponse { status: number; url: string; text: string; headers: Headers }

export interface WebClientOptions {
  baseUrl: string;
  waf?: WafSolver | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class SilogWebClient {
  private jar = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly base: string;
  private readonly origin: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  wafSolved = false;
  costCenter: string | null = null;

  constructor(private readonly opts: WebClientOptions) {
    this.base = opts.baseUrl.replace(/\/?$/, '/');
    this.origin = new URL(this.base).origin;
    this.doFetch = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  exportCookies(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }
  importCookies(c: Record<string, string> | null | undefined): void {
    this.jar = new Map(Object.entries(c ?? {}));
  }

  /** Serializa las peticiones: PRADO guarda estado por sesión. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  isLoggedIn(): Promise<boolean> {
    return this.enqueue(async () => !isLoginPage((await this.request(HOME_CHECK_PAGE)).text));
  }

  private storeCookies(res: Response): void {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const i = (pair as string).indexOf('=');
      const name = (pair as string).slice(0, i).trim();
      const value = (pair as string).slice(i + 1).trim();
      const del = value === 'deleted' || attrs.some((a) => /max-age=0\b/i.test(a.trim()));
      if (del) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(path: string, o: { method?: string; form?: Record<string, string> | null; timeoutMs?: number } = {}): Promise<WebResponse> {
    let method = o.method ?? 'GET';
    let form = o.form ?? null;
    let url = new URL(path, this.base);
    let wafTries = 0;
    for (let hops = 0; hops < 10; hops += 1) {
      if (url.origin !== this.origin) throw new SilogWebError('WEB_REDIRECT_BLOCKED', 'Redirección fuera de Silogtran bloqueada');
      const headers: Record<string, string> = { 'user-agent': UA, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual',
          signal: AbortSignal.timeout(o.timeoutMs ?? this.timeoutMs),
        });
      } catch {
        throw new SilogWebError('WEB_UNREACHABLE', 'No se pudo conectar con Silogtran (sitio web)');
      }
      this.storeCookies(res);
      if (res.headers.get('x-amzn-waf-action') === 'challenge') {
        if (wafTries >= 1) throw new SilogWebError('WEB_WAF_FAILED', 'El WAF sigue bloqueando después del reto');
        wafTries += 1;
        await this.solveWaf();
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        url = new URL(res.headers.get('location') ?? '/', url);
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; form = null; }
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status >= 400) throw new SilogWebError('WEB_HTTP_ERROR', `Silogtran respondió HTTP ${res.status}`);
      return { status: res.status, url: url.href, text: decode(body, res.headers.get('content-type') ?? ''), headers: res.headers };
    }
    throw new SilogWebError('WEB_HTTP_ERROR', 'Demasiadas redirecciones');
  }

  private async solveWaf(): Promise<void> {
    if (!this.opts.waf) throw new SilogWebError('WEB_WAF_FAILED', 'El WAF pide un reto y no hay resolvedor configurado (WAF_SOLVER_URL o WAF_CHROME_PATH)');
    const cookies = await this.opts.waf.solve(new URL(LOGIN_PAGE, this.base).href);
    for (const [k, v] of Object.entries(cookies)) if (k.toLowerCase().startsWith('aws-waf')) this.jar.set(k, v);
    this.wafSolved = true;
  }

  /** Callback PRADO de un botón activo; sigue X-PRADO-REDIRECT. */
  async pradoCallback(url: string, data: Record<string, string>, target: string): Promise<WebResponse> {
    const cb = await this.request(url, { method: 'POST', form: { ...data, PRADO_CALLBACK_TARGET: target, PRADO_CALLBACK_PARAMETER: 'null' } });
    const dest = cb.headers.get('x-prado-redirect') ?? /<!--X-PRADO-REDIRECT-->\s*"?([^"<]+)"?\s*<!--/.exec(cb.text)?.[1];
    return dest ? this.request(new URL(dest.replace(/\\\//g, '/'), url).href) : cb;
  }

  /** Login por formulario + centro de costo (siempre el primero). Errores claros; sin reintentos aquí. */
  login(user: string, password: string): Promise<void> {
    return this.enqueue(async () => {
      this.jar = new Map([...this.jar].filter(([k]) => k.toLowerCase().startsWith('aws-waf')));
      const pg = await this.request(LOGIN_PAGE);
      const f = formFields(pg.text);
      Object.assign(f.data, { [`${P}Usuario`]: user, [`${P}Clave`]: password, PRADO_POSTBACK_TARGET: `${P}BtnIngresar`, [`${P}BtnIngresar`]: 'Iniciar Sesion' });
      let r = await this.request(new URL(f.action ?? LOGIN_PAGE, pg.url).href, { method: 'POST', form: f.data });
      for (let step = 0; step < 3; step += 1) {
        if (r.text.includes(`${P}centrocosto`)) { r = await this.costCenterStep(r); continue; }
        if (r.text.includes(`${P}verification_code`)) throw new SilogWebError('WEB_LOGIN_2FA_NOT_SUPPORTED', 'La cuenta tiene verificación en dos pasos: no está soportada', 409);
        if (r.text.includes(`${P}NuevaClave`)) throw new SilogWebError('WEB_LOGIN_PASSWORD_CHANGE_REQUIRED', 'Silogtran exige cambiar la contraseña de esta cuenta antes de poder usarla', 409);
        if (isLoginPage(r.text)) throw new SilogWebError('WEB_LOGIN_REJECTED', 'Silogtran rechazó el inicio de sesión web (usuario o contraseña)', 401);
        break;
      }
      const check = await this.request(HOME_CHECK_PAGE);
      if (isLoginPage(check.text)) throw new SilogWebError('WEB_LOGIN_REJECTED', 'Silogtran rechazó el inicio de sesión web', 401);
    });
  }

  private async costCenterStep(r: WebResponse): Promise<WebResponse> {
    const f = formFields(r.text);
    const name = `${P}centrocosto`;
    const field = f.$(`[name="${name}"]`).first();
    if (field.is('select')) {
      const opt = field.find('option').toArray()
        .map((o) => ({ value: f.$(o).attr('value') ?? f.$(o).text(), text: f.$(o).text().trim() }))
        .find((o) => o.value !== '' && !/seleccione/i.test(o.text));
      if (!opt) throw new SilogWebError('WEB_COST_CENTER_FAILED', 'El usuario no tiene centros de costo disponibles');
      f.data[name] = opt.value;
      this.costCenter = opt.text;
    } else if (!f.data[name]) throw new SilogWebError('WEB_COST_CENTER_FAILED', 'No se pudo elegir el centro de costo automáticamente');
    const btn = `${P}BtnContinuar`;
    const url = new URL(f.action ?? LOGIN_PAGE, r.url).href;
    if (/TActive\w*Button\(\{'ID':'ctl0_MainModule_BtnContinuar'/.test(r.text)) return this.pradoCallback(url, f.data, btn);
    f.data.PRADO_POSTBACK_TARGET = btn;
    f.data[btn] = f.$('#ctl0_MainModule_BtnContinuar').attr('value') ?? 'Continuar';
    return this.request(url, { method: 'POST', form: f.data });
  }
}
