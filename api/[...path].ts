import type { IncomingMessage, ServerResponse } from 'node:http';
import { StartupError, createContext } from '../core/context.js';
import type { AppContext } from '../core/context.js';
import { handleNode } from '../core/http/node.js';

// Función de Vercel (Node.js). Un solo punto de entrada para /api/*; la lógica vive en core/.
let ctxPromise: Promise<AppContext> | null = null;

export const config = { maxDuration: 30 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    ctxPromise ??= createContext();
    await handleNode(await ctxPromise, req, res);
  } catch (e) {
    ctxPromise = null;
    const startup = e instanceof StartupError ? { stage: e.stage, detail: e.detailCode } : {};
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Error interno del servidor', ...startup } }));
  }
}
