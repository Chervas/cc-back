# Runbooks operativos del backend

Este índice separa la arquitectura general de los procedimientos que deben usarse para operar o verificar Marketing. La fuente canónica de arquitectura es `src/Documentacion/13-backend.md`; su copia en el repositorio frontend es un espejo completo para conservar enlaces internos y debe sincronizarse después de cada cambio.

## Marketing, intake y Google Ads

| Documento | Cuándo usarlo |
|---|---|
| [Google Data Manager: conversiones server-side](./google-data-manager-conversions.md) | Contrato de transporte, Conversiones mejoradas, Consent, evidencia controlada, estados asíncronos, reconciliadores y runbook de atribución real. |
| [Política de goals Google Ads v4](./google-ads-goal-policy-v4.md) | Custom goals, cohortes, lifecycle, aprobaciones, executor y límites entre `connect_only` y `managed_service`. |
| [Google Ads Standard Access](./google-ads-standard-access.md) | Límites de acceso/proveedor y resumen externo del diseño actual. |
| [Diagnóstico de medición por campaña](./google-ads-campaign-measurement.md) | Diferencia conversiones principales, todas las conversiones y leads CRM; comprueba destinos/cobertura sin modificar campañas. |
| [E2E controlado de intake y limpieza](./intake-e2e-cleanup.md) | Formulario/chat/teléfono, routing estricto, datos sintéticos y limpieza segura. |
| [Activos compartidos de grupo y asignaciones clínicas](./group-asset-mapping.md) | Contrato de conexión única por scope, activo efectivo propio/heredado/asignado, consumo común entre módulos y excepción de alias de ficha solo para reseñas. |
| [Visibilidad local en ChatGPT y Gemini](./marketing-ai-visibility.md) | Consultas locales canónicas, autoejecución desde Informes, caché/deduplicación, estados sin secretos y contrato server-side de OpenAI/Gemini. |
| [Adaptador offline ModSuite](./modsuite-offline-adapter.md) | Migración allowlisted de exports legacy a WebDocument v1, informe de revisión, límites y ejecución local sin runtime legacy. |

## Marketing Web: editor y publicación

Fuente canónica de arquitectura: `src/Documentacion/13-backend.md`, secciones
**Marketing Web W0-W5**. Producto/roadmap: repositorio frontend,
`src/Documentacion/20.14-marketing-web-editor-cms-seo-publicacion.md`.
Operación WordPress: `wordpress/clinicaclick-web/README.md`. Origen alojado:
`ops/nginx/README-marketing-web.md`.

Estado 2026-07-19:

- backend/plugin `2.0.0-alpha.8` promovido en staging e instalado en el
  WordPress de Propdental: registro firmado
  schema 2 para hasta 20 rutas por WordPress, `/cita/` estable más
  `/cita/<slug>/`, tombstones con ACK antes de liberar capacidad, token staged,
  artefactos autenticados por lookup dirigido y reconciliación transaccional
  del runtime de intake. Una instalación `pending` ya no reserva el dominio:
  debe demostrar control con un challenge independiente servido por HTTPS antes
  de recibir desired-state o artefactos. Runtime, registro y manifests se ligan
  a la clave Ed25519 exacta aceptada para impedir replay con una retirada. El
  corte base backend/plugin es `1cdfaa1`, merge de staging `aa8bc4c`; el
  frontend staging asociado llega por `c51537dd`. Después se promovieron los
  fixes de preservación del source HMAC `aacd01b`/staging `4769283`, contrato
  de medición WordPress `29e0179`/staging `93c45f4` y ETag
  `5d11cf8`/staging `e562936`;

- validación del corte: **320/320** contratos Node de Marketing Web,
  **40/40** contratos PHP/WordPress y los tres contratos de interoperabilidad,
  compilador real y ZIP provisionado pasan. La auditoría P0/P1/HIGH termina con
  cero abiertos. La migración de claim pasó además un preflight sobre MySQL real
  en una tabla desechable del esquema de staging y se limpió al terminar. El
  preflight de sobres runtime pasó también sobre MySQL 8.0.42: espera frente a
  un writer previo, fence INSERT/UPDATE/DELETE, caída DDL, rerun, descifrado y
  limpieza final sin tabla/trigger residual;
- ZIP genérico `alpha.8`: 17 entradas, incluida
  `class-ccw-site-claim.php`, SHA-256
  `126e0fb6f77ad08e1c2ed53b673ed094dd25de8ebd99e28d0f167e8439409bc7`.
  El provisionado final contiene 18 entradas y tiene SHA-256
  `86792a2ebf69cd9c36f529f98b1528e2ed5b08c9fe5d33216ea33b348695479f`;

- el baseline backend integrado llegó a `4e4b555`/staging `5e57431`; el corte
  vigente de renderer/galería y drift está en `c9fe9dc`/`68360ed`, promovido a
  staging por `4bbc299`. `d5ce548` añade ownership explícito al catálogo de
  plantillas en feature;
- corte funcional frontend `dev` `305d4eae`/staging `5f8f8858`: 153/153,
  build limpio `5a08e6a108414a76`, index/source SHA-256
  `c54b4f254b803a1cd7419660f76be4cb8e0cb5df2912f014e709b9d0822bafc7`,
  481/481 ficheros y readback exacto de assets críticos en 200; los commits
  documentales posteriores no cambian el runtime;
- migraciones `19000..25000` aplicadas tras backup, más la aditiva
  `20260718225000-add-campaign-destination-drift-event.js`; 17 tablas y cinco
  plantillas; cero policies/bindings reales creados;
- las siete migraciones alpha8 —`20260718230000`, `20260718233000`,
  `20260719090000`, `20260719091500`, `20260719093000`, `20260719094500` y
  `20260719100000`— están aplicadas en staging;
- gates de staging: editor para scopes Propdental y publicación solo
  `group:5` mediante `MARKETING_WEB_PUBLISHING_SCOPES`;
- plugin WordPress `2.0.0-alpha.8` instalado/activo en Propdental junto al
  legado `1.1.7`, con un único loader/bootstrap. WP-CLI y DB están alineados;
  la instalación permanece `connected`. El handshake schema 2, el claim de
  propiedad y la promoción del token staged terminaron correctamente. Antes
  del E2E de rutas, desired/reported coincidían en secuencia de registro 8;
- la caché gestionada queda fuera del document root y tanto sus rutas privadas
  como las antiguas rutas públicas de caché responden `404`;
- instalación `524c2f73-6b69-42f2-8cb0-c8d171575d94` conectada en el origen
  canónico `https://www.propdental.es`; el alta `apex` se normalizó solo durante
  el primer handshake virgen y las comprobaciones posteriores son estrictas;
- `/cita/` está publicada y saludable con renderer
  `clinicaclick-web-renderer/1.2.1`: proyecto
  `edd77d09-6ac5-4944-98e3-084d5285594c`, revisión
  `ead78c6d-f28f-478d-9058-bc189c846421`, publicación
  `5d55b1ef-c6fa-4e73-8aa8-2fd9ff41a526`, deployment
  de recuperación `a944709d…`, job `31696` y artefacto/LKG
  `a43e7c4a-9ef3-4aef-aad3-70f12f927c31` (hash público `be4d5f3c…`);
- el GET público devuelve 200, marker y formulario nativo firmado, con un único
  loader, cero bloqueos CSP y sin HMAC/tokens en HTML;
- intake E2E pasó dos veces y `LeadIntake #7261` terminó atribuido a clínica
  `59`/grupo `5` antes de su limpieza completa; rollback real publicó la
  revisión temporal 3 y volvió por secuencia 6/job `31699` a revisión 2/LKG;
- el E2E posterior de `alpha.6` confirmó atribución
  `clinicaclick_web_publication` a través del relay first-party y terminó con
  cero leads/eventos/filas WhatsApp sintéticos y cero intentos Google;
- el E2E público multi-route de `alpha.8` quedó cerrado sobre el proyecto
  desechable `f758cce8…` y la publicación `69f06cf0…`: ruta A
  `e2de500c…`/artefacto `831177bc…` y ruta B
  `4c1f3005…`/artefacto `0b9a41a2…` verificadas, con rollback de A acreditado.
  Un formulario terminó en `303` y creó `LeadIntake #7269` con clínica
  `59`/grupo `5` y proyecto/revisión/publicación/artefacto/formulario exactos,
  además de `FormSubmissionEvent #24` y `WebEvent #38157`; no llevaba click IDs
  ni generó intentos Ads;
- la limpieza `dry-run -> simulate -> apply` dejó cero filas en las 11
  categorías auditadas. El proyecto quedó archivado, la publicación/ruta
  retirada, el tombstone alcanzó desired=reported sequence `12` y la ruta
  respondió `410` mientras estuvo activo. Tras liberarlo, el readback live
  final devuelve `404` y solo permanece activa la ruta piloto. `/cita/` conserva el
  mismo body, SHA abreviado `f3ddf142…`, y el mismo artefacto;
- después del E2E multi-route se recompiló deliberadamente la misma
  revisión/proyecto piloto de renderer `1.2.1` a `1.5.0`, con
  `document_hash=ba60…` y `content_snapshot_hash=5f447…` inalterados. Conservó
  contenido, SEO y Schema; añadió `web_artifact_input_hash` antifraude y el CSS
  de `divider`/`spacer`/`gallery`. El artefacto público vigente tiene hash
  `d875201…`, body SHA `e851688…` y ETag validado;
- Chromium real a `390px` obtuvo `scrollWidth=390`; el único overflow es el
  honeypot deliberadamente fuera de pantalla. El consentimiento es responsive,
  **Aceptar todo** ocupa todo el ancho, desaparece al aceptar y persiste
  `cc_consent_v2`. El formulario conserva 11 campos; no hubo excepciones ni
  fallos de red;
- el audit live detectó dos gaps editoriales en esa revisión congelada: declara
  email como contacto preferido sin ofrecer campo email, y sus datos Social y
  Schema están incompletos. El conteo de campos y la estabilidad del renderer
  no cierran esos gaps; requieren una revisión nueva y aprobada;
- backend staging no está en paridad completa con el worktree de integración.
  Los commits/readbacks live citados aquí sí están acreditados, pero antes de
  otra promoción se debe reconciliar el diff y repetir suites/readback;
- la comprobación **Guardar** de Consent se hizo únicamente en harness: un
  diagnóstico saneado acreditó persistencia del handler, retirada del banner,
  inicialización del runtime y cero `pageerror`. No se presenta como prueba
  pública;
- el monitor horario se ejecutó de forma controlada sobre una publicación:
  `1 healthy`, `0 degraded` a `2026-07-18T13:01:04.689Z`;
- `drift_detected` queda persistido por `CampaignDestinationBindingEvent`; la
  auditoría de destino usa el orquestador común una vez al día (`5 3 * * *`),
  sin autoreparación. La suite de Campañas pasa 34 contratos/46 pruebas;
- hosted/custom domain no están disponibles;
- la rotación HMAC terminó mediante reconciliación
  `889cc3a4-7d09-4cb0-accb-65acbdbfbb61`, generación 1, estado `completed`.
  El finalizer `JobRequest #32179` terminó el `2026-07-19T07:24:30Z` tras dos
  intentos y sin error; source/target envelopes se eliminaron, queda una sola
  clave aceptada y se restauró la gracia normal a `86400000` ms. El target fue
  aceptado y el source se comprobó durante la gracia antes de expirar; staging
  quedó online;
- el router live corrige el magic-quotes que WordPress aplica a
  `HTTP_IF_NONE_MATCH`. Cloudflare y origen devuelven `304` con el
  `If-None-Match` exacto. HMAC y ETag quedan cerrados; hosted/custom conservan
  sus gates externos.

La migración `20260715152000-purge-google-places-competition-content.js` está
cancelada y sus `up`/`down` son no-op. No es una migración pendiente ni debe
reactivarse.

Estado de implementación actual, separado de la evidencia del artefacto live:

- renderer `clinicaclick-web-renderer/1.3.0` introdujo cabecera y pie globales
  por página y formulario global con contrato por página;
- `1.4.0` añadió las primitivas cerradas `divider` y `spacer`; `divider` emite un `<hr>` semántico con
  `line_style=solid|dashed|dotted` y `tone=muted|brand|accent`; `spacer` emite un
  elemento presentacional `aria-hidden` con `size=xs|sm|md|lg|xl|2xl`. Ambos
  exigen `children=[]`, carecen de bindings y solo producen clases/CSS
  allowlisted por el compilador;
- el renderer staging vigente `clinicaclick-web-renderer/1.5.0` añade
  `gallery` como décimo nodo seguro: 2–12 assets únicos, columnas 2/3/4,
  `cover|contain`, ratios allowlisted, alt/decorativa, foco y pie por item. El
  resolver congela cada recurso exacto y el compilador genera
  `figure/img/figcaption`, lazy loading y layout responsive;
- una única canonical efectiva alimenta `rel=canonical`, `og:url` y las
  URL/`@id` de WebPage/FAQ; el sitemap solo incluye canónicas indexables del
  mismo origen y excluye canónicas externas;
- el paquete live `clinicaclick-web` `2.0.0-alpha.8` conserva los contratos de
  rutas/formulario global de alpha7 y añade el runtime multi-route acreditado;
  esto no convierte el renderer `1.5.0` en un artefacto publicado. El runbook
  histórico alpha7 y su rollback alpha6 están documentados; después de schema
  2 el rollback operativo mantiene alpha8 + LKG. La API
  bloquea fail-closed un deployment WordPress con formulario global si el
  plugin es anterior (`409 web_wordpress_global_intake_plugin_outdated`);
  documentos legacy y header/footer globales sin formulario no quedan
  bloqueados por ese mínimo;
- CMS y medios proyectan capabilities del actor y de cada fila, herencia de
  solo lectura, autoría/revisión, flujo `draft -> review -> published` e
  historial inmutable. Los bindings semánticos, incluida FAQ
  `question/answer`, no reutilizan el nombre interno de la entrada;
- la hidratación de medios acepta lotes explícitos de hasta 100 UUID. El
  editor consume esa API para recuperar imágenes de nodos y assets sociales o
  globales sin persistir URLs como autoridad.
- la API revalida `campaign_context`, plantilla, scope y compatibilidad antes
  de crear un proyecto desde campaña; el filtro frontend nunca basta para
  autorizar una combinación.
- el catálogo `GET /marketing/web-templates` pagina en base de datos y expone
  `source_scope`, `source_scope_id`, `managed_by_scope`, visibilidad, estado y
  timestamps sin devolver el documento salvo preview explícita. Solo el scope
  propietario puede editar/archivar; globales/heredadas son de lectura;
- los resolvers `treatment`, `professional` e `intake_config` están
  implementados con allowlists seguras. `intake_config` conserva solo
  `id/scope/inherited`; nunca configuración privada ni HMAC.

Tanda promovida y desplegada:

- `clinicaclick-web` `2.0.0-alpha.7` conserva identidad Web/relay atribuible y
  añade contratos globales por página; `alpha.6` queda como rollback operativo;
- la API separa rollout de disponibilidad real y proyecta capabilities
  fail-closed para WordPress, hosted y custom domain;
- hosted valida pareja Ed25519, firma, bundle exacto, hashes, symlinks, punteros
  y solapamiento de rutas. El preflight ya tiene directorio de hosting y
  challenge ACME, y los rangos Cloudflare coinciden con el snippet, pero sigue
  bloqueado: no hay control DNS/vhost/certificado/flag y HTTP/HTTPS continúan
  `302` DonDominio/`521`;
- `marketing_web_publication_health_monitor` opera cada hora, lote 25,
  sin autoreparación ni APIs publicitarias;
- la suite completa, promoción y E2E público con limpieza están cerrados.
  Esta es evidencia histórica de `alpha.7`: multi-route y rotación Ed25519 no
  estaban en ese runtime. `alpha.8` ya fue migrado/desplegado y los implementa;
  el E2E desechable de dos rutas quedó cerrado con cleanup/tombstone; la
  rotación HMAC y el readback ETag `304` también quedaron cerrados después.
  Hosted/custom siguen bloqueados por
  DNS/TLS/origen/proveedor.

La auditoría Figma se materializó en un onboarding de tres pasos y un selector
de plantillas compatible con la campaña, sin fallback arbitrario. El frontend
recorre todas las páginas del catálogo, deduplica y permite buscar localmente;
el backend solo entrega `preview_document` después de ACL/paginación,
validación canónica y comprobación de hash. La opción libre se llama
**Estructura inicial editable** y explica que crea título, texto, botón y
formulario totalmente editables/eliminables; en contexto de campaña, la
ausencia de una plantilla compatible bloquea el alta en vez de fabricar una
landing vacía. SEO, Social y Schema, el inspector de CTA, el panel de diseño,
el flujo editorial/historial, los globales y la hidratación de medios ya
existen en la implementación. La galería semántica está en staging; la autoría
Página/Cabecera/Pie, archivo/restauración de proyectos y la ruta frontend real
`/marketing/web/plantillas` están integrados en feature. Un archivado no puede
publicarse y restaurar siempre vuelve a borrador. Sigue pendiente la aceptación visual completa
contra Figma, drag/drop avanzado y el E2E público de esta tanda. Se reutiliza
la UX, no el runtime ModSuite. Véase `20.14`/`20.15` en frontend.

Evidencia base: 223/223 contratos Node, 26/26 PHP/WordPress, 3/3 de
interoperabilidad y frontend Marketing Web 153/153. El build staging
limpio `5a08e6a108414a76` está desplegado. Chromium final de solo lectura
cubrió onboarding, editor, CTA, Medios, SEO/Social/Schema, revisiones y CMS en
`1440`/`360`: 13 capturas, todas las aserciones verdes y cero errores de
consola/página/request/HTTP, mutaciones Marketing Web u overflow. El fix
`305d4eae` estabiliza por identidad las opciones CTA y cierra el bucle de CPU
reproducido en Chromium. Backend y
plugin también están live. El readback, relay/atribución, limpieza, rollback y
monitor acreditaron primero el artefacto público renderer `1.2.1`; la misma
revisión/proyecto se recompiló después y el artefacto WordPress live ya es
renderer `1.5.0`, hash `d875201…`, body SHA `e851688…` y ETag `304`.
Evidencia incremental: galería backend 3/3, migración drift 3/3, Campañas 34
contratos/46 pruebas, autoría global frontend 92/92 antes de su unión y QA
staging Galería `1440`/`390` con index SHA
`4451d0ba00320451acb788b48ed939d4de30e649fa259e2d383caf3e441cca6c`.

## Orden de verificación

1. Para una incidencia de entrada o sede incorrecta: `intake-e2e-cleanup.md` y la sección de routing autoritativo en `src/Documentacion/13-backend.md`.
2. Para una conversión que no aparece: `google-data-manager-conversions.md`; distinguir intake, intento local, aceptación, Diagnostics terminal y reporting atribuido.
3. Para objetivos o pujas: `google-ads-goal-policy-v4.md`; readiness de conversiones no autoriza una mutación de campaña.
4. Para una fuente que aparece `Pendiente` en un módulo y conectada en otro: `group-asset-mapping.md`; comparar conexión efectiva, mapping, sync y datos por separado, y revisar que el lector incluya el fallback de grupo.

No se deben interpretar un HTTP 200, una acción secundaria creada o un snapshot `activation_readiness` verde como Piloto automático activo. Propdental continúa en `connect_only` hasta que exista y se apruebe una orden gestionada separada.

En el contrato integrado de tres niveles, `connect_only` se llama **Mide y
entiende**: conecta cuentas existentes, importa/unifica leads, atribuye su
ciclo, envía conversiones consentidas mejoradas/offline y muestra
diagnósticos/recomendaciones. No cambia campañas, custom goals, URLs, pujas,
presupuesto ni estados. Las referencias posteriores a **Conecta y mejora** son
el nombre visible del corte histórico de julio previo a esta integración.

Estado de arquitectura de la candidata de integración (2026-07-19): registra
**33 tareas periódicas**, **14 integraciones dirigidas/background**, **47 tipos
background** en total y **63 handlers**. Los nuevos tipos dirigidos
`web_content_generation`, `managed_campaign.google_search_create.v1`,
`managed_campaign.google_search_activate.v1` y
`managed_campaign.google_search_rollback.v1` pertenecen al mismo carril durable
`JobRequest`; no crean timers laterales. `web_intake_runtime_reconcile` continúa
registrado como handler del mismo orquestador. La
publicación, los destinos y el monitor Web continúan dentro del mismo
`JobRequest`, nunca en un cron paralelo. El detalle histórico siguiente sobre
outbox/retención se conserva: también son durables `marketing_competition_heatmap_refresh`, `automation_whatsapp_quiet_send`, `whatsapp_template_sync_delayed` e `intake_quickchat_summary_materialize`. Este último es un outbox de prioridad alta compartido por `source_detail=chatbot` y `chatbot_quickchat`: cada payload aceptado conserva en una transacción su audit exacto y job, tanto para un lead nuevo como para uno deduplicado. El JobRequest solo guarda `lead_id + audit_id` más el namespace técnico añadido por la cola; la sede validada queda en `audit.attribution_steps.resolved_clinic_id`. El handler exige esa sede y un mismatch con el lead termina `409` sin Message/socket; solo audits legacy sin marcador caen de forma segura en la clínica del lead. `Messages.metadata.intake_audit_id` impone orden durable: bajo lock del lead, el audit mayor gana y cualquier job antiguo completa como `skipped/stale` sin cambiar contenido, socket ni `last_message_at`; el watermark avanza aunque hash/contenido sean idénticos y un mensaje legacy idéntico adopta el primer marcador. El fast path admite el `result_summary` envuelto por `JobExecutor` y el formato directo compatible de callers/tests, devuelve `saved=true` solo si terminó, `202 + queued` si queda reintentable y preserva `4xx` seguros como el `409` de sede. Si falla el disparo, relee `JobRequest`; si tampoco puede releerlo responde `202 unknown_durable`, no inventa `pending`. Un `chatbot` deduplicado termina con ese outcome antes de Meta/Google para no duplicar conversiones, mientras los demás dedupes conservan `409`. Teléfonos fuera de 9–15 dígitos y emails presentes inválidos devuelven `422` antes de confirmar el lead. `pm2-back-staging` opera con cron leader + worker; las cinco líneas OPS se retiraron del crontab. `#23664-#23670` validaron los bridges y `payloadDefaults`; `#23672` completó la retención real. `SyncLogs` (auditoría funcional BD) y ficheros PM2 (stdout/stderr, 60 días) son retenciones independientes.

### Candidata de ejecución gestionada Google Search

Estado a 2026-07-19: el código permite crear una Google Search nueva en
`PAUSED`, activar después `PAUSED -> ENABLED` y retirar únicamente los recursos
propios. **No está habilitado ni acreditado en staging**: la migración
`20260719103000-create-managed-campaign-provider-executions.js` solo se ha
validado en MySQL aislado, ambos flags permanecen apagados y no se ha realizado
una llamada Google real. Propdental sigue en `connect_only`; este candidato no
autoriza convertirlo en Piloto ni tocar sus campañas.

- Registry real único: `google_ads:google_search:create_new`. PMax, Meta,
  `update_existing` y cualquier provider/family/operation no registrado fallan
  antes de red; el dry-run para esas familias continúa siendo solo simulación.
- Flags fail-closed:
  `MANAGED_CAMPAIGN_PROVIDER_EXECUTION_ENABLED=false` por defecto y
  `MANAGED_CAMPAIGN_PROVIDER_ACTIVATION_ENABLED=false` por defecto. Activación
  necesita ambos; apagar un flag no genera un falso éxito.
- Jobs del orquestador común:
  `managed_campaign.google_search_create.v1` (`high`, cinco intentos),
  `managed_campaign.google_search_activate.v1` (`critical`, cinco) y
  `managed_campaign.google_search_rollback.v1` (`critical`, tres). No existe
  timer/worker lateral.
- Persistencia: `ManagedCampaignProviderExecutions` congela plan/hash, versión,
  autorización, reserva, refs, propiedad, snapshots de goal/activación/rollback,
  jobs e idempotencias distintas por fase. Sus estados son `queued`,
  `executing`, `succeeded` —Google `PAUSED` verificado—,
  `activation_queued`, `activating`, `active` —QL + `ENABLED` verificados—,
  `activation_failed`, `failed`, `cancelled`, `manual_recovery_required`,
  `rollback_queued`, `rolling_back` y `rolled_back`.
- Fencing: locks SQL, índice único por campaña/idempotencia, una sola ejecución
  viva, lease owner/version/expiry de 30 minutos, versión de campaña, refs,
  asignación Google, aprobación, moneda y reserva se revalidan en enqueue,
  claim, antes de cada mutación y al finalizar. Las llamadas son
  `singleAttempt`, timeout dos minutos, `validateOnly` previo, mutate atómico y
  readback exacto.
- Activar es siempre otra aprobación: idempotencia y referencia nuevas, seis
  confirmaciones, vigencia 24 h y policy `qualified_lead` aplicada/releída antes
  de `ENABLED`. No usar la transición genérica de lifecycle.
- Rollback solo acepta `succeeded|active|activation_failed`, marca/ref propia y
  confirmación explícita. Elimina esa jerarquía, comprueba su ausencia y solo
  entonces libera la reserva. Ambigüedad, drift, revocación tras posible llamada
  o pérdida del fence conserva fondos/refs y exige recuperación manual.

Runbook de rollout:

1. Promover código y aplicar **solo** `20260719103000` con ambos flags apagados;
   comprobar esquema, handlers, listado/capability y cero llamadas Google. No
   ejecutar la migración `20260715152000`: continúa cancelada y no-op.
2. Para un piloto autorizado, usar una campaña Search controlada con spec
   `autopilot + managed`, `approved_to_launch`, cuenta activa, prepago verificado
   y dry-run nuevo persistido. Abrir primero únicamente el flag de ejecución.
3. Confirmar `succeeded`, árbol completo `PAUSED`, refs/marker y reserva. Si el
   resultado es ambiguo, detener; no repetir ni liberar fondos.
4. Solo tras ese readback abrir activación, confirmar policy QL, moneda/zona y
   `ENABLED` exacto. Mantener apagada para el resto la capacidad no acreditada.
5. Para deshacer, usar el rollback de esa misma ejecución; cerrar únicamente
   con `rolled_back` y ausencia verificada. Volver a apagar flags al terminar el
   piloto controlado.

El contrato completo de rutas, gates, estados, UI y recuperación está en
`src/Documentacion/13-backend.md`, apartado **Ejecución gestionada Google
Search: candidata cerrada por flags**.

Fix Enhanced verificado: el normalize/merge conserva flags y autorización en top/event/destino. La prueba controlada `#22` acreditó formato/transporte; después, siete intentos naturales `#25/#26/#27/#28/#30/#32/#33` de `1851215478` terminaron `succeeded/SUCCESS` con consentimiento, `user_data_sent=true` y `[email, phone]`. `5992356722` mantiene acciones/readiness y `validateOnly` verdes, pero todavía no un terminal natural posterior a la migración. Las ocho acciones canónicas siguen secundarias, fuera de `Conversions` y con default Google `0`: Mide y entiende enriquece atribución, pero no gobierna la puja.

Auditoría Google live 2026-07-16: las campañas heredadas continúan optimizando acciones legacy; Badalona Search presenta fuerza `POOR`, hay bolsas de keywords con score `<=4`, los ocho asset groups PMax revisados están `AVERAGE`/varios limitados, y las cuatro Smart de `599...` mantienen `TARGET_SPEND` y goals antiguos. La auditoría durable diaria incorpora ahora calidad de campaña read-only: 3 targets Conecta y mejora, 0 goal-policy; el grupo Propdental quedó con medición saludable, `runtime_ready=true` y 8/8 destinos válidos. El primer corte observó 30/30 campañas del snapshot de estrategia; al unir estrategia y campañas autorizadas por medición, el segundo corte observó **35/35** referencias únicas —17 en `185...` y 18 en `599...`—, incluyó las cuatro Smart y devolvió 0 críticos + 92 recomendaciones consultivas. Ambos cortes declararon cero mutaciones y `ChangeEvent=0`. Francia quedó en 4/10 y Eixample en 0/4 por cuentas no asignadas a esos scopes. La calidad no bloquea por sí sola el runtime de medición. `call_reporting_enabled=false` en ambas cuentas sin borrar teléfonos, assets ni histórico. Cualquier corrección de objetivos/campañas pertenece a un Piloto aprobado, no a `connect_only`.

ACL operativa: agencia es marketing-only y solo recibe atribución/pacientes/leads seudonimizados dentro de scopes explícitos. No abre PII, Chat/Registro, QuickChat, Agenda/citas, consentimientos, Personal/equipo, settings, instalaciones, nutrición, dashboard operativo o fusiones. `reception`/`admin_staff` conservan `clinic.settings.edit` + `team.manage` local, pero nunca gestionan owners; backend preserva `owner_membership_manage_forbidden` y `owner_unlink_forbidden`.

Release funcional histórica previa a Web: backend staging `9b82958`, frontend
`3c4593ae`, build `8ca8e450c563e9ee`. El corte Web actual está documentado
arriba (backend staging `5e57431`; corte funcional frontend staging `5f8f8858`,
build limpio `5a08e6a108414a76`). Consent v5 sigue vigente. Propdental continúa en
`connect_only`; no se activa Mejora/Piloto ni se cambian goals, URLs, pujas o
presupuesto. Meta Francia no tiene todavía cuenta publicitaria/píxel
configurados. `Conseguir más reseñas` está cerrado/listo.

QA público postdeploy: un chat móvil controlado con Marketing rechazado y sin click IDs seleccionó Sant Martí `56`; `chatbot` respondió `201`, `chatbot_quickchat` deduplicó con `200`, y los outbox `#23818/#23819` completaron al primer intento sobre los audits `#7400/#7401`, una conversación y un único mensaje con watermark `7401`. Hubo cero intentos Google. El lead sintético `#7213` pasó después por `dry-run -> simulate -> apply`; el postcheck comprometido dejó cero restos. Los chats reales huérfanos `#7185/#7195/#7196` se recuperaron exclusivamente mediante los jobs estándar `#23820-#23822`: una conversación/resumen por lead, sede Sants `19`, un intento por job y la cuenta de intentos publicitarios permaneció `3 -> 3`.

Feedback de calidad: pasar un lead a `descartado` requiere `motivo_descarte` y deja auditoría. `tratamiento_no_ofrecido` y `consulta_no_asistencial` son dos opciones visibles, no un enum backend cerrado: primero se comprueba catálogo/derivación o circuito interno. El motivo sirve para diagnóstico y recomendaciones; nunca se adjunta a Google/Meta como texto del paciente.
