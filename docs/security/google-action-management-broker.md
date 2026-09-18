# Acciones canónicas Google Ads por broker

Estado 18/09/2026: contrato, broker y cliente CRM preparados y probados localmente.
Sin despliegue, DDL operativa, permisos nuevos, llamadas reales a Google ni
aceptación visual autenticada. Los endpoints de creación/normalización todavía
necesitan conectar este cliente con autorización y persistencia propias del CRM.
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

## Cliente CRM y trabajo pendiente

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

Antes de conectar los endpoints debe persistirse la propiedad del plan/comando
en CRM y revalidarse la autorización del usuario para **todos los mappings activos
de la cuenta**, mediante `assertGoogleConversionMutationAccess`, alrededor de cada
operación. Un guard inyectable no sustituye esa integración. Deben mantenerse la
confirmación de mutación existente, el alcance clínico y la recuperación de
resultado desconocido en el flujo completo. Crear una acción no la registra
automáticamente como destino Data Manager: ese permiso exige tratamiento
explícito antes de declarar el onboarding listo.

También quedan enriquecimiento/bootstrap, sync tipado de leads, revisión del
job combinado, inventario completo de consumidores compartidos, preflight/DDL y
despliegue, pruebas autorizadas de proveedor y recorrido visual con login/MFA.
No reactivar históricos, campañas, leads ni jobs clínicos DEV para probar.

## Evidencia local

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
