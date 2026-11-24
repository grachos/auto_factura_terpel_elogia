-- Despliegue en un proyecto Supabase compartido: todo vive en el esquema "terpel".
-- Generado desde supabase/migrations (public. -> terpel.), sin el bucket de Storage (se usa STORAGE_DRIVER=db).
-- El rol terpel_app (creado aparte, con contraseña fuera del repositorio) es dueño del esquema y lo usa el backend.
create schema if not exists terpel;
grant usage on schema terpel to authenticated, service_role;
set local search_path = terpel, public;
-- AutoFactura Terpel - Fase 1: importar correos, Excel y persistencia.
-- Montos/cantidades numeric(18,4); identificadores text; fecha del servicio date.

create table terpel.mail_configs (
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

create table terpel.import_runs (
  id uuid primary key default gen_random_uuid(),
  mail_config_id uuid not null references terpel.mail_configs (id),
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
  on terpel.import_runs (mail_config_id)
  where status in ('pending', 'running', 'paused');

create table terpel.source_messages (
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
  first_run_id uuid references terpel.import_runs (id),
  created_at timestamptz not null default now(),
  unique (mailbox, graph_immutable_id),
  unique (mailbox, internet_message_id)
);

-- Cuerpo crudo del correo: tabla separada, sin SELECT para operadores.
create table terpel.source_message_bodies (
  message_id uuid primary key references terpel.source_messages (id) on delete cascade,
  body_raw text not null
);

create table terpel.run_messages (
  run_id uuid not null references terpel.import_runs (id) on delete cascade,
  message_id uuid not null references terpel.source_messages (id),
  outcome text not null
    check (outcome in ('imported', 'duplicate', 'needs_review', 'ignored_sender', 'ignored_subject', 'parse_error')),
  created_at timestamptz not null default now(),
  primary key (run_id, message_id)
);

create table terpel.services (
  id uuid primary key default gen_random_uuid(),
  business_key text not null unique,
  transport_number text not null,
  current_authorization_id uuid,
  status text not null default 'imported',
  version_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table terpel.authorizations (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references terpel.source_messages (id),
  service_id uuid references terpel.services (id),
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

alter table terpel.services
  add constraint services_current_authorization_fk
  foreign key (current_authorization_id) references terpel.authorizations (id);

create index authorizations_service_idx on terpel.authorizations (service_id);
create index run_messages_message_idx on terpel.run_messages (message_id);

create table terpel.import_issues (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references terpel.import_runs (id) on delete cascade,
  message_id uuid references terpel.source_messages (id),
  authorization_id uuid references terpel.authorizations (id),
  code text not null,
  severity text not null check (severity in ('info', 'warning', 'error')),
  field text,
  detail text,
  created_at timestamptz not null default now()
);
create index import_issues_run_idx on terpel.import_issues (run_id);

create table terpel.export_files (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references terpel.import_runs (id) on delete cascade,
  storage_path text,
  sha256 text,
  row_count integer,
  issue_count integer,
  status text not null check (status in ('ready', 'failed')),
  generated_at timestamptz not null default now()
);
create index export_files_run_idx on terpel.export_files (run_id);

create table terpel.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('operator', 'admin', 'viewer'))
);

create table terpel.audit_log (
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
create function terpel.app_role() returns text
  language sql stable security definer set search_path = public
  as $$ select role from terpel.user_roles where user_id = auth.uid() $$;

revoke all on function terpel.app_role() from public;
grant execute on function terpel.app_role() to authenticated, service_role;

alter table terpel.mail_configs enable row level security;
alter table terpel.import_runs enable row level security;
alter table terpel.source_messages enable row level security;
alter table terpel.source_message_bodies enable row level security;
alter table terpel.run_messages enable row level security;
alter table terpel.services enable row level security;
alter table terpel.authorizations enable row level security;
alter table terpel.import_issues enable row level security;
alter table terpel.export_files enable row level security;
alter table terpel.user_roles enable row level security;
alter table terpel.audit_log enable row level security;

revoke all on all tables in schema terpel from anon, authenticated;

grant select on terpel.import_runs, terpel.source_messages, terpel.run_messages,
  terpel.services, terpel.authorizations, terpel.import_issues, terpel.export_files
  to authenticated;
grant select on terpel.mail_configs to authenticated;
grant select on terpel.user_roles to authenticated;
grant select on terpel.audit_log to authenticated;

create policy read_runs on terpel.import_runs for select to authenticated using (terpel.app_role() is not null);
create policy read_messages on terpel.source_messages for select to authenticated using (terpel.app_role() is not null);
create policy read_run_messages on terpel.run_messages for select to authenticated using (terpel.app_role() is not null);
create policy read_services on terpel.services for select to authenticated using (terpel.app_role() is not null);
create policy read_authorizations on terpel.authorizations for select to authenticated using (terpel.app_role() is not null);
create policy read_issues on terpel.import_issues for select to authenticated using (terpel.app_role() is not null);
create policy read_exports on terpel.export_files for select to authenticated using (terpel.app_role() is not null);
create policy admin_read_mail_configs on terpel.mail_configs for select to authenticated using (terpel.app_role() = 'admin');
create policy read_own_role on terpel.user_roles for select to authenticated using (user_id = auth.uid());
create policy admin_read_audit on terpel.audit_log for select to authenticated using (terpel.app_role() = 'admin');
-- source_message_bodies: RLS activado, sin permisos ni políticas para authenticated.

-- Almacenamiento de los Excel en PostgreSQL (STORAGE_DRIVER=db), alternativa a Supabase Storage.
create table terpel.export_blobs (
  path text primary key,
  content_type text not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
alter table terpel.export_blobs enable row level security;
-- Sin permisos ni políticas para authenticated: solo el backend lee y escribe.

-- Propiedad para el rol del backend (dueño = sin RLS para el backend; RLS aplica a authenticated).
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'terpel' loop
    execute format('alter table terpel.%I owner to terpel_app', r.tablename);
  end loop;
end $$;
alter schema terpel owner to terpel_app;
alter function terpel.app_role() owner to terpel_app;
