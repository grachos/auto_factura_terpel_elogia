-- Fase 3: propuestas de ajuste de tarifa (simular, aprobar, aplicar). El escritor real en Silogtran NO existe aún:
-- Fase 3: propuestas de ajuste de tarifa. Con el escritor simulado (mock) las aplicadas quedan en 'simulated_applied'.

create table public.adjustment_settings (
  id boolean primary key default true check (id),
  reason_template text not null default 'Ajuste según autorización de pago Terpel, transporte {transport}, gasto {expense}',
  auto_enabled boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.adjustment_settings (id) values (true);

create table public.adjustment_proposals (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services (id),
  authorization_id uuid not null references public.authorizations (id),
  recon_result_id uuid references public.reconciliation_results (id),
  record_id uuid references public.silogtran_records (id),
  service_date date not null,
  transport_number text not null,
  expense_number text,
  remesa_code text,
  manifest text,
  status text not null check (status in (
    'proposed', 'needs_review', 'approved', 'applying', 'applied', 'simulated_applied', 'failed', 'uncertain',
    'verification_failed', 'rejected', 'stale', 'discarded')),
  review_code text,
  review_detail text,
  weight_source text check (weight_source in ('terpel', 'silogtran')),
  gallons numeric(18, 4),
  tariff text,
  current_weight numeric(18, 4),
  current_total numeric(18, 4),
  target_value numeric(18, 4),
  reason text,
  lines jsonb not null default '[]'::jsonb,
  idempotency_key text not null unique,
  rules_version text not null,
  auto_eligible boolean not null default false,
  auto_reasons jsonb not null default '[]'::jsonb,
  simulated boolean not null default false,
  writer_kind text,
  account_user text,
  generated_by text,
  approved_by text,
  approved_at timestamptz,
  applied_by text,
  applied_at timestamptz,
  lease_until timestamptz,
  verification jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Nunca dos aplicaciones simultáneas del mismo servicio.
create unique index adjustment_one_applying_per_service on public.adjustment_proposals (service_id) where status = 'applying';
-- Nunca dos cambios aplicados con la misma clave (servicio + versión de autorización + valores destino).
create index adjustment_proposals_date_idx on public.adjustment_proposals (service_date);
create index adjustment_proposals_status_idx on public.adjustment_proposals (status);

create table public.adjustment_events (
  id bigint generated always as identity primary key,
  proposal_id uuid not null references public.adjustment_proposals (id) on delete cascade,
  at timestamptz not null default now(),
  actor text,
  event text not null,
  from_status text,
  to_status text,
  simulated boolean not null default false,
  detail jsonb not null default '{}'::jsonb
);
create index adjustment_events_proposal_idx on public.adjustment_events (proposal_id, id);

create table public.adjustment_exports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reconciliation_runs (id),
  storage_path text not null,
  row_count integer,
  generated_by text,
  generated_at timestamptz not null default now()
);

alter table public.adjustment_settings enable row level security;
alter table public.adjustment_proposals enable row level security;
alter table public.adjustment_events enable row level security;
alter table public.adjustment_exports enable row level security;
revoke all on public.adjustment_settings, public.adjustment_proposals, public.adjustment_events, public.adjustment_exports from anon, authenticated;
grant select on public.adjustment_settings, public.adjustment_proposals, public.adjustment_events, public.adjustment_exports to authenticated;
create policy read_adj_settings on public.adjustment_settings for select to authenticated using (public.app_role() is not null);
create policy read_adj_proposals on public.adjustment_proposals for select to authenticated using (public.app_role() is not null);
create policy read_adj_events on public.adjustment_events for select to authenticated using (public.app_role() is not null);
create policy read_adj_exports on public.adjustment_exports for select to authenticated using (public.app_role() is not null);
