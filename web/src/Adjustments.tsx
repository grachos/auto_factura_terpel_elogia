import { useCallback, useEffect, useState } from 'react';
import type { AdjustSettingsDto, ApplyPreviewDto, MeDto, ProposalDto, ProposalEventDto, PublicConfigDto, ReconRunDto, RehearsalDto, WriterStatusDto } from '../../core/types';
import { api } from './api';

const STATUS_LABEL: Record<string, string> = {
  proposed: 'Propuesta', needs_review: 'Requiere revisión', approved: 'Aprobada', applying: 'Aplicando', applied: 'Aplicada',
  simulated_applied: 'SIMULADA', failed: 'Falló', uncertain: 'Resultado incierto', verification_failed: 'Verificación fallida',
  rejected: 'Rechazada', stale: 'Obsoleta', discarded: 'Simulación descartada',
};
const REVIEW_LABEL: Record<string, string> = {
  TARIFF_NOT_EXACT: 'La tarifa no es un decimal exacto', TARIFF_TOO_LONG: 'La tarifa exacta no cabe en 12 caracteres', INVALID_INPUT: 'Galones o valor inválidos',
  NOT_CUMPLIDO: 'El registro ya no está CUMPLIDO', ALREADY_INVOICED: 'El registro ya tiene factura',
  CURRENT_VALUES_UNAVAILABLE: 'No se pudieron leer los valores reales de la remesa (no se asumen)', ALREADY_ADJUSTED: 'Ya ajustado: no hace falta proponer un cambio',
};
const EVENT_LABEL: Record<string, string> = {
  generated: 'Propuesta generada', regenerated: 'Propuesta regenerada', superseded: 'Reemplazada por otra propuesta', approved: 'Aprobada', rejected: 'Rechazada',
  apply_started: 'Aplicación iniciada', simulated_applied: 'Aplicada en modo SIMULADO (Silogtran no se modificó)', applied: 'Aplicada y verificada en Silogtran',
  verification_failed: 'Verificación posterior fallida', stale: 'Obsoleta: Silogtran cambió', conflict: 'Conflicto en Silogtran', uncertain: 'Resultado incierto',
  checked_not_applied: 'Consulta: el cambio no se aplicó', rehearsed: 'Ensayo realizado (sin grabar)', reversal_created: 'Se creó una propuesta de reversa', check_unknown: 'Consulta: estado desconocido', discarded: 'Simulación descartada',
  precheck_failed: 'No se pudo releer Silogtran', writer_unavailable: 'Escritor no disponible', lease_expired: 'Aplicación sin respuesta',
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');
const when = (v: string | null): string => (v ? new Date(v).toLocaleString('es-CO') : '—');
const num = (v: string | null): string => (v === null ? 'no disponible' : v);

function Badge({ p }: { p: ProposalDto }) {
  if (p.reviewCode === 'ALREADY_ADJUSTED') return <span className="badge adj-applied" data-testid="adj-already">Ya ajustado</span>;
  return <span className={`badge adj-${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}{p.simulated ? ' · simulado' : ''}</span>;
}

type Confirm = { kind: 'apply' | 'batch'; ids: string[]; previews: ApplyPreviewDto[]; rehearsals: RehearsalDto[] };

export function Adjustments({ cfg: _cfg, me, writer, onWriter }: { cfg: PublicConfigDto; me: MeDto; writer: WriterStatusDto | null; onWriter: (w: WriterStatusDto) => void }) {
  const has = (p: string): boolean => me.permissions.includes(p);
  const [runs, setRuns] = useState<ReconRunDto[]>([]);
  const [runId, setRunId] = useState('');
  const [items, setItems] = useState<ProposalDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<ProposalEventDto[]>([]);
  const [msg, setMsg] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<ApplyPreviewDto | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [settings, setSettings] = useState<AdjustSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const mock = !writer || writer.mode === 'mock';
  const [rehearsal, setRehearsal] = useState<RehearsalDto | null>(null);
  const [allowText, setAllowText] = useState('');

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setItems((await api.listProposals(id)).proposals);
  }, []);
  useEffect(() => {
    api.listRecon().then((r) => {
      const done = r.runs.filter((x) => x.status === 'completed');
      setRuns(done);
      if (done[0]) { setRunId(done[0].id); void load(done[0].id); }
    }).catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
    api.adjustSettings().then((x) => { setSettings(x); setAllowText(x.writerAllowlist.join(', ')); }).catch(() => undefined);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); setMsg({ kind: 'info', text: ok }); await load(runId); if (open) setEvents((await api.proposalDetail(open)).events); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const toggle = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setPreview(null);
    try { setEvents((await api.proposalDetail(id)).events); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const askApply = async (ids: string[], kind: 'apply' | 'batch') => {
    try {
      const previews = await Promise.all(ids.map((id) => api.simulateProposal(id)));
      // Escritura REAL: antes de confirmar se hace el ensayo (todos los pasos menos Grabar) y se muestran los valores y la reversa.
      const rehearsals = mock ? [] : await Promise.all(ids.map((id) => api.rehearseProposal(id)));
      setConfirm({ kind, ids, previews, rehearsals });
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const doConfirm = async () => {
    if (!confirm) return;
    const c = confirm;
    setConfirm(null);
    await act(async () => {
      if (c.kind === 'apply') await api.applyProposal(c.ids[0] as string);
      else {
        const r = await api.applyBatch(c.ids);
        setMsg({ kind: r.results.every((x) => x.ok) ? 'info' : 'warn', text: r.results.map((x) => `${x.ok ? 'OK' : (x.code ?? 'ERROR')}`).join(' · ') });
      }
      setSelected(new Set());
    }, mock ? 'Aplicación SIMULADA registrada. Silogtran no se modificó.' : 'Aplicación registrada.');
  };
  const download = async () => {
    try { const { url } = await api.exportAdjustments(runId); const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; a.click(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  const approvable = items.filter((p) => p.status === 'approved' || p.status === 'failed');
  return (
    <>
      <section className="card" aria-labelledby="adj-title" data-testid="adj-panel">
        <h2 id="adj-title">Ajustes de tarifa</h2>
        <p className="muted">
          Los valores actuales se leen de la consulta de la remesa en Silogtran (el informe no refleja el peso ni la cantidad). Para cada servicio con diferencias se calcula la nueva tarifa (valor de Terpel ÷ galones, decimal exacto de hasta 12 caracteres con punto). Si no es exacta, queda en revisión y no se puede aprobar.
        </p>
        <div className="row">
          <label>Conciliación
            <select value={runId} onChange={(e) => { setRunId(e.target.value); void load(e.target.value); setOpen(null); }} data-testid="adj-run">
              {runs.map((r) => <option key={r.id} value={r.id}>{r.dateFrom} → {r.dateTo} ({r.id.slice(0, 8)})</option>)}
              {runs.length === 0 && <option value="">Sin conciliaciones completadas</option>}
            </select>
          </label>
          {has('adjustments.generate') && <button className="primary" disabled={!runId || busy} data-testid="adj-generate" onClick={() => act(async () => { const s = await api.generateProposals(runId); setMsg({ kind: 'info', text: `Propuestas: ${s.created} nuevas, ${s.unchanged} sin cambios, ${s.needsReview} en revisión.` }); }, 'Propuestas generadas.')}>Generar propuestas</button>}
          <button disabled={!runId || items.length === 0} onClick={download} data-testid="adj-export">Descargar Excel</button>
          {has('adjustments.apply') && <button disabled={busy || selected.size === 0} onClick={() => askApply([...selected], 'batch')} data-testid="adj-batch">Aplicar seleccionadas ({selected.size})</button>}
          {has('adjustments.config') && <button onClick={() => act(async () => { const r = await api.discardSimulated(); setMsg({ kind: 'info', text: `Simulaciones descartadas: ${r.discarded}.` }); }, 'Listo.')} data-testid="adj-discard">Descartar simulaciones</button>}
        </div>
        {msg && <div className={`alert ${msg.kind}`} role="status" data-testid="adj-msg">{msg.text}</div>}
        <div className="table-wrap">
          <table data-testid="adj-table">
            <thead><tr><th /><th>Transporte</th><th>Remesa</th><th>Estado</th><th>Galones</th><th>Tarifa nueva</th><th>Total actual → propuesto</th><th>Motivo</th></tr></thead>
            <tbody>
              {items.map((p) => (
                <FragmentRows key={p.id} p={p} open={open === p.id} onToggle={() => toggle(p.id)}
                  checked={selected.has(p.id)} onSelect={(c) => { const n = new Set(selected); if (c) n.add(p.id); else n.delete(p.id); setSelected(n); }}
                  events={events} preview={preview} has={has} busy={busy}
                  onSimulate={async () => { try { setPreview(await api.simulateProposal(p.id)); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } }}
                  rehearsal={rehearsal} mock={mock} onRehearse={async (real) => { try { setRehearsal(await api.rehearseProposal(p.id, real)); await load(runId); setEvents((await api.proposalDetail(p.id)).events); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } }}
                  onRevert={() => act(() => api.revertProposal(p.id), 'Propuesta de reversa creada: apruébela y aplíquela como cualquier otra.')}
                  onApprove={() => act(() => api.approveProposal(p.id), 'Propuesta aprobada.')}
                  onReject={() => act(() => api.rejectProposal(p.id), 'Propuesta rechazada.')}
                  onApply={() => askApply([p.id], 'apply')}
                  onCheck={() => act(() => api.checkProposal(p.id), 'Estado consultado.')} />
              ))}
              {items.length === 0 && <tr><td colSpan={8} className="muted">Sin propuestas. Use «Generar propuestas» sobre una conciliación completada.</td></tr>}
            </tbody>
          </table>
        </div>
        {approvable.length > 0 && <p className="muted">{approvable.length} propuesta(s) lista(s) para aplicar.</p>}
      </section>

      {settings && has('adjustments.view') && (
        <section className="card" aria-labelledby="adj-settings" data-testid="adj-settings">
          <h2 id="adj-settings">Razón de cambio y automático</h2>
          <fieldset disabled={!has('adjustments.config')} style={{ border: 0, padding: 0, margin: 0 }}>
            <label>Plantilla de la razón de cambio (marcadores permitidos: {'{transport}'}, {'{expense}'}, {'{remesa}'}, {'{manifest}'})
              <input value={settings.reasonTemplate} maxLength={200} onChange={(e) => setSettings({ ...settings, reasonTemplate: e.target.value })} data-testid="adj-template" />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <input type="checkbox" checked={settings.autoEnabled} onChange={(e) => setSettings({ ...settings, autoEnabled: e.target.checked })} />
              Permitir aplicación automática (gancho apagado por defecto; no hay orquestador todavía)
            </label>
            <label>Escritor de ajustes
              <select value={settings.writerMode} onChange={(e) => setSettings({ ...settings, writerMode: e.target.value as 'mock' | 'web' })} data-testid="adj-writer-mode">
                <option value="mock">Simulado (Silogtran no se modifica)</option>
                <option value="web">ESCRITURA REAL en Silogtran</option>
              </select>
            </label>
            <label>Remesas permitidas para escritura real (códigos separados por coma)
              <input value={allowText} onChange={(e) => setAllowText(e.target.value)} data-testid="adj-allowlist" placeholder="p. ej. 0101228393" />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <input type="checkbox" checked={settings.writerAllowAll} onChange={(e) => setSettings({ ...settings, writerAllowAll: e.target.checked })} data-testid="adj-allow-all" />
              Permitir la escritura real en TODAS las remesas (pide confirmación)
            </label>
            {has('adjustments.config') && <button onClick={() => act(async () => {
              const list = allowText.split(/[\s,;]+/).filter(Boolean);
              let confirmAll = false;
              if (settings.writerAllowAll) confirmAll = window.confirm('Esto permite escribir en TODAS las remesas de Silogtran. ¿Confirma?');
              if (settings.writerAllowAll && !confirmAll) return;
              if (settings.writerMode === 'web' && !window.confirm('Se activará la ESCRITURA REAL en Silogtran. ¿Confirma?')) return;
              const saved = await api.saveAdjustSettings({ ...settings, writerAllowlist: list, confirmAll });
              setSettings(saved);
              setAllowText(saved.writerAllowlist.join(', '));
              onWriter(await api.writerStatus());
            }, 'Parámetros de ajustes guardados.')} data-testid="adj-save-settings">Guardar</button>}
          </fieldset>
        </section>
      )}

      {confirm && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar aplicación" data-testid="adj-confirm">
          <div className="card">
            <h2>Confirmar aplicación</h2>
            {mock ? <div className="alert warn">MODO SIMULADO: Silogtran no se modifica.</div> : <div className="alert error" data-testid="adj-real-warning">ESCRITURA REAL en Silogtran: este cambio SÍ se graba.</div>}
            <p>Se {mock ? 'registrará como SIMULADA' : 'escribirá en Silogtran'} el cambio de tarifa de {confirm.previews.length} remesa(s)
              {confirm.previews[0]?.accountUser ? ` con la cuenta de ajustes «${confirm.previews[0].accountUser}»` : ' (sin cuenta de ajustes configurada)'}:</p>
            <ul>
              {confirm.previews.map((v) => (
                <li key={v.proposalId}>{v.payload ? `Remesa ${v.payload.remesaCode}: peso/cantidad ${v.payload.pesoRemesa}, nueva tarifa ${v.payload.nuevaTarifa}` : 'Sin datos para enviar'}{v.blocked ? ` · bloqueada: ${v.blocked}` : ''}</li>
              ))}
            </ul>
            {confirm.rehearsals.map((r) => (
              <div key={r.proposalId} className="muted" data-testid="adj-confirm-rehearsal">
                Remesa {r.payload.remesaCode}: enviará peso {r.payload.pesoRemesa}, cantidad {r.payload.cantidadRemesa}, tarifa {r.payload.nuevaTarifa}.
                Reversa (valores actuales de la pantalla): {r.before ? `peso ${r.before.peso}, cantidad ${r.before.cantidad}, tarifa ${r.before.tarifa}` : 'no disponible'}.
                {r.allChecksOk ? ' Comprobaciones: todas correctas.' : ` Comprobaciones fallidas: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`}
              </div>
            ))}
            <div className="row">
              <button className="primary" onClick={doConfirm} disabled={!mock && confirm.rehearsals.some((r) => !r.allChecksOk)} data-testid="adj-confirm-ok">{mock ? 'Aplicar (simulado)' : 'Aplicar (ESCRITURA REAL)'}</button>
              <button onClick={() => setConfirm(null)} data-testid="adj-confirm-cancel">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function FragmentRows(props: {
  p: ProposalDto; open: boolean; onToggle: () => void; checked: boolean; onSelect: (c: boolean) => void; events: ProposalEventDto[]; preview: ApplyPreviewDto | null;
  has: (p: string) => boolean; busy: boolean; onSimulate: () => void; onApprove: () => void; onReject: () => void; onApply: () => void; onCheck: () => void; onRehearse: (real: boolean) => void; mock: boolean; onRevert: () => void; rehearsal: RehearsalDto | null;
}) {
  const { p } = props;
  const applicable = p.status === 'approved' || p.status === 'failed';
  return (
    <>
      <tr className="clickable" data-testid="adj-row" data-transport={p.transportNumber} onClick={props.onToggle}>
        <td onClick={(e) => e.stopPropagation()}>
          {applicable && props.has('adjustments.apply') && <input type="checkbox" checked={props.checked} onChange={(e) => props.onSelect(e.target.checked)} aria-label={`Seleccionar ${p.transportNumber}`} data-testid="adj-select" />}
        </td>
        <td className="mono">{p.transportNumber}</td>
        <td className="mono">{p.remesaCode ?? '—'}</td>
        <td data-testid="adj-status"><Badge p={p} /></td>
        <td className="mono">{p.gallons ?? '—'}</td>
        <td className="mono">{p.tariff ?? '—'}</td>
        <td className="mono">{p.currentTotal ?? '—'} → {p.targetValue ?? '—'}</td>
        <td className="wrap">{p.reviewCode ? `${REVIEW_LABEL[p.reviewCode] ?? p.reviewCode}` : p.lastError ?? '—'}</td>
      </tr>
      {props.open && (
        <tr className="detail"><td colSpan={8} data-testid="adj-detail">
          <div className="cols2">
            <div>
              <h3>Cambio propuesto</h3>
              <table>
                <thead><tr><th>Campo</th><th>Valor actual</th><th>Valor propuesto</th><th>Regla</th></tr></thead>
                <tbody>{p.lines.map((l) => <tr key={l.field}><td>{l.label}</td><td className="mono">{num(l.current)}</td><td className="mono">{l.proposed ?? '—'}</td><td className="wrap">{l.rule}</td></tr>)}</tbody>
              </table>
              <p className="muted">Razón de cambio: {p.reason}<br />Manifiesto {p.manifest ?? '—'} · gasto {p.expenseNumber ?? '—'} · peso {p.weightSource === 'silogtran' ? 'de Silogtran (volumen Terpel en 0)' : 'de Terpel'}</p>
              {p.reviewDetail && <div className="alert warn">{p.reviewDetail}</div>}
              {p.simulated && <div className="alert info" data-testid="adj-simulated">SIMULADO: Silogtran no fue modificado. No debe tratarse como ajustado.</div>}
              {p.status === 'verification_failed' && <div className="alert error">La verificación posterior no coincide: no se factura.</div>}
              <div className="row">
                <button onClick={props.onSimulate} disabled={props.busy || !props.has('adjustments.apply')} data-testid="adj-simulate">Simular</button>
                {['proposed', 'approved', 'failed'].includes(p.status) && props.has('adjustments.apply') && <button onClick={() => props.onRehearse(false)} disabled={props.busy} data-testid="adj-rehearse">Ensayo</button>}
                {props.mock && ['proposed', 'approved', 'failed'].includes(p.status) && props.has('adjustments.apply') && <button onClick={() => props.onRehearse(true)} disabled={props.busy} data-testid="adj-rehearse-real">Ensayo contra la pantalla real (sin grabar)</button>}
                {p.kind === 'adjust' && !p.simulated && ['applied', 'verification_failed', 'uncertain'].includes(p.status) && p.reversalValues && props.has('adjustments.approve') && <button onClick={props.onRevert} disabled={props.busy} data-testid="adj-revert">Revertir</button>}
                {p.status === 'proposed' && props.has('adjustments.approve') && <button onClick={props.onApprove} disabled={props.busy} data-testid="adj-approve">Aprobar</button>}
                {['proposed', 'needs_review', 'approved', 'failed'].includes(p.status) && props.has('adjustments.approve') && <button onClick={props.onReject} disabled={props.busy} data-testid="adj-reject">Rechazar</button>}
                {applicable && props.has('adjustments.apply') && <button className="primary" onClick={props.onApply} disabled={props.busy} data-testid="adj-apply">Aplicar</button>}
                {p.status === 'uncertain' && props.has('adjustments.apply') && <button onClick={props.onCheck} disabled={props.busy} data-testid="adj-check">Consultar estado</button>}
              </div>
              {props.rehearsal && props.rehearsal.proposalId === p.id && (
                <div className="alert info" data-testid="adj-rehearsal">
                  <b>Ensayo {props.rehearsal.simulated ? '(simulado)' : '(pantalla real, sin grabar)'}:</b> se enviaría remesa {props.rehearsal.payload.remesaCode}, peso {props.rehearsal.payload.pesoRemesa}, cantidad {props.rehearsal.payload.cantidadRemesa}, tarifa {props.rehearsal.payload.nuevaTarifa}, razón «{props.rehearsal.payload.reason}».
                  {' '}Valores anteriores (reversa): {props.rehearsal.before ? `peso ${props.rehearsal.before.peso}, cantidad ${props.rehearsal.before.cantidad}, tarifa ${props.rehearsal.before.tarifa}` : 'no disponible en modo simulado'}.
                  <ul>{props.rehearsal.checks.map((c, i) => <li key={i}>{c.ok ? 'OK' : 'FALLÓ'}: {c.name}{c.detail ? ` (${c.detail})` : ''}</li>)}</ul>
                </div>
              )}
              {p.reversalValues && <p className="muted" data-testid="adj-reversal-values">Valores de reversa guardados: peso {p.reversalValues.peso}, cantidad {p.reversalValues.cantidad}, tarifa {p.reversalValues.tarifa}.</p>}
              {p.kind === 'reversal' && <div className="alert warn">Esta es una REVERSA de otro ajuste.</div>}
              {props.preview && props.preview.proposalId === p.id && (
                <pre className="mono" data-testid="adj-preview">{JSON.stringify(props.preview.payload, null, 2)}{'\n'}{props.preview.simulated ? '(simulado: no se envía a Silogtran)' : `Cuenta: ${props.preview.accountUser ?? '—'}`}{props.preview.blocked ? `\nBloqueada: ${props.preview.blocked}` : ''}</pre>
              )}
            </div>
            <div>
              <h3>Línea de tiempo</h3>
              <ol data-testid="adj-timeline" className="timeline">
                {props.events.map((e) => (
                  <li key={e.id}>
                    <b>{EVENT_LABEL[e.event] ?? e.event}</b> · {when(e.at)} · {e.actor ?? 'sistema'}{e.simulated ? ' · simulado' : ''}
                    {e.fromStatus && e.toStatus && <span className="muted"> ({STATUS_LABEL[e.fromStatus] ?? e.fromStatus} → {STATUS_LABEL[e.toStatus] ?? e.toStatus})</span>}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}
