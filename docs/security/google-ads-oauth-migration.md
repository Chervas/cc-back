# Google Ads: reautorización por broker, API y Ajustes

Preparado el 13/09/2026 sobre backend e0c1b16b y frontend b839e071. Código y
pruebas aisladas; cero conexiones reales migradas o reautorizadas. OPS aplazado.
El apagado de EC2 fue anunciado por el usuario, sin verificarlo en AWS.

## Selección y frontera de credenciales

GET /oauth/google/connect y /oauth/google/connection-status admiten
google_service=ads. Los otros valores siguen siendo business_profile,
search_console y analytics. El índice broker_services admite hasta cuatro
servicios configurados y connected:false; no concede permiso para renovar.
Cada estado y solicitud seleccionada comprueba sus propios consumidores.
Selección desconocida o sin binding falla sin entrar en OAuth legacy.

Se reutiliza google-oauth-cohorts-v1, con identidad Google, conexión SQL,
referencia de credencial y activo de control ads:customerId fijados previamente.
No hay alta libre, descubrimiento ni remapeo automático. El customer es canónico,
de diez dígitos y distinto de cero; el registro de lectura fija además el gestor.
Solo se consulta metadata de GoogleConnections y el predicado de tokens NULL;
ningún token se devuelve a la API, Ajustes o SQL.

La cohorte google-ads-read-v1 del broker admite los cinco controles
google.ads.oauth.begin.v1, finish.v1, activate.v1, status.v1 y abort.v1, con el
prefijo completo google.ads.oauth. en todos ellos. Conserva las ocho lecturas
y el control de revocación por activo; no añade operaciones de publicidad.
El payload no acepta scopes, redirect, ARN o identidad elegidos por el cliente.
La política fija subject, callback HTTPS canónico y exactamente openid, email,
profile y https://www.googleapis.com/auth/adwords como scopes solicitados.

Reutiliza el [motor OAuth](google-property-oauth-broker.md): PKCE/state, identidad
verificada, staging v3 en el secreto preasignado, CAS de la versión base y
activación/conciliación durable. Un baseline v3 sin los scopes de identidad no
ofrece refresh reutilizable y exige un refresh nuevo. Un baseline completo
permite reutilizar el refresh conocido cuando el intercambio no devuelve otro.
Los permisos recibidos pueden incluir concesiones anteriores; las operaciones
del broker siguen cerradas. Renovar no implica invalidar el token anterior.

## Consumidores, permisos y revocación

Dentro de las transacciones de autorización se leen con bloqueo registros Ads,
mappings, aliases canónicos/con guiones, IDs históricos, revocaciones, clínicas,
asignaciones Google y usos compartidos. Cada colección tiene límite de 1.000.
Todos los registros de la credencial Ads seleccionada deben coincidir en
conexión, identidad y referencia. Un mapping superviviente, incluso inactivo,
debe conservar cuenta, gestor, ámbito y par de referencias originales.

El activo de control requiere un mapping activo y un registro no revocado.
El conjunto afectado incluye todos los customers de esa credencial, propietarios
de clínica, miembros reales de grupos, anclas de tenant y asignaciones explícitas.
La clínica representativa de un mapping de grupo no define su propiedad. Ads
no tiene columna de primario en GrupoClinica; SC/GA/GBP mantienen sus controles
de primarios. Registros huérfanos disponibles conservan autoridad sobre sus
propietarios, pero no crean un uso activo desde el que iniciar la autorización.

Se comprueba la asignación Google activa y única, con herencia y overrides.
Un override desconectado/revocado o con otra identidad impide la operación.
La sesión debe seguir vigente y el usuario necesita write en todas las clínicas
del conjunto, además del ámbito solicitado. Este debe intersectar un uso activo
de Ads. Se persiste el conjunto completo y se compara después de las llamadas
al broker: una clínica nueva, pérdida de permisos o revocación durante el flujo
impide guardar la intención de activación. Las llamadas no mantienen una
transacción SQL abierta.

Ads gestionado puede coexistir con los otros tres servicios; un consumidor Ads
activo sin registro independiente bloquea también OAuth de las otras verticales.
Una incoherencia de identidad/ámbito falla de forma cerrada. Renovar SC/GA/GBP
no elimina el historial Ads. Activar credenciales invalida las lecturas y caches
en vuelo del broker y conserva los bloqueos persistentes por activo.

El worker confirma una intención ya autorizada mediante el mismo UUID y su
binding/digest, lease y auditoría. Los cambios de permisos previos se comprueban
antes de capturar esa intención; no hay una transacción distribuida con Google.
Las bajas posteriores mantienen su [control durable](google-ads-revocation-migration.md).
La confirmación OAuth conserva connected:false: no acredita acceso a cuentas
ni desbloquea recursos.

## Esquema, principales y orden del corte pendiente

20260913100000-add-ads-google-oauth-cohort.js amplía únicamente cohort en
GoogleOAuthBrokerBindings y GoogleOAuthBrokerRequests. Antes de la primera DDL
comprueba el ENUM, NOT NULL y default GBP de ambas tablas. Conserva claves,
solicitudes, digests e identidades de los otros tres servicios. No registra
cuentas, activa gates, copia secretos o altera la historia de revocaciones.

Aplicar esta DDL antes de registrar Ads y desplegar el lote que lo utilice.
Siguen siendo obligatorias las dependencias globales previas, incluidas
20260913070000, 20260913080000 y 20260913090000, aun con gates apagados cuando
el código consulta esas tablas. El down comprueba ambas tablas y rechaza
cualquier binding **o solicitud** Ads: borrar el binding original no permite
retirar su ENUM. Conserva datos de los otros servicios si Ads está vacío.
MySQL DDL multisentencia no es atómica; un fallo intermedio requiere inspección
y reparación aprobada, sin repetir ciegamente la migración. No borrar historia
ni restaurar tokens SQL para revertir código.

El principal OAuth y su clave pública son distintos de los lectores y del
control de revocación, incluso si un lector está deshabilitado. El runtime
comprueba esta separación y exige grants de operaciones/tuplas explícitos.
Cliente API: GOOGLE_ADS_BROKER_ORIGIN/AUDIENCE/CA_FILE y nuevas
GOOGLE_ADS_BROKER_OAUTH_KEY_ID/GOOGLE_ADS_BROKER_OAUTH_KEY_FILE. Archivos privados
canónicos, regulares, sin symlinks, hasta 64 KiB y sin permisos de grupo/otros.

Gates existentes GOOGLE_OAUTH_BROKER_ENABLED, GOOGLE_OAUTH_BROKER_WORKER_ENABLED
y GOOGLE_ADS_BROKER_ENABLED; no se instala configuración. El worker OAuth
existente incorpora Ads: hasta 10 intenciones/30 segundos cooperativos, lease
120 segundos. No se añade job; el catálogo sigue en 48. No activar antes del
lote aprobado de esquemas, IAM, secretos, grants y compatibilidad de consumidores.

## Auditoría, Ajustes y costes

El codec v10 admite provider=google_ads con assetRef Ads estricto; conserva
formato, clinicCount y clinicSetDigest. Las acciones authorize/activate producen
intento y confirmación, cuatro eventos en un flujo completo, con usuario/job,
sesión y correlación originales. V8 histórico y las otras verticales v10
conservan su formato. Actualizar writer y reader antes de emitir Ads v10;
confirmación SQL no demuestra entrega real a S3.

Ajustes muestra Google Ads como cuarto servicio cuando está configurado. Carga,
pendiente, actualizado, deshabilitado y error se mantienen por servicio. Un 403
explica la necesidad de permisos en todas las clínicas afectadas. Cambiar de
clínica cancela respuestas antiguas; una respuesta de otra vertical se rechaza.
El modo gestionado conserva el cierre de cargas legacy de métricas/publicidad.

No se añade infraestructura ni se calcula gasto ficticio. Las operaciones
Secrets Manager, auditoría y reintentos usan el sistema existente, con las
consideraciones de [coste del motor OAuth](google-property-oauth-broker.md).
Gasto verificado en Ajustes, Cost Explorer/tags, retención, permisos y
conciliación Budget/CloudFormation siguen pendientes con OPS aplazado.

## Validación y límites

Evidencia privada bajo /home/ubuntu/qa-evidence/security-migration-20260912,
prefijo ads-oauth. 565 tests Node correctos: 352 backend, 160 broker, 47 auditoría
y 6 frontend. Broker incluye runtime TLS real con AWS/proveedor ficticios,
PKCE, identidad, scopes, reinicio, ACK perdido y bloqueos conservados.

19 comprobaciones en un MySQL 8.0.42 propio, socket aislado, networking apagado,
sin arranque de la aplicación clínica y cierre 0. Incluyen convivencia de
cuatro servicios, grupos/aliases, permisos antes/después del callback, revocación
en vuelo, DDL con datos y down impedido solo por solicitudes Ads supervivientes.
Las otras suites SQL de fases anteriores conservan su evidencia histórica;
no se presentan como repetidas en este bloque.

Compilación Angular development completada. El primer intento agotó el heap
predeterminado; el segundo usa 6 GiB solo para ese proceso. Chromium aislado:
18 capturas desktop/móvil del componente real con respuestas ficticias, sin
errores de página, desbordamiento horizontal ni llamadas externas. Se revisaron
visualmente los estados Ads actualizado y permiso insuficiente.

Se conservan los fallos iniciales de fixtures (proyección Ads, servicio UI,
grant duplicado y metadata Sequelize) y el build inicial, junto a las pruebas
finales correctas. No hay validación real de proveedor, AWS, BD compartida o
despliegue. El hotfix de getAssetStats permanece intacto.

Pendientes del objetivo completo: alta/remapeo, consumidores restantes,
recepción, escrituras/conversiones, auditoría completa, costes y controles AWS
verificados, cifrado/restauración/corte real de BD y migración aprobada por
cohortes. Publicar este bloque no completa ni activa la migración global.
