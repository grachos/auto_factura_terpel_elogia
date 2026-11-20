import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types.js';

export function migrationsDir(): string {
  return fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
}

/**
 * Aplica las migraciones SQL reales de supabase/migrations en orden.
 * En Supabase el camino oficial es `supabase db push`; este ejecutor sirve para PGlite
 * y para PostgreSQL plano (`npm run db:migrate`).
 */
export async function runMigrations(db: Db, dir: string): Promise<string[]> {
  await db.exec(`create table if not exists public.app_schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set(
    (await db.query<{ name: string }>('select name from public.app_schema_migrations')).rows.map((r) => r.name),
  );
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await db.exec(readFileSync(join(dir, file), 'utf8'));
    await db.query('insert into public.app_schema_migrations (name) values ($1)', [file]);
    applied.push(file);
  }
  return applied;
}
