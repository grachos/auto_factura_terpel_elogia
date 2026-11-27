import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { MailConfigDto, MeDto, PublicConfigDto, RunDetailDto, RunDto } from '../../core/types';
import { api, ApiError } from './api';
import { hasSession, initAuth, login, loginSilog, logout } from './auth';
import { Users } from './Users';
import { Adjustments } from './Adjustments';
import { Invoices } from './Invoices';
import { Activity } from './Activity';
import type { WriterStatusDto } from '../../core/types';
import { Reconciliation } from './Reconciliation';
import { Params } from './Params';

const ROLE_LABEL: Record<string, string> = { operator: 'Operador', admin: 'Administrador', viewer: 'Lector', facturacion: 'Facturación' };
const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente', running: 'En curso', paused: 'En pausa', completed: 'Completada', failed: 'Con error',
  ready: 'Listo', imported: 'Importado', duplicate: 'Duplicado', needs_review: 'Por revisar', ignored_sender: 'Remitente ignorado',
  ignored_subject: 'Asunto ignorado', parse_error: 'Error de lectura', info: 'Info', warning: 'Advertencia', error: 'Error',
};
const label = (s: string): string => STATUS_LABEL[s] ?? s;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{label(value)}</span>;
}

function Login({ cfg, onDone }: { cfg: PublicConfigDto; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'email' | 'silog'>('email');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'silog') await loginSilog(email, password);
      else await login(cfg, email, password);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="card">
        <h1>AutoFactura Terpel</h1>
        <p className="muted">Importación de autorizaciones de pago · Fase 1</p>
        {cfg.authMode === 'demo' && (
          <div className="alert info" data-testid="demo-banner">
            Modo demostración con datos ficticios. Usuarios de prueba (contraseña <b>demo</b>):
            <div className="row" style={{ marginTop: '.5rem' }}>
              {cfg.demoUsers.map((u) => (
                <button key={u.email} type="button" data-testid={`demo-user-${u.role}`} onClick={() => { setEmail(u.email); setPassword('demo'); }}>
                  {ROLE_LABEL[u.role]}
                </button>
              ))}
            </div>
          </div>
        )}
        {cfg.silogLogin && (
          <div className="tabs" role="tablist" aria-label="Forma de ingreso">
            <button type="button" role="tab" aria-selected={mode === 'email'} onClick={() => { setMode('email'); setEmail(''); setPassword(''); setError(null); }} data-testid="login-mode-email">Correo</button>
            <button type="button" role="tab" aria-selected={mode === 'silog'} onClick={() => { setMode('silog'); setEmail(''); setPassword(''); setError(null); }} data-testid="login-mode-silog">Usuario de Silogtran</button>
          </div>
        )}
        <form onSubmit={submit}>
          <label>{mode === 'silog' ? 'Usuario de Silogtran' : 'Correo'}
            <input data-testid="login-email" type={mode === 'silog' ? 'text' : 'email'} autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>Contraseña
            <input data-testid="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="alert error" role="alert" data-testid="login-error">{error}</div>}
          <button className="primary" type="submit" disabled={busy} data-testid="login-submit">Ingresar</button>
        </form>
      </div>
    </div>
  );
}

function defaultRange(cfg: PublicConfigDto): { from: string; to: string } {
  if (cfg.mailSource === 'mock') return { from: '2026-01-01', to: '2026-01-31' };
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${pad(now.getDate())}` };
}

export function App() {
  const [cfg, setCfg] = useState<PublicConfigDto | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  const [booting, setBooting] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const doLogout = useCallback(async () => {
    await logout();
    setMe(null);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setFatal(e.message);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.config();
        setCfg(c);
        await initAuth(c, () => setMe(null));
        if (await hasSession()) await loadMe();
      } catch (e) {
        setFatal(errMsg(e));
      } finally {
        setBooting(false);
      }
    })();
  }, [loadMe]);

  if (booting) return <main><p className="loading"><span className="spinner" aria-hidden="true" /> Cargando…</p><Activity /></main>;
  if (fatal && !me) return <main><div className="alert error" role="alert">{fatal}</div>{cfg && <Login cfg={cfg} onDone={loadMe} />}</main>;
  if (!cfg) return <main><div className="alert error">No se pudo cargar la configuración.</div></main>;
  if (!me) return <Login cfg={cfg} onDone={loadMe} />;
  return <Dashboard cfg={cfg} me={me} onLogout={doLogout} />;
}

function Dashboard({ cfg, me, onLogout }: { cfg: PublicConfigDto; me: MeDto; onLogout: () => void }) {
  const has = (p: string): boolean => me.permissions.includes(p);
  const canWrite = has('import.run');
  const [range, setRange] = useState(defaultRange(cfg));
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [detail, setDetail] = useState<RunDetailDto | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [driving, setDriving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string; resumeId?: string } | null>(null);
  const [tab, setTab] = useState<'results' | 'issues'>('results');
  const [writer, setWriter] = useState<WriterStatusDto | null>(null);
  useEffect(() => { api.writerStatus().then(setWriter).catch(() => undefined); }, []);
  const [section, setSection] = useState<'import' | 'recon' | 'adjust' | 'invoices' | 'params' | 'users'>('import');
  const cancel = useRef(false);

  const refreshRuns = useCallback(async () => setRuns((await api.listRuns()).runs), []);
  const refreshDetail = useCallback(async (id: string) => setDetail(await api.detail(id)), []);

  useEffect(() => {
    refreshRuns().catch((e) => setNotice({ kind: 'error', text: errMsg(e) }));
    return () => { cancel.current = true; };
  }, [refreshRuns]);

  const drive = useCallback(async (id: string) => {
    cancel.current = false;
    setDriving(id);
    setSelected(id);
    setNotice(null);
    try {
      let leased = 0;
      for (let i = 0; i < 2000 && !cancel.current; i += 1) {
        try {
          const r = await api.step(id);
          leased = 0;
          setRuns((prev) => prev.map((x) => (x.id === id ? r.run : x)));
          setDetail((d) => (d && d.run.id === id ? { ...d, run: r.run } : d));
          if (r.run.status === 'failed') {
            setNotice({ kind: 'error', text: `La importación se detuvo con el error ${r.run.errorCode ?? 'desconocido'}. Revise la configuración o los permisos y use "Reanudar".` });
            break;
          }
          if (r.done) break;
          if (r.run.errorCode === 'STEP_ERROR' || r.run.errorCode === 'SOURCE_ERROR') {
            setNotice({ kind: 'warn', text: 'Hubo un fallo temporal; se reintenta la página (no se pierde progreso).' });
          } else if (r.retryAfterMs) {
            setNotice({ kind: 'warn', text: `El servidor de correo pidió esperar (límite de solicitudes). Reintentando en ${Math.ceil(r.retryAfterMs / 1000)} s…` });
          } else setNotice(null);
          if (r.retryAfterMs) await sleep(Math.min(r.retryAfterMs, 30_000));
        } catch (e) {
          if (e instanceof ApiError && e.code === 'RUN_LEASED' && leased < 5) {
            leased += 1;
            await sleep(2000);
            continue;
          }
          throw e;
        }
      }
      await refreshDetail(id);
      await refreshRuns();
    } catch (e) {
      setNotice({ kind: 'error', text: errMsg(e) });
    } finally {
      setDriving(null);
    }
  }, [refreshDetail, refreshRuns]);

  const startImport = async () => {
    setNotice(null);
    try {
      const run = await api.createRun(range.from, range.to);
      setRuns((p) => [run, ...p]);
      setDetail(null);
      await drive(run.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ACTIVE_RUN_EXISTS') {
        setNotice({ kind: 'warn', text: e.message, resumeId: (e.details?.runId as string | undefined) ?? undefined });
      } else setNotice({ kind: 'error', text: errMsg(e) });
    }
  };

  const view = async (id: string) => {
    setSelected(id);
    try { await refreshDetail(id); } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };

  const download = async (id: string) => {
    try {
      const { url } = await api.exportUrl(id);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.click();
    } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };

  const regenerate = async (id: string) => {
    try {
      const r = await api.regenerate(id);
      setNotice(r.status === 'ready' ? { kind: 'info', text: 'Excel regenerado desde la base de datos.' } : { kind: 'error', text: 'No se pudo generar el Excel. Intente de nuevo.' });
      await refreshRuns();
      if (selected === id) await refreshDetail(id);
    } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };

  const run = detail?.run ?? runs.find((r) => r.id === selected) ?? null;

  return (
    <>
      <Activity />
      <header className="top">
        <h1>AutoFactura Terpel <span className="muted">· autorizaciones y conciliación</span></h1>
        <div className="who">
          <span className="badge" data-testid="mail-source">{cfg.mailSource === 'mock' ? 'Correo simulado (datos ficticios)' : 'Exchange Online'}</span>
          <span data-testid="whoami">{me.displayName ?? me.email ?? me.silogUser ?? me.id} · {ROLE_LABEL[me.role]}</span>
          <button onClick={onLogout} data-testid="logout">Salir</button>
        </div>
      </header>
      {(!writer || writer.mode === 'mock') && <div className="sim-banner" role="status" data-testid="sim-banner">MODO SIMULADO: Silogtran no se modifica</div>}
      {writer?.mode === 'web' && <div className="real-banner" role="alert" data-testid="real-banner">ESCRITURA REAL ACTIVA: {writer.allowAll ? 'TODAS las remesas' : `solo remesas permitidas: ${writer.allowlist.join(', ') || '(ninguna)'}`}</div>}
      <nav className="main-nav" aria-label="Secciones">
        <button aria-current={section === 'import' ? 'page' : undefined} onClick={() => setSection('import')} data-testid="nav-import">Importar autorizaciones</button>
        <button aria-current={section === 'recon' ? 'page' : undefined} onClick={() => setSection('recon')} data-testid="nav-recon">Conciliación</button>
        {has('adjustments.view') && <button aria-current={section === 'adjust' ? 'page' : undefined} onClick={() => setSection('adjust')} data-testid="nav-adjust">Ajustes</button>}
        {has('invoices.manage') && <button aria-current={section === 'invoices' ? 'page' : undefined} onClick={() => setSection('invoices')} data-testid="nav-invoices">Facturación</button>}
        {has('params.view') && <button aria-current={section === 'params' ? 'page' : undefined} onClick={() => setSection('params')} data-testid="nav-params">Parámetros</button>}
        {has('users.manage') && <button aria-current={section === 'users' ? 'page' : undefined} onClick={() => setSection('users')} data-testid="nav-users">Usuarios</button>}
      </nav>
      {section === 'recon' && <main><Reconciliation cfg={cfg} me={me} /></main>}
      {section === 'adjust' && has('adjustments.view') && <main><Adjustments cfg={cfg} me={me} writer={writer} onWriter={setWriter} /></main>}
      {section === 'invoices' && has('invoices.manage') && <main><Invoices me={me} /></main>}
      {section === 'params' && has('params.view') && <main><Params readOnly={!has('params.edit')} /></main>}
      {section === 'users' && has('users.manage') && <main><Users me={me} /></main>}
      <main hidden={section !== 'import'}>
        <section className="card" aria-labelledby="new-import">
          <h2 id="new-import">Nueva importación</h2>
          <p className="muted">Rango en hora de Bogotá, ambos días incluidos.</p>
          <div className="row">
            <label>Desde
              <input type="date" data-testid="date-from" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </label>
            <label>Hasta
              <input type="date" data-testid="date-to" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </label>
            <button className="primary" onClick={startImport} disabled={!canWrite || driving !== null} data-testid="import-button">
              {driving ? 'Importando…' : 'Importar'}
            </button>
          </div>
          {!canWrite && <p className="muted">Su rol es de solo lectura.</p>}
          {notice && (
            <div className={`alert ${notice.kind}`} role="status" data-testid="notice">
              {notice.text}{' '}
              {notice.resumeId && canWrite && <button className="link" onClick={() => drive(notice.resumeId as string)}>Reanudar la importación activa</button>}
            </div>
          )}
        </section>

        {run && (
          <section className="card" aria-labelledby="run-title" data-testid="run-panel">
            <h2 id="run-title">Ejecución {run.id.slice(0, 8)} · {run.dateFromLocal} a {run.dateToLocal}</h2>
            <p>
              Estado: <span data-testid="run-status"><Badge value={run.status} /></span> · Páginas: {run.pagesProcessed} · Excel: <Badge value={run.exportStatus} />
            </p>
            <div className="tiles">
              <div className="tile"><b data-testid="count-found">{run.found}</b><span>Encontrados</span></div>
              <div className="tile"><b data-testid="count-imported">{run.imported}</b><span>Importados</span></div>
              <div className="tile"><b data-testid="count-duplicates">{run.duplicates}</b><span>Duplicados</span></div>
              <div className="tile"><b data-testid="count-review">{run.needsReview}</b><span>Por revisar</span></div>
              <div className="tile"><b data-testid="count-ignored">{run.ignored}</b><span>Ignorados</span></div>
            </div>
            {run.status === 'completed' && (
              <div className="row">
                <button className="primary" onClick={() => download(run.id)} disabled={run.exportStatus !== 'ready'} data-testid="download-button">Descargar Excel</button>
                {canWrite && <button onClick={() => regenerate(run.id)} data-testid="regenerate-button">Regenerar Excel</button>}
                {run.exportStatus === 'failed' && <span className="alert error" role="alert">La generación del Excel falló. Use "Regenerar Excel".</span>}
              </div>
            )}
            {detail && detail.run.id === run.id && (
              <>
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={tab === 'results'} onClick={() => setTab('results')} data-testid="tab-results">Servicios ({detail.results.length})</button>
                  <button role="tab" aria-selected={tab === 'issues'} onClick={() => setTab('issues')} data-testid="tab-issues">Incidencias ({detail.issues.length})</button>
                </div>
                {tab === 'results' ? (
                  <div className="table-wrap">
                    <table data-testid="results-table">
                      <thead><tr><th>Clave</th><th>Resultado</th><th>Versión</th><th>Fecha servicio</th><th>Placa</th><th>Valor neto</th><th>Volumen (original → número)</th><th>Incid.</th></tr></thead>
                      <tbody>
                        {detail.results.map((r) => (
                          <tr key={r.businessKey}>
                            <td className="mono">{r.businessKey}</td>
                            <td><Badge value={r.outcome} /></td>
                            <td>{r.version}/{r.versionCount}</td>
                            <td>{r.serviceDate ?? '—'}</td>
                            <td>{r.plate ?? '—'}</td>
                            <td className="mono">{r.netValue ? `${Number(r.netValue).toLocaleString('es-CO', { minimumFractionDigits: 2 })} ${r.currency ?? ''}` : '—'}</td>
                            <td className="mono">{r.transportVolumeRaw === null ? '—' : r.transportVolumeRaw === '' ? '(vacío)' : r.transportVolumeRaw} → {r.transportVolume ?? '—'} {r.transportVolume !== null && <span className="muted">galones</span>}</td>
                            <td>{r.issueCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table data-testid="issues-table">
                      <thead><tr><th>Severidad</th><th>Código</th><th>Servicio</th><th>Campo</th><th>Detalle</th></tr></thead>
                      <tbody>
                        {detail.issues.map((i) => (
                          <tr key={i.id}>
                            <td><Badge value={i.severity} /></td>
                            <td className="mono">{i.code}</td>
                            <td className="mono">{i.businessKey ?? '—'}</td>
                            <td>{i.field ?? '—'}</td>
                            <td className="wrap">{i.detail}</td>
                          </tr>
                        ))}
                        {detail.issues.length === 0 && <tr><td colSpan={5} className="muted">Sin incidencias.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <section className="card" aria-labelledby="history">
          <h2 id="history">Historial</h2>
          <div className="table-wrap">
            <table data-testid="history-table">
              <thead><tr><th>Inicio</th><th>Rango</th><th>Estado</th><th>Encontrados</th><th>Dupl.</th><th>Revisar</th><th>Excel</th><th>Acciones</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} data-testid="history-row">
                    <td>{new Date(r.createdAt).toLocaleString('es-CO')}</td>
                    <td>{r.dateFromLocal} → {r.dateToLocal}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.found}</td>
                    <td>{r.duplicates}</td>
                    <td>{r.needsReview}</td>
                    <td><Badge value={r.exportStatus} /></td>
                    <td>
                      <button className="link" onClick={() => view(r.id)}>Ver</button>
                      {canWrite && r.status !== 'completed' && <button className="link" disabled={driving !== null} onClick={() => drive(r.id)} data-testid="resume-button">Reanudar</button>}
                      {canWrite && r.status === 'completed' && <button className="link" onClick={() => regenerate(r.id)}>Regenerar</button>}
                      {r.status === 'completed' && r.exportStatus === 'ready' && <button className="link" onClick={() => download(r.id)}>Descargar</button>}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && <tr><td colSpan={8} className="muted">Aún no hay importaciones.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {has('mail.config') && <ConfigPanel />}
      </main>
    </>
  );
}

function ConfigPanel() {
  const [c, setC] = useState<MailConfigDto | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { api.getMailConfig().then(setC).catch((e) => setMsg(errMsg(e))); }, []);
  if (!c) return msg ? <div className="alert error">{msg}</div> : null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { id: _id, ...rest } = c;
      setC(await api.saveMailConfig(rest));
      setMsg('Configuración guardada.');
    } catch (err) { setMsg(errMsg(err)); }
  };
  return (
    <section className="card" aria-labelledby="cfg" data-testid="config-panel">
      <h2 id="cfg">Configuración del buzón (solo administradores)</h2>
      <form onSubmit={save} className="row">
        <label>Buzón<input value={c.mailbox} onChange={(e) => setC({ ...c, mailbox: e.target.value })} /></label>
        <label>Remitente permitido<input value={c.allowedSender} onChange={(e) => setC({ ...c, allowedSender: e.target.value })} /></label>
        <label>Patrón de asunto<input value={c.subjectPattern} onChange={(e) => setC({ ...c, subjectPattern: e.target.value })} size={44} /></label>
        <label>Clave de negocio
          <select value={c.businessKeyStrategy} onChange={(e) => setC({ ...c, businessKeyStrategy: e.target.value as MailConfigDto['businessKeyStrategy'] })}>
            <option value="transport_number">Número de transporte</option>
            <option value="transport_expense">Transporte + gasto</option>
          </select>
        </label>
        <label>Exigir DMARC=pass
          <input type="checkbox" checked={c.requireDmarcPass} onChange={(e) => setC({ ...c, requireDmarcPass: e.target.checked })} />
        </label>
        <button type="submit">Guardar</button>
      </form>
      {msg && <p className="muted" role="status">{msg}</p>}
    </section>
  );
}
