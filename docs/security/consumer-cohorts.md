# Inventario de consumidores y plan de corte

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
