import { useEffect, useState } from 'react';
import type { AssistedPlanDto, AssistedRunDetailDto, AssistedRunDto, MeDto, WriterStatusDto } from '../../core/types';
import { api } from './api';

const CATEGORY_LABEL: Record<string, string> = {
  terpel_pending: 'Pendiente de Terpel (volumen 0)', ambiguous: 'Ambiguo', no_match: 'Sin coincidencia en Silogtran', insufficient: 'Datos insuficientes',
  already_adjusted: 'Ya ajustado', needs_review: 'Requiere revisión', not_allowed: 'Fuera de la lista de remesas permitidas', applied: 'Ya aplicada',
  attention: 'Requiere atención', not_eligible: 'No elegible para el modo asistido',
};
const RESULT_LABEL: Record<string, string> = { applied: 'Aplicada', skipped: 'Omitida', halted: 'Detenida', failed: 'Falló', pending: 'Pendiente' };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');
const fmt = (v: { peso: string; cantidad: string; tarifa: string } | null): string => (v ? `peso ${v.peso}, cantidad ${v.cantidad}, tarifa ${v.tarifa}` : '—');

export function Assisted({ reconRunId, me, writer, onChanged }: { reconRunId: string; me: MeDto; writer: WriterStatusDto | null; onChanged: () => void }) {
  const allowed = me.permissions.includes('adjustments.approve') && me.permissions.includes('adjustments.apply');
  const [plan, setPlan] = useState<AssistedPlanDto | null>(null);
  const [run, setRun] = useState<AssistedRunDetailDto | null>(null);
  const [existing, setExisting] = useState<AssistedRunDto | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const real = writer?.mode === 'web';

  useEffect(() => {
    setPlan(null); setRun(null); setConfirm(false);
    if (!reconRunId) return;
    api.assistedList(reconRunId).then((r) => setExisting(r.runs.find((x) => x.status !== 'completed') ?? null)).catch(() => undefined);
  }, [reconRunId]);

  if (!allowed) return null;

  const drive = async (id: string, resume: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      let d = await api.assistedStep(id, resume);
      setRun(d);
      for (let i = 0; i < 500 && d.run.status === 'running'; i += 1) {
        d = await api.assistedStep(id);
        setRun(d);
      }
      if (d.run.status === 'halted') setMsg(`La corrida se DETUVO: ${d.run.haltedReason ?? ''}. Lo que queda pendiente no se tocó.`);
      onChanged();
    } catch (e) {
      setMsg(`${errMsg(e)} Puede reanudar la corrida: lo ya aplicado no se repite.`);
      try { setRun(await api.assistedGet(id)); } catch { /* sin conexión */ }
    } finally { setBusy(false); }
  };

  const loadPlan = async () => {
    setBusy(true); setMsg(null); setRun(null); setConfirm(false);
    try { setPlan(await api.assistedPlan(reconRunId)); onChanged(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const start = async () => {
    if (!plan) return;
    setBusy(true); setMsg(null);
    try {
      const d = await api.assistedCreate(reconRunId, plan.eligible.map((e) => e.proposalId));
      setRun(d); setPlan(null); setExisting(null);
      await drive(d.run.id, false);
    } catch (e) { setMsg(errMsg(e)); setBusy(false); }
  };
  const resumeExisting = async () => {
    if (!existing) return;
    const d = await api.assistedGet(existing.id);
    setRun(d);
    await drive(existing.id, existing.status === 'halted');
  };
  const download = async (id: string) => {
    try { const { url } = await api.assistedExport(id); const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; a.click(); } catch (e) { setMsg(errMsg(e)); }
  };

  const progress = run ? Math.round(((run.run.total - run.run.pending) / Math.max(run.run.total, 1)) * 100) : 0;
  return (
    <section className="card" aria-labelledby="asis-title" data-testid="assisted-panel">
      <h2 id="asis-title">Modo asistido</h2>
      <p className="muted">Un solo flujo con confirmación: aprueba, ensaya y aplica las propuestas elegibles de esta conciliación, una por una, y entrega un reporte. Si algo queda incierto, se detiene y no toca el resto.</p>
      <div className="row">
        <button className="primary" onClick={loadPlan} disabled={busy || !reconRunId} data-testid="assisted-plan-button">Modo asistido</button>
        {existing && !run && <button onClick={resumeExisting} disabled={busy} data-testid="assisted-resume-existing">Reanudar corrida {existing.status === 'halted' ? 'detenida' : 'interrumpida'} ({existing.applied}/{existing.total})</button>}
      </div>
      {msg && <div className="alert warn" role="status" data-testid="assisted-msg">{msg}</div>}

      {plan && (
        <div data-testid="assisted-plan">
          {plan.writer.mode === 'web'
            ? <div className="alert error" data-testid="assisted-real-banner">ESCRITURA REAL en Silogtran. Solo remesas permitidas: {plan.writer.allowAll ? 'TODAS' : plan.writer.allowlist.join(', ') || '(ninguna)'}.</div>
            : <div className="alert warn" data-testid="assisted-sim-banner">MODO SIMULADO: Silogtran no se modifica.</div>}
          <p><b data-testid="assisted-eligible-count">{plan.eligible.length}</b> propuesta(s) se aprobarán, ensayarán y aplicarán; <b>{plan.excluded.length}</b> quedan fuera.</p>
          <div className="table-wrap">
            <table data-testid="assisted-eligible">
              <thead><tr><th>Transporte</th><th>Remesa</th><th>Peso actual → propuesto</th><th>Cantidad</th><th>Tarifa</th></tr></thead>
              <tbody>
                {plan.eligible.map((e) => (
                  <tr key={e.proposalId}><td className="mono">{e.transportNumber}</td><td className="mono">{e.remesaCode}</td><td className="mono">{e.current.peso ?? '—'} → {e.proposed.peso}</td><td className="mono">{e.current.cantidad ?? '—'} → {e.proposed.cantidad}</td><td className="mono">{e.current.tarifa ?? '—'} → {e.proposed.tarifa}</td></tr>
                ))}
                {plan.eligible.length === 0 && <tr><td colSpan={5} className="muted">No hay propuestas elegibles.</td></tr>}
              </tbody>
            </table>
          </div>
          {plan.excluded.length > 0 && (
            <details data-testid="assisted-excluded"><summary>Quedan fuera ({plan.excluded.length}) y por qué</summary>
              <div className="table-wrap"><table><thead><tr><th>Transporte</th><th>Remesa</th><th>Categoría</th><th>Motivo</th></tr></thead>
                <tbody>{plan.excluded.map((x, i) => <tr key={i}><td className="mono">{x.transportNumber}</td><td className="mono">{x.remesaCode ?? '—'}</td><td>{CATEGORY_LABEL[x.category] ?? x.category}</td><td className="wrap">{x.reason}</td></tr>)}</tbody></table></div>
            </details>
          )}
          {plan.eligible.length > 0 && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="assisted-confirm" />
                {real ? 'Entiendo que se escribirá en Silogtran (escritura real)' : 'Entiendo que se registrará como aplicación SIMULADA (Silogtran no se modifica)'}
              </label>
              <button className="primary" onClick={start} disabled={!confirm || busy} data-testid="assisted-start">Aprobar, ensayar y aplicar {plan.eligible.length} propuesta(s)</button>
            </>
          )}
        </div>
      )}

      {run && (
        <div data-testid="assisted-run">
          <p>Estado: <b data-testid="assisted-status">{run.run.status === 'completed' ? 'Completada' : run.run.status === 'halted' ? 'DETENIDA' : 'En curso'}</b>{run.run.simulated ? ' · SIMULADA' : ' · ESCRITURA REAL'}</p>
          <progress value={progress} max={100} data-testid="assisted-progress" /> {progress}% · aplicadas {run.run.applied} · omitidas {run.run.skipped} · pendientes {run.run.pending}
          {run.run.status === 'halted' && <div className="alert error" data-testid="assisted-halted">Corrida detenida: {run.run.haltedReason}. El resto quedó pendiente, sin tocar. <button onClick={() => drive(run.run.id, true)} disabled={busy} data-testid="assisted-resume">Reanudar (omite lo detenido)</button></div>}
          <div className="table-wrap">
            <table data-testid="assisted-items">
              <thead><tr><th>#</th><th>Transporte</th><th>Remesa</th><th>Resultado</th><th>Antes → después</th><th>Reversa</th><th>Motivo</th></tr></thead>
              <tbody>
                {run.items.map((i) => (
                  <tr key={i.position} data-testid="assisted-item"><td>{i.position}</td><td className="mono">{i.transportNumber}</td><td className="mono">{i.remesaCode}</td><td>{RESULT_LABEL[i.result] ?? i.result}</td>
                    <td className="wrap">{fmt(i.before)} → {fmt(i.after)}</td><td className="wrap">{fmt(i.reversal)}</td><td className="wrap">{i.reason ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {(run.run.status === 'completed' || run.run.status === 'halted') && (
            <>
              <p className="muted" data-testid="assisted-report-note">Reporte: {run.run.applied} aplicada(s), {run.run.skipped} omitida(s), {run.run.pending} pendiente(s), {run.run.excluded.length} excluida(s) del plan. La facturación se hace en la pestaña «Facturación».</p>
              <button onClick={() => download(run.run.id)} data-testid="assisted-download">Descargar reporte (.xlsx)</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
