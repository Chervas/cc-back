# Search Console y GA4: cierre de credenciales legacy

Preparado el 13/09/2026 sobre backend `54a9f151` y frontend `82233de0`.
Implementación y QA locales; ninguna conexión real migrada ni despliegue.
OPS aplazado por el usuario. Apagado EC2 anunciado, sin comprobar su estado.

## Comportamiento implementado

`googleLegacyCredentials.service.js` consulta únicamente ID/subject y el registro
independiente `GoogleOAuthBrokerBindings` antes de cargar una credencial legacy.
Un marcador coincidente por ID **o identidad Google** cierra esa fuente incluso
con los gates OAuth/GBP apagados. Protege IDs recreados y otra fila SQL con el
mismo subject. El registro no tiene FK con cascada hacia la conexión.

La consulta que selecciona tokens contiene además un `NOT EXISTS` contra ese
registro. La escritura de un access token renovado repite la exclusión dentro
del propio UPDATE y fija el subject esperado. Una inserción de marcador entre
la comprobación de metadata y esas consultas no habilita la lectura/escritura.
Modelo/tabla ausente, identidad desconocida o error SQL fallan de forma cerrada.

Antes de cada petición OAuth/SC/GA cubierta y después de su respuesta se vuelve
a comprobar la identidad. Un marcador concurrente descarta la respuesta y las
siguientes llamadas desde caché. No se registra el cuerpo, cabeceras o mensaje
del proveedor. No hay bypass por variable de entorno ni fallback si falla SQL.

| Consumidor | Cobertura preparada |
|---|---|
| `web.routes`: status | Conexión gestionada: `googleConnected:false`, motivo fijo; no refresca OAuth |
| `web.routes`: sc/pages | Comprobación por cada mapping y llamada, contrato parcial existente; 409 si todos fallan |
| `web.routes`: psi/refresh | URL Inspection OAuth queda bloqueada; PSI y checks técnicos independientes conservan su recorrido y `indexed_ok:null` |
| `sync.jobs`: webSync | Timeseries, queries por intervalos e inspección URL; caché por conexión revalidada |
| `sync.jobs`: web backfill general/por sites | Reutilizan el recorrido protegido de webSync |
| `sync.jobs`: analyticsSync | Informe diario y ocho familias de dimensiones; cada petición revalida |
| `sync.jobs`: analytics backfill general/por propiedades | Reutilizan analyticsSync y propagan fallo cuando no se procesa ninguna propiedad |
| `_ensureGoogleAccessToken` compartido | La carga inicial legacy de los jobs GBP también pasa por la exclusión; sus lecturas gestionadas conservan el adaptador previo |

Cuando fallan todas las propiedades GA, SyncLog/resultado devuelven `failed`.
Un cierre de identidad entre dimensiones aborta las siguientes consultas y
marca fallida esa propiedad. Filas ya persistidas antes del cierre se conservan;
la sincronización completa no se convierte en una transacción atómica.

## API y límites

Se mantienen URLs, permisos por clínica, selección del mapping y DTO de negocio.
`GET /web/clinica/:clinicaId/sc/pages` conserva `authorization_errors` y, si fallan
todos los mappings, 409 `web_mapping_authorization_unavailable`. Códigos nuevos
de la frontera: `google_oauth_legacy_closed`, `google_connection_missing`,
`google_connection_changed`, `google_credentials_unavailable`. Los errores de
caducidad/mapping web ya existentes siguen siendo válidos. El status informa
metadata de disponibilidad legacy; no demuestra acceso real al proveedor.

**Esto prepara un bloqueo, no migra las lecturas SC/GA al broker.** Las conexiones
sin marcador continúan legacy. La reautorización fijada sigue rechazando activos
SC/GA/Ads activos con `google_oauth_consumers_pending`. No se han relajado los
grants ni añadido operaciones genéricas. La siguiente cohorte debe implementar
operaciones cerradas, referencias/grants propios, auditoría y adaptadores.

Discovery/mapping de SC/GA en `oauth.routes.js` conserva su guard previo; el
resolver legacy puede hidratar una conexión antes de llegar a ese guard.
Google Ads, conversiones, otros loaders y scripts no quedan cubiertos por esta
frontera. El inventario delta `google-web-credentials-consumers.json` distingue
las entradas preparadas de esos pendientes; no sustituye el inventario global.
El inventario de mappings usado por `/web` no selecciona GoogleConnections;
otras funciones de `effectiveMarketingAssets` sí tienen consumidores legacy.

Una credencial obtenida antes del marcador puede haber iniciado una petición:
la comprobación posterior no deshace esa llamada ni recupera memoria de otro
proceso. El corte exige drenar callbacks/jobs/lectores antiguos y retirar sus
credenciales. No hay cancelación distribuida ni aislamiento IAM nuevo en esta
fase. Un administrador capaz de borrar todos los marcadores aún puede eliminar
la barrera SQL: separación de principales sigue siendo requisito del corte.

No se añade un evento de auditoría externa. SyncLog y errores cerrados son
registros operativos; la auditoría de actor/scope/lecturas y los rechazos previos
a admisión siguen pendientes para estas verticales.

## Base de datos, coste y lote futuro

No hay migración nueva. `20260913020000` y sus dependencias deben estar aplicadas
antes del código, **incluso con todos los gates apagados**. En una instalación
sin esa tabla se cerrarán SC/GA y la carga inicial GBP legacy. La migración solo
se ha ensayado en MySQL propio; la BD compartida no ha cambiado.

Cada comprobación usa dos consultas de metadata; una carga nueva hace cinco
consultas y cada petición añade cuatro. Se conservan cachés de credenciales
legacy, sin cachear autorizaciones. Hay sobrecoste SQL/latencia pendiente de
medir en canary. Esta fase no añade recursos AWS, llamadas facturables AWS,
jobs ni cambios de horario/pausa; no acredita coste real o ahorro por apagado.

Antes del despliegue: aprobar el corte exacto de receptores/consumidores,
dependencias de esquema, respaldo, drenaje de operaciones, retirada de tokens,
ventana y canary. No borrar marcadores ni restaurar tokens para rollback:
conservar el cierre y aplazar la cohorte que no esté preparada. No ejecutar
`db:migrate` general sobre DEV/staging compartidos.

Permisos/retención DPD, conciliación Budget/CloudFormation, Cost Explorer/tags,
cifrado de la BD y todas las cohortes reales siguen pendientes. No se han usado
AWS, sesiones SSO, proveedores reales, Meta/WABA ni credenciales alternativas.

## QA reproducible

Evidencias privadas fuera del repositorio:
`/home/ubuntu/qa-evidence/security-migration-20260912/google-legacy-credentials-*`.

- 47 tests Node: frontera, HTTP propio, métodos reales de sync/backfill,
  regresiones GBP/OAuth y once pruebas del hotfix getAssetStats.
- Ocho comprobaciones MySQL 8.0.42 en directorio/socket propios, TCP apagado,
  modelos y migración reales, SELECT/UPDATE con inserciones concurrentes,
  reconstrucción del servicio, identidad cambiada y esquema ausente. Cierre 0.
- Contratos independientes de scheduler (46 jobs), caducidad/reintentos GBP y
  consumidores multigrant, con modelos ficticios instalados antes de imports.
- Proveedor inyectado, sentinelas ficticios y guard de red en todos los ensayos.
  Ningún test usa la BD compartida, Redis o un servicio publicado.

No hay cambios de UI, por lo que no se repiten build Angular/Chromium. Las
pruebas HTTP preservan el DTO y la autorización; no prueban una sesión real.
