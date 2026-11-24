-- Almacenamiento de los Excel en PostgreSQL (STORAGE_DRIVER=db), alternativa a Supabase Storage.
create table public.export_blobs (
  path text primary key,
  content_type text not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
alter table public.export_blobs enable row level security;
-- Sin permisos ni políticas para authenticated: solo el backend lee y escribe.
