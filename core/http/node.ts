import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../context.js';
import { handleRequest } from './router.js';
import type { HttpResponse } from './router.js';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preParsed !== undefined) return typeof preParsed === 'string' ? safeJson(preParsed) : preParsed;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Cuerpo demasiado grande');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? safeJson(text) : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function sendResponse(res: ServerResponse, out: HttpResponse): void {
  const headers: Record<string, string> = { ...(out.headers ?? {}) };
  if (out.file) {
    headers['Content-Type'] = out.file.contentType;
    headers['Content-Disposition'] = `attachment; filename="${out.file.filename}"`;
    res.writeHead(out.status, headers);
    res.end(out.file.data);
    return;
  }
  headers['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(out.status, headers);
  res.end(JSON.stringify(out.json ?? {}));
}

/** Adaptador Node (Vercel Functions y Fastify comparten el mismo despachador). */
export async function handleNode(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: Record<string, string> = {};
  // En Vercel, /api/* se reescribe a /api?__path=<ruta original>.
  const rewritten = url.searchParams.get('__path');
  if (rewritten && rewritten.startsWith('/api')) url.pathname = rewritten;
  url.searchParams.delete('__path');
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  let body: unknown;
  if (req.method && !['GET', 'HEAD'].includes(req.method)) body = await readBody(req);
  const out = await handleRequest(ctx, { method: req.method ?? 'GET', path: url.pathname, query, headers, body });
  sendResponse(res, out);
}
