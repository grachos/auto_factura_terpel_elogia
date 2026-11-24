import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDemoVerifier, createSupabaseVerifier, seedDemoUsers } from './auth.js';
import type { AuthVerifier } from './auth.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/types.js';
import { createPgDb } from './db/pg.js';
import { GraphMailSource, createMsalTokenProvider } from './mail/graph.js';
import { MockMailSource } from './mail/mock.js';
import type { MailSource } from './mail/types.js';
import { FsStorage } from './storage/fs.js';
import { DbStorage } from './storage/db.js';
import { SupabaseStorage } from './storage/supabase.js';
import type { StorageAdapter } from './storage/types.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  mail: MailSource;
  storage: StorageAdapter;
  auth: AuthVerifier;
}

export async function ensureMailConfig(db: Db, config: AppConfig): Promise<void> {
  const m = config.mail;
  await db.query(
    `insert into mail_configs (mailbox, allowed_sender, subject_pattern, require_dmarc_pass, business_key_strategy)
     values ($1,$2,$3,$4,$5) on conflict (mailbox) do nothing`,
    [m.mailbox, m.allowedSender, m.subjectPattern, m.requireDmarcPass, m.businessKeyStrategy],
  );
}

async function buildMail(config: AppConfig): Promise<MailSource> {
  if (config.mailSource === 'graph') {
    const g = config.graph;
    if (!g.tenantId || !g.clientId) throw new Error('Faltan GRAPH_TENANT_ID / GRAPH_CLIENT_ID para MAIL_SOURCE=graph');
    const tokenProvider = await createMsalTokenProvider({
      tenantId: g.tenantId,
      clientId: g.clientId,
      clientSecret: g.clientSecret || undefined,
      certThumbprint: g.certThumbprint || undefined,
      certPrivateKey: g.certPrivateKey || undefined,
      certPrivateKeyPath: g.certPrivateKeyPath || undefined,
    });
    return new GraphMailSource({ tokenProvider });
  }
  // Datos ficticios: se cargan bajo demanda para no empaquetar fixtures en producción real con Graph.
  const { buildFixtures } = await import('../fixtures/messages.js');
  return new MockMailSource(buildFixtures().all, { pageSize: 4, throttleOncePages: [1], throttleRetryAfterMs: 300 });
}

/** Construye dependencias según variables de entorno. Sin DATABASE_URL usa PGlite embebido (demo/local). */
/** Error de arranque con la etapa que falló y un código técnico sin datos sensibles. */
export class StartupError extends Error {
  constructor(
    readonly stage: string,
    readonly detailCode: string,
  ) {
    super(`Fallo de arranque en ${stage} (${detailCode})`);
  }
}

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: unknown; name?: unknown; message?: unknown };
    const code = typeof err.code === 'string' ? err.code : typeof err.name === 'string' ? err.name : 'UNKNOWN';
    // Mensaje truncado y sin URLs/credenciales para el log del servidor.
    const msg = typeof err.message === 'string' ? err.message.replace(/\S+:\/\/\S+/g, '<url>').slice(0, 160) : '';
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: 'startup_failed', stage: name, code, msg }));
    throw new StartupError(name, code);
  }
}

export async function createContext(env: Record<string, string | undefined> = process.env): Promise<AppContext> {
  const config = loadConfig(env);
  let db: Db;
  if (config.databaseUrl) {
    db = createPgDb(config.databaseUrl);
  } else {
    const { createPgliteDb } = await import('./db/pglite.js');
    const dir = resolve(config.dataDir, 'pglite');
    mkdirSync(dir, { recursive: true });
    db = await createPgliteDb(env.PGLITE_MEMORY === '1' ? undefined : dir);
  }
  await stage('db', () => ensureMailConfig(db, config));

  let storage: StorageAdapter;
  if (config.storageDriver === 'supabase') {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    storage = new SupabaseStorage(config.supabase.url, config.supabase.serviceRoleKey);
  } else if (config.storageDriver === 'db') {
    if (!config.filesSigningSecret) throw new Error('Falta FILES_SIGNING_SECRET');
    storage = new DbStorage(db, config.filesSigningSecret);
  } else {
    const root = join(resolve(config.dataDir), 'storage', 'exports');
    mkdirSync(root, { recursive: true });
    storage = new FsStorage(root, config.demoJwtSecret || randomBytes(32).toString('hex'));
  }

  let auth: AuthVerifier;
  if (config.authMode === 'demo') {
    await seedDemoUsers(db);
    auth = createDemoVerifier(config.demoJwtSecret);
  } else {
    auth = createSupabaseVerifier({ url: config.supabase.url, jwtSecret: config.supabase.jwtSecret, anonKey: config.supabase.anonKey });
  }
  const mail = await stage('mail', () => buildMail(config));
  return { config, db, mail, storage, auth };
}
