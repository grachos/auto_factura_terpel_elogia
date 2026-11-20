-- Datos iniciales para desarrollo local (Supabase CLI: `supabase db reset`).
-- Buzón ficticio; reemplazar por el que defina TI.
insert into public.mail_configs (mailbox, allowed_sender, subject_pattern, require_dmarc_pass)
values (
  'autorizaciones-terpel@empresa.example',
  'flota@informacion.terpel.com',
  'AUTORIZACION PAGO TERPEL - Facturacion de servicio',
  false
)
on conflict (mailbox) do nothing;

-- Roles: crear primero el usuario en Supabase Auth y luego asignar rol, p. ej.:
-- insert into public.user_roles (user_id, role) values ('<uuid del usuario>', 'admin');
