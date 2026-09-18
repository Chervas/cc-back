# Destinos Data Manager autorizados por recibo de acciones

> **Tipo:** contrato técnico y recuperación.
> **Fuente de verdad:** registro del broker y cliente interno; no habilita API ni UI CRM.
> **Última revisión:** 2026-09-18.
> **Relacionado con:** [acciones](google-action-management-broker.md), [entrega](google-data-manager-broker.md), [backend](../../src/Documentacion/13-backend.md#autorizacion-interna-de-destinos-data-manager).

Preparado y probado con proveedores ficticios. Sin publicación AWS/API, DDL
operativa, flags habilitadas ni cohortes Google migradas. Diario humano,
confirmación HTTP/UI y aceptación integrada siguen pendientes.

## Decisión explícita y alcance

La cohorte `google-ads-conversions-v1` permite tres operaciones nuevas:

| Operación | Entrada exacta | Resultado |
| --- | --- | --- |
| `google.ads.conversion_destinations.authorize.v1` | `planId`, `targets:[{event,sources}]` | UUID de autorización, plan, estado activo y destinos derivados |
| `google.ads.conversion_destinations.status.v1` | `authorizationId` | Estado durable activo/revocado y selección original |
| `google.ads.conversion_destinations.revoke.v1` | `authorizationId` | Estado revocado del permiso propio |

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

Con respuesta perdida pero permiso durable, status o repetir el **mismo comando**
recuperan el resultado. Si falta el permiso o falló el commit, un error de status
no demuestra ausencia de authorize en vuelo. Conservar UUID y decisión original;
no crear otro para forzar el intento. Todavía no hay cancelación anticipada de
un authorize desconocido. Si falla el commit de revocación, el permiso anterior
permanece y no se declara revocado. API/UI futuras deben conservar estos estados.

No borrar tablas, cierres o recibos ni restaurar SQLite anterior. Para retirar
código tras utilizarlo, cerrar el consumidor de conversiones y conservar el estado;
un binario anterior no entiende la nueva política y debe rechazarla. No sustituir
permisos dinámicos por estáticos para eludir su retirada.

## Cliente y aceptación pendiente

`googleAdsBroker.destinations(account, context, family, input, options)` requiere
contexto opaco, UUID explícito, guard `beforeExecute() === true` y plazo 1–30.000 ms.
Revalida ámbito, grants, cuenta y flags antes/después; devuelve respuesta cerrada.
Sin UUID automático, retries ni credenciales legacy. Además de la flag Ads general,
requiere conversiones, acciones y `GOOGLE_ADS_DESTINATIONS_BROKER_ENABLED=true`,
todas cerradas por defecto. El guard debe comprobar sesión/permisos sobre todas
las clínicas de la cuenta; no sustituye el diario SQL de la decisión humana.

Faltan diario/auditoría humana, API, confirmación UI, recuperación de incertidumbre,
bootstrap/leads/job combinado y aceptación Google/UI autenticada antes del corte
compartido. QA usa SQLite real, firmas, cliente CRM, servidor TLS en loopback y
AWS/Google/S3 ficticios con red externa bloqueada. No es aceptación operativa.
