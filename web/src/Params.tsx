import { useCallback, useEffect, useState } from 'react';
import type { MatchFilterDto, PlaceAliasDto, ReconSettingsDto } from '../../core/types';
import { api } from './api';

const FILTER_LABEL: Record<string, string> = { driver: 'Conductor (cédula)', plate: 'Placa', route: 'Ruta (origen y destino, con equivalencias)', date: 'Fecha (ventana de días)' };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');

export function Params() {
  const [filters, setFilters] = useState<MatchFilterDto[]>([]);
  const [aliases, setAliases] = useState<PlaceAliasDto[]>([]);
  const [settings, setSettings] = useState<ReconSettingsDto | null>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [newAlias, setNewAlias] = useState({ silog: '', terpel: '' });
  const [edit, setEdit] = useState<{ id: string; silog: string; terpel: string } | null>(null);

  const load = useCallback(async () => {
    const p = await api.reconParams();
    setFilters([...p.filters].sort((a, b) => a.position - b.position));
    setAliases(p.aliases);
    setSettings(p.settings);
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: errMsg(e) })); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg({ kind: 'info', text: ok }); await load(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= filters.length) return;
    const next = [...filters];
    [next[i], next[j]] = [next[j] as MatchFilterDto, next[i] as MatchFilterDto];
    setFilters(next.map((f, k) => ({ ...f, position: k + 1 })));
  };
  const patch = (i: number, p: Partial<MatchFilterDto>) => setFilters(filters.map((f, k) => (k === i ? { ...f, ...p } : f)));

  return (
    <>
      <section className="card" aria-labelledby="p-filters" data-testid="params-filters">
        <h2 id="p-filters">Filtros de la cascada (solo administradores)</h2>
        <p className="muted">Se aplican en este orden. Excluyente: si deja 0 candidatos no hay coincidencia. Preferente: si dejara 0 se ignora y se deja constancia.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Orden</th><th>Filtro</th><th>Activo</th><th>Modo</th><th /></tr></thead>
            <tbody>
              {filters.map((f, i) => (
                <tr key={f.key} data-testid={`filter-${f.key}`}>
                  <td>{i + 1}</td>
                  <td>{FILTER_LABEL[f.key]}</td>
                  <td><input type="checkbox" checked={f.active} onChange={(e) => patch(i, { active: e.target.checked })} aria-label={`Activar ${f.key}`} /></td>
                  <td>
                    <select value={f.mode} onChange={(e) => patch(i, { mode: e.target.value as MatchFilterDto['mode'] })} aria-label={`Modo ${f.key}`}>
                      <option value="exclusive">Excluyente</option><option value="preferred">Preferente</option>
                    </select>
                  </td>
                  <td>
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Subir ${f.key}`}>↑</button>{' '}
                    <button onClick={() => move(i, 1)} disabled={i === filters.length - 1} aria-label={`Bajar ${f.key}`}>↓</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="primary" data-testid="save-filters" onClick={() => run(() => api.saveFilters(filters), 'Filtros guardados.')}>Guardar filtros</button>
      </section>

      {settings && (
        <section className="card" aria-labelledby="p-settings" data-testid="params-settings">
          <h2 id="p-settings">Ventanas y cliente</h2>
          <div className="row">
            <label>Ventana despacho→descargue (días)<input type="number" min={0} max={60} value={settings.windowDays} onChange={(e) => setSettings({ ...settings, windowDays: Number(e.target.value) })} data-testid="set-window" /></label>
            <label>Consultar Silogtran desde (días antes)<input type="number" min={0} max={90} value={settings.lookbackDays} onChange={(e) => setSettings({ ...settings, lookbackDays: Number(e.target.value) })} data-testid="set-lookback" /></label>
            <label>NIT de Terpel<input value={settings.terpelNit} onChange={(e) => setSettings({ ...settings, terpelNit: e.target.value })} data-testid="set-nit" /></label>
            <button className="primary" data-testid="save-settings" onClick={() => run(() => api.saveSettings(settings), 'Parámetros guardados.')}>Guardar</button>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="p-aliases" data-testid="params-aliases">
        <h2 id="p-aliases">Equivalencias de lugares</h2>
        <p className="muted">Nombre del lugar en Silogtran → nombre en Terpel (sin tildes ni mayúsculas al comparar).</p>
        <div className="table-wrap">
          <table data-testid="alias-table">
            <thead><tr><th>En Silogtran</th><th>En Terpel</th><th /></tr></thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.id}>
                  {edit?.id === a.id ? (
                    <>
                      <td><input value={edit.silog} onChange={(e) => setEdit({ ...edit, silog: e.target.value })} /></td>
                      <td><input value={edit.terpel} onChange={(e) => setEdit({ ...edit, terpel: e.target.value })} /></td>
                      <td>
                        <button onClick={() => run(async () => { await api.updateAlias(a.id, edit.silog, edit.terpel); setEdit(null); }, 'Equivalencia actualizada.')}>Guardar</button>{' '}
                        <button onClick={() => setEdit(null)}>Cancelar</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{a.silogName}</td><td>{a.terpelName}</td>
                      <td>
                        <button className="link" onClick={() => setEdit({ id: a.id, silog: a.silogName, terpel: a.terpelName })}>Editar</button>
                        <button className="link" onClick={() => run(() => api.deleteAlias(a.id), 'Equivalencia eliminada.')}>Eliminar</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.createAlias(newAlias.silog, newAlias.terpel); setNewAlias({ silog: '', terpel: '' }); }, 'Equivalencia agregada.'); }}>
          <label>En Silogtran<input value={newAlias.silog} onChange={(e) => setNewAlias({ ...newAlias, silog: e.target.value })} required data-testid="new-alias-silog" /></label>
          <label>En Terpel<input value={newAlias.terpel} onChange={(e) => setNewAlias({ ...newAlias, terpel: e.target.value })} required data-testid="new-alias-terpel" /></label>
          <button type="submit" data-testid="add-alias">Agregar</button>
        </form>
      </section>
      {msg && <div className={`alert ${msg.kind}`} role="status" data-testid="params-msg">{msg.text}</div>}
    </>
  );
}
