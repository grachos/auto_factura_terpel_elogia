-- Fase 2 (ajustes): volumen 0 de Terpel parametrizable y origen del peso en los resultados.
alter table public.reconciliation_settings
  add column zero_volume_mode text not null default 'ignore'
  check (zero_volume_mode in ('ignore', 'reconcile_if_value_matches', 'reconcile_always'));
alter table public.reconciliation_results
  add column reason_code text,
  add column weight_source text check (weight_source in ('terpel', 'silogtran'));
