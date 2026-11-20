import { createClient } from '@supabase/supabase-js';
import type { StorageAdapter } from './types.js';
import { EXPORT_BUCKET, SIGNED_URL_TTL_SECONDS } from './types.js';

/** Supabase Storage (bucket privado "exports"), solo con service_role desde el backend. */
export class SupabaseStorage implements StorageAdapter {
  readonly kind = 'supabase';
  private readonly client;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async put(path: string, data: Buffer, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(EXPORT_BUCKET).upload(path, data, { contentType, upsert: false });
    if (error) throw new Error('No se pudo subir el archivo a Storage');
  }

  async get(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(EXPORT_BUCKET).download(path);
    if (error || !data) throw new Error('No se pudo leer el archivo de Storage');
    return Buffer.from(await data.arrayBuffer());
  }

  async signedUrl(path: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
    const { data, error } = await this.client.storage.from(EXPORT_BUCKET).createSignedUrl(path, ttlSeconds);
    if (error || !data) throw new Error('No se pudo firmar la URL');
    return data.signedUrl;
  }
}
