# Inventario de consumidores y plan de corte

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
| Perfil Google/Search Console/GA4 | businessProfileLocal, businessProfileLocationMapping, web.routes, sync.jobs, marketingReports | conexión y scope Google por vertical | Pendiente; no crear conexiones privadas paralelas |
| WhatsApp/recepción clínica | whatsapp.service, whatsappPhones, whatsappTemplates, whatsappAccount*, whatsappDeliveryGovernance, flowEngineV2, patientDirection, queue.workers | waAccessToken, teléfono/WABA efectivo, roles de canal | Pendiente; DEV/staging/gateway compatibles antes de retirar columnas |
| OAuth/ciclo de vida | oauth.routes, whatsapp-embedded.routes, oauthConnectionPersistence, oauthScopedDisconnect, oauthConnectionHealth | app secrets, códigos, grants, tokens y bloqueos | Pendiente; intercambio/almacenamiento en límite de confianza, nunca reactivar Meta |
| Webhooks | whatsapp-webhook.routes, app.js, intakePublicAuthentication | firma sobre bytes originales, replay, entrega durable | Pendiente; recepción continua y deduplicada, fixtures firmadas |
| Scripts/OPS/cron | push_ops_*, run_sync_account_range, backfill-whatsapp-legacy-scope, repair_propdental_ad_cache, sync.jobs | fuentes/mappings/configuraciones específicas por proceso | Pendiente; encontrar ruta o URL no autoriza invocarla ni repetir reparaciones |
| Backend/frontend/otros | API serialización, paneles, notifications, jobs monitoring, plugins/CMS | referencias y DTO; detectar dependencias indirectas | Pendiente de clasificación manual; acceso al token prohibido en contrato final |

En cada fila deben completarse consumidores concretos, runtime/entorno,
referencia de credencial y activos, operaciones, entradas/salidas, respaldo,
versión de contrato, pruebas y aprobación de cohorte. El scanner no decide esos
campos por coincidencias de texto. CI/OPS fuera del repo, instalaciones CMS y
copias operativas precisan el inventario/acceso expresamente asignado.

**Migrados: ninguno. Bloqueados por el incidente: no se cambia el estado de
Meta. Adaptador nuevo:** transporte firmado HTTPS, todavía sin conectar a
consumidores legacy. **Pruebas ficticias:** broker y contrato de transporte;
no constituyen recepción real de leads ni ejecución real de Optimiza.
