export type WebErrorCode =
  | 'WEB_LOGIN_PASSWORD_CHANGE_REQUIRED'
  | 'WEB_LOGIN_2FA_NOT_SUPPORTED'
  | 'WEB_LOGIN_REJECTED'
  | 'WEB_COST_CENTER_FAILED'
  | 'WEB_WAF_FAILED'
  | 'WEB_UNREACHABLE'
  | 'WEB_HTTP_ERROR'
  | 'WEB_REDIRECT_BLOCKED'
  | 'WEB_BAD_PAGE'
  | 'WEB_SESSION_BUSY'
  | 'WEB_NOT_CONFIGURED';

/** Error del cliente web de Silogtran. El mensaje NUNCA incluye cookies, cuerpos ni credenciales. */
export class SilogWebError extends Error {
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'SilogWebError';
  }
}
