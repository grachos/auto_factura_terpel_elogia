import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../fixtures/messages.js';
import { GraphMailSource } from '../core/mail/graph.js';
import type { FetchLike } from '../core/mail/graph.js';
import { CursorExpiredError, MailSourceError, ThrottledError } from '../core/mail/types.js';
import { createRun, runToCompletion } from '../core/orchestrator.js';
import { MAILBOX } from '../fixtures/templates.js';
import { MemoryStorage, count, deps, newDb, noSleep } from './helpers.js';
import { utcRangeForLocalDates } from '../core/dates.js';

const fx = buildFixtures();
const inRange = fx.all.filter((m) => m.receivedDateTime >= '2026-01-01T05:00:00Z' && m.receivedDateTime < '2026-02-01T05:00:00Z');

function toGraph(m: (typeof fx.all)[number]) {
  return {
    id: m.id,
    internetMessageId: m.internetMessageId,
    conversationId: m.conversationId,
    subject: m.subject,
    from: { emailAddress: { address: m.from } },
    sender: { emailAddress: { address: m.sender } },
    receivedDateTime: m.receivedDateTime,
    body: { contentType: m.bodyContentType, content: m.bodyContent },
    internetMessageHeaders: m.authenticationResults ? [{ name: 'Authentication-Results', value: m.authenticationResults }] : [],
  };
}

/** Graph simulado: 3 páginas de 6, con un 429 + Retry-After en la 2.ª página. */
function fakeGraph() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let throttled = false;
  const pageSize = 6;
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const u = new URL(url);
    const skip = Number(u.searchParams.get('$skiptoken') ?? '0');
    if (skip === pageSize && !throttled) {
      throttled = true;
      return { status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) }, json: async () => ({ error: { code: 'TooManyRequests' } }) };
    }
    const value = inRange.slice(skip, skip + pageSize).map(toGraph);
    const body: Record<string, unknown> = { value };
    if (skip + pageSize < inRange.length) {
      body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/users/x/messages?$skiptoken=${skip + pageSize}`;
    }
    return { status: 200, headers: { get: () => null }, json: async () => body };
  };
  return { fetchFn, calls };
}

describe('GraphMailSource (fetch, token y espera inyectados)', () => {
  it('arma la URL con $filter UTC, $select, $top e ImmutableId; solo GET', async () => {
    const g = fakeGraph();
    const src = new GraphMailSource({ tokenProvider: async () => 'TOKEN-DE-PRUEBA', fetchFn: g.fetchFn, sleep: noSleep });
    const range = utcRangeForLocalDates('2026-01-01', '2026-01-31');
    await src.fetchPage({ mailbox: MAILBOX, utcStart: range.utcStart, utcEndExclusive: range.utcEndExclusive, cursor: null });
    const call = g.calls[0]!;
    const url = decodeURIComponent(call.url);
    expect(url).toContain(`/users/${MAILBOX}/messages`);
    expect(url).toContain('$filter=receivedDateTime ge 2026-01-01T05:00:00Z and receivedDateTime lt 2026-02-01T05:00:00Z');
    expect(url).toContain('$select=id,internetMessageId,conversationId,subject,from,sender,receivedDateTime,body,internetMessageHeaders');
    expect(url).toContain('$top=50');
    expect(call.headers.Prefer).toBe('IdType="ImmutableId"');
    expect(call.headers.Authorization).toBe('Bearer TOKEN-DE-PRUEBA');
  });

  it('criterio 6: 3 páginas con 429 + Retry-After → todos importados una vez', async () => {
    const g = fakeGraph();
    const sleeps: number[] = [];
    const src = new GraphMailSource({ tokenProvider: async () => 't', fetchFn: g.fetchFn, sleep: async (ms) => void sleeps.push(ms) });
    const db = await newDb();
    const d = deps(db, src, new MemoryStorage());
    const run = await createRun(d, { dateFrom: '2026-01-01', dateTo: '2026-01-31', actor: 't' });
    const done = await runToCompletion(d, run.id, 't', noSleep);
    expect(sleeps).toEqual([2000]); // respetó Retry-After: 2 s
    expect(done.status).toBe('completed');
    expect(done.pagesProcessed).toBe(3);
    expect(done.found).toBe(16);
    expect(await count(db, 'source_messages')).toBe(16);
    // El nextLink se siguió tal cual y el 429 se reintentó sobre la misma URL
    expect(g.calls.filter((c) => c.url.includes('skiptoken=6')).length).toBe(2);
    // Authentication-Results se registra
    expect(await count(db, 'source_messages', `auth_results like '%dmarc=pass%'`)).toBeGreaterThan(0);
    await db.close();
  });

  it('429 persistente → ThrottledError (el paso se pausa sin perder el cursor)', async () => {
    const fetchFn: FetchLike = async () => ({ status: 429, headers: { get: () => '30' }, json: async () => ({}) });
    const src = new GraphMailSource({ tokenProvider: async () => 't', fetchFn, sleep: noSleep, maxWaitMs: 8000 });
    const range = utcRangeForLocalDates('2026-01-01', '2026-01-02');
    await expect(src.fetchPage({ mailbox: 'a@b.c', ...range, cursor: null })).rejects.toBeInstanceOf(ThrottledError);
  });

  it('403 ErrorAccessDenied → MailSourceError con código, sin cuerpo', async () => {
    const fetchFn: FetchLike = async () => ({ status: 403, headers: { get: () => null }, json: async () => ({ error: { code: 'ErrorAccessDenied', message: 'texto con datos' } }) });
    const src = new GraphMailSource({ tokenProvider: async () => 't', fetchFn, sleep: noSleep });
    const range = utcRangeForLocalDates('2026-01-01', '2026-01-02');
    const err = await src.fetchPage({ mailbox: 'a@b.c', ...range, cursor: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSourceError);
    expect((err as MailSourceError).code).toBe('ErrorAccessDenied');
    expect((err as Error).message).not.toContain('datos');
  });

  it('cursor hacia otro host o expirado → CursorExpiredError (el token no se envía fuera de Graph)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      return { status: 410, headers: { get: () => null }, json: async () => ({}) };
    };
    const src = new GraphMailSource({ tokenProvider: async () => 't', fetchFn, sleep: noSleep });
    const range = utcRangeForLocalDates('2026-01-01', '2026-01-02');
    await expect(src.fetchPage({ mailbox: 'a@b.c', ...range, cursor: 'https://evil.example/steal' })).rejects.toBeInstanceOf(CursorExpiredError);
    expect(calls).toHaveLength(0);
    await expect(src.fetchPage({ mailbox: 'a@b.c', ...range, cursor: 'https://graph.microsoft.com/v1.0/x?$skiptoken=1' })).rejects.toBeInstanceOf(CursorExpiredError);
  });
});
