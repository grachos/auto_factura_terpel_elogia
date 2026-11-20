const FORWARD_PREFIX = /^\s*(rv|re|fw|fwd)\s*:\s*/i;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Minúsculas, sin tildes, guiones equivalentes, espacios colapsados. */
export function normalizeText(s: string): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/\s*[-‐-―−]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NormalizedSubject {
  normalized: string;
  isForward: boolean;
}

/** Quita prefijos RV:/RE:/FW:/FWD: (repetidos) y marca el reenvío. */
export function normalizeSubject(subject: string): NormalizedSubject {
  let rest = subject ?? '';
  let isForward = false;
  while (FORWARD_PREFIX.test(rest)) {
    rest = rest.replace(FORWARD_PREFIX, '');
    isForward = true;
  }
  return { normalized: normalizeText(rest), isForward };
}

export function subjectMatches(subject: string, pattern: string): { matches: boolean; isForward: boolean } {
  const { normalized, isForward } = normalizeSubject(subject);
  const p = normalizeText(pattern);
  return { matches: p.length > 0 && normalized.includes(p), isForward };
}

export function normalizeEmail(address: string | null | undefined): string {
  return (address ?? '').trim().toLowerCase();
}

/** `from` y `sender` deben coincidir exactamente (sin distinguir mayúsculas) con el remitente permitido. */
export function senderAllowed(
  from: string | null | undefined,
  sender: string | null | undefined,
  allowed: string,
): boolean {
  const a = normalizeEmail(allowed);
  return a.length > 0 && normalizeEmail(from) === a && normalizeEmail(sender) === a;
}

export type DmarcStatus = 'pass' | 'fail' | 'none' | 'unknown';

export function dmarcStatus(authResults: string | null | undefined): DmarcStatus {
  if (!authResults) return 'unknown';
  const m = /dmarc=(\w+)/i.exec(authResults);
  if (!m) return 'unknown';
  const v = (m[1] ?? '').toLowerCase();
  if (v === 'pass') return 'pass';
  if (v === 'none') return 'none';
  return 'fail';
}
