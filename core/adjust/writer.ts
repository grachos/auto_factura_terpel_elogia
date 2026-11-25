import { AppError } from '../errors.js';

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
}

export type WriterOutcome =
  | { outcome: 'applied' }
  | { outcome: 'rejected' | 'conflict'; detail: string } // CERTEZA de que no se aplicó
  | { outcome: 'uncertain'; detail: string }; // timeout / respuesta ambigua: hay que consultar el estado

export interface SilogtranWriter {
  readonly kind: 'mock' | 'web';
  /** true: nada de lo que se "aplica" toca Silogtran (las propuestas quedan en simulated_applied). */
  readonly simulated: boolean;
  changeTariff(change: TariffChange): Promise<WriterOutcome>;
  /** Consulta si un cambio quedó aplicado (para resolver un resultado incierto antes de cualquier reintento). */
  getChangeState(remesaCode: string, change: TariffChange): Promise<'applied' | 'not_applied' | 'unknown'>;
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

  async getChangeState(remesaCode: string): Promise<'applied' | 'not_applied' | 'unknown'> {
    return this.applied.has(remesaCode) ? 'applied' : 'not_applied';
  }
}

/**
 * Esqueleto del escritor real. Pantalla: https://construproyec.colombiasoftware.net/index.php?page=Despacho.Remesa_003.CambioTarifa_105
 * (PRADO; Procedimiento de Cambio Tarifa por remesa). Decisión: vivirá DENTRO de esta app (incremento posterior: diagnóstico
 * de solo lectura de la pantalla con la cuenta de ajustes, login web con reto AWS WAF vía Chromium, cookies de sesión
 * reutilizables, escritura y verificación). Contrato esperado (pendiente): login WEB con reto AWS WAF con la cuenta de ajustes,
 * abrir «Procedimiento de Cambio Tarifa», diligenciar Remesa, Razón de cambio, Peso Remesa, Cantidad Remesa y
 * Nueva Tarifa (tipo GALON, cliente Terpel; separador decimal punto) y confirmar. NO escribe nada hoy.
 */
export class SilogtranWebWriter implements SilogtranWriter {
  readonly kind = 'web' as const;
  readonly simulated = false;
  async changeTariff(): Promise<WriterOutcome> {
    throw new AppError(501, 'WRITER_NOT_IMPLEMENTED', 'El escritor real de Silogtran aún no está implementado: faltan la ruta de la pantalla "Procedimiento de Cambio Tarifa" y una cuenta de ajustes habilitada');
  }
  async getChangeState(): Promise<'applied' | 'not_applied' | 'unknown'> {
    throw new AppError(501, 'WRITER_NOT_IMPLEMENTED', 'El escritor real de Silogtran aún no está implementado');
  }
}
