-- Incremento 3a: sesión web reutilizable de Silogtran (cookies CIFRADAS, incl. aws-waf*) y bloqueo de login simultáneo.
-- Sin permisos para anon/authenticated: solo el backend.
create table public.silog_web_sessions (
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
alter table public.silog_web_sessions enable row level security;
revoke all on public.silog_web_sessions from anon, authenticated;
