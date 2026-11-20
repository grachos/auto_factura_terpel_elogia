export interface MailMessage {
  /** Id inmutable de Graph (Prefer: IdType="ImmutableId"). */
  id: string;
  internetMessageId: string;
  conversationId: string | null;
  subject: string;
  from: string;
  sender: string;
  /** ISO 8601 UTC */
  receivedDateTime: string;
  bodyContentType: 'html' | 'text';
  bodyContent: string;
  /** Valor del encabezado Authentication-Results, si existe. */
  authenticationResults: string | null;
}

export interface FetchPageParams {
  mailbox: string;
  utcStart: Date;
  utcEndExclusive: Date;
  /** nextLink / cursor devuelto por la página anterior (null para la primera). */
  cursor: string | null;
}

export interface MailPage {
  messages: MailMessage[];
  nextCursor: string | null;
}

export interface MailSource {
  readonly kind: string;
  fetchPage(params: FetchPageParams): Promise<MailPage>;
}

/** 429/503/504 persistente: el cliente debe esperar y volver a llamar al paso. */
export class ThrottledError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('El origen de correo pidió esperar antes de reintentar');
    this.name = 'ThrottledError';
  }
}

/** El nextLink expiró o no es válido: se reinicia el rango (idempotente). */
export class CursorExpiredError extends Error {
  constructor() {
    super('El cursor de paginación expiró');
    this.name = 'CursorExpiredError';
  }
}

/** Error no recuperable del origen de correo (credenciales, permisos). Solo código, sin cuerpos. */
export class MailSourceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(`Error del origen de correo: ${code}`);
    this.name = 'MailSourceError';
  }
}
