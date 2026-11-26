-- Fase 4a: facturación (una factura por remesa). Emisión real solo con escritor web, lista de remesas permitida, ensayo vigente y confirmación.
create table public.invoice_settings (
  id boolean primary key default true check (id),
  cost_center text not null default 'PRINCIPAL',
  client text not null default 'ORGANIZACION TERPEL S.A',
  printable_name text not null default 'ORGANIZACION TERPEL S.A',
  seller text not null default 'CS',
  payment_days integer not null default 15 check (payment_days between 0 and 365),
  payment_city text not null default 'SANTA MARTA',
  currency text not null default 'PESOS',
  payment_method text not null default 'CUENTA CORRIENTE',
  invoice_type text not null default 'CLIENTES',
  divide text not null default 'NO' check (divide in ('SI', 'NO')),
  max_remesas integer not null default 30 check (max_remesas between 1 and 100),
  withholding_percent numeric(6, 3) not null default 1,
  product text not null default 'B100',
  observation_template text not null default 'SERVICIO DE TRANSPORTE {product} {origin} - {destination} {transport} {serviceEntrySheet}',
  writer_mode text check (writer_mode in ('mock', 'web')),            -- null = mock
  writer_allowlist text[] not null default '{}',
  writer_allow_all boolean not null default false,
  batch_enabled boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.invoice_settings (id) values (true);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services (id),
  authorization_id uuid not null references public.authorizations (id),
  recon_result_id uuid references public.reconciliation_results (id),
  record_id uuid references public.silogtran_records (id),
  remesa_code text not null,
  transport_number text not null,
  plate text,
  service_date date not null,
  terpel_value numeric(18, 4) not null,
  observation text,
  status text not null check (status in ('eligible', 'rehearsed', 'issuing', 'issued', 'failed', 'uncertain', 'verification_failed', 'skipped', 'simulated', 'discarded')),
  review_code text,
  review_detail text,
  values_before jsonb,
  values_after jsonb,
  invoice_number text,
  account_user text,
  writer_kind text,
  simulated boolean not null default false,
  idempotency_key text not null unique,
  generated_by text,
  issued_by text,
  issued_at timestamptz,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Una factura ACTIVA por remesa: nunca dos emisiones reales simultáneas ni repetidas.
create unique index invoices_one_active_per_remesa on public.invoices (remesa_code) where status in ('issuing', 'issued', 'uncertain', 'verification_failed');
create index invoices_status_idx on public.invoices (status);

create table public.invoice_events (
  id bigint generated always as identity primary key,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  at timestamptz not null default now(),
  actor text,
  event text not null,
  from_status text,
  to_status text,
  simulated boolean not null default false,
  detail jsonb not null default '{}'::jsonb
);
create index invoice_events_invoice_idx on public.invoice_events (invoice_id, id);

create table public.invoice_runs (
  id uuid primary key default gen_random_uuid(),
  recon_run_id uuid not null references public.reconciliation_runs (id),
  requested_by text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'halted')),
  writer_mode text not null,
  simulated boolean not null,
  total integer not null default 0,
  issued integer not null default 0,
  skipped integer not null default 0,
  pending integer not null default 0,
  halted_reason text,
  excluded jsonb not null default '[]'::jsonb,
  export_path text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index invoice_one_running_run on public.invoice_runs ((true)) where status = 'running';

create table public.invoice_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.invoice_runs (id) on delete cascade,
  position integer not null,
  invoice_id uuid not null references public.invoices (id),
  remesa_code text,
  transport_number text,
  result text not null default 'pending' check (result in ('pending', 'issued', 'skipped', 'halted', 'failed')),
  reason text,
  invoice_number text,
  amounts jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, invoice_id),
  unique (run_id, position)
);

alter table public.invoice_settings enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_events enable row level security;
alter table public.invoice_runs enable row level security;
alter table public.invoice_run_items enable row level security;
revoke all on public.invoice_settings, public.invoices, public.invoice_events, public.invoice_runs, public.invoice_run_items from anon, authenticated;
grant select on public.invoice_settings, public.invoices, public.invoice_events, public.invoice_runs, public.invoice_run_items to authenticated;
create policy read_invoice_settings on public.invoice_settings for select to authenticated using (public.app_role() is not null);
create policy read_invoices on public.invoices for select to authenticated using (public.app_role() is not null);
create policy read_invoice_events on public.invoice_events for select to authenticated using (public.app_role() is not null);
create policy read_invoice_runs on public.invoice_runs for select to authenticated using (public.app_role() is not null);
create policy read_invoice_run_items on public.invoice_run_items for select to authenticated using (public.app_role() is not null);
