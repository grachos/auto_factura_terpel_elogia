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

### Discrepancia (resuelta por el negocio)
El informe de Silogtran (API) indica `remesa_peso` 10460 y `total_remesa` 2.464.445 (= 10487 × 235), mientras la pantalla muestra peso/cantidad **10500** con tarifa 235. **Decisión del negocio:** el peso de la pantalla (10500) es el peso ORIGINAL de la solicitud; al cambiarlo cambia `remesa_peso` del informe. Por eso NO se exige que los `anterior_*` coincidan con el informe. Hay dos comprobaciones distintas: (a) el registro del informe sigue como se esperaba al proponer (CUMPLIDO, sin factura, mismos valores; si no, `stale`); (b) en la pantalla se leen `anterior_*` antes de grabar, se guardan como valores de REVERSA y no deben cambiar entre el ensayo y el grabado (si cambian, se aborta como `stale`).

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

## Escritor real (incremento 3b) — `SilogtranWebWriter` (`core/silog/web/writer.ts`)
Implementa la secuencia anterior. Un único método (`postGrabar`) envía Grabar y solo `changeTariff` lo llama; el **ensayo** (`rehearse`) hace todos los pasos MENOS Grabar.

### Activar la escritura real (paso a paso, solo admin)
1. Usuarios → Cuenta de ajustes: guardar la credencial (ya hecho) y comprobar «Probar conexión».
2. Ajustes → generar propuestas de la conciliación, aprobar la propuesta de la remesa de prueba (0101228393).
3. Pulsar **Ensayo** (o «Ensayo contra la pantalla real» mientras el modo sea simulado): se fijan los tres campos sin grabar y se muestran razón, peso, cantidad, tarifa y los valores anteriores (reversa). Debe pasar todas las comprobaciones.
4. Ajustes → «Escritor de ajustes»: modo **ESCRITURA REAL** y, en «Remesas permitidas», solo `0101228393`. Guardar (pide confirmación). El banner pasa a «ESCRITURA REAL ACTIVA: solo remesas permitidas: …». «Todas» exige una confirmación adicional; no se recomienda.
5. Pulsar **Aplicar**: el diálogo repite el ensayo y muestra remesa, valores nuevos, reversa y cuenta usada. La escritura real exige un ensayo válido de las últimas 24 h con la misma carga (`REHEARSAL_REQUIRED`) y que la remesa esté permitida (`REMESA_NOT_ALLOWED`).
6. Al terminar volver el modo a «Simulado» y vaciar la lista si no se va a seguir escribiendo.

### Qué se verifica tras grabar
- Mensaje de Grabar: solo un texto de éxito reconocido cuenta como éxito; cualquier mensaje desconocido o ambiguo deja la propuesta `uncertain` (nunca éxito).
- Relectura de la CONSULTA de la remesa (Home_111): Peso, Peso Bruto y tarifa_cliente deben ser los valores nuevos; si no coincide → `verification_failed` (no se factura). El informe NO se usa (no refleja estos campos).
- Si la respuesta se pierde o el mensaje es ambiguo → `uncertain`: se usa «Consultar estado» (relee la pantalla) antes de cualquier reintento; jamás hay reintento ciego.

### Revertir
En una propuesta aplicada de verdad (o con verificación fallida/incierta) pulsar **Revertir**: crea una propuesta de reversa con los valores anteriores guardados (para la remesa de prueba: peso 10500, cantidad 10500, tarifa 235) que se aprueba, se ensaya y se aplica como cualquier otra (la reversa se verifica en la pantalla). Procedimiento manual de respaldo: abrir la pantalla «Procedimiento de Cambio Tarifa» con la remesa, escribir esos valores y grabar con la razón «Reversa de ajuste de tarifa».

## Corrección tras la primera escritura real (verificación en la consulta de la remesa)
Hechos de la primera escritura real (remesa 0101228393): Silogtran respondió «La remesa #0101228393 fue actualizado con &eacute;xito!» (la entidad HTML impidió reconocerlo), el cambio sí se aplicó y **el informe (`InformeGeneral`) NO cambia**: `remesa_peso` y `total_remesa` del informe no reflejan estos campos. Por eso:
- **La verificación pasa a la consulta de la remesa** (`index.php?page=Despacho.Remesa_003.Home_111&remesa_codigo=<código de 10 dígitos>`, solo GET). Se lee por NOMBRE de columna (no por posición) la tabla `ctl0_MainModule_ItemsRemesa` y dos campos:
  - Columna **Peso** y columna **Peso Bruto**: tras el cambio ambas quedan con el valor nuevo (en la remesa de prueba: 10487 y 10487). El escritor trata `nuevo_peso` ↔ **Peso** y `nuevo_cantidad` ↔ **Peso Bruto** (inferencia observada: el cambio deja el mismo valor en las dos).
  - Columna **Cantidad**: es la cantidad ORIGINAL de la solicitud (10500) y el cambio de tarifa no la modifica; también explica por qué `anterior_cantidad` de la pantalla de cambio sigue en 10500.
  - `ctl0_MainModule_tarifa_cliente` (texto): la tarifa; en la remesa de prueba **235**.
  - `ctl0$MainModule$remesa_flete` (input; Silogtran lo muestra con comas de miles): el flete/total de la remesa; en la remesa de prueba **2,464,445** (= 10487 × 235 = valor de Terpel).
- **Verificación exacta**: peso, cantidad (Peso Bruto) y tarifa son comprobaciones duras; el flete se compara con el valor de Terpel y se informa (campo `flete` del detalle) pero NO decide el resultado, porque con una sola remesa observada no se puede asegurar que el flete siempre sea tarifa × galones.
- **Estados**: éxito reconocido + consulta coincide → `applied`; éxito reconocido pero la consulta no coincide → `verification_failed`; mensaje desconocido, respuesta perdida o consulta ilegible → `uncertain` (se resuelve con «Consultar estado», que lee la consulta y devuelve el detalle por campo; una mezcla parcial queda `unknown`).
- **Clasificador de Grabar**: decodifica entidades HTML (`&eacute;`, `&nbsp;`, numéricas) y reconoce «La remesa #<código> fue actualizado con éxito!» (cualquier mayúscula/acento/contenedor, también dentro de un script); todo lo demás es `uncertain`.
- **El informe ya no se usa para verificar ni para los «valores actuales»**: solo se exige que el registro siga CUMPLIDO, sin factura y que sea la remesa. Al GENERAR propuestas se leen los valores reales de cada remesa en la consulta (sesión web, concurrencia 1): si no se pueden leer → `needs_review` con `CURRENT_VALUES_UNAVAILABLE`; si peso, cantidad y tarifa ya son los esperados → no se propone (etiqueta «Ya ajustado», `ALREADY_ADJUSTED`). La reversa guarda los valores leídos de la consulta (Peso, Peso Bruto, tarifa).
- **Limitación de la conciliación (Fase 2)**: su comparación de volumen contra `remesa_peso` del informe es solo informativa: el informe no refleja los ajustes de peso/cantidad; la comparación definitiva se hace al proponer ajustes.

## Modo asistido (varias remesas en un solo flujo)
La pestaña Ajustes → «Modo asistido» muestra el plan (qué se aplicará y qué queda fuera y por qué), pide marcar «Entiendo que se escribirá en Silogtran» (en modo real) y ejecuta, remesa por remesa: aprobar → ensayo → aplicar, con la misma verificación en Home_111. Si el ensayo de una remesa falla se omite sin escribir; si una remesa queda `uncertain`/`verification_failed`/`failed` tras Grabar, TODA la corrida se detiene y no toca las demás: se resuelve con «Consultar estado» y luego se reanuda. La escritura real sigue gobernada por el modo y la lista de remesas permitidas (solo admin).

## Cuándo se propone un ajuste (recon-1.3.0)
Solo se proponen ajustes de tarifa para servicios cuya conciliación tiene diferencias, y desde la regla recon-1.3.0 eso significa que **el total de la remesa en Silogtran NO coincide con el valor neto de Terpel**. Si el total ya es igual, el servicio es `EXACT` aunque el volumen de Terpel y el peso de Silogtran difieran (decisión del usuario: el peso cumplido no viene ni en el informe ni en la consulta de la remesa). Por tanto ya no se generan propuestas para remesas con total igual y solo peso/cantidad distintos. Las propuestas viejas de servicios que ya no tienen diferencias pasan a `stale` al regenerar y el modo asistido las excluye.
