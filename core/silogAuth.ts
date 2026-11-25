// Login por API de Silogtran (lectura: solo valida usuario y clave). Nunca se registra ni se devuelve la clave.
export type SilogLoginResult =
  | { ok: true; name: string | null; company: string | null }
  | { ok: false; reason: 'bad_credentials' | 'unavailable' };

export interface SilogAuthClient {
  readonly kind: 'api' | 'mock';
  login(user: string, password: string): Promise<SilogLoginResult>;
}

export class SilogApiAuth implements SilogAuthClient {
  readonly kind = 'api' as const;
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async login(user: string, password: string): Promise<SilogLoginResult> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}?api=servicio.Seguridad.login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ usuario_login: user, usuario_password: password }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (res.status >= 500) return { ok: false, reason: 'unavailable' };
    type LoginJson = { success?: boolean; data?: { token?: string; usuario?: { usuario_nombre?: string; empresa_nombre?: string } } };
    let json = null as LoginJson | null;
    try {
      json = (await res.json()) as LoginJson;
    } catch {
      return { ok: false, reason: res.ok ? 'unavailable' : 'bad_credentials' };
    }
    if (!res.ok || json?.success !== true || typeof json.data?.token !== 'string' || json.data.token === '') {
      return { ok: false, reason: 'bad_credentials' };
    }
    const u = json.data.usuario;
    return { ok: true, name: typeof u?.usuario_nombre === 'string' ? u.usuario_nombre : null, company: typeof u?.empresa_nombre === 'string' ? u.empresa_nombre : null };
  }
}

/** Solo pruebas/demo: cuentas sintéticas en memoria. */
export class MockSilogAuth implements SilogAuthClient {
  readonly kind = 'mock' as const;
  calls = 0;
  down = false;
  constructor(private readonly accounts: Record<string, string> = {}, private readonly anyUserPassword?: string) {}
  async login(user: string, password: string): Promise<SilogLoginResult> {
    this.calls += 1;
    if (this.down) return { ok: false, reason: 'unavailable' };
    const expected = this.accounts[user.toLowerCase()] ?? this.anyUserPassword;
    if (expected !== undefined && password === expected) return { ok: true, name: `Persona ${user}`, company: 'EMPRESA FICTICIA' };
    return { ok: false, reason: 'bad_credentials' };
  }
}
