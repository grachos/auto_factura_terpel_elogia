import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { createContext } from '../core/context.js';
import { handleNode } from '../core/http/node.js';
import { log } from '../core/logger.js';

// Servidor local (piloto/demo): Fastify sirve /api/* con el MISMO núcleo que la función de Vercel
// y, si existe, el frontend compilado (dist/web).
async function main(): Promise<void> {
  const ctx = await createContext();
  // Sin logger por defecto de Fastify: evita registrar URLs firmadas o cuerpos.
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // El cuerpo se deja en bruto: handleNode lo lee y valida.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

  app.all('/api/*', async (request, reply) => {
    reply.hijack();
    try {
      await handleNode(ctx, request.raw, reply.raw);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
      }
      reply.raw.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Error interno del servidor' } }));
    }
  });

  const webDir = resolve('dist/web');
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No encontrado' } });
      return reply.sendFile('index.html');
    });
  }

  const port = ctx.config.port;
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
  log('server.listening', { port, auth: ctx.auth.mode, mail: ctx.mail.kind, storage: ctx.storage.kind });
}

main().catch((e: unknown) => {
  process.stderr.write(`No se pudo iniciar el servidor: ${e instanceof Error ? e.message : 'error desconocido'}\n`);
  process.exit(1);
});
