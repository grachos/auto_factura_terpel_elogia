import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../core/logger.js';
import { solveWafWithBrowser } from '../core/silog/web/waf-browser.js';
import { verifyWafRequest } from '../core/silog/web/waf.js';

// Función SEPARADA (Chromium): solo obtiene las cookies aws-waf* y las devuelve a la función principal.
// Protegida con HMAC (APP_SESSION_SECRET) sobre una marca de tiempo reciente; nunca es pública.
export const config = { maxDuration: 60 };

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const h = (n: string): string | undefined => {
    const v = req.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  if (req.method !== 'POST' || !verifyWafRequest(process.env.APP_SESSION_SECRET ?? '', h('x-waf-timestamp'), h('x-waf-signature'))) {
    json(res, 403, { ok: false, code: 'FORBIDDEN' });
    return;
  }
  const base = (process.env.SILOG_WEB_BASE_URL || (process.env.SILOG_BASE_URL ? new URL(process.env.SILOG_BASE_URL).origin : '')).replace(/\/?$/, '/');
  if (base === '/') {
    json(res, 503, { ok: false, code: 'NOT_CONFIGURED' });
    return;
  }
  const started = Date.now();
  try {
    const cookies = await solveWafWithBrowser(new URL('index.php?page=LoginPage', base).href, 40_000);
    json(res, 200, { ok: true, cookies, ms: Date.now() - started });
  } catch (e) {
    log('silog_waf.failed', { code: (e as { code?: string }).code ?? 'ERROR', ms: Date.now() - started });
    json(res, 502, { ok: false, code: (e as { code?: string }).code ?? 'WAF_FAILED' });
  }
}
