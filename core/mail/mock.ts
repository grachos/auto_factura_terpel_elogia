import type { FetchPageParams, MailMessage, MailPage, MailSource } from './types.js';
import { CursorExpiredError, ThrottledError } from './types.js';

export interface MockMailOptions {
  pageSize?: number;
  /** Índices de página (0..n) que responden "429" la primera vez que se piden. */
  throttleOncePages?: number[];
  throttleRetryAfterMs?: number;
  /** Páginas que lanzan un error genérico la primera vez (simula caída de red). */
  failOncePages?: number[];
}

/** Origen de correo simulado: filtra por rango, pagina con cursor "mock:<offset>". */
export class MockMailSource implements MailSource {
  readonly kind = 'mock';
  private readonly pageSize: number;
  private readonly throttled = new Set<number>();
  private readonly failed = new Set<number>();
  public readonly requests: { cursor: string | null }[] = [];

  constructor(
    private readonly messages: MailMessage[],
    private readonly options: MockMailOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 5;
  }

  async fetchPage(params: FetchPageParams): Promise<MailPage> {
    this.requests.push({ cursor: params.cursor });
    let offset = 0;
    if (params.cursor !== null) {
      const m = /^mock:(\d+)$/.exec(params.cursor);
      if (!m) throw new CursorExpiredError();
      offset = Number(m[1]);
    }
    const pageIndex = Math.floor(offset / this.pageSize);
    if ((this.options.throttleOncePages ?? []).includes(pageIndex) && !this.throttled.has(pageIndex)) {
      this.throttled.add(pageIndex);
      throw new ThrottledError(this.options.throttleRetryAfterMs ?? 200);
    }
    if ((this.options.failOncePages ?? []).includes(pageIndex) && !this.failed.has(pageIndex)) {
      this.failed.add(pageIndex);
      throw new Error('Fallo simulado de red');
    }
    const startMs = params.utcStart.getTime();
    const endMs = params.utcEndExclusive.getTime();
    const inRange = this.messages
      .filter((m) => {
        const t = Date.parse(m.receivedDateTime);
        return t >= startMs && t < endMs;
      })
      .sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
    const slice = inRange.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize < inRange.length ? `mock:${offset + this.pageSize}` : null;
    return { messages: slice, nextCursor: next };
  }
}
