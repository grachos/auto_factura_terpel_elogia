// Normalizadores deterministas para la conciliación (sin IA).

/** Cédula: solo dígitos, sin ceros a la izquierda. Vacío/sin dígitos -> null. */
export function normalizeDocument(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const digits = String(v).replace(/\D+/g, '').replace(/^0+/, '');
  return digits === '' ? null : digits;
}

/** Placa: mayúsculas alfanuméricas. */
export function normalizePlate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const p = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return p === '' ? null : p;
}

/** Lugar: sin tildes, mayúsculas, espacios colapsados. */
export function normalizePlace(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const p = String(v)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return p === '' ? null : p;
}

export interface ParsedRoute {
  code: string | null;
  origin: string;
  destination: string;
}

/** `C40434-SANTA MARTA - BARRANCABERMEJA` -> código + origen + destino normalizados. */
export function parseTerpelRoute(route: string | null | undefined): ParsedRoute | null {
  if (!route) return null;
  let rest = route.trim();
  let code: string | null = null;
  const m = /^([A-Za-z]{0,3}\d+)\s*-\s*(.+)$/.exec(rest);
  if (m) {
    code = (m[1] as string).toUpperCase();
    rest = m[2] as string;
  }
  let parts = rest.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) parts = rest.split(/[-–—]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const origin = normalizePlace(parts[0]);
  const destination = normalizePlace(parts.slice(1).join(' '));
  if (!origin || !destination) return null;
  return { code, origin, destination };
}

/** Número que puede venir como string, número o null. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, '');
  if (s === '') return null;
  // "1.234,56" (es-CO) o "1234.56"
  const norm = /,\d{1,4}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

export function toDateOnly(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? (m[1] as string) : null;
}

/** Diferencia en días (b - a) entre dos fechas YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.00005;
}
