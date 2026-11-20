export type BusinessKeyStrategy = 'transport_number' | 'transport_expense';

/**
 * Clave de negocio provisional: número de transporte (texto, conserva ceros a la izquierda).
 * Pendiente de confirmar con negocio; la estrategia es configurable.
 */
export function buildBusinessKey(
  strategy: BusinessKeyStrategy,
  fields: { transportNumber: string | null; expenseNumber: string | null },
): string | null {
  const t = (fields.transportNumber ?? '').trim();
  if (!t) return null;
  if (strategy === 'transport_expense') {
    const e = (fields.expenseNumber ?? '').trim();
    if (!e) return null;
    return `${t}|${e}`;
  }
  return t;
}
