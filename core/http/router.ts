import { getUserRole } from '../auth.js';
import { DEMO_USERS } from '../auth.js';
import { isAppToken, verifyAppToken } from '../appAuth.js';
import { can, permissionsOf } from '../permissions.js';
import type { Permission } from '../permissions.js';
import { silogLogin } from '../silogLogin.js';
import { generateAdjustExport } from '../adjust/excel.js';
import {
  applyBatch, applyProposal, approveProposal, checkUncertain, discardSimulated, generateProposals, getAdjustSettings, getEvents, getProposal,
  listProposals, rejectProposal, saveAdjustSettings, simulateProposal,
} from '../adjust/service.js';
import {
  createUser, deleteUserPassword, listServiceCredentials, listUsers, parsePurpose, saveServiceCredential, saveUserPassword, testServiceCredential,
  testUserCredential, updateUser,
} from '../users.js';
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
  kind: 'supabase' | 'silogtran';
  displayName: string | null;
  silogUser: string | null;
}

async function authenticate(ctx: AppContext, req: HttpRequest): Promise<Session> {
  const token = bearer(req.headers);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Inicie sesión para continuar');
  if (isAppToken(token)) {
    // Token propio (ingreso con usuario de Silogtran): el usuario y su rol se comprueban en BD en CADA petición.
    const claims = await verifyAppToken(ctx.config.security.appSessionSecret, token);
    if (!claims) throw new AppError(401, 'UNAUTHENTICATED', 'Sesión inválida o vencida');
    const r = await ctx.db.query<{ id: string; silog_user: string; display_name: string | null; role: Role; active: boolean; session_version: number }>(
      'select id, silog_user, display_name, role, active, session_version from app_users where id = $1',
      [claims.id],
    );
    const u = r.rows[0];
    if (!u || !u.active || u.session_version !== claims.sessionVersion) throw new AppError(401, 'UNAUTHENTICATED', 'Sesión inválida o vencida');
    return { userId: u.id, email: null, role: u.role, kind: 'silogtran', displayName: u.display_name, silogUser: u.silog_user };
  }
  const user = await ctx.auth.verify(token);
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Sesión inválida o vencida');
  const role = await getUserRole(ctx.db, user.id);
  if (!role) throw new AppError(403, 'NO_ROLE', 'Su usuario no tiene un rol asignado');
  return { userId: user.id, email: user.email, role, kind: 'supabase', displayName: null, silogUser: null };
}

function requirePermission(s: Session, p: Permission): void {
  if (!can(s.role, p)) throw new AppError(403, 'FORBIDDEN', 'No tiene permisos para esta acción');
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
      writerKind: ctx.writer.kind,
      silogLogin: !!ctx.silogAuth && ctx.config.security.appSessionSecret.length >= 32,
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

  if (a === 'auth' && b === 'silog-login' && parts.length === 2 && is('POST', '/auth/silog-login')) {
    const body = asObject(req.body);
    const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || req.headers['x-real-ip'] || req.headers['x-remote-addr'] || 'unknown';
    try {
      return ok(await silogLogin(ctx, { usuario: body.usuario, clave: body.clave, ip }));
    } catch (e) {
      if (e instanceof AppError && e.code === 'TOO_MANY_ATTEMPTS') {
        const res = errorResponse(e);
        res.headers = { ...res.headers, 'Retry-After': String(e.details?.retryAfterSeconds ?? 900) };
        return res;
      }
      throw e;
    }
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
    const me: MeDto = {
      id: session.userId, email: session.email, role: session.role, permissions: permissionsOf(session.role),
      displayName: session.displayName, silogUser: session.silogUser, loginKind: session.kind,
    };
    return ok(me);
  }

  if (a === 'mail-config' && parts.length === 1) {
    if (is('GET', '/mail-config')) {
      requirePermission(session, 'mail.config'); // misma regla que RLS: mail_configs solo para administradores
      return ok(await getMailConfigDto(ctx.db));
    }
    if (is('PUT', '/mail-config')) {
      requirePermission(session, 'mail.config');
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
        requirePermission(session, 'import.run');
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
      requirePermission(session, 'import.run');
      return ok(await stepRun(ctx, runId(b), session.userId));
    }
    if (parts.length === 3 && c === 'export' && is('POST', '/runs/:id/export')) {
      requirePermission(session, 'import.run');
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

  if (a === 'auth' && b === 'logout' && parts.length === 2 && is('POST', '/auth/logout')) {
    if (session.kind === 'silogtran') {
      await ctx.db.query('update app_users set session_version = session_version + 1 where id = $1', [session.userId]);
      await audit(ctx.db, session.userId, 'auth.logout', 'app_user', session.userId, {});
    }
    return ok({ ok: true });
  }

  const adj = await dispatchAdjust(ctx, session, parts, is, req);
  if (adj) return adj;

  const adm = await dispatchAdmin(ctx, session, parts, is, req);
  if (adm) return adm;

  const recon = await dispatchRecon(ctx, session, parts, method, is, req);
  if (recon) return recon;

  throw new AppError(404, 'NOT_FOUND', 'Ruta no encontrada');
}

async function dispatchAdjust(
  ctx: AppContext,
  session: Session,
  parts: string[],
  is: (m: string, route: string) => boolean,
  req: HttpRequest,
): Promise<HttpResponse | null> {
  const [a, b, c] = parts;
  const deps = { db: ctx.db, storage: ctx.storage, silog: ctx.silog, writer: ctx.writer };
  const uid = (seg: string | undefined): string => {
    if (!isUuid(seg)) throw new AppError(400, 'INVALID_ID', 'Identificador inválido');
    return seg;
  };
  if (a === 'reconciliations' && c === 'adjustments' && parts.length === 4 && parts[3] === 'generate' && is('POST', '/reconciliations/:id/adjustments/generate')) {
    requirePermission(session, 'adjustments.generate');
    return ok(await generateProposals(deps, uid(b), session.userId));
  }
  if (a !== 'adjustments') return null;
  if (parts.length === 1 && is('GET', '/adjustments')) {
    requirePermission(session, 'adjustments.view');
    const runId = req.query.runId;
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : null;
    let from: string | undefined;
    let to: string | undefined;
    if (runId) {
      const run = await getReconRun(ctx.db, uid(runId));
      from = run.dateFrom;
      to = run.dateTo;
    }
    return ok({ proposals: await listProposals(ctx.db, { runFrom: from, runTo: to, status }), writerKind: ctx.writer.kind, simulated: ctx.writer.simulated });
  }
  if (b === 'settings' && parts.length === 2) {
    if (is('GET', '/adjustments/settings')) {
      requirePermission(session, 'adjustments.view');
      return ok(await getAdjustSettings(ctx.db));
    }
    if (is('PUT', '/adjustments/settings')) {
      requirePermission(session, 'adjustments.config');
      const body = asObject(req.body);
      return ok(await saveAdjustSettings(ctx.db, session.userId, { reasonTemplate: body.reasonTemplate, autoEnabled: body.autoEnabled }));
    }
  }
  if (b === 'apply-batch' && parts.length === 2 && is('POST', '/adjustments/apply-batch')) {
    requirePermission(session, 'adjustments.apply');
    const ids = asObject(req.body).ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every((x) => typeof x === 'string' && isUuid(x))) {
      throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: ids (1 a 50 identificadores)');
    }
    return ok({ results: await applyBatch(deps, session.userId, ids as string[]) });
  }
  if (b === 'discard-simulated' && parts.length === 2 && is('POST', '/adjustments/discard-simulated')) {
    requirePermission(session, 'adjustments.config');
    return ok({ discarded: await discardSimulated(ctx.db, session.userId) });
  }
  if (b === 'export' && parts.length === 2 && is('POST', '/adjustments/export')) {
    requirePermission(session, 'adjustments.view');
    const r = await generateAdjustExport(deps, uid(asObject(req.body).runId as string | undefined), session.userId);
    return ok({ url: await ctx.storage.signedUrl(r.path, SIGNED_URL_TTL_SECONDS), rows: r.rows, expiresInSeconds: SIGNED_URL_TTL_SECONDS });
  }
  if (parts.length === 2 && is('GET', '/adjustments/:id')) {
    requirePermission(session, 'adjustments.view');
    return ok({ proposal: await getProposal(ctx.db, uid(b)), events: await getEvents(ctx.db, uid(b)) });
  }
  if (parts.length === 3) {
    const id = uid(b);
    if (c === 'simulate' && is('POST', '/adjustments/:id/simulate')) {
      requirePermission(session, 'adjustments.apply');
      return ok(await simulateProposal(deps, session.userId, id));
    }
    if (c === 'approve' && is('POST', '/adjustments/:id/approve')) {
      requirePermission(session, 'adjustments.approve');
      return ok(await approveProposal(ctx.db, session.userId, id));
    }
    if (c === 'reject' && is('POST', '/adjustments/:id/reject')) {
      requirePermission(session, 'adjustments.approve');
      return ok(await rejectProposal(ctx.db, session.userId, id, asObject(req.body ?? {}).reason));
    }
    if (c === 'apply' && is('POST', '/adjustments/:id/apply')) {
      requirePermission(session, 'adjustments.apply');
      return ok((await applyProposal(deps, session.userId, id)).proposal);
    }
    if (c === 'check' && is('POST', '/adjustments/:id/check')) {
      requirePermission(session, 'adjustments.apply');
      return ok(await checkUncertain(deps, session.userId, id));
    }
  }
  return null;
}

async function dispatchAdmin(
  ctx: AppContext,
  session: Session,
  parts: string[],
  is: (m: string, route: string) => boolean,
  req: HttpRequest,
): Promise<HttpResponse | null> {
  const [a, b, c, d] = parts;
  const secrets = { encryptionKey: ctx.config.security.encryptionKey };
  const uid = (seg: string | undefined): string => {
    if (!isUuid(seg)) throw new AppError(400, 'INVALID_ID', 'Identificador inválido');
    return seg;
  };
  if (a === 'users') {
    requirePermission(session, 'users.manage');
    if (parts.length === 1 && is('GET', '/users')) return ok({ users: await listUsers(ctx.db) });
    if (parts.length === 1 && is('POST', '/users')) {
      const body = asObject(req.body);
      return ok(await createUser(ctx.db, session.userId, { silogUser: body.silogUser, role: body.role, displayName: body.displayName }), 201);
    }
    if (parts.length === 2 && is('PUT', '/users/:id')) {
      const body = asObject(req.body);
      return ok(await updateUser(ctx.db, session.userId, uid(b), { role: body.role, active: body.active, displayName: body.displayName }));
    }
    if (parts.length === 3 && c === 'credential') {
      requirePermission(session, 'credentials.manage');
      if (is('PUT', '/users/:id/credential')) return ok(await saveUserPassword(ctx.db, secrets, session.userId, uid(b), asObject(req.body).password));
      if (is('DELETE', '/users/:id/credential')) return ok(await deleteUserPassword(ctx.db, session.userId, uid(b)));
    }
    if (parts.length === 4 && c === 'credential' && d === 'test' && is('POST', '/users/:id/credential/test')) {
      requirePermission(session, 'credentials.manage');
      return ok(await testUserCredential(ctx.db, secrets, ctx.silogAuth, session.userId, uid(b)));
    }
  }
  if (a === 'service-credentials') {
    requirePermission(session, 'credentials.manage');
    if (parts.length === 1 && is('GET', '/service-credentials')) return ok({ credentials: await listServiceCredentials(ctx.db) });
    if (parts.length === 2 && is('PUT', '/service-credentials/:purpose')) {
      const body = asObject(req.body);
      return ok({ credentials: await saveServiceCredential(ctx.db, secrets, session.userId, parsePurpose(b), { silogUser: body.silogUser, password: body.password }) });
    }
    if (parts.length === 3 && c === 'test' && is('POST', '/service-credentials/:purpose/test')) {
      return ok(await testServiceCredential(ctx.db, secrets, ctx.silogAuth, session.userId, parsePurpose(b)));
    }
  }
  return null;
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
    requirePermission(session, 'recon.run');
    const body = asObject(req.body);
    return ok(await syncStep(deps, body.dateFrom, body.dateTo, body.cursor, session.userId));
  }

  if (a === 'reconciliations') {
    if (parts.length === 1) {
      if (is('GET', '/reconciliations')) return ok({ runs: await listReconRuns(ctx.db) });
      if (is('POST', '/reconciliations')) {
        requirePermission(session, 'recon.run');
        const body = asObject(req.body);
        const run = await createReconRun(deps, { actor: session.userId, dateFrom: body.dateFrom, dateTo: body.dateTo, sync: body.sync === false ? false : true });
        return ok(run, 201);
      }
    }
    if (parts.length === 2 && is('GET', '/reconciliations/:id')) return ok(await getReconDetail(ctx.db, id(b)));
    if (parts.length === 3 && c === 'step' && is('POST', '/reconciliations/:id/step')) {
      requirePermission(session, 'recon.run');
      return ok(await stepReconRun(deps, id(b), session.userId, async (dp, rid, actor) => void (await generateReconExport(dp, rid, actor))));
    }
    if (parts.length === 3 && c === 'results' && is('GET', '/reconciliations/:id/results')) {
      const st = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : null;
      return ok({ results: await listResults(ctx.db, id(b), st) });
    }
    if (parts.length === 3 && c === 'export' && is('POST', '/reconciliations/:id/export')) {
      requirePermission(session, 'recon.run');
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
      requirePermission(session, 'recon.resolve');
      return ok(await resolveResult(ctx.db, session.userId, id(b), asObject(req.body).recordId));
    }
    if (c === 'alias' && is('POST', '/reconciliation-results/:id/alias')) {
      requirePermission(session, 'params.edit');
      const body = asObject(req.body);
      return ok(await addAliasAndReconcile(ctx.db, session.userId, id(b), body.silogName, body.terpelName));
    }
  }

  if (a === 'recon-params' && parts.length === 1 && is('GET', '/recon-params')) {
    requirePermission(session, 'params.view');
    return ok(await getParams(ctx.db, ctx.config.silog.terpelNit));
  }

  if (a === 'match-filters' && parts.length === 1 && is('PUT', '/match-filters')) {
    requirePermission(session, 'params.edit');
    const body = asObject(req.body);
    if (!Array.isArray(body.filters)) throw new AppError(400, 'INVALID_FIELD', 'Campo inválido: filters');
    return ok({ filters: await saveFilters(ctx.db, session.userId, body.filters as MatchFilterDto[]) });
  }
  if (a === 'recon-settings' && parts.length === 1 && is('PUT', '/recon-settings')) {
    requirePermission(session, 'params.edit');
    const body = asObject(req.body);
    return ok(await saveSettings(ctx.db, session.userId, body as unknown as ReconSettingsDto));
  }
  if (a === 'place-aliases') {
    if (parts.length === 1 && is('GET', '/place-aliases')) {
      requirePermission(session, 'params.view');
      return ok({ aliases: await loadAliases(ctx.db) });
    }
    if (parts.length === 1 && is('POST', '/place-aliases')) {
      requirePermission(session, 'params.edit');
      const body = asObject(req.body);
      return ok(await upsertAlias(ctx.db, session.userId, body.silogName, body.terpelName), 201);
    }
    if (parts.length === 2 && is('PUT', '/place-aliases/:id')) {
      requirePermission(session, 'params.edit');
      const body = asObject(req.body);
      return ok(await upsertAlias(ctx.db, session.userId, body.silogName, body.terpelName, id(b)));
    }
    if (parts.length === 2 && is('DELETE', '/place-aliases/:id')) {
      requirePermission(session, 'params.edit');
      await deleteAlias(ctx.db, session.userId, id(b));
      return ok({ ok: true });
    }
  }
  void method;
  return null;
}
