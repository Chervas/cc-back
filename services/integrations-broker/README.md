# Broker de integraciones

## 18/09/2026 — Contrato de conversiones Google Data Manager

Validación ficticia, ingesta individual y estado ligado a recibo durable preparados
en la cohorte explícita `google-ads-conversions-v1`. Conserva consentimiento,
alcance y revocación; un resultado desconocido no se reenvía automáticamente.
Pruebas offline con HTTPS/SQLite reales. Consumidores CRM, despliegue AWS,
proveedor y aceptación UI autenticada todavía pendientes.
[Contrato, límites y recuperación](../../docs/security/google-data-manager-broker.md).

La reserva SQL y el coordinador CRM conservan el UUID aun con ACK perdido o fallo
de commit. Consulta de estado devuelve el recibo original dentro del mismo scope.
El emisor común y el resolutor por mapping ya seleccionan el broker sin tokens
locales: 29 comprobaciones MySQL aisladas y 27 de cliente/scope/constructor pasan.
La última regresión del motor broker, que no cambia aquí, sigue en556. Mandatos
workspace v2, hitos nativos, diagnóstico y preparación aún necesitan adaptadores;
sin DDL operativa, despliegue ni aceptación UI real de este conjunto.

## 13/09/2026 — Alta WhatsApp durable en el broker

Cohorte privada `whatsapp-onboarding-v1`: begin/finish/status/abort firmados,
canje único, candidata en Secrets Manager y conciliación por versión/hash.
Baja de control con bloqueos de grupo/clínicas independientes y auditoría atómica.
No exige MetaConnection general; rechaza grants de Ads/leads. No activa el canal.
Runtime preparado, sin instalación ni gateway/UI conectados. Configuración y
permisos reales Meta/AWS pendientes; cuarentena conservada.
[Contrato, recuperación y lote pendiente](../../docs/security/whatsapp-onboarding-broker.md).

## 13/09/2026 — Transporte privado del alta WhatsApp

Canje con aplicación/URI fijadas, token prestado solo dentro del broker y
resultado de metadata; prueba de pertenencia WABA/número con edge/cursor fijos.
294 pruebas broker pasan, 31 nuevas; 46 afectadas repetidas tras refuerzo final.
Sin operación de alta registrada, Secrets Manager candidato o rutas integradas.
No se ha abierto Meta. [Contrato y próximos pasos](../../docs/security/whatsapp-oauth-transport.md).

## 13/09/2026 — Inspección de credenciales WhatsApp

Antes de usar un secreto, el runtime verifica respuesta Meta de identidad,
scopes exactos, único WABA y expiraciones. Sin fallback ni uso de diagnóstico
aportado por navegador. 263 pruebas broker pasan, 80 WhatsApp, con ficticios.
Campos/granularidad y cuota reales por verificar; no se abre Meta ni se implementa
todavía el alta. [Contrato y límites](../../docs/security/whatsapp-broker-messaging.md).

## 13/09/2026 — Motor WhatsApp y cliente staging

Preparada cohorte `whatsapp-messaging-v1`: texto y plantillas textuales registradas,
secretos de envío/consulta separados y fijados, bloqueo local y recibo durable.
Una respuesta perdida no autoriza repetir el POST. Runtime independiente
`src/whatsapp-main.js`; no instalar configuración ni iniciar acceso real con este
corte. El cliente excluye DEV/gateway, pero faltan barreras efectivas del entorno.

QA: 232 broker + 59 backend, con AWS/Meta ficticios. Sin nueva DDL ni UI.
No conectado aún a registro, `whatsapp.service.js`, workers o recepción pública;
cuarentena conservada, cero credenciales migradas/despliegues. OPS puede estar off.
[Contrato, límites, coste y siguiente corte](../../docs/security/whatsapp-broker-messaging.md).

## 13/09/2026 — Fundamento de altas Ads y prioridad Meta/doble factor

Preparados ámbito/solicitudes independientes, autorización del conjunto original
y cliente interno de altas Ads. La barrera de credenciales Google consulta ambos
registros por ID/sujeto, incluso si desaparecen las asignaciones. Cancelación en
el broker antes de preparar, durable y sin secretos; una cuenta no verificada
no queda reservada ni revocada para otra clínica.

DDL `20260913120000` obligatoria antes del código **aunque el gate esté apagado**;
pendiente en BD compartida. QA: 574 tests Node (391 backend, 183 broker), 141 checks
en nueve MySQL propios, cierre 0 en todos. Sin cambios de UI, runtime ni OPS.
Faltan escritor, conciliador, conexión con bajas/API/Ajustes y auditoría humana.

Por indicación del usuario, se cierra este fundamento ya probado y se prioriza
una primera etapa de protecciones Meta y doble factor. El alta general Ads se
aplaza; ni esta entrega ni las pruebas ficticias acreditan esa etapa terminada.

[Contrato, dependencias y límites](../../docs/security/google-ads-enrollment-application.md).
[Objetivo de la primera etapa y entregas](../../docs/security/incremental-delivery-plan.md).

## 13/09/2026 — Alta de cuentas Ads: motor del broker preparado

El broker incorpora discover/prepare/activate/status sobre un ámbito explícito
independiente de las cuentas existentes. Preparación durable sin lecturas de
campañas; activación y recibo/auditoría atómicos. Consulta MCC fija, claves de
alta/lectura/baja/OAuth separadas, límites, historial de revocación y revalidación
bajo el lock de SQLite. Una baja prevalece sobre recibos anteriores y peticiones
en vuelo; retirar una cuenta no retira el ámbito de alta.

QA: 178 tests del broker, incluidos 15 nuevos, todos correctos; HTTPS local,
SQLite privados, reinicio, auditoría y proveedores/SDK ficticios. No se ha cargado
la BD clínica. Tabla e índice nuevos solo en el store SQLite del broker; no hay
nueva migración compartida, variables, jobs ni cambios de interfaz. Configuración
real intacta, OPS aplazado y cero cuentas reales incorporadas o despliegues.

Falta conectar este motor con la API/Ajustes: ámbito e intención persistentes,
permisos sobre el conjunto original y usos compartidos/primarios, conciliación de
activación y auditoría humana. El alta general y la primera identidad Google aún
no están completas. Siguen pendientes cambios de propietario, otros consumidores,
auditoría completa, costes/controles AWS y cifrado/corte BD.

[Contrato, límites y siguiente integración](../../docs/security/google-ads-enrollment-migration.md).

## 13/09/2026 — Resumen de cuentas Ads registradas

Novena lectura google.ads.discovery.read.v1, payload vacío y grant explícito por
cuenta/tenant/conexión. Resumen cerrado de cuenta, nombre, manager, moneda, zona
y estado; exactamente una fila, sin página siguiente ni jerarquía libre.
Auditoría técnica v2 conserva solo metadata de operación. 163 tests del broker
correctos; TLS Ads repetido con discovery y comprobación de entrega ficticia.
[API, permisos, costes y corte pendiente](../../docs/security/google-ads-discovery-migration.md).

## 13/09/2026 — OAuth Google Ads preparado

La cohorte Ads admite cinco operaciones google.ads.oauth.*.v1 con principal/clave
OAuth independientes, scopes fijados, PKCE, secreto v3, CAS y conciliación durable.
Conserva las ocho lecturas y revocación por activo; renovar invalida lecturas en
vuelo sin borrar bloqueos. API, permisos de grupos/compartidos y Ajustes preparados.
160 tests del broker correctos, incluidos TLS runtime y proveedores ficticios.
Sin configuración instalada, AWS ni conexión real. [Contrato, DDL y corte pendiente](../../docs/security/google-ads-oauth-migration.md).

## 13/09/2026 — Lecturas de sincronización Ads y colectores tipados

El broker incorpora cuatro lecturas más: estados de publicación, destinos,
inventario de anuncios y métricas diarias. Los colectores aceptan llamadas tipadas;
el lector descarta respuestas incompletas, cambios de recursos y revocaciones
concurrentes. QA: 193 tests (145 broker y 48 backend), HTTPS local, ambos
colectores y 100.001 anuncios ficticios paginados sin pérdida de filas. Sin DDL, UI, AWS/proveedor real, configuración instalada o despliegue.

Registro persistente, autorización clínica/grupo/compartidos y baja Ads todavía
pendientes; sync/backfill aún no inyecta el lector. Cero cuentas migradas.
OPS aplazado; continúan los pendientes de otras cohortes, auditoría completa,
IAM/retención/costes/Budget y cifrado/corte BD.

[Contrato y dependencias](../../docs/security/google-ads-read-broker.md).

## 13/09/2026 — Motor de lecturas Google Ads preparado en el broker

Cuatro lecturas Ads tipadas fijan cuenta/gestor, GAQL y campos; OAuth y developer
token permanecen en el broker. Paginación acotada en memoria y control de baja
con principal/clave separados. QA: 138 tests del broker, incluidos 15 nuevos Ads,
HTTPS local, 10.001 filas ficticias y bloqueo tras reinicio. Sin DDL, UI,
configuración instalada, AWS/proveedores reales o despliegue. Cero cuentas Ads
migradas: registro/adaptador backend, OAuth Ads, otros consumidores y corte real
siguen pendientes. OPS aplazado; IAM/retención/costes/Budget/BD pendientes.

[Contrato, QA y dependencias](../../docs/security/google-ads-read-broker.md).

## 13/09/2026 — Motor OAuth SC/GA preparado en el broker

El broker prepara begin/finish/activate/status/abort OAuth separados para SC y
GA, con identidad y propiedad fijadas, permisos readonly por vertical y tercer
principal/clave independiente. V3 previo incompleto exige nuevo refresh; staging,
activación y conciliación sobreviven a ACK perdido/reinicio. Nuevas credenciales
conservan bloqueos y descartan respuestas de la versión anterior.

QA ficticia: 255 tests Node (123 broker, 132 backend), incluidos los flujos GBP,
SC y GA por HTTPS local. Hotfix conservado. Sin nueva DDL/QA MySQL/UI, despliegue,
configuración instalada, cambios de pausas ni llamadas AWS/proveedor reales.
OPS aplazado; apagado EC2 anunciado sin verificar.

API/UI de reautorización aún GBP: faltan selección por cohorte y autorización
sobre todos sus consumidores, intenciones SQL/captura humana, callback/estado e
interfaz SC/GA. La baja durable del bloque anterior permanece preparada. No
activar por tener el motor interno. Otras cohortes, auditoría completa,
retención/IAM/Cost Explorer/Budget y cifrado/restauración/corte BD siguen pendientes.

[Contrato](../../docs/security/google-property-oauth-broker.md).

## 13/09/2026 — Controles de revocación SC/GA preparados en el broker

google.search_console.asset.revoke.v1 y google.analytics.asset.revoke.v1 aceptan
payload vacío y grant exacto; reutilizan control revoke_asset, SQLite y auditoría
v2. REVOKE_OPERATION queda fuera de OPERATIONS de lectura. El arranque exige
principal y clave distintos de todos los lectores. Sin consultas de secretos ni
llamadas de proveedor por el control. Bloqueos/replay persisten tras reinicio;
los lectores conservan checks después de awaits. La API/cola de desconexión
SC/GA todavía debe conectarse; no activar el flujo parcial.
[Contrato, pruebas y pendientes](../../docs/security/google-property-revocation-control.md).

## Consumidores SC/GA compartidos preparados

SC usa ahora registros SQL compuestos por site_hash/mapping_id y conserva cada
grant de clínica. Discovery admite el inventario compartido/primario vigente
del mismo grupo y mantiene tenant del origen. No añade operaciones al broker,
scopes, claves o recursos. La nueva DDL 20260913050000 pertenece al lote API/BD
aprobado; no da acceso SQL al broker ni se ejecuta sobre BD compartida.
[Contrato, QA y pendientes](../../docs/security/google-shared-property-migration.md).

## Discovery SC/GA registrado preparado, sin activar

Se añaden google.search_console.discovery.read.v1 y
google.analytics.discovery.read.v1 a sus cohortes de lectura existentes.
GET fijo a Sites.get o Properties.get, payload vacío y grants explícitos;
metadata proyectada y sin persistir datasets. GA Admin exige analytics.readonly
en secreto y scopes del access token cacheado; no admite enumerar cuentas.
No se amplían permisos instalados ni se modifica infraestructura.
[Contrato, límites, QA y lote pendiente](../../docs/security/google-property-discovery-migration.md).

Los apartados de lecturas previas siguientes conservan las cifras de sus cortes;
el contrato nuevo amplía discovery sin completar onboarding/OAuth/UI ni activar
ninguna cohorte. OPS continúa aplazado; apagado EC2 no verificado.

## GA4: nueve lecturas preparadas, sin activar

`google-main.js` admite google-analytics-read-v1 con subject, propiedades y grants
exactos. Nueve familias fijas runReport, secreto v3 google_analytics, refresh
confinado y cursor ligado a cardinalidad/metadata. Páginas de 500, techo local
100.000 por familia explícito; no persiste datasets en SQLite/S3. Adaptador de
jobs revalida registro compuesto por mapping, incluidas propiedades de varias
clínicas; metadata de calidad en el reporte operativo. No Admin API, discovery,
OAuth de autorización o mutaciones GA. Auditoría v2 y bloqueo durable comunes.

DDL 20260913040000 y dependencias antes del código aun con gates apagados.
QA backend con Node 22.17.0 y broker con Node 24.21.0; no se modifica el runtime
de procesos usados. No despliegue/AWS, OPS aplazado y apagado EC2 no verificado.
[Contrato, límites, coste, QA y lote pendiente](../../docs/security/google-analytics-read-migration.md).

## Search Console: cuatro lecturas preparadas, sin activar

`google-main.js` admite una configuración distinta con cohort
`google-search-console-read-v1`, proveedor `google_search_console`, subject y
propiedades exactas. Solo timeseries/queries/pages/inspection; secreto v3 fijado
a subject/client ID/scopes. Refresh dentro del broker, sin alta/reautorización,
mutaciones o proxy. Cursor queries opaco, páginas de 500, techo 25.000 por
intervalo y resultados no persistidos. Reutiliza auditoría v2 y bloqueo durable.

API/rutas/jobs usan referencias y el registro SQL independiente; gates apagados,
esquema `20260913030000` previo al código aun deshabilitado. Claves/audiences/
estado de procesos separados requieren revisión en el corte. 65 tests broker
y 61 backend, 31 checks SQL propios y tres contratos. No AWS ni despliegue;
OPS aplazado, apagado EC2 anunciado sin verificar. `npm start` sigue ficticio.
[Contrato, configuración, coste y lote pendiente](../../docs/security/google-search-console-read-migration.md).

## Google OAuth fijado: preparación, sin activar

El runtime Google admite cinco controles cerrados de reautorización de una
identidad/secreto/activo revisados, con un tercer principal distinto de lectores
y revocadores. No basta con desplegar el binario: requiere política `oauth`,
grants exactos y permisos AWS adicionales aún no verificados ni autorizados.
La API usa cola SQL y sesión gestionada; nunca obtiene tokens. No hay alta de
cuentas nuevas, recurso AWS nuevo ni reactivación de bloqueos. Ledger SQLite
conserva estados `staging/activating` y lápidas; no hacer rollback a un broker
que ignore la barrera de activación. Pruebas ficticias con TLS/SDK dobles.
[Contrato, esquema v3, IAM, costes, recuperación y corte](../../docs/security/google-oauth-broker-migration.md).


## 13/09/2026 — Revocación durable por activo preparada

Operación `google.business_profile.asset.revoke.v1`, payload `{}`, principal y
clave distintos de lectores, grant exacto. SQLite conserva bloqueo, auditoría
y resultado idempotente juntos; los lectores verifican el bloqueo antes/después
de esperar y tras reinicios. No consulta secretos ni invalida tokens en Google.
API mantiene cola SQL y 202 pendiente. `npm start` sigue ficticio; gates apagados,
ningún despliegue/AWS. [Contrato y corte](../../docs/security/google-business-profile-revocation-migration.md).

## 13/09/2026: lecturas GBP preparadas, sin activar

`google-main.js` incorpora un arranque explícito con siete operaciones cerradas
de Perfil de Empresa, Secrets Manager/renovación, IMDSv2/STS y writer separado
por rol. Dos jobs backend usan referencias para ubicaciones gestionadas; una
tabla independiente impide fallback al borrar/recrear el mapping. Sin AWS,
OAuth real ni despliegue. [Contrato, pruebas y lote pendiente](../../docs/security/google-business-profile-read-migration.md).
La séptima operación, `discovery.read.v1`, obtiene solo cuenta/ficha exactas
del grant para el listado OAuth, con proyección cerrada y dos GET fijos.
[Contrato del listado y su cierre global de legacy](../../docs/security/google-business-profile-discovery-migration.md).
OPS aplazado; apagado EC2 anunciado por el usuario y aún no verificado.
`npm start` mantiene su entrada ficticia. Las secciones siguientes describen
el núcleo común; la configuración Google se especifica en el contrato enlazado.

Paquete autocontenido con Node 24, dependencias y lockfile propios. No importa
el bootstrap, modelos, `.env` ni credenciales de la API clínica. No hay servicio
desplegado: `main.js` solo admite conexiones ficticias y escucha en loopback
por defecto. Instalar Node 24 en un destino usado requiere el lote de despliegue;
la versión Node del destino se verificará en ese lote, sin inferirla del shell de QA.

## Contrato implementado

`POST /v1/execute` sobre TLS, JSON máximo 32 KiB. Sin redirecciones, compresión,
rutas dinámicas ni proxy genérico. El cuerpo firmado contiene `version=1`,
`audience`, `requestId` UUIDv4, `nonce` UUIDv4, `issuedAt` en milisegundos UTC,
`operation`, `connectionRef`, `assetRef`, `tenantRef` y `payload`.

Identidad de servicio Ed25519 con clave pública aprovisionada en la política
del broker. No acepta el JWT de usuario de la aplicación como identidad.
Cabeceras `x-broker-key-id` y `x-broker-signature` (base64url). Firma exacta:

```text
clinicaclick-broker-v1\nPOST\n/v1/execute\n<sha256 hexadecimal del cuerpo HTTP>
```

Cada principal tiene grants exactos por clínica, conexión, activo y operaciones.
No se admiten comodines. La política local incluye versión para auditoría;
el consumidor no puede editarla por API. Un backend comprometido conserva la
capacidad de invocar los grants asignados: esta separación no elimina ese riesgo.

Catálogo actual: `fictitious.connection.check.v1`, payload `{}`, devuelve
`{fixture:true,status:"available"}`. No acredita salud de Meta, Google ni WhatsApp.
Los catálogos Google se registran solo en `google-main.js`, según su cohorte:
siete lecturas GBP (más controles aprobados por política), cuatro SC o nueve GA4.
Su migración operativa y el resto de consumidores permanecen pendientes.

`src/lib/integrationsBrokerClient.js` del backend implementa el transporte HTTPS
firmado, verifica el certificado, sanea errores y no contiene recuperación de
secretos ni reintentos automáticos. Los dos jobs GBP están conectados en código,
con gate apagado. Sus llamadas conservan el mismo requestId al conciliar;
GBP no persiste contenido de respuesta y devuelve outcome_unknown al repetirlo.

## Estado y auditoría

SQLite local privado, WAL, `synchronous=FULL`, transacciones para reservar
comandos y auditoría conjuntamente. Guarda referencias, bloqueos, nonces,
cuota por principal, resultados permitidos e identificadores de entrega.
No guarda tokens. El EBS cifrado está reportado y debe verificarse en AWS.

La carga de configuración nunca sustituye un bloqueo/revocación persistido.
El bloqueo se comprueba antes y después de obtener el secreto y llamar al
proveedor. Los comandos ya despachados pueden tener un resultado incierto;
cancelar el transporte no deshace una escritura remota. Un comando iniciado
sin finalización se conserva como pendiente de conciliación, sin repetición.

Outbox con eventId, instante UTC, actor de servicio, scope, recurso, resultado,
motivo categorizado, correlación y versión de política. La versión 2 añade
conexión/operación autorizadas; sigue aceptando v1 histórico. Sin payload ni mensajes
de error del proveedor. Un ID arbitrario de un scope denegado no se registra.
No hay instrumentación todavía de accesos de usuarios a toda la plataforma.

El emisor S3 usa objeto único `app/integrations/v2/fecha/eventId-sha256.json`
(histórico v1 conserva `app/v1/`), SSE-KMS con ARN
exacto, checksum SHA-256 e `IfNoneMatch=*`. No lee ni borra objetos. Deshabilita
Bucket Keys **en esa petición**, sin modificar la configuración del bucket;
su efecto sobre permisos/costes se verificará con la prueba ficticia aprobada.
Exige versión, checksum y cifrado/KMS en ACK. Respuesta perdida/412 conserva entrega
inconfirmada: un reader independiente tendrá que conciliarla, no se supone éxito.
Los workers usan leases persistentes y reintentos con backoff. El arranque
ficticio no programa drenado ni crea credenciales de entrega; el entry point
Google programa un drain serial con writer explícito.

La cola alcanza un máximo de admisión configurado; el broker falla cerrado
antes de nuevas operaciones al agotarlo. No se borra auditoría para liberar
espacio. Esta política no se aplica automáticamente a la atención clínica.
No implementa eliminación ni decide seis meses/183 días/Governance por el DPD.

## Secrets Manager

Adaptador AWS con cliente inyectado: valida cuenta/prefijo, ARN y KMS de metadata,
versión `AWSCURRENT`, proveedor y conexión. JSON de secreto v1 con exactamente
`version`, `connectionRef`, `provider`, `accessToken`. No convierte el secreto
ficticio aprovisionado por AWS en un token operativo ni lee su valor en QA.

Sin caché de credenciales; usa un buffer durante la operación y lo limpia.
El SDK/JSON y las llamadas de proveedor pueden mantener copias temporales en
memoria administrada: no se promete borrado criptográfico de todas ellas.
El cifrado en reposo corresponde a Secrets Manager/KMS; la segunda KMS payload
está reportada pero no se implementa ni se declara doble cifrado en esta fase.
No hay API de lectura/exportación de secretos ni renovación/revocación real.

## Costes

El núcleo puro se ha trasladado al paquete hermano
[`services/aws-cost-collector`](../aws-cost-collector/README.md), con SDK de
costes separado de Secrets/S3. Incluye caché persistente en la aplicación,
job diario Madrid deshabilitado por defecto, endpoint de administración y UI
de Ajustes. Probado offline; AWS, migración real y despliegue siguen pendientes.

[GetCostAndUsage](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html)
define filtros, paginación y fin de periodo exclusivo.
[SSE-KMS S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)
describe permisos por tipo de escritura. La validación con clientes SDK
ficticios no prueba IAM efectivo.

## QA y operación

```bash
npm ci --ignore-scripts
npm test
```

Ejecutar con Node 24. QA niega todas las conexiones externas y solo permite el
puerto loopback efímero declarado para TLS; no carga el entorno de producción.
Prueba concurrencia, bloqueo/reinicio, timeout incierto, firma/replay, scope,
proyección sin secretos, outbox/leases, ACK/reintento, metadata de Secrets,
copia/restauración **del SQLite ficticio del broker**. Costes tiene su propia suite.
Esa restauración no acredita cifrado ni recuperación de la BD clínica.

Antes de desplegar: aprobar destino/versión Node, propietario y permisos del
código/configuración, TLS, grants, principales de despliegue y servicio, red,
disco/backups, retención, entrega AWS, coste y rollback. No ejecutar el template
de aprovisionamiento de nuevo. Un rollback conserva bloqueos, comandos y audit;
no recupera tokens de BD ni permite reabrir `getAssetStats`.
