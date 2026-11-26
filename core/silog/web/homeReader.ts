import type { HomeReader } from '../../adjust/service.js';
import { normalizeNumberString } from '../../adjust/tariff.js';
import type { Db } from '../../db/types.js';
import { AppError } from '../../errors.js';
import { SilogWebError } from './errors.js';
import { readRemesaHome } from './remesa.js';
import type { RemesaState } from './remesa.js';
import { openWebSession } from './session.js';
import type { WafSolver } from './waf.js';

export interface WebHomeReaderDeps { db: Db; encryptionKey: string; baseUrl: string; waf: WafSolver | null; fetchFn?: () => typeof fetch | undefined }

/**
 * Lee los valores REALES de las remesas en la consulta Home_111 con la cuenta de ajustes (sesión web reutilizable).
 * Concurrencia 1 (PRADO serializa por sesión) y tolerante a fallos: lo que no se pueda leer se informa como error, nunca se asume.
 */
export class WebHomeReader implements HomeReader {
  constructor(private readonly deps: WebHomeReaderDeps) {}

  async readMany(codes: string[], actor: string | null, budgetMs: number): Promise<Map<string, RemesaState | { error: string }>> {
    const out = new Map<string, RemesaState | { error: string }>();
    if (codes.length === 0) return out;
    const fail = (e: unknown): string => (e instanceof SilogWebError || e instanceof AppError ? e.code : 'ERROR');
    let session;
    try {
      session = await openWebSession({ ...this.deps, fetchFn: this.deps.fetchFn?.() }, 'adjust', actor);
    } catch (e) {
      for (const c of codes) out.set(c, { error: fail(e) });
      return out;
    }
    const deadline = Date.now() + budgetMs;
    try {
      for (const c of codes) {
        if (Date.now() > deadline) { out.set(c, { error: 'TIME_BUDGET' }); continue; }
        try {
          out.set(c, await readRemesaHome(session.client, c));
        } catch (e) {
          out.set(c, { error: fail(e) });
        }
      }
    } finally {
      await session.close().catch(() => undefined);
    }
    return out;
  }
}

/** Demo/pruebas sin credenciales de Silogtran: deriva los valores del snapshot del informe (NO es la fuente real). */
export class SnapshotHomeReader implements HomeReader {
  constructor(private readonly db: Db) {}
  async readMany(codes: string[]): Promise<Map<string, RemesaState | { error: string }>> {
    const out = new Map<string, RemesaState | { error: string }>();
    for (const c of codes) {
      const r = await this.db.query<{ w: string | null; rate: string | null; total: string | null }>(
        `select remesa_weight::text as w, rate::text as rate, total_remesa::text as total from silogtran_records where remesa_code = $1 limit 1`, [c],
      );
      const x = r.rows[0];
      const w = normalizeNumberString(x?.w ?? null);
      const rate = normalizeNumberString(x?.rate ?? null);
      const total = normalizeNumberString(x?.total ?? null);
      out.set(c, w && rate && total ? { peso: w, pesoBruto: w, cantidadSolicitada: w, volumen: null, tarifa: rate, flete: total } : { error: 'SNAPSHOT_MISSING' });
    }
    return out;
  }
}
