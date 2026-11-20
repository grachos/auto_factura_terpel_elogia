// Verifica el acceso a Exchange Online vía Microsoft Graph (solo GET; no cambia isRead).
// Uso: npm run graph:check            → buzón autorizado (esperado 200)
//      npm run graph:check -- --denied → segundo buzón NO autorizado (esperado 403 ErrorAccessDenied)
import { createMsalTokenProvider, GRAPH_BASE } from '../core/mail/graph.js';
import { loadConfig } from '../core/config.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const g = cfg.graph;
  const denied = process.argv.includes('--denied');
  const mailbox = denied ? (process.env.GRAPH_CHECK_DENIED_MAILBOX ?? '') : cfg.mail.mailbox;

  const missing: string[] = [];
  if (!g.tenantId) missing.push('GRAPH_TENANT_ID');
  if (!g.clientId) missing.push('GRAPH_CLIENT_ID');
  if (!g.clientSecret && !(g.certThumbprint && (g.certPrivateKey || g.certPrivateKeyPath))) {
    missing.push('GRAPH_CLIENT_SECRET (pruebas) o GRAPH_CLIENT_CERT_THUMBPRINT + GRAPH_CLIENT_CERT_PRIVATE_KEY[_PATH]');
  }
  if (!mailbox) missing.push(denied ? 'GRAPH_CHECK_DENIED_MAILBOX' : 'MAIL_MAILBOX');
  if (missing.length > 0) {
    console.error('No hay credenciales de Exchange Online configuradas. Esto es esperado hasta que TI las entregue.');
    console.error('Variables faltantes:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('Mientras tanto use MAIL_SOURCE=mock. Ver docs/guia-ti-exchange.md.');
    process.exit(2);
  }

  const tokenProvider = await createMsalTokenProvider({
    tenantId: g.tenantId,
    clientId: g.clientId,
    clientSecret: g.clientSecret || undefined,
    certThumbprint: g.certThumbprint || undefined,
    certPrivateKey: g.certPrivateKey || undefined,
    certPrivateKeyPath: g.certPrivateKeyPath || undefined,
  });
  let token: string;
  try {
    token = await tokenProvider();
  } catch {
    console.error('No se pudo obtener el token en login.microsoftonline.com (revise tenant, app, certificado/secreto y salida HTTPS).');
    process.exit(3);
  }
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages?$top=1&$select=id`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' } });
  let code = '';
  if (res.status !== 200) {
    try {
      code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? '';
    } catch {
      code = '';
    }
  }
  console.log(`Buzón ${denied ? 'NO autorizado' : 'autorizado'}: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  const expectOk = !denied;
  const pass = expectOk ? res.status === 200 : res.status === 403 && code === 'ErrorAccessDenied';
  console.log(pass ? 'RESULTADO: OK (como se esperaba)' : `RESULTADO: INESPERADO (se esperaba ${expectOk ? '200' : '403 ErrorAccessDenied'})`);
  process.exit(pass ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('Error en graph:check:', e instanceof Error ? e.message : 'desconocido');
  process.exit(1);
});
