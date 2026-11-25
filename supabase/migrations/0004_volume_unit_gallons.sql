-- La unidad del volumen del transporte quedó confirmada por el negocio: galones (puede venir en 0).
-- La columna loading_plant_flag queda sin uso (la planta de cargue no se evalúa).
update public.authorizations set transport_volume_unit = 'galones', unit_status = 'confirmed'
  where transport_volume is not null and transport_volume_unit is null;
update public.authorizations set unit_status = 'not_applicable'
  where transport_volume is null and unit_status = 'pending_confirmation';
