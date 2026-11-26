import { useCallback, useEffect, useRef, useState } from 'react';
import type { DifferenceDto, ManualCandidateDto, MeDto, PublicConfigDto, ReconResultDto, ReconRunDto, TraceStepDto } from '../../core/types';
import { api, ApiError } from './api';

const STATUS_LABEL: Record<string, string> = {
  EXACT: 'Exacto',
  MATCH_WITH_DIFFERENCES: 'Con diferencias',
  AMBIGUOUS: 'Ambiguo',
  NO_MATCH: 'Sin registro en Silogtran',
  INSUFFICIENT_DATA: 'Datos insuficientes',
  pending: 'Pendiente', syncing: 'Sincronizando Silogtran', reconciling: 'Conciliando', completed: 'Completada', failed: 'Con error', ready: 'Listo',
};
const FILTER_LABEL: Record<string, string> = { driver: 'Conductor', plate: 'Placa', route: 'Ruta', date: 'Fecha' };
const FIELD_LABEL: Record<string, string> = { volume: 'Volumen (galones)', value: 'Valor', plate: 'Placa' };
const REVIEW = ['AMBIGUOUS', 'NO_MATCH', 'INSUFFICIENT_DATA'];
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmt = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : Number.isFinite(Number(v)) ? Number(v).toLocaleString('es-CO', { maximumFractionDigits: 2 }) : String(v);

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{STATUS_LABEL[value] ?? value}</span>;
}

function Trace({ trace }: { trace: TraceStepDto[] }) {
  return (
    <table data-testid="trace-table">
      <thead><tr><th>Filtro</th><th>Modo</th><th>Candidatos antes</th><th>Después</th><th>Nota</th></tr></thead>
      <tbody>
        {trace.map((t) => (
          <tr key={t.filter}>
            <td>{FILTER_LABEL[t.filter]}</td>
            <td>{t.mode === 'exclusive' ? 'Excluyente' : 'Preferente'}</td>
            <td>{t.before}</td><td>{t.after}</td>
            <td>{t.skipped ? (t.reason === 'inactive' ? 'Inactivo' : t.reason === 'would_empty' ? 'Ignorado: habría dejado 0 candidatos' : 'Sin dato de Terpel') : ''}</td>
          </tr>
        ))}
        {trace.length === 0 && <tr><td colSpan={5} className="muted">No se aplicaron filtros.</td></tr>}
      </tbody>
    </table>
  );
}

function Diffs({ diffs }: { diffs: DifferenceDto[] }) {
  if (diffs.length === 0) return <span className="muted">Sin diferencias</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
      {diffs.map((d, i) => (
        <li key={i} className={d.severity === 'adjustable' ? 'diff-adjustable' : 'muted'}>
          {d.note ? d.note : `${FIELD_LABEL[d.field] ?? d.field}: Terpel ${fmt(d.terpel)} vs Silogtran ${fmt(d.silogtran)} (${d.severity === 'adjustable' ? 'a ajustar' : 'informativa'})`}
        </li>
      ))}
    </ul>
  );
}

function ManualAssign({ r, canWrite, onReplace }: { r: ReconResultDto; canWrite: boolean; onReplace: (r: ReconResultDto) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [list, setList] = useState<ManualCandidateDto[]>([]);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const search = async (term: string) => { try { setList((await api.manualCandidates(r.id, term)).candidates); setMsg(null); } catch (e) { setMsg(errMsg(e)); } };
  const assign = async (c: ManualCandidateDto) => {
    let reassign = false;
    if (c.assignedTo) {
      if (!window.confirm(`La remesa ${c.remesaCode} ya está asignada al transporte ${c.assignedTo}. ¿Reasignarla a este servicio? Aquel quedará sin coincidencia.`)) return;
      reassign = true;
    }
    try { onReplace(await api.assignManual(r.id, c.id, reason, reassign)); setOpen(false); } catch (e) { setMsg(errMsg(e)); }
  };
  return (
    <div data-testid="manual-assign" style={{ marginTop: '.5rem' }}>
      {!open ? <button disabled={!canWrite} onClick={() => { setOpen(true); void search(''); }} data-testid="manual-open">Asignar remesa manualmente</button> : (
        <>
          <h3>Asignar remesa manualmente</h3>
          <div className="row">
            <label>Remesa o manifiesto<input value={q} onChange={(e) => setQ(e.target.value)} data-testid="manual-q" /></label>
            <button onClick={() => void search(q)} data-testid="manual-search">Buscar</button>
            <label>Motivo (obligatorio)<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="manual-reason" /></label>
          </div>
          {msg && <div className="alert warn" data-testid="manual-msg">{msg}</div>}
          <table data-testid="manual-candidates"><thead><tr><th>Manifiesto/Remesa</th><th>Despacho</th><th>Placa</th><th>Total</th><th>Asignada a</th><th /></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id}><td className="mono">{c.manifest}/{c.remesaCode}</td><td>{c.dispatchDate}</td><td>{c.plate}{c.suggested ? ' ★' : ''}</td><td className="mono">{fmt(c.totalRemesa)}</td><td>{c.assignedTo ?? '—'}</td>
                <td><button disabled={reason.trim().length < 3} onClick={() => void assign(c)} data-testid="manual-pick">Asignar</button></td></tr>
            ))}{list.length === 0 && <tr><td colSpan={6} className="muted">Sin registros CUMPLIDO de Terpel sin factura.</td></tr>}</tbody></table>
        </>
      )}
    </div>
  );
}

function ResultDetail({ r, canWrite, isAdmin, onResolve, onAlias, onReplace }: {
  r: ReconResultDto; canWrite: boolean; isAdmin: boolean; onReplace: (r: ReconResultDto) => void;
  onResolve: (resultId: string, recordId: string) => void; onAlias: (resultId: string, silog: string, terpel: string) => void;
}) {
  const [silogName, setSilogName] = useState('');
  const [terpelName, setTerpelName] = useState('');
  const failedRoute = r.status === 'NO_MATCH' && r.trace.some((t) => t.filter === 'route' && t.after === 0 && !t.skipped);
  return (
    <div className="cols2" data-testid="result-detail">
      <div>
        <h3>Regla aplicada</h3>
        <p className="muted">{r.reason} · reglas {r.rulesVersion}</p>
        <Trace trace={r.trace} />
        <h3 style={{ marginTop: '.75rem' }}>Diferencias</h3>
        <Diffs diffs={r.differences} />
        {r.manual && <p className="muted" data-testid="manual-note">Asignada manualmente por {r.resolvedBy} el {r.resolvedAt ? new Date(r.resolvedAt).toLocaleString('es-CO') : ''}{r.resolvedNote ? `: ${r.resolvedNote}` : ''}.{' '}
          {canWrite && <button onClick={async () => { try { onReplace(await api.unassignManual(r.id)); } catch { /* sin permiso */ } }} data-testid="manual-remove">Quitar asignación manual</button>}</p>}
      </div>
      <div>
        <h3>Silogtran (referencia)</h3>
        {r.silog ? (
          <p className="muted">
            Manifiesto {r.silog.manifest} · remesa {r.silog.remesaCode} · despacho {r.silog.dispatchDate ?? '—'}<br />
            Peso neto cargue {fmt(r.silog.netLoadWeight)} · tarifa {fmt(r.silog.rate)} · estado {r.silog.status ?? '—'} / {r.silog.remesaStatus ?? '—'}<br />
            Factura: {r.silog.invoice ? `ya tiene (${r.silog.invoice})` : 'no tiene'}
          </p>
        ) : <p className="muted">Sin registro elegido.</p>}
        {(r.status === 'NO_MATCH' || (r.status === 'INSUFFICIENT_DATA' && r.reasonCode === 'MISSING_DATA')) && <ManualAssign r={r} canWrite={canWrite} onReplace={onReplace} />}
        {r.status === 'AMBIGUOUS' && (
          <>
            <h3>Candidatos</h3>
            <table data-testid="candidates-table">
              <thead><tr><th>Manifiesto</th><th>Despacho</th><th>Placa</th><th>Peso remesa</th><th>Total remesa</th><th /></tr></thead>
              <tbody>
                {r.candidates.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.manifest}/{c.remesaCode}</td><td>{c.dispatchDate}</td><td>{c.plate}</td>
                    <td className="mono">{fmt(c.remesaWeight)}</td><td className="mono">{fmt(c.totalRemesa)}</td>
                    <td><button disabled={!canWrite} data-testid="pick-candidate" onClick={() => onResolve(r.id, c.id)}>Elegir este</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {failedRoute && isAdmin && (
          <form
            data-testid="alias-form"
            onSubmit={(e) => { e.preventDefault(); onAlias(r.id, silogName, terpelName); }}
            className="row" style={{ marginTop: '.5rem' }}
          >
            <label>Nombre en Silogtran<input value={silogName} onChange={(e) => setSilogName(e.target.value)} required data-testid="alias-silog" /></label>
            <label>Nombre en Terpel<input value={terpelName} onChange={(e) => setTerpelName(e.target.value)} required data-testid="alias-terpel" /></label>
            <button type="submit" data-testid="alias-submit">Agregar equivalencia</button>
          </form>
        )}
        {failedRoute && !isAdmin && <p className="muted">La ruta no coincide por el nombre de algún lugar. Un administrador puede agregar la equivalencia.</p>}
      </div>
    </div>
  );
}

export function Reconciliation({ cfg, me }: { cfg: PublicConfigDto; me: MeDto }) {
  const canWrite = me.permissions.includes('recon.run');
  const isAdmin = me.permissions.includes('params.edit');
  const [range, setRange] = useState(cfg.mailSource === 'mock' ? { from: '2026-01-01', to: '2026-01-31' } : defaultMonth());
  const [runs, setRuns] = useState<ReconRunDto[]>([]);
  const [run, setRun] = useState<ReconRunDto | null>(null);
  const [results, setResults] = useState<ReconResultDto[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [review, setReview] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string; resumeId?: string } | null>(null);
  const cancel = useRef(false);

  const refreshRuns = useCallback(async () => setRuns((await api.listRecon()).runs), []);
  const load = useCallback(async (id: string) => {
    const d = await api.reconDetail(id);
    setRun(d.run);
    setResults(d.results);
  }, []);

  useEffect(() => {
    refreshRuns().catch((e) => setNotice({ kind: 'error', text: errMsg(e) }));
    return () => { cancel.current = true; };
  }, [refreshRuns]);

  const drive = useCallback(async (id: string) => {
    cancel.current = false;
    setDriving(true);
    setNotice(null);
    try {
      let leased = 0;
      for (let i = 0; i < 500 && !cancel.current; i += 1) {
        try {
          const r = await api.stepRecon(id);
          leased = 0;
          setRun(r.run);
          if (r.run.status === 'failed') {
            setNotice({ kind: 'error', text: r.message ?? `La conciliación se detuvo (${r.run.errorCode ?? 'error'}).` });
            break;
          }
          if (r.done) break;
          if (r.message) setNotice({ kind: 'warn', text: `${r.message}. Reintentando…` });
          else setNotice(null);
          if (r.retryAfterMs) await sleep(r.retryAfterMs);
        } catch (e) {
          if (e instanceof ApiError && e.code === 'RUN_LEASED' && leased < 5) { leased += 1; await sleep(2000); continue; }
          throw e;
        }
      }
      await load(id);
      await refreshRuns();
    } catch (e) {
      setNotice({ kind: 'error', text: errMsg(e) });
    } finally {
      setDriving(false);
    }
  }, [load, refreshRuns]);

  const start = async () => {
    setNotice(null);
    try {
      const created = await api.createRecon(range.from, range.to);
      setRun(created);
      setResults([]);
      await drive(created.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ACTIVE_RUN_EXISTS') setNotice({ kind: 'warn', text: e.message, resumeId: (e.details?.runId as string | undefined) ?? undefined });
      else setNotice({ kind: 'error', text: errMsg(e) });
    }
  };

  const replace = (r: ReconResultDto) => setResults((prev) => prev.map((x) => (x.id === r.id ? r : x)));
  const onResolve = async (resultId: string, recordId: string) => {
    try { replace(await api.resolveResult(resultId, recordId)); setNotice({ kind: 'info', text: 'Candidato elegido y registrado en la auditoría.' }); if (run) await refreshCounts(run.id); } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };
  const onAlias = async (resultId: string, silog: string, terpel: string) => {
    try { replace(await api.addAlias(resultId, silog, terpel)); setNotice({ kind: 'info', text: 'Equivalencia guardada y servicio conciliado de nuevo.' }); if (run) await refreshCounts(run.id); } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };
  const refreshCounts = async (id: string) => { const d = await api.reconDetail(id); setRun(d.run); };

  const download = async (id: string) => {
    try {
      const { url } = await api.reconExportUrl(id);
      const a = document.createElement('a');
      a.href = url; a.rel = 'noopener'; a.click();
    } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };
  const regenerate = async (id: string) => {
    try {
      const r = await api.reconRegenerate(id);
      setNotice(r.status === 'ready' ? { kind: 'info', text: 'Excel regenerado desde la base de datos.' } : { kind: 'error', text: 'No se pudo generar el Excel.' });
      await load(id);
    } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); }
  };

  const visible = results.filter((r) => (review ? REVIEW.includes(r.status) : true) && (statusFilter ? r.status === statusFilter : true));
  const progress = run ? progressOf(run) : null;

  return (
    <>
      <section className="card" aria-labelledby="recon-new">
        <h2 id="recon-new">Conciliar con Silogtran</h2>
        <p className="muted">
          Rango por fecha de descargue de Terpel. Silogtran (solo lectura) se consulta desde unos días antes para encontrar el despacho.
          {cfg.silogSource === 'mock' && ' Modo demostración: Silogtran simulado con datos ficticios.'}
          {cfg.silogSource === 'none' && ' Silogtran no está configurado en el servidor (faltan SILOG_BASE_URL, SILOG_USER y SILOG_PASSWORD).'}
        </p>
        <div className="row">
          <label>Desde<input type="date" data-testid="recon-from" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label>Hasta<input type="date" data-testid="recon-to" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button className="primary" onClick={start} disabled={!canWrite || driving} data-testid="recon-button">{driving ? 'Conciliando…' : 'Conciliar'}</button>
        </div>
        <p className="muted" data-testid="recon-informe-note">El informe de Silogtran no trae el peso cumplido ni refleja los ajustes de peso/cantidad. Regla (recon-1.3.0, vigente en recon-1.4.0): si el total de la remesa coincide exactamente con el valor de Terpel, el servicio es EXACTO (sin diferencia de volumen ni de valor); el volumen solo se reporta cuando el total NO coincide.</p>
        {!canWrite && <p className="muted">Su rol es de solo lectura.</p>}
        {driving && progress && <p data-testid="recon-progress"><progress value={progress.value} max={progress.max} /> {progress.text}</p>}
        {notice && (
          <div className={`alert ${notice.kind}`} role="status" data-testid="recon-notice">
            {notice.text}{' '}
            {notice.resumeId && canWrite && <button className="link" onClick={() => drive(notice.resumeId as string)}>Reanudar la conciliación activa</button>}
          </div>
        )}
      </section>

      {run && (
        <section className="card" aria-labelledby="recon-results" data-testid="recon-panel">
          <h2 id="recon-results">Conciliación {run.id.slice(0, 8)} · {run.dateFrom} a {run.dateTo}</h2>
          <p>Estado: <span data-testid="recon-status"><Badge value={run.status} /></span> · Ventana {run.windowDays} días · Reglas {run.rulesVersion}</p>
          <div className="tiles">
            <div className="tile"><b data-testid="recon-total">{run.totalServices}</b><span>Servicios</span></div>
            <div className="tile"><b data-testid="recon-exact">{run.exact}</b><span>Exactos</span></div>
            <div className="tile"><b data-testid="recon-diff">{run.withDifferences}</b><span>Con diferencias</span></div>
            <div className="tile"><b data-testid="recon-amb">{run.ambiguous}</b><span>Ambiguos</span></div>
            <div className="tile"><b data-testid="recon-nomatch">{run.noMatch}</b><span>Sin registro</span></div>
            <div className="tile"><b data-testid="recon-insuf">{run.insufficient}</b><span>Datos insuficientes</span></div>
          </div>
          {run.status === 'completed' && (
            <div className="row">
              <button className="primary" onClick={() => download(run.id)} disabled={run.exportStatus !== 'ready'} data-testid="recon-download">Descargar Excel</button>
              {canWrite && <button onClick={() => regenerate(run.id)}>Regenerar Excel</button>}
              <label>Estado
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="recon-status-filter">
                  <option value="">Todos</option>
                  {['EXACT', 'MATCH_WITH_DIFFERENCES', 'AMBIGUOUS', 'NO_MATCH', 'INSUFFICIENT_DATA'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} data-testid="recon-review" /> Bandeja de revisión
              </label>
            </div>
          )}
          {results.length > 0 && (
            <div className="table-wrap">
              <table data-testid="recon-table">
                <thead>
                  <tr><th>Transporte</th><th>Descargue</th><th>Terpel (ruta · placa · galones · valor)</th><th>Silogtran (manifiesto · despacho · placa · peso · total)</th><th>Estado</th><th>Motivo</th><th>Peso Fase 3</th><th>Diferencias</th></tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <FragmentRow key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} canWrite={canWrite} isAdmin={isAdmin} onResolve={onResolve} onAlias={onAlias} onReplace={replace} />
                  ))}
                  {visible.length === 0 && <tr><td colSpan={8} className="muted">Sin resultados para este filtro.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="recon-history">
        <h2 id="recon-history">Historial de conciliaciones</h2>
        <div className="table-wrap">
          <table data-testid="recon-history">
            <thead><tr><th>Inicio</th><th>Rango</th><th>Estado</th><th>Servicios</th><th>Acciones</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} data-testid="recon-history-row">
                  <td>{new Date(r.createdAt).toLocaleString('es-CO')}</td>
                  <td>{r.dateFrom} → {r.dateTo}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{r.totalServices}</td>
                  <td>
                    <button className="link" onClick={() => load(r.id).catch((e) => setNotice({ kind: 'error', text: errMsg(e) }))}>Ver</button>
                    {canWrite && r.status !== 'completed' && <button className="link" disabled={driving} onClick={() => { setRun(r); void drive(r.id); }}>Reanudar</button>}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && <tr><td colSpan={5} className="muted">Aún no hay conciliaciones.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function FragmentRow({ r, open, toggle, canWrite, isAdmin, onResolve, onAlias, onReplace }: {
  onReplace: (r: ReconResultDto) => void;
  r: ReconResultDto; open: boolean; toggle: () => void; canWrite: boolean; isAdmin: boolean;
  onResolve: (a: string, b: string) => void; onAlias: (a: string, b: string, c: string) => void;
}) {
  return (
    <>
      <tr className="clickable" onClick={toggle} data-testid="recon-row" data-transport={r.transportNumber}>
        <td className="mono">{r.transportNumber}</td>
        <td>{r.serviceDate}</td>
        <td>{r.terpel.route ?? '—'} · {r.terpel.plate ?? '—'} · {fmt(r.terpel.volume)} · {fmt(r.terpel.netValue)}</td>
        <td>
          {r.silog
            ? `${r.silog.manifest} · ${r.silog.dispatchDate ?? '—'} · ${r.silog.plate ?? '—'} · ${fmt(r.silog.remesaWeight)} · ${fmt(r.silog.totalRemesa)}`
            : r.status === 'AMBIGUOUS' ? `${r.candidates.length} candidatos` : '—'}
        </td>
        <td><Badge value={r.status} />{r.manual && <span className="muted"> (manual)</span>}</td>
        <td className="wrap" data-testid="recon-reason">{r.reasonCode ? `${r.reasonCode}: ` : ''}{r.status === 'INSUFFICIENT_DATA' || r.reasonCode ? r.reason : '—'}</td>
        <td data-testid="recon-weight-source">{r.weightSource === 'terpel' ? 'Terpel' : r.weightSource === 'silogtran' ? 'Silogtran' : '—'}</td>
        <td className="wrap">{r.differences.filter((d) => d.severity === 'adjustable').map((d) => FIELD_LABEL[d.field] ?? d.field).join(', ') || '—'}</td>
      </tr>
      {open && <tr className="detail"><td colSpan={8}><ResultDetail r={r} canWrite={canWrite} isAdmin={isAdmin} onResolve={onResolve} onAlias={onAlias} onReplace={onReplace} /></td></tr>}
    </>
  );
}

function progressOf(run: ReconRunDto): { value: number; max: number; text: string } {
  if (run.status === 'syncing' && run.syncCursor && run.syncEnd) {
    return { value: 0, max: 1, text: `Sincronizando Silogtran… ${run.syncCursor} de ${run.syncEnd}` };
  }
  return { value: run.reconcileOffset, max: Math.max(run.totalServices, 1), text: `Conciliando servicios… ${run.reconcileOffset}/${run.totalServices}` };
}

function defaultMonth(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
}
