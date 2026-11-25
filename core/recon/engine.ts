import { daysBetween, normalizeDocument, normalizePlace, parseTerpelRoute, sameNumber, toNumber } from './normalize.js';

export const RULES_VERSION = 'recon-1.0.0';

export type FilterKey = 'driver' | 'plate' | 'route' | 'date';
export type FilterMode = 'exclusive' | 'preferred';
export type ReconStatus = 'EXACT' | 'MATCH_WITH_DIFFERENCES' | 'AMBIGUOUS' | 'NO_MATCH' | 'INSUFFICIENT_DATA';

export interface FilterConfig {
  key: FilterKey;
  position: number;
  active: boolean;
  mode: FilterMode;
}

export interface TerpelInput {
  driverCode: string | null;
  route: string | null;
  serviceDate: string | null; // fecha de DESCARGUE
  plateNormalized: string | null;
  transportVolume: number | string | null;
  netValue: number | string | null;
}

export interface SilogCandidate {
  id: string;
  dispatchDate: string | null;
  plateNormalized: string | null;
  driverDocument: string | null;
  originCity: string | null;
  destinationCity: string | null;
  remesaWeight: number | string | null;
  totalRemesa: number | string | null;
}

export interface TraceStep {
  filter: FilterKey;
  before: number;
  after: number;
  mode: FilterMode;
  skipped: boolean;
  reason?: 'inactive' | 'would_empty' | 'no_terpel_data';
}

export interface Difference {
  field: 'volume' | 'value' | 'plate' | FilterKey;
  terpel: string | number | null;
  silogtran: string | number | null;
  severity: 'adjustable' | 'info';
  note?: string;
}

export interface EngineResult {
  status: ReconStatus;
  chosenId: string | null;
  candidateIds: string[];
  trace: TraceStep[];
  differences: Difference[];
  reason: string;
}

export interface EngineParams {
  filters: FilterConfig[];
  windowDays: number;
  /** nombre normalizado en Silogtran -> nombre normalizado en Terpel */
  aliases: Map<string, string>;
}

const FILTER_LABEL: Record<FilterKey, string> = { driver: 'conductor', plate: 'placa', route: 'ruta', date: 'fecha' };

function placeEquals(silogPlace: string | null, terpelNorm: string, aliases: Map<string, string>): boolean {
  const n = normalizePlace(silogPlace);
  if (!n) return false;
  if (n === terpelNorm) return true;
  return aliases.get(n) === terpelNorm;
}

function predicate(key: FilterKey, t: TerpelInput, p: EngineParams): ((c: SilogCandidate) => boolean) | null {
  switch (key) {
    case 'driver': {
      const d = normalizeDocument(t.driverCode);
      return d ? (c) => c.driverDocument === d : null;
    }
    case 'plate':
      return t.plateNormalized ? (c) => c.plateNormalized === t.plateNormalized : null;
    case 'route': {
      const r = parseTerpelRoute(t.route);
      return r ? (c) => placeEquals(c.originCity, r.origin, p.aliases) && placeEquals(c.destinationCity, r.destination, p.aliases) : null;
    }
    case 'date':
      return t.serviceDate
        ? (c) => {
            if (!c.dispatchDate) return false;
            const d = daysBetween(c.dispatchDate, t.serviceDate as string);
            return d >= 0 && d <= p.windowDays;
          }
        : null;
  }
}

/** Compara el servicio de Terpel con UN registro de Silogtran. Volumen 0 no se compara. */
export function compareRecord(t: TerpelInput, c: SilogCandidate): Difference[] {
  const diffs: Difference[] = [];
  const vol = toNumber(t.transportVolume);
  const w = toNumber(c.remesaWeight);
  if (vol !== null && vol !== 0 && (w === null || !sameNumber(vol, w))) {
    diffs.push({ field: 'volume', terpel: vol, silogtran: w, severity: 'adjustable' });
  }
  const val = toNumber(t.netValue);
  const tot = toNumber(c.totalRemesa);
  if (val !== null && (tot === null || !sameNumber(val, tot))) {
    diffs.push({ field: 'value', terpel: val, silogtran: tot, severity: 'adjustable' });
  }
  if (t.plateNormalized && c.plateNormalized && t.plateNormalized !== c.plateNormalized) {
    diffs.push({ field: 'plate', terpel: t.plateNormalized, silogtran: c.plateNormalized, severity: 'info' });
  }
  return diffs;
}

function classifySingle(t: TerpelInput, c: SilogCandidate, trace: TraceStep[], extra: Difference[], reason: string): EngineResult {
  const differences = [...compareRecord(t, c), ...extra];
  const adjustable = differences.some((d) => d.severity === 'adjustable');
  return {
    status: adjustable ? 'MATCH_WITH_DIFFERENCES' : 'EXACT',
    chosenId: c.id,
    candidateIds: [c.id],
    trace,
    differences,
    reason,
  };
}

/** Cascada de filtros. `base` ya excluye ANULADO y clientes distintos de Terpel. */
export function reconcile(t: TerpelInput, base: SilogCandidate[], p: EngineParams, manualId?: string | null): EngineResult {
  const filters = [...p.filters].sort((a, b) => a.position - b.position);

  // Datos mínimos de Terpel para los filtros activos.
  const missing: string[] = [];
  for (const f of filters) {
    if (!f.active || f.key === 'plate') continue;
    if (predicate(f.key, t, p) === null) missing.push(FILTER_LABEL[f.key]);
  }
  if (missing.length > 0) {
    return {
      status: 'INSUFFICIENT_DATA', chosenId: null, candidateIds: [], trace: [], differences: [],
      reason: `Terpel no trae datos para filtrar: ${missing.join(', ')}`,
    };
  }

  let current = base;
  const trace: TraceStep[] = [];
  const infos: Difference[] = [];
  for (const f of filters) {
    const before = current.length;
    if (!f.active) {
      trace.push({ filter: f.key, before, after: before, mode: f.mode, skipped: true, reason: 'inactive' });
      continue;
    }
    const pred = predicate(f.key, t, p);
    if (!pred) {
      trace.push({ filter: f.key, before, after: before, mode: f.mode, skipped: true, reason: 'no_terpel_data' });
      continue;
    }
    const next = current.filter(pred);
    if (next.length === 0 && f.mode === 'preferred' && before > 0) {
      trace.push({ filter: f.key, before, after: before, mode: f.mode, skipped: true, reason: 'would_empty' });
      infos.push({ field: f.key, terpel: null, silogtran: null, severity: 'info', note: `Filtro preferente de ${FILTER_LABEL[f.key]} ignorado: ningún candidato coincidía` });
      continue;
    }
    trace.push({ filter: f.key, before, after: next.length, mode: f.mode, skipped: false });
    current = next;
    if (next.length === 0) {
      return {
        status: 'NO_MATCH', chosenId: null, candidateIds: [], trace, differences: [],
        reason: `Sin candidatos tras el filtro de ${FILTER_LABEL[f.key]}`,
      };
    }
  }

  if (manualId) {
    const chosen = current.find((c) => c.id === manualId) ?? base.find((c) => c.id === manualId);
    if (chosen) return { ...classifySingle(t, chosen, trace, infos, 'Candidato elegido manualmente'), candidateIds: current.map((c) => c.id) };
  }
  if (current.length === 0) {
    return { status: 'NO_MATCH', chosenId: null, candidateIds: [], trace, differences: [], reason: 'No hay registros de Silogtran para comparar' };
  }
  if (current.length > 1) {
    return {
      status: 'AMBIGUOUS', chosenId: null, candidateIds: current.map((c) => c.id), trace, differences: infos,
      reason: `${current.length} candidatos tras todos los filtros; requiere elección manual`,
    };
  }
  return classifySingle(t, current[0] as SilogCandidate, trace, infos, 'Un único candidato tras todos los filtros');
}
