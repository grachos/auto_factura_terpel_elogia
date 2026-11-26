# Diseño aprobado — AutoFactura Terpel

Estado: diseño aprobado por el usuario. Implementar **solo la Fase 1**. Fases 2–4 quedan documentadas y requieren aprobación aparte.

Reglas generales: código en inglés; interfaz, documentación y mensajes en español. Reglas deterministas, sin APIs de IA. Proveedores sin documentación → adaptador simulado y capacidad marcada como "pendiente de verificar".

## 1. Decisiones técnicas

| Tema | Decisión |
|---|---|
| Frontend + backend | **React + Vite (TS)** + **Vercel Functions Node.js** (`api/`). Lógica en `core/` agnóstica del framework; mismo núcleo servido por **Fastify** en `server/` para el piloto local. |
| Ejecución larga | Importación **por pasos**: `POST /runs` crea la ejecución; el cliente llama `POST /runs/:id/step`, que procesa una página Graph en < 20 s y guarda cursor en BD. Reanudable desde el historial. En local, un worker puede invocar el mismo paso en bucle. |
| BD | Supabase PostgreSQL. `numeric(18,4)` para montos/cantidades, `text` para identificadores, `date` para fecha del servicio. |
| Auth usuarios | Supabase Auth; roles `operator`, `admin`, `viewer` en `user_roles`. Independiente de Microsoft. Backend valida el JWT de Supabase. |
| Escrituras | Solo backend con `service_role`. Frontend lee bajo RLS o vía API. |
| Graph | `@azure/msal-node` client credentials (certificado en prod; secreto corto para pruebas). `fetch` nativo, `Prefer: IdType="ImmutableId"`, `$select`, seguir `@odata.nextLink`, reintentos con `Retry-After` en 429/503/504. Solo GET (no cambia `isRead`). |
| Fechas | Luxon, zona `America/Bogota`: `[inicio día inicial, inicio día siguiente al final)` → UTC. |
| Parser | Determinista: HTML→texto (`node-html-parser`), localizar bloque "Esta es la información del servicio", campos por etiqueta normalizada (sin tildes, case-insensitive, `:` y espacios opcionales). `parser_version` en cada salida. |
| Decimales | Normalizador propio: `9973,0000`→9973.0000; `1.234.567,89`→1234567.89; si hay `.` y `,` el último es decimal; solo `,` → decimal; `.` ambiguo (`1.234`) → incidencia, no se adivina. Usar strings/decimal.js, nunca float para persistir. |
| Excel | ExcelJS. Identificadores como texto (`numFmt '@'`), decimales numéricos con 4 cifras; para volumen incluir también el texto original. |
| Pruebas | Vitest (unidad + integración con Supabase local y Graph simulado); Playwright smoke de UI (Chromium preinstalado, no ejecutar `playwright install`). |
| Adaptadores | Interfaces `MailSource` (Graph, Mock), futuras `SilogtranSource`, `SilogtranWriter`, `InvoicingGateway`, cada una con `Mock*`. |

Estructura: `core/`, `api/`, `server/`, `web/`, `supabase/migrations`, `fixtures/`, `docs/`.

## 2. Fase 1 — Importar correos, Excel y persistencia

Configurable: buzón (lo define TI), remitente exacto (inicial `flota@informacion.terpel.com`), patrón de asunto (referencia "AUTORIZACION PAGO TERPEL – Facturacion de servicio").

Flujo de una ejecución:
1. Operador elige rango → `import_runs` (índice único parcial: una ejecución activa por buzón; `lease_until` para tomar ejecuciones abandonadas).
2. Cada paso: `GET /users/{mailbox}/messages?$filter=receivedDateTime ge {utcStart} and receivedDateTime lt {utcEndExcl}&$select=id,internetMessageId,conversationId,subject,from,sender,receivedDateTime,body,internetMessageHeaders&$top=50`.
3. Filtro de remitente en la app: `from` y `sender` deben coincidir exactamente (case-insensitive) con el configurado. `Authentication-Results` (DMARC/SPF) se registra; exigirlo es opcional (`require_dmarc_pass`).
4. Asunto normalizado: sin tildes, guiones `- – —` equivalentes, espacios colapsados, prefijos `RV:`/`RE:`/`FW:`/`FWD:` permitidos y marcados como reenvío.
5. `INSERT … ON CONFLICT DO NOTHING` del mensaje → parseo → vínculo a servicio → `run_messages`. Tras confirmar la transacción de la página, guardar `nextLink` como cursor. Si el nextLink expira, reiniciar el rango (idempotente).
6. Al terminar: Excel generado **desde la BD**, subido a Storage privado, registrado en `export_files`. Si falla: `export_status = failed` y botón "Regenerar".

Identidades:
- Mensaje: único por `(mailbox, graph_immutable_id)` y `(mailbox, internet_message_id)`.
- Servicio: `business_key` provisional = número de transporte (configurable; pendiente de confirmar con negocio, podría incluir número de gasto).
- Corrección/reenvío: nueva versión en `authorizations` del mismo servicio; si hay valores distintos → incidencia `CORRECTED_AUTHORIZATION`. Nunca un segundo servicio. Versión vigente por defecto: la recibida más reciente, con revisión obligatoria.
- Reenvíos de remitentes internos no permitidos → revisión con incidencia `SENDER_NOT_ALLOWED`.

Vacío vs cero: `raw = NULL` etiqueta ausente; `raw = ''` presente vacía → normalizado NULL; `'0'` → 0. Etiqueta ausente o campo obligatorio vacío → incidencia.

Volumen: `transport_volume_raw`, `transport_volume` numérico, unidad `galones` y `unit_status = 'confirmed'` (confirmado por el negocio; puede venir en 0). Sin conversión.

Planta de cargue: se guarda tal cual; el negocio indicó no tenerla en cuenta (sin marca 9P ni reglas).

Fecha del servicio: formato `DD.MM.AAAA`, campo independiente de la fecha de recepción.

Campos de la plantilla: Número de transporte, Número de remisión, Número de gasto, Fecha del servicio, Planta de cargue, Documento de compras o contrato, Hoja de entrada de servicio, Valor neto y moneda, Placa del vehículo, Ruta, Volumen del transporte, Tarifa, Código del conductor, Nombre del conductor.

Excel: hoja "Servicios" (una fila por servicio del lote), hoja "Incidencias", hoja "Resumen" (metadatos del lote, contadores, sha256).

## 3. Modelo de datos (Fase 1)

```
mail_configs        id, mailbox, allowed_sender, subject_pattern, require_dmarc_pass bool,
                    active, updated_by, updated_at
import_runs         id, mail_config_id, requested_by, date_from_local date, date_to_local date,
                    utc_start timestamptz, utc_end_exclusive timestamptz,
                    status (pending|running|paused|completed|failed), cursor_next_link text,
                    lease_until timestamptz, pages_processed,
                    found, imported, duplicates, needs_review, ignored,
                    export_status (pending|ready|failed), error_code, error_detail,
                    started_at, finished_at
source_messages     id, mailbox, graph_immutable_id, internet_message_id, conversation_id,
                    from_address, sender_address, subject, received_at, is_forward bool,
                    auth_results text, body_content_type, body_sha256, body_raw (sin SELECT
                    para operadores), first_run_id, created_at
                    UNIQUE(mailbox, graph_immutable_id), UNIQUE(mailbox, internet_message_id)
run_messages        run_id, message_id, outcome (imported|duplicate|needs_review|
                    ignored_sender|ignored_subject|parse_error), PK(run_id, message_id)
services            id, business_key UNIQUE, transport_number, current_authorization_id,
                    status ('imported'…), version_count, created_at, updated_at
authorizations      id, message_id UNIQUE, service_id, version, parse_status (ok|incomplete|error),
                    parser_version, template_variant,
                    transport_number, remission_number, expense_number (text),
                    service_date date, service_date_raw,
                    loading_plant, loading_plant_flag, purchase_doc, service_entry_sheet,
                    net_value numeric(18,4), net_value_raw, currency,
                    plate, plate_normalized, route,
                    transport_volume numeric(18,4), transport_volume_raw,
                    transport_volume_unit, unit_status,
                    rate numeric(18,4), rate_raw, driver_code, driver_name,
                    raw_fields jsonb, created_at
import_issues       id, run_id, message_id, authorization_id, code, severity, field, detail
export_files        id, run_id, storage_path, sha256, row_count, issue_count, status, generated_at
user_roles          user_id, role
audit_log           id, actor, action, entity, entity_id, data jsonb, at
```

RLS: SELECT para autenticados con rol en `user_roles` (excepto `body_raw`, p. ej. vía tabla separada o vista); escrituras por API; `mail_configs` solo admin. Bucket `exports` privado, URLs firmadas de 5 min desde backend. Logs: solo IDs, contadores y códigos; nunca cuerpos, tokens ni nombres de conductores.

## 4. Requisitos para TI (Exchange Online)

0. Confirmar Exchange Online vs local. Local: definir integración autorizada (EWS en Exchange SE, IMAP OAuth o híbrido); mientras, modo simulado.
1. Buzón dedicado, preferiblemente compartido (sin licencia < 50 GB).
2. App de un solo tenant en Entra ID, sin redirect URI. Certificado (`.cer` público; clave privada solo en servidor). Secreto de 30–90 días solo para pruebas si TI lo autoriza.
3. Exchange Online PowerShell:
   ```powershell
   New-ServicePrincipal -AppId <AppId> -ObjectId <ObjectId de la Aplicación empresarial> -DisplayName "AutoFactura Terpel"
   New-ManagementScope -Name "Scope-AutorizacionesTerpel" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'autorizaciones-terpel@empresa.com'"
   New-ManagementRoleAssignment -App <AppId> -Role "Application Mail.Read" -CustomResourceScope "Scope-AutorizacionesTerpel"
   ```
4. Verificar en Entra que la app NO tenga Application Mail.Read de Graph consentido (los permisos se suman), ni Mail.ReadWrite ni Mail.Send.
5. Pruebas (propagación 30 min–2 h):
   ```powershell
   Test-ServicePrincipalAuthorization -Identity <AppId> -Resource autorizaciones-terpel@empresa.com   # InScope True
   Test-ServicePrincipalAuthorization -Identity <AppId> -Resource otro.buzon@empresa.com              # InScope False
   ```
   y `npm run graph:check` → 200 en buzón autorizado, 403 `ErrorAccessDenied` en el segundo.
6. Salida HTTPS a `login.microsoftonline.com` y `graph.microsoft.com`. Entregar Tenant ID, App ID, buzón, certificado por canal seguro, y muestras anonimizadas de la plantilla.

## 5. Costos por ambiente (referenciales)

| Ambiente | Componentes | Costo |
|---|---|---|
| Demo personal (no comercial) | Vercel Hobby + Supabase Free + MockMailSource | US$0 (Free pausa tras 7 días inactivo; Hobby prohíbe uso comercial) |
| Piloto local | Node 22 + Docker + Supabase CLI local + Fastify; Graph real con autorización de TI | US$0 software |
| Producción | Vercel Pro (~US$20/miembro/mes) + Supabase Pro (~US$25/mes, `sa-east-1`) | ~US$45–70/mes; Graph/Entra/buzón compartido sin costo adicional |
| Fases 2–4 | API Silogtran, proveedor de facturación | Por confirmar con proveedores |

Datos de conductor: datos personales (Ley 1581 de 2012) → acceso por rol, sin logs, retención definida con jurídica.

## 6. Criterios de aceptación — Fase 1

1. Rango 01–31 Bogotá → `[01T05:00Z, 32T05:00Z)`; pruebas de 23:59:59 y 00:00:00.
2. Dos ejecuciones del mismo rango o solapadas → un solo `source_messages` por mensaje; la segunda reporta duplicados.
3. Reenviada/corregida → nueva versión del mismo servicio, un solo `services`, incidencia visible.
4. `000123` idéntico en PostgreSQL y en celda Excel tipo texto.
5. `9973,0000` → raw `9973,0000`, numérico 9973.0000, unidad pendiente; vacío ≠ `0`.
6. Paginación simulada de 3 páginas con 429 + `Retry-After` → todos importados una vez.
7. Interrupción a mitad de página → reanudar sin duplicados; `found = imported + duplicates + needs_review + ignored`.
8. Excel: una fila por servicio del lote + Incidencias + Resumen; prueba que relee el .xlsx y lo compara campo a campo con la BD.
9. Fallo forzado del Excel → "Regenerar" produce el archivo desde el lote.
10. Remitente distinto → ignorado/revisión; variantes de asunto aceptadas.
11. Sin sesión no hay acceso a la API; operador no lee `body_raw` ni cambia configuración.

## 7. Plan de implementación — Fase 1

1. Esqueleto: TS estricto, ESLint, Vitest, CI (GitHub Actions), `.env.example`.
2. Núcleo: rango de fechas, normalizador de asunto/remitente, parser HTML/texto, decimales, clave de negocio + pruebas.
3. Fixtures sintéticos: válido, duplicado, reenviado (RV:), corregido con valor distinto, campos vacíos, etiquetas con otro formato, solo texto, remitente falso, decimal ambiguo, ceros iniciales. Conductores ficticios.
4. Migraciones Supabase + RLS + bucket privado + seed; pruebas con Supabase local (si Docker no está disponible en el entorno, usar PostgreSQL local o pg-mem/PGlite para pruebas y dejarlo documentado).
5. `MockMailSource` (paginación, 429, fallos) y `GraphMailSource` (MSAL cert/secreto, `$select`, nextLink, Retry-After) + script `graph:check`.
6. Orquestador: crear, pasos, lease, reanudar, contadores, incidencias.
7. Excel: ExcelJS, Storage, URL firmada, regeneración, prueba de concordancia con BD.
8. API: `POST /runs`, `POST /runs/:id/step`, `GET /runs`, `GET /runs/:id`, `POST /runs/:id/export`, `GET /runs/:id/export/url`; JWT Supabase; adaptadores Vercel + Fastify.
9. UI: login, selector de fechas, avance, tabla de resultados, incidencias, descarga, historial con "Reanudar" y "Regenerar".
10. `npm run demo:twice` (evidencia de idempotencia), README en español, `docs/guia-ti-exchange.md`, lista de probado/pendiente.

## 8. Fases 2–4 (solo diseño, no implementar)

- **Fase 2 — Conciliar con Silogtran (IMPLEMENTADA, ver README y `core/recon/`):** fuentes .xlsx (mapeo configurable) y API simulada → mismo `silogtran_records`. Candidatos por placa + fecha; discriminadores confirmados (transporte, remisión, peso/volumen solo con unidad confirmada). Resultados `EXACT`, `MATCH_WITH_DIFFERENCES`, `AMBIGUOUS`, `NO_MATCH`, `INSUFFICIENT_DATA` con dato Terpel, dato Silogtran y regla. Bandeja de revisión. Tolerancias en cero hasta validar.
  - **Reglas de negocio confirmadas (Fase 2):** (1) la placa NO es llave: puede ser distinta entre Terpel y Silogtran (se muestra como diferencia informativa); (2) el conductor siempre es el mismo, aunque en Silogtran el nombre puede venir incompleto: se compara normalizado y por contención; (3) la fecha de Terpel es de DESCARGUE y la de Silogtran es de DESPACHO: se compara con una ventana (despacho ≤ descargue), no por igualdad; (4) la ruta siempre debe coincidir; (5) si el volumen difiere (Terpel en galones), se propone el ajuste en Silogtran (Fase 3). Terpel puede traer volumen 0: no se compara ni se ajusta en 0 (por confirmar).
  - **Equivalencias de lugares (parametrizables):** tabla `place_aliases` (nombre en Silogtran → nombre en Terpel), editable por un administrador desde la aplicación (con auditoría), sin tocar código. Los nombres se comparan sin tildes ni mayúsculas. Valores iniciales: Chimitá → Bucaramanga, Lizama → Barrancabermeja, Villa del Rosario → Cúcuta, Puerto Berrío → Cimitarra. Si una ruta no coincide por un nombre desconocido, la bandeja de revisión ofrece "Agregar equivalencia" y reconcilia de nuevo.
  - **Filtros en cascada y parametrizables (cambio de diseño):** la ubicación del despacho es una cascada de filtros, como en Excel, con orden, activación y modo configurables desde la aplicación (tabla `match_filters`, solo administradores, con auditoría). Orden inicial: conductor (cédula) → placa → ruta (con equivalencias de lugares) → fecha (ventana de días). Cada filtro se puede activar o desactivar, cambiar de orden y fijar como **excluyente** (si deja cero candidatos, no hay coincidencia) o **preferente** (si dejara cero candidatos se ignora, se conserva el conjunto anterior y se marca la diferencia). Cada resultado guarda cuántos candidatos quedaron tras cada filtro. La placa deja de ser solo informativa y pasa a ser un filtro más; en los 5 despachos encontrados el 04/11 coincidió siempre con la de Silogtran.
  - **Ajustes decididos (Fase 3):** cuando difiere, se ajustan en Silogtran `remesa_peso` y el valor de la remesa; deben quedar iguales a lo que solicita Terpel (cómo se aplica se define después). El volumen de Terpel no puede ser cero: si viene en 0 no se ajusta el volumen y el valor de la remesa se ajusta al valor de Terpel (interpretación por confirmar). Un servicio de Terpel sin registro en Silogtran es normal (puede no estar despachado aún): queda como sin coincidencia, sin error.
  - **Pendiente de confirmar con el informe real:** ventana de días por ruta; si ambos sistemas comparten cédula/código del conductor, número de transporte o remisión; formato de la ruta en Silogtran (código vs nombre); dos viajes del mismo conductor y ruta dentro de la ventana: desde recon-1.1.0 se elige el despacho con la fecha más cercana (≤ fecha de Terpel) y se anota en la regla; solo si dos candidatos empatan en fecha queda AMBIGUOUS. Desde recon-1.2.0, si un filtro preferente (placa) deja la cascada en NO_MATCH, se reintenta sin él (la placa de Silogtran no siempre coincide).
  - **Estado de la Fase 2:** implementada con API de Silogtran (solo lectura), snapshot por tramos de 7 días, cascada de filtros parametrizable, bandeja de revisión, parámetros de admin y Excel. Verificada contra la API real (rango 2026-11-17 a 2026-11-25, 6 servicios: 3 con diferencias de volumen/valor, 2 exactos incluido el alias Lizama=Barrancabermeja y volumen 0, 1 sin registro). Pendiente: variables `SILOG_*` en Vercel (sin ellas la API responde `SILOG_NOT_CONFIGURED`).
  - **Ajustes posteriores de la Fase 2:** (a) solo se consideran registros de Silogtran con `estado = CUMPLIDO`. (b) Volumen 0 de Terpel parametrizable (`reconciliation_settings.zero_volume_mode`, solo admin, auditado): `ignore` (por defecto; INSUFFICIENT_DATA `ZERO_VOLUME_IGNORED`, "Volumen 0: se espera corrección de Terpel"), `reconcile_if_value_matches` (EXACT con `weightSource: silogtran` si el valor coincide exactamente; si no, INSUFFICIENT_DATA `ZERO_VOLUME_VALUE_MISMATCH`) y `reconcile_always` (cascada normal, sin comparar volumen, valor comparado, `weightSource: silogtran`). Con volumen > 0, `weightSource: terpel`.
  - **Regla recon-1.3.0 (decisión del usuario):** si el total de la remesa en Silogtran coincide exactamente con el valor neto de Terpel no hay diferencia de volumen ni de valor (estado `EXACT`): el peso cumplido no viene ni en el informe ni en la consulta de la remesa, y si volumen × tarifa reproduce el valor exacto no hay error. La diferencia de volumen se reporta solo cuando el total NO coincide. Efecto: las propuestas de ajuste solo se generan cuando el total difiere; ya no se corrigen peso/cantidad cuando el total ya es igual (decisión del usuario). Al regenerar, las propuestas vivas de servicios que dejaron de tener diferencias pasan a `stale`.
- **Fase 3 — Ajustes (IMPLEMENTADA CON ESCRITOR SIMULADO; ver README):** `adjustment_proposals` (campo, actual, propuesto, regla, fuente según matriz `field_authority`). Modos simulate / approval_required / auto. Leer y comparar versión → escribir con clave idempotente → releer; incierto → consultar antes de reintentar.
  - **Procedimiento de cambio en Silogtran (diseño, NO implementado):** pantalla "Procedimiento de Cambio Tarifa", por remesa (ej. remesa 0101228393). Campos: Remesa (código), Razón de cambio (texto) y, por ítem, Peso Remesa, Cantidad Remesa y Nueva Tarifa (tipo de tarifa GALON, cliente Terpel). Regla: Peso Remesa = Cantidad Remesa = galones que indica Terpel; Nueva Tarifa = valor neto de Terpel ÷ galones; la tarifa NO tiene que ser entera: el campo "Nueva Tarifa" de Silogtran admite hasta 12 caracteres (el punto cuenta), o sea hasta 8 decimales con 3 dígitos enteros (7 con 4 dígitos). REGLA FINAL (decidida por el negocio): el valor debe quedar IDÉNTICO, sin tolerancia. Antes de escribir se comprueba con aritmética decimal exacta (nunca coma flotante) que valor ÷ galones es un decimal finito que cabe en 12 caracteres y que tarifa × galones == valor de Terpel exactamente; si la división no es exacta (p. ej. 913,333…) o no cabe, el servicio va a revisión y NO se escribe. El redondeo interno de Silogtran no es observable antes de escribir, así que después de escribir se relee el informe de Silogtran y se confirma que `remesa_peso` = galones y `total_remesa` = valor de Terpel; si no coinciden, el servicio queda marcado como discrepancia (no se factura) y se avisa. Datos reales: 136 de 146 despachos de Terpel cumplidos tienen tarifa entera y 10 no (p. ej. 913,33333333 y 235,02232), y Silogtran guarda totales con decimales. El separador decimal en Silogtran es el punto (.). Si Terpel viene en 0 y el parámetro permite conciliar, como la coincidencia por valor es exacta se toma el peso de Silogtran (`weightSource = silogtran`): Nueva Tarifa = valor Terpel ÷ peso Silogtran.
  - **Pendientes de Fase 3:** documentación oficial de escritura de la API de Silogtran (autenticación, permisos, errores, entorno de pruebas); documentación oficial de escritura y decisión de qué hacer ante una discrepancia posterior a la escritura (la regla de exactitud ya está decidida: sin tolerancia); razón de cambio estándar; quién aprueba.
  - **Estado de la Fase 3:** implementados el cálculo exacto de tarifa (BigInt), las propuestas con reglas por línea, la máquina de estados idempotente con eventos, simular / aprobar / rechazar / aplicar (individual y lote), la relectura previa y la verificación posterior, el manejo de resultados inciertos, el gancho de elegibilidad para automático (`adjustments_auto_enabled`, apagado), permisos (`adjustments.*`), UI «Ajustes» y Excel. TODO lo que se «aplica» hoy es SIMULADO (`SILOG_WRITER=mock`, estado `simulated_applied`): la Fase 4 no debe tratarlo como ajustado.
  - **Escritor real (no implementado):** pantalla `https://construproyec.colombiasoftware.net/index.php?page=Despacho.Remesa_003.CambioTarifa_105` (PRADO). Vivirá dentro de esta app. Plan: (1) diagnóstico de solo lectura de la pantalla con la cuenta de ajustes; (2) login web con reto AWS WAF vía Chromium; (3) cookies de sesión reutilizables; (4) escritura y verificación.
  - **Qué cambiaría para enchufarlo:** implementar `SilogtranWebWriter` (`changeTariff` y `getChangeState`, con `simulated=false`) y poner `SILOG_WRITER=web`. Secretos: la cuenta de ajustes ya está cifrada en `silog_credentials` (`purpose='adjust'`, `ENCRYPTION_KEY`); habría que guardar de forma cifrada las cookies de sesión reutilizables (nueva tabla o campo cifrado con su propio AAD). Vercel: un navegador Chromium headless no cabe en una función estándar (tamaño y 30 s máx.), por lo que el escritor tendría que correr en un servicio aparte con Chromium (contenedor/worker, p. ej. Render o un runner) que la función de Vercel invoque de forma asíncrona, o usar un Chromium empaquetado para serverless si el reto WAF lo permite; el paso «aplicar» pasaría a ser asíncrono (estado `applying` + consulta) y respetar el límite de 30 s por función. Límites: reto WAF (posible bloqueo por IP de centro de datos), una sesión por cuenta, serialización de escrituras, y la verificación posterior usa la lectura ya existente.
  - **Incremento 3a (login web y diagnóstico, IMPLEMENTADO):** cliente web de Silogtran con reto AWS WAF resuelto por la función `api/silog-waf` (Chromium), sesión web cifrada reutilizable y diagnóstico de solo lectura de la pantalla de cambio de tarifa. Mapa y secuencia propuesta de escritura en `docs/silogtran-cambio-tarifa.md`. Pendiente (3b): implementar `SilogtranWebWriter` con esa secuencia, aclarar la discrepancia de peso (pantalla 10500 vs informe 10460) y la primera escritura real con aprobación explícita.
  - **Incremento 3b (escritor real, IMPLEMENTADO, desactivado por defecto):** `SilogtranWebWriter` con ensayo (todos los pasos menos Grabar), modo del escritor y lista de remesas permitidas en BD (solo admin), reversa guardada y propuesta de reversa, verificación posterior por pantalla e informe, `uncertain` ante cualquier ambigüedad. Procedimiento de activación, verificación y reversa en `docs/silogtran-cambio-tarifa.md`. La primera escritura real la hace el usuario con su propia aprobación en la UI. **Corrección tras la primera escritura real:** el informe de Silogtran no refleja el peso/cantidad que cambia el ajuste; la verificación (y los valores actuales/reversa) pasaron a la consulta Home_111 (ver `docs/silogtran-cambio-tarifa.md`). Texto de éxito de Grabar: «La remesa #… fue actualizado con éxito!».
- **Fase 4 — Facturación (IMPLEMENTADA 4a, sin emisión real; ver `docs/silogtran-facturacion.md`):** una factura por remesa vía la pantalla web Automatica_111, índice único de una factura activa por remesa, ensayo obligatorio, regla crítica (flete = valor Terpel), `uncertain` nunca se reintenta a ciegas, lote real apagado por defecto. Diseño original: elegible si conciliado + ajustes confirmados o sin ajustes + datos completos + regla de cliente activa (9P desactivada hasta confirmar NIT). `invoices.service_id` UNIQUE, `idempotency_key`, `SELECT … FOR UPDATE`, estados `pending→submitting→submitted→accepted|rejected|uncertain`. Timeout → buscar factura existente. Registrar número, CUFE, estado DIAN, rechazo. Producción bloqueada hasta aprobación.

## 9. Decisiones abiertas (con valor por defecto)

- Clave de negocio: número de transporte (configurable).
- Versión vigente ante corrección: la más reciente + revisión.
- Muestra real anonimizada HTML y variantes: pendiente.
- Reenvíos internos: revisión con `SENDER_NOT_ALLOWED`.


## 10. Usuarios, roles, cuentas de Silogtran y modo asistido / no asistido (diseño acordado; incremento 1 IMPLEMENTADO)

**Estado.** Incremento 1 implementado: usuarios (`app_users`), roles (`admin`, `facturacion`, `operator`, `viewer`), matriz central de permisos (`core/permissions.ts`; la API devuelve `permissions` en `/me` y la UI muestra solo lo permitido), credenciales cifradas AES-256-GCM (`silog_credentials`: de persona opcional y de servicio por `purpose` = `adjust`|`invoice`; hoy solo se usa `adjust`), «Probar conexión» por login por API (lectura), e ingreso con usuario de Silogtran (`POST /api/auth/silog-login`) con límite de intentos persistido en BD (`login_attempts`: 5 fallos/usuario y 20/IP cada 15 min, evaluado antes de llamar a Silogtran). Los modos asistido/no asistido, la Fase 3 y la Fase 4 siguen sin implementar. El login WEB de Silogtran (reto AWS WAF) se verificará en la Fase 3.

**Variables nuevas (solo servidor):** `ENCRYPTION_KEY` (64 hex; sin ella no se guardan credenciales: 503 `ENCRYPTION_NOT_CONFIGURED`) y `APP_SESSION_SECRET` (≥ 32 caracteres; sin él el ingreso con Silogtran responde 503 `SESSION_NOT_CONFIGURED`). El ingreso por correo (Supabase) no depende de ellas.

**Matriz de permisos.**

| Permiso | admin | facturacion | operator | viewer |
|---|---|---|---|---|
| Ver resultados | sí | sí | sí | sí |
| Importar / conciliar / resolver revisión | sí | sí | sí | no |
| Ver parámetros | sí | sí | no | no |
| Editar parámetros, equivalencias, volumen 0, buzón | sí | no | no | no |
| Usuarios y credenciales | sí | no | no | no |

**Sesión.** Token propio HS256 (`typ:'app'`, 8 h, `APP_SESSION_SECRET`) que convive con el JWT de Supabase; en cada petición se consulta `app_users` (activo, rol vigente, `session_version`), así que desactivar, cambiar el rol o cerrar sesión surte efecto en la siguiente petición. Protección de administradores: nadie puede desactivarse ni quitarse el rol a sí mismo y siempre queda al menos un administrador activo.

**Usuarios y credenciales (solo administrador).** Cada usuario de la app tiene su usuario de Silogtran, un rol (administrador / facturación) y, opcionalmente, su contraseña de Silogtran guardada CIFRADA (AES-256-GCM, clave solo en el servidor, AAD = id del registro; nunca se muestra ni se devuelve por la API; botón "Probar conexión"; auditoría). Las personas pueden ingresar a la app con su usuario y contraseña de Silogtran (se valida contra el API de Silogtran; solo entran los usuarios registrados por el administrador; límite de intentos y mensajes uniformes para no usar la app como adivinador de contraseñas ni bloquear cuentas de Silogtran). Cada persona ve solo las opciones de su rol; las parametrizaciones se ven (según permisos) pero la administración de usuarios y credenciales es solo del administrador.

**Cuentas de servicio de Silogtran (parametrizadas por el administrador).** Una cuenta de AJUSTES (con la que se escribe el cambio de tarifa en Silogtran) y la(s) cuenta(s) de FACTURACIÓN. Deben estar sin cambio de contraseña pendiente ni verificación en dos pasos. La app siempre registra qué persona pidió cada acción, aunque en Silogtran quede la cuenta de servicio.

**Permisos.** Facturación puede proponer, aprobar y APLICAR ajustes; los ajustes se escriben en Silogtran con la cuenta de ajustes parametrizada. Solo el administrador edita parámetros y administra usuarios/credenciales.

**Modo asistido / no asistido.** Un selector (por defecto ASISTIDO) define cómo se ejecuta el proceso conciliar → ajustar → facturar:
- ASISTIDO: la app propone y una persona aprueba cada paso (ajustes y facturas).
- NO ASISTIDO (automático): tras conciliar, la app aplica los ajustes y factura sola SOLO los servicios que cumplan al 100% las condiciones de elegibilidad; todo lo demás queda en la bandeja de revisión sin tocarse. Al final entrega un reporte completo de lo hecho.
- Condiciones de elegibilidad propuestas (por confirmar): un único despacho candidato; solo diferencias ajustables (remesa_peso y/o valor); volumen de Terpel > 0 (o volumen 0 solo si el parámetro lo permite y el valor coincide exacto); valor ÷ galones EXACTO (decimal finito de hasta 12 caracteres, tarifa × galones == valor, aritmética decimal exacta) y confirmación posterior releyendo el total en Silogtran; registro CUMPLIDO y sin factura previa en Silogtran; datos completos de facturación.
- Protecciones: el modo no asistido solo lo habilita el administrador; interruptor de apagado; tope de servicios por ejecución; idempotencia por servicio (nunca doble ajuste ni doble factura); verificar el estado antes de escribir y confirmar después; ante un resultado incierto se consulta el estado antes de reintentar; un fallo individual deja ese servicio en revisión y el lote sigue, pero un fallo sistémico (login, WAF, errores repetidos) detiene el lote.
- Reporte por ejecución (pantalla y Excel): por cada servicio, cada paso (conciliación, ajuste, factura), valores antes/después, cuenta usada, quién lo pidió, número de factura/CUFE/estado y errores o motivos de revisión.

**Modo asistido (IMPLEMENTADO).** Plan sin efectos → confirmación explícita → corrida por pasos (aprobar, ensayar, aplicar) → reporte `.xlsx`. Excluye y explica lo no elegible (volumen 0, ambiguos, sin coincidencia, ya ajustado, revisión, fuera de la lista); omite si el ensayo falla; se detiene ante cualquier resultado incierto o fallo tras grabar y deja el resto sin tocar; reanudable e idempotente. El modo NO asistido (automático, sin confirmación) sigue sin implementarse. Facturación: Fase 4a implementada (sin emisión real), pestaña «Facturación».

**Orden de construcción propuesto (cada incremento requiere aprobación):** (1) usuarios, roles y credenciales cifradas + ingreso con usuario de Silogtran; (2) Fase 3: propuesta/simulación/aprobación y aplicación de ajustes (con adaptador simulado hasta mapear la pantalla "Procedimiento de Cambio Tarifa"); (3) Fase 4: facturación con adaptador simulado; (4) orquestador asistido / no asistido y reporte.
