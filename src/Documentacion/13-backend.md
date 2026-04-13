> **Módulo:** Arquitectura del Backend
> **Última actualización:** 2026-04-13
> **Relacionado con:** [20.1-motor-flujos-v2](./20.1-motor-flujos-v2.md) | documento operativo `cc-front/src/Documentacion/31-roadmap-arquitectura-entornos-gateway.md`

---

## 2026-04-12 - Arquitectura operativa dev/staging/gateway

Esta sección manda sobre cualquier nota antigua de `feat/integracion`, `clinicaclick-auth`, `clinicaclick-integracion` o namespaces derivados de puerto.

Topología backend vigente:

| Runtime | Ruta | Rama | Puerto | Rol |
|:---|:---|:---|---:|:---|
| `pm2-back-dev` | `/home/ubuntu/wt/back-dev` | `dev` | `3004` | API local y jobs namespace `dev` |
| `pm2-back-staging` | `/home/ubuntu/wt/back-staging` | `staging` | `3001` | API CRM, jobs namespace `staging`, cron leader actual |
| `pm2-gateway` | `/home/ubuntu/wt/gateway` | `staging` | `3000` | webhooks externos, OAuth callbacks, WhatsApp/audio inbound |

Variables críticas:

| Variable | Regla |
|:---|:---|
| `RUNTIME_ROLE` | `api` en dev/staging; `gateway` en gateway |
| `JOB_RUNTIME_NAMESPACE` | `dev`, `staging` o `gateway` según proceso |
| `QUEUE_PREFIX` | debe coincidir con el namespace operativo |
| `JOBS_WORKER_ENABLED` | `true` en API dev/staging; `false` en gateway |
| `JOBS_CRON_LEADER` | `true` solo en `pm2-back-staging` hasta que exista prod |
| `JOB_RUNTIME_CLAIM_UNSCOPED` | por defecto `false` cuando hay namespace explícito; solo `true` en migración controlada |
| `JOB_RUNTIME_NAMESPACE_ALIASES` | lista separada por comas para migraciones controladas de namespaces legacy; por defecto vacío |
| `AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE` | en gateway actual debe apuntar a `staging` para recuperar waits antiguos sin namespace |
| `AUTOMATIONS_V2_RESUME_FROM_SOCKET_BUS` | opt-in legacy; por defecto apagado para evitar doble resume inbound |

Reglas de jobs:

- Todo `JobRequest` nuevo lleva `payload.__runtime_namespace`.
- `pm2-back-dev` no reclama jobs de `staging`.
- `pm2-back-staging` no reclama jobs de `dev`.
- Un runtime con namespace explícito no reclama jobs sin namespace salvo `JOB_RUNTIME_CLAIM_UNSCOPED=true`.
- Un runtime solo reclama aliases legacy si `JOB_RUNTIME_NAMESPACE_ALIASES` se define explícitamente.
- `pm2-gateway` no ejecuta scheduler de negocio ni cron.

Reglas de inbound externo:

- WhatsApp, audio, OAuth callbacks y webhooks externos entran por `pm2-gateway`.
- Gateway persiste el mensaje y emite realtime.
- Gateway encola el resume de automatización en el namespace propietario del flujo.
- Dev/staging no deben reanudar `message:created` desde socket-bus salvo opt-in temporal documentado.
- Si hay varias ejecuciones esperando en la misma conversación, gana la más reciente y las antiguas se cancelan como `superseded_by_newer_waiting_execution`.

Cambios de código asociados:

| Archivo | Responsabilidad |
|:---|:---|
| `src/services/jobRequests.service.js` | scope de jobs por `__runtime_namespace` y control de unscoped |
| `src/services/jobScheduler.service.js` | scheduler por namespace, aliases explícitos y log `claim unscoped` |
| `src/workers/queue.workers.js` | workers de negocio deshabilitados en `RUNTIME_ROLE=gateway` |
| `src/app.js` | gateway no registra cron y socket-bus resume queda opt-in |
| `src/services/automationsV2Resume.service.js` | inbound encola resume en namespace propietario |
| `src/services/flowEngineV2.service.js` | waits nuevos guardan `runtime_namespace` |

Referencia operativa completa: `cc-front/src/Documentacion/31-roadmap-arquitectura-entornos-gateway.md`.

## 2026-04-13 - Intake: flujos de chat para clínica cerrada

Se añade soporte real para plantillas de flujos de chat que solo deben mostrarse cuando la clínica está fuera de horario.

Modelo:

| Tabla | Campo | Uso |
|:---|:---|:---|
| `ChatFlowTemplates` | `show_when_clinic_closed` | Marca una plantilla activa como candidata para clínica cerrada. |

Endpoints afectados:

| Endpoint | Cambio |
|:---|:---|
| `GET /api/marketing/chat-flow-templates` | Devuelve `show_when_clinic_closed`. |
| `POST /api/marketing/chat-flow-templates` | Acepta `show_when_clinic_closed`. No propaga por sí solo. |
| `PUT /api/marketing/chat-flow-templates/:id` | Actualiza `show_when_clinic_closed`. No propaga por sí solo. |
| `POST /api/marketing/chat-flow-templates/:id/propagate` | Propaga manualmente una copia del catálogo a configuraciones existentes compatibles. |
| `GET /api/intake/config` | Devuelve `clinic_open_state` y añade flujos especiales si aplican. |

`GET /api/intake/config` calcula apertura desde `ClinicaHorarios`:

- `open_now=true`: la clínica está abierta;
- `open_now=false`: la clínica está cerrada;
- `open_now=null`: no hay horario estructurado suficiente o no hay clínica efectiva única.

Regla runtime:

- si `open_now=false`, el snippet evalúa primero flujos con `show_when_clinic_closed=true`;
- esos flujos mantienen `url_rules`, por lo que pueden seguir aplicando por página;
- si no hay match cerrado, se usa la lógica normal de flujo por URL/default;
- si no hay horario, nunca se activa cierre por defecto.

Migración asociada:

- `20260413082000-add-closed-clinic-flag-to-chat-flow-templates.js`

Limitación consciente:

- En scope de grupo sin clínica efectiva única no se fuerza horario de cierre, porque distintas sedes pueden tener horarios distintos.

Propagación manual de catálogo:

- `create/update/duplicate` de `ChatFlowTemplates` solo modifica el catálogo.
- `POST /api/marketing/chat-flow-templates/:id/propagate` ejecuta la propagación sobre clínicas compatibles por `disciplina_codes`.
- Si una clínica compatible no tiene `IntakeConfig`, se crea una configuración mínima de scope `clinic` con `domains=[]`, `hmac_key=null` y `config.flows` propagado. No se activa medición web ni se marca dominio instalado.
- Las copias propagadas guardan `template_id`, `catalog_template_id`, `template_flow_index` y `catalog_template_flow_index` para poder actualizar la misma copia sin duplicarla.
- Compatibilidad: si existe una copia antigua sin metadata pero con `id` tipo `catalog_<templateId>_<flowIndex>`, se reconoce como copia propagada y se normaliza en la siguiente propagación.
- Si el subflujo interno se llama `default`, la copia propagada usa como nombre visible `ChatFlowTemplates.name`; así la UI de clínica no muestra varios flujos indistinguibles llamados `default`.
- Plantillas normales nuevas se insertan desactivadas para no cambiar widgets publicados sin acción explícita.
- En copias normales ya existentes se actualiza el contenido del catálogo, pero se preserva `enabled/is_default` si la clínica lo había cambiado manualmente.
- Plantillas `show_when_clinic_closed=true` se insertan activadas y con `show_when_clinic_closed=true`.
- `GET /api/intake/config` devuelve `clinic_name` cuando el scope efectivo es una clínica. El widget lo usa como fallback para resolver `{{clinica.nombre}}` aunque no haya sede seleccionada.
- Plantillas que coinciden con `is_default_for` de la clínica se insertan activadas, pasan a ser `is_default=true` y actualizan `config.flow` legacy.
- Si una plantilla queda inactiva o deja de aplicar por disciplina, sus copias existentes quedan `enabled=false` e `is_default=false`.
- `GET /api/intake/config` evita duplicar flujos de clínica cerrada: si una copia persistida ya existe para el mismo `catalog_template_id` e índice, no inyecta otra copia dinámica.
- La respuesta de propagación devuelve `{ created, updated, skipped }`.

## 2026-04-12 - Informes de marketing agregados V1

Se añade el primer endpoint real para `Marketing > Informes`:

| Endpoint | Estado | Uso |
|:---|:---|:---|
| `GET /api/marketing/reports/overview` | Operativo V1 | KPIs, funnel, canales, web, SEO, Ads, Perfil Google, estado de fuentes y recomendaciones. |

Parámetros soportados:

- `clinicId` o `clinica_id`: ID de clínica, CSV de clínicas, `group:ID` o `all`.
- `startDate` / `endDate`: opcionales; por defecto últimos 30 días.

Fuentes que cruza:

- `LeadIntake` para leads, canales, estados y atribución.
- `FormSubmissionEvent` para formularios por URL.
- `CitasPacientes` para citas vinculadas a leads y asistencia.
- `GoogleAdsInsightsDaily` y `ClinicGoogleAdsAccount` para Google Ads.
- `SocialAdsInsightsDaily`, `SocialAdsActionsDaily`, `SocialAdsAdsetDailyAgg` y `SocialAdsEntity` para Meta Ads.
- `ClinicMetaAssets`, `SocialStatsDaily`, `SocialPosts` y `SocialPostStatsDaily` para Facebook/Instagram orgánico.
- `WebScDaily` y `WebScQueryDaily` para SEO/Search Console.
- `WebGaDaily` para GA4 opcional.
- `ClinicBusinessLocation`, `BusinessProfileDailyMetric` y `BusinessProfileReview` para Perfil Empresa Google.

Estado de sincronización:

- La respuesta incluye `sync.active`, `sync.sources[]` y `sync.allSources[]`.
- El estado `connected` de Search Console, GA4, Perfil Google, Google Ads, Meta Ads, Facebook e Instagram debe salir de los mapeos activos (`ClinicWebAssets`, `ClinicAnalyticsProperties`, `ClinicBusinessLocations`, `ClinicGoogleAdsAccounts`, `ClinicMetaAssets`), no de que existan métricas agregadas en el rango consultado. Una fuente puede estar conectada aunque el periodo seleccionado aún no tenga datos.
- `sync.active=true` cuando una fuente conectada tiene `JobRequest` pendiente/en ejecución, registros locales pendientes (`ClinicBusinessLocations.sync_status=pending`) o error.
- El endpoint considera terminada una sincronización cuando el último `JobRequest` relevante para la clínica está `completed`, aunque la API externa no haya devuelto filas nuevas. Los jobs globales sin `clinicId` no deben contaminar el estado de una clínica concreta.
- Si una fuente queda en `state=error`, `sync.message` debe mostrar el mensaje de error de esa fuente, no el texto genérico de "recabando datos".
- En Perfil de Empresa Google, si el último `JobRequest.result_summary.report.errors[]` indica que `mybusiness.googleapis.com` está deshabilitada, el informe debe indicar que Google está rechazando ese servicio exacto como no habilitado en el proyecto afectado y pedir revisar Google Cloud antes de relanzar el resync.
- El frontend usa ese estado para mostrar una barra informativa y refrescar cada 60 segundos mientras haya trabajo pendiente.
- El objetivo es que conectar GA4, Search Console, Perfil de Empresa, Google Ads o Meta Ads no parezca "sin datos" durante los primeros minutos.

Search Console:

- `web_backfill_for_sites` puede generar cientos de miles de filas en `WebScQueryDaily`.
- Las escrituras de queries se hacen por lotes (`SEARCH_CONSOLE_BULK_CHUNK_SIZE`, por defecto `500`) para no superar `max_allowed_packet` de MySQL.
- Si se ve `Got a packet bigger than max_allowed_packet` seguido de `write EPIPE`, la causa probable es un bulk demasiado grande, no un problema de permisos de Search Console. Relanzar el job después de aplicar el troceado debe cerrar el aviso de `Revisar sync`.

Limitación consciente:

- No existen todavía `WebEvents`, `WebPageDaily`, `WebClickDaily` ni `WebSessionDaily`.
- Por eso las visitas propias del funnel usan GA4 si existe o clicks sincronizados desde Ads/SEO como fallback.
- El frontend debe mostrar nota de calidad de datos y no vender esa métrica como pageviews propios hasta cerrar `ClinicaClick Analytics V1`.

## 2026-03-27 - Integración de terceros Meta/Google: estado exacto

### Estado actual del producto

La parte de ClinicaClick ya está operativa para soportar conexiones propias e heredadas:

- `scopeConnectionResolver.service.js` y `effectiveMarketingAssets.service.js` ya resuelven:
  - conexión técnica;
  - assignment por clínica/grupo;
  - activos efectivos;
  - fallback global de Meta Pixel/CAPI cuando aplica;
- `Marketing > Campañas` y `Ajustes > Cuentas conectadas` ya exponen:
  - conexión heredada de grupo;
  - conexión propia de clínica;
  - CTA para conectar otra cuenta para la clínica;
  - selección de activos efectivos para esa clínica.

### Bloqueo actual

El bloqueo actual para conectar una cuenta Meta de un tercero externo ya no está en el backend de ClinicaClick.
Está en Meta App Review / permisos de la app `1807844546609897`.

Estado verificado por Graph a fecha `2026-03-27`:

- permisos `live` confirmados:
  - `public_profile`
  - `email`
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
- el OAuth de Meta que lanzamos pide además:
  - `public_profile`
  - `pages_read_engagement`
  - `pages_show_list`
  - `pages_manage_ads`
  - `pages_manage_metadata`
  - `ads_read`
  - `leads_retrieval`
  - `instagram_basic`
  - `instagram_manage_insights`

Mientras esos permisos de negocio no estén operativos para usuarios externos, Meta responde con errores del tipo:

- `Parece que esta aplicación no está disponible`

### Permisos previstos para solicitar / revisar

Se deja documentado como lista de trabajo con Meta:

- `publish_video`
- `instagram_branded_content_creator`
- `instagram_branded_content_brand`
- `instagram_business_basic`
- `pages_manage_ads`
- `instagram_business_manage_messages`
- `instagram_manage_messages`
- `pages_manage_metadata`
- `ads_read`
- `pages_read_engagement`
- `pages_show_list`
- `business_management`

Y deben mantenerse vigentes:

- `public_profile`
- `whatsapp_business_messaging`
- `whatsapp_business_management`

### Nota sobre `business_management`

`business_management` es recomendable, pero no resuelve por sí solo la integración completa.

Es especialmente relevante porque Meta restringe `GET /me/accounts` para páginas vinculadas a un Business si el usuario no concede `business_management` y no tiene rol en ese business.

Pero ClinicaClick necesita además:

- listar cuentas publicitarias (`/me/adaccounts`);
- suscribir páginas a `leadgen` (`/{page-id}/subscribed_apps`);
- leer leads;
- operar con permisos de anuncios y páginas.

Por tanto, `business_management` debe entenderse como permiso complementario, no sustitutivo.

### Decisión operativa hasta que Meta apruebe permisos

Mientras ese review no se cierre:

- no debe considerarse cerrada la conexión de terceros Meta desde clínica;
- no debe forzarse más lógica sobre “conectar otra cuenta” si el bloqueo viene de Meta;
- el trabajo puede seguir avanzando en:
  - automatizaciones;
  - citas;
  - nodos;
  - leads;
  - intake;
  - UX interna de `Campañas` y `Ajustes`.

## 2026-03-28 - Aislamiento de colas entre runtimes y checks visibles de entorno

En esta máquina `dev` y `staging` comparten base de datos. El riesgo real no está solo en la configuración de PM2, sino en que ambos runtimes pueden intentar consumir la misma cola de `JobRequests`.

### Medida aplicada

- cada job nuevo guarda `payload.__runtime_namespace`;
- si no existe `JOB_RUNTIME_NAMESPACE`, el backend usa `port:<PORT>` como fallback estable;
- `claimNextJob`, `claimJobById` y `resetRunningJobs` ya filtran por ese namespace.

### Consecuencia operativa

- `pm2-back-dev` debe reclamar solo jobs de `dev`;
- `pm2-back-staging` debe reclamar solo jobs de `staging`;
- esto evita que una automatización creada y monitorizada en `localhost` siga ejecutándose “por detrás” en `staging`, dejando el monitor local sin eventos en tiempo real.

### Monitorización

`GET /api/job-requests/worker/status` expone ahora:

- `runtimeNamespace`
- `runtimeInfo.summaryLabel`
- `systemChecks.groqApiKey`
- `systemChecks.runtimeNamespace`

La UI de `Ajustes > Monitoreo del sistema` debe usar estos checks como semáforo visible, no solo los logs de servidor.
El check de `GROQ_API_KEY` describe siempre el proceso activo en ese instante; si cambia `.env`, hay que reiniciar el backend para que el estado reflejado sea real.

## 2026-04-01 - Propagación de plantillas WhatsApp con versionado técnico interno

### Problema real detectado

Editar una plantilla de catálogo y propagarla no bastaba cuando ya existía en Meta una versión aprobada con el mismo nombre técnico y un contrato distinto.

Caso real:

- `clinicaclick_confirmacion_cita` aprobada en Meta con `4` variables;
- nueva definición local con `5` variables;
- intentar reabrir revisión sobre el mismo `name` devolvía errores genéricos de Meta;
- esperar al job horario no resolvía nada porque no había una revisión real nueva.

### Regla nueva

Cuando el contenido Meta-facing cambia para una plantilla de catálogo:

1. ClinicaClick mantiene la **misma plantilla lógica** (`catalog_template_id`).
2. El backend crea una **variante técnica** en Meta:
   - `clinicaclick_confirmacion_cita_v2`
   - `clinicaclick_confirmacion_cita_v3`
   - etc.
3. El override local de cada clínica pasa a apuntar a esa variante técnica.
4. La UI sigue agrupando por `catalog_template_id`, no por `name`, para no duplicar la plantilla lógica.

### Estados

- `PENDING`: existe una revisión real abierta en Meta para la variante técnica actual.
- `PENDING_LOCAL`: ni la variante técnica nueva ni una revisión equivalente han quedado abiertas en Meta.

### Sync

`syncTemplatesForWaba(...)` ya no degrada una plantilla versionada a `PENDING_LOCAL` si:

- el `meta_template_id` coincide con la revisión remota, o
- el `name` técnico versionado (`_v2`, `_v3`, ...) coincide con la plantilla remota de esa misma familia.

Eso evita perder el enlace a revisiones `PENDING` recién creadas cuando Meta devuelve componentes normalizados de forma distinta.

## 2026-03-26 - Activos efectivos de marketing por clínica/grupo

`Marketing > Campañas`, `Ajustes > Cuentas conectadas`, el intake web y Meta CAPI ya no deben razonar solo en términos de “hay una conexión”.
El backend expone ahora un modelo explícito de **activos efectivos para esta clínica** con herencia de grupo y fallback global cuando aplica.

### Problema que existía

Hasta ahora convivían tres planos distintos:

- el assignment técnico (`MetaConnectionAssignment`, `GoogleConnectionAssignment`);
- los assets materializados (`ClinicMetaAsset`, `ClinicGoogleAdsAccount`);
- la configuración de medición (`IntakeConfig.config.meta_ads` / `google_ads`);

Cada subsistema resolvía estos planos de forma parcial.
El resultado era inconsistente:

- `Campañas` podía decir “conectado” aunque la clínica usara una conexión heredada del grupo;
- `Ajustes` no mostraba con claridad qué activos se estaban usando realmente en esa clínica;
- Meta CAPI seguía dependiendo del pixel global por `.env`;
- el snippet web no sabía si debía inyectar un pixel/tag propio, heredado o ninguno.

### Resolver canónico

Se introduce `src/services/effectiveMarketingAssets.service.js` como fuente única para:

- resolver el scope operativo (`clinic` / `group`);
- leer `IntakeConfig` de clínica y grupo;
- listar assets Meta visibles para la clínica;
- listar cuentas Google Ads visibles para la clínica;
- fusionar configuración de tracking con prioridad:
  - clínica;
  - grupo;
  - fallback global solo para Meta Pixel/CAPI;
- devolver qué asset se usará realmente en esa clínica.

### Regla de precedencia

Para una clínica concreta:

1. selección/configuración explícita de clínica;
2. asset/configuración heredada del grupo;
3. fallback global de entorno solo para:
   - `META_PIXEL_ID`
   - `META_CAPI_TOKEN`

No existe hoy fallback global equivalente para Google Ads.
Google solo trabaja con lo guardado en `IntakeConfig.config.google_ads`.

### Qué consume este resolver

- `GET /api/marketing/campaign-onboarding/bootstrap`
- `GET /api/marketing/campaign-onboarding/meta-pixels`
- `POST /api/marketing/campaign-onboarding/start`
- `GET /api/intake/config`
- `POST /api/intake/leads`
- `POST /api/intake/events`

Matiz operativo importante en multi-sede:
- si el snippet llega firmado correctamente y resuelve una `clinic_id` válida, el backend ya no aborta la ingesta solo porque el `group_id` derivado no pueda validarse.
- en ese caso se prioriza la clínica, se continúa con `group_id = null` y se evita romper casos como `tel_modal` o `CallInitiated` por una inconsistencia accesoria de scope.

Resolución adicional en webs de grupo:
- si el snippet llega con `data-group-id` y el payload trae el nombre de la clínica, `POST /api/intake/leads` intenta resolver la clínica dentro de ese grupo antes de usar el mapeo por dominio o la clínica por defecto;
- se leen claves como `clinica`, `clinic`, `clinic_name`, `sede`, `centro`, `ubicacion` tanto en `lead_data` como en `form_submission.fields`;
- la comparación usa `buildClinicMatcher(...)`, sin tildes y sin pisar una `clinic_id` explícita ni una clínica ya resuelta por dominio;
- cuando hace match, queda auditado en:
  - `clinic_match_source = clinic_name_field`
  - `clinic_match_value = <texto recibido>`

### Pixel de Meta

Estado actual del producto:

- **no** se crea automáticamente ningún pixel desde ClinicaClick;
- el pixel se selecciona entre los pixels existentes del ad account resuelto;
- si la clínica/grupo no tienen pixel configurado, Meta CAPI puede seguir usando el global del entorno si existe;
- si tampoco existe pixel global, no se envía CAPI y el readiness lo marca como incompleto.

### Google Tag / Google Ads

Google no usa un “pixel” equivalente en este flujo.
La parte web se basa en el `send_to` guardado en `IntakeConfig.config.google_ads`.

Del `send_to` se deriva:

- `tag_id` para la inyección web (`AW-...`);
- la configuración de conversiones server-side en `maybeUploadGoogleConversion(...)`.

### Compatibilidad

Este cambio no altera:

- el ownership de tokens en `MetaConnection` / `GoogleConnection`;
- la sync de assets y jobs ya existentes;
- la atribución de leads ya creados.

Lo que cambia es el punto de lectura:

- ya no debe deducirse “qué usar” a partir de una conexión o asset cualquiera;
- debe consultarse siempre el resolver de activos efectivos.

## 2026-03-24 - Intake inbound: descarte explícito de leads sin scope

El intake inbound ya no debe crear `LeadIntake` huérfanos cuando una fuente externa no puede resolverse a clínica o grupo.

### Problema que existía

En conexiones históricas de Meta podían entrar leads con:

- `source = meta_ads`
- `clinic_match_source = meta_page_id`
- `clinic_match_value = <page_id>`

pero sin un `ClinicMetaAsset` activo que materializase esa página o formulario dentro del scope vigente.

El resultado era inconsistente:

- el lead se persistía;
- `clinica_id` y `grupo_clinica_id` quedaban `null`;
- CRM mostraba el contacto como `Sin clínica`;
- las automatizaciones posteriores no tenían un scope fiable.

### Comportamiento actual

Tanto `ingestLead` como `receiveMetaWebhook` cortan la creación si, tras resolver activos y scope, no existe:

- `clinica_id`, ni
- `grupo_clinica_id`.

En ese caso:

- el webhook se considera procesado para evitar reintentos infinitos;
- el backend responde con descarte explícito;
- no se crea `LeadIntake`;
- no se crea auditoría ni conversación colgando de un lead sin dueño.

### Criterio operativo

Esto es deliberado:

- si la conexión está mal mapeada, el dato correcto no es “lead sin clínica”;
- el dato correcto es “lead descartado por mapeo incompleto”.

Por tanto, cuando aparezcan leads Meta/Google sin entrar en CRM, la primera revisión debe ser:

- activos del scope (`ClinicMetaAsset`, `ClinicGoogleAdsAccount`, assignments);
- page/form/account mapeados al grupo o clínica correctos;
- coherencia entre el `clinic_match_*` guardado y los activos materializados.

## 2026-03-24 - Importación manual de leads sobre `LeadIntake`

`Marketing > Leads` ya no necesita crear leads uno a uno cuando la fuente llega como CSV/Excel.
El backend expone un flujo de importación en dos fases sobre el intake existente:

- `POST /api/intake/leads/import/preview`
- `POST /api/intake/leads/import/execute`

### Principio de diseño

El backend no parsea el binario del fichero.
El navegador lee `csv/xls/xlsx`, lo convierte a filas JSON y backend se encarga de:

- validar clínica y source de destino;
- aplicar mapeo de columnas;
- ejecutar exclusiones;
- comprobar duplicados;
- crear `LeadIntake` y `LeadAttributionAudit` cuando procede.

Esto mantiene el contrato estable y evita acoplar Express a formatos de Excel.

### Qué hace `preview`

`preview` recalcula, fila a fila:

- si la fila tiene identidad mínima (`nombre`, `email` o `telefono`);
- si queda fuera por una regla de exclusión;
- si ya existe un lead similar en la clínica destino;
- si colisiona por `external_source + external_id`;
- si el intake global ya tiene un contacto reciente igual dentro de la ventana de dedupe.

La respuesta devuelve:

- resumen global;
- clínica y grupo resueltos;
- estado por fila (`ready`, `excluded`, `invalid`);
- motivos legibles de exclusión.

### Qué hace `execute`

`execute` no confía en el preview previo del cliente.
Recalcula internamente el mismo análisis y solo intenta crear las filas que siguen en `ready`.

Al importar:

- crea `LeadIntake`;
- registra `LeadAttributionAudit` con el raw de importación, mapping y contexto;
- conserva `created_at` importado cuando la columna se ha mapeado como fecha de entrada;
- materializa cita importada en `cita_propuesta` cuando el archivo trae fecha/hora/responsable/dirección.

### Alcance del mapeo actual

Campos canónicos soportados:

- `external_id`
- `created_at`
- `source`
- `source_detail`
- `nombre`
- `email`
- `telefono`
- `status_lead`
- `notas`
- `concern`
- `appointment_date`
- `appointment_time`
- `appointment_clinic`
- `appointment_responsible`
- `appointment_address`

Regla práctica:

- si el archivo trae más columnas de negocio, hoy deben mapearse a `notas` o quedar fuera;
- no se debe inventar una tabla paralela de importación para información que ya cabe razonablemente en `LeadIntake` o `cita_propuesta`.

## 2026-03-24 - Análisis de campañas cache-only

> **Estado:** implementado en `back-integracion`.

`Marketing > Campañas > Análisis` ya no debe depender de llamadas live a Meta o Google.

La regla operativa actual es:

1. la sincronización/cron alimenta las tablas cacheadas;
2. la UI consulta solo esas tablas;
3. si falta detalle, la vista queda parcial o pendiente de sincronización;
4. no se intenta "rellenar en caliente" desde la API del proveedor.

### Tablas que actúan como fuente de verdad

- `GoogleAdsInsightsDaily`
- `GoogleAdsAdInsightsDaily`
- `SocialAdsEntity`
- `SocialAdsInsightsDaily`
- `SocialAdsActionsDaily`

### Implicación práctica

Cuando QA detecta que falta detalle en `Análisis`, la pregunta correcta es:

- si el cron/resync ya escribió ese nivel en cache,

no:

- si el frontend hizo una llamada live al proveedor.

Esto reduce latencia, evita divergencias entre pantallas y elimina dependencia de cuotas/rate limits durante la navegación.

### Ajuste importante del 2026-03-24

El frontend ya no debe reconstruir un rango corto (`Ayer`, `Semana pasada`, etc.) usando fallback de `all_time`.

Eso obliga a backend a ser claro:

- si hay cache para ese rango, se devuelve;
- si no la hay, se devuelve vacío/parcial;
- el siguiente paso correcto es ejecutar/respetar la sincronización nocturna, no abrir una llamada live desde UI.

## 2026-03-24 - Scope real de WhatsApp en Ajustes

`GET /api/whatsapp/phones` ya debe aceptar y respetar:

- `clinic_id`
- `group_id`

Semántica actual:

- `clinic_id`: devuelve números propios de la clínica y números heredados del grupo;
- `group_id`: devuelve números asignados al grupo y números clínicos de las clínicas que cuelgan de ese grupo;
- sin scope: vista global según permisos del usuario.

Esto alinea WhatsApp con el resto de activos conectados en `Ajustes`.

`GET /api/whatsapp/accounts` debe seguir la misma semántica de scope:

- `clinic_id`: WABA/números propios de la clínica y heredados del grupo;
- `group_id`: números y WABA asignados al grupo o a clínicas del grupo;
- sin scope: vista global según permisos del usuario.

Importante:

- si en `Ajustes` no aparece nada de WhatsApp para un grupo, primero hay que validar si existen filas activas en `ClinicMetaAsset` para `whatsapp_phone_number` o `whatsapp_business_account`;
- el frontend no debe inventar una conexión inexistente por scope.

Caso real detectado en integración:

- CRM podía seguir enviando WhatsApp aunque `Ajustes` no mostrase ningún activo scoped;
- la causa era un fallback legacy global en `src/services/whatsapp.service.js` (`META_WHATSAPP_ACCESS_TOKEN` + `META_WHATSAPP_PHONE_NUMBER_ID` o número por defecto);
- por tanto, "funciona en runtime" no significaba "está modelado por scope".

Regla aplicada inicialmente:

- si existe un número legacy operativo y se quiere que aparezca en `Ajustes`, hay que materializarlo como `ClinicMetaAsset` scoped;
- para ese backfill existe el script:
  - `scripts/backfill-whatsapp-legacy-scope.js`
- el script crea o actualiza un `whatsapp_phone_number` con `assignmentScope = group` o el scope indicado.

Además, los lectores de estado deben resolver herencia de grupo:

- `GET /api/whatsapp/status?clinic_id=...`
- `GET /api/whatsapp/templates/summary?clinic_id=...`

si no encuentran un asset propio de clínica, deben intentar el asset `assignmentScope = group` del grupo de esa clínica antes de devolver "no configurado".

Migración segura aplicada cuando CRM funciona pero `Ajustes` no refleja WhatsApp:

1. inspeccionar `Messages.metadata` recientes para localizar `wabaId` y `phoneNumberId` realmente usados por el runtime;
2. validar esos IDs contra Graph con el token actual;
3. materializar ambos activos en `ClinicMetaAsset` para el scope correcto;
4. sincronizar teléfonos y plantillas del `wabaId`;
5. desactivar el asset test/legacy de la vista;
6. mantener temporalmente el fallback global hasta verificar la operativa en UI y envío real;
7. cuando esa validación sea correcta, retirar el fallback global del runtime.

Esto evita dos errores frecuentes:

- reconectar a ciegas cuando el canal real ya existe y solo falta modelarlo;
- retirar el fallback global antes de comprobar que el nuevo scope ya resuelve `phone_number_id`, `waba_id` y plantillas.

Estado actual en integración:

- el runtime operativo de envío ya no cae a `META_WHATSAPP_ACCESS_TOKEN` / `META_WHATSAPP_PHONE_NUMBER_ID` como ruta normal;
- `src/services/whatsapp.service.js` resuelve exclusivamente activos scoped (`clinic` o herencia `group`);
- el endpoint `POST /api/whatsapp/messages` exige `auth` y `clinic_id`;
- los tokens de entorno de WhatsApp siguen siendo válidos para:
  - embedded signup / bootstrap técnico;
  - scripts de backfill o diagnóstico;
  - sincronizaciones puntuales contra Graph cuando ya existe un WABA conocido.

En otras palabras:

- operar WhatsApp para una clínica/grupo ya no depende de `.env`;
- bootstrapear o reparar una conexión sí puede seguir necesitando `.env`.

## 2026-03-24 - Salud de Google Ads: serving/billing cacheado

La salud de Google Ads no debe depender solo de `ClinicGoogleAdsAccount.accountStatus`.

Desde esta iteración, la sync diaria/backfill debe persistir también en `GoogleAdsInsightsDaily`:

- `campaignServingStatus`
- `campaignPrimaryStatus`
- `campaignPrimaryStatusReasons`

Fuente:

- campos `campaign.serving_status`
- `campaign.primary_status`
- `campaign.primary_status_reasons`

Objetivo:

- detectar campañas que no están publicando aunque la cuenta siga figurando como `ENABLED`;
- especialmente casos de billing o saldo pendiente que Google Ads muestra como motivo de serving a nivel campaña.

La UI de `Marketing > Campañas > Salud` debe leer esto desde cache y no consultar live al proveedor.

## 2026-03-24 - Cron y variables de entorno operativas

Los horarios efectivos de sincronización salen de `src/jobs/sync.jobs.js`, pero pueden quedar sobreescritos por variables de entorno.

Defaults actuales de interés:

- `JOBS_ADS_SCHEDULE`: `30 0 * * *`
- `JOBS_GOOGLE_ADS_SCHEDULE`: `20 0 * * *`
- `JOBS_WEB_SCHEDULE`: `15 4 * * *`
- `JOBS_ANALYTICS_SCHEDULE`: `45 4 * * *`
- `JOBS_BUSINESS_PROFILE_SCHEDULE`: `10 5 * * *`
- `JOBS_BUSINESS_PROFILE_BACKFILL_SCHEDULE`: `20 5 * * 0`
- `JOBS_ADS_MIDDAY_SCHEDULE`: `0 12 * * *`
- `JOBS_WHATSAPP_PHONES_SCHEDULE`: `*/15 * * * *`
- `JOBS_WHATSAPP_TEMPLATES_SCHEDULE`: `*/20 * * * *`
- `WHATSAPP_PROPAGATE_RESYNC_DELAY_MINUTES`: `12`

Ventanas y límites asociados:

- `ADS_SYNC_INITIAL_DAYS`
- `ADS_SYNC_RECENT_DAYS`
- `ADS_SYNC_MIDDAY_DAYS`
- `ADS_SYNC_BACKFILL_DAYS`
- `GOOGLE_ADS_SYNC_INITIAL_DAYS`
- `GOOGLE_ADS_SYNC_RECENT_DAYS`
- `GOOGLE_ADS_BACKFILL_DAYS`
- `GOOGLE_ADS_SYNC_CHUNK_DAYS`
- `WEB_SYNC_RECENT_DAYS`
- `WEB_BACKFILL_DAYS`
- `ANALYTICS_SYNC_RECENT_DAYS`
- `ANALYTICS_BACKFILL_DAYS`
- `LOCAL_SYNC_RECENT_DAYS`
- `LOCAL_BACKFILL_DAYS`

Regla operativa:

- cambiar el default en código no modifica producción/integración si la variable ya existe en `.env` o en PM2;
- si se ajusta el cron, hay que revisar también el valor efectivo en entorno y reiniciar con actualización de variables si aplica.

Perfil de Empresa Google:

- `GET /oauth/google/local/locations` usa Business Information API con `readMask`; Google rechaza la llamada sin ese parámetro y no deben tragarse esos errores como "0 fichas";
- `POST /oauth/google/local/map-locations` guarda `ClinicBusinessLocations`, conserva `raw_payload.accountName` y encola `business_profile_backfill_locations`;
- `businessProfileSync` usa la Google Business Profile Performance API para métricas recientes y las rutas v4 de My Business (`mybusiness.googleapis.com`) para reseñas/publicaciones;
- el job persiste en `BusinessProfileDailyMetrics`, `BusinessProfileReviews` y `BusinessProfilePosts`;
- `BusinessProfilePosts.summary`, `call_to_action_url` y `media_url` deben ser `TEXT`; Google puede devolver publicaciones o URLs más largas que 1024 caracteres;
- si falta `raw_payload.accountName`, Google devuelve 403/scope insuficiente o `mybusiness.googleapis.com` no está habilitada en el proyecto, la ficha queda con `sync_status=error`; no debe mostrarse como "0 reseñas/publicaciones" completado.
- `GET /api/local/clinica/:clinicaId/status` expone `syncStatus`, `lastSyncedAt`, teléfono, web y dirección procedentes de `raw_payload`;
- `GET /api/local/clinica/:clinicaId/overview|timeseries|reviews|posts` son los endpoints reales que alimentan `Marketing > Perfil Google`.

Namespace al encolar desde OAuth/gateway:

- Los diálogos de mapeo Google/Meta que llaman a `https://autenticacion.clinicaclick.com` envían `runtime_namespace`.
- `localhost:4203` debe encolar jobs `dev`; `crm.clinicaclick.com` debe encolar `staging`; `app.clinicaclick.com` debe encolar `prod`.
- Si no llega namespace y el runtime es gateway, el fallback operativo es `AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE` o `staging`.
- El gateway no debe ejecutar el job de negocio; `triggerImmediate` solo tendrá efecto si el namespace coincide con el runtime que reclama.
- Además de GA4, Ads y Meta, el gateway debe encolar backfills dirigidos para Search Console (`web_backfill_for_sites`) y Perfil Empresa Google (`business_profile_backfill_locations`) con el namespace del front que originó la acción.

Refresco diferido tras `Propagar`:

- además del cron periódico, una propagación de plantilla sobre clínicas conectadas encola una sync diferida por `wabaId`;
- por defecto se programa a los `12` minutos (`WHATSAPP_PROPAGATE_RESYNC_DELAY_MINUTES`);
- esto cubre el caso en que Meta aprueba la revisión pocos minutos después de abrirla, sin depender del cron periódico;
- la sync diferida se deduplica por ventana para no encolar varias iguales si se propagan varias plantillas seguidas sobre el mismo WABA.

Cron periódico de plantillas WhatsApp:

- ya no recorre todos los WABA activos a ciegas;
- por defecto corre cada `20` minutos;
- solo encola sync para WABAs que tengan alguna plantilla activa en `PENDING` o `IN_REVIEW`;
- si no hay pendientes reales, no hace llamadas de revisión a Meta.

### Liderazgo explícito del cron

Desde `2026-04-01`, el arranque del scheduler ya no debe depender de que varios runtimes compartan `JOBS_AUTO_START=true`.

Nueva regla:

- `JOBS_WORKER_ENABLED` controla el worker de `JobRequests`.
  - Por defecto se considera `true`.
  - Si vale `false`, este runtime no ejecuta automatizaciones, resumes ni jobs diferidos aunque el backend esté online.
- `JOBS_CRON_LEADER=true`: este runtime es el que manda y arranca `metaSyncJobs.start()`.
- `JOBS_CRON_LEADER=false`: este runtime no debe encolar cron jobs periódicos.

Importante:

- `jobScheduler.start()` y `metaSyncJobs.start()` ya no significan lo mismo.
- `staging` debe poder ejecutar sus automatizaciones (`appointment_created`, `wait_response`, resumes) aunque no sea el leader de cron.

Configuración operativa actual:

- `clinicaclick-integracion`: `JOBS_CRON_LEADER=true`
- `clinicaclick-auth`: `JOBS_CRON_LEADER=false`
- `clinicaclick-staging`: `JOBS_CRON_LEADER=false`

Objetivo:

- evitar duplicados horarios de `whatsapp_templates_sync`;
- evitar que `auth` o `staging` compitan con `integracion` sobre la misma base de datos;
- poder migrar el liderazgo sin tocar código.

### Regla de migración a staging

Cuando `staging` deba convertirse en el runtime que manda los cron jobs:

1. poner `JOBS_CRON_LEADER=false` en `integracion`;
2. poner `JOBS_CRON_LEADER=true` en `staging`;
3. reiniciar ambos procesos con actualización de `.env`.

Importante:

- no deben coexistir dos runtimes con `JOBS_CRON_LEADER=true` contra la misma base;
- `JOBS_AUTO_START=true` por sí solo ya no basta para arrancar cron.
- `JOBS_CRON_LEADER=false` no debe apagar el worker de `JobRequests`; solo desactiva los cron periódicos.

## 2026-03-23 - Cache ad-level de Google Ads para análisis de campañas

> **Estado:** implementado en `back-integracion`.

### Qué faltaba

En `Marketing > Campañas > Análisis`, Google Ads solo llegaba hasta:

- campaña
- grupo de anuncios
- una preview resumida de campaña

Eso no permitía enseñar un último nivel real por anuncio como sí hacíamos ya con Meta.

### Qué se añadió

Nueva tabla cacheada:

- `GoogleAdsAdInsightsDaily`

Guarda por anuncio y día:

- `customerId`
- `campaignId`
- `adGroupId`
- `adId`
- nombre y tipo del anuncio
- `finalUrl`
- `displayUrl`
- `headlines`
- `descriptions`
- métricas diarias:
  - impresiones
  - clics
  - coste
  - conversiones

### Cómo se usa hoy

La tabla se usa como cache persistente para el análisis detallado.

El endpoint de análisis:

1. lee `GoogleAdsAdInsightsDaily`;
2. si no hay suficiente detalle, devuelve el nivel parcial disponible;
3. deja la responsabilidad de completar datos al resync/cron, no a la UI.

### Alcance actual

Esto permite en `Campañas > Análisis` para Google Ads:

- grupos de anuncios reales
- anuncios reales
- headlines reales
- descriptions reales
- URL destino real
- métricas reales por anuncio

### Límite actual

Google no nos está dejando todavía una capa equivalente a Meta para:

- thumbnails reales por anuncio
- vídeo preview real por anuncio

Por tanto:

- Google queda resuelto a nivel de estructura + texto + URL + métricas
- Meta sigue siendo la fuente rica para media preview

### Regla importante

Las métricas globales existentes no se recalculan desde esta tabla nueva.

Seguimos usando:

- `GoogleAdsInsightsDaily`

para overview/reporting general, y:

- `GoogleAdsAdInsightsDaily`

solo para el nivel detallado de análisis por anuncio.

Esto evita duplicidades de gasto o conversiones en otros endpoints.

---

## 2026-03-18 - Diseño objetivo de conexiones OAuth por scope

> **Estado:** implementado y alineado entre runtime OAuth, `Ajustes` y `back-integracion`.

### Limitación del modelo actual

El backend actual sigue siendo principalmente **owner-centric**:

- `MetaConnection` y `GoogleConnection` se resuelven por `userId`;
- gran parte de los endpoints de estado, conexión y desconexión usan `findOne({ where: { userId } })`;
- los mappings clínicos (`ClinicMetaAsset`, `ClinicGoogleAdsAccount`, etc.) cuelgan de esas conexiones técnicas.

Eso permite operar hoy, pero no resuelve correctamente el caso de negocio:

- un usuario autoriza la app;
- luego deja de ser admin interno o abandona la empresa;
- la integración debería seguir viva para la clínica o el grupo.

### Objetivo

Pasar a un modelo **scope-centric**:

1. el grant OAuth lo ejecuta un usuario humano;
2. la conexión efectiva pertenece a un **scope**:
   - clínica
   - o grupo
3. el usuario autorizador queda solo como trazabilidad;
4. la operativa y los permisos se resuelven por scope, no por owner humano.

### Modelo objetivo

Se mantiene temporalmente el almacenamiento técnico de tokens por proveedor:

- `MetaConnection`
- `GoogleConnection`

Pero producto y runtime dejarán de tratarlos como “la conexión del usuario”.
Pasarán a ser el **grant técnico**.

Encima de ese grant deben añadirse asignaciones canónicas por scope:

- `MetaConnectionAssignments`
- `GoogleConnectionAssignments`

Contrato mínimo de cada assignment:

- `id`
- `metaConnectionId` / `googleConnectionId`
- `assignmentScope` = `clinic | group`
- `clinicaId` nullable
- `grupoClinicaId` nullable
- `status` = `active | reauthorization_required | revoked | disconnected`
- `authorizedByUserId` nullable
- `authorizedByName`
- `authorizedByEmail`
- `connectedAt`
- `lastValidatedAt`
- `lastErrorCode`
- `lastErrorMessage`
- `createdBy`
- `updatedBy`

Restricción funcional:

- una sola conexión activa por proveedor y scope.

### Ajuste necesario de los grants técnicos

Para que la conexión no se rompa al salir el usuario autorizador:

- `MetaConnection.userId` y `GoogleConnection.userId` deben dejar de implicar borrado en cascada de la conexión efectiva del negocio;
- la relación con `Usuario` debe tolerar que el owner humano desaparezca:
  - `SET NULL` o equivalente;
- deben conservarse snapshots de auditoría:
  - `userName`
  - `userEmail`

Si esto no se cambia, la capa de assignments no bastará: al borrar el usuario, el grant técnico seguiría cayéndose.

### Resolución canónica

Debe existir un resolver unificado por proveedor:

- `resolveEffectiveMetaConnection(scope)`
- `resolveEffectiveGoogleConnection(scope)`

Precedencia:

1. conexión propia de clínica
2. si no existe, conexión heredada del grupo
3. si no existe ninguna, scope sin conexión

### Regla operativa aplicada

En la implementación activa para Meta y Google:

- la conexión de una clínica perteneciente a grupo se **promociona** a conexión compartida del grupo;
- la vista clínica hereda esa conexión de grupo;
- la desconexión desde clínica o grupo actúa sobre la conexión compartida del grupo;
- los mappings permanecen por clínica y se limpian por clínica afectada cuando se desconecta una conexión compartida.

Esto fija una separación explícita:

- **OAuth connection**: compartida por grupo por defecto;
- **asset mapping**: independiente por clínica.

Este resolver debe usarse en:

- `Ajustes > Cuentas conectadas`
- onboarding técnico de campañas
- WhatsApp/Meta
- Google Ads / Search Console / Analytics / Business Profile
- jobs de sync
- reporting y métricas

### Mappings

Los mappings existentes pueden mantenerse en una fase transitoria:

- `ClinicMetaAsset`
- `ClinicGoogleAdsAccount`
- `ClinicWebAsset`
- `ClinicAnalyticsProperty`
- `ClinicBusinessLocation`

Pero dejan de estar legitimados por “mi `userId` conectado”.
La fuente de verdad pasa a ser:

- existe una conexión efectiva válida para ese scope;
- el mapping está asignado a ese scope;
- el usuario actual tiene permisos internos para operar en ese scope.

### Desconexión segura

El comportamiento actual de `disconnect` por `userId` es demasiado destructivo.

Nuevo contrato:

1. `disconnect` actúa sobre el **scope actual**;
2. desactiva o elimina el assignment del scope;
3. solo si el grant técnico queda sin referencias activas:
   - se limpia el grant;
   - y se decide si limpiar mappings dependientes.

Esto evita romper otras clínicas o grupos que reutilicen el mismo grant técnico.

### Permisos

Niveles mínimos recomendados:

- `view_connected_assets`
- `manage_connected_assets`
- `manage_provider_connection`

Ninguna de estas acciones debe depender de ser el owner original del grant.
Debe depender de los permisos internos del usuario sobre la clínica o el grupo.

### Diferencias por proveedor

- **Google**
  - ya existe `refreshToken` y el backend sabe refrescar tokens;
  - el problema principal no es técnico de token, sino de ownership de la conexión.
- **Meta**
  - no hay refresh token clásico equivalente;
  - el runtime depende de:
    - `long-lived user token`
    - `pageAccessToken`
    - `waAccessToken`
  - el sistema debe marcar `reauthorization_required` cuando el grant o los permisos reales de Meta dejen de ser válidos.

### Comportamiento de grupos

Regla aprobada:

1. una clínica puede heredar la conexión del grupo;
2. una clínica puede sobrescribir con conexión propia;
3. si ambas existen, manda la de clínica.

### Estrategia de migración

No hacer big bang.

Fases:

1. crear tablas de assignments;
2. ajustar FK/ownership de `MetaConnection` y `GoogleConnection`;
3. backfill de assignments desde el estado real existente;
4. dual-read:
   - primero assignment nuevo
   - fallback legacy;
5. dual-write al conectar y mapear;
6. mover `disconnect` a scope;
7. retirar gradualmente el uso directo de `findOne({ where: { userId } })`.

### Criterios de aceptación de la remodelación

1. Usuario A conecta Meta o Google para clínica X.
2. Usuario B, admin de clínica X, puede operar sin reautorizar.
3. Si Usuario A deja de ser admin interno, la clínica sigue operativa.
4. Si el proveedor revoca el grant, el scope queda en `reauthorization_required`.
5. Desconectar una clínica no rompe otra clínica/grupo que comparta el grant.
6. La UI deja de presentar “Conectado como X” como fuente principal de verdad en scopes clínicos.

### Regla de integración a staging/producción

Este bloque no se despliega solo desde `cc-back`.

Además de `wt/back-integracion`, hay que integrar el runtime OAuth dedicado que sirve:

- `https://autenticacion.clinicaclick.com`
- repo local actual: `/home/ubuntu/backendclinicaclick`

Si se mueve solo `cc-back` y no se mueve el auth runtime:

- los callbacks OAuth pueden seguir en lógica antigua;
- `connection-status` puede no reflejar el modelo por scope;
- `disconnect` puede seguir operando con semántica legacy.

Para cualquier migración de este bloque, tratar `cc-back` + auth runtime como un único paquete funcional.

### Plan ejecutable de implementación

> **Objetivo:** ejecutar la migración sin tumbar runtime ni romper las conexiones ya activas.

#### Fase 0. Preparación

Antes de tocar runtime:

1. inventariar endpoints legacy que hoy resuelven por `userId`;
2. centralizar la lógica de resolución en un servicio nuevo;
3. no mezclar este bloque con refactors de campañas/chat/agendas.

Servicio nuevo recomendado:

- `src/services/scopeConnectionResolver.service.js`

Funciones mínimas:

- `resolveEffectiveMetaConnection({ clinicaId, grupoClinicaId })`
- `resolveEffectiveGoogleConnection({ clinicaId, grupoClinicaId })`
- `getScopeConnectionStatus({ provider, clinicaId, grupoClinicaId })`

#### Fase 1. Esquema

Migraciones nuevas recomendadas:

1. `20260318090000-create-meta-connection-assignments.js`
2. `20260318091000-create-google-connection-assignments.js`
3. `20260318092000-make-meta-connections-userid-nullable.js`
4. `20260318093000-make-google-connections-userid-nullable.js`

Tablas nuevas:

- `MetaConnectionAssignments`
- `GoogleConnectionAssignments`

Índices mínimos:

- único por:
  - `assignmentScope + clinicaId + provider(active)`
  - `assignmentScope + grupoClinicaId + provider(active)`
- índice por `metaConnectionId`
- índice por `googleConnectionId`
- índice por `status`

Contrato sugerido:

- `assignmentScope`
- `clinicaId`
- `grupoClinicaId`
- `status`
- `authorizedByUserId`
- `authorizedByName`
- `authorizedByEmail`
- `connectedAt`
- `lastValidatedAt`
- `lastErrorCode`
- `lastErrorMessage`
- `createdBy`
- `updatedBy`

#### Fase 2. Backfill

No meter backfill complejo dentro de migraciones destructivas.

Recomendado:

- script explícito:
  - `src/scripts/backfill_scope_connection_assignments.js`

Reglas del backfill:

1. por cada mapping clínico existente, crear assignment al grant técnico correspondiente si no existe;
2. si hay mappings de grupo, crear assignment de grupo;
3. copiar snapshots de auditoría desde `MetaConnection` / `GoogleConnection`;
4. no tocar aún los mappings existentes.

Resultado esperado tras backfill:

- todo scope con mappings activos tiene assignment resoluble;
- todavía siguen existiendo grants legacy por `userId`.

#### Fase 3. Dual-read

Todos los lectores de estado deben pasar por `scopeConnectionResolver`.

Regla:

1. primero assignment por scope;
2. si no existe, fallback legacy por `userId`;
3. si no existe ninguno, `not_connected`.

Endpoints a introducir:

- `GET /oauth/meta/scope-connection-status`
- `GET /oauth/google/scope-connection-status`

Parámetros:

- `clinic_id`
- `group_id`

Respuesta mínima:

```json
{
  "connected": true,
  "status": "active",
  "ownership_mode": "scope",
  "connection_source": "clinic",
  "inherited_from_group": false,
  "authorized_by": {
    "user_id": 12,
    "name": "Carlos Hervas",
    "email": "car.hervas@gmail.com"
  },
  "connected_at": "2026-03-18T10:00:00.000Z",
  "last_validated_at": "2026-03-18T11:00:00.000Z",
  "last_error_code": null,
  "last_error_message": null
}
```

#### Fase 4. Dual-write

Al conectar o reautorizar:

1. guardar/actualizar grant técnico (`MetaConnection` / `GoogleConnection`);
2. crear o actualizar assignment del scope actual;
3. actualizar snapshots:
   - `authorizedByUserId`
   - `authorizedByName`
   - `authorizedByEmail`
   - `connectedAt`

Endpoints a introducir:

- `POST /oauth/meta/assign-scope`
- `POST /oauth/google/assign-scope`

Payload mínimo:

```json
{
  "assignment_scope": "clinic",
  "clinic_id": 36,
  "group_id": null
}
```

#### Fase 5. Disconnect seguro

Reemplazar el `disconnect` por `userId` con disconnect por scope.

Nuevos endpoints:

- `DELETE /oauth/meta/scope-connection`
- `DELETE /oauth/google/scope-connection`

Regla:

1. desactivar/eliminar assignment del scope;
2. revisar si el grant técnico queda referenciado por otros assignments;
3. solo si queda huérfano, limpiar el grant técnico;
4. nunca borrar de golpe mappings de otros scopes por desconectar uno.

#### Fase 6. Mapeos

Los controladores de mappings deben validar contra la conexión efectiva del scope, no contra el `userId` actual.

Zonas a revisar:

- `src/routes/oauth.routes.js`
- `src/controllers/whatsapp.controller.js`
- `src/controllers/googleads.controller.js`
- `src/controllers/socialstats.controller.js`
- `src/controllers/campaignOnboarding.controller.js`

Regla operativa:

- el usuario actual debe tener permisos internos sobre el scope;
- no hace falta que sea el owner histórico del grant.

#### Fase 7. Jobs y sync

Los jobs no deben buscar “la conexión del usuario”.
Deben usar:

- `metaConnectionId` / `googleConnectionId` resueltos desde assignment o mapping;
- o el resolver de scope cuando el trabajo nazca desde clínica/grupo.

Zonas a revisar:

- `src/jobs/sync.jobs.js`
- `src/controllers/metasync.controller.js`
- `src/services/whatsapp*.js`

#### Fase 8. Limpieza legacy

Cuando dual-read y dual-write estén estables:

1. retirar fallbacks directos por `userId` en endpoints de estado;
2. retirar copy/UI basada en “Conectado como X”;
3. dejar `MetaConnection` / `GoogleConnection` como grant técnico, no como concepto de producto.

### Riesgos y mitigaciones

#### Riesgo 1. Usuario borrado

Mitigación:

- `userId` nullable en grants;
- snapshots de auditoría persistidos;
- permissions por scope, no por owner histórico.

#### Riesgo 2. Meta revoca el grant

Mitigación:

- validación periódica;
- `status = reauthorization_required`;
- UI y jobs deben degradar con error explícito.

#### Riesgo 3. Disconnect destructivo

Mitigación:

- disconnect por scope;
- reference counting lógico antes de borrar grant técnico.

#### Riesgo 4. Despliegue parcial

Mitigación:

- este bloque debe desplegarse coordinado entre:
  - `wt/back-integracion`
  - `/home/ubuntu/backendclinicaclick`
  - frontend de `Ajustes`

### Orden recomendado de ejecución

1. migraciones de schema;
2. script de backfill;
3. servicio `scopeConnectionResolver`;
4. endpoints nuevos de `scope-connection-status`;
5. dual-write en callbacks OAuth;
6. disconnect por scope;
7. adaptación de `Ajustes`;
8. limpieza legacy.

## 2026-03-08 - Conversaciones lead y actividad de paciente

- **Nomenclatura canónica en marketing/chat**
  - `LeadIntake` es el modelo canónico de lead para marketing, formularios y automatizaciones.
  - `LeadIntake` usa `clinica_id`.
  - `Conversation` pertenece al subsistema de chat y usa `clinic_id`.
  - `Conversation.lead_id` debe resolver contra `LeadIntake.id`.
  - El modelo histórico `Lead` no debe usarse en nuevo código de marketing ni en el runtime de conversaciones asociado a leads.
  - El CRUD legacy `/api/leads` queda retirado en integración. El canónico de leads vive en `/api/intake/leads`.
  - Se mantiene únicamente el alias `/api/leads/webhook`, resuelto por `intakeController`.
  - `automation-catalog` sigue expuesto, pero con hard-cut de `trigger_type`: ya no acepta nombres legacy como `cita_creada` o `recordatorio_cita`.
  - La actividad operativa de paciente normaliza sus eventos de cita a claves `appointment_*` (`appointment_created`, `appointment_confirmed`, `appointment_completed`, etc.).
  - En integración se elimina la superficie legacy de flujos de cita v1 para tratamientos (`AppointmentFlowTemplate`, `AppointmentFlowInstance`, `/api/appointment-flow-templates`, `/api/tratamientos/:id/flow`).
  - `/api/citas` queda únicamente sobre resumen de ejecuciones v2 (`FlowExecutionV2`) y ya no depende del runtime v1.
  - En intake web multi-sede, si el snippet envía `clinica_id` resuelto por teléfono y además `grupo_clinica_id`, backend puede validar la firma HMAC con la configuración de grupo. Esto evita rechazar leads o `CallInitiated` cuando el widget se ha cargado con secreto de grupo pero la sede final se resuelve en cliente.

- `GET /api/conversations`
  - Cuando se consulta por `lead_id` y todavía no existe conversación, backend puede crear una conversación WhatsApp on-demand si el lead tiene teléfono.
  - El objetivo es que drawers y vistas embebidas no queden bloqueados en estado vacío cuando el lead ya es contactable pero aún no ha abierto hilo.
- `GET /api/conversations/by-patient/:patientId`
  - Ruta canónica para drawers embebidos de agenda y ficha de paciente.
  - Debe resolver la conversación a partir del propio `Paciente`, sin depender del `clinic_id` que lleve el estado UI en frontend.
  - Devuelve `{ conversation, messages }`.
- `GET /api/conversations/by-lead/:leadId`
  - Ruta canónica para drawers embebidos de leads.
  - Debe resolver la conversación a partir del propio `LeadIntake`, sin depender del `clinic_id` activo en frontend.
  - Devuelve `{ conversation, messages }`.

- `CitasPacientes`
  - Se añaden `created_by` y `updated_by` para persistir el actor operativo que crea o modifica la cita.
  - Estos campos se rellenan en:
    - creación de cita
    - cambio de estado
    - reagendado
  - Si la cita nace desde marketing con `lead_intake_id`, backend copia `campana_id` desde `LeadIntake` cuando no llega un valor explícito.
  - El bloque completo de atribución (`source`, `source_detail`, `landing_url`, UTMs) sigue siendo canónico en `LeadIntake`; `CitasPacientes` no lo duplica como columnas propias.

- `GET /api/pacientes/:id/activity`
  - Nuevo endpoint de actividad operativa del paciente.
  - Devuelve eventos de cita construidos desde `CitasPacientes` con actor resuelto desde `Usuarios`.
  - Esto permite que el registro del paciente muestre acciones como `Cita agendada` indicando qué usuario ejecutó la operación.

## 2026-03-15 - Duplicidad canónica de paciente y señalización de leads

- **Paciente**
  - No se permite crear ni actualizar un paciente con el mismo teléfono/email que otro paciente ya existente dentro del scope de grupo clínico.
  - Si el duplicado ya está vinculado a la clínica de trabajo, backend responde `409 PACIENTE_DUPLICADO` con mensaje de `esta clínica`.
  - Si el duplicado pertenece a otra clínica del mismo grupo, backend responde `409 PACIENTE_DUPLICADO` indicando la clínica de origen.
  - El alta ya no reutiliza ni vincula pacientes de forma implícita. La reutilización queda como acción explícita de UI usando `checkDuplicates` + `vincularPacienteAClinica`.
  - La excepción funcional para compartir contacto no es “crear otro paciente con el mismo móvil”, sino modelar relación de tutor/guardián.

- **Leads**
  - `GET /api/intake/leads` y `GET /api/intake/leads/:id` enriquecen la respuesta con `patient_match`.
  - `GET /api/intake/leads` y `GET /api/intake/leads/:id` enriquecen además `linked_appointment` para no depender de lógica local en frontend al decidir si un lead ya está agendado.
  - Contrato de `patient_match`:
    - `exists`
    - `patient_id`
    - `same_clinic`
    - `clinic_id`
    - `clinic_name`
    - `match_field` (`phone | email`)
  - Este bloque permite marcar en UI:
    - `Ya paciente`
    - `Ya paciente de <clínica>`
  - `es_paciente` queda derivado de `patient_match` para no mantener dos fuentes de verdad.
  - `GET /api/intake/leads/:id/candidate-appointments`
    - Devuelve citas recientes del mismo contexto clínico susceptibles de vincularse a un lead que llamó.
    - Prioriza coincidencia por `lead_intake_id` y, en su defecto, por teléfono normalizado del paciente.
    - Contrato mínimo devuelto:
      - `id`
      - `fecha`
      - `hora`
      - `paciente_nombre`
      - `paciente_telefono`
      - `tratamiento`
      - `phone_match`
    - Esta ruta sirve para **resolución manual asistida** cuando no hubo auto-match.
    - Al crear una cita manual, `createCita` intenta primero resolver un `LeadIntake` pendiente de llamada en la misma clínica y con el mismo teléfono. Si lo encuentra y la cita no es `continuacion`, vincula automáticamente la cita al lead, hereda `campana_id` y cierra el `call_outcome` como `citado`.
  - `GET /api/intake/leads/:id/activity`
    - Añade actividad de cita (`Cita agendada`, `Estado de cita actualizado`) construida desde `CitasPacientes`.
    - Resuelve actor con `created_by` / `updated_by -> Usuarios`.
    - Esto evita que lead, agenda y ficha de paciente muestren cronologías distintas del mismo hecho operativo.

## 2026-03-16 - Trigger explícito en flujos V2

- **Trigger V2 sin activador por defecto operativo**
  - Un borrador nuevo puede persistirse con el flag interno `__trigger_unconfigured` en el nodo trigger.
  - Ese estado representa únicamente un placeholder de editor.
  - Backend permite guardar el borrador, pero bloquea `publishTemplateVersion` con `trigger_selection_required` mientras el flag siga presente.
  - El placeholder nunca debe llegar al runtime operativo.

## 2026-03-16 - Tratamientos e instalaciones permitidas

- `Tratamientos`
  - Nuevo contrato persistido para restringir dónde puede agendarse un tratamiento:
    - `asignacion_instalacion_tipo`: `cualquiera | especificas`
    - `tipo_instalacion_requerida`: tipo mínimo exigido cuando el modo es `cualquiera`
    - `instalaciones_habilitadas`: IDs explícitos cuando el modo es `especificas`
  - Migraciones:
    - `20260316113000-add-installation-assignment-to-tratamientos.js`
    - `20260316120500-add-installation-type-to-tratamientos.js`
- Agenda
  - Si el tratamiento exige `instalaciones específicas`, frontend solo ofrece esas instalaciones en el drawer y en la autoasignación.
  - Si el tratamiento exige `cualquier instalación de un tipo`, frontend filtra por `Installation.tipo`.
  - Si el tratamiento no define restricción de instalaciones, se mantiene el comportamiento general de agenda.

## Automation v2: Nodos y Acciones

### Nodo `action/write_note`

El nodo `action/write_note` en el motor de flujos v2 (`flowEngineV2.service.js`) ha sido actualizado para mejorar la legibilidad de las notas automáticas que se escriben en el historial de un paciente o cita.

Anteriormente, el timestamp se guardaba en formato ISO (`YYYY-MM-DDTHH:mm:ss.sssZ`). La nueva implementación formatea el timestamp a un formato más amigable para el usuario final en la zona horaria de Madrid.

- **Formato del Timestamp**: `dd/mm/yyyy hh:mm` (24 horas)
- **Implementación**: Se utiliza la función `formatAutomationTimestamp` que emplea `Intl.DateTimeFormat` con el locale `es-ES` y `timeZone: 'Europe/Madrid'`.
- **Contenido de la Nota**: El contenido final de la nota se prefija con este timestamp, resultando en: `[dd/mm/yyyy hh:mm] Contenido de la nota...`

```javascript
// src/services/flowEngineV2.service.js

function formatAutomationTimestamp(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date).replace(',', '');
  } catch (_err) {
    return date.toISOString(); // Fallback
  }
}

async function handleWriteNote(node, context, runtime) {
  // ...
  const timestamp = formatAutomationTimestamp(new Date());
  const noteLine = `[${timestamp}] ${content}`;
  // ...
}
```

Este cambio asegura que cuando el personal clínico revise el historial de notas, pueda identificar rápidamente cuándo se registró cada evento automático, mejorando la trazabilidad y la auditoría de las interacciones del flujo-automatizadas.

---

## Automation v2: Nodo `condition/ai_analysis` (Groq)

El nodo `condition/ai_analysis` quedó operativo en runtime real sobre Groq, con selección de modelo gestionada internamente por backend.

### Política de modelos (no configurable por usuario)

- `llama-3.1-70b-versatile`: tareas complejas (razonamiento clínico-operativo, más contexto, extracción amplia).
- `llama-3.1-8b-instant`: tareas rápidas de soporte/Q&A simple.
- El usuario del editor **no selecciona modelo**. Solo define el `analysis_mode` del nodo:
  - `quick_qa`
  - `complex_reasoning`
  - `auto` (heurística de backend)

### Contrato de configuración del nodo

`config` mínimo esperado:

```json
{
  "analysis_mode": "complex_reasoning",
  "prompt": "Instrucción del análisis",
  "input_text": "{{last_response}}",
  "max_tokens": 700,
  "output_format": {
    "decision": { "type": "string" },
    "reason": { "type": "string" }
  }
}
```

Reglas de validación relevantes:

- `analysis_mode` debe estar en `quick_qa | complex_reasoning | auto`.
- `max_tokens` (si se envía) debe estar entre `1` y `4096`.
- `output_format` debe tener al menos 1 campo y tipos válidos (`string | number | boolean`).
- `input_text` acepta placeholders inline en formato `{{ruta.variable}}`, combinados con texto libre.
  - Ejemplo: `Mensaje previo: {{last_prompt}}\nRespuesta: {{last_response}}`

### Variables de entorno

En `.env` / `.env.example`:

- `GROQ_API_KEY`
- `GROQ_API_BASE_URL` (default `https://api.groq.com/openai/v1`)
- `GROQ_MODEL_COMPLEX` (default `llama-3.1-70b-versatile`)
- `GROQ_MODEL_FAST` (default `llama-3.1-8b-instant`)
- `GROQ_TIMEOUT_MS` (default `20000`)
- `GROQ_STT_MODEL` (default `whisper-large-v3-turbo`, para transcripción de audio inbound WhatsApp)
- `GROQ_STT_TIMEOUT_MS` (default `30000`; si no existe usa `GROQ_TIMEOUT_MS`)
- `WHATSAPP_MEDIA_DOWNLOAD_MAX_BYTES` (default `25000000`, límite defensivo para descargar media inbound antes de STT)

### Notas operativas

- La API key de Groq se usa **solo en backend**.
- Si `GROQ_API_KEY` falta, `condition/ai_analysis` falla en runtime con `groq_api_key_not_configured`. No hay fallback silencioso.
- El output del nodo guarda además metadatos técnicos (`_ai_provider`, `_ai_model`, `_ai_analysis_mode`, `_ai_usage`) para auditoría y depuración.
- Al arrancar el backend, `src/app.js` deja un warning explícito en logs si `GROQ_API_KEY` no está definida.
- Además, `/api/job-requests/worker/status` marca `GROQ_API_KEY` como check fallido para que soporte lo vea desde UI.
- Requisito de producto pendiente: persistir consumo por usuario/clinic para facturación por uso.

### Audio inbound (WhatsApp) y hoja de ruta local

- Estado actual:
  - `workers/queue.workers.js` detecta `message.type = audio` en webhooks inbound de WhatsApp.
  - El worker descarga la media con el token activo de la clínica (`whatsappService.downloadMediaBuffer(...)`) y transcribe el buffer con Groq STT (`src/services/groqAudio.service.js`).
  - Se persiste como `Messages.message_type = text` para no migrar el enum actual. La semántica real queda en `Messages.metadata.media.kind = audio`.
  - `Messages.content` queda visible para soporte/QuickChat como el texto transcrito limpio, sin cabecera redundante. El badge de UI indica que procede de audio.
  - `Messages.metadata.audio_transcribed = true` y `Messages.metadata.audio_transcription` guarda `status`, `provider`, `model`, `text` y `transcribed_at`.
  - `resume_text` se emite por socket y se entrega al runtime V2 con el texto transcrito limpio, sin la cabecera visible. Así los nodos `wait_response` y `condition/ai_analysis` analizan lo que dijo el paciente.
  - Si falla descarga/STT, se persiste el mensaje `Audio recibido. No se pudo transcribir automáticamente.` con `metadata.audio_transcription.status = failed`; no se rompe el webhook ni se pierde trazabilidad.
  - **No** se persiste aún el binario de audio ni media estática propia.
  - Para escuchar el audio, `GET /api/conversations/messages/:messageId/media` valida permisos de conversación, solicita a Meta una URL temporal desde `metadata.media.id`, descarga el binario en backend y lo devuelve como stream/buffer autenticado al navegador.
  - Si el mensaje no tiene `metadata.media.id`, si el token ya no puede recuperar el audio o si Meta ya no lo conserva, el endpoint responde `410 audio_unavailable`. La UI muestra snackbar: `El audio ya no está disponible. La transcripción seguirá visible debajo.`
  - Esta reproducción es transicional y depende de la disponibilidad temporal de media en Meta. No debe tratarse como archivo histórico permanente.
- Reparación de audios huérfanos:
  - Si un worker antiguo guardó un audio como mensaje vacío con `metadata.media.kind = audio` pero sin `metadata.media.id`, no se puede pedir a Meta el audio solo con la fila de `Messages`.
  - Antes de darlo por perdido, se puede intentar recuperar el `media_id` desde el payload original de BullMQ/Redis (`bull:webhook_whatsapp:<jobId>`) si el job aún existe.
  - Si ese payload conserva `messages[].audio.id`, se puede reparar la fila de `Messages` asociando por `metadata.wamid`, descargar desde Meta y transcribir de nuevo.
  - Esto es una vía de contingencia, no un contrato operativo: si Redis ya purgó el job o Meta ya no conserva la media, solo quedará registrar el audio como no disponible.
- Estrategia de almacenamiento:
  - Fase actual: no hay storage propio; se solicita a Meta bajo demanda para transcribir y reproducir.
  - Fase con estáticos privados: al recibir un audio, además de transcribirlo, se guardará el binario en almacenamiento privado/autenticado (p.ej. S3 compatible o storage local protegido), se persistirá una referencia interna en `Messages.metadata.media.storage`, y el reproductor priorizará ese storage frente a Meta.
  - La migración a storage propio debe definir retención, borrado, permisos, cifrado y auditoría, porque los audios pueden contener datos sanitarios o personales.
- Objetivo futuro (servidor local):
  - Sustituir la llamada cloud STT por un servicio local de transcripción (p.ej. `faster-whisper`/`whisper.cpp`) detrás de un endpoint interno.
  - Mantener el mismo contrato de salida (`content` + `metadata.audio_transcription`) para no romper QuickChat ni automations.
  - Llama 3.1 seguirá para razonamiento de texto (`condition/ai_analysis`), y STT quedará desacoplado en el servicio de audio local.

## Leads: actividad operativa y conversación

- `GET /api/intake/leads/:id/activity`
  - Nuevo endpoint de actividad operativa del lead.
  - Agrega:
    - formularios (`FormSubmissionEvents`),
    - contactos registrados,
    - mensajes y plantillas de WhatsApp,
    - actor interno si existe (`Messages.sender_id -> Usuarios`).
- `POST /api/intake/events`
  - Procesa `CallInitiated` para tel-modal.
  - Si el lead deduplicado todavía no tenía `clinica_id`, el runtime lo enriquece a partir del request o del teléfono pulsado dentro del grupo.
  - Emite `lead:call_initiated` por socket a la clínica resuelta.
- `PUT /api/intake/leads/:id/call-outcome`
  - Registra el resultado operativo de la llamada (`citado`, `informacion`, `no_contactado`).
  - Emite `lead:call_outcome` por socket para cerrar alertas pendientes en UI.
  - El scope realtime debe ser coherente con el scope HTTP de conversaciones/leads. Para admin global, `socket.io` debe suscribirse a todas las clínicas del sistema, no solo a las presentes en `UsuarioClinica`; si no, el usuario ve la clínica en la API pero no recibe `lead:created` ni `lead:call_initiated` en vivo.
  - En integración, esto se validó expresamente porque era posible ver una clínica por API pero no recibir sus eventos en vivo si el socket no entraba en `clinic:{id}`.

- Socket / conversaciones
- `src/app.js` crea el servidor `socket.io` y resuelve el scope inicial de clínicas por usuario.
- `QuickChat` depende de que `/socket.io` y `/api` apunten al mismo backend; si no, los mensajes siguen entrando en BD pero no llegan a la UI en tiempo real.
- En integración, las colas `BullMQ` deben ir aisladas con `QUEUE_PREFIX=integracion`. Si el proceso comparte prefijo con `staging` u otro backend, los workers pueden consumir webhooks/mensajes en el proceso equivocado y el socket del entorno activo deja de emitir a su propia UI.
- Además, el realtime ya no depende solo del `ioInstance` local del proceso. `src/services/socket.service.js` publica y suscribe eventos por Redis (`clinicaclick:socket:events:<db>`), de forma que si el webhook real entra por `clinicaclick-auth` o cualquier otro backend PM2, `clinicaclick-integracion` recibe el evento y lo reemite a sus sockets conectados.
- Ese bus también cubre runtime V2. Cuando integración recibe por Redis un `message:created` inbound originado en otro backend, `src/app.js` reejecuta `enqueueInboundResponseResume(...)` con la conversación canónica. Sin este paso, el mensaje entra en BD y se ve en QuickChat, pero el flujo se queda en `wait_response` porque el backend que procesó el webhook no tiene por qué tener el runtime V2 activo.
- `Conversations.unread_count` se mantiene como dato agregado, pero el valor canónico de no leídos en UI es por usuario. `conversation.controller.js` recalcula `unread_count` desde `ConversationReads.last_read_at` también en endpoints de detalle (`getMessages`, `getConversationByPatient`, `getConversationByLead`) para evitar que una conversación abierta vuelva a mostrar badge tras recargar el hilo.
- El evento `message:created` ya no puede limitarse a `{ content, message_type }`. Debe incluir `metadata` y, cuando el inbound no es texto plano, un `resume_text` explícito para que el runtime V2 no dependa de reconstruir semántica desde la UI.

#### Punto crítico de arquitectura: inbound remoto y reanudación V2

Este comportamiento ya no debe tratarse como workaround local de integración. Forma parte del contrato técnico del sistema:

1. un webhook inbound puede entrar por cualquier proceso PM2 con acceso a la cola;
2. el mensaje debe persistirse una sola vez sobre la conversación canónica;
3. el evento `message:created` se publica por Redis;
4. el backend del entorno activo debe reintentar la reanudación `wait_response` usando `enqueueInboundResponseResume(...)`;
5. la ejecución debe continuar con `resume_mode=response` y consumir `waiting_meta.pending_response_text`.

Si falta el paso 4, el síntoma es engañoso:

- la UI muestra el mensaje del paciente;
- `last_inbound_at` queda bien en conversación;
- pero `FlowExecutionsV2.status` sigue en `waiting` y la cita no cambia de estado.

#### Reacciones de WhatsApp

Las reacciones del paciente también forman parte del contrato de inbound.

- WhatsApp Cloud API entrega esas respuestas como `messages[].type = reaction`, con `reaction.emoji` y `reaction.message_id`.
- En backend se persisten como `Messages.message_type = reaction`.
- `metadata.reaction` guarda:
  - `emoji`
  - `message_id`
  - preview del mensaje objetivo si existe en la conversación canónica
- Para `wait_response` e IA no se usa el emoji desnudo si procede de una reacción. Se genera un `resume_text` semántico del tipo:
  - `El paciente reaccionó 👍 a tu mensaje`
  - o, si se conoce el objetivo:
  - `El paciente reaccionó 👍 al mensaje: ...`

Esto evita dos regresiones:

1. que la reacción se vea en chat pero no dispare `wait_response`;
2. que el nodo IA reciba texto vacío al analizar la confirmación.
3. que una misma respuesta reactive varias ejecuciones pendientes en la misma conversación. Si hay varias `wait_response` abiertas para el mismo chat, el backend reanuda solo la más reciente y cancela las anteriores con `cancelled_reason = superseded_by_newer_waiting_execution`.

Regla funcional validada en QA para `condition/ai_analysis` con `preset_key = confirm_appointment`:

- reacción positiva explícita (`👍`, `✅`, `👌`, `🙌` y variantes cercanas) sobre el mensaje escuchado:
  - se trata como `confirmado` de forma determinista;
  - no depende del LLM;
  - enruta por `on_success`.
- reacción negativa o neutra (`👎`, `🤔`, etc.):
  - no se fuerza como éxito;
  - se analiza como respuesta no confirmatoria y debe terminar en `on_fail` salvo que el preset futuro decida otra semántica explícita.
- emoji escrito como texto normal:
  - no se trata como `reaction`;
  - entra como `text`;
  - lo analiza la IA/preset igual que cualquier otra respuesta escrita.

Checklist obligatorio al pasar a `staging` y luego a `main`:

- validar que el backend del entorno usa `QUEUE_PREFIX` propio;
- validar que `src/services/socket.service.js` publica y suscribe el bus Redis;
- validar una cita real con:
  - mensaje inicial,
  - respuesta inbound,
  - salida de `wait_response`,
  - `appointment:updated` emitido,
  - UI de agenda actualizando icono/estado sin abrir drawer.
  - `conversation.controller.js` emite eventos salientes (`message:created`, `message:updated`) en el mismo proceso HTTP.
  - `workers/queue.workers.js` emite eventos entrantes de WhatsApp (`message:created`) desde el worker BullMQ usando `getIO()` del mismo proceso backend.
  - Si el backend de integración se fragmenta en procesos separados sin adapter de Socket.io compartido, los jobs podrían persistir mensajes sin notificar a los clientes conectados a otro proceso. En el runtime actual de integración se asume proceso único (`fork_mode`).
  - Regla canónica de conversación WhatsApp:
    - debe existir una sola conversación por `clinic_id + contact_id`.
    - si el sistema detecta duplicados, backend los fusiona en lectura/escritura y reutiliza la conversación canónica.
    - inbound WhatsApp, QuickChat, drawers y runtime de flujos deben resolver siempre contra la misma conversación canónica.
    - si reaparecen dos conversaciones para el mismo número en la misma clínica, tratarlo como regresión porque rompe trazabilidad, ventana 24h y reanudación de `wait_response`.
    - al entrar una respuesta, `wait_response` reutiliza el job pendiente de la ejecución marcándolo con `resume_mode = response`; si el payload del job histórico no traía ese campo, el executor cae a `waiting_meta.resume_mode` y `waiting_meta.pending_response_text` antes de asumir `timeout`.
    - el backend que reanuda no tiene que ser el mismo que recibió el webhook. En integración se da por correcto que el webhook pueda entrar por otro proceso PM2 y que la reanudación final la haga `clinicaclick-integracion` a través del bus Redis.

#### Riesgos reales validados en QA y qué revisar antes de migrar

Estos puntos ya no son teoría. Han fallado de verdad durante QA en `integracion` y deben tratarse como checklist de migración:

- `wait_response` no debe arrancar el contador desde la entrada al nodo si el mensaje quedó retenido por `quiet_hours`.
  - Regla válida: el timeout empieza en `scheduled_for` o en la hora efectiva de salida del mensaje escuchado.
  - Síntoma si falla:
    - el paciente recibe el mensaje tarde;
    - el timeout vence antes o casi al mismo tiempo que la lectura real del mensaje.

- La reanudación por inbound no debe reciclar a ciegas el job histórico de timeout.
  - Regla válida: la respuesta crea o actualiza un job dedicado con `resume_mode = response`.
  - Síntoma si falla:
    - la ejecución se queda en `waiting`;
    - el webhook persiste el inbound;
    - pero el scheduler sigue tratando el caso como `timeout`.

- La conversación usada para reanudar debe ser la escuchada por el nodo (`listens_to_node_id`) y no una conversación antigua arrastrada en `context`.
  - Síntoma si falla:
    - el mensaje del paciente entra en QuickChat;
    - pero la ejecución no consume la respuesta correcta.

- El backend que recibe el webhook puede no ser el backend que ejecuta la automatización.
  - Regla válida:
    - `clinicaclick-auth` puede persistir el inbound;
    - `clinicaclick-integracion` o el runtime activo del entorno debe reclamar el job `automations_v2_execute`.
  - Síntoma si falla:
    - en logs de webhook aparece `owned_by_other_runtime:*`;
    - la ejecución queda en `waiting`;
    - el inbound existe en BD y se ve en la UI.

- El `runtime namespace` del job debe coincidir con el scheduler que realmente reclama jobs.
  - Regla válida:
    - jobs del entorno activo `integracion`: `port:3004`;
    - jobs del entorno activo `staging`: `port:3001`;
    - si en el futuro `crm` usa otro backend PM2 para reclamar jobs, debe tener su namespace explícito y único.
  - Síntoma si falla:
    - el job existe;
    - `next_run_at` ya venció;
    - pero el scheduler nunca lo reclama porque filtra por otro `__runtime_namespace`.

- Las pruebas manuales por shell también deben respetar ese namespace real.
  - Regla válida:
    - si se crean ejecuciones/jobs desde `node -e`, scripts puntuales o seeds de QA, hay que exportar `JOB_RUNTIME_NAMESPACE` del runtime activo antes de tocar `JobRequests` o `FlowExecutionsV2`.
  - Síntoma si falla:
    - el job queda con `cwd:/...`;
    - el scheduler real filtra por `port:*`;
    - la prueba parece rota aunque el runtime productivo esté bien.

  - Normalización de teléfono para CRM + WhatsApp:
    - se centraliza en `src/lib/phone.js`;
    - si el número llega con `+` o `00`, se respeta como internacional;
    - si llega sin prefijo y tiene `9` dígitos, se asume local español y se normaliza con `34`;
    - si llega sin `+` pero ya trae entre `10` y `15` dígitos, se trata como internacional tal cual, sin anteponer `34`.
    - esto evita errores como convertir `31618027729` en `+3431618027729`.
    - el mismo criterio se usa en intake, lead import, paciente, cita, runtime de automatizaciones, QuickChat y sender de WhatsApp.

- Conversaciones de lead
  - El modelo canónico para marketing es `LeadIntake`.
  - La vinculación correcta queda así:
    - `LeadIntake.clinica_id`
    - `Conversation.clinic_id`
    - `Conversation.lead_id -> LeadIntake.id`
  - `Lead` legacy no debe usarse ya en código nuevo de marketing/chat.
  - `GET /api/intake/leads/:id` y `GET /api/intake/leads/:id/activity` deben resolver `conversation_id` contra la conversación canónica, no contra una conversación arbitraria por `lead_id`.
  - Regla de integración:
    - los drawers que parten de `patient_id` o `lead_id` deben resolver por estas rutas canónicas (`by-patient`, `by-lead`) y no reenviar `clinic_id` desde el frontend salvo que estén listando conversaciones.
    - si se mezcla lookup por entidad con un `clinic_id` desfasado, el síntoma típico es chat vacío en agenda/leads aunque el inbound haya entrado y la conversación exista.

### Contrato canónico del catálogo de automatizaciones

El endpoint `/api/automation-catalog` acepta solo estos `trigger_type`:

- `lead_nuevo`
- `appointment_created`
- `appointment_confirmed`
- `appointment_cancelled`
- `appointment_reminder_window`
- `appointment_after`
- `patient_inactive`
- `quote_accepted`
- `treatment_completed`
- `birthday`

La migración `20260313134000-hard-cut-automation-catalog-trigger-types.js` normaliza:

- `AutomationFlowCatalog.trigger_type`
- `AutomationFlowCatalog.steps`
- `AutomationFlows.disparador`
- `AutomationFlows.pasos`
- `AutomationFlows.acciones`

Cleanup de integración:

- `/api/flows` deja de exponerse como superficie legacy.
- El circuito canónico de flujos queda en `automations/v2`.

### Contrato de `trigger_config` en `AutomationFlowTemplatesV2`

En integración, `AutomationFlowTemplatesV2` incorpora `trigger_config` como copia normalizada del `config` del nodo trigger. No es una segunda capa editable: backend la deriva al crear, actualizar y publicar una versión.

Contrato actual:

```json
{
  "appointment_scope": "all | with_treatment | without_treatment",
  "appointment_type_without_treatment": "any | primera_sin_trat | urgencia | revision",
  "day_proximity_filter": "all | exclude_day_before | exclude_same_day | exclude_same_day_and_day_before"
}
```

Reglas:

- Solo aplica a `trigger_type = appointment_created`.
- Para el resto de triggers, `trigger_config = null`.
- Si `appointment_scope !== without_treatment`, `appointment_type_without_treatment` se normaliza a `any`.
- `day_proximity_filter` delimita el trigger por cercanía en días respecto al momento en que se crea la cita.
  - `exclude_day_before`: no matchea si la cita se crea el día anterior.
  - `exclude_same_day`: no matchea si la cita se crea el mismo día.
  - `exclude_same_day_and_day_before`: no matchea ni el mismo día ni el día anterior.

Contratos temporales adicionales:

- `appointment_reminder_window`
  ```json
  {
    "schedule_moment": "same_day | day_before | week_before",
    "schedule_time_mode": "custom | one_hour_before",
    "custom_time": "HH:mm | null"
  }
  ```
- `appointment_after`
  ```json
  {
    "schedule_moment": "same_day | day_after | week_after",
    "schedule_time_mode": "custom | one_hour_after",
    "custom_time": "HH:mm | null"
  }
  ```

### Resolución de flujos de cita V2

`appointmentAutomationV2Runtime` usa esta precedencia:

1. **Flujo asignado al tratamiento**
   - Si la cita tiene `tratamiento_id` y ese tratamiento tiene `appointment_automation_template_key/version`, ese flujo gana.
2. **Fallback clinic/group/system**
   - Si no hay flujo por tratamiento, se buscan templates V2 publicados en el scope de clínica, grupo o sistema.
   - Solo se consideran como fallback los templates no asignados ya a tratamientos.
3. **Matching de `appointment_created`**
   - `with_treatment` solo matchea con citas que tienen tratamiento.
   - `without_treatment` solo matchea con citas sin tratamiento.
   - si `day_proximity_filter` está definido, el template se descarta según la fecha local de creación frente a la fecha local de la cita.
   - Para `without_treatment`, la prioridad es:
     - tipo exacto (`primera_sin_trat`, `urgencia`, `revision`)
     - `any`
     - `all`
   - Entre dos templates válidos del mismo scope, uno con filtro temporal explícito gana frente al genérico sin filtro.

Consecuencias:

- No debe dispararse más de un flujo V2 por el mismo `appointment_created`.
- Un template `without_treatment` no debe asignarse desde `PUT /api/tratamientos/:id/automation-template`.

### `condition/field_check` temporal

El nodo `condition/field_check` admite ahora dos contratos:

1. `simple`
   - comparador clásico `left_ref + operator + right_value`
2. `appointment_booking_timing`
   - switch temporal específico de cita creada

Contrato del modo temporal:

```json
{
  "mode": "appointment_booking_timing",
  "switch_type": "appointment_booking",
  "switch_rules": [
    { "id": "branch_1", "match_window": "same_day" },
    { "id": "branch_2", "match_window": "day_before" },
    { "id": "branch_3", "match_window": "more_than_day_before" }
  ]
}
```

Salidas requeridas:

- una por cada `switch_rule.id`
- `on_else`

Semántica:

- usa la fecha local de la clínica
- compara `CitasPacientes.created_at` frente a la fecha local de la cita (`inicio`)
- cada regla cubre una ventana cerrada por día natural
  - `same_day`: la cita se añadió a la agenda el mismo día que la cita
  - `day_before`: la cita se añadió a la agenda el día anterior al de la cita
  - `more_than_day_before`: la cita se añadió a la agenda más de un día antes de la fecha de la cita
- si no encaja en ninguna regla, sale por `on_else`

Validaciones:

- `switch_rules` no puede estar vacío
- no se repite `match_window`
- cada regla necesita su salida en `node.outputs`
- `on_else` es obligatorio

### `control/join` multirrama

- `control/join` sigue usando `mode = any`
- pero en integración ya converge dos o más ramas
- no depende de que la bifurcación previa sea estrictamente binaria

### Scheduler de cita

`appointment_reminder_window` y `appointment_after` se ejecutan mediante `JobRequests`, no por cambio de estado.

Contrato operativo:

- al crear, editar o reagendar una cita, backend llama a `syncScheduledTriggersForCita(cita)`;
- al publicar un flujo programado o reactivar una versión publicada, backend resincroniza citas futuras del scope del flujo para no depender de que la cita se edite después;
- se crean jobs `appointment_automation_schedule_fire` con `payload`:
  - `appointment_id`
  - `trigger_type`
  - `template_key`
  - `window_identifier`
  - `scheduled_for`
- cuando el job vence, `fireScheduledTrigger(payload)` resuelve la última versión publicada activa del `template_key` y crea una `FlowExecutionV2` normal.

Reglas importantes:

- `appointment_reminder_window` no debe programarse si la cita ya ha empezado;
- el backfill de publicación no dispara recordatorios retroactivos si la ventana ya pasó; solo deja programadas ventanas futuras;
- `appointment_after` sí puede quedar programado desde la creación inicial de la cita;
- el entorno debe aislar sus colas con `QUEUE_PREFIX` propio;
- tras una migración de namespaces, no dejar jobs `waiting` con `payload.__runtime_namespace` legacy. Si hace falta reclamar aliases, configurar temporalmente `JOB_RUNTIME_NAMESPACE_ALIASES` y retirarlo al terminar la migración;
- una resincronización de cita debe cancelar y recrear jobs programados cuyo `__runtime_namespace` no pertenezca al runtime actual;
- si varios procesos consumen la misma tabla/cola de jobs en un entorno, todos deben conocer `appointment_automation_schedule_fire` o bien solo uno de ellos debe actuar como scheduler. Si no, el síntoma es `No handler registered for job type 'appointment_automation_schedule_fire'`.
- Regla aplicada desde el 2026-03-24: cada scheduler debe reclamar solo los tipos que sabe ejecutar (`claimNextJob(..., allowedTypes)`). Esto evita que runtimes auxiliares como `clinicaclick-auth` fallen jobs de automatización V2 que pertenecen al backend funcional.

Caso real `2026-04-13`:

- recordatorios del día anterior en Propdental Eixample no salieron a las 09:00;
- algunas citas tenían jobs `waiting` vencidos con `payload.__runtime_namespace = port:3001`, pero `pm2-back-staging` ya reclamaba solo `staging`;
- otras citas no tenían job porque la cita existía antes de publicar/activar el flujo programado;
- no activar aliases ni reclamar jobs vencidos de pacientes reales sin confirmar si se deben enviar tarde.

### Diagnóstico real de una cita que "no disparó" la automatización

Si una cita parece no haber disparado `appointment_created`, el orden correcto de diagnóstico en integración es:

1. revisar `FlowExecutionsV2` por `trigger_entity_type = appointment` y `trigger_entity_id = <id_cita>`;
2. revisar `FlowExecutionLogsV2` para localizar el nodo exacto que falló;
3. revisar `AutomationFlowTemplatesV2.nodes` de la versión ejecutada, no solo la versión que el editor tenga abierta;
4. revisar la plantilla real en `WhatsappTemplates`, no el nombre lógico del nodo.

Caso real validado el `2026-03-27`:

- cita `99`
- clínica `57` (`Propdental Eixample`)
- doctora `Doctora`
- flujo ejecutado:
  - `FlowExecutionsV2.id = 41`
  - `template_version_id = 45`
  - `public_id = flw_1da2804bd8552a43`
  - `version = 14`
- resultado:
  - `status = failed`
  - `last_error = whatsapp_send_failed:(#132000) Number of parameters does not match the expected number of params`

La automatización **sí disparó**.
Lo que falló fue el nodo `N2 action/send_whatsapp`.

#### Error de configuración detectado

El nodo `N2` enviaba:

- `1 = {{paciente.nombre}}`
- `2 = {{profesional.nombre}}`
- `3 = {{cita.fecha}}`
- `4 = {{cita.hora}}`
- `5 = {{clinica.direccion}}`

Pero la plantilla real `clinicaclick_confirmacion_cita` (`WhatsappTemplates.id = 17`) solo tenía **4 placeholders** en `BODY` mientras el catálogo ya iba por 5.

Corrección aplicada en `feat/integracion` el `2026-03-27`:

- `send_whatsapp` ya usa contrato semántico (`variables_named`) y reconstruye `variables` según la plantilla operativa real;
- el runtime acepta que el nodo conserve variables adicionales semánticas aunque la plantilla activa todavía no las exponga posicionalmente;
- al propagar una plantilla, backend recompone automáticamente las automatizaciones V2 que la usan.

#### Estado actual de los flujos de cita

Tras el saneado del 2026-03-28, los flujos activos de cita quedan con esta semántica:

1. `wait_response` escuchando al nodo equivocado
   - corregido: `wait_response` escucha al nodo outbound real (`N2`)

2. `condition/ai_analysis` en preset `confirm_appointment`
   - `on_success` significa `decision = confirmado`
   - `on_fail` significa cualquier otro caso (`no_confirmado`, `dudas` o fallo técnico)
   - no se usa ya un `field_check` intermedio en estos flujos porque complicaba el grafo sin aportar nada al usuario
   - adicionalmente, ciertas reacciones positivas de WhatsApp (`👍`, `✅`, `👌`, `🙌`) se resuelven de forma determinista como `confirmado` antes de pasar por LLM

3. Falta de Groq en local o staging
   - el flujo falla de forma explícita en el nodo `condition/ai_analysis`
   - el error esperado es `groq_api_key_not_configured`
   - esto debe tratarse como problema de entorno, no como decisión funcional del flujo

4. Monitor de ejecuciones
   - `GET /api/automations/v2/executions` ya ordena por `updated_at DESC, id DESC`
   - así una ejecución antigua que recibe una respuesta nueva vuelve arriba en el monitor y no parece "desaparecida"

Corrección aplicada en los flujos activos de cita el `2026-03-28`:

- `wait_response` escucha al nodo outbound correcto (`N2`);
- `condition/ai_analysis` para `confirm_appointment` enruta directamente `confirmado` por `on_success` y el resto por `on_fail`;
- el monitor de ejecuciones ordena por última actividad.

### Preview de atribución en cita manual

- `GET /api/citas/manual-attribution-preview`
  - Se usa desde agenda cuando ya hay paciente identificado en una cita manual.
  - Backend resuelve tres casos:
    1. `pending_call_auto_link`: existe un `LeadIntake` pendiente de llamada en la misma clínica y con el mismo teléfono. Al guardar la cita manual se vinculará automáticamente.
    2. `patient_origin`: no hay llamada pendiente, pero sí un origen histórico conocido del paciente por teléfono/email.
    3. `manual_no_attribution`: no se encontró señal fiable.
  - Si `tipo_cita = continuacion`, devuelve `kind = continuation` y no intenta vincular leads de adquisición.

#### Estado actual del catálogo de automatizaciones

El `2026-03-27` la capa `AutomationFlowCatalog` no actúa todavía como fuente de verdad viva del sistema:

- `propagateCatalogAutomationToClinics(...)` crea o actualiza una nueva versión V2 por clínica y la **publica automáticamente** a partir de un `template_key` enlazado;
- la propagación debe resolver siempre el flujo base neutro del catálogo y no reutilizar copias de clínica como fuente;
- cada familia propagada por clínica debe tener `public_id` propio, distinto del asset base del catálogo;
- desactiva la versión publicada anterior de la misma familia en la clínica y deja activa la recién propagada;
- no versiona ni valida el contrato de placeholders de las plantillas WhatsApp que usan esos nodos;
- varios registros históricos del catálogo siguen con `template_key = NULL`, por lo que no son propagables como catálogo funcional.

Implicación:

- hoy no existe una garantía fuerte de alineación entre:
  - `AutomationFlowCatalog`
  - `AutomationFlowTemplatesV2` publicados
  - `WhatsappTemplateCatalog`
  - `WhatsappTemplates` operativas de la WABA

Si se quiere usar el catálogo como gobierno real, hacen falta al menos estas garantías:

1. todo item de catálogo debe enlazar a un `template_key` válido y publicado;
2. cada nodo `action/send_whatsapp` debe conservar contrato verificable de la plantilla elegida (`template_id`/`catalog_template_id` + número/semántica de placeholders);
3. publicar un flujo debe invalidarse si el contrato real de `WhatsappTemplates.components` ya no coincide con el nodo.

Regla operativa vigente tras el fix del `2026-04-01`:

- si el catálogo enlaza un flujo base por `public_id`, la propagación a clínicas debe:
  - preferir la versión **sin scope** (`clinic_id = null`, `group_id = null`);
  - normalizar cualquier `template_key` heredado quitando sufijos previos `__clinic_<id>`;
  - generar el `template_key` final de clínica como `<base>__clinic_<id>`;
  - asignar un `public_id` propio a la familia propagada de esa clínica.

Esto evita dos regresiones:

1. que el `template_key` se vaya concatenando (`base__clinic_1__clinic_19__clinic_22...`);
2. que publicar una copia de clínica desactive por accidente el flujo base del catálogo al compartir `public_id`.

#### Semántica pendiente de normalizar en contexto de cita

Contrato de negocio deseado:

- `usuario.*` = usuario logado que crea la cita
- `profesional.*` = doctor/profesional asignado a la cita

Estado real del runtime el `2026-03-27`:

- `flowEngineV2` sigue poblando `profesional.nombre` y `profesional.email` a partir de `created_by`;
- la variable del doctor asignado no está separada todavía en el contexto estándar.

Esto explica casos como la cita `99`, donde el mensaje usó `Graci Gonzalez` aunque la cita estaba asignada a `Doctora`.

- Ventana de 24h en WhatsApp
  - La ventana de texto libre se considera abierta solo si existe `last_inbound_at` real dentro de las últimas 24 horas.
  - Enviar una plantilla aprobada por Meta no abre por sí solo el chat libre.
  - Tras enviar una plantilla, la UI debe permitir seguir enviando plantillas, pero no texto libre, hasta que el paciente responda.
  - Si frontend vuelve a tratar una plantilla outbound como apertura de sesión, reaparecerán mensajes `failed` en Meta y estados visuales incoherentes entre QuickChat y drawers.

## 2026-03-15 - Recordatorios reales de volver a llamar

- `LeadIntake`
  - Nuevos campos:
    - `callback_reminder_at`
    - `callback_reminder_reason`
    - `callback_reminder_notes`
    - `callback_reminder_created_by`
    - `callback_reminder_job_id`
    - `callback_reminder_notified_at`
  - Migración: `20260315193000-add-callback-reminder-to-leadintakes.js`

- `POST /api/intake/leads/:id/contact`
  - Acepta:
    - `callback_reminder_at`
    - `callback_reminder_reason`
    - `callback_reminder_notes`
  - Si se informa recordatorio, backend:
    - cancela el job anterior si existía
    - agenda un `JobRequest` de tipo `lead_callback_reminder_notify`
    - persiste el recordatorio sobre el lead

- `PUT /api/intake/leads/:id/call-outcome`
  - Al resolver el resultado operativo de la llamada, backend limpia el recordatorio pendiente y cancela el job si seguía vivo.

- Notificaciones
  - Categoría: `crm`
  - Evento: `crm.call_back_reminder`
  - Destinatario: el usuario que creó el recordatorio (`callback_reminder_created_by`)

## 2026-03-15 - Lead enlazado a cita y agenda operativa

- `GET /api/intake/leads` y `GET /api/intake/leads/:id`
  - Enriquecen cada lead con `linked_appointment`.
  - Resolución:
    1. `call_outcome_appointment_id` si existe
    2. última cita por `lead_intake_id`
  - Objetivo: que el frontend no vuelva a ofrecer `Agendar` cuando ya existe una cita asociada.

- `GET /api/intake/leads/:id/candidate-appointments`
  - Devuelve citas recientes del mismo contexto clínico para resolver manualmente una llamada (`call_outcome = citado`).
  - Matching actual:
    - misma clínica del lead
    - ventana configurable por query `hours` (default `48`)
    - prioridad implícita a citas enlazadas por `lead_intake_id`
    - fallback por coincidencia de teléfono del paciente

- `GET /api/intake/leads/:id/activity`
  - Ya no refleja solo formularios y WhatsApp.
  - Agrega también la cita creada desde ese lead, con actor (`created_by` / `updated_by`) resuelto desde `Usuarios`.
  - Esto alinea el timeline del lead con agenda y ficha de paciente.

- `GET /api/citas/:id`
  - Sigue siendo el detalle operativo de la cita.
  - El drawer de agenda en integración usa `GET /api/pacientes/:id/activity` como fuente principal de `Registros`, filtrando por `citaId`, para no reconstruir actividad local divergente.

## 2026-03-15 - Contexto V2 enriquecido con datos clínicos

- `buildHydratedExecutionContext`
  - Para triggers de cita ya expone:
    - `profesional.nombre`
    - `profesional.email`
    - `cita.usuario_nombre`
    - `cita.usuario_email`
    - `clinica.direccion`
    - `clinica.telefono`
    - `clinica.url_web`
    - `clinica.url_ficha_local`

- Criterio
  - `usuario.*` es el usuario operativo que agenda/crea la cita.
  - `profesional.*` es el doctor o profesional asignado a la cita.
  - `cita.usuario_*` se conserva como alias de compatibilidad para plantillas anteriores.
  - No se inventan valores derivados: la URL de ficha local solo se expone si existe en `Clinicas.url_ficha_local`.

## 2026-04-13 - Contacto de clínica separado y WhatsApp efectivo

- `Clinicas.telefono` se mantiene como compatibilidad legacy.
- Nuevos campos persistidos:
  - `telefono_fijo`
  - `telefono_movil`
  - `telefono_whatsapp`
- `GET /api/clinicas/:id` enriquece la respuesta con:
  - `telefono_whatsapp_conectado`
  - `whatsapp_connected`
- `telefono_whatsapp_conectado` se deriva de `ClinicMetaAsset` (`assetType='whatsapp_phone_number'`) priorizando asignación de clínica y usando grupo como fallback. No debe editarse manualmente.
- `GET /api/intake/config` construye `available_locations[].whatsapp` con prioridad:
  1. WhatsApp Business conectado a la clínica.
  2. `Clinicas.telefono_whatsapp`.
  3. WhatsApp Business conectado al grupo.
  4. móvil/fijo normalizado como fallback.
- `GET /api/intake/config` añade `available_locations[].opening_hours_text` para variables de chat. Se calcula desde `ClinicaHorarios` activos y agrupa días consecutivos con el mismo horario, por ejemplo `L-J de 9 a 20h y V de 10 a 14h`.
- Migración:
  - `20260413101000-add-clinic-contact-phone-fields.js`
  - copia inicialmente `Clinicas.telefono` a `Clinicas.telefono_fijo` si el nuevo campo está vacío.

## 2026-04-13 - Variables canónicas en flujos de chat web

- El runtime público de `intake.js` resuelve variables `{{ruta.con.puntos}}`.
- Variable canónica de nombre de paciente: `{{paciente.nombre}}`.
- Variable de horario de apertura: `{{clinica.horario_apertura}}`, alimentada por `available_locations[].opening_hours_text`.
- Variables dinámicas de datos recogidos: `{{lead.<campo>}}`, solo válidas para campos capturados en pasos anteriores.
- Alias legacy `{{nombre}}` sigue funcionando en runtime, pero no debe usarse en plantillas nuevas.
- Migración:
  - `20260413102000-normalize-chat-flow-patient-name-variable.js`
  - normaliza JSON existentes en `ChatFlowTemplates.flow`, `ChatFlowTemplates.flows`, `ChatFlowTemplates.texts` e `IntakeConfigs.config`.

## 2026-03-24 - Contexto conversacional canónico para IA

- `buildHydratedExecutionContext` y el runtime de `wait_response` ya exponen:
  - `last_prompt`
  - `last_response`
  - `last_response_context`
  - `conversation_today`
  - `conversation_this_year`
  - `conversation_all_time`

- `conversation_*` se construye desde `Conversations` + `Messages`:
  - usando horario `Europe/Madrid`
  - excluyendo mensajes `event` y `reaction`
  - formateando cada línea con:
    - fecha/hora
    - autor (`Clínica` o `Paciente`)
    - texto

- Criterio operativo:
  - `last_*` sirve como atajo tras `wait_response`
  - para análisis conversacional real, la clave recomendada es `conversation_today`
  - el runtime ya no soporta aliases `context.*`
  - la corrección de aliases viejos se hace en:
    - editor
    - normalización backend
    - migraciones de datos
  - los presets IA conocidos que antes persistían `last_prompt/last_response` se reescriben a su forma canónica:
    - `confirm_appointment` -> `conversation_today` + `last_response_context.responded_at`
    - `summarize_conversation` -> `conversation_today`

- Límites defensivos:
  - `conversation_today`, `conversation_this_year` y `conversation_all_time` se truncan si el histórico crece demasiado
  - el objetivo es evitar prompts infinitos, no ocultar mensajes recientes

## 2026-03-24 - Identidad canónica de flujos V2

- `AutomationFlowTemplatesV2` añade `public_id`.
- `public_id` identifica la familia de flujo para navegación y lectura.
- `template_key` sigue siendo la clave operativa de binding para:
  - tratamientos
  - catálogo
  - resolución de la última versión activa

Reglas:

- varias versiones del mismo flujo comparten el mismo `public_id`
- el editor y el frontend deben navegar por `public_id`
- el backend acepta `template_ref` en rutas de lectura/escritura:
  - puede ser `public_id`
  - o `template_key` como compatibilidad beta
- los flujos nuevos no deben depender de que el nombre genere un `template_key` único:
  - si no llega `template_key` explícito, backend genera uno único para evitar colisiones por nombre

## 2026-03-15 - Timeline y acciones de cita en integración

- `GET /api/pacientes/:id/activity`
  - Devuelve eventos `appointment_*` con:
    - `descripcion` multilinea legible;
    - `descripcion_html` para drawers que quieran resaltar fecha, hora, teléfono y tratamiento;
    - `usuarioNombre` en formato `Nombre Apellidos <email>`.

- `GET /api/intake/leads/:id/activity`
  - Añade también:
    - formularios;
    - llamadas y recordatorios;
    - mensajes WhatsApp;
    - citas vinculadas al lead con el mismo formato rico (`descripcion_html`).

- `PATCH /api/citas/:id/estado`
  - Es el contrato canónico para cancelar o cambiar estado de una cita desde agenda.
  - Persistencia:
    - actualiza `CitasPacientes.estado`;
    - guarda actor en `updated_by`;
    - dispara `appointmentAutomationV2Runtime` si el nuevo estado mapea a un evento V2.

## 2026-03-15 - Catálogo V2 y legado retirado en integración

- `catalogo-automatizaciones`
  - Sigue expuesto como catálogo de metadatos.
  - Ya no debe crear ni editar `AutomationFlow` legacy.
  - La propagación a clínicas crea o actualiza versiones V2 por clínica, las publica automáticamente y las enlaza operativamente por `template_key`.
  - `template_version` queda como campo histórico de transición y deja de ser binding operativo.

- Tratamientos y cita
  - El contrato vigente es `GET/PUT /api/tratamientos/:id/automation-template`.
  - La resolución canónica es:
    - tratamiento guarda `appointment_automation_template_key`;
    - runtime resuelve la última versión publicada activa (`published_at != null`, `is_active = true`);
    - las versiones publicadas anteriores del mismo `template_key` pasan a `deprecadas`.
  - Desactivar un flujo publicado en clínica lo saca de la resolución operativa:
    - `appointment_created` no lo volverá a seleccionar en `resolveClinicFallbackTemplate(...)`;
    - los recordatorios/after ya programados no se ejecutan, porque `fireScheduledTrigger(...)` vuelve a comprobar `is_active = true` y `published_at != null` antes de lanzar la ejecución;
    - el resultado práctico es que desactivar el flujo en clínica detiene la automatización sin necesidad de borrar jobs pendientes.
  - Las superficies v1 de flujos de cita (`AppointmentFlowTemplate`, `AppointmentFlowInstance`, `/api/tratamientos/:id/flow`, `/api/appointment-flow-templates`) se consideran retiradas en integración.

- Merge hygiene
  - Si reaparecen referencias activas a `Lead`, `AutomationFlow`, `AppointmentFlowTemplate` o `/api/flows` en este circuito, tratarlo como regresión de integración y no como compatibilidad legítima.
## 2026-03-16 - Reglas de integración endurecidas

### Lead y cita

- `LeadIntake.status_lead = citado` requiere una cita activa real.
- Estados de cita tratados como activos para el vínculo lead -> cita:
  - `pendiente`
  - `info_enviada`
  - `info_confirmada`
  - `recordatorio_enviado`
  - `recordatorio_confirmado`
  - `reprogramada`
- `cancelada` no mantiene al lead como `citado`.
- `enrichLeadsWithLinkedAppointments()` ignora citas no activas para `linked_appointment`.

### Intake web: precedencia de scope

- Un widget puede venir firmado con configuración de grupo y aun así resolverse a una clínica concreta.
- Regla aplicada en integración:
  - si el dominio del formulario tiene `IntakeConfig` de clínica, el lead persiste con `clinica_id` de esa clínica;
  - la firma HMAC válida de grupo sigue siendo aceptada si fue la que firmó el widget;
  - `grupo_clinica_id` se conserva si existe o se infiere desde la clínica.
- Si solo se puede resolver `grupo_clinica_id` y no hay clínica inequívoca:
  - el lead ya no se deja a nivel grupo “huérfano”;
  - se asigna a la primera clínica creada del grupo como fallback operativo.
- Esto evita que un lead de web quede invisible en `marketing/leads` cuando el usuario está filtrando por una clínica concreta del grupo.

### wait_response

- La reanudación automática por inbound debe matchear por identidad conversacional real:
  - `conversation_id`
  - `patient_id`
  - `lead_id`
- Se evita hacer match por `appointment_id` en respuestas WhatsApp.
- El `JobRequest` de tipo `automations_v2_execute` se actualiza con `resume_mode=response` y el payload inbound consolidado antes de volver al scheduler.
- La respuesta inbound no debe sobrescribir el timeout histórico sin más. Debe existir un job efectivo reclamable por el scheduler con:
  - `resume_mode = response`
  - `response_text`
  - `inbound_message_id`
  - `inbound_conversation_id`
- `waiting_meta.runtime_namespace` y `payload.__runtime_namespace` deben apuntar al mismo runtime que reclama jobs en ese entorno.
- Si el mensaje outbound escuchado salió más tarde por horario silencioso, `wait_starts_at` debe anclarse a esa hora efectiva de salida, no a la entrada inicial al nodo.
- Si una ejecución se queda en `waiting` pero el job asociado falla con `No handler registered for job type 'automations_v2_execute'`, el problema es de scheduler/claiming, no de plantilla ni del nodo `wait_response`.
- En QA de automatizaciones con WhatsApp conviene distinguir siempre:
  - reacción (`message_type = reaction`);
  - emoji enviado como texto (`message_type = text`);
  - texto ambiguo (`Tengo dudas`, `No podré ir`, etc.).
  El flujo puede tratarlos distinto aunque visualmente el usuario vea solo un emoji o una respuesta corta.

### Checklist cerrada para migrar a `staging` o al backend que sirva CRM

Antes de mover tráfico real o de declarar estable el runtime nuevo, verificar en este orden:

1. Namespaces
   - cada PM2 que reclame jobs debe tener un `JOB_RUNTIME_NAMESPACE` estable o un `PORT` estable;
   - revisar que el scheduler del entorno objetivo filtra exactamente por ese namespace;
   - no dejar jobs vivos con namespace del entorno anterior.

2. Liderazgo de cron
   - exactamente un runtime con `JOBS_CRON_LEADER=true` por base de datos;
   - el resto `false`.

3. Colas y webhook
   - `QUEUE_PREFIX` aislado por entorno;
   - webhook WhatsApp entrando por el runtime previsto o, si entra por otro, Redis/socket-bus funcionando.

4. Reanudación V2
   - crear una ejecución real con `wait_response`;
   - responder desde WhatsApp;
   - validar que:
     - se crea job `resume_mode=response`;
     - el scheduler del entorno objetivo lo reclama solo;
     - la ejecución sale de `waiting` sin intervención manual.

5. Horario silencioso
   - repetir una prueba con `quiet_hours` o con `scheduled_for` forzado;
   - validar que el timeout empieza cuando el paciente ve el mensaje, no antes.

6. QuickChat / CRM
   - el inbound debe verse en la conversación canónica;
   - la automatización debe consumir esa misma conversación;
   - no debe aparecer doble conversación ni reanudación sobre un chat viejo.

7. QA manual
   - cualquier script manual que cree ejecuciones o jobs debe exportar el namespace real del entorno objetivo;
   - si no, los jobs quedarán invisibles para el scheduler y la prueba será falsa.

### Execution monitor

- Aunque el acceso backend sigue siendo por permisos, la UX esperada en integración es que el front envíe `clinic_id` según el selector global para no mezclar ejecuciones de clínicas distintas en una misma pantalla.


---

## 2026-03-22 - Runtime actual: estrategias de campaña y `Campañas Admin`

> **Estado:** Operativo en integración. El runtime sigue funcionando como adapter sobre `Campaign` + `CampaignRequest`, pero la capa de estrategias, edición, campañas externas y `Campañas Admin` ya está activa y consumida por el frontend.

### 1. Persistencia real hoy

No existe todavía una tabla nativa `Strategy`. El runtime persiste sobre:

- `Campaign`
- `CampaignRequest`
- JSON `solicitud`

En esa carga se guardan, entre otros:

- configuración base de la estrategia,
- `external_targets`,
- `target_destinations`,
- `target_summaries`,
- configuración de automatización.

### 2. Rutas operativas de Marketing

| Método | Ruta | Estado | Uso |
|---|---|---|---|
| GET | `/api/marketing/campaign-onboarding/bootstrap` | Operativo | scope, webs, cuentas y capacidades base |
| GET | `/api/marketing/campaign-onboarding/external-campaigns` | Operativo | campañas externas Google/Meta por scope |
| GET | `/api/marketing/strategies/catalog` | Operativo | catálogo consumido por el wizard |
| GET | `/api/marketing/strategies/recommend-automation` | Operativo | recomendación de automatización |
| GET | `/api/marketing/strategies` | Operativo | listado de estrategias |
| POST | `/api/marketing/strategies` | Operativo | creación de estrategia |
| GET | `/api/marketing/strategies/:id` | Operativo | detalle completo para rehidratar edición |
| GET | `/api/marketing/strategies/:id/analysis/campaign` | Operativo | estructura lazy por campaña vinculada usando tablas cacheadas |
| PATCH | `/api/marketing/strategies/:id` | Operativo | edición real |
| PATCH | `/api/marketing/strategies/:id/status` | Operativo | transiciones de estado |
| GET | `/api/marketing/strategies/:id/metrics` | Operativo | métricas live de estrategia |
| GET | `/api/marketing/google-ads/conversion-actions` | Operativo | readiness de conversiones Google Ads |
| POST | `/api/marketing/google-ads/conversion-actions/ensure` | Operativo | crea/reutiliza conversiones recomendadas |

### 3. Reglas de negocio activas hoy

- **Una estrategia en curso por objetivo y scope.** Backend bloquea crear otra estrategia activa/en curso para el mismo objetivo.
- **`connect_only` requiere campañas externas vinculadas.** No es válido como estrategia "vacía".
- **Una campaña externa no se reutiliza entre estrategias en curso.**
- **`connect_only` nace activa.** No sigue workflow de aprobación.
- **`managed_*` mantienen lifecycle clásico** (`draft`, `pending_approval`, `active`, `paused`, `completed`) donde aplica.

### 4. `connect_only`: campañas externas por target

La estrategia puede guardar varias campañas externas por target.

**Targets soportados:**
- tratamiento concreto
- bloque genérico

**Payload persistido:**
- `external_targets`
- `target_destinations`

**Hydration de detalle:**
- el backend devuelve `external_targets` ya enriquecidos con métricas live
- además construye `target_summaries` para cards y detalle

### 5. Detección de destino y datos enriquecidos

`GET /api/marketing/campaign-onboarding/external-campaigns` ya devuelve campañas externas sincronizadas de Google Ads y Meta Ads con:

- cuenta
- estado
- métricas
- `destination_detection`

`destination_detection` puede ser:

- `web`
- `lead_form`
- `unknown`

e incluye, cuando existe:

- URLs detectadas
- datos de formulario instantáneo de Meta
- preview creativo resumido
- preview Google Ads (headlines, descriptions, display URL y sitelinks) cuando la sincronización ya lo conoce

> **Nota operativa:** el detalle de estrategia ya preserva `destination_detection` dentro de `external_targets`. Antes se perdía al normalizar el payload; desde marzo 2026 se mantiene para que la UI pueda reutilizar previews y tipos de destino al reabrir una configuración.

### 5.1. Análisis lazy por campaña

`GET /api/marketing/strategies/:id/analysis/campaign` resuelve bajo demanda la estructura de análisis de una campaña externa vinculada:

- `provider`
- `external_campaign_id`
- `timeframe` (`yesterday | last_week | last_7_days | last_month | all_time`)

**Fuente de datos:**
- Google Ads: `GoogleAdsInsightsDaily` cacheada
- Meta Ads: `SocialAdsEntity`, `SocialAdsInsightsDaily` y `SocialAdsActionsDaily` cacheadas

**Cobertura real actual:**
- Google Ads: campaña → ad group real; preview creativo reutiliza el material ya detectado a nivel campaña
- Meta Ads: campaña → ad set → ad con métricas reales cacheadas

**Payload operativo actual:**
- cada fila puede devolver `thumbnail_url`
- cada fila de anuncio puede devolver `creative_image_url`, `creative_text`, `creative_cta`, `creative_destination_url`
- Google puede devolver además `google_ads_headlines`, `google_ads_descriptions`, `google_ads_display_url` y `google_ads_sitelinks`
- Meta puede devolver además `instant_form_name`, `instant_form_questions` y `follow_up_url`

Esto permite:
- modal de creatividad sin llamadas live adicionales
- carga lazy del tab `Análisis`
- reutilizar el mismo endpoint para recalcular métricas de las cards resumen por rango temporal

**Límite actual:**
- Google Ads todavía no tiene creatividad/ad-level persistida en cache con el mismo nivel de detalle que Meta, así que el último nivel visual puede seguir apoyándose en preview resumido de campaña

### 6. Métricas live y atribución CRM

#### A nivel estrategia

`buildLiveStrategyMetrics(...)` recalcula:

- `investment`
- `leads`
- `conversions`
- `cpl`
- `cost_per_conversion`

usando campañas externas vinculadas y, cuando hay señal suficiente, atribución CRM.

#### A nivel target

`buildTargetSummaries(...)` devuelve:

- `investment`
- `leads`
- `channel_conversions`
- `crm_conversions`
- `patients_converted`

La atribución CRM usa `LeadIntake` y solo se acepta cuando el match con la campaña externa es no ambiguo. Si no lo es, el lead no se atribuye.

> **Pendiente real:** ingresos y rentabilidad por target. No están cerrados todavía y no deben documentarse como operativos.

### 7. Recomendación de automatización

`GET /api/marketing/strategies/recommend-automation` sigue resolviendo por clínica, incluso en scope grupo, con la cascada:

1. `objective + treatment + clinic`
2. `objective + treatment + group`
3. `objective + treatment + global`
4. `objective + area_medica + clinic`
5. `objective + area_medica + group`
6. `objective + area_medica + global`
7. `objective + clinic`
8. `objective + group`
9. `objective + global`

La respuesta se consume ya desde el wizard y no debe tratarse como contrato futuro.

### 7.1. Estado real de plantillas WhatsApp propagadas

Para `WhatsappTemplates`, el backend ya distingue entre:

- `PENDING`: la plantilla se ha enviado realmente a Meta y está en revisión.
- `PENDING_LOCAL`: el catálogo local cambió y se propagó a clínica, pero todavía no existe una revisión remota equivalente en Meta para esa versión.
- `APPROVED`, `REJECTED`, `SIN_CONECTAR`: se mantienen con su semántica habitual.

Regla operativa:

- si existe una plantilla remota con el mismo nombre pero distinto contrato Meta-facing, la propagación debe intentar abrir igualmente una revisión real en Meta;
- si Meta acepta esa creación, el override local queda en `PENDING`;
- si Meta la rechaza, el override local queda en `PENDING_LOCAL` y se persiste el motivo exacto devuelto por Meta en `rejection_reason`;
- el `syncTemplatesForWaba(...)` solo sube el override a `APPROVED` cuando el contenido remoto coincide realmente.
- el `syncTemplatesForWaba(...)` tampoco debe heredar el `meta_template_id` de la plantilla remota vieja cuando el contenido no coincide, para no dar a entender que esa revisión remota corresponde al override local.

Diagnóstico real aplicado el `2026-03-31`:

- se verificó directamente contra Meta que `clinicaclick_confirmacion_cita` seguía aprobada solo con `4` placeholders;
- la versión local propagada con `5` placeholders no tenía revisión real abierta en Meta;
- por eso podían pasar días sin cambiar de estado: no era un fallo del job, sino un estado local mal interpretado.

Implicación operativa:

- si una plantilla queda en `PENDING_LOCAL`, esperar no basta por sí solo;
- ese estado significa que ClinicaClick tiene un cambio local, pero Meta todavía no tiene una versión remota equivalente aprobable para ese contenido.

Además, el motor V2 ya bloquea el envío de plantillas que no estén en `APPROVED`.

### 7.2. Catálogo de plantillas: `Propagada` vs `Aprobada`

En `catalogo-plantillas` ya no debe asumirse que ambos conceptos significan lo mismo:

- `Propagada = Sí`:
  - la propagación local terminó correctamente;
  - la cola de backend acabó sin error;
  - el catálogo selló `last_propagated_at`;
  - no implica aprobación remota en Meta.

- `Aprobada = Sí`:
  - la versión técnica más reciente propagada de esa familia ya está `APPROVED` en Meta;
  - si la versión más nueva sigue `PENDING`, el catálogo debe mostrar `Aprobada = No` aunque `Propagada = Sí`.
  - el cálculo se hace sobre la versión técnica más nueva de las instancias remotas activas (`waba_id != null`);
  - clínicas sin WABA o placeholders `SIN_CONECTAR` no cuentan para el `Sí`;
  - si una sola clínica conectada queda `PENDING`, `REJECTED` o `PENDING_LOCAL` en esa versión más nueva, el catálogo muestra `Aprobada = No`.

- `Propagada = En proceso`:
  - la plantilla ya fue encolada para propagación;
  - el worker aún no ha terminado;
  - cuando el worker completa, pasa a `Sí` o vuelve implícitamente a `No` si luego se edita otra vez.

Reglas de validación local antes de propagar a Meta:

- el `BODY` no puede empezar por una variable;
- el `BODY` no puede terminar en una variable;
- no puede haber variables consecutivas sin texto fijo entre ellas.

Si se incumplen, backend debe devolver `400 invalid_template_body` y no encolar la propagación.

### 8. `Campañas Admin` (`AdminCampaignPlaybook`)

Ya existe runtime real para la capa de campañas admin:

- modelo Sequelize
- migración
- controlador
- rutas CRUD

**Rutas:**

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/admin/campaign-playbooks` | Listar |
| GET | `/api/admin/campaign-playbooks/:id` | Detalle |
| POST | `/api/admin/campaign-playbooks` | Crear |
| PUT | `/api/admin/campaign-playbooks/:id` | Actualizar |
| DELETE | `/api/admin/campaign-playbooks/:id` | Eliminar |

**Reglas activas:**

- `catalog_key` único
- validación de `promotion_kind`
- `treatment_id` solo para `treatment_specific`
- `area_medica` / `family_key` solo para `generic_campaign`
- `measurement_profile` incluye `remarketing` y `ad_calls`
- `automation_strategy.mode` soporta `inherit_recommendation`, `force_template`, `none`
- `force_template` valida automatización activa con plantilla publicada

### 9. Conexión real con el wizard

La conexión ya no es futura:

- el wizard de `new_patients` consume campañas admin activas para saber qué tratamientos o campaña general pueden promocionarse
- `Campañas Admin` filtra el catálogo visible del wizard
- `connect_only` usa además campañas externas reales por target

La parte que sigue pendiente no es servir playbooks, sino cerrar capacidades avanzadas como:

- ingresos por target,
- formularios instantáneos operativos end-to-end,
- ejecución fully-managed desde ClinicaClick.
## Agenda: persistencia de ajustes por clínica

La agenda ya persiste su configuración operativa en:
- `Clinica.configuracion.agenda_settings`

Estructura actual:

```json
{
  "hideSaturdays": true,
  "hideSundays": true,
  "hideClosedHours": true,
  "useDurationFirstNoTreatment": false,
  "durationFirstNoTreatment": 30,
  "useDurationUrgencia": false,
  "durationUrgencia": 30,
  "useDurationRevision": false,
  "durationRevision": 30
}
```

Criterio:
- el backend no necesita tabla nueva
- se apoya en `PATCH /api/clinicas/:id`
- el merge sigue siendo no destructivo sobre `configuracion`

## Automatizaciones v2: notificación interna y saludo horario

### Variable canónica de saludo horario

El motor soporta la variable:
- `{{runtime.day_part_greeting}}`

Resolución:
- se calcula en hora `Europe/Madrid`
- se resuelve con la hora efectiva de envío del nodo `action/send_whatsapp`
- si el mensaje se reprograma por quiet hours, se usa la hora programada real, no la hora original del flujo

Rangos actuales:
- `06:00-13:59` → `Buenos días`
- `14:00-20:59` → `Buenas tardes`
- resto → `Buenas noches`

### Nodo `action/send_system_notification`

Nuevo nodo real del motor.

Objetivo:
- emitir una `Notification` interna a usuario/rol/subrol de la clínica

Resolución de destinatarios:
- reutiliza `resolveTaskAssigneeUserIds(...)`
- por tanto respeta exactamente el mismo modelo de pertenencia clínica que `action/create_task`

Campos:
- `title`
- `message`
- `assignee_type`
- `assignee_id`
- `subrole`

Contexto extra que inyecta antes de interpolar:
- `runtime.day_part_greeting`
- `system.patient_conversation_link`
- `system.patient_detail_link`

Comportamiento de navegación:
- si existe conversación, la notificación guarda `quickChatConversationId`
- el front puede abrir QuickChat directamente desde la notificación
- si no hay conversación, el fallback navegable es la ficha del paciente
