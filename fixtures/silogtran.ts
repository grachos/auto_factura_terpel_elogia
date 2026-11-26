// Filas SINTÉTICAS con la misma forma que el informe de Silogtran (datos inventados).
export const TERPEL_NIT = '830095213';

let n = 0;
export function silogRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  return {
    manifiesto: `M${String(1000 + n)}`,
    remesa_codigo: 5000 + n,
    fecha: '2026-01-12',
    fecha_entrega: '2026-01-14',
    placa: 'ABC123',
    trailer_placa: null,
    conductor: 'CONDUCTOR FICTICIO',
    conductor_documento: '1',
    cliente: 'TERPEL FICTICIO',
    cliente_nit: TERPEL_NIT,
    ciudad_origen_remesa: 'FICTICIA NORTE',
    ciudad_destino_remesa: 'FICTICIA SUR',
    remesa_peso: 9973,
    peso_neto_cargue: 9973,
    remesa_tarifa: '123.45',
    fleteremesa_despacho: '1000000',
    total_remesa: '1234567.89',
    valor_adicional_remesa: '0',
    estado: 'CUMPLIDO',
    estado_remesa: 'CUMPLIDA',
    factura: null,
    numero_cumplido_rndc: '111',
    ...o,
  };
}

/** Repite la fila `times` veces (el informe real repite filas cambiando solo numero_cumplido_rndc). */
export function repeated(row: Record<string, unknown>, times: number): Record<string, unknown>[] {
  return Array.from({ length: times }, (_, i) => ({ ...row, numero_cumplido_rndc: String(100 + i) }));
}

/** Datos del modo demo: coinciden con los servicios ficticios del correo simulado. */
export function buildDemoSilogRows(): Record<string, unknown>[] {
  n = 0;
  return [
    ...repeated(silogRow({ manifiesto: 'MD001', remesa_codigo: 9001, fecha: '2026-01-12', conductor_documento: '000001' }), 2), // 000123 exacto
    silogRow({ manifiesto: 'MD002', remesa_codigo: 9002, fecha: '2026-01-13', conductor_documento: '2', placa: 'XYZ987', remesa_peso: 9900, total_remesa: '2400000' }), // 000124 con diferencias
    silogRow({ manifiesto: 'MD003', remesa_codigo: 9003, fecha: '2026-01-08', conductor_documento: '4', placa: 'ABC123' }), // 000125 ambiguo
    silogRow({ manifiesto: 'MD004', remesa_codigo: 9004, fecha: '2026-01-08', conductor_documento: '4', placa: 'ABC123' }),
    silogRow({ manifiesto: 'MD005', remesa_codigo: 9005, fecha: '2026-01-12', cliente_nit: '900000001', conductor_documento: '7' }), // otro cliente
    silogRow({ manifiesto: 'MD006', remesa_codigo: 9006, fecha: '2026-01-12', conductor_documento: '7', estado: 'ANULADO' }),
  ];
}
