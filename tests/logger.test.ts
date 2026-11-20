import { afterEach, describe, expect, it } from 'vitest';
import { log, safeFields, setLogSink } from '../core/logger.js';

describe('logger seguro', () => {
  afterEach(() => setLogSink(() => undefined));
  it('descarta cuerpos, tokens, asuntos y nombres de conductor', () => {
    const out = safeFields({ runId: 'r1', count: 3, body: '<html>', accessToken: 'x', driverName: 'Fulano', driver_name: 'F', subject: 's', authorization: 'Bearer x', ok: true });
    expect(out).toEqual({ runId: 'r1', count: 3, ok: true });
  });
  it('emite JSON de una línea', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    log('evento', { runId: 'r1', body: 'secreto' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'evento', runId: 'r1' });
    expect(lines[0]).not.toContain('secreto');
  });
});
