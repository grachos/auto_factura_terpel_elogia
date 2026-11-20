import { readFileSync } from 'node:fs';
import type { FetchPageParams, MailMessage, MailPage, MailSource } from './types.js';
import { CursorExpiredError, MailSourceError, ThrottledError } from './types.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_HOST = 'graph.microsoft.com';
const SELECT =
  'id,internetMessageId,conversationId,subject,from,sender,receivedDateTime,body,internetMessageHeaders';

export type TokenProvider = () => Promise<string>;
export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface GraphMailOptions {
  tokenProvider: TokenProvider;
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  maxAttempts?: number;
  /** Presupuesto total de espera por llamada; si se excede se lanza ThrottledError. */
  maxWaitMs?: number;
}

interface GraphMessage {
  id?: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  sender?: { emailAddress?: { address?: string } };
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name?: string; value?: string }[];
}

export class GraphMailSource implements MailSource {
  readonly kind = 'graph';
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pageSize: number;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;

  constructor(private readonly opts: GraphMailOptions) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pageSize = opts.pageSize ?? 50;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxWaitMs = opts.maxWaitMs ?? 8000;
  }

  buildFirstUrl(p: Pick<FetchPageParams, 'mailbox' | 'utcStart' | 'utcEndExclusive'>): string {
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const filter = `receivedDateTime ge ${iso(p.utcStart)} and receivedDateTime lt ${iso(p.utcEndExclusive)}`;
    return (
      `${GRAPH_BASE}/users/${encodeURIComponent(p.mailbox)}/messages` +
      `?$filter=${encodeURIComponent(filter)}` +
      `&$orderby=${encodeURIComponent('receivedDateTime asc')}` +
      `&$select=${SELECT}&$top=${this.pageSize}`
    );
  }

  async fetchPage(params: FetchPageParams): Promise<MailPage> {
    let url: string;
    if (params.cursor) {
      // Nunca se envía el token a un host distinto de Graph.
      let host = '';
      try {
        host = new URL(params.cursor).host;
      } catch {
        throw new CursorExpiredError();
      }
      if (host !== GRAPH_HOST) throw new CursorExpiredError();
      url = params.cursor;
    } else {
      url = this.buildFirstUrl(params);
    }

    const body = (await this.getWithRetry(url, params.cursor !== null)) as { value?: GraphMessage[]; '@odata.nextLink'?: string };
    const messages = (body.value ?? []).map(toMailMessage);
    return { messages, nextCursor: body['@odata.nextLink'] ?? null };
  }

  private async getWithRetry(url: string, isCursor: boolean): Promise<unknown> {
    let waited = 0;
    let lastWait = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const token = await this.opts.tokenProvider();
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"', Accept: 'application/json' },
      });
      if (res.status === 200) return res.json();
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        const ra = Number(res.headers.get('Retry-After'));
        const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(500 * 2 ** (attempt - 1), 4000);
        lastWait = waitMs;
        if (attempt === this.maxAttempts || waited + waitMs > this.maxWaitMs) throw new ThrottledError(waitMs);
        waited += waitMs;
        await this.sleep(waitMs);
        continue;
      }
      const code = await safeErrorCode(res);
      if (res.status === 410 || (isCursor && (res.status === 400 || res.status === 404))) {
        throw new CursorExpiredError();
      }
      throw new MailSourceError(code ?? `HTTP_${res.status}`, res.status);
    }
    throw new ThrottledError(lastWait || 1000);
  }
}

async function safeErrorCode(res: { json(): Promise<unknown> }): Promise<string | null> {
  try {
    const b = (await res.json()) as { error?: { code?: unknown } };
    return typeof b?.error?.code === 'string' ? b.error.code : null;
  } catch {
    return null;
  }
}

function toMailMessage(m: GraphMessage): MailMessage {
  const auth = (m.internetMessageHeaders ?? []).find((h) => (h.name ?? '').toLowerCase() === 'authentication-results');
  return {
    id: m.id ?? '',
    internetMessageId: m.internetMessageId ?? '',
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? '',
    from: m.from?.emailAddress?.address ?? '',
    sender: m.sender?.emailAddress?.address ?? '',
    receivedDateTime: m.receivedDateTime ?? '',
    bodyContentType: (m.body?.contentType ?? 'html').toLowerCase() === 'text' ? 'text' : 'html',
    bodyContent: m.body?.content ?? '',
    authenticationResults: auth?.value ?? null,
  };
}

export interface GraphAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  certThumbprint?: string;
  certPrivateKey?: string;
  certPrivateKeyPath?: string;
}

/** Proveedor de tokens con MSAL (client credentials). Certificado en producción; secreto solo para pruebas. */
export async function createMsalTokenProvider(cfg: GraphAuthConfig): Promise<TokenProvider> {
  const { ConfidentialClientApplication } = await import('@azure/msal-node');
  let clientCertificate: { thumbprint: string; privateKey: string } | undefined;
  if (cfg.certThumbprint && (cfg.certPrivateKey || cfg.certPrivateKeyPath)) {
    const pem = cfg.certPrivateKey
      ? cfg.certPrivateKey.replace(/\\n/g, '\n')
      : readFileSync(cfg.certPrivateKeyPath as string, 'utf8');
    clientCertificate = { thumbprint: cfg.certThumbprint, privateKey: pem };
  }
  if (!clientCertificate && !cfg.clientSecret) {
    throw new MailSourceError('GRAPH_CREDENTIALS_MISSING');
  }
  const app = new ConfidentialClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      ...(clientCertificate ? { clientCertificate } : { clientSecret: cfg.clientSecret as string }),
    },
  });
  return async () => {
    const r = await app.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
    if (!r?.accessToken) throw new MailSourceError('GRAPH_TOKEN_UNAVAILABLE');
    return r.accessToken;
  };
}
