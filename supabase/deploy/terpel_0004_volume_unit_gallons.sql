-- Equivalente de supabase/migrations/0004 para el esquema "terpel" (ya aplicado).
update terpel.authorizations set transport_volume_unit = 'galones', unit_status = 'confirmed'
  where transport_volume is not null and transport_volume_unit is null;
update terpel.authorizations set unit_status = 'not_applicable'
  where transport_volume is null and unit_status = 'pending_confirmation';
