import { createHmac, timingSafeEqual } from 'node:crypto';
import { SilogWebError } from './errors.js';

/** Resuelve el reto AWS WAF y devuelve SOLO las cookies `aws-waf*`. */
export interface WafSolver {
  solve(loginUrl: string): Promise<Record<string, string>>;
}

const MAX_SKEW_MS = 60_000;

function key(secret: string): Buffer {
  return createHmac('sha256', 'waf-solver').update(secret).digest();
}

export function signWafRequest(secret: string, timestamp: number): string {
  return createHmac('sha256', key(secret)).update(String(timestamp)).digest('hex');
}

/** La función del WAF exige HMAC (derivado de APP_SESSION_SECRET) sobre una marca de tiempo reciente. Nunca es pública. */
export function verifyWafRequest(secret: string, timestamp: string | undefined, signature: string | undefined, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !timestamp || !signature || !/^\d{10,16}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(signWafRequest(secret, Number(timestamp)), 'hex');
  let got: Buffer;
  try {
    got = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Llama a la función separada `api/silog-waf` (Chromium) y recibe las cookies aws-waf*. */
export class HttpWafSolver implements WafSolver {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 65_000,
  ) {}

  async solve(loginUrl: string): Promise<Record<string, string>> {
    const ts = Date.now();
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-waf-timestamp': String(ts), 'x-waf-signature': signWafRequest(this.secret, ts) },
        body: JSON.stringify({ url: loginUrl }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SilogWebError('WEB_WAF_FAILED', 'No se pudo contactar a la función que resuelve el reto del WAF');
    }
    type WafJson = { ok?: boolean; cookies?: Record<string, string>; code?: string };
    let json = null as WafJson | null;
    try {
      json = (await res.json()) as WafJson;
    } catch {
      /* respuesta no JSON */
    }
    if (!res.ok || !json?.ok || !json.cookies || Object.keys(json.cookies).length === 0) {
      throw new SilogWebError('WEB_WAF_FAILED', `La función del WAF no obtuvo el token (HTTP ${res.status}${json?.code ? `, ${json.code}` : ''})`);
    }
    return json.cookies;
  }
}
