# AutoFactura Terpel — Fase 1

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

## Variables de entorno

Ver [`.env.example`](.env.example) (sin valores reales). Las principales: `AUTH_MODE`, `MAIL_SOURCE`, `MAIL_MAILBOX`, `MAIL_ALLOWED_SENDER`, `MAIL_SUBJECT_PATTERN`, `MAIL_REQUIRE_DMARC_PASS`, `BUSINESS_KEY_STRATEGY`, `GRAPH_*`, `DATABASE_URL`, `STORAGE_DRIVER`, `SUPABASE_*`. Las variables `MAIL_*` solo siembran la primera configuración; luego un administrador la edita desde la UI.

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

### Pendiente de verificar

| Tema | Estado |
|---|---|
| **Buzón real / Exchange Online** | Probado: lectura del buzón dedicado con certificado (200) y rechazo de otro buzón (403). El buzón recibe reenvíos hechos a mano; falta que TI cree la regla que copie allí los correos de Terpel. |
| **Plantilla real** | Validada con 6 correos reales reenviados (texto plano). Pendiente: variantes HTML y correos con planta de cargue, corregidos o con remisión informada. |
| **Reenvíos** | Se aceptan si el asunto es RV:/RE:/FW: y el cuerpo cita "De:" el remitente de Terpel, sin importar quién reenvíe. El "De:" citado no está autenticado: se puede limitar con `mail_configs.allowed_forwarders`. |
| **Clave de negocio** | Número de transporte (confirmado: el número de gasto siempre es distinto). |
| **Volumen** | Unidad confirmada: galones. Frecuentemente viene en 0 (valor válido); en la Fase 2 no debe compararse en 0. |
| **Planta de cargue** | No se evalúa (decisión del negocio). |
| **Informe Silogtran y su documentación** | No disponible; es insumo de la Fase 2 (no implementada). |
| **Producción** | Desplegado en Vercel sobre el esquema `terpel` de un proyecto Supabase compartido; los Excel se guardan en PostgreSQL (`STORAGE_DRIVER=db`). El plan gratuito de Vercel no permite uso comercial: pasar a Pro antes del uso diario. |

## Seguridad y privacidad

- Sin secretos en el repositorio; `.env` está ignorado y `.env.example` no contiene valores reales.
- Los logs solo llevan identificadores, contadores y códigos: nunca cuerpos de correo, tokens, asuntos ni nombres de conductor (`core/logger.ts` descarta esas claves).
- El cuerpo crudo del correo vive en `source_message_bodies`, sin permiso de lectura para usuarios autenticados.
- El token de Graph solo se envía a `graph.microsoft.com`; los cursores hacia otros hosts se rechazan.
- Datos de conductor = datos personales (Ley 1581 de 2012): acceso por rol y retención a definir.
