import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { StorageAdapter } from './types.js';
import { SIGNED_URL_TTL_SECONDS } from './types.js';

/** Storage en sistema de archivos para demo/local. URLs firmadas con HMAC y expiración. */
/** Base con URLs firmadas HMAC servidas por /api/files (FsStorage y DbStorage). */
export abstract class SignedUrlStorage implements StorageAdapter {
  abstract readonly kind: string;
  constructor(
    private readonly signingSecret: string,
    private readonly publicBase = '/api/files',
  ) {}
  abstract put(path: string, data: Buffer, contentType: string): Promise<void>;
  abstract get(path: string): Promise<Buffer>;

  private sign(path: string, exp: number): string {
    return createHmac('sha256', this.signingSecret).update(`${path}\n${exp}`).digest('base64url');
  }

  async signedUrl(path: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const q = new URLSearchParams({ p: path, exp: String(exp), sig: this.sign(path, exp) });
    return `${this.publicBase}?${q.toString()}`;
  }

  /** Valida p/exp/sig de una URL firmada; devuelve la ruta o null. */
  verify(path: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(path, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

export class FsStorage extends SignedUrlStorage {
  readonly kind = 'fs';
  constructor(
    private readonly rootDir: string,
    signingSecret: string,
  ) {
    super(signingSecret);
  }

  private resolve(path: string): string {
    const full = normalize(join(this.rootDir, path));
    if (!full.startsWith(normalize(this.rootDir) + sep)) throw new Error('Ruta de almacenamiento inválida');
    return full;
  }

  async put(path: string, data: Buffer): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(path: string): Promise<Buffer> {
    return readFile(this.resolve(path));
  }
}
