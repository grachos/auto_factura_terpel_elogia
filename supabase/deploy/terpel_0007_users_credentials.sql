-- Equivalente de supabase/migrations/0007 para el esquema terpel (Supabase compartido).
-- Estas tablas NO tienen permisos para anon/authenticated: solo el backend (propietario) las usa.

alter table terpel.user_roles drop constraint if exists user_roles_role_check;
alter table terpel.user_roles add constraint user_roles_role_check
  check (role in ('operator', 'admin', 'viewer', 'facturacion'));

create table terpel.app_users (
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

create table terpel.silog_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references terpel.app_users (id) on delete cascade,
  purpose text unique check (purpose in ('adjust', 'invoice')),
  silog_user text not null,
  password_enc text not null,
  updated_by text,
  updated_at timestamptz not null default now(),
  last_test_at timestamptz,
  last_test_ok boolean,
  check ((user_id is null) <> (purpose is null))
);

create table terpel.login_attempts (
  key text primary key,
  window_start timestamptz not null default now(),
  fail_count integer not null default 0,
  blocked_until timestamptz
);

alter table terpel.app_users enable row level security;
alter table terpel.silog_credentials enable row level security;
alter table terpel.login_attempts enable row level security;
revoke all on terpel.app_users, terpel.silog_credentials, terpel.login_attempts from anon, authenticated;

-- apply_migration crea los objetos como "postgres": pasarlos al rol dueño que usa el backend.
alter table terpel.app_users owner to terpel_app;
alter table terpel.silog_credentials owner to terpel_app;
alter table terpel.login_attempts owner to terpel_app;
