# Control de revocación de propiedades Search Console y GA4

Preparado el 13/09/2026 sobre backend `78728e72` y frontend `9fd67667`.
Consumidores migrados en runtime: **cero**. Código y pruebas aisladas;
sin despliegue, AWS, proveedor real, cambios de pausas ni migración compartida.
OPS continúa aplazado. Apagado EC2 anunciado por el usuario, sin verificar.

## Operaciones del broker

| Operación | Proveedor y activo | Entrada y salida |
|---|---|---|
| `google.search_console.asset.revoke.v1` | `google_search_console`, `sc:<SHA256 del siteUrl canónico>` | payload `{}`; `data: {revoked: true}` |
| `google.analytics.asset.revoke.v1` | `google_analytics`, `ga4:<propertyId>` | payload `{}`; `data: {revoked: true}` |

Se ejecutan mediante el transporte firmado existente. El grant debe coincidir
con principal, `clinic:<id>`, connectionRef, assetRef y operación. El arranque
valida que el activo figura en la política de esa conexión y cohorte. No admite
operaciones de otras verticales, restauración, payload arbitrario o grants de
grupo. Las listas `OPERATIONS` de lectura conservan cinco operaciones SC y diez
GA; `REVOKE_OPERATION` se exporta por separado. Ningún lector gana control por
utilizar la lista existente.

Las cohortes `google-search-console-read-v1` y `google-analytics-read-v1` aceptan
grants explícitos de esta operación además de sus lecturas. No se modifica una
política instalada. El principal de control y su clave pública Ed25519 deben
ser distintos de todos los lectores de la configuración, aunque lean otra
conexión o un lector esté deshabilitado. Cambiar solo principal/keyId, PEM o
nombre de archivo con la misma clave no separa capacidades. Un principal de
control tampoco puede recibir lecturas. Las configuraciones antiguas de lectura
siguen siendo válidas y no reciben grants nuevos automáticamente.

## Persistencia, peticiones en curso y ámbito

Reutiliza `BrokerStore.revokeAsset`, la tabla SQLite `asset_revocations` y el
control `revoke_asset` existentes. Una transacción IMMEDIATE guarda el bloqueo,
los eventos requested/revoked y el resultado del comando. WAL/FULL y los bloqueos
permanecen al reiniciar; cargar initialState=active no los elimina. No añade
esquema SQLite ni una operación de reactivación o limpieza.

La clave del bloqueo es **(tenant, conexión, activo)**. Otras clínicas, otras
conexiones y otras propiedades conservan sus grants. Varios mappings SQL que
usan esa misma tupla comparten el bloqueo: el protocolo del broker no lleva
mapping_id. La clave SQL por mapping del bloque anterior no añade una dimensión
de autorización al broker. Una futura baja desde la clínica destinataria deberá
respetar la asignación compartida y el propietario original; este control no
decide a qué mappings está autorizado a afectar un usuario.

Se abortan las lecturas en curso de la tupla dentro del proceso. Las comprobaciones
antes del despacho y después de awaits consultan además SQLite, por lo que una
segunda instancia del broker sobre el mismo archivo puede invalidar el resultado
sin compartir AbortController. Las pruebas usan dos conexiones SQLite reales
en el proceso de test, no dos servicios desplegados. Un GET ya recibido por Google
no se puede deshacer; se suprime la respuesta cuando se observa la revocación.
Un aborto local puede terminar la lectura con provider_timeout; solicitudes
posteriores reciben asset_revoked. El bloqueo de conexión conserva prioridad.

El control sigue permitido con la conexión bloqueada, caducada o revocada. No
obtiene el secreto, no invalida el token OAuth en Google y no vacía el caché de
credenciales compartido por otras clínicas. El mismo requestId/digest se puede
reintentar tras perder el ACK y devuelve replayed=true sin duplicar auditoría;
reutilizar el UUID con otra tupla produce idempotency_conflict. Una nueva solicitud
para una tupla ya bloqueada es idempotente en acceso y genera su propia auditoría.

Backlog sin espacio para los dos eventos devuelve audit_unavailable. Un fallo
al persistir el segundo evento revierte bloqueo, comando y primer evento. No
se devuelve confirmación de una transacción incompleta. Los límites existentes
del transporte, autenticación, nonces, tasa y concurrencia permanecen vigentes.

## Auditoría, costes y estado de la API

Auditoría de broker v2, `app/integrations/v2/`: integration.requested y
asset.revoked con actor de servicio de control, clínica, referencias, operación
y requestId. Las denegaciones autenticadas conservan su captura existente. No
incluye métricas, URLs de páginas, etiquetas de propiedades, tokens o identidad
humana inferida de la firma de servicio. El control no añade una nueva versión
del lector de auditoría ni sustituye la captura de plataforma del usuario.

Por comando nuevo confirmado: dos eventos del broker y un resultado pequeño en
SQLite, más las entregas S3/KMS del flujo existente. El replay no duplica estos
eventos; denegaciones y lecturas fallidas pueden añadir los suyos. La operación
en sí hace cero llamadas a Google o Secrets Manager. El arranque real del broker
sí verifica identidades AWS y construye clientes; sigue sujeto al lote aprobado.
Sin medición real de volumen, factura o latencia. Ajustes conserva su estado
de costes pendiente y caché existente; CE/tags/Budget/CloudFormation siguen abiertos.

**DELETE /oauth/google/disconnect aún no envía estos controles SC/GA.** El
encolado, worker, estado de confirmación y auditoría de usuario existentes cubren
GBP. Este bloque no amplía esa cobertura ni convierte una baja SQL legacy en
revocación del broker. Tampoco cambia rutas/UI, asignaciones, flags o jobs.

## Integración y corte pendientes

1. Implementar la intención durable SC/GA junto con desactivación SQL y assignment,
   con validación de todo el ámbito, overrides, mappings compartidos/primarios,
   referencias originales y auditoría humana. Resolver el efecto sobre todos los
   mappings de una misma tupla antes de crear el comando.
2. Añadir worker con lease/CAS, reintento del UUID original y confirmación junto
   con el evento de plataforma. Mantener bloqueos locales antes de enviar,
   durante indisponibilidad y tras borrar/recrear mappings o registros; cerrar
   fallback por identidad. Extender GET de estado y el contrato de UI completo.
3. Completar altas/remapeo, OAuth, desconexión y estado Google general. El arranque
   actual sigue eligiendo una cohorte por configuración; no se afirma convivencia
   desplegada de GBP/SC/GA en un único origen. Resolver transporte y política
   para el lote completo sin duplicar consumidores ni abrir un proxy genérico.
4. Aprobar migraciones SQL exactas y dependencias existentes, respaldo/restauración,
   drenaje, aislamiento de origen/IAM, secretos, identidades de lectura/control,
   instalación y canary. No activar el flujo parcial por disponer de la operación.

No hay nueva migración SQL en este bloque. Las migraciones GBP/OAuth/SC/GA y
`20260913050000`, junto con auditoría/sesiones, siguen pendientes en la BD
compartida. Ninguna se ha aplicado aquí. Rollback debe conservar SQLite/WAL y
los bloqueos; no volver a código que ignore asset_revocations ni reponer tokens
SQL. El fallo se contiene en la cohorte afectada y se repara conservando evidencia.
Otros consumidores, auditoría completa, retención DPD, IAM/Budget y cifrado,
restauración y corte real de BD siguen abiertos.

## QA y publicación

202 tests Node aprobados: 93 broker con Node 24.21.0 y 109 backend con
Node 22.17.0. Catorce nuevos tests parametrizados prueban separación de claves,
grants y payload, todas las lecturas después del bloqueo, tuplas independientes,
replay/digest/reinicio, esperas de secreto y proveedor, otra conexión SQLite,
rollback de auditoría, backlog y conexiones bloqueadas/caducadas/revocadas.

Los dos tests HTTPS locales existentes usan el cliente firmado y adaptadores
SC/GA reales con SDK/proveedores ficticios; prueban revocación, replay y lecturas
rechazadas tras reiniciar, conservando también la regresión de bloqueo de
conexión y confinamiento de tokens. El hotfix getAssetStats conserva hash y
sus once tests. No se han repetido MySQL ni QA visual: no cambia SQL ni UI.
Las 59 comprobaciones SQL del bloque previo siguen siendo evidencia de aquel
corte, no pruebas nuevas de esta desconexión SC/GA.

Evidencias privadas property-control-*.json/.log bajo
/home/ubuntu/qa-evidence/security-migration-20260912/ (0700/0600). El primer
ensayo nuevo detectó dos expectativas de error incorrectas en el test de activo
ajeno: el contrato existente devuelve scope_denied; se corrigió la expectativa
y la suite completa final pasó. No se cambió la denegación para hacerla pasar.

Publicación propia y selectiva a DEV según runbook, con manifiesto de archivos,
rango completo, hashes y SHAs remotos verificados en property-control-publication.json.
Push no aplica migraciones ni despliega. La migración general no está completa.
