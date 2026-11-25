import type { BusinessKeyStrategy } from './businessKey.js';

export interface AppConfig {
  authMode: 'demo' | 'supabase';
  mailSource: 'mock' | 'graph';
  storageDriver: 'fs' | 'supabase' | 'db';
  databaseUrl: string | null;
  dataDir: string;
  port: number;
  mail: {
    mailbox: string;
    allowedSender: string;
    allowedForwarders: string[];
    subjectPattern: string;
    requireDmarcPass: boolean;
    businessKeyStrategy: BusinessKeyStrategy;
  };
  graph: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    certThumbprint: string;
    certPrivateKey: string;
    certPrivateKeyPath: string;
  };
  supabase: { url: string; anonKey: string; serviceRoleKey: string; jwtSecret: string };
  demoJwtSecret: string;
  filesSigningSecret: string;
}

type Env = Record<string, string | undefined>;

const bool = (v: string | undefined, d: boolean): boolean => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));
const str = (v: string | undefined, d = ''): string => (v === undefined || v === '' ? d : v);

export function loadConfig(env: Env = process.env): AppConfig {
  // Seguro por defecto: el modo demo exige AUTH_MODE=demo explícito y nunca corre en producción de Vercel.
  const authMode = env.AUTH_MODE === 'demo' ? 'demo' : 'supabase';
  if (authMode === 'demo' && env.VERCEL_ENV === 'production') {
    throw new Error('AUTH_MODE=demo no se permite en producción');
  }
  const strategy = env.BUSINESS_KEY_STRATEGY === 'transport_expense' ? 'transport_expense' : 'transport_number';
  return {
    authMode,
    mailSource: env.MAIL_SOURCE === 'graph' ? 'graph' : 'mock',
    storageDriver: env.STORAGE_DRIVER === 'supabase' ? 'supabase' : env.STORAGE_DRIVER === 'db' ? 'db' : 'fs',
    databaseUrl: str(env.DATABASE_URL) || null,
    dataDir: str(env.DATA_DIR, '.data'),
    port: Number(str(env.PORT, '3000')),
    mail: {
      mailbox: str(env.MAIL_MAILBOX, 'autorizaciones-terpel@empresa.example'),
      allowedSender: str(env.MAIL_ALLOWED_SENDER, 'flota@informacion.terpel.com'),
      allowedForwarders: str(env.MAIL_ALLOWED_FORWARDERS).split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
      subjectPattern: str(env.MAIL_SUBJECT_PATTERN, 'AUTORIZACION PAGO TERPEL - Facturacion de servicio'),
      requireDmarcPass: bool(env.MAIL_REQUIRE_DMARC_PASS, false),
      businessKeyStrategy: strategy,
    },
    graph: {
      tenantId: str(env.GRAPH_TENANT_ID),
      clientId: str(env.GRAPH_CLIENT_ID),
      clientSecret: str(env.GRAPH_CLIENT_SECRET),
      certThumbprint: str(env.GRAPH_CLIENT_CERT_THUMBPRINT),
      certPrivateKey: str(env.GRAPH_CLIENT_CERT_PRIVATE_KEY),
      certPrivateKeyPath: str(env.GRAPH_CLIENT_CERT_PRIVATE_KEY_PATH),
    },
    supabase: {
      url: str(env.SUPABASE_URL),
      anonKey: str(env.SUPABASE_ANON_KEY),
      serviceRoleKey: str(env.SUPABASE_SERVICE_ROLE_KEY),
      jwtSecret: str(env.SUPABASE_JWT_SECRET),
    },
    demoJwtSecret: str(env.DEMO_JWT_SECRET),
    filesSigningSecret: str(env.FILES_SIGNING_SECRET),
  };
}
