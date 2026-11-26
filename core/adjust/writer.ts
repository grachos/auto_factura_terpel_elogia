/**
 * Escritor en Silogtran. El único cambio previsto es la pantalla «Procedimiento de Cambio Tarifa»
 * (por remesa: Remesa, Razón de cambio y, por ítem, Peso Remesa, Cantidad Remesa y Nueva Tarifa).
 */
export interface TariffChange {
  remesaCode: string;
  reason: string;
  pesoRemesa: string;
  cantidadRemesa: string;
  nuevaTarifa: string;
  /** Valor total esperado (Terpel): solo informativo en la verificación (remesa_flete). */
  valorTotal?: string | null;
}

/** Valores que la pantalla muestra (y guarda como REVERSA antes de grabar). */
/** Valores reales de la remesa (consulta Home_111): Peso, Peso Bruto (cantidad) y tarifa_cliente. `flete` es informativo. */
export interface ScreenValues { peso: string; cantidad: string; tarifa: string; flete?: string }

export interface WriteContext {
  actor: string | null;
  /** Valores `anterior_*` vistos en el ensayo: si cambian antes de grabar, se aborta como obsoleto. */
  expectedBefore?: ScreenValues | null;
}

export type WriterOutcome =
  | { outcome: 'applied'; before?: ScreenValues; detail?: string; after?: ScreenValues }
  | { outcome: 'verification_failed'; detail: string; before?: ScreenValues; after?: ScreenValues } // Grabar dijo éxito pero la consulta no coincide
  | { outcome: 'rejected' | 'conflict' | 'stale'; detail: string; before?: ScreenValues } // CERTEZA de que no se aplicó
  | { outcome: 'uncertain'; detail: string; before?: ScreenValues }; // timeout / respuesta ambigua: hay que consultar el estado

export interface RehearsalCheck { name: string; ok: boolean; detail?: string }

/** Resultado de un ensayo: todos los pasos menos Grabar. */
export interface RehearsalResult {
  simulated: boolean;
  payload: TariffChange;
  before: ScreenValues | null;
  checks: RehearsalCheck[];
  wouldPostGrabar: false;
  grabar?: { target: string | null; hasUuid: boolean; hasLock: boolean };
}

export type ChangeState = 'applied' | 'not_applied' | 'unknown';
export interface FieldCheck { expected: string; actual: string | null; ok: boolean }
export interface ChangeStateResult { state: ChangeState; fields?: Record<string, FieldCheck>; detail?: string }

export interface SilogtranWriter {
  readonly kind: 'mock' | 'web';
  /** true: nada de lo que se "aplica" toca Silogtran (las propuestas quedan en simulated_applied). */
  readonly simulated: boolean;
  changeTariff(change: TariffChange, ctx?: WriteContext): Promise<WriterOutcome>;
  /** Ensayo: deja los campos fijados y devuelve lo que se enviaría; NUNCA pulsa Grabar. */
  rehearse(change: TariffChange, ctx?: WriteContext): Promise<RehearsalResult>;
  /** Consulta si un cambio quedó aplicado (para resolver un resultado incierto antes de cualquier reintento). */
  getChangeState(remesaCode: string, change: TariffChange, ctx?: WriteContext): Promise<ChangeStateResult>;
}

export type MockWriterMode = 'success' | 'reject' | 'conflict' | 'timeout';

/** Escritor simulado para demo y pruebas: no contacta a Silogtran. */
export class MockSilogtranWriter implements SilogtranWriter {
  readonly kind = 'mock' as const;
  readonly simulated = true;
  mode: MockWriterMode = 'success';
  /** En el modo timeout: ¿el cambio "llegó" a aplicarse aunque no hubo respuesta? */
  timeoutAppliesChange = false;
  calls: TariffChange[] = [];
  private applied = new Map<string, TariffChange>();
  delayMs = 0;

  async changeTariff(change: TariffChange): Promise<WriterOutcome> {
    this.calls.push(change);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    switch (this.mode) {
      case 'reject': return { outcome: 'rejected', detail: 'Rechazado por Silogtran (simulado)' };
      case 'conflict': return { outcome: 'conflict', detail: 'Conflicto: la remesa cambió (simulado)' };
      case 'timeout':
        if (this.timeoutAppliesChange) this.applied.set(change.remesaCode, change);
        return { outcome: 'uncertain', detail: 'Sin respuesta de Silogtran (simulado)' };
      default:
        this.applied.set(change.remesaCode, change);
        return { outcome: 'applied' };
    }
  }

  async rehearse(change: TariffChange): Promise<RehearsalResult> {
    return { simulated: true, payload: change, before: null, wouldPostGrabar: false, checks: [{ name: 'escritor simulado: no se contacta a Silogtran', ok: true }] };
  }

  async getChangeState(remesaCode: string): Promise<ChangeStateResult> {
    return { state: this.applied.has(remesaCode) ? 'applied' : 'not_applied' };
  }
}
