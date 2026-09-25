# Perfil de Empresa: cohorte de lecturas del broker

Ampliación posterior del 13/09: [listado por grants](google-business-profile-discovery-migration.md)
añade una séptima lectura y cierra descubrimiento/remapeo legacy globalmente
tras el primer registro. OPS aplazado por el usuario; apagado EC2 anunciado,
sin estado efectivo verificado. Las seis lecturas de jobs de este documento
conservan sus contratos. Ninguna cohorte real desplegada.

Estado: **preparada y probada con ficticios; sin desplegar ni migrar ubicaciones
reales**, 13/09/2026. Este documento complementa el runbook principal; no autoriza
AWS, OAuth real, cambios de red/IAM ni migraciones sobre la BD compartida.

El usuario comunicó otro incidente de WABA, pidió detener el trabajo y después
autorizó reanudar indicando que había revocado los tokens de WhatsApp. Es
información reportada, sin prueba de tokens ni comprobación independiente de
contención. No se han cambiado los flags, colas o runtimes de WhatsApp/Meta.

## Consumidores y contrato

Se adaptan `executeBusinessProfileSync` y `executeBusinessProfileReviewsSync`
de `src/jobs/sync.jobs.js`, incluidos los backfills que reutilizan esas funciones.
`businessProfileBroker.service` obtiene un contexto sin credenciales para las
ubicaciones marcadas. Antes y después de cada llamada verifica en BD la clínica,
conexión Google, activo, estado activo y referencia capturados. Un cambio
observado descarta la respuesta; esas verificaciones y las escrituras posteriores
de caché no forman una única transacción. El corte exige drenar trabajos previos.

La selección persistente son dos columnas nullable de `ClinicBusinessLocations`:
`broker_read_connection_ref` y `broker_read_asset_ref`. Ambas null conservan el
recorrido legacy. Una referencia presente exige un par válido, gate `true` y
broker disponible; nunca recupera el token antiguo como fallback.
`BusinessProfileBrokerBindings`, sin FK ni borrado en cascada, conserva el
locationId externo, referencias y clínica/conexión originales. Los jobs consultan
este registro antes de cargar incluso un token legacy. Borrar/recrear un mapping,
quitar solo sus columnas o cambiar su conexión no vuelve a habilitar la fuente
antigua: registro y mapping deben coincidir. No hay API para borrar el registro.
Una modificación directa de ambas fuentes por un administrador de BD queda
fuera de esta protección; no se presenta como aislamiento frente al DBA.
`assetRef`
es `gbp:<accountId>:<locationId>` y `tenantRef` se deriva de `clinica_id` como
`clinic:<id>`. Los IDs Google son cadenas numéricas; no se convierten a Number.
La política del broker vuelve a exigir principal/clínica/conexión/activo/operación
exactos. No hay ruta pública para editar esos grants o recuperar secretos.

| Operación (prefijo `google.business_profile.`) | Payload exacto | Destino y proyección |
|---|---|---|
| `metrics.read.v1` | `startDate`, `endDate` YYYY-MM-DD, hasta 366 fechas inclusivas | Performance v1, nueve métricas actuales del job, fechas/valores/subtipo |
| `reviews.read.v1` | `pageToken: null` o cursor opaco | v4 accounts/locations/reviews, hasta 50; reseña/reply y conteos |
| `posts.read.v1` | `pageToken: null` o cursor opaco | v4 accounts/locations/localPosts, hasta 100; publicación pública/evento/oferta/media |
| `media.read.v1` | `pageToken: null` o cursor opaco | v4 accounts/locations/media, hasta 100; metadatos de fotos |
| `details.read.v1` | `{}` | Business Information v1 locations, readMask fijo con ficha/servicios/horarios |
| `verification.read.v1` | `{}` | Verifications v1 locations/VoiceOfMerchantState, estado/recomendación |

El catálogo y las proyecciones están en `google-business-profile-contract.js`.
Se rechazan URLs, headers, campos extra, métricas arbitrarias, activos ajenos y
rangos inválidos. Los nombres de recursos devueltos, cuando están presentes,
deben corresponder a la ubicación solicitada. Las reseñas que solo traen
`reviewId` conservan esa clave legacy, sin fabricar otro nombre de caché.
Los campos desconocidos no pasan a `raw_payload`. El transporte no descarga
las URLs de imágenes devueltas ni sigue redirecciones.

Se conservan métricas ausentes frente a cero, cachés de detalles/posts/media,
matching interno de reseñas y limpieza autoritativa de reseñas solo al terminar
el barrido completo. Fallo de página, límite de páginas o job incremental no
autorizan esa limpieza. Los números que perderían precisión se rechazan; los
tipos/límites de las tablas existentes siguen aplicándose, sin migrar su negocio.

Referencias oficiales usadas para contrastar métodos y formas de respuesta:
[métricas y consulta de fechas](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries),
[reseñas](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list),
[publicaciones](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/list),
[media](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media),
[ficha](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations),
[verificación](https://developers.google.com/my-business/reference/verifications/rest/v1/locations/getVoiceOfMerchantState).

## Credenciales y ciclo de vida

`google-secrets.js` solo funciona dentro del broker. Cada lectura comprueba
DescribeSecret/GetSecretValue AWSCURRENT de dos secretos, con ARN, cuenta,
prefijo, KMS, proveedor y versión explícitos. No usa `.env` de la aplicación,
GoogleConnection ni una cadena AWS de credenciales por defecto.

JSON de conexión: exactamente `{version:2,provider:"google_business_profile",
connectionRef,refreshToken,scopes}`. JSON de aplicación: exactamente
`{version:1,provider:"google-oauth-client",clientId,clientSecret}`. La política
local fija `secretArn` y `clientSecretArn`. Se exige `business.manage`; falta de
scope, KMS distinto, metadatos borrados o formato desconocido detienen la lectura.
Estos formatos **no son** el secreto ficticio ya aprovisionado; no se sobrescribe.

Renueva únicamente mediante POST HTTPS fijo `oauth2.googleapis.com/token`,
grant refresh_token, según caducidad (margen 60 s, máximo una hora en caché).
Hasta 64 entradas/renovaciones concurrentes en memoria, renovación compartida
por conexión/versión y versiones comprobadas en cada operación. Cambiar versión,
bloquear o cerrar invalida buffers; la expiración se comprueba al consumirlos.
No hay rotación periódica de refresh tokens ni escritura a Secrets Manager.
`invalid_grant` bloquea como `revoked` de forma durable, también si llega después
del timeout del cliente. Un 401/403 invalida la caché y devuelve error cerrado;
no reintenta la lectura automáticamente ni declara revocación por ese solo dato.

Contrato limitado a los refresh tokens Bearer compatibles; no implementa el
alta OAuth, DPoP, consentimiento ni recuperación automática de conexiones
revocadas. [Renovación oficial](https://developers.google.com/identity/protocols/oauth2/web-server#offline).
La renovación no prueba invalidación del access token anterior. La API recibe
datos proyectados, nunca access/refresh/client secrets. Se buscan sus sentinels
también dentro de los campos permitidos antes de devolver/persistir resultados.
El borrado de buffers no garantiza eliminar copias temporales de SDK/JSON/HTTP.

Cifrado en reposo: Secrets Manager con KMS nativo exacto. No se implementa ni
se afirma doble cifrado con la clave payload cuyo ARN sigue pendiente. La clave
AES-GCM de 32 bytes del cursor cifra exclusivamente tokens de paginación,
caduca a diez minutos y vincula principal, clínica, conexión, activo, operación
y versión de política; no es una clave global de credenciales en el backend.

## Runtime, auditoría y límites

`npm start`/`main.js` conserva exclusivamente el arranque ficticio. El nuevo
entry point explícito es `node src/google-main.js /ruta/privada/config.json`,
**solo después de aprobar el corte**. Node 24, TLS/Ed25519 y SQLite WAL FULL;
el Node 18 de la API usa únicamente el cliente firmado. El paquete tiene su
propio lockfile, sin importar la aplicación ni su BD clínica.

Configuración cerrada: `cohort:"google-business-profile-read-v1"`, `enabled:true`,
`policy`, `listenAddress` IP, `port` 1024..65535, `stateFile`, `tlsCertFile`,
`tlsKeyFile`, `cursorKeyFile`. Config/certificados/claves son archivos privados
absolutos sin symlinks; estado en directorio privado. No se ha creado una
configuración operativa ni asignado clínicas/grants reales.

Bootstrap AWS: `AWS_CONFIG_FILE=/dev/null`, `AWS_SHARED_CREDENTIALS_FILE=/dev/null`,
`AWS_EC2_METADATA_V1_DISABLED=true`,
`AWS_EC2_METADATA_SERVICE_ENDPOINT=http://169.254.169.254`. IMDSv2 explícito y
GetCallerIdentity deben identificar la cuenta `137819318729`, rol
`clinicaclick-integrations-prod-ec2-role` y sesión de instancia
`i-0cf40cfe823f160fa`. Después asume exclusivamente
`clinicaclick-audit-prod-writer-role` y valida su identidad. Secrets Manager usa
el principal de instancia; S3 usa el writer. No son dos identidades de proceso
aisladas frente a compromiso del mismo host; reader/admin siguen fuera de él.
Endpoints regionales fijos, sin retries SDK, sin perfiles SSO/keys alternativos.
ARN Secrets KMS fijado al reportado terminado en `15864f4f-2db5-485b-a49f-303c57eedc59`.

Ocho comandos simultáneos, 64 conexiones TLS, cuota durable por principal,
backlog máximo configurado, timeout total broker 25 s/cliente 30 s y transporte
Google 8 s. Máximo 32 KiB de petición, 2 MiB de respuesta Google (32 KiB OAuth),
proyección inferior a 772 KiB. El cliente corta incluso una respuesta que gotea
bytes; no hay reintentos HTTP genéricos. No se acredita capacidad productiva.

Los comandos GBP conservan ID/digest/estado, **sin persistir su respuesta** en
SQLite: reseñas pueden contener información personal. Repetir el mismo
requestId devuelve `outcome_unknown`, sin nueva llamada. Una nueva lectura
requiere un nuevo comando; los jobs conservan su política de reintentos de
lectura. Las cachés de negocio existentes siguen teniendo sus propios datos.

Auditoría de integraciones v2 añade operación/conexión autorizadas, actor de
servicio, tenant/activo, política, correlación UTC y resultado. No guarda
payloads, reseñas, tokens ni errores del proveedor. Acepta eventos históricos
v1. Denegaciones no asignadas ocultan referencias arbitrarias. La cuota y
rechazos anteriores a la autenticación no equivalen a auditoría completa.

Outbox antes de llamar al proveedor y resultado durable antes de responder.
Drain cada segundo, hasta 20 registros por turno, sin solaparse, a
`app/integrations/v2/YYYY-MM-DD/eventId-digest.json` del bucket reportado.
V1 conserva `app/v1/`. PutObject condicional con cuenta/KMS exactas, checksum
y ACK de versión/cifrado; nunca Get/Delete. Caída conserva pendientes y puede
cerrar admisión; respuesta perdida/412 no se confirma automáticamente. La
conciliación de estos objetos v2 y su consulta por operador siguen pendientes:
el visor de plataforma `app/platform/v1..v5` no los consulta. El journal local
no es inmutable ni demuestra entrega externa. Retención/DPD/Governance no se
alteran; 183 días no se convierten en «seis meses» por esta implementación.

## Lote pendiente de aprobación

1. Verificar mediante SSO expresamente asignado identidad, EC2/EBS/red,
   secretos solo por metadata, KMS y controles S3; no usar credenciales previas.
   Conciliar Budget/CloudFormation y retención por sus lotes separados.
2. Acordar commits exactos, instalación Node 24 en la EC2 existente, usuario
   del servicio, TLS/rotación de firmas, backups y canal de acceso autorizado.
   Hoy no hay ingress. Concretar origen de la API, reglas y trusts antes de
   abrir comunicación; no SSH público ni recursos adicionales.
3. Aprobar permiso/trust runtime→writer exacto: la plantilla reportada no lo
   concede. Reader, retención, SSO y cost-reader no se conceden al backend.
   Resolver monitor de backlog/disco y conciliación del journal del broker.
4. Seleccionar clínicas, cuentas, ubicaciones y conexiones; inventariar sus
   lectores alternativos. `oauth.routes.js` descubre cuentas/fichas con tokens
   legacy mientras no haya registros; con el primer registro el nuevo listado
   usa solo grants y bloquea globalmente remapeo/discovery legacy (ver ampliación).
   `push_ops_google_business_profile.js` renueva, consulta detalles,
   reseñas/posts y escribe en OPS. OPS queda aplazado por el usuario, sin migrar
   ni cambiar su runtime; no está autorizado ejecutarlo desde esta tarea.
   Todos los cron OPS exigen además `OPS_BRIDGE_ENABLED=true`; conservar el
   token o la URL configurados no los activa. El gate no afecta a los jobs
   nativos `businessProfile*` que alimentan Perfil de Empresa dentro del CRM.
   Pausarlos para ese ámbito o migrarlos antes de declarar una única fuente.
   El registro independiente impide que borrar/recrear el mapping reactive los
   dos jobs legacy. El alta/reasignación/desconexión OAuth aún necesita su
   operación del broker para actualizar o revocar el grant; mantenerla pausada
   en el canary hasta adaptar el ciclo de vida completo.
5. Aprobar copia/movimiento real de credenciales y mantenimiento del scope.
   Respuestas a reseñas, fotos, horarios, Google Ads, Search Console y GA4
   siguen siendo cohortes separadas: aún impiden retirar la credencial Google
   compartida del backend. No copiar tokens WhatsApp/Meta revocados.
6. Pausar/drenar los lectores afectados sin modificar el resto de los flags;
   respaldar esquema, mappings y cachés. Aplicar **solo**
   `20260913000000-add-business-profile-broker-read-binding.js` antes de cargar
   el modelo nuevo en procesos usados. Migración aditiva: columnas/CHECK y tabla
   independiente sin FK; son dos DDL MySQL y no se promete atomicidad conjunta.
   Si falla entre ellos, conservar el respaldo y conciliar esquema antes de
   reintentar. No migra filas ni secretos. DEV/staging comparten BD. Ensayar la
   restauración privada; evitar `db:migrate` global y promotion completa de DEV.
7. Instalar contratos compatibles, probar TLS/auditoría con ficticios en el
   destino aprobado, habilitar gate/firmas/grants y escribir atómicamente el par
   de referencias y su registro independiente para
   el canary acordado. Aprobar por separado cualquier lectura/refresh real.
   Verificar cachés, una fuente por lector, errores, coste y bloqueo durable.

Coste: no se contrata infraestructura adicional. Cada comando puede hacer
cuatro llamadas SM de metadata/valor y genera normalmente dos eventos S3;
renovación según caducidad, no cada lectura. Cuantificar volumen de clínicas,
páginas y jobs y su factura incremental con el colector de costes/Ajustes ya
preparado. Sus gates/cache/job no cambian. El Budget reportado de 60 USD es una
alerta, no un límite; etiquetas, filtro y factura efectivos no están verificados.

Rollback: pausar lecturas afectadas, conservar referencias y bloqueos y volver
al último código compatible con ese marcador. Apagar el gate **detiene** una
ubicación gestionada. No borrar columnas/referencias/registro ni reactivar tokens DB
para recuperarse automáticamente. `down` rechaza ubicaciones marcadas o
registros independientes, incluso si el mapping ya no existe. Retirar ambos
solo con rollback de cohorte explícito y jobs drenados. Conservar
outbox/receipts y el hotfix de getAssetStats. Push no realiza este lote.

## Evidencia y pendientes globales

QA: suite completa del broker (incluye runtime TLS propio, SDK/proveedor
ficticios, scopes/cursor/renovación/revocación tardía, reinicio, backpressure,
auditoría y timeout), cinco tests del adaptador, ocho comprobaciones MySQL
8.0.42 con migraciones/modelos y fuente real de jobs, y regresión del hotfix.
Red externa bloqueada; MySQL usa socket/datadir propios y sale con código 0.
No cambia UI: no se presenta una prueba Chromium previa como QA de este bloque.
Resultados/hashes/comandos y SHAs publicados en `gbp-offline-qa.json` y
`gbp-publication.json`, privados bajo `/home/ubuntu/qa-evidence/security-migration-20260912/`.

El apartado nuevo de `13-backend.md` se escribe primero en backend y se refleja
exactamente en frontend. Los cuerpos anteriores ya divergían; copiar todo el
archivo habría incorporado documentación ajena de publicidad. Ese desfase
preexistente queda separado del corte, con hashes en `gbp-api-mirror-drift.json`,
para conciliación por el integrador. No se declara igualdad de los dos archivos
completos ni se arrastran esas diferencias con esta publicación.

Siguen pendientes todas las migraciones reales, otros consumidores, alta OAuth,
webhooks, cobertura completa de auditoría/accesos/permisos, verificación AWS,
retención, conciliación Budget y el corte/restauración de la BD compartida.
