-- Equivalente de supabase/migrations/0005 para el esquema terpel (Supabase compartido). Aplicar y luego: alter table ... owner to terpel_app.
-- Cédulas y nombres de conductores son datos personales: sin SELECT público, acceso por rol.

create table terpel.silogtran_records (
  id uuid primary key default gen_random_uuid(),
  manifest text not null,
  remesa_code text not null,
  dispatch_date date,
  delivery_date date,
  plate text,
  plate_normalized text,
  trailer_plate text,
  driver_name text,
  driver_document text,
  client text,
  client_nit text,
  origin_city text,
  destination_city text,
  remesa_weight numeric(18, 4),
  net_load_weight numeric(18, 4),
  rate numeric(18, 4),
  freight_dispatch numeric(18, 4),
  total_remesa numeric(18, 4),
  additional_value numeric(18, 4),
  status text,
  remesa_status text,
  invoice text,
  synced_at timestamptz not null default now(),
  unique (manifest, remesa_code)
);
create index silogtran_records_dispatch_idx on terpel.silogtran_records (client_nit, dispatch_date);

create table terpel.silogtran_sync_log (
  id bigint generated always as identity primary key,
  run_id uuid,
  date_from date not null,
  date_to date not null,
  rows_total integer not null default 0,
  rows_kept integer not null default 0,
  duration_ms integer,
  status text not null check (status in ('ok', 'failed')),
  error_code text,
  at timestamptz not null default now()
);

create table terpel.reconciliation_settings (
  id boolean primary key default true check (id),
  window_days integer not null default 10 check (window_days between 0 and 60),
  lookback_days integer not null default 15 check (lookback_days between 0 and 90),
  terpel_nit text not null default '830095213',
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into terpel.reconciliation_settings (id) values (true);

create table terpel.match_filters (
  key text primary key check (key in ('driver', 'plate', 'route', 'date')),
  position integer not null,
  active boolean not null default true,
  mode text not null check (mode in ('exclusive', 'preferred')),
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into terpel.match_filters (key, position, active, mode) values
  ('driver', 1, true, 'exclusive'),
  ('plate', 2, true, 'preferred'),
  ('route', 3, true, 'exclusive'),
  ('date', 4, true, 'exclusive');

create table terpel.place_aliases (
  id uuid primary key default gen_random_uuid(),
  silog_name text not null,
  terpel_name text not null,
  silog_norm text not null unique,
  terpel_norm text not null,
  created_by text,
  created_at timestamptz not null default now()
);
insert into terpel.place_aliases (silog_name, terpel_name, silog_norm, terpel_norm) values
  ('Chimitá', 'Bucaramanga', 'CHIMITA', 'BUCARAMANGA'),
  ('Lizama', 'Barrancabermeja', 'LIZAMA', 'BARRANCABERMEJA'),
  ('Villa del Rosario', 'Cúcuta', 'VILLA DEL ROSARIO', 'CUCUTA'),
  ('Puerto Berrío', 'Cimitarra', 'PUERTO BERRIO', 'CIMITARRA');

create table terpel.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  date_from date not null,
  date_to date not null,
  sync_enabled boolean not null default true,
  lookback_days integer not null,
  window_days integer not null,
  rules_version text not null,
  status text not null default 'pending'
    check (status in ('pending', 'syncing', 'reconciling', 'completed', 'failed')),
  sync_cursor date,
  sync_end date,
  reconcile_offset integer not null default 0,
  lease_until timestamptz,
  total_services integer not null default 0,
  exact integer not null default 0,
  with_differences integer not null default 0,
  ambiguous integer not null default 0,
  no_match integer not null default 0,
  insufficient integer not null default 0,
  export_status text not null default 'pending' check (export_status in ('pending', 'ready', 'failed')),
  export_path text,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check (date_from <= date_to)
);
create unique index reconciliation_runs_one_active
  on terpel.reconciliation_runs ((true))
  where status in ('pending', 'syncing', 'reconciling');

-- Un resultado vigente por servicio (se reemplaza al reconciliar de nuevo; la resolución manual se conserva).
create table terpel.reconciliation_results (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null unique references terpel.services (id),
  run_id uuid not null references terpel.reconciliation_runs (id),
  authorization_id uuid not null references terpel.authorizations (id),
  transport_number text not null,
  service_date date not null,
  status text not null
    check (status in ('EXACT', 'MATCH_WITH_DIFFERENCES', 'AMBIGUOUS', 'NO_MATCH', 'INSUFFICIENT_DATA')),
  chosen_record_id uuid references terpel.silogtran_records (id),
  candidate_ids uuid[] not null default '{}',
  filter_trace jsonb not null default '[]'::jsonb,
  differences jsonb not null default '[]'::jsonb,
  reason text,
  rules_version text not null,
  resolved_record_id uuid references terpel.silogtran_records (id),
  resolved_by text,
  resolved_at timestamptz,
  computed_at timestamptz not null default now()
);
create index reconciliation_results_date_idx on terpel.reconciliation_results (service_date);
create index reconciliation_results_status_idx on terpel.reconciliation_results (status);

-- RLS: lectura para usuarios con rol; escritura solo desde el backend. Configuración: lectura para todos con rol.
alter table terpel.silogtran_records enable row level security;
alter table terpel.silogtran_sync_log enable row level security;
alter table terpel.reconciliation_settings enable row level security;
alter table terpel.match_filters enable row level security;
alter table terpel.place_aliases enable row level security;
alter table terpel.reconciliation_runs enable row level security;
alter table terpel.reconciliation_results enable row level security;

revoke all on terpel.silogtran_records, terpel.silogtran_sync_log, terpel.reconciliation_settings,
  terpel.match_filters, terpel.place_aliases, terpel.reconciliation_runs, terpel.reconciliation_results
  from anon, authenticated;
grant select on terpel.silogtran_records, terpel.silogtran_sync_log, terpel.reconciliation_settings,
  terpel.match_filters, terpel.place_aliases, terpel.reconciliation_runs, terpel.reconciliation_results
  to authenticated;

create policy read_silog on terpel.silogtran_records for select to authenticated using (terpel.app_role() is not null);
create policy read_silog_sync on terpel.silogtran_sync_log for select to authenticated using (terpel.app_role() is not null);
create policy read_recon_settings on terpel.reconciliation_settings for select to authenticated using (terpel.app_role() is not null);
create policy read_match_filters on terpel.match_filters for select to authenticated using (terpel.app_role() is not null);
create policy read_place_aliases on terpel.place_aliases for select to authenticated using (terpel.app_role() is not null);
create policy read_recon_runs on terpel.reconciliation_runs for select to authenticated using (terpel.app_role() is not null);
create policy read_recon_results on terpel.reconciliation_results for select to authenticated using (terpel.app_role() is not null);
-- Escrituras (configuración solo admin, resoluciones por operador/admin) pasan por la API con service/owner role.
