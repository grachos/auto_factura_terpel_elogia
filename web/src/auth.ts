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

export async function initAuth(cfg: PublicConfigDto, onLogout: () => void): Promise<void> {
  if (cfg.authMode === 'supabase' && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    configureAuth(
      async () => (await (supabase as SupabaseClient).auth.getSession()).data.session?.access_token ?? null,
      onLogout,
    );
  } else {
    configureAuth(async () => memoryToken, onLogout);
  }
}

export async function login(cfg: PublicConfigDto, email: string, password: string): Promise<void> {
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

export async function logout(): Promise<void> {
  memoryToken = null;
  writeStored(null);
  if (supabase) await supabase.auth.signOut();
}

export async function hasSession(): Promise<boolean> {
  if (supabase) return (await supabase.auth.getSession()).data.session !== null;
  return memoryToken !== null;
}
