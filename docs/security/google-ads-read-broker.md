# Motor de lecturas Google Ads en el broker

Preparado el 13/09/2026 sobre backend `503b6080f7efd0408b7e9679c29d84c116280408`
y frontend `672b8ae122410a4839593372aac1d7891867c9fe`. OPS aplazado. Motor y QA
ficticia; **ninguna cuenta Ads está migrada ni activada en runtime**. El cierre
legacy de la fase anterior se conserva. Esta entrega no autoriza OAuth, Ads,
conversiones, mensajes, traslado de secretos ni despliegue real.

Ampliado sobre backend `04ebc703e21cde0690b7ef303883f4ae43402e96` y frontend
`1f587169db254a52af35d10d905e6025e52fca2f`: ocho lecturas, lector completo backend
y entrada tipada de los colectores. El registro SQL y la inyección en jobs se
prepararon después en [la integración backend](google-ads-backend-migration.md).
La QA HTTPS de este motor usa un autorizador ficticio; la QA SQL se documenta allí.

## Contrato cerrado

El runtime Google reconoce la cohorte `google-ads-read-v1`, proveedor `google_ads`.
Cada conexión fija `googleSubject`, `secretArn`, `clientSecretArn`,
`developerSecretArn` y `googleAdsAccounts`. Cada cuenta contiene exactamente
`assetRef: ads:<customerId>`, `customerId` y `loginCustomerId` (ID del gestor o null).
Los IDs son cadenas de diez dígitos sin guiones. Grants por clínica, conexión,
cuenta y operación; no tenant de grupo ni operación genérica de búsqueda.

| Operación | Payload exacto | Resultado permitido |
|---|---|---|
| `google.ads.account.read.v1` | `{}` | ID, manager=false, moneda y zona horaria |
| `google.ads.campaigns.read.v1` | `{pageToken: null/string}` | Campañas y estados, máximo 5.000 |
| `google.ads.campaign_metrics.read.v1` | `{startDate, endDate, pageToken}` | Métricas por campaña, fecha, red y dispositivo |
| `google.ads.adgroup_metrics.read.v1` | `{startDate, endDate, pageToken}` | Las mismas dimensiones más grupo de anuncios |
| `google.ads.publishing_campaigns.read.v1` | `{pageToken}` | Campañas ENABLED/PAUSED, canal, estados, sufijo y ajustes de automatización; máximo 5.000 |
| `google.ads.landing_pages.read.v1` | `{startDate, endDate, pageToken}` | Campaña, URL final observada y clics; máximo 100.000 |
| `google.ads.ads.read.v1` | `{campaignId, pageToken}` | Identidad/estado de campaña, grupo y anuncio; URLs, titulares, descripciones RSA y estado de revisión; máximo 200.000 |
| `google.ads.ad_metrics.read.v1` | `{campaignId, startDate, endDate, pageToken}` | Identidades y métricas diarias de anuncio por fecha/red/dispositivo; máximo 200.000 |
| `google.ads.asset.revoke.v1` | `{}` | `{revoked: true}` con UUID/replay durable |

Fechas canónicas, ventana máxima inclusiva de 15 días y 100.000 filas por
consulta de métricas de campaña/grupo. Destinos admite hasta 30 días inclusivos;
anuncios mantiene 15 días y 200.000 filas. Los límites de bytes pueden rechazar
una consulta antes de alcanzar su máximo de filas. `campaignId` es null o una
cadena de 1–20 dígitos, positiva sin ceros iniciales; no amplía el grant de cuenta.
`pageToken` siempre es null o string y todos los campos de cada payload son
obligatorios. El broker construye ocho plantillas GAQL cerradas.
El consumidor no envía query, URL, método, cabeceras, cuenta, gestor, campos,
versión de API ni tokens. No se exponen operaciones de escritura o conversión.
La revocación requiere principal y clave diferentes de todos los lectores;
rechaza lectores con el mismo material criptográfico bajo otro keyId.

La proyección comprueba cuenta, IDs, fechas, métricas finitas/precisión segura,
filas duplicadas en cada página, longitud y estructura. Conserva ceros protobuf
omitidos y excluye campos desconocidos. No entrega respuestas del proveedor
directamente. El consumidor completo deberá detectar también duplicados o cambios
entre páginas y conciliar las métricas antes de persistir el snapshot; el lector
y los colectores tipados descritos abajo ya preparan esas comprobaciones.

Las nuevas selecciones siguen los recursos oficiales de
[destinos](https://developers.google.com/google-ads/api/fields/v24/landing_page_view),
[anuncios y revisión](https://developers.google.com/google-ads/api/fields/v24/ad_group_ad)
y [automatización de campaña](https://developers.google.com/google-ads/api/reference/rpc/v24/Campaign.AssetAutomationSetting).
Las URL se tratan únicamente como datos de observación: HTTP/HTTPS, sin usuario
o contraseña, máximo 4.096 bytes; no se visitan. Listas acotadas a 20 URLs, 15
titulares y cuatro descripciones RSA, 50 motivos/ajustes y textos de hasta 1.024
bytes. La proyección de métricas de anuncios excluye las creatividades.

## Transporte, secretos y paginación

El transporte privado solo añade POST
`https://googleads.googleapis.com/v24/customers/<ID>/googleAds:search`.
TLS verificado, puerto 443, sin redirecciones, compresión ni cabeceras libres;
timeout HTTP de ocho segundos. Límite de respuesta Ads 16 MiB, manteniendo los
límites previos de otros proveedores. OAuth usa el transporte acotado existente.

Google requiere OAuth y `developer-token`; el gestor se selecciona mediante
`login-customer-id` cuando corresponde. Se fijan en el broker, según el
[contrato oficial de cabeceras](https://developers.google.com/google-ads/api/rest/auth).
El secreto de conexión v3 vincula proveedor, referencia, subject y clientId;
el cliente OAuth conserva su formato v1 y se exige scope `adwords`. El developer
token usa un tercer secreto JSON con claves exactas:
`{version: 1, provider: "google-ads-developer", developerToken: "…"}`.
No se ha creado ni movido ningún secreto real.

Se comprueban ARN/prefijo/cuenta/región, KMS esperado y AWSCURRENT antes de usar
el developer token. No se recupera de variables legacy ni se devuelve fuera de
su callback privado. Los buffers temporales se vacían; las respuestas que
contienen sentinels de las credenciales se rechazan. No se promete que todas las
copias de cadenas gestionadas por JavaScript desaparezcan de memoria.

[Search pagina hasta 10.000 filas](https://developers.google.com/google-ads/api/docs/reporting/paging),
por lo que no se envía pageSize. El motor guarda páginas proyectadas en memoria
y sirve porciones de hasta 250 filas, reducidas si superan el presupuesto de
780.000 bytes de datos. El resultado completo queda por debajo del límite
vigente de 1 MiB del cliente del broker. Un provider pageToken nunca se entrega
al consumidor: el cursor opaco referencia página/offset y autentica principal,
tenant, conexión, activo, operación y versión de política. También se comprueban
fechas/query y huella de los tokens usados en esa página.

Caché máxima de 16 páginas y 64 MiB de JSON contabilizado; no es un límite del
RSS total del proceso. Caducidad de diez minutos, como el cursor. Evicción,
reinicio, cursor expirado o cambio de token rechazan la continuación. No se
reinicia silenciosamente desde una página intermedia. Se detectan pageTokens
repetidos, exceso de filas y tamaños. El adaptador backend deberá abandonar un
snapshot incompleto y comenzar otro intento acotado. Falta medir memoria,
latencia y comportamiento con cuentas reales grandes en un canary aprobado.

## Lector y colectores del backend

`src/services/googleAdsBrokerReader.service.js` exige un cliente y un
`assertContext` que resuelva una autorización opaca creada por el servidor. Una
estructura recibida del usuario con tenant/cuenta no es una autorización. El
autorizador SQL ya está preparado en googleAdsBrokerScope.service.js y se inyecta
en sync/backfill mediante googleAdsBroker.service.js. No se exporta como una ruta
pública; su configuración, DDL y activación real siguen pendientes.

El lector no acepta cursores externos. Comprueba el contexto antes/después de
cada petición y antes de devolver el resultado completo, requestId, forma de
respuesta, cuenta, duplicados entre páginas y estabilidad de metadatos de campaña,
grupo y anuncio. Ventana temporal total por consulta de 90 segundos por defecto
(máximo 450 segundos), hasta 2.000 peticiones, 64 MiB de JSON de filas proyectadas,
límites de filas anteriores y máximo 30 segundos por llamada. Este presupuesto
de bytes tampoco representa RSS: las claves de deduplicación, huellas de recursos,
arrays y copias JavaScript tienen sobrecoste. Errores/cursor inválido/revocación
descartan lo acumulado; no se entrega un resultado parcial ni se reinicia la
paginación a mitad de consulta.

`googleCampaignMetricsCache.collectGoogleCampaignMetrics` admite
`readTyped(family, payload, budget)` para las cuatro lecturas originales. Mantiene
su conciliación Search/PMax, cobertura de ceros, fingerprint y plazo de 90 segundos.
`googleAdCache.syncGoogleAdCache` admite esa entrada para inventario y métricas;
divide los chunks configurados en ventanas de hasta 15 días, conserva creatividades,
estados, atribución y cobertura. Un fallo del lector tipado no invoca legacy. Los
imports de lectores legacy son diferidos y no se ejecutan en la rama tipada.
No se cambia el contrato de persistencia ni se aplica DDL.

La QA por HTTPS local conecta el cliente firmado real, lector, broker y ambos
colectores, con proveedor/Secrets Manager/autorización y repositorios de escritura
ficticios. No carga el índice de modelos clínicos. La integración backend posterior inyecta este
recorrido en sync/backfill y conecta publicación/destinos con sus escritores;
solo el éxito de todas esas fases permite actualizar lastSyncedAt, con permisos
revalidados dentro de las transacciones. Continúa pendiente el corte real.

## Bloqueo y auditoría

La revocación persiste en SQLite y reintenta el mismo UUID. Antes de secretos y
después de awaits se comprueba conexión/activo. La baja invalida su caché de
páginas; el bloqueo de conexión y cierre del runtime la limpian también. Tras
reiniciar, el bloqueo permanece aunque la caché sea nueva. No puede deshacer
una petición que Google ya haya recibido ni revoca el token OAuth del proveedor.

Auditoría v2 existente: actor de servicio, tenant, referencias, operación,
resultado y correlación; dos eventos por nueva lectura admitida. Las métricas,
nombres de campañas, cursores y credenciales no se persisten en el resultado
SQLite ni en el outbox. El lector de API general todavía debe aportar la captura
de actor humano y enlazarla con estos eventos. Entrega S3/IAM/retención reales y
auditoría completa de la plataforma siguen pendientes.

## Pruebas y costes

145 tests del broker correctos (22 de Ads), con Node 24 y red
bloqueada salvo los servidores HTTPS locales propiedad de las pruebas. Cubren
ocho lecturas, payloads hostiles, ámbito, 10.001 filas completas con dos
consultas ficticias, caché/evicción/caducidad, rotación de token, páginas repetidas,
sentinels, límites de tamaño, transporte, KMS/ARN y runtime HTTPS real con
desconexión persistente tras reiniciar. La ampliación prueba 100.001 anuncios en
11 páginas Google ficticias, porciones autenticadas y secuencia completa de IDs.
Las otras cohortes siguen pasando. Además, 48 tests Node backend comprueban lector,
paridad de snapshots y regresión de los dos colectores; total 193 correctos.
Sin nueva DDL, MySQL, UI/build, procesos de aplicación, AWS ni proveedor real.

Evidencia privada `ads-broker-*` bajo
`/home/ubuntu/qa-evidence/security-migration-20260912/`;
`ads-broker-final-regression.log` y su JSON acreditan la ejecución final.
El primer fallo era el nombre de tabla usado por el test de ausencia de datos;
se conservó ese log y se comprobó después `audit_outbox` real.
La ejecución final ampliada es `ads-consumers-regression.log/json`. El espejo de
API tiene prueba final `ads-consumers-api-final-proof.json`; el primer verificador
eliminaba también un salto de línea y dio un falso negativo, conservado en su
artefacto inicial. Los cuerpos API previos son idénticos byte a byte.

Por petición del consumidor hay nominalmente seis llamadas Secrets Manager
(Describe/Get para conexión, cliente y developer token), aun si la página se
sirve de memoria; refresh solo cuando lo exige el almacén existente. Una página
de 10.000 filas puede producir 40 o más peticiones pequeñas y sus eventos de
auditoría. La caché evita repetir esa consulta Google, pero no elimina el coste
SM/S3/KMS ni la latencia de validación. No se asigna un precio o ahorro ficticio.
Cost Explorer, etiquetas, Ajustes con gasto verificado y Budget/CloudFormation
conservan sus pendientes. No se añade infraestructura ni presupuesto.

## Siguiente integración y puerta de activación

Registro independiente, comprobación SQL NULL de tokens, autorización de grupo y
compartidos, cierre legacy e inyección en sync/backfill se prepararon en
[el bloque backend](google-ads-backend-migration.md). OAuth Ads y la cola de
confirmación de desconexiones siguen pendientes; una baja gestionada se rechaza
antes de cambios parciales mientras falta esa dependencia.
Ads usa assignmentScope/grupoClinicaId y asignaciones explícitas; GrupoClinica no
tiene una columna de cuenta Ads primaria. Los primarios SC/GA/GBP se comprueban
en sus recorridos correspondientes.
También faltan recepción, conversiones, optimización y resto del inventario Ads.
No convertir el cliente HTTP genérico en un proxy al broker.

Antes del uso real: completar esas dependencias, resolver el lote de IAM/acceso
exacto a los tres secretos, configurar policy/grants y principals propios, probar
aislamiento, migrar solo la cohorte aprobada y acreditar que ningún consumidor
recurre a tokens SQL. El motor implementado no sustituye ese corte.
OPS permanece aplazado. El push solo publica código y documentación propios;
no instala configuración, reinicia, mueve secretos ni despliega.
