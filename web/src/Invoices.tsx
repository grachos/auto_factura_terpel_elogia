import { useEffect, useState } from 'react';
import type { InvoiceDto, InvoicePlanDto, InvoiceRehearsalDto, InvoiceRunDetailDto, InvoiceRunDto, InvoiceSettingsDto, MeDto, ReconRunDto } from '../../core/types';
import { api } from './api';

const CATEGORY_LABEL: Record<string, string> = {
  volume_zero: 'Volumen 0 en Terpel', ambiguous: 'Ambigua', no_match: 'Sin coincidencia en Silogtran', insufficient: 'Datos insuficientes', adjustment_pending: 'Ajuste pendiente',
  already_invoiced: 'Ya facturada', not_cumplido: 'No está CUMPLIDO', incomplete: 'Faltan datos', not_terpel: 'No es Terpel', not_allowed: 'Fuera de la lista permitida', attention: 'Requiere atención',
};
const RESULT_LABEL: Record<string, string> = { issued: 'Facturada', skipped: 'Omitida', halted: 'Detenida', failed: 'Falló', pending: 'Pendiente' };
const STATUS_LABEL: Record<string, string> = {
  eligible: 'Elegible', rehearsed: 'Ensayada', issuing: 'Emitiendo', issued: 'Facturada', failed: 'Falló', uncertain: 'Resultado INCIERTO', verification_failed: 'Verificación fallida',
  skipped: 'Omitida', simulated: 'SIMULADA', discarded: 'Descartada',
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');
const money = (v: string): string => Number(v).toLocaleString('es-CO');

export function Invoices({ me }: { me: MeDto }) {
  const isAdmin = me.permissions.includes('invoices.config');
  const [runs, setRuns] = useState<ReconRunDto[]>([]);
  const [reconId, setReconId] = useState('');
  const [plan, setPlan] = useState<InvoicePlanDto | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [run, setRun] = useState<InvoiceRunDetailDto | null>(null);
  const [existing, setExisting] = useState<InvoiceRunDto | null>(null);
  const [rehearsal, setRehearsal] = useState<InvoiceRehearsalDto | null>(null);
  const [settings, setSettings] = useState<InvoiceSettingsDto | null>(null);
  const [allowText, setAllowText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);

  const loadSettings = async () => { const s = await api.invoiceSettings(); setSettings(s); setAllowText(s.writerAllowlist.join(', ')); };
  useEffect(() => {
    api.listRecon().then((r) => { const done = r.runs.filter((x) => x.status === 'completed'); setRuns(done); if (done[0]) setReconId(done[0].id); }).catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
    loadSettings().catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
  }, []);
  const actionable = (st: string): boolean => ['eligible', 'rehearsed', 'failed', 'skipped'].includes(st);
  useEffect(() => {
    setPlan(null); setRun(null); setConfirm(false); setRehearsal(null);
    if (!reconId) return;
    // Al abrir la pestaña o cambiar de conciliación se carga lo ya trabajado (lectura, sin efectos).
    api.invoiceView(reconId).then((p) => { setPlan(p); setChecked(new Set(p.eligible.filter((e) => actionable(e.status)).map((e) => e.id))); }).catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
    api.invoiceRunList(reconId).then(async (r) => {
      setExisting(r.runs.find((x) => x.status !== 'completed') ?? null);
      const last = r.runs[0];
      if (last) setRun(await api.invoiceRunGet(last.id));
    }).catch(() => undefined);
  }, [reconId]);

  const real = (plan?.writer.mode ?? settings?.writerMode) === 'web';
  const batchOk = !real || !!(plan?.writer.batchEnabled ?? settings?.batchEnabled);
  const todo = plan ? plan.eligible.filter((e) => ['eligible', 'rehearsed', 'failed', 'skipped'].includes(e.status)) : [];
  const picked = todo.filter((e) => checked.has(e.id));
  const total = picked.reduce((a, e) => a + Number(e.terpelValue), 0);

  const wrap = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); } };
  const loadPlan = () => wrap(async () => {
    await api.invoicePlan(reconId);
    const p = await api.invoiceView(reconId);
    setPlan(p); setRun(null); setConfirm(false); setRehearsal(null);
    setChecked(new Set(p.eligible.filter((e) => actionable(e.status)).map((e) => e.id)));
  });
  const refresh = async () => { if (reconId) { const p = await api.invoiceView(reconId); setPlan(p); } };

  const drive = async (id: string, resume: boolean) => {
    setBusy(true); setMsg(null);
    try {
      let d = await api.invoiceRunStep(id, resume);
      setRun(d);
      for (let i = 0; i < 1000 && d.run.status === 'running'; i += 1) { d = await api.invoiceRunStep(id); setRun(d); }
      if (d.run.status === 'halted') setMsg({ kind: 'error', text: `La corrida se DETUVO: ${d.run.haltedReason ?? ''}. Lo pendiente no se tocó; verifique en Silogtran antes de reanudar.` });
    } catch (e) {
      setMsg({ kind: 'warn', text: `${errMsg(e)} Puede reanudar la corrida: lo ya facturado no se repite.` });
      try { setRun(await api.invoiceRunGet(id)); } catch { /* sin conexión */ }
    } finally { setBusy(false); try { await refresh(); } catch { /* sin conexión */ } }
  };
  const startAll = () => wrap(async () => {
    const d = await api.invoiceRunCreate(reconId, picked.map((e) => e.id));
    setRun(d); setExisting(null);
    await drive(d.run.id, false);
  });
  const rehearseOne = (e: InvoiceDto) => wrap(async () => { setRehearsal(await api.invoiceRehearse(e.id)); await refresh(); });
  const issueOne = (e: InvoiceDto) => wrap(async () => {
    const r = await api.invoiceRehearse(e.id);
    setRehearsal(r);
    if (!r.allChecksOk) { setMsg({ kind: 'warn', text: `El ensayo no pasó; no se facturó la remesa ${e.remesaCode}.` }); await refresh(); return; }
    const out = await api.invoiceIssue(e.id);
    setMsg({ kind: out.status === 'uncertain' ? 'error' : 'info', text: `Remesa ${e.remesaCode}: ${STATUS_LABEL[out.status] ?? out.status}${out.invoiceNumber ? ` · factura ${out.invoiceNumber}` : ''}` });
    await refresh();
  });
  const download = async (id: string) => { try { const { url } = await api.invoiceRunExport(id); const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; a.click(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } };
  const resumeExisting = async () => { if (!existing) return; setRun(await api.invoiceRunGet(existing.id)); await drive(existing.id, existing.status === 'halted'); };
  const toggle = (id: string) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const progress = run ? Math.round(((run.run.total - run.run.pending) / Math.max(run.run.total, 1)) * 100) : 0;
  return (
    <>
      <section className="card" aria-labelledby="inv-title" data-testid="invoices-panel">
        <h2 id="inv-title">Facturación</h2>
        <p className="muted">Una factura por remesa (cliente Terpel). Solo se facturan remesas cuyo flete en Silogtran es idéntico al valor neto de Terpel.</p>
        {real
          ? <div className="alert error" role="alert" data-testid="invoice-real-banner">EMISIÓN REAL de facturas en Silogtran. Remesas permitidas: {(plan ? plan.writer.allowAll : settings?.writerAllowAll) ? 'TODAS' : (plan?.writer.allowlist ?? settings?.writerAllowlist ?? []).join(', ') || '(ninguna)'}.</div>
          : <div className="alert warn" data-testid="invoice-sim-banner">MODO SIMULADO: no se emite ninguna factura real; Silogtran no se modifica.</div>}
        <div className="row">
          <label>Conciliación
            <select value={reconId} onChange={(e) => setReconId(e.target.value)} data-testid="invoice-recon">
              {runs.map((r) => <option key={r.id} value={r.id}>{r.dateFrom} → {r.dateTo}</option>)}
            </select>
          </label>
          <button className="primary" onClick={loadPlan} disabled={busy || !reconId} data-testid="invoice-plan-button">Generar plan de facturación</button>
          {existing && !run && <button onClick={resumeExisting} disabled={busy} data-testid="invoice-resume-existing">Reanudar corrida {existing.status === 'halted' ? 'detenida' : 'interrumpida'} ({existing.issued}/{existing.total})</button>}
        </div>
        {msg && <div className={`alert ${msg.kind === 'error' ? 'error' : 'warn'}`} role="status" data-testid="invoice-msg">{msg.text}</div>}
      </section>

      {plan && (
        <section className="card" aria-labelledby="inv-plan" data-testid="invoice-plan">
          <h2 id="inv-plan">Remesas por facturar</h2>
          <p><b data-testid="invoice-count">{picked.length}</b> de {todo.length} marcadas · flete total esperado <b data-testid="invoice-total">{money(String(total))}</b> · {plan.excluded.length} excluida(s){plan.unplanned ? ` · ${plan.unplanned} elegible(s) nueva(s) sin planificar: pulse «Generar plan de facturación»` : ''}</p>
          <div className="table-wrap">
            <table data-testid="invoice-table">
              <thead><tr><th><input type="checkbox" aria-label="Marcar o desmarcar todas las remesas" checked={todo.length > 0 && picked.length === todo.length} ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < todo.length; }} onChange={(ev) => setChecked(ev.target.checked ? new Set(todo.map((e) => e.id)) : new Set())} disabled={todo.length === 0} data-testid="invoice-check-all" /></th><th>Transporte</th><th>Remesa</th><th>Placa</th><th>Fecha</th><th>Valor Terpel</th><th>Flete esperado</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {plan.eligible.map((e) => {
                  const actionable = ['eligible', 'rehearsed', 'failed', 'skipped'].includes(e.status);
                  return (
                    <tr key={e.id} data-testid="invoice-row">
                      <td>{actionable && <input type="checkbox" aria-label={`Marcar remesa ${e.remesaCode}`} checked={checked.has(e.id)} onChange={() => toggle(e.id)} data-testid="invoice-check" />}</td>
                      <td className="mono">{e.transportNumber}</td><td className="mono">{e.remesaCode}</td><td className="mono">{e.plate ?? '—'}</td><td>{e.serviceDate}</td>
                      <td className="mono">{money(e.terpelValue)}</td><td className="mono">{money(e.expectedFreight)}</td>
                      <td className="wrap">{STATUS_LABEL[e.status] ?? e.status}{e.invoiceNumber ? ` · ${e.invoiceNumber}` : ''}{e.reviewDetail ? ` — ${e.reviewDetail}` : ''}</td>
                      <td>{actionable && (
                        <>
                          <button onClick={() => rehearseOne(e)} disabled={busy} data-testid="invoice-rehearse">Ensayo</button>{' '}
                          <button onClick={() => issueOne(e)} disabled={busy || !confirm} data-testid="invoice-issue-one">Facturar esta</button>
                        </>
                      )}
                      {e.status === 'uncertain' && <button onClick={() => wrap(async () => { await api.invoiceCheck(e.id); await refresh(); })} disabled={busy}>Consultar estado</button>}</td>
                    </tr>
                  );
                })}
                {plan.eligible.length === 0 && <tr><td colSpan={9} className="muted">No hay remesas elegibles.</td></tr>}
              </tbody>
            </table>
          </div>
          {rehearsal && (
            <details open data-testid="invoice-rehearsal"><summary>Ensayo de la remesa {rehearsal.listing?.remesa ?? ''}: {rehearsal.allChecksOk ? 'pasó todas las comprobaciones' : 'NO pasó'}</summary>
              <p className="muted">Observación: {rehearsal.observation} · Orden de compra: {rehearsal.purchaseOrder}</p>
              <ul>{rehearsal.checks.map((c, i) => <li key={i}>{c.ok ? 'OK' : 'FALLA'} · {c.name}{c.detail ? ` — ${c.detail}` : ''}</li>)}</ul>
            </details>
          )}
          {plan.excluded.length > 0 && (
            <details data-testid="invoice-excluded"><summary>Excluidas ({plan.excluded.length}) y por qué</summary>
              <div className="table-wrap"><table><thead><tr><th>Transporte</th><th>Remesa</th><th>Categoría</th><th>Motivo</th></tr></thead>
                <tbody>{plan.excluded.map((x, i) => <tr key={i}><td className="mono">{x.transportNumber}</td><td className="mono">{x.remesaCode ?? '—'}</td><td>{CATEGORY_LABEL[x.category] ?? x.category}</td><td className="wrap">{x.reason}</td></tr>)}</tbody></table></div>
            </details>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="invoice-confirm" />
            {real ? 'Entiendo que se EMITIRÁN facturas reales en Silogtran' : 'Entiendo que se registrarán facturas SIMULADAS (Silogtran no se modifica)'}
          </label>
          <button className="primary" onClick={startAll} disabled={!confirm || busy || picked.length === 0 || !batchOk} data-testid="invoice-start">Facturar todas ({picked.length})</button>
          {!batchOk && <p className="muted" data-testid="invoice-batch-off">Con escritor real, «Facturar todas» está desactivado: un administrador debe activarlo en los parámetros. Mientras tanto use «Facturar esta».</p>}
        </section>
      )}

      {run && (
        <section className="card" aria-labelledby="inv-run" data-testid="invoice-run">
          <h2 id="inv-run">Corrida de facturación</h2>
          <p>Estado: <b data-testid="invoice-status">{run.run.status === 'completed' ? 'Completada' : run.run.status === 'halted' ? 'DETENIDA' : 'En curso'}</b>{run.run.simulated ? ' · SIMULADA' : ' · EMISIÓN REAL'}</p>
          <progress value={progress} max={100} data-testid="invoice-progress" /> {progress}% · facturadas {run.run.issued} · omitidas {run.run.skipped} · pendientes {run.run.pending}
          {run.run.status === 'halted' && <div className="alert error" data-testid="invoice-halted">Corrida detenida: {run.run.haltedReason}. <button onClick={() => drive(run.run.id, true)} disabled={busy} data-testid="invoice-resume">Reanudar (omite lo detenido)</button></div>}
          <div className="table-wrap">
            <table data-testid="invoice-items">
              <thead><tr><th>#</th><th>Transporte</th><th>Remesa</th><th>Resultado</th><th>Factura</th><th>Flete / Retefuente / Total</th><th>Motivo</th></tr></thead>
              <tbody>{run.items.map((i) => (
                <tr key={i.position} data-testid="invoice-item"><td>{i.position}</td><td className="mono">{i.transportNumber}</td><td className="mono">{i.remesaCode}</td><td>{RESULT_LABEL[i.result] ?? i.result}</td>
                  <td className="mono">{i.invoiceNumber ?? '—'}</td><td className="mono">{i.amounts ? `${money(i.amounts.freight)} / ${money(i.amounts.withholding)} / ${money(i.amounts.total)}` : '—'}</td><td className="wrap">{i.reason ?? ''}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {(run.run.status === 'completed' || run.run.status === 'halted') && (
            <>
              <p className="muted" data-testid="invoice-report-note">Reporte: {run.run.issued} facturada(s), {run.run.skipped} omitida(s), {run.items.filter((i) => i.result === 'halted').length} incierta(s)/detenida(s), {run.run.pending} pendiente(s), {run.run.excluded.length} excluida(s) del plan.</p>
              <button onClick={() => download(run.run.id)} data-testid="invoice-download">Descargar reporte (.xlsx)</button>
            </>
          )}
        </section>
      )}

      {settings && isAdmin && (
        <section className="card" aria-labelledby="inv-settings" data-testid="invoice-settings">
          <h2 id="inv-settings">Parámetros de facturación (solo administrador)</h2>
          <p className="muted">La cuenta de facturación se define en Usuarios. El producto sale de la consulta de la remesa (Home_111) tal cual (p. ej. B-100).</p>
          <div className="grid2">
            {([['costCenter', 'Centro de costo'], ['client', 'Cliente'], ['seller', 'Vendedor'], ['paymentCity', 'Ciudad de pago'], ['currency', 'Moneda'], ['paymentMethod', 'Forma de pago'], ['invoiceType', 'Tipo de factura']] as const).map(([k, label]) => (
              <label key={k}>{label}<input value={settings[k]} onChange={(e) => setSettings({ ...settings, [k]: e.target.value })} data-testid={`invoice-set-${k}`} /></label>
            ))}
            <label>Días de pago<input type="number" value={settings.paymentDays} onChange={(e) => setSettings({ ...settings, paymentDays: Number(e.target.value) })} /></label>
            <label>Retefuente (%)<input type="number" step="0.01" value={settings.withholdingPercent} onChange={(e) => setSettings({ ...settings, withholdingPercent: Number(e.target.value) })} /></label>
          </div>
          <label>Plantilla de la observación ({'{product} {origin} {destination} {transport} {serviceEntrySheet}'})
            <input value={settings.observationTemplate} maxLength={200} onChange={(e) => setSettings({ ...settings, observationTemplate: e.target.value })} data-testid="invoice-set-template" />
          </label>
          <label>Escritor
            <select value={settings.writerMode} onChange={(e) => setSettings({ ...settings, writerMode: e.target.value as 'mock' | 'web' })} data-testid="invoice-set-mode">
              <option value="mock">Simulado (no emite)</option><option value="web">REAL (emite facturas en Silogtran)</option>
            </select>
          </label>
          <label>Remesas permitidas para emisión real (separadas por coma)<input value={allowText} onChange={(e) => setAllowText(e.target.value)} data-testid="invoice-set-allow" /></label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}><input type="checkbox" checked={settings.batchEnabled} onChange={(e) => setSettings({ ...settings, batchEnabled: e.target.checked })} data-testid="invoice-set-batch" /> Habilitar «Facturar todas» con escritor real</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}><input type="checkbox" checked={settings.writerAllowAll} onChange={(e) => setSettings({ ...settings, writerAllowAll: e.target.checked })} /> Permitir TODAS las remesas</label>
          <button className="primary" disabled={busy} data-testid="invoice-save-settings" onClick={() => wrap(async () => {
            let confirmAll = false;
            if (settings.writerAllowAll) confirmAll = window.confirm('Esto permite emitir facturas en TODAS las remesas. ¿Confirma?');
            if (settings.writerAllowAll && !confirmAll) return;
            if (settings.writerMode === 'web' && !window.confirm('Se activará la EMISIÓN REAL de facturas en Silogtran. ¿Confirma?')) return;
            const list = allowText.split(/[,\s]+/).filter(Boolean);
            const saved = await api.saveInvoiceSettings({ ...settings, writerAllowlist: list, confirmAll });
            setSettings(saved); setAllowText(saved.writerAllowlist.join(', '));
            setMsg({ kind: 'info', text: 'Parámetros de facturación guardados.' });
          })}>Guardar</button>
        </section>
      )}
    </>
  );
}
