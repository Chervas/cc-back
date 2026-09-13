# Inventario de consumidores y plan de corte

## 13/09/2026 — OAuth Ads preparado en broker, API y Ajustes

Google Ads se incorpora como cuarto servicio (google_service=ads), con identidad
fijada, PKCE/staging/activación y principal OAuth independiente. Comprueba todos
los grupos, aliases y clínicas de la credencial antes y después del callback;
revocaciones, pérdida de permisos o cambios de consumidores impiden activarla.
Credenciales actualizadas no acreditan acceso ni eliminan bloqueos anteriores.

DDL 20260913100000 amplía los dos ENUM OAuth; conserva las otras tres cohortes
y rechaza down si queda cualquier binding o solicitud Ads. No aplicada a la BD
compartida. Auditoría v10 admite Ads; catálogo de jobs sigue en 48, sin activar.
QA: 565 tests Node, 19 checks en un MySQL propio con cierre 0, build Angular y
18 capturas Chromium desktop/móvil con datos ficticios. Sin llamadas reales.

Alta/remapeo, otros consumidores, auditoría completa, costes/controles AWS,
cifrado BD y cortes reales siguen pendientes. OPS aplazado; ninguna conexión
real migrada. [Contrato y evidencia](google-ads-oauth-migration.md).

## 13/09/2026 — Baja Ads durable y auditoría v11

Desconexión Ads preparada en la transacción de mappings/assignment: registra
intención, bloquea bindings y captura auditoría humana; fallos de otras
integraciones revierten todo. Revisa grupos, overrides, aliases e historial
borrado; usos fuera del ámbito devuelven 409 sin cambios parciales. Worker
independiente confirma con el mismo UUID y conserva el bloqueo si pierde el ACK.

DDL 20260913090000 previa al código aun con gates apagados. Auditoría v11,
status agregado por ámbito y exclusión legacy por ID/subject incluso sin bindings.
QA: 352 tests backend + 47 de auditoría; 116 checks en nueve MySQL propios,
todos con cierre 0. Catálogo preparado de 48 jobs; ninguno activado. Hotfix intacto.

Cero cuentas migradas, AWS/proveedores reales, DDL compartido o despliegue.
OAuth Ads, otros consumidores, auditoría completa, costes y cifrado/corte BD
siguen pendientes; OPS aplazado. Contrato: `docs/security/google-ads-revocation-migration.md`.

## 13/09/2026 — Registro durable y consumidores de lecturas Ads

Sync/backfill conectados en código a las ocho lecturas Ads, con contexto opaco,
permisos de grupos/compartidos y revalidación SQL dentro de las escrituras.
Registro independiente por customer/mapping y exclusión legacy por ID/subject.
QA: 344 tests Node y 106 checks en ocho MySQL propios, todos con cierre 0;
hotfix conservado. DDL 20260913080000 obligatoria antes del código aun apagado,
pendiente en BD compartida. Sin AWS/proveedor real, despliegue, claves o flags.

Baja Ads y OAuth pendientes: desconexión gestionada rechazada con 503 antes de
cambios parciales. Cero cuentas migradas. OPS aplazado; continúan otras cohortes,
auditoría completa, IAM/retención/costes/Budget y cifrado/corte BD.

[Contrato y dependencias](google-ads-backend-migration.md).

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

[Contrato y dependencias](google-ads-read-broker.md).

## 13/09/2026 — Motor de lecturas Google Ads preparado en el broker

Cuatro lecturas Ads tipadas fijan cuenta/gestor, GAQL y campos; OAuth y developer
token permanecen en el broker. Paginación acotada en memoria y control de baja
con principal/clave separados. QA: 138 tests del broker, incluidos 15 nuevos Ads,
HTTPS local, 10.001 filas ficticias y bloqueo tras reinicio. Sin DDL, UI,
configuración instalada, AWS/proveedores reales o despliegue. Cero cuentas Ads
migradas: registro/adaptador backend, OAuth Ads, otros consumidores y corte real
siguen pendientes. OPS aplazado; IAM/retención/costes/Budget/BD pendientes.

[Contrato, QA y dependencias](google-ads-read-broker.md).

## 13/09/2026 — Cierre de credenciales antiguas en consumidores Google Ads

La carga/renovación Ads preparada consulta los marcadores durables de Google
antes de leer o guardar tokens. Sync/backfill revalida cada petición; Diagnostics
y Health comprueban sus cachés. Conserva selección clínica/grupo y grants ambiguos.
QA aislada: 238 tests Node, contrato de desconexión separado y 11 comprobaciones
MySQL con cierre 0. Hotfix conservado. Ads aún necesita su adaptador al broker;
los consumidores legacy sin marcador no están migrados. Sin nueva DDL, UI,
despliegue o proveedor real. Esquema Google previo obligatorio incluso apagado.
OPS sigue aplazado; costes/retención/IAM/Budget y corte de BD pendientes.

[Contrato, evidencia y límites](google-ads-legacy-boundary.md).

## 13/09/2026 — Reautorización Google por servicio en API y Ajustes

La reautorización preparada separa Business Profile, Search Console y Analytics
por cuenta/conexión, con sesiones gestionadas y permiso sobre todos los consumidores,
compartidos y primarios. Conserva solicitudes GBP antiguas, bloqueos y control de
identidad. API/worker capturan servicio y ámbito en SQL; callback y estado no
mezclan referencias. Ajustes ofrece estados y reautorización por servicio.

Auditoría v10 para la política nueva, con actor, ámbito, proveedor y compromiso
del conjunto de clínicas; v8 histórico conservado. QA ficticia: 180 tests Node
(133 backend, 41 auditoría, seis frontend), 92 checks MySQL en siete bases propias
con cierre 0, build Angular y 24 capturas Chromium desktop/móvil. Cuatro contratos
correctos, scheduler 47. Hotfix conservado. DDL 20260913070000 y dependencias antes
del código incluso con gates apagados; writer/reader v10 antes de emitir.

Cero migraciones compartidas, despliegues, configuración instalada o llamadas
AWS/proveedores reales. OPS aplazado; apagado EC2 anunciado sin verificar. Altas/remapeo generales, otras integraciones, auditoría completa, retención/IAM/costes/
Budget y cifrado/restauración/corte BD siguen pendientes. El push no activa flujos.

[Contrato, QA y corte pendiente](google-oauth-services-migration.md).

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

[Contrato, QA y pendientes](google-property-oauth-broker.md).

## 13/09/2026 — Baja durable SC/GA conectada a la API

Preparada la baja SC/GA desde API con intención SQL, bloqueo local y auditoría
v9 atómicos junto a los mappings/assignment. Comprueba compartidos y primarios,
preserva overrides y revierte todo si afecta fuera del ámbito. Worker con
lease/CAS y replay confirma el broker; el estado agrega GBP/SC/GA. Los marcadores
sobreviven a borrados/recreaciones y cierran legacy por ID/subject.

QA ficticia: 265 tests Node (132 backend, 93 broker, 40 auditoría), 79 checks
MySQL en seis bases propias con shutdown 0 y cuatro contratos, incluido scheduler
47 jobs. Hotfix getAssetStats conservado. Nueva DDL 20260913060000 y dependencias
antes del código incluso apagado; writer/reader v9 antes de emitir. Ninguna
migración compartida, despliegue, clave/grant instalado ni cambio de pausas/UI.

OPS aplazado y apagado EC2 anunciado sin verificar. Sin AWS/proveedores reales.
Altas/remapeo, OAuth/estado/UI generales SC/GA, otras cohortes, auditoría completa,
retención/IAM/Budget/Cost Explorer y cifrado/restauración/corte BD siguen pendientes.
Este bloque actualiza el estado de los apartados históricos siguientes.

[Contrato, QA y requisitos del corte](google-property-disconnect-migration.md).

## 13/09/2026 — Controles de revocación SC/GA preparados en el broker

El broker admite bloqueo durable de Search Console y GA4 por clínica/conexión/
propiedad, con grants y claves de control separados de lectura. Persiste bloqueo,
auditoría v2 y resultado juntos; replay tras reinicio y descarte de respuestas
posteriores a la revocación. No consulta secretos ni llama a Google para bloquear.

QA aislada: 202 tests Node (93 broker, 109 backend), incluido HTTPS local firmado,
reinicios, SQLite y hotfix getAssetStats. Sin nueva DDL ni QA MySQL/UI en este
bloque. DELETE Google, cola/worker, estado y auditoría humana SC/GA aún pendientes:
la desconexión durable conectada a la API sigue cubriendo GBP. Todas las
migraciones compartidas y despliegues siguen pendientes. OPS aplazado; sin AWS,
proveedores reales, cambios de pausas ni verificación del apagado EC2.

[Contrato y próximos pasos](google-property-revocation-control.md).

## 13/09/2026 — Propiedades Google con varios mappings y acceso compartido

SC conserva varios vínculos legítimos por propiedad mediante registro compuesto
site_hash/mapping_id, estados independientes y cierre de recreaciones/fallback.
Discovery SC/GA incorpora mappings compartidos/primarios vigentes del mismo
grupo con permiso de la clínica destinataria y grant del origen. Revalida el
inventario tras cada lectura y al terminar; no carga configuración de otros
proveedores ni altera assignments, publicidad o UI.

QA ficticia: 188 tests Node (109 backend, 79 broker), 59 checks MySQL propios
(20 GA, 20 SC, ocho legacy, once OAuth) con cierre 0 y tres contratos, incluido
scheduler 46 jobs. TLS local de ambas cohortes y hotfix getAssetStats conservados.
Nueva DDL 20260913050000 y dependencias: **pendiente en BD compartida**, previa
al código aun desactivado. Ningún despliegue, llamada AWS/proveedor o cambio de
pausas/OPS; OPS aplazado y apagado EC2 anunciado sin verificar. Ciclo de vida/UI
completos, otras cohortes, auditoría completa, retención/IAM/Budget/Cost Explorer
y cifrado/restauración/corte BD siguen abiertos.

[Contrato, QA y lote pendiente](google-shared-property-migration.md).

## 13/09/2026 — Listado SC/GA de propiedades registradas por broker

Preparados listados SC/GA y estado GA sin tokens SQL para registros gestionados.
Dos operaciones GET cerradas, sesión vigente y revalidación de todo el ámbito.
GA conserva grants por clínica de una propiedad compartida; muestra identificador
de cuenta. La API genérica de estado Google cierra legacy antes de hidratar
credenciales. La incorporación/remapeo y ciclo OAuth/UI completos siguen pendientes;
SC conserva su restricción de mapping original. No se activa Ajustes todavía.

QA ficticia: 174 tests Node (79 broker, 95 backend), 49 comprobaciones MySQL propias
(16 GA, 14 SC, ocho legacy, once OAuth) y tres contratos, incluido scheduler de
46 jobs. HTTPS local firmado en ambas cohortes, bloqueo tras reinicio y hotfix
getAssetStats conservado. Sin nueva migración: requisitos GBP/OAuth/SC/GA y
sesiones previos al código aun con gates apagados. Cero despliegues/migraciones
reales. OPS aplazado, apagado EC2 anunciado sin verificar; sin AWS/proveedores
reales ni cambios de pausas. Coste/cuotas reales, auditoría completa, retención,
IAM/Budget/Cost Explorer y cifrado/restauración/corte BD continúan pendientes.

[Contrato, límites y lote pendiente](google-property-discovery-migration.md).

## Lecturas GA4 preparadas (13/09/2026)

[Contrato](google-analytics-read-migration.md) y delta
`google-analytics-consumers.json`: nueve familias de analyticsSync/backfills
con referencias y registro compuesto propiedad/mapping; varias clínicas
legítimas con grants propios, sin fallback ni tokens SQL. Añade cierres globales
OAuth y de identidad legacy. DDL 20260913040000 previa al código aun con gates
apagados. No hay consumidores migrados en runtime. GA/SC discovery y ciclo OAuth
completos, otras cohortes y auditoría completa pendientes; OPS sigue aplazado.

## Lecturas SC preparadas (13/09/2026)

[Contrato](google-search-console-read-migration.md) y delta
`google-search-console-consumers.json`: cuatro operaciones cerradas SC, rutas
status/pages/inspección y webSync/backfills conectados al adaptador en código.
Registro independiente por propiedad/mapping/identidad, tokens SQL NULL y
revalidación alrededor de cada página. Amplía cierres legacy/global OAuth.
GA, OAuth/discovery SC completos, otras cohortes y cobertura de auditoría
pendientes. El nuevo esquema 20260913030000 es previo al código aun con gates
apagados. Ningún consumidor migrado en runtime; OPS continúa aplazado.

## Ampliación SC/GA: bloqueo legacy preparado (13/09/2026)

[Contrato](google-web-credentials-boundary.md) e inventario delta
`google-web-credentials-consumers.json`: las rutas web y jobs SC/GA rechazan
conexiones del registro OAuth sin hidratar sus tokens. Carga inicial GBP
compartida cubierta; discovery legacy, operaciones broker SC/GA, Ads,
conversiones, otros loaders y OPS siguen pendientes. Migrados en runtime: cero.

`consumer-inventory.json` es el resultado reproducible de
`node src/scripts/security-inventory-consumers.js`: solo símbolos, líneas y
hashes del código. No lee valores, `.env`, DB, PM2 ni sistemas externos.
245 archivos detectados inicialmente: 114 candidatos consumidores, 103 QA y
28 modelos/migraciones. Se preserva su HEAD de referencia; no equivale a 114
integraciones independientes ni a una enumeración completa del runtime.

El mismo scanner sobre `front-dev` produjo `frontend-consumer-inventory.json`:
74 archivos (32 candidatos y 42 QA). Las coincidencias incluyen autenticación
JWT, por lo que requieren distinguir tokens de sesión de tokens de proveedor;
el resultado no demuestra una fuga por sí solo.

| Cohorte | Entradas principales | Autoridad/credencial actual que debe revisarse | Estado / corte necesario |
|---|---|---|---|
| Meta social/estadísticas | metaClient, metaBatch, facebook.routes, metasync.service, socialstats, marketingReports, sync.jobs | conexión Meta, Page Token, mappings propios/heredados | Pendiente; Meta bloqueado. Conservar proyecciones y ACL de getAssetStats |
| Meta Ads/objetivos | campaignWorkspaceMeta*, metaWorkspaceSignal*, campana, effectiveMarketingAssets | conexión/grant, cuenta/página/pixel por clínica/grupo | Pendiente; separar lecturas de todas las mutaciones y publicidad |
| Google Ads/inventario | googleAdsClient, googleAdsScopedRuntime, googleAdCache, googleCampaignMetricsCache, campaignWorkspaceGoogle* | grant exacto del mapping y developer token | Pendiente; métricas/lecturas primero tras aprobar consultas concretas |
| Conversiones/recepción | googleDataManager*, googleAdsConversion*, metaCapi, metaLeadReception, metaWorkspaceSignalDelivery, intake, googleLeadReception | grant, activo, consentimiento y comandos durables | Pendiente; idempotencia/receipts y cero doble envío al cortar |
| Perfil Google/Search Console/GA4 | businessProfileLocal, businessProfileLocationMapping, web.routes, sync.jobs, marketingReports | conexión y scope Google por vertical | Siete lecturas GBP, cuatro SC y nueve GA con adaptadores preparadas offline. Cierres globales de legacy y registros independientes. OAuth/discovery GA/SC completos, escrituras y demás cohortes pendientes; OPS aplazado. Ver contratos de cohorte |
| WhatsApp/recepción clínica | whatsapp.service, whatsappPhones, whatsappTemplates, whatsappAccount*, whatsappDeliveryGovernance, flowEngineV2, patientDirection, queue.workers | waAccessToken, teléfono/WABA efectivo, roles de canal | Pendiente; DEV/staging/gateway compatibles antes de retirar columnas |
| OAuth/ciclo de vida | oauth.routes, whatsapp-embedded.routes, oauthConnectionPersistence, oauthScopedDisconnect, oauthConnectionHealth | app secrets, códigos, grants, tokens y bloqueos | Desconexión scoped y reautorización Google de identidad fijada preparadas offline. Alta nueva y ciclo completo del resto pendientes; nunca reactivar Meta |
| Webhooks | whatsapp-webhook.routes, app.js, intakePublicAuthentication | firma sobre bytes originales, replay, entrega durable | Pendiente; recepción continua y deduplicada, fixtures firmadas |
| Scripts/OPS/cron | push_ops_*, run_sync_account_range, backfill-whatsapp-legacy-scope, repair_propdental_ad_cache, sync.jobs | fuentes/mappings/configuraciones específicas por proceso | Pendiente; encontrar ruta o URL no autoriza invocarla ni repetir reparaciones |
| Backend/frontend/otros | API serialización, paneles, notifications, jobs monitoring, plugins/CMS | referencias y DTO; detectar dependencias indirectas | Pendiente de clasificación manual; acceso al token prohibido en contrato final |

En cada fila deben completarse consumidores concretos, runtime/entorno,
referencia de credencial y activos, operaciones, entradas/salidas, respaldo,
versión de contrato, pruebas y aprobación de cohorte. El scanner no decide esos
campos por coincidencias de texto. CI/OPS fuera del repo, instalaciones CMS y
copias operativas precisan el inventario/acceso expresamente asignado.

**Migrados en runtime: ninguno.** Reautorización Google fijada con cola/PKCE/versiones/auditoría v8 preparada; [contrato](google-oauth-broker-migration.md) e inventario delta `google-oauth-consumers.json`. Primer vínculo cierra OAuth legacy globalmente; aceptar impacto y drenar antes del corte.  Control adicional de revocación por activo preparado, con cola SQL, auditoría v7 y confirmación en UI. No revoca tokens OAuth; [contrato](google-business-profile-revocation-migration.md). Siete operaciones de lectura: seis de lectura en dos jobs
y una de listado de fichas registradas. Conectadas en código al transporte firmado;
sin fallback de esos jobs incluso si se elimina/recrea el mapping, mediante
registro independiente. El listado/remapeo legacy se cierra globalmente tras
el primer registro: aceptar ese impacto antes del canary. OAuth/lifecycle
requieren adaptación o pausa; OPS aplazado por el usuario, sin pausa operativa
verificada. [Contrato del listado](google-business-profile-discovery-migration.md). Inventario manual:
`google-business-profile-consumers.json`; [contrato](google-business-profile-read-migration.md).
Meta sigue sin reactivar; el usuario comunica revocación de tokens WhatsApp el
13/09, no verificada con proveedores. Pruebas ficticias no constituyen recepción
real de leads, ejecución de Optimiza ni migración operativa.
