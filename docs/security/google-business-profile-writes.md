# Escrituras Google Business Profile y recuperación de recibos

> **Tipo:** contrato de implementación y validación.
> **Fuente de verdad:** broker, diario SQL y consumidores manuales/automatizados preparados en fuente DEV; no acredita publicación ni aceptación clínica.
> **Última revisión:** 2026-09-20.
> **Relacionado con:** [consumidores públicos](google-public-consumers.md), [contrato backend](../../src/Documentacion/13-backend.md#escrituras-tipadas-business-profile-preparadas), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Estado y frontera

Preparados en fuente DEV el broker, diario SQLite, diario SQL, cuatro consumidores
manuales, nodo de horarios programados, rutas de recuperación y UI. Las fichas gestionadas ya tienen un recorrido
sin leer tokens locales; las no migradas conservan la vía anterior con el guard de
credenciales legacy. El nodo gestionado conserva un intento por ejecución/nodo y
comprueba el intento vigente del job antes de aceptar su resultado.
No retirar tokens compartidos ni activar la cohorte hasta completar el censo,
la resolución de incertidumbres y la aceptación autenticada. Ninguna candidata
pública ni runtime incorpora este consumidor. Las tres tablas SQL ya están
aplicadas y vacías solo en DEV desde el 20/09; CRM conserva el esquema anterior.
[Acta SQL y recuperación](google-schema-readiness.md). La compatibilidad AWS de auditoría v25 está publicada
y verificada desde el 20/09: [acta y recuperación](audit-reader-view-migration.md).

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
`BusinessProfileCacheStates` coordina ese diario con el sync de reseñas, medios
y detalles. Conserva hasta tres filas por ubicación global Google, independientes
de la cuenta, mapping o namespace del proceso; DEV sigue separado por su BD.
Cada familia guarda época, identificador de observación y número de mutaciones
pendientes. Admisión/finalización modifican época y contador en la misma transacción
que el intento o recibo. La recuperación histórica no los modifica de nuevo.

El sync captura época/observación antes del HTTP y comprueba ambas al guardar,
junto con el mapping/registro/revocación actuales. Otra mutación o una observación
posterior invalida la respuesta antigua. Los bloqueos SQL duran solo el trabajo
local; ninguna transacción espera la llamada a Google. Un intento incierto impide
iniciar lecturas de su familia incluso si después se cierra el gate escritor; las
otras familias pueden avanzar. El job conserva su error/reintento existente, sin
nuevo envío de la mutación ni borrado de pendientes. No es un bloqueo global de CRM.

Cada página de reseñas y cada lote de borrado autoritativo valida esa observación
dentro de la transacción que cambia la caché. La poda recorre por ID en lotes de
hasta 500, conserva la condición de paginación completa y no corre en incremental.
Medios/detalles combinan sus datos con el JSON actual bajo bloqueo de fila.
También los lectores legacy usan esta coordinación, para respetar una mutación
gestionada sobre un alias; requiere la tabla antes de publicar esos lectores.
Las escrituras legacy todavía no participan en el diario. Esta protección tampoco
prueba consistencia inmediata de Google ni ordena cambios externos en su interfaz:
una lectura nueva posterior a la confirmación podría recibir datos aún no
convergentes del proveedor. Esa aceptación real y su política siguen pendientes.
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

## Horarios programados y propiedad de la ejecución

`businessProfileAutomation.service` adapta el nodo existente
`action/update_google_special_hours`; no añade programación de citas ni un job
nuevo. Las fichas sin migrar conservan su recorrido anterior. La simulación del
motor no llama al broker. En una ficha gestionada se exige una ejecución V2
persistida, su log de nodo y un `JobRequest.automations_v2_execute` vigente; una
llamada directa sin ese contexto no puede publicar.

El UUID se deriva de namespace, ejecución y nodo. El diario guarda el plan
combinado original, autor y hashes de plantilla/nodo: otro intento del job no
recompone fechas ni sustituye el comando. Antes de admitir se verifica que el
plan local no cambió desde su lectura. Se comprueban plantilla publicada/activa,
clínica, creador, nodo actual, gates y permisos de todas las clínicas afectadas
antes/después de las esperas y dentro de las transacciones. Editar la plantilla
o retirar un permiso impide aceptar el recibo antiguo.

`jobClaim` identifica el intento por ID, contador monotónico `attempts`, instante
de adquisición, namespace explícito y ejecución. Conserva también la vigencia
del executor en memoria; se invalida al terminar o agotar el plazo. **No es un
lease con renovación ni cancela una petición externa ya enviada.** La finalización
del scheduler y su reparación SQL comparan el número de intento esperado: un
trabajador anterior no puede finalizar el intento de otro.

El motor comprueba ese claim al entrar, entre nodos, tras procesarlos y al guardar
el estado, bajo bloqueo breve ejecución→job. Las escrituras de estado y la
reanudación de esperas rechazan un nodo/estado que cambió entretanto. La red queda
fuera de estas transacciones. Esto protege la aceptación del estado del motor;
no convierte automáticamente los demás efectos de los nodos en cancelables o
idempotentes. Siguen sujetos a sus contratos propios.

Si falta la confirmación, el flujo queda `waiting` en el mismo nodo, con
`provider_status: outcome_unknown` y plantilla activa. Los siguientes intentos
consultan únicamente el UUID original: espera de 1, 2, 4… minutos, con tope de
una hora; `not_found` tampoco permite reenviar. Hay un máximo de ocho resultados
no confirmados, contando el envío inicial, o 24 horas desde la admisión SQL.
Se conserva el contador entre intentos; la antigüedad se obtiene del diario,
no de una fecha reiniciada por el job. Un recibo confirmado permite
guardar juntos log, salida, siguiente nodo y desactivación opcional de la
plantilla. Un fallo durante ese guardado revierte esos cuatro cambios, aunque el
diario ya tenga el recibo aplicado; el siguiente intento acepta ese recibo sin
otra publicación. Las excepciones conservan el nodo y no toman `on_fail`, porque
una interrupción no demuestra que la escritura externa haya fallado.

El timeout global del executor conserva su política existente: resultado fallido
**sin reintento automático**. Tras él, el manejador tardío pierde su claim y no
puede aceptar ni avanzar. La recuperación forzada del fixture demuestra seguridad
ante otro intento autorizado; no implementa ni autoriza un botón de reejecución
clínica. Al agotar el presupuesto de consulta, la ejecución conserva `waiting`,
el mismo nodo y `manual_review_required:true`, sin `wait_until`; su job finaliza
`failed`, `retryable:false`. Es una incidencia de conciliación, no una declaración
de que Google rechazó el cambio. El executor reconoce esta retención antes del
backoff genérico, que de otro modo programaría otra consulta con fecha nula.
Otro claim no vuelve a consultar ni escribir. La plantilla no se desactiva y no
se toma `on_fail`. No hay un nuevo servicio de colas ni barrido global.

El endpoint de reanudación genérica rechaza estas esperas con HTTP409 después
de comprobar el ámbito; el motor también las protege aunque no se use ese
endpoint. Timeout/respuesta/formulario no pueden borrar el contador ni saltarse
la espera. Monitor y editor muestran el aviso correspondiente y ocultan la
reanudación genérica; las esperas normales conservan su operación anterior.
No genera automáticamente notificaciones externas.

La revisión operativa empieza por el UUID original en Perfil de Empresa, con
la sesión del autor y permisos vigentes. Esa acción solo recupera el recibo y
su caché; **no reanuda una ejecución agotada**. Si continúa `unknown/not_found`,
conservar diario, locks, ámbito y error, contrastar el cambio con el titular en
Google y mantener la incidencia abierta. Una apariencia coincidente en Google
no prueba qué intento la produjo. No existe aún una acción para certificar esa
evidencia, resolver el bloqueo y aceptar atómicamente el nodo: esa resolución y
su prueba autenticada siguen pendientes antes de activar la cohorte. No duplicar
plantilla/ejecución, sustituir el UUID ni editar filas para desbloquearla.
Tampoco se libera un lock
por antigüedad. Los jobs clínicos de DEV permanecen apagados.

Variables sin activar: `GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED`,
`GOOGLE_BUSINESS_PROFILE_WRITER_KEY_ID` y `GOOGLE_BUSINESS_PROFILE_WRITER_KEY_FILE`,
además del gate lector GBP y `JOB_RUNTIME_NAMESPACE` explícito. No se han generado
ni admitido claves reales de escritor ni instalado esta cohorte en AWS.

Mientras `GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED` y
`GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED` no estén ambos activos, el preflight
excluye el grupo de esquema `google_business_profile_writes` y los sync de solo
lectura no consultan sus tres tablas. Esto conserva el comportamiento previo,
pero no autoriza escrituras. Activar ambos gates obliga a tener registradas las
dos DDL y hace que el preflight falle cerrado si falta alguna.

Siguiente implementación necesaria:

1. Completar la resolución de incertidumbres retenidas para revisión y la aceptación real del
   nodo adaptado. Mantener apagados en DEV los jobs que actúan sobre pacientes,
   leads, campañas y automatizaciones; este corte no autoriza su activación.
2. Las DDL `20260919200000-create-business-profile-mutation-journal.js`
   y `20260919210000-create-business-profile-cache-coordination.js` (tres tablas)
   ya están aplicadas solo en DEV. Preparar su corte clínico nuevo antes de
   publicar allí consumidores/sync. Fuente y esquema DEV pasan 52 tablas;
   el corte clínico anterior de 49 sigue consumido y no
   se amplía ni se ejecuta de nuevo. Drenar escritores y sync para el corte; la
   migración de coordinación rechaza intentos inciertos existentes. No inicializar
   contadores a cero sobre actividad anterior ni mezclar escritores de versiones
   que no participan. El down rechaza borrar filas de coordinación existentes.
3. Conservar la compatibilidad AWS v1–v25 publicada el 20/09 y publicar el panel
   y filtro v25 junto con los consumidores. El canario sintético real verifica
   transporte S3; no sustituye la aceptación clínica del consumidor.
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
y los cortes `google-gbp-writers-20260919/`, `google-gbp-sync-20260919/` y
`google-gbp-automation-20260919/`.
La coordinación se prueba además con respuestas tardías reales entre promesas,
mutaciones simultáneas, aliases, pérdida de ACK, gate escritor cerrado, revocación
y poda por lotes en el MySQL aislado. No sustituye la prueba Google/CRM real.
La fuente real del executor y motor se carga con dependencias explícitas en el
MySQL aislado. Se prueban ACK perdido, timeout real antes/después de aceptar Google
ficticio, reemplazo/cancelación de claim, namespace/ejecución incorrectos, permisos
y plantilla modificados durante la llamada, rollback del nodo, plan concurrente
y consulta de incertidumbres sin reenvío. No prueba interfaz autenticada ni Google real.
No hay despliegue del consumidor GBP que revertir. La publicación AWS de auditoría
exige conservar un lector v1–v25. Conservar las releases/grants clínicos actuales. Una futura
recuperación debe mantener el diario y los intentos inciertos; volver a código
que lea tokens o borrar bloqueos no es una recuperación válida de una cohorte
ya migrada. No trabajar en copias generales ni rotación hasta nueva instrucción
expresa del titular; antes debe acordarse dónde se alojarán las copias.

Fuentes primarias contrastadas: [actualizar respuesta](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply),
[eliminar respuesta](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/deleteReply),
[crear foto y particularidades PROFILE/LOGO](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/create)
y [actualizar ubicación](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch).
