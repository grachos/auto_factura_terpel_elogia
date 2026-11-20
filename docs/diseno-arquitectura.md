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

Volumen: `transport_volume_raw`, `transport_volume` numérico, `transport_volume_unit = NULL`, `unit_status = 'pending_confirmation'`. Sin conversión.

Planta 9P: solo marca `loading_plant_flag = '9P'`; sin regla de cliente en Fase 1.

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

- **Fase 2 — Conciliar con Silogtran:** fuentes .xlsx (mapeo configurable) y API simulada → mismo `silogtran_records`. Candidatos por placa + fecha; discriminadores confirmados (transporte, remisión, peso/volumen solo con unidad confirmada). Resultados `EXACT`, `MATCH_WITH_DIFFERENCES`, `AMBIGUOUS`, `NO_MATCH`, `INSUFFICIENT_DATA` con dato Terpel, dato Silogtran y regla. Bandeja de revisión. Tolerancias en cero hasta validar.
- **Fase 3 — Ajustes:** `adjustment_proposals` (campo, actual, propuesto, regla, fuente según matriz `field_authority`). Modos simulate / approval_required / auto. Leer y comparar versión → escribir con clave idempotente → releer; incierto → consultar antes de reintentar.
- **Fase 4 — Facturación:** elegible si conciliado + ajustes confirmados o sin ajustes + datos completos + regla de cliente activa (9P desactivada hasta confirmar NIT). `invoices.service_id` UNIQUE, `idempotency_key`, `SELECT … FOR UPDATE`, estados `pending→submitting→submitted→accepted|rejected|uncertain`. Timeout → buscar factura existente. Registrar número, CUFE, estado DIAN, rechazo. Producción bloqueada hasta aprobación.

## 9. Decisiones abiertas (con valor por defecto)

- Clave de negocio: número de transporte (configurable).
- Versión vigente ante corrección: la más reciente + revisión.
- Muestra real anonimizada HTML y variantes: pendiente.
- Reenvíos internos: revisión con `SENDER_NOT_ALLOWED`.
