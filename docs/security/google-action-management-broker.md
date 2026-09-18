# Acciones canónicas Google Ads por broker

Estado 18/09/2026: contrato, broker, cliente, diario MySQL, API y UI CRM preparados y probados localmente.
Sin despliegue, DDL operativa, permisos nuevos, llamadas reales a Google ni
aceptación visual autenticada. La API de planes ya conecta el cliente con
autorización y persistencia CRM. Workspace y asistente comparten revisión/confirmación
explícitas; falta su aceptación autenticada con proveedor real.
No activar el corte parcial de la identidad Google compartida.

## Contrato y alcance

La cohorte `google-ads-conversions-v1` admite cuatro operaciones adicionales,
sólo con `googleAdsActionManagement.accounts` explícito en el binding y grants
para el activo exacto. La política fija eventos, monedas y permisos separados
`allowCreate`/`allowNormalize`. Las cohortes de lectura rechazan estos bindings.
Las claves de operación permanecen separadas de enrollment, OAuth y revocación,
también cuando el principal sólo tiene estas operaciones o Data Manager.

| Operación | Selección | Resultado |
|---|---|---|
| `google.ads.conversion_actions.prepare.v1` | Modo, moneda y hasta cinco eventos/IDs | Plan propio, caducidad y cambios propuestos |
| `google.ads.conversion_actions.validate.v1` | UUID del plan propio | Comprobación de cambios y `validateOnly`, sin aplicación |
| `google.ads.conversion_actions.apply.v1` | UUID del plan propio | Recibo durable con eventos e IDs aplicados |
| `google.ads.conversion_actions.status.v1` | UUID del plan propio | Estado durable y recibo, sin mutación Google |

El catálogo fijo contiene lead, contact, qualified_lead, schedule y purchase,
con los mismos nombres/categorías canónicos del CRM. No se aceptan URLs, headers,
GAQL, operaciones Google, nombres libres, tokens, contactos ni cuerpos de eventos.
Crear sólo añade acciones ausentes `UPLOAD_CLICKS`, secundarias, habilitadas,
`MANY_PER_CLICK` y con valor predeterminado cero/moneda autorizada. No modifica
acciones existentes. Normalizar sólo ajusta recuento y `primaryForGoal`, con
`updateMask` fijo; no cambia nombres, moneda, categoría, estado, campañas o metas.

El inventario fresco y paginado conserva `ownerCustomer` además del resource.
Nombre canónico duplicado, ID inesperado, propietario ajeno/desconocido, categoría
o tipo distinto impiden preparar/aplicar. Sólo se admiten estados ENABLED/HIDDEN
para acciones existentes. Se rechazan páginas repetidas, IDs duplicados y
truncamiento; máximo 5.000 filas. Sólo se persiste metadata del catálogo seleccionado.

El transporte sigue cerrado por defecto. La nueva opción privada permite sólo
POST a `/v24/customers/{cuenta}/conversionActions:mutate`, con OAuth y developer
token en AWS, cuerpo de 32 KiB y respuesta de 128 KiB como máximo. Usa
`partialFailure=false` y `RESOURCE_NAME_ONLY`, sin redirecciones ni reintentos.
El estado propio pasa por la autorización general del broker y puede requerir
resolución del secreto OAuth; no se presenta como una consulta libre de secretos.

## Intentos, concurrencia y recuperación

`google_action_plans` y `google_action_locks` viven en el SQLite del broker. El
plan caduca a los cinco minutos y pertenece al principal, su clave pública,
clínica, conexión y activo originales. Cambios de subject, secretos, cuenta/gestor
o autorización del binding no heredan el plan. Cambios ajenos de versión de
política no alteran esa propiedad.

Preparar persiste plan, respuesta del comando y auditoría en una transacción.
Aplicar adquiere bloqueos por cuenta/evento, vuelve a leer el catálogo, valida
con Google y vuelve a leer antes de la escritura. Cualquier cambio seleccionado
invalida el plan. La caducidad, revocación y propiedad de los bloqueos se
comprueban inmediatamente antes de guardar `attempted`, **antes** de llamar a
Google. El recibo aplicado y su auditoría se confirman juntos.

Un timeout, ACK perdido del proveedor o fallo del commit posterior deja
`attempted` y bloqueos durables. No se liberan por tiempo, reinicio o UUID nuevo.
El bloqueo cubre también selecciones sin cambios: ver la acción en Google no
permite fabricar un recibo aplicado con otro plan para el intento desconocido.
Un bloqueo de preparación sí puede recuperarse tras caducar su plan, porque ese
plan ya no puede llegar a escribir. Un comando concurrente del mismo plan tampoco
puede liberar los bloqueos de otro intento. La coordinación es del broker; no es
una transacción con otros operadores que modifiquen Google fuera de él.

Si el broker guardó el recibo pero se perdió la respuesta al CRM, `status`
recupera el resultado y repetir el comando exacto devuelve su acuse sin escribir.
Si el broker no guardó un recibo, un `attempted` sigue desconocido y requiere
conciliación explícita: no borrar bloqueos/planes, restaurar un SQLite antiguo ni
regenerar comandos para forzar la escritura. Un validate-only histórico tampoco
autoriza aplicar sin las comprobaciones frescas que hace `apply`.

## Cliente, diario y API CRM

`googleAdsBroker.actionManagement(account, context, family, input, options)` usa
el contexto opaco del registro Ads. Requiere UUID de comando explícito, callback
`beforeExecute` que devuelva `true` y plazo máximo de 30 segundos. Comprueba
registro, grants, cuenta/gestor y flag antes y después de la llamada. Las
respuestas admiten sólo metadata tipada, plan propio, eventos/IDs coherentes y
resultados completos; nunca devuelve detalles libres del proveedor.

Además de la flag Ads general, exige ambas
`GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED=true` y
`GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED=true`; siguen apagadas por defecto.
No genera UUID, aplica automáticamente, reintenta ni recurre a tokens locales.

`GoogleAdsActionPlans` conserva el UUID del plan, usuario, referencia de sesión,
mapping, cuenta, huella del propietario/ámbito/registro y metadatos tipados. No
guarda JWT, secretos ni datos de pacientes. `GoogleAdsActionCommands` conserva
cada UUID/familia e intento antes del transporte. El recibo y la finalización del
comando se guardan juntos; nunca hay una transacción SQL abierta durante Google.
La migración `20260918190000-create-google-ads-action-journal.js` y sus dos tablas
están fijadas en `ops/security/schema-contract.json`; **no aplicada a BD operativa**.

`POST /api/marketing/google-ads/conversion-action-plans` prepara el plan;
`POST /:planId/validate`, `/apply` y `/status` ejecutan sus operaciones explícitas.
Contrato de cuerpos y respuestas en el `13-backend.md` canónico. La API exige
sesión gestionada vigente y revalida permisos de escritura sobre **todos los
mappings activos de la cuenta**, mediante `assertGoogleConversionMutationAccess`,
antes y después. Las comprobaciones dentro de transacciones bloquean también
pertenencias y asignaciones; la pertenencia al grupo y el registro broker deben
conservarse. Una clínica en pausa bloquea prepare/validate/apply para toda la
cuenta; status sigue disponible con autorización vigente para recuperar recibos. Otro usuario, sesión o ámbito no puede adoptar un plan.

`apply` exige `confirm_external_mutation=true`. Solo se persiste un UUID de
aplicación por plan. Una petición repetida devuelve el estado guardado; no vuelve
a despacharse, tampoco tras reinicio. Las respuestas antiguas de estado no
retroceden un recibo ya aplicado. Si se pierde el ACK, un nuevo comando **status
del mismo plan** puede recuperar el recibo del broker. Si no lo hay, se conserva
el intento desconocido; no hay lease que habilite repetir la mutación, worker,
reintento automático ni nuevo UUID de apply. Caducar la sesión no transfiere su
propiedad: la conciliación operativa de ese caso requiere un procedimiento
explícito aún pendiente, no editar/eliminar el diario.

Las rutas antiguas `ensure` y normalización rechazan cuentas gestionadas; el
resolutor del nuevo flujo rechaza cuentas legacy antes de leer sus credenciales.
El diario no escribe `IntakeConfig`, no encola conciliación ni declara readiness.
Crear una acción no la registra
automáticamente como destino Data Manager: ese permiso exige tratamiento
explícito antes de declarar el onboarding listo.

Quedan la aceptación autenticada, captura general de actividad de este flujo,
conciliación tras expirar sesión o preparación no recuperable, enriquecimiento/bootstrap,
sync tipado de leads, revisión del
job combinado, inventario completo de consumidores compartidos, preflight/DDL y
despliegue, pruebas autorizadas de proveedor y recorrido visual con login/MFA.
No reactivar históricos, campañas, leads ni jobs clínicos DEV para probar.

## Evidencia local

Diario CRM: MySQL 8.0.42 aislado, broker firmado con SQLite y HTTP Express real
por loopback, AWS/Google y prueba de sesión ficticios. **12 escenarios**: propiedad
usuario/sesión/ámbito y reinicio; ACK perdido; seis preparaciones y seis aplicaciones
concurrentes; revocación de permiso SQL de otra clínica/sesión/flags; recuperación
de prepare y caducidad; resultado proveedor desconocido; permiso retirado tras
mutar; fallo del commit SQL del recibo; API cerrada/confirmación/no-store; rechazo
legacy antes de credenciales; pausa de otra clínica sin bloquear la recuperación
de recibos; migración repetible y rollback que preserva historia.
Contrato de esquema contrastado con metadata del MySQL del test. Evidencia privada
`google-action-journal-20260918/` y `google-action-ui-20260918/`. UI Angular real y
HttpClient con respuestas HTTP ficticias: 25 comprobaciones/18 capturas a 1440/390 px;
pérdida de respuesta, reload, permisos retirados, caducidad, normalización, doble
clic y almacenamiento no disponible. Build completo DEV correcto; 12 pruebas de
modelo y método real del asistente y 35 regresiones backend. No son proveedor real
ni sesión pública/MFA; no sumar estos lotes solapados como casos únicos.

Suite completa del broker: 584/584 Node24, incluido cliente real CRM contra broker
firmado/SQLite. Tras exigir tipos string para propietario/resource, lote focalizado: 28/28. Incluye transporte HTTPS
real local, reinicio, pérdida de respuesta, concurrencia, caducidad, revocación,
deriva del catálogo, ACK malformado y fallo de auditoría. Regresión CRM Node18:
60/60, incluidos cliente nuevo, Data Manager, scope, lector y onboarding.
Estos lotes se solapan: no sumar sus cifras como pruebas únicas. Proveedores
AWS/Google ficticios, guardias de red offline y ningún envío real; sin UI autenticada.
Fallos iniciales de dos fixtures y sus correcciones conservados en evidencia.
La revisión reprodujo y corrigió un caso de plan sin cambios que podía eludir
el bloqueo de un intento desconocido. Reproducción anterior al arreglo conservada
en evidencia
privada `google-action-management/`.

Referencias oficiales revisadas el 18/09/2026:
[petición mutate v24](https://developers.google.com/google-ads/api/reference/rpc/v24/MutateConversionActionsRequest),
[respuesta mutate v24](https://developers.google.com/google-ads/api/reference/rpc/v24/MutateConversionActionsResponse),
[campos y propietario](https://developers.google.com/google-ads/api/fields/v24/conversion_action).
Una acción secundaria puede seguir interviniendo en pujas a través de metas
personalizadas; este cambio no modifica esas metas ni garantiza ausencia de ese uso.
