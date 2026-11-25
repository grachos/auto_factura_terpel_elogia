import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicConfigDto } from '../../core/types';
import { api, configureAuth } from './api';

const KEY = 'af_demo_token';
let supabase: SupabaseClient | null = null;

function readStored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function writeStored(v: string | null): void {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}
let memoryToken: string | null = readStored();
// Token propio del ingreso con usuario de Silogtran (convive con la sesión de Supabase/demo).
const APP_KEY = 'af_app_token';
let appToken: string | null = null;
try {
  appToken = sessionStorage.getItem(APP_KEY);
} catch {
  appToken = null;
}
const withApp = (getter: () => Promise<string | null>) => async () => appToken ?? (await getter());

function clearApp(): void {
  appToken = null;
  try {
    sessionStorage.removeItem(APP_KEY);
  } catch {
    /* noop */
  }
}

export async function initAuth(cfg: PublicConfigDto, onLogoutRaw: () => void): Promise<void> {
  const onLogout = (): void => {
    clearApp(); // un token propio vencido no debe tapar al ingreso por correo
    onLogoutRaw();
  };
  if (cfg.authMode === 'supabase' && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    configureAuth(
      withApp(async () => (await (supabase as SupabaseClient).auth.getSession()).data.session?.access_token ?? null),
      onLogout,
    );
  } else {
    configureAuth(withApp(async () => memoryToken), onLogout);
  }
}

export async function login(cfg: PublicConfigDto, email: string, password: string): Promise<void> {
  clearApp();
  if (cfg.authMode === 'supabase') {
    if (!supabase) throw new Error('Supabase no está configurado');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Correo o contraseña incorrectos');
    return;
  }
  const { token } = await api.demoLogin(email, password);
  memoryToken = token;
  writeStored(token);
}

export async function loginSilog(usuario: string, clave: string): Promise<void> {
  const { token } = await api.silogLogin(usuario, clave);
  appToken = token;
  try {
    sessionStorage.setItem(APP_KEY, token);
  } catch {
    /* almacenamiento no disponible */
  }
}

export async function logout(): Promise<void> {
  if (appToken) {
    try {
      await api.logout();
    } catch {
      /* sesión ya vencida */
    }
    appToken = null;
    try {
      sessionStorage.removeItem(APP_KEY);
    } catch {
      /* noop */
    }
  }
  memoryToken = null;
  writeStored(null);
  if (supabase) await supabase.auth.signOut();
}

export async function hasSession(): Promise<boolean> {
  if (appToken) return true;
  if (supabase) return (await supabase.auth.getSession()).data.session !== null;
  return memoryToken !== null;
}
