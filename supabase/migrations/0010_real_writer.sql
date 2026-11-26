-- Incremento 3b: escritor real (modo y lista de remesas permitidas editables por admin) y reversas.
alter table public.adjustment_settings
  add column writer_mode text check (writer_mode in ('mock', 'web')), -- null = valor inicial de SILOG_WRITER
  add column writer_allowlist text[] not null default '{}',
  add column writer_allow_all boolean not null default false;

alter table public.adjustment_proposals
  add column kind text not null default 'adjust' check (kind in ('adjust', 'reversal')),
  add column reversal_of uuid references public.adjustment_proposals (id),
  add column quantity numeric(18, 4),            -- Cantidad Remesa (null = igual a gallons)
  add column reversal_values jsonb;              -- anterior_peso/cantidad/tarifa leídos de la pantalla antes de grabar
create index adjustment_proposals_reversal_idx on public.adjustment_proposals (reversal_of) where reversal_of is not null;
