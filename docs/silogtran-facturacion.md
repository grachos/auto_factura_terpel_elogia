# Pantalla «Facturar Remesas» de Silogtran (Automatica_111) y módulo de facturación 4a

Pantalla: `index.php?page=Financiero.Factura.Automatica_111` (PRADO). Este incremento (4a) construye TODO menos la emisión real:
**no se pulsó «Facturar Remesas» ni «Preview»** en Silogtran real. Solo se hizo `GET`, un callback de autocompletado del cliente y el envío del botón
**«Listar Remesas»** (solo lectura: llena la tabla `porFacturar`; los totales siguen en 0,00 hasta «Total Remesas», que tampoco se pulsó).

## Diagnóstico de solo lectura (producción, remesa 0101229798)
`POST /api/admin/silog-web/diagnostic` con `{"invoice": true, "remesa": "…"}` (admin, auditado): GET de la pantalla, configuración llenada solo en memoria,
texto en `listadocumento` («Búsqueda Por Comas») y envío de `ListarRemesas` con su `IDLock`.

| Control (`ctl0$MainModule$…`) | Uso |
|---|---|
| `cliente_codigo` (autocompletado) | cliente Terpel; al elegirlo la pantalla precarga retefuente en campos ocultos `impuesto_retefuente_nombre/porcentaje` (no se elige a mano) |
| `nombreimprimible`, `vendedor_codigo`, `dias_vencimiento`, `moneda_codigo`, `forpag_codigo`, `tipfac_codigo`, `division`, `numeroremesa` | configuración de la factura (selects por texto de la opción) |
| `ciudad_codigo_pago` | ciudad de pago (autocompletado; ya viene por defecto) |
| `observacion` / `factura_ordencompra` | observación de la factura y orden de compra |
| `listadocumento` | «Búsqueda Por Comas»: código de la remesa (10 dígitos con ceros) |
| `ListarRemesas` (+ `IDLockHidden_…ListarRemesas`) | listar (lectura) |
| `porFacturar$ctlN$*` | fila: `remesa1`, `vehiculo`, `fecha`, `estado_remesa` (cumplida), `origen`, `destino`, `observacion` (= producto), `peso`, `unidades`, `descripcion_remesa`, `tarifa_cliente`, `tarifa`, `otros`, `total`, casilla `valido` |
| `FacturarRemesas` | **emite** (solo `SilogtranWebInvoiceWriter.postFacturar`, protegido) |

Resultado para la remesa de ejemplo 0101229798: la fila trae total **1.651.428** = valor neto de Terpel; peso **10194** × tarifa cliente **162** = 1.651.428.
**La regla crítica se cumple en el ejemplo real.** El texto de la observación del ejemplo usa como segundo número la hoja de entrada de servicio
(1005579437 para el transporte 6008613622), confirmado contra `authorizations.service_entry_sheet`.

## Regla crítica
El flete a facturar (total de la fila y tarifa) debe ser IDÉNTICO al valor neto de Terpel; además remesa cumplida, `otros = 0` y peso × tarifa cliente = total.
Si no se cumple la remesa se **omite** (no se factura) con el motivo; la corrida continúa con las demás.

## Observación y orden de compra
Plantilla por defecto (editable por el administrador, máx. 176 caracteres, truncada por palabra con aviso):
`SERVICIO DE TRANSPORTE {product} {origin} - {destination} {transport} {serviceEntrySheet}` (mayúsculas, espacios simples). Marcadores: `{product}`, `{origin}`,
`{destination}`, `{transport}`, `{serviceEntrySheet}`, `{remesa}`. Producto: columna «Producto» de la consulta de la remesa (Home_111), normalizado quitando guiones.
Origen/destino: informe de Silogtran. Transporte y hoja: correo de Terpel. **Orden de compra = número de transporte.**
Si falta producto, origen, destino, transporte, hoja o valor, la remesa NO es elegible y queda en «Excluidas» con el motivo. En el ensayo se compara la
observación generada con la que Silogtran trae precargada y el producto con la «Observación» del listado, y se reporta por remesa (informativo).

**PENDIENTE DE CONFIRMAR:** la consulta Home muestra el producto como `B-100` y el listado de facturar como `B100`; por defecto se quitan los guiones.

## Módulo (código)
- `core/invoice/service.ts` (plan, ensayo, emisión protegida, verificación, consulta, resolución manual), `core/invoice/runs.ts` (corrida por pasos), `core/invoice/excel.ts` (reporte),
  `core/invoice/writer.ts` (interfaz + `MockInvoiceWriter`), `core/silog/web/invoice.ts` + `invoiceWriter.ts` (escritor web).
- Migración `0012_invoicing.sql` (+ `supabase/deploy/terpel_0012_invoicing.sql`): `invoice_settings`, `invoices` (índice único parcial: UNA factura activa por remesa),
  `invoice_events`, `invoice_runs`, `invoice_run_items`.
- Estados: `eligible → rehearsed → issuing → issued | failed | uncertain | verification_failed | skipped | simulated`. Un resultado `uncertain` nunca se reintenta a ciegas: se consulta el informe
  (factura no nula = emitida) o lo resuelve el administrador a mano.
- Emisión real solo si: modo `web` + remesa en la lista permitida + ensayo vigente (mismo contenido, <24 h) + confirmación; tras emitir se relee el informe hasta 3 veces buscando el número.
- Permisos: `invoices.manage` (admin y facturación; operador y lector reciben 403) e `invoices.config` (solo admin: parámetros, resolución manual).
- Cuenta de facturación: la cuenta `invoice` (o, si no existe, `adjust`) de Usuarios; sin cuenta → `INVOICE_ACCOUNT_NOT_CONFIGURED`.
- «Facturar todas» con escritor real exige que el admin active `batch_enabled` (apagado por defecto); «Facturar esta» siempre está disponible. La corrida se detiene de inmediato ante
  `uncertain` / `verification_failed` / `failed` tras emitir y se reanuda explícitamente; si el ensayo falla o se viola la regla crítica, omite y continúa.
- API: `POST /api/reconciliations/:id/invoices/plan`, `GET /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices/:id/{rehearse,issue,check,resolve}`,
  `GET|PUT /api/invoices/settings`, `GET /api/invoices/writer-status`, `/api/invoice-runs` (crear, `step`, detalle, `export`).

## Riesgos y decisiones
- **Peso neto cumplido:** la fila usa el peso del cumplido de Silogtran; la regla crítica compara el TOTAL, que es lo que se factura.
- **Remesa en dos servicios** (p. ej. 101229386 ↔ 6008613621/6008613622): se excluye como ambigua.
- Una factura SIMULADA no cuenta como emitida; al planificar con escritor real vuelve a ser elegible.

## Qué debe confirmar el usuario antes de la primera factura real
Vendedor (`CS`), retefuente (1 %), días de pago (15), ciudad de pago, tipo de factura, plantilla de observación, normalización del producto (B-100 → B100),
la cuenta de facturación en Usuarios, y activar la emisión real solo para UNA remesa en la lista permitida (ensayo → «Facturar esta» → verificar en Silogtran).
