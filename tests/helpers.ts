import { createPgliteDb } from '../core/db/pglite.js';
import type { Db } from '../core/db/types.js';
import type { OrchestratorDeps } from '../core/orchestrator.js';
import type { MailSource } from '../core/mail/types.js';
import type { StorageAdapter } from '../core/storage/types.js';
import { ALLOWED_SENDER, MAILBOX, SUBJECT_PATTERN } from '../fixtures/templates.js';

export class MemoryStorage implements StorageAdapter {
  readonly kind = 'memory';
  files = new Map<string, Buffer>();
  failNextPut = 0;
  async put(path: string, data: Buffer): Promise<void> {
    if (this.failNextPut > 0) {
      this.failNextPut -= 1;
      throw new Error('fallo forzado de Storage');
    }
    this.files.set(path, data);
  }
  async get(path: string): Promise<Buffer> {
    const f = this.files.get(path);
    if (!f) throw new Error('no existe');
    return f;
  }
  async signedUrl(path: string, ttl = 300): Promise<string> {
    return `memory://${path}?ttl=${ttl}`;
  }
}

export async function newDb(config: { requireDmarc?: boolean; strategy?: string } = {}): Promise<Db> {
  const db = await createPgliteDb();
  await db.query(
    `insert into mail_configs (mailbox, allowed_sender, subject_pattern, require_dmarc_pass, business_key_strategy)
     values ($1,$2,$3,$4,$5)`,
    [MAILBOX, ALLOWED_SENDER, SUBJECT_PATTERN, config.requireDmarc ?? false, config.strategy ?? 'transport_number'],
  );
  return db;
}

export function deps(db: Db, mail: MailSource, storage: StorageAdapter, extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return { db, mail, storage, ...extra };
}

export const noSleep = async (): Promise<void> => undefined;

export async function count(db: Db, table: string, where = 'true'): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`);
  return r.rows[0]?.n ?? 0;
}
