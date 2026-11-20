// Aplica supabase/migrations a un PostgreSQL plano (DATABASE_URL). En Supabase use `supabase db push`.
import { createPgDb } from '../core/db/pg.js';
import { migrationsDir, runMigrations } from '../core/db/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Defina DATABASE_URL. Nota: las migraciones usan auth.users, storage.buckets y roles de Supabase;');
  console.error('en PostgreSQL plano debe aplicar antes supabase/tests/shim.sql. En Supabase use `supabase db push`.');
  process.exit(2);
}
const db = createPgDb(url);
runMigrations(db, migrationsDir())
  .then((applied) => console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Sin migraciones pendientes'))
  .finally(() => db.close());
