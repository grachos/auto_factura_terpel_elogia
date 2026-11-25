-- Cuentas autorizadas para reenviar las autorizaciones de Terpel al buzón dedicado.
-- Vacío (por defecto) = cualquier cuenta puede reenviar, siempre que el texto citado ("De:") muestre al
-- remitente permitido de Terpel. Con cuentas listadas, solo esas pueden reenviar.
alter table public.mail_configs
  add column allowed_forwarders text[] not null default '{}';
