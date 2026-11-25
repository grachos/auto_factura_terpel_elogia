import { getUserRole } from '../auth.js';
import { DEMO_USERS } from '../auth.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { generateExport } from '../excel.js';
import { log } from '../logger.js';
import { audit } from '../audit.js';
import { createRun, stepRun } from '../orchestrator.js';
import { getMailConfigDto, getRunDetail, getRunExports, listRunDtos } from '../queries.js';
import { SignedUrlStorage } from '../storage/fs.js';
import { SIGNED_URL_TTL_SECONDS } from '../storage/types.js';
import type { ApiErrorDto, MailConfigDto, MeDto, PublicConfigDto, Role } from '../types.js';
import { sqlState } from '../db/types.js';
import { generateReconExport } from '../recon/excel.js';
import {
  addAliasAndReconcile, createReconRun, deleteAlias, getParams, getReconDetail, getReconRun, isUuid, listReconRuns, listResults, loadAliases,
  resolveResult, saveFilters, saveSettings, stepReconRun, syncStep, upsertAlias,
} from '../recon/service.js';
import type { MatchFilterDto, ReconSettingsDto } from '../types.js';

export interface HttpRequest {
  method: string;
  /** Ruta sin query, p. ej. /api/runs/abc/step */
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  file?: { data: Buffer; contentType: string; filename: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_ROLES: Role[] = ['operator', 'admin'];

function ok(json: unknown, status = 200): HttpResponse {
  return { status, json, headers: { 'Cache-Control': 'no-store' } };
}

function errorResponse(e: AppError): HttpResponse {
  const body: ApiErrorDto = { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
  return { status: e.status, json: body, headers: { 'Cache-Control': 'no-store' } };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new AppError(400, 'INVALID_BODY', 'El cuerpo de la solicitud debe ser un objeto JSON');
}

function bearer(headers: Record<string, string | undefined>): string | null {
  const h = headers.authorization ?? headers.Authorization;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1] ?? null;
}

interface Session {
  userId: string;
  email: string | null;
  role: Role;
}

async function authenticate(ctx: AppContext, req: HttpRequest): Promise<Session> {
  const token = bearer(req.headers);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Inicie sesión para continuar');
  const user = await ctx.auth.verify(token);
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Sesión inválida o vencida');
  const role = await getUserRole(ctx.db, user.id);
  if (!role) throw new AppError(403, 'NO_ROLE', 'Su usuario no tiene un rol asignado');
  return { userId: user.id, email: user.email, role };
}

function requireRole(s: Session, roles: Role[]): void {
  if (!roles.includes(s.role)) throw new AppError(403, 'FORBIDDEN', 'No tiene permisos para esta acción');
}

function runId(seg: string | undefined): string {
  if (!seg || !UUID.test(seg)) throw new AppError(400, 'INVALID_ID', 'Identificador de ejecución inválido');
  return seg;
}

function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new AppError(400, 'INVALID_FIELD', `Campo inválido: ${name}`);
  return v.trim();
}

/** Despachador agnóstico del framework: lo usan Fastify (local) y la función de Vercel. */
export async function handleRequest(ctx: AppContext, req: HttpRequest): Promise<HttpResponse> {
  const started = Date.now();
  let route = 'unknown';
  let res: HttpResponse;
  try {
    const out = await dispatch(ctx, req, (r) => {
      route = r;
    });
    res = out;
  } catch (e) {
    if (e instanceof AppError) {
      res = errorResponse(e);
    } else {
      // Nunca se devuelve ni registra el mensaje original (podría contener datos).
      log('http.unhandled', { route, state: sqlState(e) });
      res = errorResponse(new AppError(500, 'INTERNAL', 'Error interno del servidor'));
    }
  }
  log('http', { method: req.method, route, status: res.status, ms: Date.now() - started });
  return res;
}

async function dispatch(ctx: AppContext, req: HttpRequest, setRoute: (r: string) => void): Promise<HttpResponse> {
  const parts = req.path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  const [a, b, c, d] = parts;
  const is = (m: string, route: string): boolean => {
    if (m === method) {
      setRoute(`${m} ${route}`);
      return true;
    }
    return false;
  };

  // ---- Públicas -------------------------------------------------------------
  if (a === 'health' && parts.length === 1 && is('GET', '/health')) return ok({ ok: true });

  if (a === 'config' && parts.length === 1 && is('GET', '/config')) {
    const dto: PublicConfigDto = {
      authMode: ctx.auth.mode,
      mailSource: ctx.mail.kind,
      supabaseUrl: ctx.auth.mode === 'supabase' ? ctx.config.supabase.url || null : null,
      supabaseAnonKey: ctx.auth.mode === 'supabase' ? ctx.config.supabase.anonKey || null : null,
      demoUsers: ctx.auth.mode === 'demo' ? DEMO_USERS.map((u) => ({ email: u.email, role: u.role })) : [],
      silogSource: ctx.silog?.kind ?? 'none',
    };
    return ok(dto);
  }

  if (a === 'auth' && b === 'demo-login' && parts.length === 2 && is('POST', '/auth/demo-login')) {
    if (!ctx.auth.demoLogin) throw new AppError(404, 'NOT_FOUND', 'No encontrado');
    const body = asObject(req.body);
    const r = await ctx.auth.demoLogin(str(body.email, 'email'), str(body.password, 'password'));
    if (!r) throw new AppError(401, 'BAD_CREDENTIALS', 'Correo o contraseña incorrectos');
    return ok({ token: r.token });
  }

  if (a === 'files' && parts.length === 1 && is('GET', '/files')) {
    if (!(ctx.storage instanceof SignedUrlStorage)) throw new AppError(404, 'NOT_FOUND', 'No encontrado');
    const p = req.query.p ?? '';
    if (!ctx.storage.verify(p, Number(req.query.exp), req.query.sig ?? '')) {
      throw new AppError(403, 'LINK_EXPIRED', 'El enlace de descarga venció o no es válido');
    }
    const data = await ctx.storage.get(p);
    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      file: {
        data,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: p.startsWith('recon/') ? `conciliacion-${p.split('/')[1]?.slice(0, 8) ?? 'lote'}.xlsx` : `autorizaciones-${p.split('/')[0]?.slice(0, 8) ?? 'lote'}.xlsx`,
      },
    };
  }

  // ---- Autenticadas ----------------------------------------------------------
  const session = await authenticate(ctx, req);

  if (a === 'me' && parts.length === 1 && is('GET', '/me')) {
    const me: MeDto = { id: session.userId, email: session.email, role: session.role };
    return ok(me);
  }

  if (a === 'mail-config' && parts.length === 1) {
    if (is('GET', '/mail-config')) {
      requireRole(session, ['admin']); // misma regla que RLS: mail_configs solo para administradores
      return ok(await getMailConfigDto(ctx.db));
    }
    if (is('PUT', '/mail-config')) {
      requireRole(session, ['admin']);
      const body = asObject(req.body);
      const strategy = body.businessKeyStrategy;
      if (strategy !== 'transport_number' && strategy !== 'transport_expense') {
        throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: businessKeyStrategy');
      }
      const mailbox = str(body.mailbox, 'mailbox', 254);
      const allowedSender = str(body.allowedSender, 'allowedSender', 254);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailbox) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(allowedSender)) {
        throw new AppError(400, 'INVALID_FIELD', 'Los correos del buzón y del remitente deben ser direcciones válidas');
      }
      const active = await ctx.db.query(`select 1 from import_runs where status in ('pending','running','paused') limit 1`);
      if (active.rowCount > 0) throw new AppError(409, 'ACTIVE_RUN_EXISTS', 'No se puede cambiar la configuración con una importación activa');
      const current = await getMailConfigDto(ctx.db);
      await ctx.db.query(
        `update mail_configs set mailbox=$2, allowed_sender=$3, subject_pattern=$4, require_dmarc_pass=$5,
                business_key_strategy=$6, updated_by=$7, updated_at=now() where id=$1`,
        [current.id, mailbox, allowedSender, str(body.subjectPattern, 'subjectPattern'), body.requireDmarcPass === true, strategy, session.userId],
      );
      await audit(ctx.db, session.userId, 'mail_config.update', 'mail_config', current.id, {});
      const dto: MailConfigDto = await getMailConfigDto(ctx.db);
      return ok(dto);
    }
  }

  if (a === 'runs') {
    if (parts.length === 1) {
      if (is('GET', '/runs')) return ok({ runs: await listRunDtos(ctx.db) });
      if (is('POST', '/runs')) {
        requireRole(session, WRITE_ROLES);
        const body = asObject(req.body);
        const run = await createRun(ctx, {
          actor: session.userId,
          dateFrom: str(body.dateFrom, 'dateFrom', 10),
          dateTo: str(body.dateTo, 'dateTo', 10),
        });
        return ok(run, 201);
      }
    }
    if (parts.length === 2 && is('GET', '/runs/:id')) return ok(await getRunDetail(ctx.db, runId(b)));
    if (parts.length === 3 && c === 'step' && is('POST', '/runs/:id/step')) {
      requireRole(session, WRITE_ROLES);
      return ok(await stepRun(ctx, runId(b), session.userId));
    }
    if (parts.length === 3 && c === 'export' && is('POST', '/runs/:id/export')) {
      requireRole(session, WRITE_ROLES);
      const result = await generateExport(ctx, runId(b), session.userId);
      return ok(result);
    }
    if (parts.length === 4 && c === 'export' && d === 'url' && is('GET', '/runs/:id/export/url')) {
      const id = runId(b);
      const latest = (await getRunExports(ctx.db, id)).find((x) => x.status === 'ready' && x.storagePath);
      if (!latest?.storagePath) throw new AppError(404, 'EXPORT_NOT_READY', 'Aún no hay un Excel generado para esta ejecución');
      const url = await ctx.storage.signedUrl(latest.storagePath, SIGNED_URL_TTL_SECONDS);
      await audit(ctx.db, session.userId, 'export.download_link', 'import_run', id, {});
      return ok({ url, expiresInSeconds: SIGNED_URL_TTL_SECONDS });
    }
  }

  const recon = await dispatchRecon(ctx, session, parts, method, is, req);
  if (recon) return recon;

  throw new AppError(404, 'NOT_FOUND', 'Ruta no encontrada');
}

async function dispatchRecon(
  ctx: AppContext,
  session: Session,
  parts: string[],
  method: string,
  is: (m: string, route: string) => boolean,
  req: HttpRequest,
): Promise<HttpResponse | null> {
  const [a, b, c, d] = parts;
  const deps = { db: ctx.db, storage: ctx.storage, silog: ctx.silog, defaultNit: ctx.config.silog.terpelNit };
  const id = (seg: string | undefined): string => {
    if (!isUuid(seg)) throw new AppError(400, 'INVALID_ID', 'Identificador inválido');
    return seg;
  };

  if (a === 'silogtran' && b === 'sync' && parts.length === 2 && is('POST', '/silogtran/sync')) {
    requireRole(session, WRITE_ROLES);
    const body = asObject(req.body);
    return ok(await syncStep(deps, body.dateFrom, body.dateTo, body.cursor, session.userId));
  }

  if (a === 'reconciliations') {
    if (parts.length === 1) {
      if (is('GET', '/reconciliations')) return ok({ runs: await listReconRuns(ctx.db) });
      if (is('POST', '/reconciliations')) {
        requireRole(session, WRITE_ROLES);
        const body = asObject(req.body);
        const run = await createReconRun(deps, { actor: session.userId, dateFrom: body.dateFrom, dateTo: body.dateTo, sync: body.sync === false ? false : true });
        return ok(run, 201);
      }
    }
    if (parts.length === 2 && is('GET', '/reconciliations/:id')) return ok(await getReconDetail(ctx.db, id(b)));
    if (parts.length === 3 && c === 'step' && is('POST', '/reconciliations/:id/step')) {
      requireRole(session, WRITE_ROLES);
      return ok(await stepReconRun(deps, id(b), session.userId, async (dp, rid, actor) => void (await generateReconExport(dp, rid, actor))));
    }
    if (parts.length === 3 && c === 'results' && is('GET', '/reconciliations/:id/results')) {
      const st = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : null;
      return ok({ results: await listResults(ctx.db, id(b), st) });
    }
    if (parts.length === 3 && c === 'export' && is('POST', '/reconciliations/:id/export')) {
      requireRole(session, WRITE_ROLES);
      return ok(await generateReconExport(ctx, id(b), session.userId));
    }
    if (parts.length === 4 && c === 'export' && d === 'url' && is('GET', '/reconciliations/:id/export/url')) {
      const run = await getReconRun(ctx.db, id(b));
      const row = await ctx.db.query<{ export_path: string | null }>('select export_path from reconciliation_runs where id=$1', [run.id]);
      const path = row.rows[0]?.export_path;
      if (!path || run.exportStatus !== 'ready') throw new AppError(404, 'EXPORT_NOT_READY', 'Aún no hay un Excel generado para esta conciliación');
      const url = await ctx.storage.signedUrl(path, SIGNED_URL_TTL_SECONDS);
      await audit(ctx.db, session.userId, 'recon_export.download_link', 'reconciliation_run', run.id, {});
      return ok({ url, expiresInSeconds: SIGNED_URL_TTL_SECONDS });
    }
  }

  if (a === 'reconciliation-results' && parts.length === 3) {
    if (c === 'resolve' && is('POST', '/reconciliation-results/:id/resolve')) {
      requireRole(session, WRITE_ROLES);
      return ok(await resolveResult(ctx.db, session.userId, id(b), asObject(req.body).recordId));
    }
    if (c === 'alias' && is('POST', '/reconciliation-results/:id/alias')) {
      requireRole(session, ['admin']);
      const body = asObject(req.body);
      return ok(await addAliasAndReconcile(ctx.db, session.userId, id(b), body.silogName, body.terpelName));
    }
  }

  if (a === 'recon-params' && parts.length === 1 && is('GET', '/recon-params')) return ok(await getParams(ctx.db, ctx.config.silog.terpelNit));

  if (a === 'match-filters' && parts.length === 1 && is('PUT', '/match-filters')) {
    requireRole(session, ['admin']);
    const body = asObject(req.body);
    if (!Array.isArray(body.filters)) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: filters');
    return ok({ filters: await saveFilters(ctx.db, session.userId, body.filters as MatchFilterDto[]) });
  }
  if (a === 'recon-settings' && parts.length === 1 && is('PUT', '/recon-settings')) {
    requireRole(session, ['admin']);
    const body = asObject(req.body);
    return ok(await saveSettings(ctx.db, session.userId, body as unknown as ReconSettingsDto));
  }
  if (a === 'place-aliases') {
    if (parts.length === 1 && is('GET', '/place-aliases')) return ok({ aliases: await loadAliases(ctx.db) });
    if (parts.length === 1 && is('POST', '/place-aliases')) {
      requireRole(session, ['admin']);
      const body = asObject(req.body);
      return ok(await upsertAlias(ctx.db, session.userId, body.silogName, body.terpelName), 201);
    }
    if (parts.length === 2 && is('PUT', '/place-aliases/:id')) {
      requireRole(session, ['admin']);
      const body = asObject(req.body);
      return ok(await upsertAlias(ctx.db, session.userId, body.silogName, body.terpelName, id(b)));
    }
    if (parts.length === 2 && is('DELETE', '/place-aliases/:id')) {
      requireRole(session, ['admin']);
      await deleteAlias(ctx.db, session.userId, id(b));
      return ok({ ok: true });
    }
  }
  void method;
  return null;
}
