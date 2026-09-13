# Search Console: lecturas por broker preparadas

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

## Ampliación vigente GA4 (13/09/2026)

El [bloque GA4](google-analytics-read-migration.md) incorpora su registro a los
guards OAuth/legacy compartidos: 20260913040000 y dependencias antes del código,
aun con gates apagados. Frontera legacy: cuatro consultas por comprobación,
nueve por carga y ocho por petición. No cambia las cuatro lecturas SC ni amplía
su OAuth/discovery. Las cifras y requisitos siguientes describen el corte SC
anterior; ningún consumidor real se ha migrado.

Preparación local del 13/09/2026 sobre backend `3655c04b` y frontend `a754ef5c`.
Migrados en runtime: **cero**. Sin migración compartida, despliegue ni llamadas
AWS/proveedores reales. OPS aplazado por el usuario; apagado EC2 anunciado,
sin comprobar su estado. No se ha activado ninguna configuración.

## Contrato y consumidores

`google-main.js` admite la cohorte `google-search-console-read-v1` y cuatro
operaciones `google.search_console.{timeseries,queries,pages,inspection}.read.v1`.
Recibe referencias firmadas de principal, clínica, conexión y propiedad;
la API general no recibe ni renueva sus tokens Google. No admite OAuth de
autorización, descubrimiento de propiedades, mutaciones ni proxy genérico.

| Operación | Payload cerrado | Resultado proyectado |
|---|---|---|
| timeseries | startDate, endDate; hasta 550 fechas inclusive | keys=[date], clicks, impressions, ctr, position; hasta 550 filas |
| queries | startDate, endDate; hasta 62 fechas; pageToken string/null | keys=[date,query,page], métricas, nextPageToken y rowLimitReached; 500 filas por página |
| pages | startDate, endDate; hasta 550 fechas; startRow y rowLimit | keys=[page], métricas; 1–500 filas, offset+limit hasta 25.000 |
| inspection | objeto vacío | inspectionResult.indexStatusResult con verdict y coverageState |

Search Analytics usa POST a `www.googleapis.com` y la ruta fija
`/webmasters/v3/sites/<propiedad codificada>/searchAnalytics/query`. La propiedad
se obtiene de la política revisada; dimensiones, dataState=final, type=web y
aggregationType=auto se fijan dentro del broker. URL Inspection usa únicamente
`searchconsole.googleapis.com/v1/urlInspection/index:inspect`, con raíz revisada
y languageCode=en-US. El consumidor no proporciona URLs, cabeceras, scopes o ARN.

Google pagina por offset y no garantiza devolver todas las filas; los empates
pueden cambiar de orden. Las fechas son PT, sin alterar el reloj UTC local.
El techo de 25.000 filas por intervalo es una decisión de esta cohorte, no un
inventario completo de Google.
[Referencia oficial de Search Analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
URL Inspection devuelve información de la versión indexada, no una prueba de
indexabilidad en vivo.
[Referencia oficial de URL Inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).

`searchConsoleBroker.service.js` prepara un contexto opaco en WeakMap. Consulta
metadata y una expresión SQL que comprueba ambos tokens NULL; no selecciona sus
columnas. Conserva IDs/DTO de negocio. Consumidores preparados:

- `web.routes.js`: status solo metadata, páginas SC y rama URL Inspection de
  PSI por broker. PSI/API key y sondas web siguen independientes y pendientes.
- `sync.jobs.js`: timeseries, queries por intervalos e inspección de webSync;
  backfills generales y por sites heredan el mismo adaptador.
- `googleLegacyCredentials.service.js`: exclusión de ID/subject contra registros
  OAuth **y** SC, también dentro del SELECT/UPDATE que accede a tokens.
- `googleOAuthBroker.service.js`: el primer registro SC también cierra
  connect/callback legacy global; su guard de conexión consulta ID o subject.

GA4 conserva la frontera legacy anterior. Discovery/mapping SC/GA, OAuth completo
SC, Ads, otros loaders/scripts, escrituras GBP y demás verticales siguen pendientes.
`googleOAuthBrokerScope` continúa rechazando SC/GA/Ads activos: no se amplía la
admisión de reautorización GBP. El resolver de discovery legacy todavía puede
hidratar una fila antes del guard; no se considera migrado. Inventario delta:
`google-search-console-consumers.json`, sin sustituir el inventario global.

## Identidad, sesiones y bloqueo

`SearchConsoleBrokerBindings` conserva hash SHA-256 de propiedad exacta, URL,
mapping original, clínica, conexión, subject, referencias y estado. AssetRef es
`sc:<sha256>`. No tiene FK/cascada: quitar/recrear mapping o conexión no reabre
tokens SQL. Se exige una sola fila Google para ID o subject, con accessToken y
refreshToken NULL. Cambiar dueño, conexión, subject, referencias o estado
descarta la respuesta. Un duplicado no hereda autorización por compartir URL.

Cada propiedad tiene un único mapping original en el registro. Una clínica
receptora por inventario efectivo compartido conserva ese vínculo; la API
revalida la asignación actual y permiso sobre la clínica solicitada.

Propiedades canónicas ASCII de hasta 512 caracteres: sc-domain con FQDN en
minúsculas o URL-prefix http/https con FQDN, ruta ASCII y barra final. Se rechazan
puertos, credenciales, query, fragmento, escapes porcentuales, IP y normalización
implícita. Es una restricción local más estrecha que Google. `prepare` la aplica
también a mappings legacy: inventariar incompatibilidades antes de desplegar;
no normalizar un marcador para abrir otra fuente ni asumir compatibilidad real.

Cada página comprueba registro/mapping/identidad/gate antes y después del broker.
HTTP exige sesión gestionada vigente (sessionVersion=1, jti y mismo actor),
permiso actual de lectura/escritura e inventario fresco, también antes del
agregado final. Perder sesión o permiso descarta datos con 401/403. Status
propaga esos rechazos. Jobs usan principal de servicio y revalidan bindings;
no inventan un actor de usuario.

Registro ausente con referencias, estado blocked, error SQL, gate apagado,
tokens SQL presentes o identidad duplicada impiden leer. No hay fallback.
Sin registro ni referencias se conserva legacy sujeto a su frontera SQL.
Cualquier marcador SC por ID/subject cierra esa frontera con gates apagados.

El núcleo del broker conserva bloqueo/revocación en SQLite, aborta solicitudes
locales y comprueba estado tras secreto/respuesta. Reiniciar no borra el bloqueo.
No se añade desconexión SC ni cancelación distribuida. Peticiones antiguas ya
despachadas y filas de jobs ya persistidas no se deshacen: el corte exige drenaje
y retirada de fuentes previas. El batch no es una transacción. Un administrador
con capacidad de borrar marcadores sigue siendo riesgo de aislamiento pendiente.

## Secretos, configuración y límites

SC exige secreto v3 con campos exactos version, provider=google_search_console,
connectionRef, googleUserId, clientId, refreshToken y scopes. Subject se fija a
política y client ID al secreto de aplicación v1 google-oauth-client. Scope
webmasters.readonly o webmasters; preferir readonly en el lote revisado. SC no
acepta el secreto GBP v2. Refresh y access token quedan en broker con validación
de scope, caché limitada y borrado de sus buffers. No elimina el riesgo de memoria
privilegiada ni crea/versiona secretos. No se autoriza ni revoca OAuth real.

El bootstrap AWS preparado fija cuenta/región/prefijo/ARN/KMS, IMDSv2 y writer
asumido separado. Los permisos reportados todavía no acreditan ese funcionamiento
ni la asunción del writer; no se ha cambiado IAM/trusts ni consultado AWS.

Variables del consumidor, sin valores instalados:

| Variable | Uso |
|---|---|
| GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED | Solo literal true; default false, sin fallback |
| GOOGLE_SEARCH_CONSOLE_BROKER_ORIGIN | Origen HTTPS exacto |
| GOOGLE_SEARCH_CONSOLE_BROKER_AUDIENCE | Audience de política SC |
| GOOGLE_SEARCH_CONSOLE_BROKER_KEY_ID | Principal de lectura con grants SC exactos |
| GOOGLE_SEARCH_CONSOLE_BROKER_KEY_FILE | Ed25519 privada absoluta, sin symlink, permisos privados, hasta 64 KiB |
| GOOGLE_SEARCH_CONSOLE_BROKER_CA_FILE | CA en archivo privado absoluto, sin symlink, hasta 64 KiB |

Config privada: cohort, enabled, listenAddress, port, stateFile, tlsCertFile,
tlsKeyFile, cursorKeyFile y policy. Conexiones con googleSubject y
searchConsoleSites(assetRef/siteUrl); grants clinic:N para las cuatro lecturas.
Revisar clave/audience/origen/estado propios y separación de GBP/OAuth/control
en el corte: el validador SC no compara claves alojadas en otro proceso.
No se han instalado archivos ni cambiado el npm start ficticio o Node de la API.

Cursor queries AES-GCM, diez minutos, ligado a principal, clínica, conexión,
activo, operación, política e intervalo. Agregado máximo de 50 páginas de 500,
deadline 450 segundos y 40 MB. Pages divide offset/limit de hasta 25.000 en
llamadas de 500. Proyección hasta 786.432 bytes por página; Google hasta 2 MiB.
Rechaza duplicados, formas/métricas inválidas, claves excesivas y secretos.
TLS estricto, sin redirects, compresión ni desactivación de CA.

Queries con 25.000 filas completas devuelve rowLimitReached=true; webSync añade
rowLimits al informe. Fallar entre páginas descarta el agregado de ese intervalo.
Runtime limita ocho llamadas simultáneas y 25 segundos/operación; cliente espera
30 segundos. Sin retry automático ni cursor de proveedor en DTO público.

## Auditoría y coste

Outbox durable v2 del broker: requested y completed/failed por comando admitido,
principal de servicio, referencias, correlación y política. No persiste resultados
de métricas, páginas, queries, tokens o cursor en SQLite/eventos S3. Repetir el
comando no recupera datos guardados. Entrega SDK/S3 ficticia ensayada; entrega y
retención AWS no verificadas. Auditoría de usuario, cachés, rechazos previos a
admisión y cobertura completa de plataforma siguen pendientes para esta vertical.

Cada página admitida usa dos DescribeSecret y dos GetSecretValue incluso con
access token en caché, dos eventos y sus entregas/reintentos. Puede multiplicar
hasta por 50 las llamadas de un intervalo frente a la antigua petición de
25.000 filas. Medir cuotas, latencia, S3/KMS/Secrets Manager antes del canary.

Inspección SQL gestionada completa: tres consultas; página: dos inspecciones,
además de prepare/sesión/ACL/inventario. Frontera legacy: tres consultas por
comprobación, siete por carga y seis por petición. Recuentos de código, no
medición real. Ajustes conserva monitor/cache preparados. No hay recursos nuevos,
gasto inventado o cambio de presupuesto. Cost Explorer/tags y conciliación
Budget/CloudFormation pendientes. Apagado anunciado no acredita ahorro.

## Migración y lote pendiente de aprobación

`20260913030000-add-search-console-broker-read-binding.js` añade dos referencias
nullable y CHECK de par a ClinicWebAssets y crea el registro independiente,
estado inicial blocked. No copia, cifra, borra ni migra tokens/filas reales.
Requiere tablas previas y nulabilidad OAuth de `20260913020000`.
**Esquema y dependencias antes del nuevo código, incluso con gates apagados**:
lo consultan también OAuth y los loaders legacy.

DDL múltiple no atómica. Down rechaza cualquier registro o referencia; rollback
con datos gestionados debe conservar esquema y barreras. Up/down solo ensayado
en MySQL propio. No ejecutar db:migrate general en la BD DEV/staging compartida.

El futuro lote debe concretar acceso temporal AWS aprobado y metadata verificada;
receptores/consumidores exactos (incluidos gateway/staging); respaldo y DDL por
paso; inventario canónico/subject único/permisos compartidos; referencias y registro
coherentes en transacción; traslado aprobado a v3 y retirada de tokens SQL/cachés/
duplicados; drenaje de OAuth/discovery/GA/Ads y demás consumidores de la identidad;
política/grants/TLS/estado/IAM aislados; sesiones, límites, coste, ventana, canary
y rollback seguro. No hay autorización para ejecutar ese lote.

No bajar flags, borrar marcadores o restaurar tokens como rollback. Alta y
reautorización SC requieren implementación/corte propios. Publicación DEV con
archivos propios, rango completo revisado y SHA remoto verificado según el
apartado 5 del runbook; no promover toda publicidad ni equiparar push y despliegue.

## QA y evidencias

126 tests Node (65 broker, 61 backend), 31 checks MySQL en tres bases propias
(12 SC, ocho frontera legacy, once OAuth) y tres contratos adicionales
(scheduler 46 jobs, caducidad GBP, multigrant). Ficticios, con guard de red y
modelos aislados antes de imports. MySQL 8.0.42 con TCP apagado, socket/datadir
propios, migraciones/repositorios/modelos reales y cierre 0 en las tres bases.

Cobertura: destinos/proyección/límites, 50 páginas/25.000 filas, cursores,
exclusión de tokens, invalid_grant, bloqueo/reinicio, SQL concurrente, duplicados,
recreación, pérdida de sesión/ACL/mapping y descarte HTTP. TLS propio conecta
runtime real, cliente firmado y adaptador con Google/SDK ficticios: 501 filas,
dos páginas, refresh solo en broker. Once pruebas del hotfix getAssetStats incluidas.

Evidencia privada: `/home/ubuntu/qa-evidence/security-migration-20260912/`,
prefijo search-console- (logs, QA, paths, espejo API y publicación). Sin claves,
sesiones, dumps o evidencia privada en Git. Front solo documentación: no se
repite Angular/Chromium. No acredita pacientes/proveedores/permisos AWS,
cifrado/restauración de BD, entrega real de auditoría ni despliegue.
