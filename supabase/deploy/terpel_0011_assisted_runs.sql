-- Equivalente de supabase/migrations/0011 para el esquema terpel (Supabase compartido).
create table terpel.assisted_runs (
  id uuid primary key default gen_random_uuid(),
  recon_run_id uuid not null references terpel.reconciliation_runs (id),
  requested_by text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'halted')),
  writer_mode text not null,
  simulated boolean not null,
  total integer not null default 0,
  applied integer not null default 0,
  skipped integer not null default 0,
  pending integer not null default 0,
  halted_reason text,
  excluded jsonb not null default '[]'::jsonb,   -- snapshot de lo que quedó fuera del plan (con motivo)
  export_path text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
-- Una sola corrida activa a la vez.
create unique index assisted_one_running on terpel.assisted_runs ((true)) where status = 'running';

create table terpel.assisted_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references terpel.assisted_runs (id) on delete cascade,
  position integer not null,
  proposal_id uuid not null references terpel.adjustment_proposals (id),
  remesa_code text,
  transport_number text,
  result text not null default 'pending' check (result in ('pending', 'applied', 'skipped', 'halted', 'failed')),
  reason text,
  before_values jsonb,
  after_values jsonb,
  reversal_values jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, proposal_id),
  unique (run_id, position)
);

alter table terpel.assisted_runs enable row level security;
alter table terpel.assisted_run_items enable row level security;
revoke all on terpel.assisted_runs, terpel.assisted_run_items from anon, authenticated;
grant select on terpel.assisted_runs, terpel.assisted_run_items to authenticated;
create policy read_assisted_runs on terpel.assisted_runs for select to authenticated using (terpel.app_role() is not null);
create policy read_assisted_items on terpel.assisted_run_items for select to authenticated using (terpel.app_role() is not null);

alter table terpel.assisted_runs owner to terpel_app;
alter table terpel.assisted_run_items owner to terpel_app;
