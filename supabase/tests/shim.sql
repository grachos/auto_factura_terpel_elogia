-- Solo para PGlite (pruebas y modo demo): imita los objetos de Supabase que
-- usan las migraciones reales. NO se aplica sobre un proyecto Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')
  )::uuid
$$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false);
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
