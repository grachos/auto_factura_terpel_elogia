export type DecimalStatus = 'ok' | 'empty' | 'ambiguous' | 'invalid';

export interface DecimalResult {
  /** Cadena canónica con punto decimal (apta para numeric), o null. Nunca float. */
  value: string | null;
  status: DecimalStatus;
}

const EMPTY: DecimalResult = { value: null, status: 'empty' };
const AMBIGUOUS: DecimalResult = { value: null, status: 'ambiguous' };
const INVALID: DecimalResult = { value: null, status: 'invalid' };

function ok(sign: string, intPart: string, frac: string): DecimalResult {
  const i = intPart.length === 0 ? '0' : intPart;
  return { value: `${sign}${i}${frac ? `.${frac}` : ''}`, status: 'ok' };
}

/** Grupos de miles válidos: 1-3 dígitos, luego grupos de exactamente 3. */
function isThousandsGrouped(intWithSep: string, sep: string): boolean {
  const groups = intWithSep.split(sep);
  const first = groups[0] ?? '';
  if (!/^\d{1,3}$/.test(first)) return false;
  return groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

/**
 * Normaliza números en formato colombiano/anglo sin adivinar casos ambiguos.
 *  9973,0000 → 9973.0000 ; 1.234.567,89 → 1234567.89 ; 1,234.50 → 1234.50
 *  solo "," → decimal ; "1.234" → ambiguo (incidencia, no se adivina).
 */
export function normalizeDecimal(raw: string | null | undefined): DecimalResult {
  if (raw === null || raw === undefined) return EMPTY;
  let s = raw.replace(/\u00a0/g, ' ').trim();
  if (s === '') return EMPTY;
  s = s.replace(/\s+/g, '');
  let sign = '';
  if (s.startsWith('-')) {
    sign = '-';
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return INVALID;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const pos = s.lastIndexOf(decSep);
    const intRaw = s.slice(0, pos);
    const frac = s.slice(pos + 1);
    if (intRaw.includes(decSep) || !/^\d*$/.test(frac) || frac === '') return INVALID;
    if (!isThousandsGrouped(intRaw, thouSep)) return INVALID;
    return ok(sign, intRaw.split(thouSep).join(''), frac);
  }

  if (hasComma) {
    const parts = s.split(',');
    if (parts.length > 2) return AMBIGUOUS;
    const [i = '', f = ''] = parts;
    if (!/^\d*$/.test(i) || !/^\d+$/.test(f)) return INVALID;
    return ok(sign, i, f);
  }

  if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      return isThousandsGrouped(s, '.') ? ok(sign, parts.join(''), '') : INVALID;
    }
    const [i = '', f = ''] = parts;
    if (!/^\d*$/.test(i) || !/^\d+$/.test(f)) return INVALID;
    if (f.length === 3 && i !== '' && i !== '0') return AMBIGUOUS; // "1.234": miles o decimales
    return ok(sign, i, f);
  }

  return ok(sign, s, '');
}
