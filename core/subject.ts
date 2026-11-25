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

/** Direcciones de las líneas "De:" / "From:" del texto citado en un reenvío (sin distinguir mayúsculas). */
export function quotedSenders(body: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const line of (body ?? '').replace(/<[^>]+>/g, ' ').split(/\r?\n/)) {
    const m = /^\s*(?:de|from)\s*:\s*(.*)$/i.exec(stripAccents(line));
    if (!m) continue;
    for (const a of (m[1] ?? '').matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(normalizeEmail(a[0]));
  }
  return [...out];
}

export interface ForwardTrust {
  trusted: boolean;
  reason: 'direct' | 'internal_forward' | 'none';
}

/**
 * Confianza en el remitente. Directo: from y sender son el remitente permitido. Reenvío: el mensaje es un
 * reenvío (RV:/FW:/RE:) y el cuerpo citado muestra como remitente original ("De:") al permitido de Terpel;
 * lo reenvíe quien lo reenvíe. Si `allowedForwarders` tiene cuentas, solo esas pueden reenviar; vacío = cualquiera.
 * El texto citado no está autenticado: el reenviador queda registrado y la incidencia es visible.
 */
export function evaluateSenderTrust(opts: {
  from: string | null | undefined;
  sender: string | null | undefined;
  allowedSender: string;
  allowedForwarders: string[];
  isForward: boolean;
  body: string | null | undefined;
}): ForwardTrust {
  if (senderAllowed(opts.from, opts.sender, opts.allowedSender)) return { trusted: true, reason: 'direct' };
  const forwarders = new Set(opts.allowedForwarders.map(normalizeEmail).filter(Boolean));
  const forwarderOk = forwarders.size === 0 || forwarders.has(normalizeEmail(opts.from));
  if (opts.isForward && forwarderOk && quotedSenders(opts.body).includes(normalizeEmail(opts.allowedSender))) {
    return { trusted: true, reason: 'internal_forward' };
  }
  return { trusted: false, reason: 'none' };
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
