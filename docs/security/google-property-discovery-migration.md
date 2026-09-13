# Google: listado de propiedades registradas mediante broker

Preparación local del 13/09/2026 sobre backend `9b576a86` y frontend `83e30496`.
Runtime migrado: **cero**. No despliegue, migración compartida, AWS ni llamadas
Google/Meta/WABA reales. OPS aplazado; apagado EC2 anunciado, sin verificar.
Este bloque amplía las lecturas SC/GA preparadas y sus fronteras de credenciales.

## Operaciones y autorización del proveedor

| Operación nueva | Petición fija | Campos permitidos |
|---|---|---|
| google.search_console.discovery.read.v1 | GET www.googleapis.com/webmasters/v3/sites/{siteUrl codificada} | siteUrl exacta, permissionLevel |
| google.analytics.discovery.read.v1 | GET analyticsadmin.googleapis.com/v1beta/properties/{id} | name exacto, displayName, propertyType, parent, account |

Payload exclusivamente `{}`. El recurso se obtiene de la política aprobada y el
grant exacto principal/tenant/conexión/activo. Se mantienen los cohortes
`google-search-console-read-v1` y `google-analytics-read-v1`: cinco y diez
operaciones respectivamente, incluyendo las lecturas anteriores. La nueva
operación necesita un grant explícito; actualizar código no amplía los grants
instalados. No admite cuentas, URL, campos o paginación elegidos por el caller.

SC admite siteOwner/siteFullUser/siteRestrictedUser; un sitio no verificado o
una identidad distinta falla. Sites.get utiliza los scopes SC ya admitidos.
[Referencia Sites.get](https://developers.google.com/webmaster-tools/v1/sites/get),
[recurso Sites](https://developers.google.com/webmaster-tools/v1/sites).

GA consulta una propiedad y proyecta su cuenta/parent como identificadores;
no consulta ni enumera cuentas, streams u otras propiedades. Tipos admitidos:
PROPERTY_TYPE_ORDINARY, PROPERTY_TYPE_SUBPROPERTY y PROPERTY_TYPE_ROLLUP.
Rechaza propiedades eliminadas, nombre distinto, parent/cuenta no canónicos,
etiqueta vacía, controles o más de 100 unidades UTF-16. GA Admin documenta
analytics.readonly o analytics.edit; esta lectura exige **analytics.readonly**
en el secreto v3 y en los scopes del access token renovado/cacheado. El scope
analytics admitido por los informes no basta para esta operación. Si Google
omite scope al renovar, se conservan los scopes del secreto aprobado.
[properties.get](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/get),
[recurso Property](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties).

TLS estricto, sin redirecciones, timeout de transporte Google 8 s, máximo 2 MiB
crudos; proyecta campos cerrados y comprueba que no incluyan secretos. Refresh,
Secrets Manager y KMS siguen confinados al broker. Las operaciones son lecturas
con persistResult=false: datos de propiedad no se guardan en comandos/auditoría.
Conservan auditoría v2 del principal de servicio y bloqueo durable tras reinicio.
No implementa todavía auditoría completa de usuario/denegaciones del listado.

## API y controles de ámbito

`googlePropertyDiscovery.service.js` consulta registros independientes y mappings
por ID, clínica y conexión, con columnas de metadata. Los lectores SC/GA vuelven
a comprobar mapping activo, identidad Google única y ambos tokens SQL NULL.
Un contexto opaco no concede acceso cuando cambia cualquiera de esos vínculos.

| Endpoint | Contrato preparado |
|---|---|
| GET /oauth/google/assets | success, assets[{siteUrl,permissionLevel,propertyType}], total; añade inventory_mode=broker_grants |
| GET /oauth/google/analytics/properties | success, accounts[{accountName,accountDisplayName,properties:[{propertyName,propertyDisplayName,propertyType,parent}]}]; añade inventory_mode=broker_grants |
| GET /oauth/google/analytics/connection-status | connected=true solo tras verificar las propiedades registradas; hasAccounts/accounts restringidos al inventario; verification=registered_properties_read e inventory_mode=broker_grants |
| GET /oauth/google/connection-status | El flujo OAuth gestionado existente conserva su contrato. Fuera de él, el primer registro de una cohorte cierra la rama legacy antes del resolver que carga credenciales: connected=false/reason=google_oauth_legacy_closed, HTTP 409 |

GA agrupa el identificador accounts/N como accountSummaries/N para mantener la
forma anterior. accountDisplayName muestra **accounts/N**, no un nombre de cuenta
inventado ni datos obtenidos enumerando cuentas. El estado GA no devuelve
caducidad de token ni certifica autorización de todo Google/OAuth.

Los tres endpoints de inventario/estado GA requieren ámbito explícito y permiso
de gestión write. Para GA status este requisito se endurece respecto a su lectura
anterior. El middleware inicial conserva 400/401/403. La rama gestionada exige
sesión administrada vigente (sessionVersion=1, jti y actor original), vuelve a
autorizar **todas** las clínicas del grupo y exige la misma conexión y el mismo
conjunto de clínicas antes/después de cada llamada y al terminar. Cambios durante
la petición descartan la respuesta completa. Cabecera private, no-store.

Sin conexión, los listados conservan 404; el estado GA conserva 200 con
connected=false/reason=no_connection.

Errores del nuevo recorrido: 401 google_discovery_session_required;
403 google_discovery_scope_forbidden; 409 broker_binding_invalid,
broker_discovery_scope_unconfigured, broker_discovery_limit o
google_oauth_legacy_closed; 503 para cohorte apagada, registros inaccesibles,
fallos de proveedor/credenciales, timeout o saturación. Desconocidos:
google_discovery_unavailable. No refleja mensajes SQL/proveedor en respuesta
ni registra sus cuerpos en estos handlers.

Máximo **20 mappings** por petición, cuatro peticiones concurrentes por proceso
API, 60 s cooperativos para el listado y timeout por llamada al broker hasta
30 s/restante. Los registros se vuelven a consultar y todos los mappings se
validan antes de entregar. El plazo no cancela consultas SQL pendientes; su slot
se retiene hasta finalizar. No se entrega una página o lista parcial. El contrato
tiene además un techo de 1 MiB de salida. No hay retry automático de discovery.

GA mantiene varios mappings de una propiedad, cada uno con grant de su clínica;
verifica cada uno y deduplica únicamente la propiedad pública idéntica. Un vínculo
bloqueado dentro del ámbito solicitado impide el listado completo; un vínculo de
otra clínica excluida no bloquea el suyo. No modifica assignments, inventario
compartido, mappings ni reglas de publicidad.

**Límite SC existente:** su registro conserva un mapping original por hash de
propiedad. Este bloque no cambia esa clave ni incorpora clones legítimos de SC.
El listado exige registros cuya clínica origen esté dentro del ámbito autorizado;
no incorpora referencias compartidas de clínicas origen externas a ese ámbito.
Esos casos requieren ampliar el registro/discovery y su contrato antes del corte.

## Frontera legacy y alcance pendiente

Los listados sin ningún registro gestionado conservan la vía legacy, con loader
SQL condicionado por NOT EXISTS de registros OAuth/SC/GA por ID o subject.
Se comprueban además los cierres globales OAuth/SC/GA/GBP antes y después de
cada petición, incluida renovación; una respuesta de refresh no se guarda si
aparece un marcador. La actualización usa la frontera SQL existente. GA legacy
limita la enumeración a 20 páginas de 200 cuentas, 60 s y 1 MiB agregado; cursores
repetidos o forma inválida impiden entregar cuentas parciales. SC legacy limita
1.000 entradas/1 MiB. No son rutas migradas en runtime.

El primer registro, aun bloqueado o con gate apagado, excluye el listado legacy
global. Un ámbito sin registros propios devuelve conflicto; no reutiliza tokens
SQL ni enumera propiedades ajenas. El corte debe drenar peticiones anteriores:
los chequeos separados de SQL no constituyen una transacción distribuida con
Google. Los controles de publicación/corte no se sustituyen por este código.

Preparado el listado de **propiedades previamente registradas**. Siguen pendientes
alta de propiedades, remapeo, OAuth SC/GA completo, desconexión y conciliación de
esos flujos, UI de ciclo de vida y estado general compatible con todas las
cohortes. El estado Google genérico legacy se cierra, por lo que **no se autoriza
activar todavía el flujo completo de Ajustes**. Otros resolvers/loaders, Ads,
Meta y WABA no se consideran migrados. No se modifica código frontend ni se
presenta esta QA HTTP como una validación visual o una conexión real.

## Esquema, coste y lote pendiente

No crea migración, variable, proceso, job o recurso. Necesita las migraciones ya
preparadas: registros GBP/revocación, OAuth 20260913020000, SC 20260913030000,
GA 20260913040000 y sus dependencias **antes del código incluso con gates
apagados**. No se ejecutó ninguna en BD compartida. Conserva las reglas de down
que impiden eliminar registros activos o bloqueados. No cambia el hotfix ni OPS.

Coste técnico: una lectura Google por mapping registrado; SDK Describe/Get de
secreto y cliente por operación (cuatro lecturas metadata/valor), con refresh
cacheado en el broker. Estado GA y listado son dos peticiones independientes;
una pantalla que llame a ambos puede generar hasta 40 lecturas para 20 mappings.
Los límites son por proceso, no cuotas globales. Latencia, cuotas y costes AWS
reales requieren canary, Cost Explorer/filtros y revisión del Budget. No cambia
el cálculo ni la caché de Ajustes, y no presume gasto cero o Budget verificado.

Antes de activar: aprobar lote con consumidores/sesiones registrados, migraciones
concretas y respaldo, corte/drenaje de legacy, destinos y separación de claves/
audiences/estado, grants discovery exactos, scope readonly GA, secretos v3 sin
credenciales SQL, control de origen/IAM y auditoría funcional. Medir el canary
aprobado con rollback al bloqueo; no devolver tokens a la API para recuperar
funcionalidad. EC2 está con apagado anunciado y no se ha consultado.
Retención DPD, permisos, Budget/CloudFormation y cifrado/restauración/corte BD
mantienen sus pendientes y aprobaciones anteriores.

## QA aislada

174 tests Node: 79 broker con Node 24.21.0 y 95 backend con Node 22.17.0;
23 tests nuevos de adaptador/HTTP y cuatro nuevos de broker, sin duplicar recuentos.
TLS real local en ambas cohortes, clientes firmados y lectores reales, proveedores/
SDK ficticios, proyección, scopes, denegación antes de SDK, pérdida de permisos,
sesión/conexión/grupo, presión concurrente y persistencia del bloqueo al reiniciar.
Pruebas anteriores de OAuth/GBP/SC/GA/frontera SQL y getAssetStats incluidas.

MySQL temporal propio, sin networking, en cuatro bases: 16 comprobaciones GA,
14 SC, ocho de frontera legacy y once OAuth; 49 en total, con cierre 0. Incluye
repositorios/modelos reales, filtros de ámbito, varios mappings GA, desactivación
SQL durante lectura y ausencia de columnas de credenciales en consultas gestionadas.
Tres contratos adicionales: scheduler (46 jobs), caducidad GBP y multigrant.
No bootstrap de modelos/BD normal, PM2, migración real, AWS ni proveedor real.

Evidencias privadas: /home/ubuntu/qa-evidence/security-migration-20260912/
property-discovery-*.json y .log (directorio 0700, archivos 0600). No se publican
secretos, dumps o sesiones. Publicación selectiva a DEV según apartado 5 del
runbook, con padres/rango completo revisados y SHA remoto comprobado; push no
es despliegue. El acta privada de publicación contiene los SHAs finales.
