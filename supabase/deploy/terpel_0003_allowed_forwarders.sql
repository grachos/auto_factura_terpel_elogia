-- Equivalente de supabase/migrations/0003 para el esquema "terpel" del Supabase compartido (ya aplicado).
alter table terpel.mail_configs add column if not exists allowed_forwarders text[] not null default '{}';
