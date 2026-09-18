# Destinos Data Manager autorizados por recibo de acciones

> **Tipo:** contrato técnico y recuperación.
> **Fuente de verdad:** registro del broker, diario humano y contrato CRM preparados; no activados.
> **Última revisión:** 2026-09-18.
> **Relacionado con:** [acciones](google-action-management-broker.md), [entrega](google-data-manager-broker.md), [backend](../../src/Documentacion/13-backend.md#autorizacion-interna-de-destinos-data-manager).

Preparado y probado con proveedores ficticios. Sin publicación AWS/API, DDL
operativa, flags habilitadas ni cohortes Google migradas. Diario humano, API,
confirmación UI y auditoría v18 preparados y probados; compatibilidad AWS v18,
recuperación sin referencia local y aceptación integrada/autenticada pendientes.

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
Con el destino revocado tampoco se consulta su recibo Data Manager: la
conciliación administrativa de ese caso sigue pendiente.

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
| `/:authorizationId/status` | Ninguno |
| `/:authorizationId/revoke` | `input:{planId,targets}` original, siempre obligatorio en CRM |

Exactamente un `clinic_id` o `group_id`; cuerpos cerrados, sin query ni IDs de
acciones arbitrarios. Rate limit de destinos: 30/minuto; usa el mismo valor que planes, con clave propia. Respuesta
`success,authorizationId,planId,commandId,commandState,outcomeUnknown,canRevoke,authorization`;
authorization es null o el recibo tipado del broker. 202 conserva intento incierto;
200 por sí solo tampoco implica permiso activo: interpretar estado/outcome.
Todas las respuestas son `private, no-store`; errores saneados, sin tokens.

El diálogo de acciones aplicadas ofrece **Revisar permiso de envío**. Se eligen
explícitamente hitos y WEB/OTHER; abrir, Finalizar o recuperar el plan no autoriza.
Antes de enviar se conserva UUID, ámbito, selección y IDs esperados en
`sessionStorage`; si no puede guardarlos, no envía la petición. Recargar consulta
una vez; no vuelve a autorizar, aplicar ni hacer polling. Workspace y asistente
permiten reabrir la referencia guardada. La retirada confirmada puede cerrar esa
referencia local, conservando ambos diarios.

**Límite pendiente:** no hay listado/recuperación de permisos entre navegadores
sin la referencia original. No activar cohortes hasta completar esa recuperación
y su aceptación. El servidor permite recuperar con referencia y sesión nueva del
mismo usuario/ámbito; no admite adopción por otro usuario ni otra selección.

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

El visor proyecta el recibo después de verificar su versión S3 exacta y distingue
permiso confirmado, permiso retirado y resultado inicial incierto. v18 está
preparado en lector/escritor, pero AWS sigue en v17: publicar compatibilidad antes
de activar captura. Usa el outbox, bucket S3 y servicios existentes, sin otro
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

Faltan recuperación sin referencia de navegador, compatibilidad AWS v18,
conciliación de entregas tras revocar, bootstrap/leads/job combinado y aceptación
Google/UI autenticada antes del corte compartido. QA usa MySQL/SQLite reales,
firmas, cliente CRM, HTTP local, Chromium con componentes Angular reales y
AWS/Google/S3 ficticios con red externa bloqueada. No es aceptación operativa.
