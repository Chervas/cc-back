# Acciones canónicas Google Ads por broker

Estado 18/09/2026: contrato, broker, cliente, diario MySQL, API y UI CRM preparados y probados localmente.
Sin despliegue, DDL operativa, permisos nuevos, llamadas reales a Google ni
aceptación visual autenticada. La API de planes ya conecta el cliente con
autorización y persistencia CRM. Workspace y asistente comparten revisión/confirmación
explícitas; falta su aceptación autenticada con proveedor real.
No activar el corte parcial de la identidad Google compartida.

La autorización posterior de destinos Data Manager tiene [contrato propio](google-destinations-broker.md):
broker, diario humano/API/UI y cliente preparados, con decisión explícita sobre
recibos applied. No se ejecuta al crear/aplicar/consultar un plan. Compatibilidad
AWS v18, recuperación sin referencia local y aceptación operativa aún pendientes.

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
caducidad original, ámbito/huella capturados, cierre durable, mapping, cuenta y
metadatos tipados. No
guarda JWT, secretos ni datos de pacientes. `GoogleAdsActionCommands` conserva
cada UUID/familia e intento antes del transporte. La admisión y su evento, y luego el recibo/finalización y su evento, se guardan
en sendas transacciones; nunca hay una transacción SQL abierta durante Google.
Las migraciones `20260918190000-create-google-ads-action-journal.js` y
`20260918203000-google-action-recovery-ownership.js`, y sus dos tablas, están fijadas en `ops/security/schema-contract.json`; **no aplicada a BD operativa**.

`POST /api/marketing/google-ads/conversion-action-plans` prepara el plan;
`POST /:planId/validate`, `/apply` y `/status` ejecutan sus operaciones explícitas.
`POST /:planId/cancel` cierra exclusivamente una preparación sin aplicación,
conservando su selección original, incluso si todavía no se admitió prepare.
Contrato de cuerpos y respuestas en el `13-backend.md` canónico. La API exige
sesión gestionada vigente y revalida permisos de escritura sobre **todos los
mappings activos de la cuenta**, mediante `assertGoogleConversionMutationAccess`,
antes y después. Las comprobaciones dentro de transacciones bloquean también
pertenencias y asignaciones; la pertenencia al grupo y el registro broker deben
conservarse. Una clínica en pausa bloquea prepare/validate/apply para toda la
cuenta; status/cancel siguen disponibles con autorización vigente. Una sesión
nueva del mismo usuario puede consultar/cerrar bajo el mismo ámbito y huella de
grants/registro. No hereda apply/validate. Otro usuario no adopta un plan.

`apply` exige `confirm_external_mutation=true`. Solo se persiste un UUID de
aplicación por plan. Una petición repetida devuelve el estado guardado; no vuelve
a despacharse, tampoco tras reinicio. Las respuestas antiguas de estado no
retroceden un recibo ya aplicado. Si se pierde el ACK, un nuevo comando **status
del mismo plan** puede recuperar el recibo del broker. Si no lo hay, se conserva
el intento desconocido; no hay lease que habilite repetir la mutación, worker,
reintento automático ni nuevo UUID de apply. Cancelar una preparación persiste
su cierre antes de habilitar una sustituta; una respuesta tardía no lo revierte.
El cierre de un plan aún no admitido actúa como tombstone y no toca Google.
No cancela ni libera una mutación intentada/aplicada. Consultar un cierre es local.
Las filas antiguas sin ámbito/huella/caducidad originales fallan cerradas; no se
rellenan a partir de permisos actuales. Cambio de propietario/ámbito, referencia
perdida o resultado Google incierto siguen requiriendo conciliación explícita.

### Registro de actividad y compatibilidad

`integration.google_ads.action_plan` v17 registra cada comando admitido y su
terminación en el outbox SQL, dentro de la transacción del diario. Salud acotada:
menos de 10000 pendientes y antigüedad inferior a una hora; sin consulta de
intentos no resueltos en esta vía. Captura previa fallida implica cero transporte;
fallo de captura posterior deja el intento recuperable por estado. No hay
transacción MySQL abierta durante AWS/Google.

La recuperación por status completa también la auditoría del prepare/apply
original: `result_recovered`, UUID de consulta y sesiones original/actual. El
cierre de una consulta en vuelo registra `command_cancelled`, resultado unknown;
no inventa éxito de esa lectura. `preparation_cancelled` acredita solo cierre
local y `closure_observed` su consulta. Selección y conjunto clínico se representan
por conteos/huellas; no se guardan tokens, JWT ni contenido clínico.

El visor filtra la acción y proyecta plan, comando, consulta/cierre relacionado,
cuenta, familia, estado y ambas sesiones solo tras verificar versión y bytes S3.
Preparación verificada, cambios confirmados y resultado incierto son distintos.
Lector/escritor deben admitir v17 antes de activar este consumidor. La
compatibilidad AWS está publicada y el transporte de dos eventos de QA fue
verificado por recibo firmado y versión/bytes/KMS S3. No publica la captura/API/UI
del consumidor ni sustituye su aceptación autenticada; estado y corte en 19/99.
Las flags siguen apagadas.

**Rollback:** después de usar cancelación, el consumidor antiguo no conoce
`closed_at`. Apagar gestión de acciones antes de revertir a ese código, o conservar
una versión compatible. No eliminar diarios ni cierres. La migración down se
niega con planes existentes; el rollback de UI no revoca una aplicación ya hecha.

Las rutas antiguas `ensure` y normalización rechazan cuentas gestionadas; el
resolutor del nuevo flujo rechaza cuentas legacy antes de leer sus credenciales.
El diario no escribe `IntakeConfig`, no encola conciliación ni declara readiness.
Crear una acción no la registra
automáticamente como destino Data Manager: ese permiso exige tratamiento
explícito antes de declarar el onboarding listo.

Quedan la aceptación autenticada y entrega integrada del consumidor, conciliación
administrativa de casos sin identidad/recibo verificables, enriquecimiento/bootstrap,
sync tipado de leads, revisión del
job combinado, inventario completo de consumidores compartidos, preflight/DDL y
despliegue, pruebas autorizadas de proveedor y recorrido visual con login/MFA.
No reactivar históricos, campañas, leads ni jobs clínicos DEV para probar.

## Evidencia local

Diario CRM: MySQL 8.0.42 aislado, broker firmado con SQLite y HTTP Express real
por loopback, AWS/Google y prueba de sesión ficticios. **16 escenarios**: propiedad
usuario/sesión/ámbito y reinicio; ACK perdido; seis preparaciones y seis aplicaciones
concurrentes; revocación de permiso SQL de otra clínica/sesión/flags; recuperación
de prepare y caducidad; resultado proveedor desconocido; permiso retirado tras
mutar; fallo del commit SQL del recibo; API cerrada/confirmación/no-store; rechazo
legacy antes de credenciales; pausa de otra clínica sin bloquear recuperación/cierre;
sesión renovada sin permiso heredado de aplicación; cierre previo a preparación
y carrera con ACK tardío; fallo transaccional de auditoría y fila legacy incompleta;
migración repetible y rollback que preserva historia.
Contrato de esquema contrastado con metadata del MySQL del test. Evidencia privada
`google-action-recovery-20260918/`. UI Angular real/HttpClient con respuestas HTTP
ficticias: **35 comprobaciones/24 capturas** a 1440/390 px, incluidas sesión nueva,
cancelación previa a reemplazo y cierre sin ACK de preparación. El desbordamiento
móvil detectado se corrigió con contenido desplazable y botones accesibles.
Visor: **8 capturas**, acción nueva, correlación y estados diferenciados.
**75 pruebas** del servicio de auditoría y **11 escenarios** del visor con MySQL,
versión S3 ficticia y HTTP real local; **47 regresiones backend** y **19 frontend**.
Build completo DEV correcto. No son proveedor real ni sesión pública/MFA; no
sumar lotes solapados como casos únicos. Historial anterior en bitácora.

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
