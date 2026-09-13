# Motor de lecturas Google Ads en el broker

Preparado el 13/09/2026 sobre backend `503b6080f7efd0408b7e9679c29d84c116280408`
y frontend `672b8ae122410a4839593372aac1d7891867c9fe`. OPS aplazado. Motor y QA
ficticia; **ninguna cuenta Ads está migrada ni activada en runtime**. El cierre
legacy de la fase anterior se conserva. Esta entrega no autoriza OAuth, Ads,
conversiones, mensajes, traslado de secretos ni despliegue real.

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
| `google.ads.asset.revoke.v1` | `{}` | `{revoked: true}` con UUID/replay durable |

Fechas canónicas, ventana máxima inclusiva de 15 días y 100.000 filas por
consulta de métricas. El broker construye cuatro plantillas GAQL estáticas.
El consumidor no envía query, URL, método, cabeceras, cuenta, gestor, campos,
versión de API ni tokens. No se exponen operaciones de escritura o conversión.
La revocación requiere principal y clave diferentes de todos los lectores;
rechaza lectores con el mismo material criptográfico bajo otro keyId.

La proyección comprueba cuenta, IDs, fechas, métricas finitas/precisión segura,
filas duplicadas en cada página, longitud y estructura. Conserva ceros protobuf
omitidos y excluye campos desconocidos. No entrega respuestas del proveedor
directamente. El consumidor completo deberá detectar también duplicados o cambios
entre páginas y conciliar las métricas antes de persistir el snapshot.

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

138 tests del broker correctos, incluidos 15 nuevos de Ads, con Node 24 y red
bloqueada salvo los servidores HTTPS locales propiedad de las pruebas. Cubren
cuatro lecturas, payloads hostiles, ámbito, 10.001 filas completas con dos
consultas ficticias, caché/evicción/caducidad, rotación de token, páginas repetidas,
sentinels, límites de tamaño, transporte, KMS/ARN y runtime HTTPS real con
desconexión persistente tras reiniciar. Las otras cohortes siguen pasando.
Sin nueva DDL, MySQL, UI/build, procesos de aplicación, AWS ni proveedor real.

Evidencia privada `ads-broker-*` bajo
`/home/ubuntu/qa-evidence/security-migration-20260912/`;
`ads-broker-final-regression.log` y su JSON acreditan la ejecución final.
El primer fallo era el nombre de tabla usado por el test de ausencia de datos;
se conservó ese log y se comprobó después `audit_outbox` real.

Por petición del consumidor hay nominalmente seis llamadas Secrets Manager
(Describe/Get para conexión, cliente y developer token), aun si la página se
sirve de memoria; refresh solo cuando lo exige el almacén existente. Una página
de 10.000 filas puede producir 40 o más peticiones pequeñas y sus eventos de
auditoría. La caché evita repetir esa consulta Google, pero no elimina el coste
SM/S3/KMS ni la latencia de validación. No se asigna un precio o ahorro ficticio.
Cost Explorer, etiquetas, Ajustes con gasto verificado y Budget/CloudFormation
conservan sus pendientes. No se añade infraestructura ni presupuesto.

## Siguiente integración y puerta de activación

Falta adaptar el backend: registro independiente de cuentas/mappings, metadata
de identidad y tokens SQL NULL, autorización clínica/grupo/compartidos/primarios,
marcador durable de cierre legacy Ads, consumidor tipado del colector de métricas,
lecturas de inventario/destinos/anuncios restantes, OAuth Ads y desconexión API.
También faltan recepción, conversiones, optimización y resto del inventario Ads.
No convertir el cliente HTTP genérico en un proxy al broker.

Antes del uso real: completar esas dependencias, resolver el lote de IAM/acceso
exacto a los tres secretos, configurar policy/grants y principals propios, probar
aislamiento, migrar solo la cohorte aprobada y acreditar que ningún consumidor
recurre a tokens SQL. El motor implementado no sustituye ese corte.
OPS permanece aplazado. El push solo publica código y documentación propios;
no instala configuración, reinicia, mueve secretos ni despliega.
