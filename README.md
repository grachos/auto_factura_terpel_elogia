# AutoFactura Terpel — Fases 1 y 2

Importa los correos de **autorización de pago** de Terpel desde un buzón, extrae los datos de cada servicio con reglas deterministas (sin IA), los guarda en PostgreSQL (Supabase) sin duplicados y genera un **Excel** del lote desde la base de datos.

Alcance: **solo Fase 1** (importar correos, Excel y persistencia). La conciliación con Silogtran, los ajustes y la facturación (Fases 2–4) están documentados en [`docs/diseno-arquitectura.md`](docs/diseno-arquitectura.md) y **no** están implementados.

> Funciona de punta a punta con **datos ficticios** y sin credenciales (`MockMailSource`). Para leer el buzón real hace falta que TI autorice el acceso: ver [`docs/guia-ti-exchange.md`](docs/guia-ti-exchange.md).

## Contenido

- [Arquitectura](#arquitectura)
- [Inicio rápido (demo)](#inicio-rápido-demo)
- [Comandos](#comandos)
- [Piloto local (Supabase CLI + Fastify)](#piloto-local-supabase-cli--fastify)
- [Despliegue en Vercel + Supabase](#despliegue-en-vercel--supabase)
- [Probar con Exchange Online real](#probar-con-exchange-online-real)
- [Variables de entorno](#variables-de-entorno)
- [Reglas de negocio implementadas](#reglas-de-negocio-implementadas)
- [Probado vs. pendiente de verificar](#probado-vs-pendiente-de-verificar)
- [Seguridad y privacidad](#seguridad-y-privacidad)

## Arquitectura

```
core/        Lógica agnóstica del framework (fechas, parser, decimales, orquestador, Excel, API)
  mail/        MailSource: GraphMailSource (MSAL + fetch) y MockMailSource
  db/          Db: pg (Supabase/PostgreSQL) y PGlite (pruebas/demo)
  storage/     StorageAdapter: Supabase Storage y sistema de archivos (demo)
  http/        Despachador común de la API
api/         Función de Vercel (Node.js): un catch-all /api/* sobre core/http
server/      Fastify local: el MISMO despachador + frontend compilado
web/         React + Vite (UI en español)
supabase/    Migraciones SQL reales (RLS, bucket privado), seed y shim solo para PGlite
fixtures/    Correos sintéticos (conductores ficticios)
scripts/     demo:twice, graph:check, migraciones
tests/       Vitest (unidad + integración) y Playwright (smoke de UI)
```

Cómo funciona una importación (resumen del diseño):

1. El operador elige un rango de fechas (hora de Bogotá). Se guarda `import_runs` y solo puede haber **una ejecución activa por buzón**.
2. El cliente llama repetidamente a `POST /api/runs/:id/step`. Cada paso procesa **una página** del origen de correo (< 20 s), dentro de una transacción que también guarda el cursor (`@odata.nextLink`). Si algo se interrumpe, se reanuda desde el historial sin duplicar.
3. Cada mensaje se clasifica: `imported`, `duplicate`, `needs_review`, `ignored_sender`, `ignored_subject` o `parse_error`. Los contadores se recalculan desde `run_messages`, así que `encontrados = importados + duplicados + por revisar + ignorados` siempre se cumple.
4. Al terminar se genera el Excel **desde la base de datos** y se sube a un bucket privado; la descarga usa una URL firmada de 5 minutos. Si falla, la ejecución queda con `export_status = failed` y el botón **Regenerar** lo rehace.

## Inicio rápido (demo)

Requisitos: Node.js 22+ y npm. No hace falta Docker, Supabase ni cuenta alguna.

```bash
npm install
npm run demo            # compila la UI y arranca http://127.0.0.1:3000 en modo demo
```

Abra `http://127.0.0.1:3000`, elija un usuario de prueba (contraseña `demo`) e importe el rango 01–31 de enero de 2026 (ya viene precargado):

| Usuario | Rol | Puede |
|---|---|---|
| `operador@demo.local` | Operador | Importar, reanudar, regenerar y descargar |
| `lector@demo.local` | Lector | Solo consultar y descargar |
| `admin@demo.local` | Administrador | Lo anterior + configuración del buzón |

En modo demo la base de datos es **PGlite** (PostgreSQL embebido que ejecuta las migraciones SQL reales) guardada en `.data/pglite`, y los Excel se guardan en `.data/storage` con URLs firmadas HMAC. Borre `.data/` para empezar de cero.

Evidencia de idempotencia (sin servidor ni UI):

```bash
npm run demo:twice
```

Importa dos veces el mismo rango y verifica que quede un registro por mensaje, que la segunda ejecución reporte todo como duplicado y que el Excel de cada ejecución concuerde campo a campo con la base de datos.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm install` | Instala dependencias |
| `npm run typecheck` | TypeScript estricto (backend y web) |
| `npm run lint` | ESLint |
| `npm test` | Vitest: unidad + integración (PGlite con las migraciones reales, RLS, Graph simulado, API) |
| `npm run test:e2e` | Smoke de UI con Playwright (usa el Chromium preinstalado; compila y levanta el servidor demo en el puerto 4310) |
| `npm run demo` | UI + API en modo demo |
| `npm run demo:twice` | Importa dos veces el mismo rango y verifica idempotencia y Excel vs BD |
| `npm run dev` | API (`tsx watch`) + Vite con proxy a `/api` |
| `npm run build` | Compila la UI a `dist/web` |
| `npm run graph:check` | Prueba el acceso a Exchange Online (ver abajo) |
| `npm run db:migrate` | Aplica `supabase/migrations` a un PostgreSQL (`DATABASE_URL`) |

## Piloto local (Supabase CLI + Fastify)

Para usar PostgreSQL y Storage reales en la máquina del piloto (requiere Docker):

```bash
npx supabase start                  # levanta Postgres, Auth, Storage locales y aplica supabase/migrations + seed
npx supabase status                 # muestra API URL, anon key, service_role key, JWT secret y DB URL
cp .env.example .env
```

En `.env`:

```
AUTH_MODE=supabase
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
STORAGE_DRIVER=supabase
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key de supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key de supabase status>
SUPABASE_JWT_SECRET=<JWT secret de supabase status>
MAIL_SOURCE=mock            # o graph cuando TI autorice
```

Cree un usuario en Supabase Studio (`http://127.0.0.1:54323` → Authentication) y asígnele rol:

```sql
insert into public.user_roles (user_id, role) values ('<uuid del usuario>', 'admin');  -- operator | admin | viewer
```

Luego `npm run build && npm start` y abra `http://127.0.0.1:3000` (la UI inicia sesión con Supabase Auth).

> **Sin Docker:** el piloto con Supabase local no es posible; use el modo demo (PGlite). Las pruebas de integración también corren sin Docker porque ejecutan las migraciones reales sobre PGlite con un *shim* mínimo de los objetos de Supabase (`supabase/tests/shim.sql`: roles `anon/authenticated/service_role`, `auth.users`, `auth.uid()` y `storage.buckets`). Ese shim **no** se aplica a Supabase.

## Despliegue en Vercel + Supabase

1. **Supabase**: cree un proyecto (región sugerida `sa-east-1`). Aplique el esquema:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push                # aplica supabase/migrations (incluye RLS y el bucket privado "exports")
   ```
   Cree los usuarios en Authentication y asigne roles con el `insert into public.user_roles ...` de arriba. Inserte la configuración inicial del buzón (ver `supabase/seed.sql`) o deje que la aplicación la cree desde las variables `MAIL_*` en el primer arranque.
2. **Vercel**: importe el repositorio (framework "Other"). `vercel.json` ya define `npm run build`, salida `dist/web`, la reescritura SPA y `maxDuration: 30` para `api/**`.
3. **Variables de entorno en Vercel** (nunca en el repositorio):
   - `AUTH_MODE` **sin definir** (o `supabase`). El modo demo está bloqueado en producción.
   - `DATABASE_URL` (cadena del *pooler* de transacciones de Supabase), `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_JWT_SECRET` (o, si el proyecto usa claves de firma asimétricas, dejar `SUPABASE_JWT_SECRET` vacío: se valida con el JWKS de `SUPABASE_URL`).
   - `MAIL_SOURCE`, `MAIL_MAILBOX`, `MAIL_ALLOWED_SENDER`, `MAIL_SUBJECT_PATTERN` y, para Graph, las `GRAPH_*` (en Vercel la clave privada va en `GRAPH_CLIENT_CERT_PRIVATE_KEY` con saltos de línea como `\n`).
4. **Límites**: cada paso procesa una página y debe terminar en < 20 s; la función tiene `maxDuration: 30`. Revise el límite de su plan de Vercel. El plan Hobby es solo para uso no comercial y el plan gratuito de Supabase se pausa tras 7 días de inactividad.

## Probar con Exchange Online real

Cuando TI complete [`docs/guia-ti-exchange.md`](docs/guia-ti-exchange.md):

```bash
# .env
MAIL_SOURCE=graph
MAIL_MAILBOX=autorizaciones-terpel@su-empresa.com
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_CERT_THUMBPRINT=...
GRAPH_CLIENT_CERT_PRIVATE_KEY_PATH=/ruta/segura/clave.pem
# solo pruebas y con autorización de TI: GRAPH_CLIENT_SECRET=...
GRAPH_CHECK_DENIED_MAILBOX=otro.buzon@su-empresa.com

npm run graph:check              # buzón autorizado → HTTP 200
npm run graph:check -- --denied  # buzón no autorizado → HTTP 403 ErrorAccessDenied
```

Sin credenciales, `graph:check` termina con un mensaje en español que lista las variables faltantes (código de salida 2). Con `graph:check` en verde, pruebe un rango corto desde la UI. Solo se hacen peticiones **GET**; no se modifican correos.

## Fase 2 — Conciliar con Silogtran (solo lectura)

La app compara cada servicio de Terpel (autorización vigente) con el informe de Silogtran. **Silogtran es solo lectura**: no hay ninguna llamada de escritura (los ajustes son la Fase 3, no implementada).

- **Fuente**: `SilogtranSource` con `SilogtranApiSource` (login `servicio.Seguridad.login`, informe `servicio.Manifiesto.InformeGeneral`, cabecera `Authorization` con el token crudo, nuevo login ante 401, timeout de 20 s, errores sin credenciales) y `MockSilogtranSource` (datos sintéticos; modo demo sin credenciales). Variables solo de servidor: `SILOG_BASE_URL`, `SILOG_USER`, `SILOG_PASSWORD`, opcional `SILOG_TERPEL_NIT` (830095213). Sin ellas la API responde `SILOG_NOT_CONFIGURED` con un mensaje claro.
- **Snapshot incremental**: la sincronización trae tramos de 7 días (medido: 1–3 s por tramo, ~1.200 filas) y hace upsert por (`manifiesto`, `remesa_codigo`) en `silogtran_records`; se deduplican las filas repetidas, se filtra por NIT y se excluye `ANULADO` al conciliar. Es reanudable e idempotente. Bitácora en `silogtran_sync_log`.
- **Conciliación** (`POST /api/reconciliations` + `POST /api/reconciliations/:id/step`): sincroniza Silogtran desde `fecha_min − lookback` (15 días) hasta `fecha_max` y concilia en lotes de 150 servicios. Un resultado vigente por servicio (`reconciliation_results`); reconciliar de nuevo no duplica y conserva la elección manual.
- **Cascada de filtros** (tabla `match_filters`, editable por admin): conductor (cédula sin ceros) → placa → ruta (con `place_aliases`) → fecha (`0 ≤ descargue − despacho ≤ N` días, N=10). Modo *excluyente* (0 candidatos ⇒ `NO_MATCH`) o *preferente* (si dejaría 0 se ignora y se anota). Por defecto: conductor, ruta y fecha excluyentes; placa preferente. Cada resultado guarda la traza `[{filter, before, after, mode, skipped}]`.
- **Regla recon-1.3.0 (decisión del usuario)**: el informe no trae el peso cumplido ni la consulta de la remesa lo expone; por eso, si el **total de la remesa en Silogtran coincide exactamente con el valor neto de Terpel**, no hay diferencia de volumen ni de valor y el servicio es `EXACT` (si volumen × tarifa da el valor exacto no hay error). La diferencia de volumen solo se reporta cuando el total NO coincide. Consecuencia: ya no se proponen ajustes de peso/cantidad cuando el total ya es igual; solo se proponen cuando el total difiere. Al regenerar propuestas, las que quedaron de servicios sin diferencias pasan a `stale`.
- **Estados**: `EXACT`, `MATCH_WITH_DIFFERENCES` (solo diferencias `adjustable`: volumen Terpel vs `remesa_peso` —no se compara si Terpel trae 0— y valor neto vs `total_remesa`), `AMBIGUOUS` (nunca se elige al azar), `NO_MATCH` (normal si aún no se despachó), `INSUFFICIENT_DATA`. La placa distinta es solo informativa.
- **Bandeja de revisión** (UI «Conciliación»): ver traza y diferencias, elegir candidato (operador/admin, auditado con usuario y fecha) y «Agregar equivalencia» de lugar (admin) que re-concilia el servicio. Excel (hojas *Conciliación*, *Incidencias*, *Resumen*) por el mismo `StorageAdapter`.
- **Solo registros CUMPLIDO**: del informe de Silogtran solo se consideran las filas con `estado = CUMPLIDO` (se excluyen ANULADO y ACTIVO). El snapshot solo guarda CUMPLIDO; si una fila ya guardada cambia de estado, solo se actualiza su estado (no se borra nada) y deja de ser candidata. Al conciliar se ignora cualquier fila guardada con otro estado.
- **Volumen 0 de Terpel (parámetro `zero_volume_mode`, solo admin, auditado; pestaña Parámetros)**. Regla de negocio: si Terpel manda volumen 0, por defecto no se tiene en cuenta (el cliente corrige y reenvía).
  - `ignore` (por defecto): el servicio no se concilia: `INSUFFICIENT_DATA` con motivo `ZERO_VOLUME_IGNORED` ("Volumen 0: se espera corrección de Terpel"); sin ajuste.
  - `reconcile_if_value_matches`: cascada normal; con un único candidato, si el valor neto de Terpel es exactamente `total_remesa` → `EXACT` (el volumen no se compara; `weightSource = silogtran`); si no coincide → `INSUFFICIENT_DATA` con `ZERO_VOLUME_VALUE_MISMATCH` (no se concilia ni se ajusta).
  - `reconcile_always`: cascada normal; el volumen no se compara; el valor sí (diferencia ajustable si difiere); `weightSource = silogtran`.
  - Con volumen > 0 el comportamiento no cambia (`weightSource = terpel`). El motivo y el origen del peso se ven en la tabla de Conciliación, en el Excel y en la API.
- **Parámetros** (solo admin): equivalencias de lugares (CRUD), orden/activación/modo de filtros, ventana de días, lookback y NIT; todo con `audit_log`.
- Migración `supabase/migrations/0005_phase2_reconciliation.sql`; equivalente para el Supabase compartido en `supabase/deploy/terpel_0005_phase2_reconciliation.sql` (esquema `terpel`, dueño `terpel_app`).

Probar en demo: `npm run demo`, entrar como operador, importar enero de 2026 y abrir **Conciliación** (Silogtran simulado). Con credenciales reales: definir `SILOG_*` en `.env` (o en Vercel) y elegir un rango.

## Usuarios, roles y credenciales (incremento 1)

- **Ingreso**: pantalla con dos opciones, «Correo» (Supabase, como antes) y «Usuario de Silogtran». Con la segunda, la app comprueba primero que el usuario esté **registrado y activo** (`app_users`) y solo entonces valida la contraseña con el login por API de Silogtran (solo lectura; la contraseña no se guarda). Emite un token propio de 8 h (`APP_SESSION_SECRET`). Límite de intentos persistido en BD, mensajes uniformes, `Retry-After` en bloqueos, auditoría sin datos sensibles.
- **Roles y permisos** (`core/permissions.ts`, devueltos en `/me`): `admin` (todo), `facturacion` (importar, conciliar, resolver; ve parámetros sin editarlos; sin usuarios), `operator` (importar/conciliar/resolver), `viewer` (solo lectura). Detalle en la sección 10 de `docs/diseno-arquitectura.md`.
- **Pestaña «Usuarios»** (solo admin): alta/edición/desactivación de usuarios por su usuario de Silogtran, contraseña opcional guardada **cifrada** (AES-256-GCM, AAD = id del registro, formato `v1:`; solo escritura, nunca se devuelve; «Probar conexión»), y **cuenta de ajustes** (credencial de servicio `adjust`; el modelo admite también `invoice`). Protección del último administrador.
- **Variables nuevas** (solo servidor): `ENCRYPTION_KEY` (64 hex: `openssl rand -hex 32`) y `APP_SESSION_SECRET` (`openssl rand -base64 48`). Si faltan, el guardado de credenciales y el ingreso con Silogtran responden un error claro (503) y el ingreso por correo sigue funcionando. En modo demo, cualquier usuario registrado entra con la contraseña `demo` (Silogtran simulado).
- Migración `0007_users_credentials.sql` (+ `supabase/deploy/terpel_0007_users_credentials.sql`): tablas sin permisos para `anon`/`authenticated`.

## Fase 3 — Ajustes de tarifa (SIMULADOS: Silogtran no se modifica)

- **Qué hace**: a partir de una conciliación completada, genera una **propuesta por servicio** con diferencias ajustables (incluye el caso de volumen 0 con `weightSource = silogtran` y diferencia de valor): Peso Remesa, Cantidad Remesa (actual «no disponible en el informe»), Nueva Tarifa y total de la remesa, cada uno con su regla. Se puede **simular** (muestra exactamente qué se enviaría, sin cambiar estado), **aprobar**, **rechazar** y **aplicar** (individual o en lote seleccionado).
- **Tarifa exacta**: galones = volumen de Terpel (o el peso de Silogtran cuando `weightSource = silogtran`); tarifa = valor neto de Terpel ÷ galones con aritmética decimal exacta (BigInt, sin coma flotante), decimal finito de **máximo 12 caracteres** (el punto cuenta), punto decimal, y tarifa × galones debe reproducir el valor sin tolerancia. Si no: `needs_review` con `TARIFF_NOT_EXACT`, `TARIFF_TOO_LONG` o `INVALID_INPUT`, y no se puede aprobar ni aplicar. Ej.: 2464445 ÷ 10487 = 235; 6694492 ÷ 10174 = 658; 2346240 ÷ 9984 = 235.
- **Estados** (`adjustment_proposals` + línea de tiempo en `adjustment_events`): `proposed → approved → applying → applied | failed | uncertain | verification_failed`, más `needs_review`, `rejected`, `stale`, `simulated_applied` y `discarded`. Idempotencia: clave única (servicio + autorización + galones/tarifa/valor), `FOR UPDATE` y compare-and-set a `applying`, e índice único de una sola aplicación por servicio. Antes de escribir se **relee** Silogtran (CUMPLIDO, sin factura y mismos valores; si no → `stale`, sin escribir). Después de escribir se relee y se confirma `remesa_peso` y total (si no → `verification_failed`, no se factura). Un resultado incierto **no se reintenta**: se consulta el estado y solo desde `failed` (certeza de no aplicado) se reintenta.
- **Modo simulado (crítico)**: el escritor por defecto es `MockSilogtranWriter` (`SILOG_WRITER=mock`). Con él las aplicaciones terminan en `simulated_applied` (nunca `applied`), con `simulated=true` en API, UI y Excel, la verificación se omite con la nota «simulado» y la UI muestra el banner permanente «MODO SIMULADO: Silogtran no se modifica». La facturación futura NO debe tratar `simulated_applied` como ajustado. El admin puede **descartar simulaciones** (queda el historial). `SILOG_WRITER=web` selecciona el esqueleto `SilogtranWebWriter`, que responde `WRITER_NOT_IMPLEMENTED`.
- **Permisos**: ver ajustes: todos los roles; generar, aprobar y aplicar: admin y facturación; plantilla de razón y `adjustments_auto_enabled`: solo admin. Cada propuesta registra quién generó, aprobó y aplicó, la cuenta de servicio `adjust` usada y las fechas; aplicar de verdad sin cuenta de ajustes → `ADJUST_ACCOUNT_NOT_CONFIGURED`.
- **Razón de cambio**: plantilla parametrizable (marcadores `{transport}`, `{expense}`, `{remesa}`, `{manifest}`, máx. 200 caracteres). Por defecto «Ajuste según autorización de pago Terpel, transporte {transport}, gasto {expense}».
- **Automático**: existe la función de elegibilidad (único candidato, solo diferencias ajustables, volumen > 0 salvo volumen 0 conciliado por valor, tarifa exacta, CUMPLIDO sin factura, datos completos) y el parámetro `adjustments_auto_enabled` (apagado). No hay orquestador: es un incremento posterior.
- **Escritor real (pendiente)**: la pantalla es `https://construproyec.colombiasoftware.net/index.php?page=Despacho.Remesa_003.CambioTarifa_105` (PRADO, «Procedimiento de Cambio Tarifa» por remesa). Decisión: el escritor vivirá **dentro de esta app**. Para enchufarlo bastará implementar `SilogtranWriter` (`core/adjust/writer.ts`: `changeTariff` y `getChangeState`) con `simulated=false` y `SILOG_WRITER=web`; ver «Qué cambiaría» en `docs/diseno-arquitectura.md`.
- Migración `0008_adjustments.sql` (+ `supabase/deploy/terpel_0008_adjustments.sql`).

## Login web de Silogtran y diagnóstico de solo lectura (incremento 3a)

- **Cliente web** (`core/silog/web/`): login por formulario PRADO + centro de costo, cookie jar cifrada (AES-256-GCM, tabla `silog_web_sessions`, migración 0009), cola serializada, un solo login simultáneo por cuenta, errores claros (`WEB_LOGIN_PASSWORD_CHANGE_REQUIRED`, `WEB_LOGIN_2FA_NOT_SUPPORTED`, `WEB_LOGIN_REJECTED`, `WEB_WAF_FAILED`, ...). No registra cuerpos, cookies ni claves.
- **Reto AWS WAF**: función separada `api/silog-waf.ts` (`@sparticuz/chromium` + `puppeteer-core`, 60 s) que SOLO devuelve las cookies `aws-waf*`; exige HMAC derivado de `APP_SESSION_SECRET`. La función principal no incluye Chromium. Las cookies del WAF se guardan cifradas y se reutilizan. Local: `WAF_CHROME_PATH`. Prueba manual: `WAF_CHROME_PATH=<chromium> NODE_USE_ENV_PROXY=1 npx tsx` con un script que llame a `LocalWafSolver` (el reto se resolvió en ~2,3 s en el sandbox).
- **Diagnóstico** (`POST /api/admin/silog-web/diagnostic`, solo admin, auditado): entra con la cuenta `adjust` guardada y devuelve la ESTRUCTURA de la pantalla (controles, widgets, tablas, validadores). Banderas del cuerpo: `lookup` (autocompletado de la remesa) y `search` (envío del botón *Buscar*, de lectura). Nunca pulsa Grabar ni devuelve cookies, claves o valores personales. Resultado documentado en `docs/silogtran-cambio-tarifa.md`.
- **Escritura real**: implementada en el incremento 3b (ver más abajo); desactivada por defecto.
- Variables nuevas: `SILOG_WEB_BASE_URL`, `WAF_SOLVER_URL`, `WAF_CHROME_PATH` (todas opcionales; ver `.env.example`).

## Escritor real de cambio de tarifa (incremento 3b)

- **`SilogtranWebWriter`** (`core/silog/web/writer.ts`) implementa la secuencia de `docs/silogtran-cambio-tarifa.md` con la sesión web cifrada de 3a: autocompletado exacto de la remesa, razón, *Buscar*, lectura de `anterior_*` (reversa), campos `nuevo_*`, **un único** `grabar` (con `IDLockHidden` y `grabar_uuid` de la página), verificación en la CONSULTA de la remesa (Home_111; el informe no refleja peso/cantidad). Mensaje desconocido o respuesta perdida = `uncertain`; sin reintentos ciegos.
- **Ensayo**: `POST /api/adjustments/:id/rehearse` (facturación/admin) hace todo MENOS Grabar y devuelve lo que se enviaría, la reversa y las comprobaciones; registra el evento `rehearsed` sin cambiar el estado. Con `{"real": true}` ensaya contra la pantalla real aunque el modo sea simulado.
- **Parámetros del escritor** (solo admin, auditados; Ajustes → «Escritor de ajustes»): `writer_mode` (`mock` por defecto | `web`) y `writer_allowlist` (remesas permitidas; «todas» exige confirmación). `SILOG_WRITER` solo es el valor inicial. Con `web` y una remesa fuera de la lista: `REMESA_NOT_ALLOWED`. Banner: «MODO SIMULADO» o «ESCRITURA REAL ACTIVA: solo remesas permitidas: …».
- **Escritura real**: exige cuenta de ajustes, remesa permitida y un ensayo válido reciente de la misma carga; misma máquina de estados de la Fase 3. `simulated=false` solo con el escritor web.
- **Valores reales**: «valores actuales» y reversa salen de la consulta Home_111 (Peso, Peso Bruto, tarifa_cliente, remesa_flete), no del informe; si no se pueden leer la propuesta queda en revisión (`CURRENT_VALUES_UNAVAILABLE`) y si ya están ajustados no se propone (`ALREADY_ADJUSTED`, «Ya ajustado»). Mensaje de éxito de Grabar: «La remesa #… fue actualizado con éxito!» (se decodifican entidades HTML).
- **Reversa**: «Revertir» crea una propuesta con los valores anteriores guardados, sujeta a aprobación.
- Activación paso a paso, verificaciones y reversa: `docs/silogtran-cambio-tarifa.md`. Migración `0010_real_writer.sql`. La función principal pasó a `maxDuration` 60 s (la escritura puede tardar).

## Modo asistido de ajustes

Tras una conciliación completada, **un solo flujo con confirmación humana** aprueba, ensaya y aplica las propuestas elegibles y entrega un reporte.
- **Plan (sin efectos)**: `POST /api/reconciliations/:id/assisted/plan` genera las propuestas que falten y devuelve las **elegibles** (propuestas `proposed`/`approved` sin revisión y elegibles) con valores actuales→propuestos y las **excluidas** con motivo legible: pendiente de Terpel (volumen 0), ambiguos, sin coincidencia, ya ajustado, requiere revisión (`CURRENT_VALUES_UNAVAILABLE`, tarifa no exacta...), fuera de la lista de remesas permitidas, ya aplicadas. Incluye el estado del escritor para advertir «ESCRITURA REAL».
- **Corrida**: `POST /api/assisted-runs {reconRunId, proposalIds, confirm:true}` (con `confirm` obligatorio y exactamente esos ids, que deben seguir siendo elegibles) y `POST /api/assisted-runs/:id/step` (~20 s por paso; la UI repite hasta terminar). `GET /api/assisted-runs/:id` da progreso y reporte; `POST /api/assisted-runs/:id/export` descarga el `.xlsx`.
- **Por propuesta, en orden**: aprobar (como el actor; evento y auditoría `assisted`) → ensayo → si pasa todas las comprobaciones, aplicar con el escritor configurado. Respeta modo del escritor, lista de remesas permitidas (el modo asistido NO la amplía), `REHEARSAL_REQUIRED`, cuenta de ajustes y verificación en Home_111.
- **Paradas**: ensayo fallido o rechazo previo a grabar → se **omite** (nada se escribió) y sigue. `uncertain`, `verification_failed`, `failed` tras grabar, o error de infraestructura/inesperado → la corrida se **DETIENE** (`halted`) y el resto queda pendiente sin tocar; se reanuda de forma explícita (`resume`), omitiendo lo detenido. Una sola corrida activa; lease de 90 s; si el navegador se cierra, la corrida queda reanudable y lo ya aplicado no se repite (`applyProposal` es idempotente).
- **Permisos**: `adjustments.approve` y `adjustments.apply` (admin y facturación). Auditoría: `assisted.plan/start/approve/halt/resume/finish/export`.
- **Reporte** (pantalla y `.xlsx`: Resumen, Aplicadas con antes→después y reversa, Omitidas y detenidas, Excluidas del plan por categoría) con la indicación de que la facturación se hace en la pestaña «Facturación».
- Tablas `assisted_runs` y `assisted_run_items` (migración `0011_assisted_runs.sql`). El interruptor anterior «aplicación automática» queda como reservado (no implementado).

## Fase 4a — Facturación (SIN emisión real)
- Conciliación `recon-1.4.0`: asignación uno a uno (un registro no puede ser de dos servicios) y coincidencia débil por placa ignorada ⇒ revisión manual. Ver `docs/silogtran-facturacion.md`.
- Pestaña «Facturación» (admin y facturación): plan de remesas elegibles (conciliación EXACTA o ajuste aplicado y verificado, CUMPLIDO, sin factura, Terpel, volumen > 0, datos completos), todas marcadas; «Facturar todas (N)» = UNA factura por remesa, por pasos, con progreso, parada ante resultado incierto y reporte `.xlsx`; «Facturar esta» por remesa.
- Escritor simulado por defecto (banner «MODO SIMULADO»). El escritor real (`SilogtranWebInvoiceWriter`) solo emite con modo `web`, remesa en la lista permitida, ensayo vigente y confirmación; «Facturar todas» real requiere `batch_enabled`. **Ninguna factura real se ha emitido.**
- Migración `0012_invoicing.sql`; detalle, mapa de la pantalla Automatica_111, regla crítica y pendientes por confirmar en [`docs/silogtran-facturacion.md`](docs/silogtran-facturacion.md).

## Variables de entorno

Ver [`.env.example`](.env.example) (sin valores reales). Las principales: `AUTH_MODE`, `MAIL_SOURCE`, `MAIL_MAILBOX`, `MAIL_ALLOWED_SENDER`, `MAIL_SUBJECT_PATTERN`, `MAIL_REQUIRE_DMARC_PASS`, `BUSINESS_KEY_STRATEGY`, `GRAPH_*`, `DATABASE_URL`, `STORAGE_DRIVER`, `SUPABASE_*`, `SILOG_*` (Fase 2), `ENCRYPTION_KEY` y `APP_SESSION_SECRET` (usuarios), `SILOG_WRITER` (`mock` por defecto; solo valor inicial: el modo efectivo está en la BD). Las variables `MAIL_*` solo siembran la primera configuración; luego un administrador la edita desde la UI.

## Reglas de negocio implementadas

- **Rango**: `[inicio del día inicial, inicio del día siguiente al final)` en `America/Bogota`, convertido a UTC (01–31 de enero → `[01-01T05:00Z, 02-01T05:00Z)`).
- **Remitente**: `from` y `sender` deben coincidir exactamente (sin distinguir mayúsculas) con el remitente configurado. `Authentication-Results` (DMARC/SPF) se registra; `MAIL_REQUIRE_DMARC_PASS=true` lo exige.
- **Asunto**: sin tildes, guiones `- – —` equivalentes, espacios colapsados; prefijos `RV:`/`RE:`/`FW:`/`FWD:` se aceptan y marcan el reenvío.
- **Reenvío de remitente no permitido** → `needs_review` con incidencia `SENDER_NOT_ALLOWED` (no crea ni modifica servicios). Remitente distinto sin reenvío → `ignored_sender`.
- **Identidad**: mensaje único por `(buzón, id inmutable)` y por `(buzón, Message-ID)`. Servicio: `business_key` = número de transporte (texto; conserva ceros a la izquierda). Una corrección o reenvío crea una **nueva versión del mismo servicio**; si cambian valores → incidencia `CORRECTED_AUTHORIZATION` (revisión obligatoria); si es idéntico → `RESENT_AUTHORIZATION` (informativa). Versión vigente: la recibida más reciente.
- **Decimales**: `9973,0000` → `9973.0000`; `1.234.567,89` → `1234567.89`; solo `,` es decimal; `1.234` es ambiguo → incidencia `AMBIGUOUS_DECIMAL`, no se adivina. Nunca float al persistir.
- **Vacío ≠ cero**: etiqueta ausente → `NULL` (+ incidencia); etiqueta presente vacía → texto `''` y valor `NULL` (+ incidencia si es obligatoria); `0` → `0`.
- **Volumen**: se guardan el texto original y el valor numérico, con unidad **galones** (confirmada por el negocio; `unit_status = 'confirmed'`). Puede venir en 0: es un valor válido, distinto de vacío. Sin conversión de unidades.
- **Planta de cargue**: se guarda el texto tal cual, pero no se evalúa ni genera reglas (decisión del negocio).
- **Campos obligatorios** (incidencia si faltan o vienen vacíos): número de transporte, fecha del servicio (`DD.MM.AAAA`), valor neto y moneda, placa y volumen.
- **Excel**: hoja *Servicios* (una fila por servicio del lote, con su versión vigente; identificadores como texto, decimales numéricos con 4 cifras, volumen también como texto original), *Incidencias* y *Resumen* (metadatos, contadores y huella sha256 del contenido; la huella del archivo completo queda en `export_files.sha256`). El lote incluye los servicios de mensajes importados **y** duplicados del rango, así que repetir una ejecución produce los mismos servicios y valores; en cambio la columna "Resultado en la ejecución", el conteo de incidencias, la hoja *Incidencias* y los contadores del *Resumen* reflejan **solo esa ejecución** (en la segunda todo figura como duplicado y sin incidencias).

## Probado vs. pendiente de verificar

### Probado (resultados reales de pruebas automáticas en este repositorio)

- Rango de fechas de Bogotá, incluidos los límites 23:59:59 y 00:00:00.
- Parser de la plantilla **sintética** (tabla HTML, párrafos con otro formato de etiquetas, solo texto, reenvío `RV:`), normalizador de decimales, asunto y remitente, clave de negocio.
- Migraciones SQL reales sobre **PGlite**: unicidad, índice de una ejecución activa por buzón, RLS (el operador lee pero no ve `source_message_bodies` ni `mail_configs`, no escribe; sin rol no ve nada), bucket `exports` privado.
- Orquestador: idempotencia entre ejecuciones iguales y solapadas, reanudación tras interrupción a mitad de página (transacción revertida), lease vigente/vencido, cursor expirado, invariante de contadores, versiones/correcciones, DMARC exigido.
- `GraphMailSource` contra un Graph **simulado** (3 páginas, 429 con `Retry-After`, 403, cursor hacia otro host).
- Excel: relectura del `.xlsx` y comparación campo a campo con la BD; fallo forzado de Storage y regeneración.
- API: 401 sin sesión, roles, JWT HS256 tipo Supabase, demo-login bloqueado fuera de modo demo, URL firmada con expiración, logs sin cuerpos/tokens/conductores.
- UI: smoke con Playwright (login, importación, resultados, incidencias, descarga, segunda importación = duplicados, roles).
- `npm run demo:twice`.
- Fase 2 (Vitest + PGlite con migraciones reales, datos sintéticos): normalizadores, motor de cascada (orden, activación, excluyente/preferente, ventana, AMBIGUOUS, NO_MATCH, INSUFFICIENT_DATA, volumen 0, diferencias, placa informativa), deduplicación/ANULADO/NIT, cliente de la API (token crudo, re-login, errores sin credenciales), sync idempotente, 6 casos reales reproducidos con datos inventados, endpoints con roles, auditoría, resolución manual, equivalencias y Excel que concuerda con la BD. Smoke e2e de Conciliación y Parámetros.
- Fase 2 contra la API real de Silogtran (backend local con PGlite + los 6 servicios de Terpel ya importados, rango 17–25/11/2026): los 6 resultados coinciden con lo esperado (ver docs/diseno-arquitectura.md).

- Usuarios y credenciales (Vitest, datos sintéticos): cifrado (ida y vuelta, AAD, clave inválida), matriz de permisos, ingreso con Silogtran simulado (mensaje uniforme, bloqueo antes de llamar a Silogtran, token manipulado/vencido, revocación al desactivar/cambiar rol, convivencia con tokens de Supabase), protección del último admin, ausencia de secretos en BD/API/logs/auditoría y e2e. Prueba real solo local: ingreso y «Probar conexión» contra la API real de Silogtran.

### Pendiente de verificar

| Tema | Estado |
|---|---|
| **Buzón real / Exchange Online** | Probado: lectura del buzón dedicado con certificado (200) y rechazo de otro buzón (403). El buzón recibe reenvíos hechos a mano; falta que TI cree la regla que copie allí los correos de Terpel. |
| **Plantilla real** | Validada con 6 correos reales reenviados (texto plano). Pendiente: variantes HTML y correos con planta de cargue, corregidos o con remisión informada. |
| **Reenvíos** | Se aceptan si el asunto es RV:/RE:/FW: y el cuerpo cita "De:" el remitente de Terpel, sin importar quién reenvíe. El "De:" citado no está autenticado: se puede limitar con `mail_configs.allowed_forwarders`. |
| **Clave de negocio** | Número de transporte (confirmado: el número de gasto siempre es distinto). |
| **Volumen** | Unidad confirmada: galones. Frecuentemente viene en 0 (valor válido); en la Fase 2 no debe compararse en 0. |
| **Planta de cargue** | No se evalúa (decisión del negocio). |
| **Informe Silogtran** | Fase 2 implementada y probada contra la API real desde el backend local. En producción (Vercel) la conciliación requiere que `SILOG_BASE_URL`, `SILOG_USER` y `SILOG_PASSWORD` estén definidas; si faltan la app responde `SILOG_NOT_CONFIGURED`. |
| **Ajustes en Silogtran (Fase 3)** | Propuestas, simulación, aprobación y aplicación implementadas con escritor SIMULADO. El escritor real (pantalla `Despacho.Remesa_003.CambioTarifa_105`: login web con reto AWS WAF vía Chromium, cookies, escritura y verificación) está pendiente y vivirá dentro de esta app. |
| **Ventana de días por ruta** | Ventana global (10 días, configurable); en los casos reales fue de 2 a 6. |
| **Producción** | Desplegado en Vercel sobre el esquema `terpel` de un proyecto Supabase compartido; los Excel se guardan en PostgreSQL (`STORAGE_DRIVER=db`). El plan gratuito de Vercel no permite uso comercial: pasar a Pro antes del uso diario. |

## Seguridad y privacidad

- Sin secretos en el repositorio; `.env` está ignorado y `.env.example` no contiene valores reales.
- Los logs solo llevan identificadores, contadores y códigos: nunca cuerpos de correo, tokens, asuntos ni nombres de conductor (`core/logger.ts` descarta esas claves).
- El cuerpo crudo del correo vive en `source_message_bodies`, sin permiso de lectura para usuarios autenticados.
- El token de Graph solo se envía a `graph.microsoft.com`; los cursores hacia otros hosts se rechazan.
- Datos de conductor = datos personales (Ley 1581 de 2012): acceso por rol y retención a definir.
