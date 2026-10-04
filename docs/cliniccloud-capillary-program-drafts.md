# Borradores documentales de programas capilares

> **Tipo:** runbook de una operación acotada.
> **Fuente de verdad:** ejecución del operador; contrato y estado en el manual central.
> **Última revisión:** 2026-10-04.
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
  se inventan. **Aclaración del 04/10:** las tablas originales sí indican
  «qué se hace, en este orden» y sitúan las revisiones tras los tratamientos;
  no especifican sus fechas ni la mayoría de intervalos. La advertencia de los
  borradores iniciales sobre «inventario» no debe borrar ese orden documental.
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

## Reconciliación posterior y modalidad manual — 04/10/2026

El titular autoriza programas sin intervalos con sesiones pendientes de citar,
fechas elegidas manualmente y duración explícita cuando no exista. No cambiar
los paquetes iniciales sellados ni repetir sus importadores para activarlos:
reconciliar el catálogo actual por su API y versión vigentes. La modalidad
manual y la vinculación de citas existentes tienen su contrato en el manual
central 18.2; no acreditan que los datos clínicos/comerciales de BS estén listos.

La consulta SQL actual confirma ocho fichas inactivas importadas deliberadamente
en borrador, no ocho tratamientos retirados por la clínica. Las incidencias de
instalación antiguas pueden estar resueltas y deben contrastarse con recursos
actuales. No basta cambiar `activo`: hay que conservar perfiles, equipos,
consentimientos y fiscalidad. CAP-04 define revisión médica de 15 minutos;
la ficha anterior asignada a auxiliar no se debe reescribir como si acreditase
un acto médico histórico. El reparto de PRP+LED tampoco puede inventarse para
encajar una máquina fija en otra sala.

Los precios del archivo son finales, pero no acreditan IVA o exención. El
criterio oficial distingue asistencia sanitaria terapéutica por profesional
reconocido y prestaciones puramente estéticas: no eximir por el nombre del
producto ni extrapolar un IVA histórico a todas las variantes. Las prestaciones
incluidas sin precio individual no son automáticamente servicios gratuitos.
No alterar presupuestos/facturas anteriores ni crear compras, firmas o consumos
para lograr la activación.

### Decisión fiscal de este corte

Investigación autorizada y contrastada con la
[AEAT, manual IVA 2026](https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2026/capitulo-03-entregas-realizadas-empresarios-profesionales/entregas-bienes-servic-realizadas-empresarios-profesionales/operaciones-exentas/exenciones-operaciones-interiores/exenciones-operaciones-medicas-sanitarias.html)
y la [Ley 37/1992, artículos 20.Uno.3 y 90](https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740#a20):
servicio estético no terapéutico, 21 %; asistencia sanitaria de diagnóstico,
prevención o tratamiento de enfermedades por profesional reconocido, exenta.
No existe un IVA único por técnica capilar. Los archivos no acreditan esa
clasificación para todas las fichas y el rol informático no certifica titulación.

El permiso para decidir autónomamente no se registra como prueba de una
finalidad clínica. No fijar un tipo masivo ni fabricar una exención. Conserva
la revisión fiscal mientras falte el supuesto de hecho del servicio, no porque
no se haya investigado la norma. Mantener precios finales y economía anterior.
El contrato vigente tampoco admite `standalone_sales_enabled=false` como
política efectiva: es una propuesta, no una protección implementada. Las
variantes incluidas con `precio_base=null` requieren una política comercial
canónica antes de activarse; no usar un cero ficticio para superar el guard.
