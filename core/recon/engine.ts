import { daysBetween, normalizeDocument, normalizePlace, parseTerpelRoute, sameNumber, toNumber } from './normalize.js';

export const RULES_VERSION = 'recon-1.1.0';

export type FilterKey = 'driver' | 'plate' | 'route' | 'date';
export type FilterMode = 'exclusive' | 'preferred';
export type ZeroVolumeMode = 'ignore' | 'reconcile_if_value_matches' | 'reconcile_always';
export type WeightSource = 'terpel' | 'silogtran';
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
  reason?: 'inactive' | 'would_empty' | 'no_terpel_data' | 'closest_date';
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
  reasonCode: string | null;
  weightSource: WeightSource | null;
}

export interface EngineParams {
  filters: FilterConfig[];
  windowDays: number;
  zeroVolumeMode?: ZeroVolumeMode;
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

function classifySingle(t: TerpelInput, c: SilogCandidate, trace: TraceStep[], extra: Difference[], reason: string, mode: ZeroVolumeMode): EngineResult {
  const cmp = compareRecord(t, c);
  const differences = [...cmp, ...extra.filter((x) => !(x.field === 'plate' && cmp.some((d) => d.field === 'plate')))];
  const zero = toNumber(t.transportVolume) === 0;
  if (zero && mode === 'reconcile_if_value_matches' && differences.some((d) => d.field === 'value')) {
    return {
      status: 'INSUFFICIENT_DATA', chosenId: null, candidateIds: [c.id], trace,
      differences: differences.map((d) => (d.field === 'value' ? { ...d, severity: 'info' as const } : d)),
      reason: 'Volumen 0 y el valor de Terpel no coincide con Silogtran: no se concilia ni se ajusta',
      reasonCode: 'ZERO_VOLUME_VALUE_MISMATCH', weightSource: null,
    };
  }
  const adjustable = differences.some((d) => d.severity === 'adjustable');
  return {
    status: adjustable ? 'MATCH_WITH_DIFFERENCES' : 'EXACT',
    chosenId: c.id,
    candidateIds: [c.id],
    trace,
    differences,
    reason,
    reasonCode: null,
    weightSource: zero ? 'silogtran' : 'terpel',
  };
}

/** Candidato con la fecha de despacho más cercana (≤ fecha de Terpel); null si no hay uno único. */
function closestByDate(cands: SilogCandidate[], serviceDate: string | null): SilogCandidate | null {
  if (!serviceDate) return null;
  const dated = cands
    .filter((c) => c.dispatchDate)
    .map((c) => ({ c, d: Math.abs(daysBetween(c.dispatchDate as string, serviceDate)) }))
    .sort((a, b) => a.d - b.d);
  if (dated.length === 0) return null;
  if (dated.length > 1 && dated[1]!.d === dated[0]!.d) return null;
  return dated[0]!.c;
}

/** Cascada de filtros. `base` ya excluye ANULADO y clientes distintos de Terpel. */
export function reconcile(t: TerpelInput, base: SilogCandidate[], p: EngineParams, manualId?: string | null): EngineResult {
  const filters = [...p.filters].sort((a, b) => a.position - b.position);
  const zeroMode = p.zeroVolumeMode ?? 'ignore';
  if (toNumber(t.transportVolume) === 0 && zeroMode === 'ignore') {
    return {
      status: 'INSUFFICIENT_DATA', chosenId: null, candidateIds: [], trace: [], differences: [],
      reason: 'Volumen 0: se espera corrección de Terpel', reasonCode: 'ZERO_VOLUME_IGNORED', weightSource: null,
    };
  }

  // Datos mínimos de Terpel para los filtros activos.
  const missing: string[] = [];
  for (const f of filters) {
    if (!f.active || f.key === 'plate') continue;
    if (predicate(f.key, t, p) === null) missing.push(FILTER_LABEL[f.key]);
  }
  if (missing.length > 0) {
    return {
      status: 'INSUFFICIENT_DATA', chosenId: null, candidateIds: [], trace: [], differences: [],
      reason: `Terpel no trae datos para filtrar: ${missing.join(', ')}`, reasonCode: 'MISSING_DATA', weightSource: null,
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
        reason: `Sin candidatos tras el filtro de ${FILTER_LABEL[f.key]}`, reasonCode: null, weightSource: null,
      };
    }
  }

  if (manualId) {
    const chosen = current.find((c) => c.id === manualId) ?? base.find((c) => c.id === manualId);
    if (chosen) return { ...classifySingle(t, chosen, trace, infos, 'Candidato elegido manualmente', zeroMode), candidateIds: current.map((c) => c.id) };
  }
  if (current.length === 0) {
    return { status: 'NO_MATCH', chosenId: null, candidateIds: [], trace, differences: [], reason: 'No hay registros de Silogtran para comparar', reasonCode: null, weightSource: null };
  }
  if (current.length > 1) {
    // Desempate por fecha: se elige el despacho más cercano (anterior o igual) a la fecha de Terpel.
    const closest = closestByDate(current, t.serviceDate);
    if (closest) {
      const dist = daysBetween(closest.dispatchDate as string, t.serviceDate as string);
      trace.push({ filter: 'date', before: current.length, after: 1, mode: 'exclusive', skipped: false, reason: 'closest_date' });
      return classifySingle(
        t, closest, trace, infos,
        `${current.length} candidatos; se eligió el despacho más cercano a la fecha de Terpel (${dist} día${dist === 1 ? '' : 's'} antes)`, zeroMode,
      );
    }
    return {
      status: 'AMBIGUOUS', chosenId: null, candidateIds: current.map((c) => c.id), trace, differences: infos,
      reason: `${current.length} candidatos tras todos los filtros; requiere elección manual`, reasonCode: null, weightSource: null,
    };
  }
  return classifySingle(t, current[0] as SilogCandidate, trace, infos, 'Un único candidato tras todos los filtros', zeroMode);
}
