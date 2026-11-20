/**
 * Logger seguro: solo admite valores primitivos y descarta claves sensibles.
 * Nunca se deben pasar cuerpos de correo, tokens ni nombres de conductor.
 */
const FORBIDDEN_KEYS = /body|token|secret|password|authorization|driver|conductor|subject|content|cookie|key/i;

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function setLogSink(next: LogSink): void {
  sink = next;
}

export function safeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    if (typeof v === 'string' && v.length > 200) continue;
    out[k] = v;
  }
  return out;
}

export function log(event: string, fields: LogFields = {}): void {
  sink(JSON.stringify({ t: new Date().toISOString(), event, ...safeFields(fields) }));
}
