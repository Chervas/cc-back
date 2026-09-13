# GA4: lecturas por broker preparadas

## 13/09/2026 — Controles de revocación SC/GA preparados en el broker

Añadido control cerrado de bloqueo por tupla clínica/conexión/propiedad,
con principal y clave distintos de lectura. Conserva grants de otras tuplas,
aunque compartan credencial. No distingue mappings SQL con la misma tupla.
Auditoría v2 y bloqueo sobreviven a reinicios. La API/cola/worker de desconexión
SC/GA, sus bloqueos SQL y auditoría humana todavía deben integrarse. No despliegue,
operación real ni migración compartida. [Contrato](google-property-revocation-control.md).

## Ampliación vigente de mappings y compartidos (13/09/2026)

El [bloque compartido](google-shared-property-migration.md) incorpora PK SC
(site_hash,mapping_id) con migración 20260913050000 y listado SC/GA mediante
inventario efectivo de la destinataria. Requiere origen del mismo grupo,
asignación/primario vigente y grant original; no copia credenciales. Sustituye
las restricciones de mapping único SC y origen dentro del ámbito directo del
listado anterior. Las cifras y requisitos de los cortes previos siguientes
son históricos; este lote añade su DDL y QA, sin activar ni desplegar cohortes.

## Ampliación vigente de discovery (13/09/2026)

El [listado de propiedades registradas](google-property-discovery-migration.md)
añade discovery.read.v1, con GET a un recurso exacto de la política, payload
vacío y proyección cerrada. Mantiene los informes y sus límites. GA Admin exige
analytics.readonly; su scope analytics no basta. No añade esquema ni activa
cohortes. Los apartados anteriores/siguientes fechados como lecturas describen
ese corte previo: el nuevo contrato rige para discovery. Onboarding, remapeo,
OAuth/estado UI completos, cohortes reales y sus aprobaciones siguen pendientes.

Preparación local del 13/09/2026 sobre backend `60553a1d` y frontend `ecf7fa65`.
Ningún consumidor migrado en runtime. Sin despliegue, migración compartida,
secretos reales o llamadas AWS/Google. OPS aplazado por el usuario; apagado EC2
anunciado y no verificado. Esta preparación amplía las lecturas GBP/SC previas.

## Operaciones y datos

El runtime `google-main.js` admite la cohorte `google-analytics-read-v1`, proveedor
`google_analytics`, con nueve operaciones `google.analytics.<familia>.read.v1`.
Se autorizan por principal, tenant clinic:N, conexión y assetRef ga4:N exactos.
PropertyName se revisa en política: `properties/<ID decimal sin ceros iniciales>`,
hasta veinte dígitos. El consumidor nunca proporciona URL, ARN, scope, filtros,
métricas, dimensiones libres o cabeceras de Google.

| Familia | Dimensiones fijas |
|---|---|
| daily | date |
| channel | date, sessionDefaultChannelGroup |
| source_medium | date, sessionSourceMedium |
| device | date, deviceCategory |
| country | date, country |
| city | date, city |
| language | date, language |
| gender | date, userGender |
| age | date, userAgeBracket |

Cada payload contiene startDate/endDate (fechas exactas, hasta 550 días inclusive)
y pageToken string/null. El broker envía únicamente POST a
`analyticsdata.googleapis.com/v1beta/properties/<ID>:runReport`, con metrics
sessions/activeUsers/newUsers/keyEvents/totalRevenue, limit=500, offset como
string int64, orden por todas las dimensiones, keepEmptyRows=false y
returnPropertyQuota=false. Sin Admin API, Measurement Protocol, Ads, mutaciones,
descubrimiento, autorización OAuth o proxy genérico.

La Data API documenta offset/limit y rowCount independiente de la página;
también utiliza moneda y zona de la propiedad si no se fuerzan en la petición.
[runReport oficial](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport),
[RunReportResponse](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/RunReportResponse).
Google renombró la métrica conversions a keyEvents. El broker usa el nombre
vigente; el adaptador conserva la columna/DTO histórica conversions en el
índice correspondiente y su redondeo existente. No son envíos ni configuración
de conversiones publicitarias.
[Changelog oficial](https://developers.google.com/analytics/devguides/reporting/data/v1/changelog),
[métricas disponibles](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema).

La proyección exige cabeceras exactas y tipos de métrica compatibles. Valida
fechas/rango, cantidad de columnas, números finitos y límites SQL: contadores
INT no negativos, revenue DECIMAL(12,2), incluidos importes negativos válidos.
KeyEvents conserva valores fraccionarios hasta el redondeo del consumidor;
no cambia el esquema de métricas. Dimensiones hasta 256 caracteres/1024 bytes,
sin controles; resultados hasta 786.432 bytes por página, Google hasta 2 MiB.
Campos ajenos y contenido arbitrario no atraviesan la proyección.

## Adaptadores y límites de cobertura

`analyticsBroker.service.js` mantiene contextos opacos en WeakMap y devuelve
solo datos/referencias. Jobs analyticsSync y backfill general/por propiedades
usan el adaptador en las nueve familias antes de intentar cargar un token.
`_runGaReport` comprueba de nuevo el registro incluso con credenciales legacy
preparadas antes del marcador. Cambio de modo o binding prohíbe fallback.

Para una propiedad gestionada, fallar una familia marca fallida esa propiedad
y detiene las siguientes llamadas. Si ninguna se procesa, SyncLog/resultado
es failed. El batch no es atómico: upserts de familias anteriores permanecen,
igual que las filas históricas que un informe nuevo no devuelve. No se afirma
que un resultado vacío elimine la caché antigua. El legado sin marcadores
conserva sus loaders protegidos y su tratamiento previo de dimensiones opcionales.

Discovery, mapping, alta/reautorización y desconexión completas GA siguen
pendientes. Las rutas OAuth pueden hidratar una fila legacy antes de su guard;
no se consideran migradas. `googleOAuthBrokerScope` mantiene el rechazo de
SC/GA/Ads activos para reautorización GBP. Lecturas de caché en informes y rutas
web, otros loaders Google/Ads, otras verticales y auditoría completa de usuarios
conservan su corte pendiente. No se modifican UI, publicidad ni el inventario
efectivo compartido. Ver `google-analytics-consumers.json` junto al inventario global.

## Registro y bloqueo

AnalyticsBrokerBindings usa PK compuesta property_name/mapping_id. Una propiedad
puede tener varios mappings de clínicas legítimos: cada uno requiere su fila,
clínica/conexión/subject/referencias y estado exactos. El adaptador comprueba el
mapping original de cada solicitud y admite hasta 1000 registros por propiedad.
El grant mantiene el tenant de la clínica original; no transfiere autorización
entre mappings por compartir propiedad o identidad. El estado SQL de un mapping
no bloquea automáticamente otro mapping autorizado de esa misma propiedad.

Registro sin FK/cascada: eliminar o recrear mapping/conexión no borra su barrera.
Si existe cualquier registro de la propiedad, un mapping sin registro propio
no puede seleccionar legacy. Una propiedad sin registros ni referencias conserva
legacy, sujeto a la exclusión de identidad compartida. Estado blocked, gate
apagado, referencias parciales, cambios de dueño/subject/propiedad o SQL ausente
cierran el acceso. No normalizar IDs para eludir marcadores.

La conexión requiere ID/subject exactos, una única fila Google para esa identidad
y accessToken/refreshToken NULL. Se consultan solo columnas de metadata y el
booleano SQL de nulabilidad, nunca valores de tokens. Comprueba esas condiciones
antes y después de cada página; no cachea autorización. Un cambio descarta el
agregado. Los jobs usan principal de servicio; no inventan sesión/actor humano.

La frontera googleLegacyCredentials consulta registros OAuth, SC y GA por ID
**o** subject. El SELECT y UPDATE de tokens incluyen los tres NOT EXISTS dentro
de la propia sentencia. El primer registro GA también cierra connect/callback
Google legacy globalmente aun con gates apagados. Aceptar ese impacto y drenar
receptores antes del corte; nunca borrar registros para recuperar legacy.

El broker conserva bloqueo/revocación de conexión en SQLite entre reinicios y
aborta sus operaciones locales; invalid_grant deja estado revocado. Un bloqueo
de conexión alcanza todos sus grants. No añade una operación de desconexión GA,
revocación OAuth o cancelación distribuida. Un proceso antiguo puede conservar
credenciales y llamadas ya despachadas; el drenaje y aislamiento de principales
siguen siendo condiciones reales pendientes.

## Paginación y calidad del informe

Cursor AES-GCM de diez minutos ligado a principal/tenant/conexión/activo/
operación/política, fechas, offset, rowCount y hash de metadata proyectada.
Cada página exige cardinalidad coherente y el mismo rowCount/metadata; el
adaptador vuelve a validarlo y rechaza duplicados entre páginas. No constituye
un snapshot transaccional de Google: si los datos cambian, puede fallar y
necesitar una lectura nueva revisada. No hay retry automático del transporte.

Hasta 200 páginas de 500, techo local 100.000 filas por familia, igual al límite
solicitado antes por el job. Deadline agregado 450 segundos, máximo 40 MB. Si
Google declara más filas, rowLimitReached=true; no se presenta el techo local
como totalidad del proveedor. Fallar entre páginas no devuelve parte del
agregado de esa familia. Runtime conserva ocho llamadas simultáneas y 25 s
por operación; cliente 30 s. La comprobación de 450 s es cooperativa antes y
después de esperar metadata/respuestas: impide nuevos envíos al agotarse,
pero no cancela una consulta SQL que siga pendiente. Los límites de tiempo/cuota pueden alcanzarse
antes del número máximo de páginas: medir con canary, sin desactivarlos.

Se propagan moneda/zona, subjectToThresholding, dataLossFromOtherRow,
samplingMetadatas y un motivo fijo provider_report_empty, sin copiar el mensaje
arbitrario del proveedor. Si hay restricciones activas de métricas, el informe
falla en vez de convertir una métrica ocultada en cero. Metadata de muestreo se
valida y no se usa para reconstruir cifras. Los flags no prueban completitud ni
ausencia de datos omitidos.
[Metadata oficial](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData).

El informe del job añade dataQuality por propiedad/familia con rowCount,
returnedRows, rowLimitReached y esa metadata saneada. Backfill por propiedades
la agrega. No se amplían los DTO de métricas públicas ni se convierte moneda,
se cambia zona horaria o se rehace el histórico. La presentación de calidad en
los informes/cachés de usuario sigue pendiente; estos datos quedan en el reporte
operativo del job cuando la propiedad completa sus familias. Cambiar moneda o
zona entre familias marca fallida la propiedad y detiene las siguientes lecturas.

## Secretos, configuración, auditoría y costes

Secreto GA v3 exacto: version/provider=google_analytics/connectionRef/
googleUserId/clientId/refreshToken/scopes. Subject fijado a política, client ID
al secreto de aplicación v1 google-oauth-client; analytics.readonly o analytics,
prefiriendo readonly en el lote revisado. No admite v2 GBP ni secretos SC.
Refresh ocurre solo en broker; cachea access token limitado por versión/caducidad,
invalida y borra buffers al bloquear. No escribe Secrets Manager desde esta
cohorte ni elimina el riesgo de lectura privilegiada de memoria.

| Variable del consumidor | Uso |
|---|---|
| GOOGLE_ANALYTICS_BROKER_ENABLED | Solo true habilita; default false, sin bypass legacy |
| GOOGLE_ANALYTICS_BROKER_ORIGIN | Origen HTTPS revisado |
| GOOGLE_ANALYTICS_BROKER_AUDIENCE | Audience exacta de GA |
| GOOGLE_ANALYTICS_BROKER_KEY_ID | Principal de lectura con grants exactos |
| GOOGLE_ANALYTICS_BROKER_KEY_FILE | Ed25519 privada absoluta, sin symlink, permisos privados, hasta 64 KiB |
| GOOGLE_ANALYTICS_BROKER_CA_FILE | CA privada absoluta, sin symlink, hasta 64 KiB |

Config privada del runtime: cohort=google-analytics-read-v1, enabled, policy,
listenAddress, port, stateFile, tlsCertFile, tlsKeyFile, cursorKeyFile. Conexiones
incluyen googleSubject/analyticsProperties(assetRef,propertyName); solo grants
de las nueve lecturas. Rechaza campos SC/OAuth en GA. Revisar claves/audiences/
orígenes/estado separados en el corte; el validador no compara claves de otros
procesos. No se instalaron archivos/env ni se cambió npm start ficticio.

Bootstrap AWS previo explícito (IMDSv2/STS, cuenta/región/prefijo/KMS, writer
separado). Acceso efectivo, asunción de writer y aislamiento real todavía no
verificados/autorizados. No se cambió IAM, red, instancia o claves KMS.

Auditoría durable v2 por comando admitido: requested y completed/failed,
principal de servicio, referencias, correlación y política. No persiste filas,
valores de dimensiones, tokens o cursor en SQLite/S3. La repetición del mismo
comando no recupera un dataset guardado. Captura del usuario, lectura de cachés
y rechazos previos a admisión no están cubiertos por este bloque. Retención DPD
y entrega real AWS pendientes; QA SDK/S3 ficticia no las acredita.

Por página se hacen dos DescribeSecret y dos GetSecretValue incluso con access
token cacheado, y dos eventos/entregas de auditoría más posibles reintentos.
Hasta 200 llamadas por familia; nueve familias por propiedad. Revisar cuotas,
latencia, Secrets Manager/S3/KMS y almacenamiento antes del canary. Cada
inspección GA usa tres consultas SQL; dos por página, además de prepare. La
frontera legacy ampliada usa cuatro consultas por comprobación, nueve por carga
y ocho por petición. Son recuentos de código, no coste/latencia medidos.

Ajustes conserva monitor/cache de costes preparados. No se contrata recurso,
se inventa gasto ni se cambia presupuesto. Cost Explorer/tags, filtros
incrementales y Budget/CloudFormation siguen pendientes. Apagado anunciado
no acredita ahorro, estado EC2 o presupuesto disponible.

## Migración, corte y rollback pendientes

`20260913040000-add-analytics-broker-read-binding.js` añade dos referencias
nullable con CHECK de par a ClinicAnalyticsProperties y el registro compuesto,
estado inicial blocked, índices por conexión/subject y sin cascada. No copia,
cifra, borra o migra credenciales. DDL múltiple no atómica; down rechaza registros
o referencias. Dependencias previas OAuth/SC (`20260913020000`/`20260913030000`).
**El esquema es obligatorio antes del código aun con todos los gates apagados**:
también lo consultan OAuth y los loaders legacy compartidos.

El lote real debe concretar acceso temporal AWS/metadata, todos los receptores,
respaldo y DDL por paso, propiedades/mappings/subjects/grants exactos (incluidos
casos de varias clínicas), referencias y registro en transacción, traslado
aprobado a v3 y retirada de tokens SQL/duplicados/cachés, drenaje de OAuth/
discovery/Ads/otros consumidores de la identidad, sesiones/roles cuando aplique,
TLS/estado/IAM aislados, auditoría, cuotas/coste, ventana, canary y rollback.
La autorización existente no permite ejecutar ese lote. Alta/reautorización
GA todavía requiere implementación propia.

Rollback conserva barreras/esquema y deja la cohorte sin activar; no restaurar
tokens ni borrar marcadores. No db:migrate general ni promoción de publicidad.
Publicar solo commits propios a DEV, rango revisado y SHA remoto comprobado
según §5 del runbook. Push no equivale a despliegue.

## Evidencia local

QA ficticia: 147 tests Node (75 broker, 72 backend), 44 checks MySQL propios
(13 GA, 12 SC, ocho frontera legacy, once OAuth) con cierre 0 en cuatro bases,
y tres contratos (scheduler 46 jobs, caducidad GBP, multigrant). TLS GA repetido
tras la última revisión del adaptador. Hotfix getAssetStats conservado.

QA backend con Node 22.17.0 y broker con Node 24.21.0. La versión de procesos
usados se verificará en su corte; no se infiere del shell ni se ha modificado.

Pruebas con Google/SDK ficticios, guard de red y modelos aislados antes de
imports. Incluyen runtime TLS propio con cliente firmado/adaptador, 501 filas en
dos páginas, refresh solo en broker, denegación previa a secretos y bloqueo al
reiniciar; paginación de 100.000 filas, headers/metadata/cursores/restricciones,
nueve familias y backfills reales del código. MySQL propio usa migraciones,
repositorios y modelos reales, socket/datadir privados y TCP apagado; prueba
varios mappings de una propiedad, ID/subject duplicados, recreación, esquema
ausente y marcadores concurrentes en SELECT/UPDATE.

Resultados/manifiestos privados bajo
`/home/ubuntu/qa-evidence/security-migration-20260912/analytics-*`. No claves,
sesiones, dumps o evidencia privada en Git. Front solo documentación; no se
repite Angular/Chromium. No constituye prueba con pacientes, proveedores,
permisos AWS, cifrado/restauración real o despliegue.
