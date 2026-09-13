# OAuth de Search Console y GA4 en el broker

Preparado el 13/09/2026 sobre backend 70e3ce63 y frontend e3a9672a. Código y
pruebas ficticias; cero conexiones reautorizadas o migradas en runtime. Sin
AWS/proveedor real, BD compartida, configuración instalada ni despliegue.
OPS aplazado; apagado EC2 anunciado por el usuario, sin verificar.

## Capacidad nueva y límite de integración

Las cohortes google-search-console-read-v1 y google-analytics-read-v1 admiten
ahora OAuth fijado a identidad, propiedad y política dentro del broker. Reutiliza
el motor de staging/activación/conciliación existente de GBP y su tabla SQLite.
No añade una operación genérica ni devuelve credenciales a la API general.

La [integración SQL/API/Ajustes por servicio](google-oauth-services-migration.md)
queda preparada en el bloque posterior: selección explícita, comprobación de
consumidores, captura humana v10, callback/estado y UI. Mantiene la política GBP
histórica y permite una política nueva por servicio/identidad. Requiere DDL y
configuración del lote aprobado; cero conexiones reales migradas. La instalación
del runtime, permisos AWS, nuevos bindings/grants y despliegue siguen pendientes.
La [desconexión durable SC/GA](google-property-disconnect-migration.md) permanece.

## Protocolo interno cerrado

Cada prefijo admite begin.v1, finish.v1, activate.v1, status.v1 y abort.v1:

| Prefijo | Proveedor de política | Activo |
|---|---|---|
| google.search_console.oauth. | google_search_console | sc:SHA256(siteUrl canónico) |
| google.analytics.oauth. | google_analytics | ga4:propertyId |
| google.business_profile.oauth. | google_business_profile | GBP existente, sin cambiar nombres |

OPERATIONS/PREFIX del contrato OAuth histórico siguen representando GBP.
operationsFor(provider) y controlsFor(provider,engine) seleccionan exclusivamente
los nombres de la cohorte conocida. OPERATIONS de lectura SC/GA permanece sin
OAuth; no se añaden capacidades a lectores por reutilizar esa lista.

Begin recibe únicamente state aleatorio; finish flowId, state y code; activate,
status y abort únicamente flowId. RequestId, tenant, conexión y activo forman
parte del transporte firmado y los grants exactos. No acepta scopes, redirect,
ARN de secreto, URL de destino o credencial en payload. Un nombre de otra
vertical no recibe permiso; una propiedad fuera de la política falla scope_denied.

La política de conexión puede incluir oauth.subject/redirectUri/scopes. En SC/GA,
subject debe coincidir con googleSubject; redirect HTTPS canónico con ruta exacta
/oauth/google/callback, sin credenciales, query, fragmento o puerto explícito.
Los grants OAuth necesitan un tercer principal y clave Ed25519, distintos de
lectores y revocadores, incluso lectores deshabilitados. Se compara clave
pública canónica, no solo keyId/PEM. La política sigue siendo de una cohorte por
runtime; la convivencia operativa del conjunto aún requiere el lote correspondiente.

Una configuración de solo lectura sigue válida y no obtiene grants OAuth.
Solo se construye el motor si alguna conexión trae oauth revisado. No hay nuevo
flag/archivo .env ni configuración real modificada en este bloque.

## Permisos, identidad y credenciales

SC solicita exactamente openid, email, profile y webmasters.readonly; GA solicita
openid, email, profile y analytics.readonly. El arranque rechaza permisos de
Ads, Business Profile, escritura o la otra vertical en estas configuraciones.
Los scopes elegidos permiten las lecturas documentadas por Google:
[Search Console Sites.get](https://developers.google.com/webmaster-tools/v1/sites/get)
y [GA Admin Properties.get](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/get).

Conserva state de un solo flujo, PKCE S256, login_hint y verificación posterior
de identidad mediante userinfo antes de persistir el refresh token. Código,
state y verifier no van a SQLite ni a auditoría; solo hashes y referencias.
PKCE pendiente se mantiene en memoria y se pierde al reiniciar: no se reintenta
el intercambio de un código de resultado incierto ni se recupera desde SQL.

La solicitud mantiene access_type=offline e include_granted_scopes=true del
[flujo web de Google](https://developers.google.com/identity/protocols/oauth2/web-server).
Google puede devolver permisos concedidos previamente más amplios que los
solicitados; el broker conserva los scopes recibidos y mantiene operaciones/grants
cerrados. No se afirma que el token real quede limitado exclusivamente a cuatro
scopes ni que renovar invalide la credencial anterior. GBP conserva su política
anterior de scopes; no se han ampliado permisos reales de ninguna cohorte.

Secretos v3 usan provider de la cohorte, connectionRef, googleUserId y clientId
exactos. SC/GA rechaza v2, proveedor diferente o identidad/client distintos.
Un v3 válido previo que carece de los scopes ahora solicitados sirve como versión
base para CAS, pero devuelve reusable=null: fuerza consentimiento y exige un nuevo
refresh_token. No falla el inicio por ser una configuración de lectura previa,
y tampoco usa su refresh como fallback. Con un v3 completo y no revocado, un
nuevo intercambio sin refresh_token puede reutilizar el refresh conocido; evita
consentimiento forzado repetitivo. V2 sigue siendo solo baseline GBP sin reutilización.

## Persistencia, reintentos y bloqueos

Finish guarda el candidato en el secreto preasignado, versión=flowId y etiqueta
AWSPENDING. Activate verifica digest y versión base antes de mover AWSCURRENT,
y relee esa versión exacta antes de confirmar. Nunca CreateSecret, ARN arbitrario,
lectura de tokens SQL ni retorno de tokens a la aplicación.

Flujos SC/GA añaden provider/googleSubject a su huella de configuración. La huella
GBP anterior se conserva para no invalidar sus flujos pendientes por este cambio.
Flujo queda ligado a principal, tenant, conexión, activo, identidad y configuración.
Status concilia staging/activating tras reinicio o ACK perdido, sin volver a
intercambiar el código; abort conserva tombstone ante un begin tardío.

Activating impide lecturas hasta conciliar. Al confirmar se incrementa revision,
se invalida el caché y se abortan lecturas en curso del runtime; una respuesta
con revisión antigua no se entrega. Activar credenciales no cambia estado de
conexión ni borra asset_revocations: bloqueos de clínica/propiedad, conexión
bloqueada/revocada o caducada permanecen. Una revocación mientras AWS procesa
la activación no deshace esa escritura ya enviada, pero el acceso sigue bloqueado.
Metadata accessBlocked lo refleja; no hay una operación implícita de reactivación.

Se conservan límites del motor: ocho ejecuciones simultáneas, 128 estados PKCE,
señal de aborto a los 25 s, caducidad de inicio de diez minutos y límites de versiones
por conexión. Auditoría v2 guarda referencias, servicio iniciador y correlación,
no atribuye por sí sola un usuario humano. Fallo de captura final conserva staging/
activating para conciliar. No cambia el esquema del lector de auditoría.

## Costes y corte real pendiente

OAuth implica llamadas a Google durante finish y lecturas/escrituras de versiones
en Secrets Manager, además de auditoría S3/KMS. El flujo normal ensayado hace un
PutSecretValue y un UpdateSecretVersionStage; reintentos inciertos requieren
consultar versión/digest, y no se extrapola un precio de la prueba ficticia.
Ajustes conserva su caché de costes/estados pendientes. Cost Explorer, etiquetas,
Budget/CloudFormation y medición de volumen real siguen sin verificar.

El rol runtime reportado carece de permisos de escritura/etapas de Secrets
Manager. No se ha consultado ni cambiado IAM. El lote posterior debe concretar
servicios/commits, secretos y clientes por cohorte, permisos mínimos, identidad,
red/TLS, copia/restauración del estado, versiones previas, capacidad/cuotas,
canary y rollback. Ninguna autorización para AWS/SSO, mover secretos o desplegar
se deriva de esta preparación local ni del push a DEV.

No nueva DDL SQL/SQLite; las migraciones compartidas del runbook permanecen
pendientes. No devolver tokens a SQL, reactivar Meta/WABA ni borrar bloqueos,
flujos o auditoría durante rollback. Conservar candidatos/versiones y reparar
la cohorte en estado cerrado. Auditoría completa, otras cohortes, retención DPD,
IAM, costes y cifrado/restauración/corte BD siguen abiertos.

## QA y entrega

255 tests Node: 123 broker con Node 24.21.0 y 132 backend con Node 22.17.0,
guardas offline y dependencias ficticias. El conjunto original de diez pruebas
OAuth se ejecuta ahora para GBP, SC y GA, incluido runtime HTTPS local firmado
con activación después de reinicio. Diez pruebas adicionales SC/GA cubren
separación de claves y scopes, baseline v3 parcial, inputs/capacidades ajenos,
revocación durante activación y lectura con token anterior descartada.

Se verifica PKCE/identidad, ausencia de secretos en SQLite/auditoría, refresh
conocido, conexión caducada/revocada, pérdida de ACK de staging/activación,
auditoría fallida, callbacks concurrentes, abort tardío y reinstancia. Conserva
la regresión de lectores/desconexión y el hotfix getAssetStats. Sin nueva QA
MySQL/UI porque no cambian SQL, modelos, handlers o componentes; las 79 pruebas
MySQL del bloque anterior acreditan aquel corte, no reautorización SQL SC/GA.

Un primer test nuevo esperaba invalid_request para una propiedad ajena; se
corrigió a scope_denied, contrato existente de resource(). La suite final completa
pasó sin cambiar esa denegación. Evidencia privada property-oauth-* en
/home/ubuntu/qa-evidence/security-migration-20260912/ (0700/0600): pruebas, hashes,
API espejo, allowlist, rango y SHAs remotos. [Delta](google-property-oauth-consumers.json).
Publicación propia/selectiva a DEV según runbook; push no despliega. La tarea
integral y el ciclo API/UI SC/GA no están completos.
