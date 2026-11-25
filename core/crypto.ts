import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

/** Clave AES-256 (64 hex) solo desde variables de entorno del servidor. Falla claro, sin tocar nada. */
export function parseEncryptionKey(hex: string | undefined | null): Buffer {
  if (!hex) throw new AppError(503, 'ENCRYPTION_NOT_CONFIGURED', 'Falta ENCRYPTION_KEY en el servidor: no se pueden guardar credenciales');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new AppError(503, 'ENCRYPTION_KEY_INVALID', 'ENCRYPTION_KEY inválida: debe tener 64 caracteres hexadecimales');
  }
  return Buffer.from(hex, 'hex');
}

const VERSION = 'v1';

/** AES-256-GCM. Formato versionado `v1:iv:tag:ciphertext` (base64url). AAD = id del registro. */
export function encryptSecret(plain: string, aad: string, keyHex: string | undefined | null): string {
  const key = parseEncryptionKey(keyHex);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptSecret(blob: string, aad: string, keyHex: string | undefined | null): string {
  const key = parseEncryptionKey(keyHex);
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new AppError(500, 'CREDENTIAL_UNREADABLE', 'La credencial guardada no se puede leer');
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1] as string, 'base64url'));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(parts[2] as string, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[3] as string, 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new AppError(500, 'CREDENTIAL_UNREADABLE', 'La credencial guardada no se puede leer (¿cambió ENCRYPTION_KEY?)');
  }
}
