# Escrituras Google Business Profile y recuperación de recibos

> **Tipo:** contrato de implementación y validación.
> **Fuente de verdad:** operaciones del broker y adaptador preparados en fuente DEV; no acredita migración de consumidores ni publicación.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [consumidores públicos](google-public-consumers.md), [contrato backend](../../src/Documentacion/13-backend.md#escrituras-tipadas-business-profile-preparadas), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Estado y frontera

Preparados en DEV el contrato, transporte, diario SQLite, consulta de recibos y
adaptador de backend. **Las cuatro funciones de `businessProfileLocal.service.js`
todavía usan la vía anterior**: faltan diario SQL del consumidor, rutas, UI y
automatizaciones. No retirar tokens compartidos ni activar la cohorte para dar
por terminada esta migración. Ninguna candidata pública ni runtime incorpora
esta preparación todavía; sin DDL clínica, flags, grants o recursos AWS nuevos.

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
Se rechazan otra clínica, query/fragmento, rutas privadas y destinos arbitrarios.
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

## Adaptador y trabajo pendiente del consumidor

`businessProfileBroker.write` exige contexto gestionado, cliente escritor propio,
UUID y función de autorización del llamante. Comprueba mapping, registro y
revocación antes/después de esperas; vuelve a comprobar permisos del llamante
antes de aceptar una respuesta para actualizar SQL. Nunca usa el cliente lector
ni devuelve tokens. Estas comprobaciones no sustituyen el diario/orden de las
operaciones locales, que todavía falta.

Variables nuevas, sin activar: `GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED`,
`GOOGLE_BUSINESS_PROFILE_WRITER_KEY_ID` y `GOOGLE_BUSINESS_PROFILE_WRITER_KEY_FILE`.
Requieren también el gate previo de GBP. No se han generado/admitido claves reales
ni instalado esta cohorte en AWS.

Siguiente implementación necesaria:

1. Diario SQL del intento y su resultado local, identidad estable de usuario/job,
   permisos de todas las clínicas afectadas, sesión y validación de activo público.
2. Adaptar las cuatro funciones y `applyScheduledSpecialHoursPeriod`/nodo del motor
   de flujos. Conservar funcionamiento, gates, namespace y pausas; sin históricos.
3. Reconciliar recibos sin nueva mutación y sin sobrescribir un cambio posterior
   con el recibo de una operación anterior. Presentar incertidumbre y recuperación
   en las pantallas existentes, con pruebas visuales reales.
4. Ensayar SQL/HTTP/HTTPS integrados, promover selectivamente a candidatas propias
   y completar el censo de toda la identidad Google antes del marcador de cierre.
5. Configurar y aceptar cohorte real con titular, MFA, proveedor y carga. La sesión
   SSO sigue caducada en la comprobación de esta continuación; renovar con el titular.

## Evidencia y recuperación

Suite nueva: 16 grupos aislados, incluyendo HTTPS real con el adaptador actual,
corte deliberado de socket después del commit, reinicio y consulta sin secretos
ni segunda publicación. Cubre dos conexiones SQLite, concurrencia, otra cuenta,
revocación, fallo de auditoría, respuesta tardía, scopes, cuerpos, URLs, gates y
separación de claves. Backend: ocho grupos entre adaptador y contrato local previo.
Los servicios Google, AWS y el titular son ficticios; no es aceptación clínica ni
prueba visual de estas escrituras. Resultado de regresión global y revisiones en
la [bitácora](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-escrituras-tipadas-gbp-y-recuperación-de-recibos-2026-09-19).

Evidencia privada: `qa-evidence/security-resume-20260917/google-gbp-writers-20260919/`.
No hay despliegue que revertir. Conservar las releases/grants actuales. Una futura
recuperación debe mantener el diario y los intentos inciertos; volver a código
que lea tokens o borrar bloqueos no es una recuperación válida de una cohorte
ya migrada. Copias generales al final; rotación periódica aplazada.

Fuentes primarias contrastadas: [actualizar respuesta](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply),
[eliminar respuesta](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/deleteReply),
[crear foto y particularidades PROFILE/LOGO](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/create)
y [actualizar ubicación](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch).
