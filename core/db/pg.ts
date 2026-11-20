import pg from 'pg';
import type { Db, Queryable } from './types.js';

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const wrap = (q: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query(sql, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
