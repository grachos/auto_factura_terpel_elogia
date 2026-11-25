-- Incremento 1: usuarios de la app (ingreso con usuario de Silogtran), roles, credenciales cifradas e intentos de ingreso.
-- Estas tablas NO tienen permisos para anon/authenticated: solo el backend (propietario) las usa.

alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role in ('operator', 'admin', 'viewer', 'facturacion'));

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  silog_user text not null unique check (silog_user = lower(silog_user) and length(silog_user) between 1 and 120),
  display_name text,
  company text,
  role text not null check (role in ('admin', 'facturacion', 'operator', 'viewer')),
  active boolean not null default true,
  session_version integer not null default 1,
  last_login_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.silog_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.app_users (id) on delete cascade,
  purpose text unique check (purpose in ('adjust', 'invoice')),
  silog_user text not null,
  password_enc text not null,
  updated_by text,
  updated_at timestamptz not null default now(),
  last_test_at timestamptz,
  last_test_ok boolean,
  check ((user_id is null) <> (purpose is null))
);

create table public.login_attempts (
  key text primary key,
  window_start timestamptz not null default now(),
  fail_count integer not null default 0,
  blocked_until timestamptz
);

alter table public.app_users enable row level security;
alter table public.silog_credentials enable row level security;
alter table public.login_attempts enable row level security;
revoke all on public.app_users, public.silog_credentials, public.login_attempts from anon, authenticated;
