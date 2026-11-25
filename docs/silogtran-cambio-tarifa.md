# Pantalla «Procedimiento de Cambio Tarifa» de Silogtran (mapa de solo lectura)

Resultado del diagnóstico del incremento 3a, ejecutado en producción con la cuenta de ajustes (login web con reto AWS WAF) el 2026-11-25.
Pantalla: `index.php?page=Despacho.Remesa_003.CambioTarifa_105` (PRADO). **No se grabó nada** en Silogtran: solo `GET`, un callback de autocompletado
y el envío del botón *Buscar* (lectura). Sin datos personales; la remesa de prueba es la 0101228393 (servicio Terpel 6008602767).

## Acceso
- Login web por formulario (`ctl0$MainModule$Usuario`, `Clave`, `BtnIngresar`) + centro de costo (el primero). El WAF exige el token `aws-waf-token`, obtenido con Chromium (función `api/silog-waf`); el resto es HTTP plano.
- La cuenta de ajustes entró sin cambio de contraseña pendiente ni 2FA. Primer ingreso (WAF + login + GET): 6,6 s en total desde el cliente; con la sesión cifrada reutilizada: 0,7 a 0,9 s.
- Errores claros: `WEB_LOGIN_PASSWORD_CHANGE_REQUIRED`, `WEB_LOGIN_2FA_NOT_SUPPORTED`, `WEB_LOGIN_REJECTED`, `WEB_WAF_FAILED`, `WEB_SESSION_BUSY` (un solo login simultáneo por cuenta).

## Estructura de la pantalla (antes de buscar)
| Control | Nombre (`ctl0$MainModule$…`) | Notas |
|---|---|---|
| Remesa | `remesa_codigo` (+ `remesa_codigo$IDHidden`) | `CAutoComplete`; 1 sugerencia por código exacto (5 celdas, atributos `…_remesa_codigo` y `…_remesa_codigo_idhidden`) |
| Razón de cambio | `cambiotarifa_nota` (textarea) | validador `Requeridos` (solo del lado cliente) |
| Buscar | `buscar` (submit, `TButton`, grupo `Requeridos`) + `IDLockHidden_ctl0_MainModule_buscar` | lectura: llena la tabla |
| Token | `grabar_uuid` (hidden) | token de unicidad del envío de Grabar |
No hay casilla «Remesa»: el campo Remesa es un autocompletado. La tabla de resultados tiene las columnas Solicitud, Item, Cliente, Tipo Tarifa, Peso Remesa, Cantidad Remesa y Nueva Tarifa.

## Después de *Buscar* (remesa de prueba)
- `remesa_codigo` queda **deshabilitado**; aparece el botón **`grabar`** (`TButton`, grupo `Requeridos`) con `IDLockHidden_ctl0_MainModule_grabar` y siguen los hidden `grabar_uuid`.
- Tabla `ItemsRemesa` (una fila por ítem, prefijo `ctl0$MainModule$ItemsRemesa$ctl0$`): editables `nuevo_peso`, `nuevo_cantidad`, `nueva_tarifa` (TextBox); ocultos `anterior_peso`, `anterior_cantidad`, `anterior_tarifa`.
- Valores leídos para la remesa de prueba: peso 10500, cantidad 10500, tarifa 235 (anterior = nuevo, sin cambios). Validadores `Requeridos` sobre remesa, razón, nuevo peso, nueva cantidad y nueva tarifa.

### Discrepancia a resolver antes de escribir
El informe de Silogtran (API) indica `remesa_peso` 10460 y `total_remesa` 2.464.445 (= 10487 × 235), mientras la pantalla muestra peso/cantidad **10500** con tarifa 235. La pantalla manda: la lectura previa del escritor real debe usar los `anterior_*` de la pantalla (no solo el informe) y abortar como `stale` si no son los esperados. Hay que entender con el negocio qué campo del informe corresponde a «Peso Remesa» de la pantalla.

## Secuencia propuesta del escritor real (incremento 3b; NO implementada)
1. Sesión web de la cuenta de ajustes (reutilizar cookies cifradas; bloqueo de una sola sesión).
2. `GET` de la pantalla; `suggest` por el código de remesa; exigir **exactamente una** sugerencia con el mismo código; `select`.
3. Escribir la razón (`cambiotarifa_nota`) y enviar *Buscar* (envío simple con `buscar=Buscar` y el IDLock en `true`).
4. Verificar: exactamente una fila en `ItemsRemesa`, con `anterior_peso/cantidad/tarifa` iguales a lo esperado; si no → `stale`, sin escribir.
5. Fijar `nuevo_peso`, `nuevo_cantidad` (= galones) y `nueva_tarifa` (punto decimal, ≤ 12 caracteres, exacta).
6. **Un único** envío de `grabar` (valor `Grabar`, IDLock en `true`, y `grabar_uuid` tal como lo sirvió la página). Sin reintentos: un timeout deja la propuesta `uncertain`.
7. Mensaje de éxito esperado: **por confirmar** en la primera escritura real (otras pantallas muestran «El registro ha sido guardado»).
8. Verificar: volver a buscar la remesa (los `anterior_*` deben ser los nuevos) y releer el informe (`remesa_peso` = galones y `total_remesa` = valor de Terpel). Si no coincide → `verification_failed`, no se factura.

## Riesgos
- La validación es solo del lado cliente: el servidor puede ignorar en silencio un envío incompleto; siempre verificar el resultado.
- Los `ctlN` cambian: ubicar los controles por `ValidationGroup`/nombre, nunca por posición.
- Reto WAF: puede bloquear la IP de la función; el token se reutiliza guardado (cifrado) y solo se relanza Chromium si caduca.
- Estado pendiente en la sesión de Silogtran: serializar siempre las peticiones y una sola sesión por cuenta.
- Aún no se probó el efecto de *Buscar* repetido ni de `grabar_uuid` reutilizado.
