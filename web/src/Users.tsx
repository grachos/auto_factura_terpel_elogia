import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { MeDto } from '../../core/types';
import { api } from './api';
import type { AppUserDto, ServiceCredentialDto } from './api';

const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', facturacion: 'Facturación', operator: 'Operador', viewer: 'Lector' };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');
const when = (v: string | null): string => (v ? new Date(v).toLocaleString('es-CO') : '—');

export function Users({ me }: { me: MeDto }) {
  const [users, setUsers] = useState<AppUserDto[]>([]);
  const [creds, setCreds] = useState<ServiceCredentialDto[]>([]);
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState({ silogUser: '', role: 'facturacion', displayName: '' });
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [svc, setSvc] = useState({ silogUser: '', password: '' });

  const load = useCallback(async () => {
    setUsers((await api.listUsers()).users);
    setCreds((await api.serviceCredentials()).credentials);
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: errMsg(e) })); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg({ kind: 'info', text: ok }); await load(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const test = async (fn: () => Promise<{ ok: boolean }>) => {
    try {
      const r = await fn();
      setMsg(r.ok ? { kind: 'info', text: 'Conexión correcta: Silogtran aceptó la credencial.' } : { kind: 'error', text: 'Silogtran rechazó la credencial guardada.' });
      await load();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await api.createUser(form.silogUser, form.role, form.displayName || undefined); setForm({ silogUser: '', role: 'facturacion', displayName: '' }); }, 'Usuario registrado. Podrá ingresar con su usuario y contraseña de Silogtran.');
  };
  const svcFor = (p: 'adjust' | 'invoice') => creds.find((c) => c.purpose === p);
  const adjust = svcFor('adjust');

  return (
    <>
      <section className="card" aria-labelledby="u-list" data-testid="users-panel">
        <h2 id="u-list">Usuarios de la aplicación</h2>
        <p className="muted">Cada persona entra con su propio usuario y contraseña de Silogtran. Solo ingresan los usuarios registrados aquí y activos. La aplicación no crea contraseñas.</p>
        <div className="table-wrap">
          <table data-testid="users-table">
            <thead><tr><th>Usuario de Silogtran</th><th>Nombre</th><th>Rol</th><th>Activo</th><th>Último ingreso</th><th>Contraseña guardada</th><th>Acciones</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid="user-row" data-user={u.silogUser}>
                  <td className="mono">{u.silogUser}</td>
                  <td>{u.displayName ?? '—'}</td>
                  <td>
                    <select value={u.role} aria-label={`Rol de ${u.silogUser}`} onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value }), 'Rol actualizado.')}>
                      {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td>{u.active ? 'Sí' : 'No'}</td>
                  <td>{when(u.lastLoginAt)}</td>
                  <td>{u.hasStoredPassword ? `Guardada (${when(u.credentialUpdatedAt)})${u.lastTestAt ? ` · prueba ${u.lastTestOk ? 'correcta' : 'fallida'} ${when(u.lastTestAt)}` : ''}` : 'No'}</td>
                  <td>
                    <button className="link" onClick={() => run(() => api.updateUser(u.id, { active: !u.active }), u.active ? 'Usuario desactivado.' : 'Usuario activado.')} disabled={u.id === me.id && u.active} data-testid="toggle-active">{u.active ? 'Desactivar' : 'Activar'}</button>
                    <button className="link" onClick={() => { setPwFor(pwFor === u.id ? null : u.id); setPw(''); }}>{u.hasStoredPassword ? 'Reemplazar contraseña' : 'Guardar contraseña'}</button>
                    {u.hasStoredPassword && <button className="link" onClick={() => test(() => api.testUserPassword(u.id))}>Probar conexión</button>}
                    {u.hasStoredPassword && <button className="link" onClick={() => run(() => api.deleteUserPassword(u.id), 'Contraseña eliminada.')}>Quitar contraseña</button>}
                    {pwFor === u.id && (
                      <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.saveUserPassword(u.id, pw); setPwFor(null); setPw(''); }, 'Contraseña de Silogtran guardada cifrada.'); }}>
                        <label>Contraseña de Silogtran (no se vuelve a mostrar)<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
                        <button type="submit">Guardar</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={7} className="muted">Aún no hay usuarios registrados.</td></tr>}
            </tbody>
          </table>
        </div>
        <form className="row" onSubmit={create}>
          <label>Usuario de Silogtran<input value={form.silogUser} onChange={(e) => setForm({ ...form, silogUser: e.target.value })} required data-testid="new-user-name" /></label>
          <label>Nombre (opcional)<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
          <label>Rol
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} data-testid="new-user-role">
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button className="primary" type="submit" data-testid="new-user-submit">Registrar usuario</button>
        </form>
      </section>

      <section className="card" aria-labelledby="u-svc" data-testid="service-panel">
        <h2 id="u-svc">Cuenta de ajustes (servicio)</h2>
        <p className="muted">
          Credencial de Silogtran con la que, en una fase posterior, se escribirá el cambio de tarifa. Debe estar sin cambio de contraseña pendiente ni verificación en dos pasos. La contraseña se guarda cifrada y no se vuelve a mostrar.
        </p>
        <p data-testid="service-adjust-status">
          {adjust?.saved ? `Guardada: usuario ${adjust.silogUser} · ${when(adjust.updatedAt)}${adjust.lastTestAt ? ` · prueba ${adjust.lastTestOk ? 'correcta' : 'fallida'} ${when(adjust.lastTestAt)}` : ''}` : 'Sin credencial guardada.'}
        </p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.saveServiceCredential('adjust', svc.silogUser, svc.password); setSvc({ silogUser: '', password: '' }); }, 'Cuenta de ajustes guardada (cifrada).'); }}>
          <label>Usuario<input value={svc.silogUser} onChange={(e) => setSvc({ ...svc, silogUser: e.target.value })} required data-testid="svc-user" /></label>
          <label>Contraseña<input type="password" autoComplete="new-password" value={svc.password} onChange={(e) => setSvc({ ...svc, password: e.target.value })} required data-testid="svc-pass" /></label>
          <button type="submit" data-testid="svc-save">{adjust?.saved ? 'Reemplazar' : 'Guardar'}</button>
          {adjust?.saved && <button type="button" onClick={() => test(() => api.testServiceCredential('adjust'))} data-testid="svc-test">Probar conexión</button>}
        </form>
      </section>
      {msg && <div className={`alert ${msg.kind}`} role="status" data-testid="users-msg">{msg.text}</div>}
    </>
  );
}
