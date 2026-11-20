-- AutoFactura Terpel - Fase 1: importar correos, Excel y persistencia.
-- Montos/cantidades numeric(18,4); identificadores text; fecha del servicio date.

create table public.mail_configs (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  allowed_sender text not null,
  subject_pattern text not null,
  require_dmarc_pass boolean not null default false,
  business_key_strategy text not null default 'transport_number'
    check (business_key_strategy in ('transport_number', 'transport_expense')),
  active boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (mailbox)
);

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  mail_config_id uuid not null references public.mail_configs (id),
  requested_by text not null,
  date_from_local date not null,
  date_to_local date not null,
  utc_start timestamptz not null,
  utc_end_exclusive timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'paused', 'completed', 'failed')),
  cursor_next_link text,
  lease_until timestamptz,
  pages_processed integer not null default 0,
  found integer not null default 0,
  imported integer not null default 0,
  duplicates integer not null default 0,
  needs_review integer not null default 0,
  ignored integer not null default 0,
  export_status text not null default 'pending'
    check (export_status in ('pending', 'ready', 'failed')),
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check (date_from_local <= date_to_local),
  check (utc_start < utc_end_exclusive)
);

-- Una sola ejecución activa por buzón (configuración de correo).
create unique index import_runs_one_active_per_mailbox
  on public.import_runs (mail_config_id)
  where status in ('pending', 'running', 'paused');

create table public.source_messages (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  graph_immutable_id text not null,
  internet_message_id text not null,
  conversation_id text,
  from_address text,
  sender_address text,
  subject text,
  received_at timestamptz not null,
  is_forward boolean not null default false,
  auth_results text,
  body_content_type text,
  body_sha256 text,
  first_run_id uuid references public.import_runs (id),
  created_at timestamptz not null default now(),
  unique (mailbox, graph_immutable_id),
  unique (mailbox, internet_message_id)
);

-- Cuerpo crudo del correo: tabla separada, sin SELECT para operadores.
create table public.source_message_bodies (
  message_id uuid primary key references public.source_messages (id) on delete cascade,
  body_raw text not null
);

create table public.run_messages (
  run_id uuid not null references public.import_runs (id) on delete cascade,
  message_id uuid not null references public.source_messages (id),
  outcome text not null
    check (outcome in ('imported', 'duplicate', 'needs_review', 'ignored_sender', 'ignored_subject', 'parse_error')),
  created_at timestamptz not null default now(),
  primary key (run_id, message_id)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_key text not null unique,
  transport_number text not null,
  current_authorization_id uuid,
  status text not null default 'imported',
  version_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.authorizations (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.source_messages (id),
  service_id uuid references public.services (id),
  version integer,
  parse_status text not null check (parse_status in ('ok', 'incomplete', 'error')),
  parser_version text not null,
  template_variant text,
  transport_number text,
  remission_number text,
  expense_number text,
  service_date date,
  service_date_raw text,
  loading_plant text,
  loading_plant_flag text,
  purchase_doc text,
  service_entry_sheet text,
  net_value numeric(18, 4),
  net_value_raw text,
  currency text,
  plate text,
  plate_normalized text,
  route text,
  transport_volume numeric(18, 4),
  transport_volume_raw text,
  transport_volume_unit text,
  unit_status text not null default 'pending_confirmation',
  rate numeric(18, 4),
  rate_raw text,
  driver_code text,
  driver_name text,
  raw_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.services
  add constraint services_current_authorization_fk
  foreign key (current_authorization_id) references public.authorizations (id);

create index authorizations_service_idx on public.authorizations (service_id);
create index run_messages_message_idx on public.run_messages (message_id);

create table public.import_issues (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.import_runs (id) on delete cascade,
  message_id uuid references public.source_messages (id),
  authorization_id uuid references public.authorizations (id),
  code text not null,
  severity text not null check (severity in ('info', 'warning', 'error')),
  field text,
  detail text,
  created_at timestamptz not null default now()
);
create index import_issues_run_idx on public.import_issues (run_id);

create table public.export_files (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.import_runs (id) on delete cascade,
  storage_path text,
  sha256 text,
  row_count integer,
  issue_count integer,
  status text not null check (status in ('ready', 'failed')),
  generated_at timestamptz not null default now()
);
create index export_files_run_idx on public.export_files (run_id);

create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('operator', 'admin', 'viewer'))
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor text,
  action text not null,
  entity text,
  entity_id text,
  data jsonb,
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: lectura para autenticados con rol; escrituras solo vía API (service_role).
-- ---------------------------------------------------------------------------
create function public.app_role() returns text
  language sql stable security definer set search_path = public
  as $$ select role from public.user_roles where user_id = auth.uid() $$;

revoke all on function public.app_role() from public;
grant execute on function public.app_role() to authenticated, service_role;

alter table public.mail_configs enable row level security;
alter table public.import_runs enable row level security;
alter table public.source_messages enable row level security;
alter table public.source_message_bodies enable row level security;
alter table public.run_messages enable row level security;
alter table public.services enable row level security;
alter table public.authorizations enable row level security;
alter table public.import_issues enable row level security;
alter table public.export_files enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_log enable row level security;

revoke all on all tables in schema public from anon, authenticated;

grant select on public.import_runs, public.source_messages, public.run_messages,
  public.services, public.authorizations, public.import_issues, public.export_files
  to authenticated;
grant select on public.mail_configs to authenticated;
grant select on public.user_roles to authenticated;
grant select on public.audit_log to authenticated;

create policy read_runs on public.import_runs for select to authenticated using (public.app_role() is not null);
create policy read_messages on public.source_messages for select to authenticated using (public.app_role() is not null);
create policy read_run_messages on public.run_messages for select to authenticated using (public.app_role() is not null);
create policy read_services on public.services for select to authenticated using (public.app_role() is not null);
create policy read_authorizations on public.authorizations for select to authenticated using (public.app_role() is not null);
create policy read_issues on public.import_issues for select to authenticated using (public.app_role() is not null);
create policy read_exports on public.export_files for select to authenticated using (public.app_role() is not null);
create policy admin_read_mail_configs on public.mail_configs for select to authenticated using (public.app_role() = 'admin');
create policy read_own_role on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy admin_read_audit on public.audit_log for select to authenticated using (public.app_role() = 'admin');
-- source_message_bodies: RLS activado, sin permisos ni políticas para authenticated.

-- ---------------------------------------------------------------------------
-- Bucket privado para los Excel exportados.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;
