# Guía para TI: acceso de solo lectura al buzón (Exchange Online)

Esta guía describe lo que AutoFactura Terpel necesita de TI para leer **únicamente** un buzón dedicado de autorizaciones de pago, con el mínimo privilegio. La aplicación **solo hace GET**: no marca correos como leídos, no los mueve, no responde ni envía.

> Hasta que TI entregue esto, la aplicación funciona con datos ficticios (`MAIL_SOURCE=mock`). Nada de lo que sigue es necesario para la demo.

## 0. Confirmar el tipo de Exchange

| Escenario | Qué hacer |
|---|---|
| **Exchange Online (Microsoft 365)** | Seguir esta guía (Microsoft Graph con permisos de aplicación limitados por RBAC). |
| **Exchange local (on-premises)** | Graph no aplica. Definir con TI una integración autorizada (EWS en Exchange SE, IMAP con OAuth, o configuración híbrida). Mientras tanto se usa el modo simulado. |
| **Híbrido** | Confirmar si el buzón dedicado vive en línea; si no, tratarlo como local. |

## 1. Buzón dedicado

- Crear un buzón **dedicado** (por ejemplo `autorizaciones-terpel@su-empresa.com`) al que lleguen los correos del remitente `flota@informacion.terpel.com`.
- Preferiblemente **buzón compartido**: no requiere licencia mientras pese menos de 50 GB.
- Regla de transporte o reenvío para que los correos lleguen allí (decisión de TI). No se debe compartir el buzón personal de nadie.

## 2. Aplicación en Microsoft Entra ID

1. Registrar una aplicación **de un solo inquilino** (single tenant), p. ej. "AutoFactura Terpel".
2. **Sin redirect URI** (es una aplicación de servicio, sin inicio de sesión de usuarios).
3. Credencial:
   - **Producción: certificado.** TI genera el par de claves; sube a Entra solo el `.cer` (público). La clave privada (`.pem`/`.key`) se entrega por canal seguro **solo** al servidor donde corre la aplicación.
   - **Pruebas: secreto de cliente** de 30–90 días, únicamente si TI lo autoriza. Debe eliminarse al terminar las pruebas.
4. Anotar: **Tenant ID**, **Application (client) ID** y, para el paso 3, el **Object ID de la Aplicación empresarial** (Enterprise application → la misma app → Object ID; **no** es el Object ID del registro de la app).

## 3. Limitar la aplicación a UN buzón (RBAC para aplicaciones)

En lugar de conceder `Mail.Read` a todo el inquilino, se usa **RBAC for Applications** de Exchange Online, que restringe la app a un ámbito. En Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline

# 1) Registrar la aplicación como principal de servicio en Exchange
New-ServicePrincipal -AppId <AppId> -ObjectId <ObjectId de la Aplicación empresarial> -DisplayName "AutoFactura Terpel"

# 2) Ámbito de gestión: solo el buzón de autorizaciones
New-ManagementScope -Name "Scope-AutorizacionesTerpel" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'autorizaciones-terpel@su-empresa.com'"

# 3) Asignar el rol de lectura de correo limitado a ese ámbito
New-ManagementRoleAssignment -App <AppId> -Role "Application Mail.Read" -CustomResourceScope "Scope-AutorizacionesTerpel"
```

Sustituir `<AppId>`, `<ObjectId ...>` y la dirección del buzón por los valores reales.

## 4. Verificar que la aplicación NO tiene permisos de más

En Entra ID → Aplicaciones empresariales → AutoFactura Terpel → **Permisos**:

- **No** debe tener consentido el permiso de aplicación `Mail.Read` de Microsoft Graph a nivel de inquilino: los permisos se **suman**, y ese permiso anularía la restricción del paso 3 (la app podría leer todos los buzones).
- Tampoco `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.*` ni similares.
- Si existe algún permiso de Graph consentido, retirarlo y dejar solo el RBAC de Exchange.

## 5. Pruebas de autorización

La propagación del RBAC puede tardar **entre 30 minutos y 2 horas**. Probar en PowerShell:

```powershell
# Buzón autorizado: debe responder InScope = True
Test-ServicePrincipalAuthorization -Identity <AppId> -Resource autorizaciones-terpel@su-empresa.com

# Otro buzón cualquiera: debe responder InScope = False
Test-ServicePrincipalAuthorization -Identity <AppId> -Resource otro.buzon@su-empresa.com
```

Y desde el servidor de la aplicación (con las variables de entorno del apartado 7):

```bash
npm run graph:check            # buzón autorizado → HTTP 200
npm run graph:check -- --denied # buzón NO autorizado → HTTP 403 ErrorAccessDenied
```

Ambos resultados deben coincidir; si el segundo devuelve 200, hay un permiso de más (volver al paso 4).

## 6. Red

El servidor de la aplicación necesita salida HTTPS (443) a:

- `login.microsoftonline.com` (token)
- `graph.microsoft.com` (lectura de correo)

## 7. Qué debe entregar TI y cómo se configura

Entregar por un canal seguro (nunca por correo en claro ni por chat):

| Dato | Variable en la aplicación |
|---|---|
| Tenant ID | `GRAPH_TENANT_ID` |
| Application (client) ID | `GRAPH_CLIENT_ID` |
| Dirección del buzón | `MAIL_MAILBOX` |
| Huella (thumbprint) del certificado | `GRAPH_CLIENT_CERT_THUMBPRINT` |
| Clave privada del certificado (PEM) | `GRAPH_CLIENT_CERT_PRIVATE_KEY_PATH` (ruta) o `GRAPH_CLIENT_CERT_PRIVATE_KEY` (contenido) |
| (solo pruebas) secreto de cliente | `GRAPH_CLIENT_SECRET` |
| Un segundo buzón **no** autorizado, para la prueba negativa | `GRAPH_CHECK_DENIED_MAILBOX` |

Además, **muestras anonimizadas** de los correos reales (HTML original; sustituir nombres de conductores, placas y valores por datos ficticios conservando el formato y las etiquetas) y, si existen, variantes de la plantilla. Sirven para validar el lector de la plantilla antes de usarlo con datos reales.

Con todo configurado: `MAIL_SOURCE=graph`.

## 8. Seguridad y retención

- La aplicación guarda el cuerpo crudo de los correos en una tabla a la que los operadores **no** tienen acceso (solo el servicio de backend), para poder revisar casos y reprocesar. Definir con jurídica el plazo de retención.
- Los datos de conductores son datos personales (Ley 1581 de 2012): acceso por rol, sin aparecer en logs.
- Rotar el certificado antes de su vencimiento; eliminar cualquier secreto de pruebas.
- Para revocar el acceso basta con eliminar la asignación de rol (`Remove-ManagementRoleAssignment`) o la aplicación en Entra.
