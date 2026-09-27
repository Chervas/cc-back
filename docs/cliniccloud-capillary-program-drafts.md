# Borradores documentales de programas capilares

> **Tipo:** runbook de una operación acotada.
> **Fuente de verdad:** ejecución del operador; contrato y estado en el manual central.
> **Última revisión:** 2026-09-27.
> **Relacionado con:** [37-importaciones](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/37-importaciones-cliniccloud-y-otros-sistemas.md).

`src/scripts/cliniccloud-import-capillary-program-drafts.js` prepara cinco
definiciones en BS Capilar, no tratamientos nuevos ni citas de pacientes.
Solo acepta el PDF V3 revisado (huella fijada en código), el Excel verificado
contra su plan y correspondencias exactas de tratamientos de la clínica 66.
No infiere identidades por nombre ni pisa programas existentes.

## Alcance y límites

- Esencial, Dermapen, Avanzado, Anual y Premium: 8, 9, 11, 14 y 15 entradas,
  incluidas las dos revisiones médicas. No se crean cuatro citas por las recetas.
- Dutasteride/PRP ya llevan LED. Dermapen/Dr. CYJ más LED forman una sola cita.
- La primera operación deja las variantes de vitaminas, carboxiterapia e INDIBA
  y las revisiones médicas sin tratamiento vinculado. El segundo paso, descrito
  abajo, prepara tres variantes sin modificar las sesiones sueltas. Las revisiones
  médicas siguen pendientes; no sustituirlas por revisiones de auxiliar.
- Solo el ciclo inicial de CYJ tiene días 0/14/28/42. Las otras separaciones no
  se inventan. Las revisiones al final son un inventario, no una pauta clínica.
- Estado `draft`, precio comercial `null`, compra/reserva bloqueadas. Las notas
  conservan tarifas de octubre, prestaciones, restricciones y procedencia; no
  implementan fiscalidad, caducidad ni condiciones de elegibilidad.

## Ejecución

Desde `back-dev`, rama `dev`. Argumentos comunes:

```text
node src/scripts/cliniccloud-import-capillary-program-drafts.js
  --mode prepare|preview|apply|verify
  --target crm
  --plan /ruta/privada/plan.json
  --workbook /ruta/BASE_DE_DATOS_TRATAMIENTOS_BS_MEDICAL_v2.xlsx
  --archive /ruta/Archivo explicado.zip
  --private-output /ruta/privada/salida-nueva.json
```

1. `prepare`: SQL de solo lectura, paquete con huellas y hora. No requiere
   navegador. No sobrescribe salidas.
2. `preview`: añadir `--package`; utiliza la sesión normal de CRM en Chromium
   9227 y el endpoint canónico de revisión, sin crear definiciones. Comprueba
   respuesta incompleta/no comprable y que programas, tratamientos,
   consentimientos asociados y citas no cambian.
3. `apply`: añadir `--package`, `--approved-sha256`, `--backup-manifest` y
   `--private-journal`. Exige repositorio limpio/commiteado, revisión y backup
   CRM verificado de menos de dos horas. Cinco POST canónicos independientes,
   cada uno con clave estable; el backend crea su revisión y autor con la sesión
   normal. No se copian tokens a disco ni se evita MFA. La tanda completa no es
   una única transacción: ante fallo revisar el diario y repetir la misma
   solicitud, nunca crear otra clave para solucionar un timeout.
4. `verify`: añadir `--package`; SELECT independiente verifica cinco versiones
   iniciales idénticas a sus revisiones. No escribe datos de aplicación.

El replay no duplica. Si una persona ya editó una definición, el verificador
se detiene: no restaura la versión inicial. Un cambio concurrente en una tabla
protegida también requiere revisar, nunca restaurar la base completa.

Pruebas: `cliniccloud_capillary_program_drafts.test.js`,
`treatment_programs.test.js` y
`CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/cliniccloud_capillary_program_drafts_mysql.integration.js`.
La integración usa MySQL temporal sin TCP y únicamente datos ficticios.
Completar con apertura visual pública de las definiciones en escritorio/móvil,
sin guardar modificaciones. Este operador no cambia el runtime, no requiere
build frontend ni migración SQL y nunca activa recordatorios.

## Reversión

No borrar definiciones/revisiones ni restaurar un backup global sobre datos
nuevos. Si hay que retirar estos borradores, archivarlos mediante la API
canónica y su versión esperada, tras confirmar que siguen siendo los creados
por esta operación y que no han sido completados por la clínica.

## Variantes de sesión de programa

`src/scripts/cliniccloud-import-capillary-program-variants.js` es un segundo paso
acotado, no una repetición de la importación inicial. Requiere las cinco
definiciones originales sin edición, el mismo PDF verificado y catálogo fuente.

- CAP-18: vitaminas con LED, 30 minutos C2/Ainhoa. El LED ya está dentro del
  tiempo del procedimiento; no sumar otros diez minutos.
- CAP-22: carboxiterapia con LED, 30 minutos: 18 en C10 con CO₂ fijo y 12 en C2
  con LED fijo (diez de LED y dos de registro), Ainhoa provisional. Es una
  interpretación de agenda del reparto literal del protocolo y la ubicación
  de los equipos; no una aprobación clínica. No añade tiempo de limpieza.
- CAP-23: INDIBA capilar de programa, 30 minutos C12/Ainhoa, sin LED.
- Tres códigos `BS26-CAP18-PROGRAM`, `BS26-CAP22-PROGRAM` y
  `BS26-CAP23-PROGRAM`; inactivos/borrador, precio `null`, no gratuitos, con
  procedencia, advertencia clínica y revisión fiscal/documental pendientes.
- Se completan exactamente 15 posiciones en Avanzado, Anual y Premium. Cada
  programa pasa de versión 1 a 2 por PATCH canónico; no cambia precio, pauta,
  revisiones médicas ni número/orden de citas. Esencial/Dermapen no se editan.

Argumentos comunes iguales al primer operador; modos `prepare|apply|verify`
(no `preview`). `apply` exige además paquete, su huella, backup CRM íntegro
verificado de menos de dos horas y diario privado nuevo. Solo se ejecuta desde
DEV limpio/commiteado, usando la sesión CRM normal de Chromium. No esquiva MFA.
Tres POST de tratamiento y tres PATCH de programa, no una transacción global.
Antes de cada operación se coteja el estado; los programas usan versión esperada.
Un resultado desconocido se concilia por SQL antes de repetir: nunca POST a
ciegas, nunca regenerar un paquete para esconder un cambio concurrente.

El replay con el paquete original reconoce únicamente variantes idénticas y
versiones 2 exactamente previstas. Rechaza códigos duplicados, edición humana,
cambio de recursos y alteración de las sesiones sueltas. Después de este paso,
el verificador del operador inicial ya no debe exigir la versión 1 ni restaurarla.
`verify` del segundo paso usa SELECT independiente y no escribe.

Pruebas: `cliniccloud_capillary_program_variants.test.js` y
`CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/cliniccloud_capillary_program_variants_mysql.integration.js`.
Esta última usa controlador real de tratamientos, servicio de programas y MySQL
temporal por socket con datos ficticios, sin conexión a BD de aplicación. Verificar
también los detalles públicos en Chromium sin guardar. Las citas y asociaciones
de consentimientos anteriores se comparan antes/después, sin emitir mensajes.

Reversión: conservar las variantes inactivas y revisar el journal. Si procede
retirar sus vínculos, actualizar por API los tres programas desde su versión
actual, conservando revisiones; nunca borrar histórico ni restaurar toda la BD.
No requiere migración, recompilación frontend o reinicio de API/gateway.
