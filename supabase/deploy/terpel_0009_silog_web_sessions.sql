-- Equivalente de supabase/migrations/0009 para el esquema terpel (Supabase compartido).
-- Sin permisos para anon/authenticated: solo el backend.
create table terpel.silog_web_sessions (
  id uuid primary key default gen_random_uuid(),
  purpose text not null unique check (purpose in ('adjust', 'invoice')),
  cookies_enc text,
  cookies_updated_at timestamptz,
  last_login_at timestamptz,
  last_error_code text,
  lock_owner text,
  lock_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table terpel.silog_web_sessions enable row level security;
revoke all on terpel.silog_web_sessions from anon, authenticated;

alter table terpel.silog_web_sessions owner to terpel_app;
