# Destinos Data Manager autorizados por recibo de acciones

> **Tipo:** contrato técnico y recuperación.
> **Fuente de verdad:** registro del broker, diario humano y contrato CRM preparados; no activados.
> **Última revisión:** 2026-09-18.
> **Relacionado con:** [acciones](google-action-management-broker.md), [entrega](google-data-manager-broker.md), [backend](../../src/Documentacion/13-backend.md#autorizacion-interna-de-destinos-data-manager).

Preparado y probado con proveedores ficticios. Sin publicación AWS/API, DDL
operativa, flags habilitadas ni cohortes Google migradas. Diario humano, API,
confirmación UI, recuperación sin referencia local y auditoría v18 preparados y
probados; compatibilidad AWS v18 y aceptación integrada/autenticada pendientes.

## Decisión explícita y alcance

La cohorte `google-ads-conversions-v1` permite tres operaciones nuevas:

| Operación | Entrada exacta | Resultado |
| --- | --- | --- |
| `google.ads.conversion_destinations.authorize.v1` | `planId`, `targets:[{event,sources}]` | UUID de autorización, plan, estado activo y destinos derivados |
| `google.ads.conversion_destinations.status.v1` | `authorizationId` | Estado durable activo/revocado y selección original |
| `google.ads.conversion_destinations.revoke.v1` | `authorizationId`, opcional `input:{planId,targets}` | Retirada del permiso propio, incluso antes de que llegue authorize si se conserva la intención |

Cada autorización exige un plan **applied** del mismo principal/clave, clínica,
conexión y activo. Conserva ámbito OAuth, cuenta/gestor y permisos originales.
Prepared, validate-only, attempted, inventario o consultar estado no autorizan.
Los IDs proceden del recibo aplicado y de los cambios conservados del plan:
el consumidor no puede suministrarlos. La caducidad de preparación no elimina
un recibo ya aplicado.

`googleDataManagerEnrollment.accounts` fija cuenta, eventos y orígenes permitidos;
requiere los bindings de acciones y Data Manager. Hasta cinco eventos únicos del
catálogo y WEB/OTHER, sin duplicados. Puede seleccionarse un subconjunto del plan.
`googleDataManager.destinations` admite lista vacía solo con la nueva política
válida; ello no concede destinos. Las cohortes de lectura rechazan este contrato.

Se mantienen las claves separadas de operaciones Ads, revocación general de
activos, enrollment de cuentas y OAuth. Revocar **el destino propio** pertenece
al principal operativo; no concede revocación general de otra identidad. Los
grants siguen fijando principal, tenant, conexión, activo y operación.

Los destinos nuevos tienen `enhancedPolicy=null`: no autorizan hashes personales.
La ingesta sigue exigiendo clic, consentimiento, permisos, pausas clínicas y reserva
de entrega CRM. Autorizar no prueba disponibilidad, términos, recepción final ni
readiness; necesita `validateOnly` separado. No escribe IntakeConfig, activa jobs
ni envía conversiones al crearse.

## Persistencia, concurrencia y coste

Dos tablas en el **SQLite existente del broker**:
`google_destination_authorizations` conserva propietario, plan, ámbito, selección,
estado y fechas; `google_destination_targets` indexa como máximo diez parejas
evento/origen por autorización. Sin nueva BD contratada, BullMQ, tokens, clics,
hashes personales ni contenido de eventos.

La búsqueda activa usa un índice único por principal, tenant, conexión, activo,
acción, evento y origen. Permiso y plan se leen por clave primaria; no se escanea
el historial ni se llama a Google para resolver el destino. Esto acredita el plan
SQL, no capacidad bajo carga ni aislamiento de CPU en la instancia compartida.

Un plan solo produce una autorización durable; otro UUID no lo adopta. Dos
autorizaciones activas del mismo propietario no pueden solapar la misma pareja
acción/evento/origen. Tampoco pueden solapar un permiso estático existente.
Los permisos estáticos son otra autoridad explícita: revocar uno dinámico no
elimina permisos estáticos que un operador configure después.

Permiso/revocación, targets, acuse y auditoría técnica se confirman juntos en una
transacción SQLite, repitiendo las comprobaciones dentro del commit. Cambiar clave,
identidad/secretos, cuenta/gestor, política o proyecto de cuota invalida el permiso.
Al cambiar política hay que sustituir y drenar el proceso anterior: esto no recarga
remotamente su configuración.

Las tres operaciones no mutan Google ni ingieren eventos. Utilizan la comprobación
de credenciales del broker y pueden resolver/refrescar OAuth: no se presentan como
operaciones sin acceso a secretos ni de coste cero. Auditoría usa outbox/S3
existentes. Este corte no está instalado en AWS: no hay coste real medido de su
uso ni nuevos recursos contratados.

## Revocación y recuperación

Repetir exactamente authorize recupera su acuse. Tras revocarse, tanto ese replay
como otro UUID para el mismo plan fallan; el cierre permanece tras reiniciar.
Autorizar de nuevo requiere otro plan aplicado y otra decisión explícita,
conservando el historial anterior.

Ingesta comprueba el permiso antes de secretos, al resolverlos, antes/después de
Google y al confirmar su recibo. Una revocación después de comenzar el envío deja
el intento incierto: no se afirma que Google no lo recibió ni se repite. El digest
del recibo incluye UUID/ámbito del permiso; uno posterior no adopta el envío.
Con el destino revocado `status` de Data Manager sigue cerrado. La nueva operación
explícita `conversion.reconcile` preparada consulta solo recibos aceptados con
referencia durable a su autorización original, sin restaurarla ni enviar. El
consumidor administrativo y su aceptación siguen pendientes; contrato y límites en
[recuperación de recibos](google-data-manager-broker.md#recibos-después-de-retirar-un-permiso-de-destino).

En el broker, status o el mismo comando recuperan un permiso durable; el diario
CRM **no retransmite** un UUID admitido. Si falta el permiso, un error de status
no demuestra ausencia de authorize en vuelo. Retirar conservando UUID e intención
original permite crear un cierre anticipado: exige el mismo plan aplicado y
selección autorizable, guarda estado revocado sin targets activos y bloquea la
llegada tardía de authorize. Otro permiso del mismo plan impide ese cierre.
Si ya existe el permiso, la intención aportada debe coincidir exactamente.

Si falla el commit de retirada, el permiso anterior permanece. Si la petición no
llegó, una **nueva confirmación explícita de retirada**, con otro comando pero el
mismo UUID/intención del permiso, puede terminarla. No se reintenta authorize ni
se cambia la selección. Hasta verificar revoked, la UI conserva incertidumbre,
incluso si status devuelve todavía active. Una respuesta active tardía nunca
sobrescribe revoked ya guardado. El cierre de un authorize incierto se audita
como unknown: no permite afirmar si llegó a activar el permiso previamente.

No borrar tablas, cierres o recibos ni restaurar SQLite anterior. Para retirar
código tras utilizarlo, cerrar el consumidor de conversiones y conservar el estado;
un binario anterior no entiende la nueva política y debe rechazarla. No sustituir
permisos dinámicos por estáticos para eludir su retirada.

## Diario humano, API e interfaz preparados

`GoogleDestinationAuthorizations` y `GoogleDestinationCommands` residen en el
MySQL existente de cada entorno. La migración aditiva
`20260918220000-create-google-destination-journal.js` tiene metadatos y hash fijados
en el contrato de esquema tras ejecutarse en MySQL aislado. No se ha aplicado a
ninguna BD operativa. FK al plan, claves binarias, un permiso por plan, comandos
por UUID y coherencia de finalización; down rechaza historial no vacío.

El diario exige sesión gestionada, mismo usuario propietario del plan, ámbito
original intacto y escritura vigente sobre **todas** las clínicas de la cuenta.
Una sesión renovada del mismo usuario puede consultar/retirar, no retransmitir
authorize. Una decisión nueva sobre un plan aplicado puede capturar la nueva
sesión. Una clínica pausada impide autorizar; permite consulta y retirada con
permisos vigentes. Las comprobaciones se repiten antes/dentro/después del commit.
El orden de bloqueo es plan → permiso → comando; no se mantiene una transacción
SQL durante la llamada al broker. Recuperación indexada con límite de 1000
comandos pendientes; sin barrido de todos los usuarios ni polling de interfaz.

API base `/api/marketing/google-ads/conversion-destinations`, POST:

| Ruta | Cuerpo adicional a ámbito, customer_id y request_id |
| --- | --- |
| `/` | `plan_id`, `targets:[{event,sources}]`, `confirm_authorization:true` |
| `/list` | `cursor:null` o `{createdAt,authorizationId}`; `plan_id:null` o UUID del plan aplicado |
| `/:authorizationId/status` | Ninguno |
| `/:authorizationId/revoke` | `input:{planId,targets}` original, siempre obligatorio en CRM |

Exactamente un `clinic_id` o `group_id`; cuerpos cerrados, sin query ni IDs de
acciones arbitrarios. Rate limit de destinos: 30/minuto; usa el mismo valor que planes, con clave propia. Respuesta de comandos
`success,authorizationId,planId,commandId,commandState,outcomeUnknown,canRevoke,authorization`;
authorization es null o el recibo tipado del broker. 202 conserva intento incierto;
200 por sí solo tampoco implica permiso activo: interpretar estado/outcome.
Todas las respuestas son `private, no-store`; errores saneados, sin tokens.

El diálogo de acciones aplicadas ofrece **Revisar permiso de envío**. Se eligen
explícitamente hitos y WEB/OTHER; abrir, Finalizar o recuperar el plan no autoriza.
Antes de una **nueva autorización** se conserva UUID, ámbito, selección y IDs
esperados en `sessionStorage`; si no puede guardarlos, no envía la petición.
Recargar consulta una vez; no vuelve a autorizar, aplicar ni hacer polling.
Workspace y asistente ofrecen **Mis permisos de envío**, también sin referencia
local. Una referencia ya recuperada del servidor permite consultar/retirar aunque
el navegador no pueda guardarla. La retirada confirmada puede cerrar la referencia
local; ambos diarios conservan el historial.

### Recuperación sin referencia del navegador

`POST /list` usa la misma sesión gestionada, usuario, ámbito, mapping y permisos
vigentes de todas las clínicas que los comandos. La pausa clínica permite leer.
La respuesta exacta es `success,requestId,customerId,scopeKey,items,nextCursor`.
Cada item contiene `authorizationId,input,expected,revokeId,createdAt,observedAt,
observedState,outcomeUnknown`. `expected` se deriva de los IDs del plan aplicado,
convalidando propietario, sesiones originales, scope digest y recibo guardado.
Una propiedad antigua incompleta o manipulada hace fallar la página completa.
No expone credenciales, usuario/sesión original ni errores libres del proveedor.

La lista representa **últimas observaciones SQL**, no una comprobación remota del
estado actual. No crea comandos, autoriza, retira ni llama al broker por cada fila.
Al abrir un permiso se hace una consulta status explícita. Unknown se conserva;
active con una retirada pendiente no se presenta como autorización confirmada.
El diálogo de un plan aplicado consulta primero por ese plan: si ya tiene permiso,
recupera el original; no ofrece otro authorize. Si la consulta falla, impide una
nueva autorización hasta resolverla. Se pueden consultar otros planes propios.

Página máxima de 20, lectura SQL de 21 para detectar continuación y una lectura
agrupada de hasta 20 planes por clave primaria. Orden `(created_at,authorization_id)`
descendente, cursor exacto de posición, sin OFFSET ni COUNT del historial. El
cursor no concede acceso: usuario/mapping/ámbito/digest se recalculan en cada
petición; modificarlo solo cambia la posición dentro de lo ya autorizado.
`plan_id` filtra por la clave única y exige cursor null. No es una exportación ni
un snapshot congelado del estado mutable entre páginas.

La migración aditiva `20260918224500-index-google-destination-recovery.js` añade
`cc_google_destination_recovery(actor_user_id,mapping_id,scope_key,scope_digest,
created_at,authorization_id)`. Listado general fija ese índice, con 21 filas como
límite; EXPLAIN de filas completas confirma recorrido inverso sin filesort en
MySQL aislado. No acredita capacidad bajo carga. El rollback del índice no borra
datos, pero no puede retirarse mientras este código lo use. No se ha aplicado a
BD operativa. Sesión renovada mantiene acceso solo con el mismo usuario y ámbito;
no hay adopción por otro usuario ni conciliación administrativa de ámbito cambiado.

## Auditoría y coste

Admisión y finalización humanas usan evento v18
`integration.google_ads.destinations`, en el outbox **dentro de la misma
transacción**. Captura actor/sesiones, plan/permiso/comando, ámbito, conteo de
hitos/clínicas, digest de selección y resultado; no contenido clínico, OAuth ni
identificadores de clic. Un fallo de admisión impide transporte; un fallo después
del ACK conserva intento y permite consultar sin repetir autorización.
La salud del outbox se lee una vez por transacción y se reserva capacidad por
evento añadido: 10.000 pendientes o antigüedad de una hora bloquean la operación.
Recuperar status/retirada puede cerrar intentos anteriores con referencias
correlacionadas; no reescribe su historia ni convierte unknown en éxito inventado.

Listar tiene una variante cerrada v18 separada,
`integration.google_ads.destination_list`: guarda intento antes de leer filas y
`list_prepared` antes de liberar la página, con usuario/sesión, ámbito, cuenta,
conteo y digests de criterios/resultado; no guarda el contenido de los permisos.
La captura fallida impide devolver la página. Una pérdida de permisos en la última
comprobación también la suprime; «consulta preparada» no afirma recepción humana.
Usa dos eventos del mismo outbox por página, sin eventos adicionales por cada fila.

El visor proyecta el recibo después de verificar su versión S3 exacta y distingue
permiso confirmado, permiso retirado y resultado inicial incierto. v18 está
preparado en lector/escritor, pero AWS sigue en v17: publicar compatibilidad antes
de activar captura. Las candidatas conservan las fuentes propias de cada rol
observadas en la publicación v17, con 79 pruebas por rol. La prueba SQL aislada
prepara seis eventos de las dos variantes, todavía sin entregar a AWS. Revalidar
el estado vivo al renovar SSO; procedimiento en
[lector y publicación](audit-reader-view-migration.md#candidato-v18-preparado-sin-publicar). Usa el outbox, bucket S3 y servicios existentes, sin otro
servicio/cola contratados. Aumenta filas SQL, objetos/bytes S3 y solicitudes/KMS
según uso; QA local no aporta un coste real incremental ni permite anotarlo como
cero. La sección de costes de arquitectura conserva fecha/ámbito de medición.

## Cliente y aceptación pendiente

`googleAdsBroker.destinations(account, context, family, input, options)` requiere
contexto opaco, UUID explícito, guard `beforeExecute() === true` y plazo 1–30.000 ms.
Revalida ámbito, grants, cuenta y flags antes/después; devuelve respuesta cerrada.
Sin UUID automático, retries ni credenciales legacy. Además de la flag Ads general,
requiere conversiones, acciones y `GOOGLE_ADS_DESTINATIONS_BROKER_ENABLED=true`,
todas cerradas por defecto. El guard debe comprobar sesión/permisos sobre todas
las clínicas de la cuenta; el diario implementado aporta esa comprobación durable.

Faltan compatibilidad AWS v18 y aceptación integrada de la recuperación,
consumidor administrativo de conciliación tras revocar, bootstrap/leads/job combinado y aceptación
Google/UI autenticada antes del corte compartido. QA usa MySQL/SQLite reales,
firmas, cliente CRM, HTTP local, Chromium con componentes Angular reales y
AWS/Google/S3 ficticios con red externa bloqueada. No es aceptación operativa.
