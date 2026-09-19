# Escrituras Google Business Profile y recuperación de recibos

> **Tipo:** contrato de implementación y validación.
> **Fuente de verdad:** broker, diario SQL y consumidores manuales preparados en fuente DEV; no acredita publicación ni aceptación clínica.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [consumidores públicos](google-public-consumers.md), [contrato backend](../../src/Documentacion/13-backend.md#escrituras-tipadas-business-profile-preparadas), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Estado y frontera

Preparados en fuente DEV el broker, diario SQLite, diario SQL, cuatro consumidores
manuales, rutas de recuperación y UI. Las fichas gestionadas ya tienen un recorrido
sin leer tokens locales; las no migradas conservan la vía anterior con el guard de
credenciales legacy. **El nodo de automatización de horarios aún no está adaptado**.
No retirar tokens compartidos ni activar la cohorte hasta completar ese consumidor,
el censo y la aceptación autenticada. Ninguna candidata pública ni runtime incorpora
este corte; las dos tablas SQL nuevas tampoco están aplicadas a DEV o CRM.

La cohorte explícita `google-business-profile-write-v1` admite lectores y escritores
con identidades distintas. La cohorte anterior de lectura rechaza tanto grants
de escritura como la configuración `googleBusinessProfileWrites`. Por ubicación
y clínica se autorizan separadamente respuestas, fotos y horarios. Identidades
y claves de escritores, lectores, revocación y OAuth no se pueden reutilizar entre
esas funciones. No se solicitan scopes nuevos: escritura exige `business.manage`.

## Operaciones cerradas

Todas llevan el prefijo `google.business_profile.` y un `operationId` UUIDv4
persistido por el consumidor antes de enviar. La firma añade un `requestId`
independiente por intercambio de transporte.

| Operación | Entrada específica | Acceso al proveedor |
| --- | --- | --- |
| `review.reply.update.v1` | ID de reseña y comentario, máximo 4096 unidades UTF-16 | PUT a la respuesta de esa reseña y ubicación |
| `review.reply.delete.v1` | ID de reseña | DELETE a la misma respuesta, sin cuerpo |
| `photo.publish.v1` | Enlace público, categoría y descripción opcional | POST PHOTO a los medios de la ubicación |
| `special_hours.update.v1` | Hasta 80 periodos compactos, máximo 730 días expandidos | Comprobar horario regular y PATCH con `updateMask=specialHours` fijo |
| `mutation.status.v1` | `operationId` | Solo diario local; no Google ni Secrets Manager |

Cuenta y ubicación salen del grant `gbp:<cuenta>:<ubicación>`. El consumidor no
elige host, método, headers ni máscara. TLS verificado, respuestas limitadas y sin
redirecciones/reintentos automáticos. Se mantienen turnos separados, rechazo de
solapamientos y borrado explícito del horario especial con una lista vacía.
El plan compacto cabe en el límite firmado de 32 KiB; solo el PATCH generado
internamente tiene hasta 192 KiB. No aumenta el límite de las otras operaciones.

Las fotos admiten únicamente objetos de `https://media.clinicaclick.com`, bajo
`marketing/clinic-<id>/AAAA/MM/<UUID o identificador hexadecimal>.jpg|jpeg|png|webp`.
Se admite la clínica propietaria o una clínica incluida explícitamente en
`publicMediaClinicIds` de esa ubicación; permite publicar el activo público de la
clínica solicitante cuando la ficha es compartida. El permiso no es global para
esa clínica ni permite rutas clínicas. Se rechazan otras clínicas, query/fragmento,
rutas privadas y destinos arbitrarios.
**El archivo no atraviesa el broker**: Google recibe la URL pública. El consumidor
debe seguir verificando `PublicMediaAsset`: activo, propietario, propósito,
sensibilidad y declaración de ausencia de datos clínicos; el broker no consulta
esa BD. Antes del corte real hay que censar objetos anteriores con claves
personalizadas, sin ampliar automáticamente el permiso a cualquier URL.

Se aceptan las particularidades documentadas de PROFILE/LOGO: alias LOGO→PROFILE,
recurso `/media/profile`, fecha de creación epoch, dimensiones ausentes y URL de
origen devuelta por Google distinta de la original. `completedAt` pertenece al
recibo. El consumidor debe conservar por separado el activo/URL original.

## Diario, concurrencia y respuestas perdidas

Dos tablas privadas se crean únicamente al montar esta cohorte:
`google_business_profile_mutations` y `google_business_profile_mutation_locks`.
El intento, hash del contenido, ámbito/principal, petición inicial y bloqueos se
confirman en SQLite antes de llamar al proveedor. No guardan el cuerpo de entrada
ni credenciales. Un resultado confirmado guarda solo la proyección de respuesta
permitida; puede incluir el comentario público, URLs públicas y horarios. Este
contenido queda en el diario privado, **no en S3 de auditoría**. La auditoría
contiene identificadores, acción, resultado y motivo fijos.
Consulta de recibos por clave primaria y liberación de bloqueos por índice de
`operation_id`; los planes SQLite comprobados no recorren el historial completo.
Esto no acredita todavía rendimiento con cardinalidad ni carga reales.

Recibo aplicado, auditoría de finalización y liberación de bloqueos comparten
transacción. Si se pierde la respuesta al consumidor después del commit,
`mutation.status.v1` devuelve el recibo incluso tras reiniciar y sin obtener
credenciales. Mantiene controles de conexión activa, activo, principal/clave,
ámbito, configuración y permiso de la operación original.

Si falla el proveedor, vence el plazo, se revoca durante la llamada o no se puede
confirmar la auditoría, el intento permanece `unknown`. Repetir el UUID no envía
otra escritura; crear otro tampoco evita los bloqueos sobre esa reseña, horario
o URL de foto. PROFILE/LOGO y COVER añaden bloqueo del puesto de imagen. Los IDs
globales de ubicación hacen que otro grant/cuenta gestionando esa ubicación
respete el bloqueo **dentro del mismo diario SQLite**. No controla escrituras
manuales externas a este broker ni reconoce dos archivos distintos como la misma
foto. No hay liberación por tiempo ni reenvío tras reinicio.

`not_found` significa que el diario no registra todavía ese intento; **no prueba
que no haya una petición en curso** ni permite crear otro identificador. El
consumidor conserva el mismo `operationId`. No se ha implementado una herramienta
para resolver manualmente intentos inciertos: requiere evidencia independiente y
un contrato específico; no borrar tablas, locks ni recibos para desbloquearlos.

## Consumidor SQL, autorización y recuperación

`BusinessProfileMutations` conserva UUID, autor y sesión original o ejecución/nodo,
namespace, ámbito, hashes, entrada tipada y datos necesarios para actualizar la
caché. `BusinessProfileMutationLocks` bloquea el recurso hasta confirmar también
la aplicación local. El intento y su evento v25 se confirman antes de enviar;
recibo, caché, auditoría de finalización y liberación se confirman en una sola
transacción MySQL. No hay llamada de red dentro de esa transacción. La entrada
puede incluir comentario público, URL pública y plan; S3 recibe solo metadatos.

`businessProfileBroker.write/assert` y el diario vuelven a verificar sesión vigente,
permisos, mapping, registro independiente, revocación y gates antes/después de las
esperas. El ámbito usa la ficha concreta de la reseña, grupos que la comparten,
asignaciones explícitas y otros mappings de la misma ubicación Google. No se limita
a la primera ficha del inventario. Las consultas de autorización son de metadatos
GBP; no cargan todo el inventario de marketing ni secretos. El listado de pendientes
reutiliza la comprobación de cada mapping dentro de la petición y la repite antes
de entregar la página. No se afirma que la búsqueda de aliases por sufijo esté
indexada: requiere medición con el catálogo y la carga reales antes del corte.

La recuperación humana requiere el mismo usuario original, clínica, namespace y
ámbito íntegro, con una sesión vigente; puede recuperar un intento de ese usuario
originado en una automatización sin simular que el job continúa activo. Una
operación ya aplicada devuelve la caché actual, sin volver a aplicar su recibo.
Esta protección ordena los escritores que participan en el diario. El sync de
reseñas todavía usa `bulkCreate(updateOnDuplicate)` y el de medios/detalles
actualiza la caché por su vía anterior: falta impedir que una lectura iniciada
antes del cambio publique después una observación antigua. Debe coordinarse con
el diario antes de activar escritores; no se acredita aislamiento frente a esos
jobs ni frente a cambios hechos directamente en Google.
Cambiar la lista de clínicas o el mapping mantiene el resultado pendiente de
revisión; no se eluden sus bloqueos ni se crean UUID alternativos.

Rutas bajo `/api/local/clinica/:clinicaId`:

- PUT/DELETE `reviews/:reviewId/reply`, POST `photos` y PUT `special-hours` aceptan
  `operationId`; las fichas gestionadas lo exigen. DELETE también lo recibe en JSON.
- GET `mutations/pending` devuelve hasta 100 referencias del propio usuario,
  ordenadas por fecha/UUID, sin contenido de reseñas ni URLs. Gates cerrados:
  lista vacía y `enabled:false`, sin consultar las tablas pendientes.
- POST `mutations/:operationId/recover` consulta el recibo original. No envía una
  mutación. Un resultado incierto usa HTTP202 y `success:false`; no es un guardado.

La UI guarda solo identidad/tipo del intento en `sessionStorage`, separada por
API, usuario y clínica, antes del HTTP gestionado. Mantiene el mismo UUID al
resuscribirse al observable; una página nueva combina esas referencias con SQL.
«Consultar resultado» no vuelve a publicar. Se conservan borradores y se bloquean
nuevas escrituras de esa clínica mientras haya incertidumbre o falle su consulta.
Una referencia guardada en el navegador antes de que SQL llegue a admitirla puede
quedar sin recibo; todavía exige revisión. No hay acción para borrar pendientes
ni resolución manual de `not_found/unknown`. El almacenamiento de pestaña no
sustituye al diario SQL ni al procedimiento operativo pendiente.

Variables sin activar: `GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED`,
`GOOGLE_BUSINESS_PROFILE_WRITER_KEY_ID` y `GOOGLE_BUSINESS_PROFILE_WRITER_KEY_FILE`,
además del gate lector GBP y `JOB_RUNTIME_NAMESPACE` explícito. No se han generado
ni admitido claves reales de escritor ni instalado esta cohorte en AWS.

Siguiente implementación necesaria:

1. Coordinar el commit de las lecturas de reseñas/medios/detalles con las escrituras
   nuevas y probar respuestas de sync tardías. Adaptar `applyScheduledSpecialHoursPeriod` y el nodo de flujos: identidad estable
   por ejecución/nodo, comprobación de lease/plantilla/gates y recuperación sin
   recomponer otro plan ni repetir una acción. Mantener DEV clínico apagado.
2. Preparar corte SQL nuevo para la migración
   `20260919200000-create-business-profile-mutation-journal.js` (dos tablas), primero
   en DEV. El contrato de fuente requiere 51 tablas; el corte clínico anterior de 49
   sigue consumido y no se amplía ni se ejecuta de nuevo.
3. Publicar compatibilidad AWS de auditoría v25 —lector antes que escritor— antes
   de emitir esos eventos. El panel y filtro v25 están preparados en fuente.
4. Completar resolución/retención de incertidumbres, censo de identidad compartida,
   promoción selectiva y pruebas autenticadas en las pantallas reales con titular,
   proveedor y cardinalidad/carga reales. La preparación no autoriza el cierre legacy.

## Evidencia y recuperación

Broker: 17 grupos específicos, incluyendo TLS real y corte de respuesta tras commit;
MySQL 8/SQLite: consumidores manuales y recuperación con permisos/sesiones ficticios,
fallos de auditoría, sesión revocada, aliases, grupos, fotos compartidas y caché
posterior protegida. Auditoría: 97 pruebas, incluidas v25 y rechazo de referencia,
digest o KMS distintos. El componente Angular y su servicio se prueban en Chromium
con HTTP ficticio, en escritorio/móvil. Los proveedores, sesiones y datos de QA
son ficticios: no es aceptación clínica autenticada. Resultado de regresión global y revisiones en
la [bitácora](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-consumidores-manuales-gbp-diario-sql-y-pendientes-2026-09-19).

Evidencia privada: `qa-evidence/security-resume-20260917/google-gbp-consumers-20260919/`
y el corte previo `google-gbp-writers-20260919/`.
No hay despliegue que revertir. Conservar las releases/grants actuales. Una futura
recuperación debe mantener el diario y los intentos inciertos; volver a código
que lea tokens o borrar bloqueos no es una recuperación válida de una cohorte
ya migrada. Copias generales al final; rotación periódica aplazada.

Fuentes primarias contrastadas: [actualizar respuesta](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply),
[eliminar respuesta](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/deleteReply),
[crear foto y particularidades PROFILE/LOGO](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/create)
y [actualizar ubicación](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch).
