// Cálculo EXACTO de la tarifa: valor de Terpel ÷ galones con aritmética decimal exacta (BigInt; nunca float).
export const MAX_TARIFF_CHARS = 12; // el punto cuenta

export type TariffErrorCode = 'INVALID_INPUT' | 'TARIFF_NOT_EXACT' | 'TARIFF_TOO_LONG';

export type TariffResult =
  | { ok: true; tariff: string; gallons: string; value: string }
  | { ok: false; code: TariffErrorCode; detail: string };

interface Dec {
  n: bigint; // entero escalado
  scale: number; // decimales
}

/** Acepta solo decimales positivos con punto: "10487", "10487.0000", "2464445.5". */
function parse(raw: unknown): Dec | null {
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    s = String(raw);
    if (/e/i.test(s)) return null; // notación científica: no confiable
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  return { n: BigInt((m[1] as string) + frac), scale: frac.length };
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

/** Representación canónica sin ceros sobrantes a la derecha. */
export function canonical(d: Dec): string {
  const digits = d.n.toString().padStart(d.scale + 1, '0');
  if (d.scale === 0) return digits;
  const int = digits.slice(0, digits.length - d.scale);
  const frac = digits.slice(digits.length - d.scale).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

export function normalizeNumberString(raw: unknown): string | null {
  const d = parse(raw);
  return d ? canonical(d) : null;
}

export function computeTariff(valueRaw: unknown, gallonsRaw: unknown): TariffResult {
  const v = parse(valueRaw);
  const g = parse(gallonsRaw);
  if (!v || !g) return { ok: false, code: 'INVALID_INPUT', detail: 'Valor o galones vacíos o con formato inválido' };
  if (g.n === 0n) return { ok: false, code: 'INVALID_INPUT', detail: 'Los galones deben ser mayores que 0' };
  if (v.n === 0n) return { ok: false, code: 'INVALID_INPUT', detail: 'El valor debe ser mayor que 0' };

  // tarifa = (V / 10^sv) / (G / 10^sg) = (V * 10^sg) / (G * 10^sv)
  let num = v.n * 10n ** BigInt(g.scale);
  let den = g.n * 10n ** BigInt(v.scale);
  const d = gcd(num, den);
  num /= d;
  den /= d;
  // Decimal finito sii el denominador reducido solo tiene factores 2 y 5.
  let twos = 0;
  let fives = 0;
  let rest = den;
  while (rest % 2n === 0n) { rest /= 2n; twos += 1; }
  while (rest % 5n === 0n) { rest /= 5n; fives += 1; }
  if (rest !== 1n) {
    return { ok: false, code: 'TARIFF_NOT_EXACT', detail: 'El valor dividido entre los galones no es un decimal exacto' };
  }
  const k = Math.max(twos, fives);
  const scaled = (num * 10n ** BigInt(k)) / den; // exacto por construcción
  const tariff = canonical({ n: scaled, scale: k });
  if (tariff.length > MAX_TARIFF_CHARS) {
    return { ok: false, code: 'TARIFF_TOO_LONG', detail: `La tarifa exacta (${tariff.length} caracteres) no cabe en ${MAX_TARIFF_CHARS}` };
  }
  // Comprobación explícita: tarifa × galones == valor, sin tolerancia.
  const t = parse(tariff) as Dec;
  const lhs = t.n * g.n * 10n ** BigInt(v.scale);
  const rhs = v.n * 10n ** BigInt(t.scale + g.scale);
  if (lhs !== rhs) return { ok: false, code: 'TARIFF_NOT_EXACT', detail: 'tarifa × galones no reproduce el valor' };
  return { ok: true, tariff, gallons: canonical(g), value: canonical(v) };
}
