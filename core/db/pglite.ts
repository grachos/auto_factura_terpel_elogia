import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable } from './types.js';
import { migrationsDir, runMigrations } from './migrate.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SHIM = join(fileURLToPath(new URL('../../supabase/tests/shim.sql', import.meta.url)));

/**
 * PGlite (Postgres embebido en WASM) para pruebas y modo demo.
 * Aplica un shim mínimo de objetos Supabase y luego las migraciones SQL reales.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  const wrap = (q: { query: PGlite['query'] }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query<T>(sql, params);
      return { rows: r.rows, rowCount: r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0) };
    },
  });
  // Serializa: PGlite es de una sola conexión.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const db: Db = {
    query: (sql, params) => serial(() => wrap(lite).query(sql, params)),
    exec: (sql) => serial(async () => void (await lite.exec(sql))),
    transaction: (fn) =>
      serial(() =>
        lite.transaction(async (tx) => fn(wrap(tx as unknown as { query: PGlite['query'] }))),
      ),
    close: () => lite.close(),
  };
  const hasShim = await lite.query<{ ok: boolean }>(`select to_regnamespace('auth') is not null as ok`);
  if (!hasShim.rows[0]?.ok) await lite.exec(readFileSync(SHIM, 'utf8'));
  await runMigrations(db, migrationsDir());
  return db;
}
