export const EXPORT_BUCKET = 'exports';
export const SIGNED_URL_TTL_SECONDS = 300;

export interface StorageAdapter {
  readonly kind: string;
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<Buffer>;
  /** URL firmada de corta duración (5 min). */
  signedUrl(path: string, ttlSeconds?: number): Promise<string>;
}
