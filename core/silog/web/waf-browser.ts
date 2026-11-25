// Chromium headless SOLO para obtener las cookies aws-waf*. Lo importan únicamente api/silog-waf.ts y el solver local
// (WAF_CHROME_PATH), nunca la función principal, para no inflar su tamaño.
import puppeteer from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';
import { SilogWebError } from './errors.js';
import type { WafSolver } from './waf.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export async function launchBrowser(): Promise<Browser> {
  const local = process.env.WAF_CHROME_PATH;
  if (local && !process.env.VERCEL) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    return puppeteer.launch({
      executablePath: local,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(proxy ? [`--proxy-server=${proxy}`, '--ignore-certificate-errors'] : [])],
    });
  }
  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true, args: chromium.args });
}

export async function solveWafWithBrowser(loginUrl: string, waitMs = 30_000): Promise<Record<string, string>> {
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: waitMs }).catch(() => undefined);
    const limit = Date.now() + waitMs;
    let cookies: { name: string; value: string }[] = [];
    while (Date.now() < limit) {
      cookies = await page.cookies();
      if (cookies.some((c) => c.name === 'aws-waf-token')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const waf = cookies.filter((c) => c.name.toLowerCase().startsWith('aws-waf'));
    if (!waf.some((c) => c.name === 'aws-waf-token')) throw new SilogWebError('WEB_WAF_FAILED', `El navegador no obtuvo el token del WAF en ${waitMs / 1000}s`);
    return Object.fromEntries(waf.map((c) => [c.name, c.value]));
  } catch (e) {
    if (e instanceof SilogWebError) throw e;
    throw new SilogWebError('WEB_WAF_FAILED', 'No se pudo iniciar el navegador para el reto del WAF');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export class LocalWafSolver implements WafSolver {
  solve(loginUrl: string): Promise<Record<string, string>> {
    return solveWafWithBrowser(loginUrl);
  }
}
