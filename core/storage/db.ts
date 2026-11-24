import type { Db } from '../db/types.js';
import { SignedUrlStorage } from './fs.js';

/**
 * Archivos guardados en PostgreSQL (tabla export_blobs), con URL firmada servida por la API.
 * Útil cuando no se dispone de la service_role de Supabase Storage. El acceso sigue siendo solo desde el backend.
 */
export class DbStorage extends SignedUrlStorage {
  readonly kind = 'db';
  constructor(
    private readonly db: Db,
    signingSecret: string,
  ) {
    super(signingSecret);
  }

  async put(path: string, data: Buffer, contentType: string): Promise<void> {
    await this.db.query('insert into export_blobs (path, content_type, data) values ($1, $2, $3)', [path, contentType, data]);
  }

  async get(path: string): Promise<Buffer> {
    const r = await this.db.query<{ data: Buffer | Uint8Array }>('select data from export_blobs where path = $1', [path]);
    const row = r.rows[0];
    if (!row) throw new Error('Archivo no encontrado');
    return Buffer.from(row.data);
  }
}
