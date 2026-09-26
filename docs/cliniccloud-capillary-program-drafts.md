# Borradores documentales de programas capilares

> **Tipo:** runbook de una operación acotada.
> **Fuente de verdad:** ejecución del operador; contrato y estado en el manual central.
> **Última revisión:** 2026-09-26.
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
- Las variantes de vitaminas, carboxiterapia e INDIBA de programa y las
  revisiones médicas permanecen sin tratamiento vinculado. No sustituirlas por
  servicios de otra duración o revisiones de auxiliar para pasar la validación.
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
