> **Módulo:** Arquitectura del Backend
> **Última actualización:** 2026-07-20
> **Relacionado con:** `cc-front/src/Documentacion/20.1-motor-flujos-v2.md` | documento operativo `cc-front/src/Documentacion/31-roadmap-arquitectura-entornos-gateway.md`
> **Fuente canónica:** este archivo del repositorio backend. `cc-front/src/Documentacion/13-backend.md` es un espejo completo para conservar los enlaces internos del manual frontend; cualquier cambio se hace aquí primero y después se sincroniza el espejo.

Economia del paciente: el contrato persistido de presupuestos, versiones,
cobros, saldo, bonos, plantillas y documentos fiscales se documenta en
[14-economia-paciente](./14-economia-paciente.md). VeriFactu permanece como
simulacion visible y no comunica con AEAT.

Runbooks operativos backend: `back-dev/docs/README.md`, con acceso directo a Data Manager/Conversiones mejoradas, política de goals y E2E/limpieza de intake.

---

## 2026-07-20 - Plantillas personales y automatizaciones WhatsApp trilingües operativas

- La autoría por `WhatsappTemplates.created_by_user_id` está integrada en
  `dev`/`staging` y publicada en CRM. `Mis plantillas` significa únicamente
  «creadas por el usuario autenticado»; catálogo/sistema continúa compartido y
  las filas históricas sin autor verificable aparecen como `Anteriores`,
  utilizables en su scope previo pero de solo lectura. Gestión, Leads,
  QuickChat, Agenda y ficha de paciente consumen el mismo contrato backend.
- El inventario preexistente conserva 18 filas no-sistema sin autor: seis
  remotas anteriores y doce creadas/sincronizadas sin trazabilidad suficiente.
  No se les inventó propietario y no fue necesario ocultarlas ni borrarlas para
  desplegar la autoría correcta de las plantillas nuevas.
- Las migraciones de idioma de paciente y catálogo están aplicadas. El rollout
  durable `JobRequest #32802` terminó `completed`: 30/30 variantes requeridas
  quedaron aprobadas en Meta, se reconciliaron 144 identificadores de variante
  y las 905/905 referencias WhatsApp de las versiones activas quedaron
  localizadas sin familias activas duplicadas.
- El runtime conserva `context.communication_language` por ejecución y resuelve
  familia, locale y WABA efectivo antes de crear el `Message`. Un reintento
  reutiliza esa selección; no mezcla idiomas ni cae silenciosamente a español.
- Validación 2026-07-20: `whatsapp_multilingual_automation.test.js` confirma
  que cada mensaje nuevo usa el idioma vivo del paciente enriquecido. Si se
  activa catalán después del primer envío, los siguientes nodos pueden salir en
  catalán; solo los reintentos del mismo `Message` conservan el snapshot ya
  materializado.
- El canary autorizado usó una única ejecución (`#954`, job `#32877`) y creó un
  único mensaje (`#49928`) en catalán hacia el número QA terminado en `0236`.
  Meta lo aceptó, entregó y marcó leído. No hubo segundo envío. El flujo terminó
  después en `change_status_target_not_found:appointment`, de forma deliberada,
  porque el canary no fabrica una cita.
- El preflight del canary resuelve la variante aprobada correspondiente al WABA
  del remitente, no una fila canónica sin WABA. La corrección está en
  `dev@64f155e` y `staging@88bb945`.

---

## 2026-07-20 - Marketing Web alpha.9, retirada segura y medición global

Estado autoritativo actual de Propdental:

- `clinicaclick-web 2.0.0-alpha.9` está activo y el plugin legado
  `clinicaclick 1.1.7` está inactivo. El v2 es el propietario único del loader
  y del bridge global; home y las cinco páginas de clínica exponen una sola
  instancia y ningún HMAC público.
- `/cita/` y `/cita/primera-visita-hospitalet/` están retiradas y responden
  `410`. Los proyectos/revisiones siguen siendo historial editorial, pero no
  deben presentarse como publicaciones online ni destinos de campañas.
- `webProjects.listProjects()` agrega por proyecto un resumen independiente de
  `WebPublication`: `state`, estado crudo, `is_live`, canal, URL pública,
  revisión activa/deseada, fechas y recuentos. La prioridad es determinista y
  evita inferir publicación
  desde `WebProject.status`.
- `retireWordpressPublication()` reconcilia dentro de la transacción todos los
  `CampaignDestinationBinding` de la publicación a `retired/blocked`, guarda
  `campaign_destination_publication_retired`, incrementa versión y registra el
  recuento en auditoría. El replay idempotente repara bindings antiguos sin
  revivir ni volver a retirar contenido.
- Una página WordPress ordinaria ya no consulta el puntero del último
  artefacto. Resuelve el runtime firmado global con
  `CCW_Config::runtime_configuration()` y omite
  `X-Clinicaclick-Web-Artifact`; las rutas firmadas de landing conservan el
  contrato estricto. Esto evita que retirar la última landing cause
  `ccw_event_bridge_runtime_unavailable` o reenvíe un hash retirado.
- Verificación live: relay ordinario `200`; un evento analytics-granted y
  ads-denied persistió en grupo `5`; un lead sintético de clínica `59` se creó
  una sola vez y el reintento con el mismo `event_id` devolvió el mismo ID;
  cero intentos Google. El cleanup `dry-run -> simulate -> apply` eliminó lead,
  auditoría y evento y dejó el postcheck a cero.
- `routes.json` y toda la caché gestionada deben pertenecer al usuario OS del
  sitio. Un cron/WP-CLI ejecutado como root puede producir
  `ccw_route_registry_invalid`; no se debe relajar la validación: se corrige
  ownership y se repite como el usuario del sitio.
- Pruebas del delta: `web_projects_service`, `web_publications_service` y
  paquete provisionado verdes; plugin **41/41**. ZIP genérico determinista
  SHA-256
  `daf4f84500ac559901c0532a324b36ae6091ede5c6710fd148f70e9cdf2b2f45`.
  Backup pre-alpha9 root-only:
  `/furanet/sites/propdental.es/web/.clinicaclick-web-rollbacks/plugin-before-alpha9-20260720T0730Z/clinicaclick-web-alpha8.tgz`
  (SHA-256
  `92d0077446ef917b1b408edb3c61ff075e5957c7b87643b6910fda88fd1732f9`).

Las secciones de 2026-07-18/19 que describen rutas `200`, plugin legado activo
o `alpha.8` live son snapshots históricos de sus respectivos E2E. No describen
el estado público posterior a esta retirada.

## 2026-07-19 - Cierre funcional Marketing Web W1-W5 (histórico)

Este bloque es la **verdad vigente** del cierre funcional. Los cortes que
aparecen después conservan evidencia histórica de despliegues anteriores, pero
no deben usarse para reabrir capacidades ya terminadas. El candidato fuente
queda en backend `7bd254e` (staging `d99c3a6`) y frontend `379a9570`
(staging `a1ae678f`); la evidencia pública final ya se cerró y la ruta QA se
retiró de forma deliberada después de verificarla.

### Editor, CMS y ajustes del sitio

- El editor comparte un único `WebDocument` y ofrece **Guiado** y
  **Avanzado**. Guiado es el modo inicial y limita la interfaz a controles
  esenciales y seguros. Avanzado requiere `marketing.web.advanced_edit`,
  habilita controles de diseño por dispositivo y vuelve a Guiado si se pierde
  el permiso; la preferencia local nunca evita el ACL.
- La inserción y reordenación son contextuales. Canvas, overlay y outline
  trabajan sobre la lista real de hermanos del contexto actual, validan índice
  y nodo, y delegan en el comando undoable `move_node`. No existe drag/drop
  arbitrario entre padres; los intentos inválidos son no-op y siempre hay
  alternativa accesible de teclado/click.
- Contenidos dispone de tabs Todos/Borradores/En revisión/Publicados/Archivados,
  búsqueda, filtros de tipo/idioma, paginación, tabla desktop/lista móvil,
  selección por página y acciones masivas con PATCH versionado, concurrencia
  acotada y resultado parcial. Archivar es reversible; no se añadió borrado
  destructivo ni un endpoint bulk que el backend no tenga.
- El editor CMS es tipado: reordena, duplica y retira bloques, mantiene las
  fuentes colapsables y renderiza texto mediante interpolación Angular segura,
  nunca como HTML aportado por el usuario.
- Los ajustes del sitio se dividen en **General**, **SEO** y **Social**.
  General conserva diseño, contacto y consentimiento; SEO contiene sufijo de
  título e indexación; Social define la imagen social global. El SEO de página
  sigue teniendo precedencia. No se inventaron categorías, autores resueltos,
  contadores agregados ni una imagen editorial distinta de
  `seo.default_social_asset_id`.

### Cinco plantillas builtin, revisión 2

El catálogo conserva `schema_version=1`, `version=1` y sus claves comerciales;
`builtin_revision=2` identifica la corrección segura sin duplicar plantillas:

| `catalog_key` | Nombre visible | Uso |
|---|---|---|
| `quick-treatment-v1` | Tratamiento directo | Tratamiento de decisión rápida. |
| `considered-treatment-v1` | Tratamiento explicado | Tratamiento de alta consideración. |
| `general-clinic-v1` | Clínica general | Captación general. |
| `local-call-whatsapp-v1` | Contacto local | Contacto local mediante formulario nativo, sin teléfono ficticio. |
| `qualification-form-v1` | Formulario de cualificación | Captación y cualificación. |

La migración
`20260719174500-harden-web-builtin-templates-v1.js` reconcilia únicamente una
fila builtin con identidad global exacta cuyo hash sea uno de los legados
conocidos o el hash final. Usa actualización CAS, es idempotente, verifica el
resultado y falla cerrada ante dependencia, ausencia, conflicto de identidad,
contenido desconocido o verificación fallida:

- `web_builtin_template_hardening_missing_dependency`;
- `web_builtin_template_hardening_template_missing`;
- `web_builtin_template_hardening_identity_conflict`;
- `web_builtin_template_hardening_content_conflict`;
- `web_builtin_template_hardening_verification_failed`.

Nunca sobrescribe una plantilla editada por un usuario. Su `down()` es no-op
porque un rollback de código no debe reintroducir teléfonos ficticios ni el
contenido inseguro anterior.

### Renderer 1.8 y animaciones tipadas

El compilador público activo pasa a `clinicaclick-web-renderer/1.8.0` para
soportar animaciones de entrada cerradas en `WebDocument v1`. Cada nodo puede
declarar `animation` con uno de estos valores: `none`, `fade_in`, `slide_up` o
`scale_in`. El compilador genera únicamente clases propias `cc-animate-*` y
keyframes deterministas protegidos por `prefers-reduced-motion`; no acepta
`className`, `animate-[...]`, CSS inline ni estilos arbitrarios importados de
ModSuite.

La validación está duplicada y cubierta en frontend/backend:

- JSON Schema backend `web-document-v1.schema.json`;
- validador frontend `web-document.validation.ts`;
- comandos del editor con undo/redo para `animation`;
- preview del editor y compilador público;
- tests `web_document_contract`, `web_artifact_compiler`,
  `web_gallery_backend`, `web_artifacts_service` y focales frontend.

El mismo renderer 1.8 admite ahora el nodo cerrado `video` como extensión
aditiva de `WebDocument v1`. No se incrementa la versión del renderer para no
forzar republicaciones de artefactos/LKG sin vídeo: la salida solo cambia
cuando el documento contiene explícitamente ese nodo. El contrato acepta
únicamente `provider` (`youtube` o `vimeo`), `video_id`, título accesible,
proporción, estrategia de carga y pie de vídeo. Rechaza hijos, iframe pegado,
HTML, JavaScript y URLs arbitrarias. El compilador transforma esos datos en
iframe seguro (`youtube-nocookie.com` o `player.vimeo.com`) y añade
`frame-src`/`child-src` a la CSP del meta HTML y del manifest solo cuando existe
un vídeo. La prueba focal `web_video_backend.test.js` cubre validación cerrada,
salida determinista, CSP y ausencia de handlers.

### Schema de página con presets seguros

`WebDocument v1` admite `page.seo.schema` como configuración editorial cerrada,
no como JSON-LD libre. El contrato backend valida dos campos:

- `page_type`: `auto`, `web_page` o `medical_web_page`;
- `include_faq`: booleano para publicar u omitir `FAQPage` cuando la página
  contiene preguntas/respuestas visibles.

El compilador mantiene la allowlist: emite `WebPage` por defecto,
`MedicalWebPage` solo cuando el preset lo solicita, y `FAQPage` únicamente si
hay FAQs visibles y `include_faq !== false`. La prueba focal
`web_artifact_compiler.test.js` cubre que una FAQ pueda permanecer visible en
HTML sin publicar `FAQPage`, y `web_document_contract.test.js` rechaza presets
fuera de la lista. No se aceptan tipos Schema arbitrarios, scripts ni contenido
JSON-LD pegado por el usuario.

### Renderer 1.7 y publicación WordPress histórica

El cierre anterior con `clinicaclick-web-renderer/1.7.0` cubrió cabecera y pie globales y una
galería real congelada por assets, además de SEO/Social/Schema, formulario,
hashes, manifest, ETag y desired-state multi-ruta del plugin
`clinicaclick-web 2.0.0-alpha.8`. La página publicada no ejecuta HTML, CSS o
JavaScript libre del usuario y el plugin conserva last-known-good/rollback.

La evidencia pública final ejerció globales y galería con estos identificadores
completos:

- publicación: `77d0f7a9-b42e-4844-83d6-cc71d46d14fb`;
- revisión: `b841dead-f9a7-4d6b-937c-bf7117521559`;
- deployment: `262d7091-0ff4-441c-979b-0db4cb3aead6`;
- artefacto: `f2e6f7f7-e08f-408c-9b80-d10d910bc08f`;
- hash de artefacto:
  `f922298aeb6e1e7a5ca25fc3640c38b1d3874f0987427cee6274d97c24e6cdda`;
- ruta verificada: `/cita/qa-globales-galeria-20260719/`;
- renderer `clinicaclick-web-renderer/1.7.0`, todas las aserciones públicas y
  Chromium desktop/móvil verdes;
- Schema: 1 objeto, 0 errores y 0 avisos;
- Lighthouse: rendimiento 88, accesibilidad 100, buenas prácticas 100 y SEO
  69. El SEO reducido es deliberado porque la revisión QA emitía `noindex`;
  FCP 1,0 s, LCP 3,9 s, CLS 0 y TBT 0.

Tras la validación se archivó el proyecto y se retiró la publicación. La
evidencia de retirada capturó **HTTP 410 Gone** mientras el tombstone estaba
activo; tras su liberación, el readback actual responde **HTTP 404**, también
sin contenido público y como estado final esperado. El QA admin autenticado contra
`https://crm.clinicaclick.com` recorrió Proyectos y Contenidos a `1440` y `390`:
cuatro recorridos HTTP 200, sin overflow, page errors, requests fallidas ni
errores HTTP. Evidencia:
`/home/ubuntu/qa-evidence/marketing-web-editor/staging-admin-overflow/result.json` y sus
capturas.
Hosted y dominio propio continúan fuera del rollout: sus flags,
DNS/TLS/proveedor, retiro y E2E público siguen cerrados.

### Evidencia automatizada del candidato

| Superficie | Resultado |
|---|---:|
| Backend Marketing Web | **361/361** |
| WordPress/PHP | **40/40** |
| Interoperabilidad backend-plugin | **3/3** |
| Frontend Marketing Web | **263/263** |
| Focales editor/CMS | **88/88** |
| TypeScript | **verde** |

El frontend estático promovido corresponde al build `a8170ed3c0c644ef`: 482
ficheros, `index.html` SHA-256
`b39aaed67329ead594d53fe5738afda0e3d725320ef70861c2419c3d42dcd570`,
bundle principal `main.5e80d0ee5d4c9ec5.js`, chunk Marketing
`3584.9c78544ecd67faf6.js` y chunk editor `5315.994aab1499ae3f97.js`.

Los totales 320/320, 351/351 y 354/354 citados más abajo son cortes históricos,
no regresiones del candidato actual.

### Niveles de Campañas y límites operativos

| Valor técnico | Etiqueta vigente | Autoridad |
|---|---|---|
| `connect_only` | **Mide y entiende** | Mide, atribuye y recomienda; no muta campañas ni proveedor. |
| `guided_improvement` | **Mejora** | Solo aplica cambios expresamente autorizados y revalidados. |
| `managed_service` | **Piloto** | Operación gestionada con spec, policy, fondos y aprobación. |
| `managed_self` | **Legado de solo lectura** | Compatibilidad histórica; la UI no ofrece edición/transiciones y el backend devuelve `409 legacy_mode_read_only` ante edición, creación o transición de estado. No sustituye Mejora. |

Propdental sigue en `connect_only`. Las capacidades hosted/custom y las
mutaciones de proveedor permanecen apagadas; este cierre de editor/CMS no
autoriza goals, URLs, pujas, presupuesto, estado ni altas Google/Meta.

### Salvaguardas ajenas a Marketing Web

- `20260715152000-purge-google-places-competition-content.js` continúa
  cancelada: `up` y `down` son no-op. No debe ejecutarse como purga pendiente.
- `src/controllers/personal.controller.js` conserva SHA-256
  `776da1bf46ca128e08c2f215f64c7dd48dd6615859c96cb75a5b4e8a7ba75b30`.
  `administrativo/admin_staff` mantiene `clinic.settings.edit` y
  `team.manage`, pero no puede asignar, modificar ni retirar propietarios; los
  errores de frontera son `owner_membership_manage_forbidden` y
  `owner_unlink_forbidden`. No se debe relajar ese contrato al tocar horarios,
  instalaciones, tratamientos o equipo.

Limitaciones externas que siguen abiertas: hosted/custom, credenciales y
proveedor de esos canales, su DNS/TLS/deprovisión/E2E y la procedencia/licencia
de cualquier asset de ModSuite que se quisiera reutilizar. Ninguna bloquea el
cierre funcional Guiado/Avanzado, CMS/SEO/Social, plantillas builtin revisión 2
o WordPress globales+galería.

## 2026-07-19 - Corte promovido anterior Marketing Web 1.7 e IA durable

El corte backend vigente es `3f0c0e0`, promovido a staging mediante `a22b773`;
incluye el E2E final de intake/snapshot sobre el hardening de destinos
`8c4fdeb`/`55a34d7`, el bridge `6fdd153`/`f9c3049`, el
fix de consentimiento `88b16c6`/`d8b8938` y parte del corte renderer/herencia
`b17acf4`/`db348ef`. El frontend fuente es `dd138101`, promovido a la rama
staging mediante `cf9805cc`, sobre la base `7435a827`/`522b1fc1`;
`front-dev`/ng-serve quedó fast-forward y TypeScript pasa; su compilación de
desarrollo terminó con hash `fa3f6c6dfda1977c`, pero no se generó ni publicó
un bundle estático nuevo. Las migraciones aditivas
`20260719103000-create-managed-campaign-provider-executions.js` y
`20260719113000-create-web-content-generations.js`, además de
`20260719170000-add-web-artifact-clinic-snapshot-identity.js`, están aplicadas
en staging. `clinic_snapshot_hash` es `VARCHAR(64) NOT NULL`; el índice único
incluye `revision_id`, renderer, entorno, base URL, runtime y snapshot de
clínica, y el índice legacy ya no existe.
La migración `20260715152000-purge-google-places-competition-content.js`
continúa cancelada y es un no-op: no debe reactivarse ni describirse como una
purga pendiente.

El piloto WordPress de Propdental ya sirve
`clinicaclick-web-renderer/1.7.0`. La primera republicación creó deployment
`18fa50be-270f-4d70-96cb-95880ed0c68e`, secuencia `11`, y artefacto
`aa05cb59-b27f-4d83-b8fb-f6ef0d4d5cb9` (hash `648cf766…`). `/cita/` devolvió
`200`, HTML SHA-256 `153275eb…`, condicional `304`, `warnings=[]`,
`PostalAddress`/`OpeningHoursSpecification` presentes y ninguna imagen de
clínica insegura. La evidencia 1.6, artefacto `0dcd4d80…` y secuencias 8–10
queda como historial de rollback, no como versión live.

Durante un diagnóstico se mostró accidentalmente un HMAC vigente. No se
reproduce en esta documentación: se rotó inmediatamente mediante la
reconciliación durable `889cc3a4-7d09-4cb0-accb-65acbdbfbb61`, generación `2`.
El target usa deployment `ae350f06-3325-4b88-9a46-3c37f2e627dc` y artefacto
`2a2abd9a-9249-44a2-926c-92656084725b`, ambos verificados; la reconciliación
terminó, las claves aceptadas pasaron de 2 a 1 y se eliminaron los envelopes
source/target. El readback final base `/cita/` acredita hash de artefacto
`cd4119d…`, SHA-256 HTML `a34a993…`, condicional `304`, renderer `1.7.0` en
desktop/móvil, `WebSite`/`Dentist`/`WebPage`, `PostalAddress`, diez horarios,
ausencia deliberada de imagen Schema y CSP correcto. Es una evidencia distinta
de la landing Hospitalet descrita debajo. Una sincronización manual WordPress debe ejecutarse
como usuario OS del sitio `propdental.es`, nunca como `root`: el primer intento
1.7 dejó la caché ilegible, se reparó ownership y se repitió con ese usuario.

El E2E campaña -> landing descubrió un caso real de precedencia de
`IntakeConfig`: Hospitalet `59` tenía la fila local `81`, válida para sus
integraciones técnicas pero sin consentimiento web completo, y esa fila
ocultaba el consentimiento grupal válido `24`. El fix `88b16c6` conserva
`intake_config_id`, chat, teléfono e integraciones efectivos de la clínica y
solo hereda el bloque de consentimiento del grupo cuando se cumplen a la vez
cuatro condiciones: el consentimiento local no está listo, la pertenencia real
al grupo coincide, `group.config.locations` incluye explícitamente la clínica y
el consentimiento grupal está completo. No hay fallback cross-group ni ante
una lista de sedes implícita/vacía. La respuesta separa procedencias mediante
`consent_source_scope`, `consent_source_scope_id` y
`consent_source_intake_config_id`; por tanto no atribuye al grupo las
integraciones locales ni oculta qué fila autorizó el consentimiento.

La suite `npm run test:marketing-web` pasó tras el cambio. Staging amplió de
forma acotada `MARKETING_WEB_PUBLISHING_SCOPES` a `group:5,clinic:59` y se
reinició de forma segura. El proyecto E2E
`4df293bd-98b9-4dd7-a601-3c557048925c` resuelve intake local `81`,
consentimiento de grupo `24` listo e instalación WordPress disponible. La
publicación `fe4dece6-36a8-47f2-86a0-70235f8e11d6` está verificada con
deployment `e5156f84-7977-4c4d-b626-42acd33f7bff` y artefacto
`dafc020d-03a0-4c6a-9c7f-e4d93fe18376` en
`https://www.propdental.es/cita/primera-visita-hospitalet/`.

El bridge runtime necesitaba exportar de forma explícita
`stableHttpsDestination`; el fix `6fdd153`/`f9c3049` lo convierte en contrato
del hook, sin relajar la validación HTTPS. `marketing_web.landing_published.v1`
job `32462` completó tras un retry natural (`4/8`), sin error, y creó el binding
final `8a056617-7072-4e2a-9a84-e6438a303175` para estrategia `10`, clínica `59`,
proyecto/publicación/artefacto anteriores y la URL exacta. La estrategia está
en `connect_only`: `destination_status`/capability quedaron `blocked`, con
`measure_mode_never_changes_destinations`, y las siete cuentas quedaron
bloqueadas. `destination_ready` job `32468` completó. Desde las `18:25` no se
creó ningún `marketing_campaign.destination_apply.v1`; por tanto hubo **cero
mutaciones de proveedor**, que es el resultado correcto de Mide y entiende.

El readback público devolvió `200`, condicional `304`, header/marker exactos,
hash de artefacto `3a8aff…`, renderer `1.7.0`, salida determinista, cero código
ejecutable aportado por el usuario y `warnings=[]`; contiene un formulario, un
grafo JSON-LD, `PostalAddress` y horarios. Chromium a `1440` y `390` confirmó
HTTP `200`, overflow `0` —salvo el honeypot deliberadamente fuera de
pantalla—, email, teléfono, consentimiento, contacto preferido, Consent y chat
correctos, con cero errores de consola o página. Evidencia:
`/home/ubuntu/qa-evidence/marketing-web-editor/campaign-landing17-live/` y
`campaign-landing17-e2e-evidence.json`. Este E2E acredita publicación
heredada, binding auditable y el guard de no mutación de `connect_only`; no
afirma que se haya cambiado un destino publicitario ni habilita hosted/custom.

El E2E controlado posterior cerró también el intake de esa landing en staging.
Creó temporalmente `LeadIntake #7272` para clínica `59`/grupo `5`, con
`source=google_ads` y `source_detail=clinicaclick_web_landing`, publicación
`fe4dece6-36a8-47f2-86a0-70235f8e11d6`, binding
`8a056617-7072-4e2a-9a84-e6438a303175`, cuyo `targetKind` persistido es
`general`; asignación Google Ads `28`, customer `1851215478`, campaña
`21313059516` y resolución Ads a estrategia `10`, request `24`,
`target_kind=generic`. El snapshot inmutable `web_landing` schema `1` validó
la identidad exacta de publicación, proyecto, revisión, página, artefacto,
formulario, scope, asignación Ads y estrategia antes de aceptar la atribución.
La revisión exacta fue `fc244f6e-b0b5-46cf-af72-05041a70c3a3`, deployment
`e5156f84-7977-4c4d-b626-42acd33f7bff`, artefacto
`dafc020d-03a0-4c6a-9c7f-e4d93fe18376` y hash
`3a8aff298c3768acbb6564ab4cc2c63ed6009abb614a29a549483422ea762dc4`.
La conversión terminó `skipped/no_permitted_identifiers`, con
`provider_request_id=null`; por tanto el E2E produjo **cero escrituras
externas** y no demuestra una conversión enviada a Google. La limpieza
confirmó cero restos de lead, formulario, audit, intento y eventos, y retiró
además ocho eventos de preflight. Evidencia saneada:
`/home/ubuntu/qa-evidence/marketing-web-editor/campaign-landing17-lead-e2e-evidence.json`.

El hardening final de destinos `8c4fdeb`/staging `55a34d7` cierra el límite
entre los tres modos. Al crear/revalidar un binding persiste en su autorización
un snapshot digest de modo, estado activo, scope, mandato y cohorte exacta
ordenada de cuenta/campaña/familia; la identidad de ejecución congela además el
destino y la operación concreta. La estrategia debe estar activa y todas sus
filas deben conservar un único modo/estado. La solicitud y el worker revalidan
el contrato antes de preparar, antes de mutar, después de mutar y tras el
readback; los jobs hermanos no se invalidan por un incremento incidental de
`binding.version`. Piloto automático vuelve a comprobar en cada gate la
`ManagedCampaign` y sus constraints/aprobación vigentes.

Un binding antiguo sin digest falla cerrado con
`campaign_destination_binding_refresh_required`; cambiar modo, estado, scope,
mandato o cohorte devuelve `campaign_destination_strategy_changed`, y una
cuenta que ya no pertenece al target devuelve
`campaign_destination_account_not_in_strategy`. Antes de mutar, cualquiera de
estos casos termina `blocked` con `provider_mutation=false`. Si el contrato
cambia después de iniciarse una mutación autorizada, el sistema no aplica otro
destino: encola la compensación. Incluso tras bajar a `connect_only`, un
rollback automático o manual puede restaurar **exclusivamente** el
`beforeState` capturado por aquella operación autorizada; no admite URL libre
ni reaplica el `desiredState`. La atribución legacy sin target solo se recupera
si la pareja Google cuenta/campaña pertenece de forma única al target exacto de
la landing; `general` y `generic` se canonicalizan y cualquier ambigüedad falla
`web_landing_google_strategy_mismatch`. Auditor independiente: **GO**; pruebas
focales **29/29** y suite Campañas **81/81**. El corte final
`3f0c0e0`/`a22b773` añade el snapshot inmutable y el cierre controlado anterior;
la suite completa termina **354/354** contratos Node de Marketing Web,
**40/40** WordPress y **81/81** Campañas.

La generación IA quedó acreditada extremo a extremo sin aceptación ni
publicación automática: generación
`b2f25c1b-9258-4228-bebc-ec636dcf141f`, `JobRequest #32302`, estado
`completed`, proveedor `openai`, modelo efectivo `gpt-5.6-sol`, Responses API
server-side, `store:false` y Structured Outputs. La propuesta se persistió,
pero `accepted_content_entry_id` permanece `null`; por tanto no se creó un
borrador CMS por aceptación y no se publicó nada. El hotfix backend permite
persistir transiciones internas parciales del job sin relajar la validación de
los payloads públicos; el fence one-shot sigue impidiendo repetir una llamada
de proveedor cuyo resultado sea incierto.

El último frontend estático acreditado tiene build hash `2ad4b1b987a9fde2`, bundle principal
`main.5e80d0ee5d4c9ec5.js` y chunk Marketing
`3584.9ae0ef3a69fb0819.js`; el CRM público responde `200`. El build anterior
`b218a1d8f3575d73` y su QA Chromium desktop `1440x1000`/móvil `390x844`
quedan como baseline visual histórica: cero overflow, cero solapamiento y cero
errores de consola, página o HTTP. Su evidencia saneada
`result.json` tiene SHA-256
`c1f4a16feea37dd8c42917642f9f2a95820f4721781259a0696ed8d91d25f35c`.
El QA público WordPress se repitió en contextos Chromium separados desktop y
móvil: HTTP `200`, mismo artefacto, consentimiento aceptado, banner oculto,
`visible_chat_candidates=1` y overflow `0` en ambos. Evidencia
`wordpress-renderer16-live/result.json`, SHA-256
`2b7e024f3fb586faf593732a54c40868e5b4d03c87ccda98f7852297ffc0701d`.
Solo persiste el warning benigno de que `frame-ancestors` no se aplica desde
meta CSP; el header CSP real sí lo incluye.

La ejecución gestionada Google Search está desplegada y migrada, pero sus dos
flags (`MANAGED_CAMPAIGN_PROVIDER_EXECUTION_ENABLED` y
`MANAGED_CAMPAIGN_PROVIDER_ACTIVATION_ENABLED`) permanecen apagados. No hubo
llamadas ni mutaciones reales de Google: crear, activar y rollback continúan
fail-closed hasta autorización y activación explícitas. WordPress es el único
canal público acreditado; `clinicaclick_hosted` y `custom_domain` siguen
bloqueados por DNS/TLS/proveedor/E2E externo y no se consideran operativos. La
forma hosted canónica planificada es `https://sites.clinicaclick.com/<slug>/`;
no se ha validado el modelo por subdominio/wildcard. Antes de comercializar
hosted o custom falta también el flujo de retiro/deprovisión, incluida la
eliminación del Custom Hostname/WebDomain del proveedor.

Contrato promovido y acreditado en el E2E controlado de publicación/binding
`connect_only`: una clínica puede consumir la instalación
WordPress activa propiedad de su propio grupo. La resolución debe exponer
`inherited_from_group=true` y `source_scope`, sin permitir cross-group ni la
herencia inversa de una instalación de clínica hacia el grupo. El proyecto y
la publicación conservan scope propio de clínica; el grupo sigue siendo el
único administrador del plugin, token e instalación compartida.

Al crear una publicación desde un proyecto de grupo, la clínica que se
materializará en `configuration.clinic_id` se bloquea con `UPDATE` y se
revalida como activa y miembro del mismo grupo dentro de la transacción. Así un
movimiento o una desactivación concurrentes no pueden dejar una publicación
recién creada fuera de scope. Los focos de servicios+guards pasan **26/26** y
el E2E Hospitalet acreditó la ruta heredada sin mutar proveedor.

La autorización es row-backed y se revalida contra membresía activa; crear una
publicación no concede un derecho durable si la clínica abandona el grupo. El
PATCH que cambia grupo o desactiva la clínica falla cerrado hasta retirar las
rutas WordPress heredadas y recibir confirmación/tombstone del runtime
(`clinic_membership_wordpress_publication_retirement_required`). El inventario
cubre también publicaciones `scope=group` materializadas para la
clínica mediante `configuration.clinic_id`: no puede sacarse ni desactivarse la
clínica hasta retirar esas rutas y recibir tombstone ACK. La herencia
del runtime/HMAC también exige reconciliarse antes de cambiar grupo
(`clinic_group_change_web_runtime_reconciliation_required`). Este preflight usa
la misma transacción/locks del cambio de clínica y no debe eludirse desde UI.
La edición bulk de grupos tampoco es un bypass:
`groupAssets.updateGroupConfig` centraliza
`applyClinicMembershipSelection`, toma locks de `Clinica` en orden estable y
ejecuta por cada transición los mismos gates de retire+ACK WordPress y
reconciliación de runtime antes de mutar pertenencias. El controller conserva
el `409` y el código de dominio. La regresión
`web_group_membership_transition_guard` pasa 4/4 y la focal ampliada 76/76.
El E2E campaña -> ruta Hospitalet ya acredita la herencia de publicación; la
transición destructiva de membresía/revocación conserva su E2E operativo
independiente.

Revocar una instalación no reutiliza el máximo operativo de 20 rutas activas:
inspecciona hasta `MAX_WORDPRESS_PUBLICATION_HISTORY=200` publicaciones
históricas y exige retiro más tombstone ACK para todas. La regresión con 21
tombstones bloquea si falta un ACK y revoca solo cuando están los 21; la focal
ampliada pasa **76/76**. Está desplegado; el E2E destructivo específico de
revocación masiva continúa pendiente y no debe confundirse con el E2E
campaña -> ruta Hospitalet ya cerrado.

El registry, la validación de ACK y la carga de artefacto revalidan también las
publicaciones `scope=group` mediante su `configuration.clinic_id`. Si la
clínica falta, está inactiva o ya no pertenece al grupo, la ruta se excluye
fail-closed. Los locks mixtos de publicaciones clinic/group se ordenan por
`effectiveClinicId` para evitar deadlocks. El foco tras este parche pasa 76/76;
la suite integral de aquel corte pasó 351/351 y el cierre final posterior
amplía Marketing Web a 354/354.

Contrato live del renderer **1.7/1.8**: el compilador puede
completar `PostalAddress` y `OpeningHoursSpecification` desde la ubicación
efectiva verificada, pero no reutiliza automáticamente fotos de Google Business
Profile ni sus `googleUrl`. Para OG/Schema solo admite la imagen canónica de
Clinicaclick cuando es pública y supera el mínimo de tamaño; sin ella omite la
imagen. La ficha GBP efectiva nunca se elige por `last_synced_at`: en modo de
grupo se usa exclusivamente `business_profile_primary_location_id`; en modo
clínica se exige una única asignación explícita y, si no existe, una única
`ClinicBusinessLocation` directa que esté activa, verificada y no suspendida.
La diferencia de `1.8` frente a `1.7` es el soporte de `animation` tipado y
clases `cc-animate-*`; el contrato GBP/SEO anterior no cambia.
Dos asignaciones o dos fichas directas candidatas son ambiguas y el compilador
no completa dirección/horario desde Google. Los contratos primaria frente a
reciente y doble ficha ambigua pasan **21/21** focales. La identidad inmutable
añade `clinic_snapshot_hash` a DB, marker,
manifest y caché. Así un artefacto no puede reutilizarse entre clínicas y un
cambio de dirección u horario efectivo fuerza un artefacto nuevo. La migración
aditiva `20260719170000-add-web-artifact-clinic-snapshot-identity.js` está
aplicada y el renderer pasa su tanda focal **43/43**. La publicación inicial,
el readback final tras rotación y el E2E campaña -> ruta Hospitalet de 1.7
están acreditados. El intake controlado de la landing también está acreditado y
limpio mediante `LeadIntake #7272`; no hubo escrituras externas. El 1.7 retira
`frame-ancestors` de la meta CSP, donde el navegador lo ignora, y lo conserva
en el header CSP real.

Desde 2026-07-27, el contrato de columnas del editor mantiene
`column_tracks` como compatibilidad/fallback de fila y añade `column_widths`
en `section.props` exclusivamente para nodos `structure_role=column`. El
compilador valida que esos anchos sean enteros 1..12 y rechaza cualquier
`column_widths` fuera de columnas. Cuando una fila contiene alguna columna con
`column_widths`, el renderer emite `cc-column-widths` en la fila, cambia su
grid a 12 columnas y añade `cc-col-span-*` por breakpoint a las columnas. Las
hermanas sin override heredan su ancho desde `column_tracks` de la fila; si no
hay track válido para ese índice/breakpoint, se apilan con fallback 12/12. Esto
permite que el inspector edite una columna sin reescribir el reparto de las
demás y mantiene documentos antiguos publicables.

Evidencia definitiva del código promovido: backend Marketing Web **354/354**
contratos Node, contratos WordPress **40/40**, Campañas **81/81**, reviewer
focal **96/96** con GO explícito y sin hallazgos high/medium, frontend
Marketing **302/302**, TypeScript aplicación/specs exit `0` y `git diff
--check` limpio. `front-dev`/ng-serve compiló en desarrollo con hash
`fa3f6c6dfda1977c`; no es un build estático desplegado. Estos resultados no
sustituyen el readback final, E2E público ni rollback posterior al target.

---

## 2026-07-19 - Marketing Web `alpha.8` promovido; E2E multi-route cerrado

La rama de integración contiene el corte completo del editor/CMS,
SEO + Schema, plantillas, landings y los tres niveles comerciales de campañas.
El diseño de referencia de ModSuite quedó verificado directamente en Figma,
archivo `gi540QkcCiJYc7xmoWXk8t`, nodo `682:3296`; se reutiliza su arquitectura
de interacción, no código generado por Figma. El corte funcional frontend
`c5fcab42` fue promovido a staging mediante `c51537dd`; la comprobación de
Figma y la promoción del runtime son evidencias distintas.

El paquete fuente WordPress es `clinicaclick-web 2.0.0-alpha.8`; backend/plugin
`1cdfaa1` se promovió a staging mediante `aa8bc4c`, el frontend mediante
`c51537dd` y Propdental ya ejecuta `2.0.0-alpha.8`. Los fixes posteriores son
`aacd01b`/staging `4769283` para preservar el source HMAC con publicación
bloqueada, `29e0179`/staging `93c45f4` para el contrato de medición WordPress y
`5d11cf8`/staging `e562936` para ETag. `alpha.8` añade registro firmado de hasta 20 rutas, token staged,
reconciliación durable del runtime de intake, sobres AES-256-GCM, recuperación
administrativa idempotente, lookup dirigido de artefactos, claim de propiedad
del sitio y enlace exacto de cada runtime/registro/manifest con la clave
Ed25519 aceptada. Una instalación `pending` no reserva una URL ni puede leer
desired-state/artefactos: solo pasa a `connected` después de demostrar por
HTTPS el challenge temporal servido por ese WordPress y ganar el índice único
de `claimed_site_hash` dentro de la transacción. El heartbeat posterior solo
confirma/oculta la prueba; no sustituye el claim.

Las siete migraciones alpha8, en orden, son
`20260718230000`, `20260718233000`, `20260719090000`, `20260719091500`,
`20260719093000`, `20260719094500` y `20260719100000`. Están aplicadas en
staging. La última añade el claim de sitio con backfill y
preflight fail-closed; su contrato se verificó sobre una tabla desechable en el
MySQL staging real: rerun idempotente, `pending` sin reserva, único claim
conectado, duplicado rechazado y `down` bloqueado si existen filas. La tabla de
prueba se eliminó. La `20260719091500` pasó además su preflight específico en
MySQL 8.0.42 con credencial de mantenimiento temporal al proceso de test: el
`LOCK TABLES` esperó a un writer previo, los tres triggers bloquearon
INSERT/UPDATE/DELETE, un DDL fallido conservó el fence, el rerun cifró/descifró
correctamente y la conexión liberó explícitamente sus locks. La comprobación
final dejó cero tablas y cero triggers de scratch. El usuario ordinario no
recibió privilegios nuevos; en el rollout fresco la tabla `090000` ya nace sin
columnas plaintext.

Evidencia del corte: runner Marketing Web **320/320**, contratos
WordPress **40/40** y tres pruebas end-to-end de interoperabilidad
Node→PHP/compilador/ZIP provisionado; Campañas recorre 34 contratos y termina
verde. El frontend pasa **168/168** pruebas focales, **252/252** de Marketing,
TypeScript, i18n y build de producción. La revisión de seguridad cerró con
cero P0/P1/HIGH abiertos. El ZIP genérico contiene 17 entradas y tiene SHA-256
`126e0fb6f77ad08e1c2ed53b673ed094dd25de8ebd99e28d0f167e8439409bc7`;
incluye `class-ccw-site-claim.php` y no incluye configuración provisionada.
El ZIP provisionado final contiene 18 entradas y tiene SHA-256
`86792a2ebf69cd9c36f529f98b1528e2ed5b08c9fe5d33216ea33b348695479f`.
WP-CLI y DB reportan `alpha.8`; handshake schema 2, claim y promoción del token
staged terminaron correctamente. Antes del E2E de rutas, desired/reported
coincidían en secuencia de registro 8. La caché gestionada está fuera del
document root y tanto sus rutas privadas como las antiguas rutas públicas
responden `404`. El E2E público de dos rutas, la rotación HMAC y el readback
ETag terminaron y se detallan más abajo. Cloudflare y origen devuelven `304`
con `If-None-Match` exacto después de retirar el magic-quotes de WordPress.

El inventario canónico del runtime vigente es **33 tareas
periódicas**, **14 integraciones dirigidas/background**, **47 tipos background**
en total y **63 handlers**. `web_content_generation` y las operaciones
`managed_campaign.google_search_create.v1`,
`managed_campaign.google_search_activate.v1` y
`managed_campaign.google_search_rollback.v1` comparten el carril durable de
proveedores; `web_intake_runtime_reconcile` sigue registrado en el mismo
executor. No existe un cron lateral para reconciliación, publicación, monitor,
generación IA, mutación gestionada o limpieza.

---

## 2026-07-17 - Visibilidad local en asistentes de IA

- `GET /api/marketing/reports/competition/ai-visibility` exige una clínica concreta, revalida `marketingScopeAccess` y, al entrar el usuario en Informes, garantiza cuatro consultas canónicas del sistema: mejor opción local de su categoría, opciones de la especialidad, clínica recomendada y clínica con buenas reseñas. La primera usa `¿Cuál es la mejor clínica…?` cuando la categoría empieza por «clínica» y `¿Qué <categoría> es la mejor opción…?` en el resto, evitando concordancias incorrectas como «la mejor podólogo». No depende de texto libre ni de que el usuario pulse un botón. Este GET es el único disparador automático: `getOverview()` usa `autoStart=false` por defecto, `GET /:runId` solo hace polling y no existe cron diario/semanal de proveedores.
- Desde 2026-07-24, categoría y zona proceden también de la identidad canónica `Clinicas.configuracion.marketing_competition_local_profile` generada al resolver `url_ficha_local`, además de la ficha conectada y los campos internos. La categoría debe ser una disciplina concreta: si solo consta «clínica» o falta la localidad, el servicio devuelve `setup_required + AI_VISIBILITY_DISCIPLINE_REQUIRED` y no consulta proveedores. Los runs de una categoría/localidad anterior se conservan como auditoría, pero el overview solo presenta los cuatro hashes canónicos vigentes. `typical_queries` publica el catálogo; cada run devuelve `query_key` y `query_source`.
- Si ningún proveedor tiene secreto, el GET devuelve `200 + configuration_required` y `automatic.waiting_configuration`: no crea filas/jobs y la UI puede explicar qué falta. Con al menos uno configurado, encola solo las consultas sin una ejecución de los últimos siete días y devuelve `collecting|partial|ready` sin convertir una carencia de configuración en un error de carga.
- `POST` queda como compatibilidad temporal y solo elige una consulta canónica por `query_key`; un `query` legacy se acepta exclusivamente si coincide con el catálogo. No existe prompt libre. `GET /:runId` permite polling del run de esa clínica.
- `MarketingAiVisibilityRuns` guarda consulta, estado, resultados normalizados, fuentes/citas y expiración. La migración es `20260717133000-create-marketing-ai-visibility-runs.js`.
- El request Express solo crea `JobRequest type=marketing_ai_visibility_run`, prioridad baja, máximo dos intentos y namespace del runtime. Se deduplica por `clinicId + queryHash`; `scheduledJobCatalog` lo clasifica como integración dirigida y `jobExecutor` ejecuta `marketingAiVisibilityService.executeRun()`.
- OpenAI usa `POST /v1/responses`, modelo configurable (por defecto `gpt-5.6`), herramienta `web_search`, `tool_choice=required`, fuentes completas e `store=false`. Gemini usa `POST /v1beta/interactions`, modelo configurable (por defecto `gemini-3.5-flash`), herramienta `google_search` y `store=false`.
- `GET /api/metasync/jobs/usage/ai-visibility` expone en Jobs Monitoring el estado de ChatGPT/Gemini sin llamar a proveedores ni consumir cuota: lee configuración y último run persistido. Los `429 insufficient_quota` se muestran como `quota_limited`, los `429 too_many_requests` como `rate_limited`, y solo saldo/facturación explícitos quedan como `billing_required`.
- Los parsers conservan texto, consultas, `url_citation`, fuentes y el `search_suggestions` de Gemini. Solo se envía contexto público de la clínica; la validación rechaza emails y teléfonos en la consulta. No se imprimen claves, prompts ni respuestas completas en logs.
- Control de coste y retención: resultados/textos/fuentes/citas se reutilizan siete días, los runs activos se reutilizan 15 min y se admiten cuatro consultas distintas por clínica/7 días, con un único intento por consulta/7 días. El cupo global solo cuenta los hashes del catálogo construido con la categoría/localidad actuales, de modo que corregir esos datos permite medir el nuevo contexto sin que lo bloquee el anterior; el límite individual por hash permanece. `completed`, `completed_with_errors` y los `failed` que sí tienen `job_request_id` o `started_at` bloquean por igual una repetición anticipada. Si falla el encolado antes de crear job/proveedor, se destruye el run; las filas legacy `failed` sin `job_request_id` ni `started_at` tampoco se reutilizan, muestran ni cuentan. Retención local 30 días (nunca inferior al refresco) y timeout por proveedor 90 s. `system_data_cleanup` elimina filas vencidas. Los proveedores se ejecutan en paralelo y degradan por separado. Variables vigentes: `AI_VISIBILITY_REFRESH_INTERVAL_DAYS`, `AI_VISIBILITY_MAX_RUNS_PER_CLINIC_7D`, `AI_VISIBILITY_RETENTION_DAYS` y `AI_VISIBILITY_PROVIDER_TIMEOUT_MS`; se retiran los controles legacy de 24 h. Runbook: `docs/marketing-ai-visibility.md`.
- Secretos únicamente en entorno backend: `OPENAI_API_KEY` y `GEMINI_API_KEY`. También se admiten `OPENAI_PROJECT_ID`, `OPENAI_ORGANIZATION_ID`, `GOOGLE_CLOUD_PROJECT` y `GOOGLE_CLOUD_PROJECT_NUMBER`. Ninguno se expone al frontend ni se versiona.

## 2026-07-15 - Informes sin mock, Perfil Google agregado y heatmap local gobernado

Este corte endurece `Marketing > Informes`, completa el lector operativo de Google Business Profile y deja preparada una medición local durable/coste-controlada detrás de un gate contractual. El contrato de producto ampliado está en `cc-front/src/Documentacion/20.7-marketing-fase7-informes.md`; el contrato transversal de ownership está en `20.13`.

### Informes y ACL de Marketing

- `GET /api/marketing/reports/overview` sigue siendo el agregado del resumen. El frontend ya no sustituye un error por KPIs mock: muestra error o vacío real.
- Los controladores de Informes y Competencia exigen autenticación y validan lectura/escritura contra el scope de Marketing. Una `clinica_id` del body o query no es autorización.
- `marketingReports.controller.js` continúa resolviendo Google Ads, Meta, Search Console, GA4, social y Perfil Google con `resolveEffectiveMarketingAssetInventory`. Conexión, sync y presencia de datos son señales independientes.
- En vistas multiubicación de Perfil Google, las métricas se eligen por ubicación+día: se usa el agregado `TOTAL`/canónico si existe y solo se suman componentes Maps/Search o desktop/móvil cuando falta. Después se suman las ubicaciones; nunca se elige el fallback globalmente para todo el scope.

### API local agregada de Perfil Google

Todas las rutas `/api/local/clinica/:clinicaId/*` pasan por JWT y `hasMarketingClinicScopeAccess`. El middleware resuelve una vez las ubicaciones efectivas con `resolveEffectiveMarketingAssetInventory`; una ficha heredada/asignada se consume igual que en Informes. Las escrituras requieren `access=write` sobre la clínica solicitante y, si el activo es compartido/grupal, sobre su propietaria y todas las clínicas consumidoras; si falta una, responde `409 business_profile_asset_in_use` sin mutar Google.

| Endpoint | Contrato |
|:---|:---|
| `GET /status` | Activo efectivo y estado saneado. No devuelve `raw_payload`; `purpose=reviews` es la única ruta que puede aplicar el alias de reseñas. |
| `GET /dashboard` | Agrega `status`, `overview`, `timeseries`, `seasonality`, `reviews`, `posts`, `content` y `reviewInsights`. Usa `Promise.allSettled`: `partial=true` identifica las secciones fallidas sin perder las sanas. |
| `GET /overview` | Rango actual/anterior, métricas de visibilidad/acciones y resumen de reseñas. |
| `GET /timeseries` | Serie diaria para una métrica permitida. |
| `GET /seasonality` | Serie mensual de 6 a 36 meses e insight de mejor/peor mes. |
| `GET /reviews` | Paginación real `limit/offset`; filtros `rating`, `unreplied` y `negative`; excluye `raw_payload`. |
| `GET /posts` | Paginación real `limit/offset`; excluye `raw_payload`. |
| `GET /content` | Servicios de `serviceItems` y galería de la Media API, normalizados para UI. |
| `GET /review-insights` | Heatmaps invierno/verano de respuestas privadas ClinicaClick y proyección de reseñas 5 estrellas para la media pública. |
| `POST /photos` | Publica en Google un `PublicMediaAsset` público/no clínico del mismo scope; nunca consume una URL arbitraria del body. |

La carga inicial normal del frontend ejecuta **un único GET a `/dashboard`**. Los ocho endpoints individuales no son una estrategia de reintento: solo se usan como compatibilidad con runtimes antiguos cuando `/dashboard` responde `404`, `405`, `501`, `local_dashboard_not_implemented` o `not_implemented`. Un `500`, timeout o fallo de red se propaga como error real y no debe provocar un fan-out de ocho llamadas. El dashboard lee datos ya sincronizados; las llamadas a Google pertenecen a los jobs de Perfil Google, no al render de la página.

`reviewInsights.review_response_heatmaps` puede contener matrices estructuralmente válidas con totales `0`. En ese caso la UI mantiene visible **Cuándo responden los pacientes** y muestra el estado vacío de invierno/verano; no oculta el bloque ni mezcla esas respuestas privadas con `google_rating_summary`, que procede de reseñas públicas.

La publicación de foto valida asset activo, `scope_type=clinic`, `clinica_id`, `sensitivity=public`, MIME `image/*`, `purpose=marketing_image`, `owner_type=google_business_profile_media` y metadata `non_clinical_asserted=true`; además rechaza defensivamente `patient_data_in_public_media`/`patient_name_present`, de modo que una imagen personalizada de WhatsApp nunca pueda reutilizarse en Google. El frontend debe pedir una única confirmación explícita para toda la tanda seleccionada y solo entonces crear un asset independiente por imagen con esa declaración; nunca la afirma automáticamente. Resuelve/renueva el token de la conexión efectiva y usa Media API v4 con una categoría permitida (`ADDITIONAL`, `COVER`, `PROFILE`, `LOGO`, `EXTERIOR`, `INTERIOR`, `PRODUCT`, `AT_WORK`, `TEAMS`). `COVER` se publica sin `description`. La lectura conserva la atribución que devuelve Google (`profileName`, foto/perfil y `takedownUrl`) y la UI debe mostrarla junto a la imagen cuando exista.

### Sync GBP y consistencia

- El `readMask` de Business Information incluye datos operativos, `serviceItems` ([contrato oficial de servicios](https://developers.google.com/my-business/content/services)) y `latlng`. El sync completo refresca detalles, métricas, reseñas, posts y media; conserva timestamps independientes `clinicaclick_*_synced_at` para no declarar actualizado un bloque cuyo proveedor falló.
- La verificación usa `metadata.hasVoiceOfMerchant`, el campo canónico de Business Information, y el sync completo consulta además `GET mybusinessverifications.googleapis.com/v1/{location}/VoiceOfMerchantState`. Guarda el resultado saneable en `clinicaclick_voice_of_merchant_state`: distingue ficha en regla, revisión de calidad, verificación por iniciar/completar, conflicto de propiedad y suspensión/desactivación por directrices. `verificationState`/`verificationStatus` quedan solo como fallback de snapshots legacy; la UI nunca debe inventar el motivo a partir de un booleano.
- Servicios permanecen dentro de los detalles de la ubicación; la lista de Media API se conserva como `clinicaclick_media_items`. La respuesta HTTP proyecta solo campos seguros/útiles.
- La sync incremental de reseñas corre cada 15 minutos, limita páginas y solo encola conciliación para reseñas nuevas/cambiadas. La sync completa pagina todo el inventario y reconcilia reseñas que Google ya no devuelve; el borrado no se ejecuta sobre una lectura incremental o incompleta.
- Las actualizaciones parciales de `raw_payload` se fusionan bajo lock/transacción o escritura JSON atómica. Detalles, media, timestamps y publicación de foto no deben sobrescribirse entre sí con una snapshot antigua del JSON.
- La misma conexión/token se reutiliza dentro de la pasada para reducir refreshes OAuth. Un fallo auxiliar de servicios/media se registra por bloque y no impide conservar métricas/reseñas que sí terminaron.

`BusinessProfileDailyMetrics` queda endurecida por la migración `20260715151000-dedupe-business-profile-daily-metrics.js`, aplicada en la base compartida el 2026-07-15:

1. conserva por `business_location_id + metric_type + COALESCE(metric_subtype,'') + date` la fila con `updated_at` más reciente y, en empate, mayor `id`;
2. normaliza `metric_subtype=NULL` a cadena vacía;
3. crea `uniq_business_profile_metric_location_type_subtype_date`;
4. el sync puede usar upsert idempotente sin volver a acumular duplicados.

Esta migración debía ejecutarse **antes de reiniciar código nuevo**: el modelo ya declara `metric_subtype NOT NULL` y el upsert depende del índice único. El corte ya está aplicado; la verificación posterior dejó `22.077` filas, cero subtipos `NULL`, `22.077` subtipos vacíos y cero grupos duplicados.

### Competencia local: gate contractual, coste, caché y orquestación

El producto opera en el EEE. El caso de uso de inteligencia competitiva/ranking local no figura de forma expresa entre los usos permitidos publicados para Places API en el EEE. Por eso el código conserva a `false` los defaults de `COMPETITION_GOOGLE_PLACES_COMPETITOR_USE_ALLOWED`, `COMPETITION_GOOGLE_PLACES_COMPETITOR_STORAGE_ALLOWED` y `COMPETITION_LOCAL_RANKING_STORAGE_ALLOWED`; una API key por sí sola nunca habilita el proveedor. Para esta instalación de ClinicaClick los tres gates están activados en runtime desde el 2026-07-15 por autorización operativa expresa del titular tras revisión con su DPO. Esta decisión de privacidad no sustituye la revisión contractual/licencia de Google, que queda registrada como control separado.

Con los gates apagados, `suggestions` devuelve `COMPETITION_DISCOVERY_PROVIDER_REQUIRED`, el usuario puede dar de alta competidores manuales y `local-heatmap` devuelve `LOCAL_RANKING_PROVIDER_REQUIRED`. No se aceptan `source=google_places`, `google_place_id` ni `raw_place_payload` disfrazados de alta manual. Con los gates activos, la primera entrada a Competencia para una clínica concreta carga en paralelo sugerencias y la matriz del primer término a `1 km`. El frontend lo hace una sola vez por clínica durante la vida del componente; el backend reutiliza sugerencias seis horas y el heatmap por su identidad persistente. Término y radio son controles de navegación: cada cambio solicita inmediatamente la matriz correspondiente, sin botón intermedio de aplicación.

`GET /api/marketing/reports/competition/local-heatmap` puede, por tanto, invocarse durante ese bootstrap inicial o por una acción posterior del usuario. Cada punto usa Places Text Search con `X-Goog-FieldMask: places.id`, `pageSize=20`, `rankPreference=RELEVANCE` y `locationBias` centrado en el punto. Backend no descarga, persiste, reenvía ni sirve Google Static Maps ni teselas. Devuelve las coordenadas de muestreo y la posición derivada; el frontend puede proyectarlas sobre teselas OSM solicitadas directamente por el navegador, con atribuciones separadas `OpenStreetMap` y `Posición estimada: Google Maps`. No se presentan nombres, fichas ni contenido de Places sobre OSM; se usa la excepción EEE de latitud/longitud de la cláusula 15.1 de los términos específicos.

El endpoint de sugerencias usa un único Text Search con `pageSize <= 20` y una máscara Pro reducida a identidad, nombre, dirección, coordenadas, categoría, Maps URI y estado. No pide valoraciones, número de reseñas, teléfono, web ni fotos y no dispara una petición de foto por resultado. Los detalles enriquecidos se consultan solo cuando el usuario añade un competidor. La regresión `marketing_competition_suggestions_efficiency.test.js` fija este contrato de coste.

La migración `20260715150000-create-marketing-competition-heatmap-cache.js` crea `MarketingCompetitionHeatmapCaches`. La clave estable cubre scope, clínica primaria, identidad de ficha, término normalizado, zoom, cuadrícula y versión del algoritmo. La fila persiste payload, número de peticiones de proveedor, fechas, estado/error y lease:

- `fresh`: desde la generación hasta 7 días; se devuelve sin proveedor;
- `stale`: desde 7 días hasta antes de 14; se devuelve inmediatamente y se encola una actualización;
- `expired`: desde 14 días; requiere recálculo explícito y no se presenta como reciente;
- fallo global/insuficiente del proveedor: 15 minutos `fresh` y una hora hasta expiración para amortiguar la caída, nunca la ventana normal de siete días.

El refresco stale es `JobRequest.type=marketing_competition_heatmap_refresh`, prioridad baja/background, hasta 4 intentos y namespace del request. `TARGETED_INTEGRATION_JOB_TYPES` y `JOB_HANDLERS` lo registran en el scheduler común. La API obtiene un lease de 30 minutos y usa `enqueueUniqueJobRequest` por `cache_key`; el handler relee identidad/lease y persiste. No se permite `setImmediate`, un cron adicional ni continuar trabajo no auditable después de responder. Reinicios, reintentos, backoff y recuperación pertenecen a `JobRequests`.

`GET /competition` continúa siendo una lectura pasiva de datos persistidos y nunca llama al proveedor. El componente inicia después, de forma separada, el bootstrap autorizado de sugerencias y `local-heatmap`; no debe confundirse con una llamada externa oculta dentro del agregado. Si el heatmap responde `pending`, el frontend hace como máximo cinco comprobaciones con backoff `4/7/12/20/30` segundos; después deja que el job durable continúe y evita polling permanente. `cache.refresh_available` no se deduce solo de que el estado sea distinto de `fresh`: con proveedor/gate contractual bloqueado debe ser `false`, sin `JobRequest`, polling ni llamada externa.

El refresco manual de competidores sigue el mismo principio: `POST /api/marketing/reports/competition/refresh` no llama a Meta/Google ni ejecuta navegador dentro de la petición. Encola/deduplica un `JobRequest.type=competition_refresh` con el scope y los competidores seleccionados, dispara al worker del namespace y responde `202`; el job semanal y el disparo manual comparten handler, auditoría, reintentos y recuperación.

El alta desde descubrimiento también debe hidratarse por esa misma ruta durable. `POST /api/marketing/reports/competition/competitors` persiste primero la identidad/payload ligero de Text Search y después encola un `competition_refresh` de prioridad `low` para ese `competitor_id`; nunca consulta detalles, Meta ni Ads Transparency dentro de la petición HTTP. La deduplicación usa `competition:competitor:<id>` para que una tanda no pierda ids al reutilizar el primer job y la lane background procesa los trabajos secuencialmente. La respuesta `201` incluye `hydration.status`, `hydration.queued`, `hydration.alreadyQueued` y `hydration.jobRequestId`; la fila refleja `last_sync_status=queued`. Si falla el alta del JobRequest, el competidor se conserva con `last_sync_status=queue_error`, el error queda visible y un reintento no fabrica una segunda identidad. El catálogo marca `attachJobRequestId=true` y `executeCompetitionSync` enlaza `JobRequests.sync_log_id` al iniciar, por lo que estado, intentos, error y reporte de proveedores quedan navegables desde el mismo trabajo. El worker actualiza ficha/snapshots/ads y `SyncLogs` con el mismo ejecutor del refresco manual y semanal: no existe cron, promesa huérfana ni proveedor paralelo.

Diagnóstico real previo al arreglo en Badalona (`clinica_id=58`, 2026-07-15): nueve competidores `50..58` tenían solo el payload Pro de sugerencias (dirección/categoría, sin teléfono, web, rating ni reseñas), nueve snapshots ligeros, cero `MarketingCompetitorAdSnapshots`, `last_sync_status=created` y ningún `JobRequest competition_refresh` de ese scope. Esto demuestra que el proveedor no había fallado: nunca se había solicitado la fase de enriquecimiento.

La recuperación controlada se hizo sin borrar ni recrear competidores: `JobRequest #29542` procesó los nueve al primer intento en la lane `dev`; `SyncLog #66072` cerró `processed=9`, `completed=9`, `partial=0`, y quedaron rating/reseñas/teléfono enriquecidos más 18 snapshots publicitarios (Meta + Google) para los ids `50..58`.

Para controlar coste/abuso:

- término normalizado, con máximo de 160 caracteres por defecto;
- hasta 12 identidades nuevas por clínica y hora y 60 filas activas por clínica por defecto; una identidad ya cacheada no consume un alta nueva;
- matriz/profundidad acotadas y concurrencia baja;
- umbral de al menos el 80 % de puntos válidos o el mínimo configurado antes de considerar el resultado una medición normal; con la cuadrícula por defecto se requieren 20 de 25;
- `system_data_cleanup` elimina filas expiradas antiguas y versiones de algoritmo obsoletas;
- añadir/editar/eliminar competidores no recalcula el mapa ni invalida silenciosamente la última medición.

La detección best-effort de redes desde la web de un competidor también debe usar el helper de destino HTTP seguro: esquema público, resolución DNS validada/pinneada, redirects manuales revalidados, `proxy=false`, límite de tamaño y timeout. No se debe volver a hacer `axios.get(website_url)` directamente porque abriría SSRF mediante URL/redirect/DNS.

Migraciones de este corte, con autorización separada (no ejecutar
`db:migrate` en lote). Estado real a 2026-07-15:

1. `20260715150000-create-marketing-competition-heatmap-cache.js`: **aplicada**;
2. `20260715151000-dedupe-business-profile-daily-metrics.js`: **aplicada**;
3. `20260715151500-enable-multiple-oauth-connections.js`: **aplicada** después
   de publicar el runtime multi-conexión en backend y gateway y pausar
   `connect`/`callback`;
4. `20260715152000-purge-google-places-competition-content.js`: **cancelada y
   convertida en no-op** el 2026-07-17. La propuesta original era irreversible
   y contradecía el modelo de descubrimiento autorizado. Se conserva el nombre
   para que Sequelize pueda registrarla como aplicada sin borrar datos ni
   bloquear migraciones posteriores.

Preflight histórico del 2026-07-15: competencia conservaba `49` filas totales, `48` que habría afectado la purga, y `69` snapshots totales, `68` afectados; solo `raw_place_payload` ocupaba `433.290 bytes` en competidores y `raw_payload` otros `615.780 bytes` en snapshots. Tras `1510`, GBP quedó en `22.077` filas, cero subtipos `NULL` y cero grupos duplicados. Esos conteos explican el riesgo que se evitó; ya no describen una operación pendiente. La `1520` no contiene SQL destructivo y un `db:migrate` general solo la registra como no-op.

Referencias normativas: [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies), [Google Maps Platform EEA Terms](https://cloud.google.com/terms/maps-platform/eea), [EEA Places permitted uses](https://cloud.google.com/terms/maps-platform/eea-places-api-permitted-uses) y [Static Maps caching FAQ](https://developers.google.com/maps/faq#can-i-generate-a-map-image-using-the-maps-static-api-which-i-store-and-serve-from-my-website).

Regresiones mínimas: `business_profile_local.test.js`, `marketing_competition_heatmap_cache.test.js`, `marketing_competition_suggestions_efficiency.test.js`, `marketing_competitor_hydration_queue.test.js`, `marketing_report_lead_attribution.test.js`, `marketing_report_effective_assets.test.js`, `scheduled_jobs_orchestration.test.js` y `access_policy.test.js`.

## 2026-07-14 - Corte desplegado: jobs unificados, outbox de intake, Consent v5 y `connect_only`

Release funcional staging: backend `9b82958`, promovido desde dev `ac994a0`; frontend `3c4593ae`, promovido desde dev `667c6a73` —cambio funcional `f9266f0a`—, build `8ca8e450c563e9ee`. Propdental continúa en `connect_only`; Piloto automático no está activo.

> **Nota de inventario vigente 2026-07-19:** los conteos `30/6/48` de esta
> sección se conservan como evidencia del cutover del 14 de julio. El runtime
> vigente registra **33 tareas periódicas**, **14 integraciones
> dirigidas/background**, **47 tipos background** y **63 handlers**, incluidos
> `marketing_web_publication_health_monitor` y
> `web_intake_runtime_reconcile`; todos siguen materializados en
> `JobRequest`, sin cron de negocio lateral.

### Orquestación periódica única

`SCHEDULED_JOB_DEFINITIONS` contiene 30 tareas periódicas. Las seis nuevas son `system_pm2_log_retention` y cinco bridges OPS (`ops_global_discovery`, `ops_summary`, `ops_google_business_profile_daily`, `ops_search_console_daily`, `ops_google_business_profile_requested`). `node-cron` solo crea `JobRequest`; el worker durable ejecuta, reintenta, recupera y audita. Los bridges conservan `UTC`. `OPS_INTERNAL_API_TOKEN` es obligatorio y nunca se registra.

El inventario de aquel cutover contenía 48 handlers. El runtime vigente tiene
63; la nota superior es la fuente vigente. Las 6 integraciones
dirigidas/background de aquel corte eran `meta_ads_backfill_for_sites`,
`web_backfill_for_sites`, `analytics_backfill_properties`,
`business_profile_backfill_locations`, `whatsapp_template_sync_delayed` y
`marketing_competition_heatmap_refresh`. También
`automation_whatsapp_quiet_send` e `intake_quickchat_summary_materialize` usan
`JobRequest`. Las esperas persisten `waiting + next_run_at`, deduplican y releen
el activo al vencer sin guardar teléfono, texto ni token. BullMQ recibe
únicamente transporte inmediato.

El runner OPS usa allowlist, cola de salida de 64 KiB, timeout de tres horas y terminación ordenada. El alta programada y la manual fusionan `definition.payloadDefaults` antes del payload explícito. `#23670`, invocado sin payload, persistió `onlyRequested=true`, namespace `staging` y terminó al primer intento: prueba que el default de seguridad no depende del caller.

**Cutover cerrado:** `pm2-back-staging` tiene `JOBS_CRON_LEADER=true` y `JOBS_WORKER_ENABLED=true` y registró las 30 tareas. Las cinco líneas OPS se retiraron del crontab de `ubuntu`; root tampoco contiene tareas de aplicación. Evidencia: `#23664` discovery completó; `#23665` summary falló y detectó la colisión; `#23666` GBP diario y `#23667` Search Console completaron; `#23668` requested completó; `#23669` summary completó tras el fix de identidad; `#23670` requested sin payload completó.

La auditoría del host no encontró timers systemd de ClinicaClick/OPS, jobs `at` ni `cron_restart` PM2. La programación de negocio queda en `JobRequest`; BullMQ se limita a transportes inmediatos.

La identidad OPS resuelve primero `source_platform + external_id` y tolera diferencias de nombre/mayúsculas/acentos. El interno `448`/externo `55`, sin activos locales, quedó archivado como `Propdental Sant Martí (histórica 55)`; el `449`/`56` permanece activo/canónico con su ubicación. No se borró histórico ni se tocaron leads o reseñas CRM.

Retención PM2: `#23671` dry-run estimó 22 ficheros/35.049.980.564 bytes a eliminar y 8/20.773.812.184 a rotar, sin escribir. `#23672` real completó al primer intento en 271 s: rotó 8 activos de 20.773.830.159 a 1.395.219.608 bytes, eliminó los 22 caducados y dejó 8 logs activos, 8 `.gz`, cero raw/tmp/>60d, directorio ~1,3 GiB, 224 GiB libres y 4 procesos online. Se retiró `/etc/logrotate.d/clinicaclick-ops-bridges`. `SyncLogs` conserva su retención funcional separada.

### Consent v5 y conversión

La UI/runtime desplegada usa `google_ads_user_data_marketing_v5`, hash `f3f260f0508bb2dd842e4b7616b45333048ba7b64b831245714ac53a161a8b4a` y el texto DPO exacto. Marketing es la elección publicitaria visible; antes de decidir las señales están denegadas y `Aceptar todo` concede `ad_user_data` + `ad_personalization`. El backend solo transporta identificadores normalizados/hasheados con consentimiento/readiness. Nunca transporta texto libre, tratamientos, motivos periciales/legales, diagnósticos ni notas clínicas.

Evidencia read-only sin PII: `LeadIntake #7184`, Nou Barris y Google Ads, originó el intento `#7`, `SUCCESS` por GCLID con consentimiento concedido pero `user_identifier_count=0`; fue offline click-only, no Enhanced por identificadores. `#7194` originó el intento `#11`, `skipped` con `consent_not_granted`. Ambos conservan estado CRM `nuevo`; su contenido de consulta solo sirve para triage humano. Un interés estético se valida contra catálogo/capacidad y una solicitud pericial se deriva al equipo correspondiente; `qualified_lead` exige contacto real, respuesta e interés verificado, y `schedule` exige cita vinculada.

Al pasar un lead a `descartado`, `PATCH /api/intake/leads/:id` exige `motivo_descarte`, lo persiste y lo incluye en `LeadAttributionAudit.raw_payload`. El frontend incorpora `tratamiento_no_ofrecido` y `consulta_no_asistencial` como dos opciones de feedback: el primero requiere confirmar que el servicio no se presta ni deriva; el segundo requiere confirmar que no existe circuito asistencial/interno adecuado. No son un enum cerrado del backend: el campo `STRING(512)` admite otros motivos estructurados y notas. Este dato puede alimentar diagnóstico/recomendaciones, pero nunca se transporta a Google/Meta como contenido del paciente.

El fix de `effectiveMarketingAssets` preserva `user_data_enabled`, `enhanced_conversions`, `phone_country_code`, `value`, `consent` y `user_properties` en top-level, evento y destino; el readback devuelve user data activo en ambas cuentas. Los leads `#7200/#7202/#7203` fueron previos al fix y no acreditan identificadores. La prueba controlada `#22` acreditó normalización/transporte, no atribución. El cierre natural posterior sí existe en `1851215478`: los intentos `#25/#26/#27/#28/#30/#32/#33` terminaron `succeeded/SUCCESS`, con consentimiento, `user_data_sent=true` y `[email, phone]`. `5992356722` pasa `validateOnly`, pero todavía no tiene un terminal natural postmigración; esa cuenta no se presenta como E2E cerrada.

### Capacidad de personal

`team.view` protege ruta, menú y lecturas de `/personal`; `team.manage` protege mutaciones de terceros; `team.schedule.self.manage` protege exclusivamente el horario y las ausencias propias. Los roles normalizados propietario/doctor/assistant/reception/admin_staff heredan lectura y la capacidad propia; `agencia` y `unknown` no. Por defecto `reception` y `admin_staff` heredan también `clinic.settings.edit` y `team.manage`, por lo que pueden gestionar configuración operativa de clínica, instalaciones, tratamientos, personal y horarios dentro de su ámbito. El backend de horarios y personal consulta la capacidad efectiva, no una allowlist `propietario/agencia`; seleccionar una clínica nunca eleva a agencia.

#### Clínicas operativas del profesional frente a clínicas autorizadas del actor

Los endpoints de horarios separan dos conjuntos que no son intercambiables:

- **Clínicas objetivo del profesional:** se resuelven desde sus membresías operativas. Incluyen membresías aceptadas y también `estado_invitacion='pendiente'` cuando `Usuarios.es_provisional=true`, porque un provisional creado por la clínica debe poder recibir horarios y citas antes de reclamar su cuenta. Una invitación pendiente de un usuario existente no entra en este conjunto.
- **Clínicas autorizadas del actor:** se resuelven con las capacidades y membresías aceptadas del usuario que realiza la petición. Un actor no administrador solo puede consultar o modificar la intersección entre sus clínicas autorizadas y las clínicas operativas del profesional objetivo; el administrador global puede operar sobre todas las clínicas objetivo.

No se debe reutilizar la consulta de acceso del actor para descubrir las clínicas del profesional objetivo: esa consulta excluye correctamente invitaciones pendientes y volvería a ocultar a los provisionales del Gantt. La creación provisional de un perfil con capacidad de agenda debe dejar además su `DoctorClinica` activo. `estado_invitacion='pendiente'` controla la reclamación y el acceso propio, no la disponibilidad operativa de la cuenta provisional para la clínica.

Implementación de referencia: `getOperationalStaffClinicIdsForUser()` obtiene las clínicas objetivo y `getAllowedClinicIdsForActorTarget()` aplica la autorización del actor. Regresión mínima: `node --test src/scripts/tests/personal_provisional_schedule_access.test.js`.

### Contrato comercial

En aquel corte `connect_only` se mostraba como **Conecta y mejora**; su nombre
canónico actual es **Mide y entiende**. Conecta cuentas, importa/unifica leads,
atribuye el ciclo, envía conversiones consentidas mejoradas/offline y genera
diagnósticos/recomendaciones. No modifica campañas, custom goals, pujas,
presupuesto o estados. Piloto automático es una orden `managed_service`
separada y aprobada.

Chromium live confirmó Consent v5 móvil, chat esperando seis segundos después del consentimiento, Leads/Campañas/Personal/Agenda y la corrección del `400`: solo se llamó `/api/marketing/bulk-sends/campaigns?scope=group:5&context=mass_sends`, con `200` y sin request sin scope. Meta Francia continúa sin cuenta publicitaria/píxel configurados. `Conseguir más reseñas` está cerrado/listo.

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
| `JOBS_WORKER_ENABLED` | `true` en exactamente un proceso por `JOB_RUNTIME_NAMESPACE`; `false` en cualquier réplica adicional y en gateway |
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
- Debe existir **un único proceso con `JOBS_WORKER_ENABLED=true` por namespace**. El reset de `running` al arrancar presupone este contrato; levantar dos workers con el mismo namespace no es una topología HA soportada.

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

## 2026-07-02 - Panel principal agregado

Endpoint real:

| Endpoint | Estado | Uso |
|:---|:---|:---|
| `GET /api/paneles/main` | Operativo V1 | Contrato agregado para `/panel-principal` por rol, clínica y fecha. |

Reglas:

- El panel se sirve desde backend; el frontend no debe recomponerlo con llamadas paralelas a agenda, leads, consentimientos o reseñas.
- El servicio `panelesDashboard.service.js` evita `include`/left joins para el contrato del panel: consulta tablas base y enriquece en memoria por mapas de IDs.
- `todayAppointments` usa rango de día completo y excluye citas canceladas/reprogramadas, citas ya cerradas como `completada`/`no_asistio` y citas abiertas cuyo `fin` ya pasó, porque el bloque operativo representa "citas que esperamos hoy". `doctorAppointmentsToday` conserva la agenda del doctor con el estado de cada cita del día. `pastAttendancePending` devuelve citas ya finalizadas sin asistencia cerrada para que la UI pregunte si acudió.
- Las acciones de asistencia siguen usando el endpoint canónico `PATCH /api/citas/:id/estado`.
- Desde 2026-07-04 la respuesta incluye `setup` para primeros pasos generales, `criticalAlerts` para bloqueos técnicos, `growthOpportunities` para crecimiento y `meta.generatedAt` para mostrar la última actualización.
- Desde 2026-07-04 la respuesta incluye `nextAppointments` para que el frontend explique estados vacíos de "citas de hoy" sin recomponer agenda en Angular. Se calcula en backend con la misma tabla base `CitasPacientes` y excluye canceladas/reprogramadas.
- Desde 2026-07-06 `tasks.items` incluye `pending_attendance` cuando hay citas pasadas pendientes de cerrar asistencia, y `tasks.total` se calcula en backend sobre todos los items devueltos.
- Desde 2026-07-06 el payload se recorta por rol: doctores reciben solo `doctorAppointmentsToday`, `doctorPendingConsents` y `weeklySchedule`; las citas/tareas operativas de clínica y `setup` solo se devuelven cuando `sections.showOperations`/`sections.showSetup` lo indica.
- Desde 2026-07-07 el recorte por rol y clínica no confía en `role`/`subrol` enviados por query: el backend deriva rol/subrol desde sesión y `UsuarioClinica`, filtra `clinica_id` contra las clínicas asignadas al usuario y el admin global queda como `administrador`. Si se pide una clínica fuera de scope devuelve `403 panel_scope_forbidden`.
- Desde 2026-07-07 la respuesta incluye `rolePresentation` (`mode`, `eyebrow`, `title`, `subtitle`, `icon`, acción opcional) para que el frontend pinte la narrativa del panel por rol sin inferirla ni recomponer datos. `paciente` y `laboratorio` reciben `mode=restricted` y no ven bloques operativos internos.
- Desde 2026-07-07 la respuesta incluye `unansweredReviews` para roles operativos: lista acotada de reseñas de Google sin respuesta con autor, puntuación, comentario, clínica, paciente conciliado si existe, enlace interno filtrado a `Marketing > Perfil Google` y URL externa de Google cuando está disponible. El frontend no debe llamar a `/api/local/clinica/:id/reviews` desde el panel principal para recomponer este bloque.
- Desde 2026-07-16 el panel aplica capacidades por clínica antes de consultar cualquier colección con identidad. Agencia recibe contexto de Marketing/atribución, pero no `todayAppointments`, próximas/pasadas, pacientes, consentimientos, tareas clínicas, reseñas conciliadas ni setup operativo. `roleSections()` no trata agencia como owner/operations y un scope válido de Marketing no abre datos del dashboard.
- El feedback positivo de ejemplo no se devuelve; cuando se reactive debe venir como señal real atribuible a ClinicaClick.
- Desde 2026-07-23 la narrativa owner/operaciones no mezcla "primeros pasos" en la tarjeta principal; el setup ya viaja como bloque separado y el `subtitle` se centra en agenda, asistencia, consentimientos y oportunidades.

## Control de acceso por capacidades

Endpoint real:

| Endpoint | Estado | Uso |
|:---|:---|:---|
| `GET /api/access-policies/catalog` | Operativo V1 | Devuelve el catálogo backend de roles, capacidades y defaults base. |
| `GET /api/access-policies/overrides` | Operativo V1 | Lista overrides accesibles para el usuario autenticado. |
| `GET /api/access-policies/assignments` | Operativo V1 | Devuelve usuarios afectados por rol/subrol en un ámbito de clínica o grupo. |
| `PUT /api/access-policies/overrides` | Operativo V1 | Crea, actualiza o elimina (`state=inherit`) un override por ámbito, capacidad y rol operativo. |

Contrato:

- `scope_type`: `group` o `clinic`.
- `scope_id`: ID del grupo o clínica.
- `feature_key`: `marketing`, `clinic.settings.view`, `clinic.settings.edit`, `team.view`, `team.manage`, `team.schedule.self.manage`, `billing.reports.view`, `patients.view`, `patients.sensitive.view`, `patients.edit`, `leads.sensitive.view`, `leads.manage`, `appointments.view`, `appointments.manage`, `consents.view`, `consents.manage`, `quickchat.read_patients`, `quickchat.read_team`, `quickchat.read_leads`, `nutrition.workspace.view`, `nutrition.measurements.create`, `nutrition.reports.finalize`.
- `role_code`: `propietario`, `agencia`, `doctor`, `assistant`, `reception`, `admin_staff` o `unknown`.
- `effect`: `allow` o `deny`; `state=inherit` borra el override.

Reglas:

- El catálogo de defaults vive en `src/lib/access-policy.js` y se expone por API para que front y backend no definan matrices base divergentes. Angular conserva fallback local, pero debe hidratarse desde `GET /api/access-policies/catalog` cuando el backend responde.
- Cada feature del catálogo expone `kind`: `view` para acceso de vista/módulo, `read` para lectura de conversaciones o datos y `action` para permisos de escritura o gestión. `Ajustes > Control de acceso` usa esa clasificación para enseñar primero los accesos básicos de vista/lectura y después la matriz completa de acciones por rol.
- `administrador` no se persiste como `role_code`; mantiene acceso completo.
- Un administrador puede leer/escribir todos los ámbitos. Un propietario solo puede escribir overrides en sus clínicas/grupos; el resto de staff solo lee sus ámbitos accesibles.
- `GET /api/access-policies/assignments` usa el mismo scope de lectura que `overrides` y agrupa `UsuarioClinica` por `role_code` normalizado. Sirve para que Ajustes muestre qué usuarios reales heredarán cada cambio de la matriz.
- La tabla `AccessPolicyOverrides` usa una clave única por `scope_type`, `scope_id`, `feature_key` y `role_code`.
- Pacientes consume `patients.edit` en mutaciones de ficha: creación, actualización, transferencia de contacto, vinculación a clínica y borrado. En actualización se valida la clínica actual y, si cambia `clinica_id`, también la clínica destino.
- `patients.view` permite listados dentro del scope de clínicas; abrir el detalle exige además `patients.sensitive.view`, que gobierna identidad, contacto, búsqueda identificativa, actividad clínica y adjuntos clínicos generales. Agencia conserva atribución agregada y seudónimos estables en listados de Marketing, pero el detalle de paciente responde `403 patient_detail_forbidden` y nunca recibe PII. Para actores clínicos autorizados, si un paciente está vinculado a varias sedes, clínica principal visible, vínculos, citas anterior/siguiente, actividad de citas/reseñas y nutrición se reducen a las clínicas efectivamente legibles. La tabla legacy `PacienteConsentimientos` no tiene `clinic_id`: con acceso parcial al paciente el endpoint legacy se bloquea, porque no existe un filtro seguro por sede.
- Leads separa lectura de Marketing de datos personales: `leads.sensitive.view` habilita PII y conversación; `leads.manage` habilita cambios operativos y exige además lectura sensible. Agencia puede trabajar con fuente, campaña, estado y métricas seudonimizadas, pero no con nombre, teléfono, correo, notas, click IDs ni URLs de formularios. Los sockets de clínica tampoco se suscriben si faltan las capacidades sensibles de pacientes/leads.
- Agenda separa lectura y escritura: `appointments.view` permite abrir la vista de agenda en frontend; `appointments.manage` se reserva para mutaciones reales de cita (`POST /api/citas`, `PATCH /api/citas/:id/estado`, `PATCH /api/citas/:id/nota` y `PATCH /api/citas/:id/reagendar`). Las lecturas de agenda quedan fuera de este permiso de escritura.
- Personal separa lectura y gestión: `team.view` permite abrir/listar personal y horarios; `team.manage` protege mutaciones sobre terceros; `team.schedule.self.manage` autoriza solo horario y ausencias propias. Esta última es `false` para agencia y `unknown`, por lo que una membresía de Marketing no activa las rutas `/personal/me`. Los endpoints de invitaciones, horarios, bloqueos y excepciones de terceros aceptan propietario/admin global, default efectivo de `team.manage` para `reception`/`admin_staff`, u override efectivo de `team.manage` para la clínica.
- Nutrición consume estos permisos en backend: `nutrition.workspace.view` protege la ficha, informes HTML y PDF; `nutrition.measurements.create` protege alta de mediciones y snapshots persistidos, siempre junto a `nutrition.workspace.view`; `nutrition.reports.finalize` protege el cierre de informes como snapshot final. Por defecto propietario y doctor pueden cerrar informes; auxiliar puede registrar mediciones pero no cerrar informes salvo override.
- Consentimientos separa lectura y gestión: `consents.view` permite abrir `/consentimientos`, listar plantillas/documentos pendientes y abrir/descargar PDFs de consentimiento (`consent_document_pdf`) en adjuntos clínicos. `consents.manage` protege las mutaciones privadas principales: crear/editar plantillas clínicas, vincular requisitos, generar paquetes, enviar a firma, preparar tablet, firma profesional y revocación. Las rutas públicas/tablet mantienen su token propio.
- QuickChat consume `quickchat.read_patients`, `quickchat.read_team` y `quickchat.read_leads` en `GET /api/conversations/permissions` para mostrar u ocultar pestañas según el scope activo y aplica esas mismas capacidades como ACL real de categoría en listado, contador de no leídos, lectura de mensajes, media, marcado como leído, envío y chat interno. Pacientes exige `read_patients`; equipo exige `read_team`; leads/contactos externos sin paciente exigen `read_leads`.

### Escenarios operativos de aceptación de roles (2026-07-16)

| Actor | Permitido por defecto | Límites autoritativos |
|:---|:---|:---|
| `reception` / `admin_staff` | Configuración operativa (`clinic.settings.edit`), instalaciones, tratamientos, personal/horarios (`team.manage`), leads identificados (`leads.sensitive.view` + `leads.manage`) y creación/reprogramación de citas (`appointments.manage`) dentro de sus clínicas. | No pueden operar fuera de `UsuarioClinica`. `team.manage` no permite asignar, modificar ni eliminar propietarios. |
| `agencia` | Marketing, conexiones publicitarias, atribución y métricas seudonimizadas del scope Propdental concedido. `patients.view` solo sostiene proyecciones seudonimizadas. | Denegados por defecto y en el contrato entregado: `clinic.settings.*`, `team.*`, PII/actividad/adjuntos, Chat/Registro, citas, consentimientos, QuickChat, Nutrición, dashboard operativo y fusiones. Cualquier ampliación futura requeriría una decisión de política y QA explícitos; no nace del rol ni de seleccionar clínica. |
| `propietario` / doctor | Operación e informes de sus clínicas asignadas; puede mantener su doble condición funcional sin convertirse en admin global. | La clínica pedida se intersecta siempre con sus asignaciones. El escenario de QA de Darío debe mostrar solo las sedes Propdental que tenga asignadas y nunca clínicas ajenas ni actividad de otra sede de un paciente compartido. |

La cita desde un lead combina dos controles, no uno: el lead debe ser legible y gestionable (`leads.sensitive.view` + `leads.manage`) y la clínica destino debe permitir `appointments.manage`. Del mismo modo, crear/editar instalaciones exige `clinic.settings.edit`; invitar, editar o desvincular personal no propietario exige `team.manage`. Tener acceso visual a Marketing o Agenda no sustituye esas acciones.

Los recursos de grupo aplican cobertura total: para leer o mutar un recurso que afecta a varias clínicas, el actor debe estar autorizado en **todas** las clínicas afectadas o ser admin global. Ser propietario/staff de una sola sede no habilita eliminar un grupo, editar asignaciones o aplicar una operación group-wide. El mismo principio se usa en `/api/personal/fusionar`: exige `team.manage` en todas las clínicas de ambas cuentas; si alguna membresía es propietaria, solo admin global.

Las membresías de propietario tienen una barrera independiente del catálogo de capacidades. `src/controllers/personal.controller.js` responde `owner_membership_manage_forbidden` al intentar asignar/cambiar una membresía de propietario sin autoridad y `owner_unlink_forbidden` al intentar desvincularla. Esta protección no se debe rebajar para habilitar a recepción: la vía correcta es conservar `team.manage` para doctores/personal ordinario. El frontend refleja el bloqueo, pero backend sigue siendo la autoridad. Tras añadir los gates legítimos `/personal -> team.view` y `/personal/me -> team.schedule.self.manage`, el SHA-256 esperado del controller es `776da1bf46ca128e08c2f215f64c7dd48dd6615859c96cb75a5b4e8a7ba75b30`; el cambio de hash respecto al baseline no es una reversión de los dos errores owner. Los tres bloques de protección de propietario conservan procedencia en `455a9050`.

En privacidad de agencia, los seudónimos son estables por ID local (`Paciente #XXXXXX` / `Lead #XXXXXX`) para poder seguir métricas sin revelar identidad. La redacción elimina contacto, PII clínica, notas, click IDs, URLs/referrer, campos de formulario, coincidencia con paciente, citas enlazadas y conversación. `GET /api/intake/leads/:id/activity` devuelve `403 lead_sensitive_forbidden`; las mutaciones devuelven `403 lead_manage_forbidden`. Los sockets emiten solo IDs, scope, canal, estado y timestamps y la suscripción a rooms sensibles se deniega si faltan capacidades.

Para pacientes vinculados a varias sedes, autorizar una sede no abre el paciente global: clínica principal/vínculos, citas anterior-siguiente, actividad de citas/reseñas, nutrición y adjuntos se filtran por `readableClinicIds`. El endpoint legacy de consentimientos exige acceso a todas las clínicas del paciente porque `PacienteConsentimientos` carece de `clinic_id`; si no puede filtrarse con seguridad, falla cerrado.

## Workspace Nutricion / antropometria

Endpoints reales:

| Endpoint | Estado | Uso |
|:---|:---|:---|
| `GET /api/pacientes/:id/nutrition-workspace` | Operativo V1 dev | Devuelve perfiles rapido/express, campos, tratamientos de Nutricion, mediciones, evolucion, proyeccion e informes derivados. |
| `POST /api/pacientes/:id/nutrition-measurements` | Operativo V1 dev | Registra una medicion nutricional real del paciente y calcula resultados versionados. |
| `POST /api/pacientes/:id/nutrition-measurements/:measurementId/report/finalize` | Operativo V1 dev | Cierra el snapshot del informe como `final`, supersede borradores activos y bloquea la regeneracion accidental de ese documento. |
| `GET /api/pacientes/:id/nutrition-measurements/:measurementId/report/render` | Operativo V1 dev | Renderiza el informe HTML imprimible de una medicion. |
| `GET /api/pacientes/:id/nutrition-measurements/:measurementId/report/pdf` | Operativo V1 dev | Genera el PDF con Chromium headless; si el informe es `final`, cachea/reutiliza un asset clinico privado. |
| `GET /api/pacientes/:id/nutrition-measurements/:measurementId/photos` | Operativo V1 dev | Lista metadata de fotos clinicas privadas de una medicion. |
| `POST /api/pacientes/:id/nutrition-measurements/:measurementId/photos` | Operativo V1 dev | Guarda una foto clinica privada en `ClinicalPrivateAssets`, vinculada a la medicion. |
| `GET /api/pacientes/:id/nutrition-measurements/:measurementId/photos/:photoId` | Operativo V1 dev | Sirve una foto clinica privada por endpoint autenticado, sin URL publica. |
| `GET /api/pacientes/:id/clinical-attachments` | Operativo V1 dev | Lista assets clinicos privados del paciente desde `ClinicalPrivateAssets`, filtrados por permiso y proposito. |
| `POST /api/pacientes/:id/clinical-attachments` | Operativo V1 dev | Sube un adjunto clinico privado general en JSON base64 (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`), con `patients.edit`, categoria `pruebas`/`informes`/`otros` y asociacion opcional a `appointment_id`. |
| `GET /api/pacientes/:id/clinical-attachments/:attachmentId` | Operativo V1 dev | Sirve un asset clinico privado por `public_id` o `id`, con `Cache-Control: private, no-store` y sin URL publica. |
| `GET /api/pacientes/:id/activity` | Operativo V1 dev | Incluye eventos `nutrition_report_finalized` para informes finales de Nutricion cuando el rol puede ver `nutrition.workspace.view`. |
| `GET /api/especialidades/area-contracts` | Operativo V1 dev | Requiere autenticacion. Devuelve contrato versionado por area medica para catalogo, agenda y ficha clinica: perfil de tratamiento, ejemplos de servicio, asistente de alta, resumen de flujo, protocolos, accion clinica de agenda y opciones/schemas especificos de Nutricion. |
| `GET /api/especialidades/area-contracts/:code` | Operativo V1 dev | Requiere autenticacion. Devuelve el contrato de un area concreta con fallback `general`. |
| `PUT /api/especialidades/area-contracts/:code` | Operativo V1 dev | Requiere autenticacion y admin global. Persiste override del contrato de un area medica en `MedicalAreaContracts` manteniendo fallback al contrato base. |

Contrato:

- `Tratamientos.clinical_config` guarda configuracion clinica por area. Para Nutricion se usa `clinical_config.nutrition.service_kind` (`consultation`, `follow_up`, `quick_measurement`, `isak_study`, `nutrition_plan_pack`) y `clinical_config.nutrition.measurement_profile_code` con `none`, `quick` o `express_isak`.
- `Tratamientos.clinical_config.appointment_type_prices` puede guardar overrides opcionales de precio por tipo de cita con claves `primera_con_trat`, `continuacion`, `revision` y `urgencia`. Agenda usa ese importe como propuesta visual cuando existe; si falta, usa `Tratamientos.precio_base`. No aplica a `primera_sin_trat` porque no hay tratamiento/servicio asociado.
- `Tratamientos.clinical_config.financing.enabled = true` marca que el servicio puede aparecer en plantillas de presupuesto financiado. No contiene tipos de interes ni condiciones de financieras; esos datos pertenecen a la clinica.
- `Clinicas.configuracion.financing_settings` guarda financieras manuales por clinica: proveedores, plazos, gastos de apertura, interes nominal, TAE, importes minimo/maximo, documentacion requerida y condiciones visibles. No hay integracion externa ni aprobacion automatica; el backend solo persiste condiciones para que presupuesto/facturacion las consuman.
- El contrato de area medica se sirve desde backend como `medical-area-contracts-v1`. La tabla `MedicalAreaContracts` permite overrides por `code`; si no hay override o la tabla aun no existe en un runtime, el servicio vuelve al contrato base estatico. El front conserva fallback local para tolerar runtimes sin endpoint. El contrato incluye `patient_workspace` para indicar si un area activa debe abrir una pestaña clinica propia en ficha de paciente; Nutricion activa `nutricion` y Capilar deja `capilar` definido pero desactivado hasta crear el workspace real. Tambien incluye `appointment_action` para que agenda lea etiqueta, detalle, icono, ruta y si requiere perfil clinico desde backend en vez de hardcodearla en Angular. Desde 2026-07-06 incluye `protocol_rules`: reglas estructuradas con origen, destino, espera minima, condicion, accion y alcance; desde 2026-07-22 la UI los presenta como "Protocolos del area" y oculta ids/rutas en opciones avanzadas.
- En Nutricion, cada `nutrition_service_kind_options` incluye defaults operativos para el alta de tratamiento: `recommendedName`, `defaultCategory`, `recommendedProfile`, `defaultGenerateReport`, `defaultComparePrevious` y `defaultSessions`. Los overrides parciales de `MedicalAreaContracts` se normalizan por `value` contra el contrato base para no perder defaults ni borrar otras opciones de servicio.
- Nutricion declara en ese contrato `nutrition_measurement_profile_options`, `nutrition_measurement_profile_schemas` y `nutrition_measurement_fields`. Cada grupo de schema puede declarar `required_fields`: el normalizador los reinyecta si un override antiguo o manual intenta quitarlos, porque sostienen calculos como IMC, somatotipo y diametros/perimetros corregidos. El perfil tecnico `express_isak` se muestra como `Completa` e incluye tambien campos avanzados opcionales para Kerr-Ross (`sitting_height_cm`, `head_cm`, perimetros de antebrazo/muslo/torax, diametros biacromial/biiliocrestal y diametros toracicos). El workspace nutricional consume esos campos para devolver `profiles` y `fields`, normalizar `raw_values_json`, validar requeridos/rangos y renderizar informes con labels vigentes. `POST /api/pacientes/:id/nutrition-measurements` rechaza perfiles incompletos con `missing_required_measurement_fields`. Los codigos tecnicos de perfiles/campos permanecen cerrados en esta fase para no romper formulas ni historico; los nombres visibles no deben usar marcas de terceros.
- El contrato base de Nutricion expone ejemplos de servicio cobrable (`Consulta nutricional`, `Valoracion nutricional`, `Seguimiento nutricional`, `Estudio antropometrico completo`, `Plan de seguimiento mensual`) para que el catalogo no empuje a crear tratamientos llamados `Primera cita` o `Revision`.
- Al crear una competencia profesional propia de clinica o añadir una competencia de sistema a una clinica, los endpoints de especialidades devuelven `disciplinas` con la lista actualizada de areas medicas de la clinica, normalizada en minusculas y sin duplicados. El frontend usa esa lista para mostrar areas activas formateadas y no inferir estados intermedios. La UI no debe llamar `disciplina` a este concepto salvo al hablar del campo tecnico.
- `PatientNutritionMeasurements` guarda mediciones por `patient_id`, `clinic_id`, `professional_id`, `appointment_id`, `treatment_id`, `profile_code`, `raw_values_json`, `calculated_values_json`, `formula_version` y `quality_flags_json`.
- El motor `nutrition-basic-v3` calcula en backend IMC, ratio cintura/cadera, suma de pliegues, perimetros corregidos, somatotipo Heath-Carter cuando hay datos suficientes, composicion corporal estimada con ecuacion seleccionable, fraccionamiento Kerr-Ross de cinco componentes cuando esta completo el bloque avanzado y proyeccion lineal simple con las ultimas dos mediciones. Las mediciones historicas pueden conservar `nutrition-basic-v1` o `nutrition-basic-v2` en su snapshot.
- Workspace e informes exponen `calculation_profile=clinicaclick-anthropometry-v3`: la formula guardada por defecto de masa grasa es Durnin-Womersley + Siri, pero `render`/`pdf` aceptan recalculo bajo demanda con Faulkner, Jackson-Pollock 4 sitios, Katch-McArdle, Sloan, Withers, Yuhasz-Carter o Slaughter. Heath-Carter, Kerr-Ross y proyeccion lineal siguen siendo bloques automaticos de calculo/trazabilidad.
- El contrato de workspace e informes incluye `formula_references` con bases publicas/metodologicas usadas por `nutrition-basic-v3` para que el frontend y el HTML/PDF puedan mostrar la trazabilidad de calculo. Incluye IMC, perfil antropometrico completo, somatotipo Heath-Carter, la ecuacion de masa grasa aplicada en ese informe, Kerr-Ross cinco componentes y la proyeccion lineal simple propia.
- Informes V1 se materializan en `PatientNutritionReports` como snapshot JSON/HTML con `snapshot_hash`, `formula_version`, `report_type`, `measurement_id`, `patient_id`, `clinic_id`, `appointment_id` y `treatment_id`. `snapshot_html` debe ser `MEDIUMTEXT`, porque los informes completos embeben CSS e ilustraciones y no caben de forma fiable en `TEXT`. Al crear una medicion se intenta crear automaticamente el snapshot activo; `POST /api/pacientes/:id/nutrition-measurements/:measurementId/report/snapshot` permite materializarlo para mediciones antiguas. `POST /api/pacientes/:id/nutrition-measurements/:measurementId/report/finalize` crea un snapshot `final`, marca los borradores `active` como `superseded` y anota `finalized_by/finalized_at`; render y PDF priorizan siempre `final` sobre `active`. El contrato de workspace/informe expone `clinical_storage` para indicar `clinical_private`, snapshot privado en base de datos y `public_media=false`. Desde `ClinicalPrivateAssets`, el primer PDF solicitado de un informe `final` se cachea como asset clinico privado (`PatientNutritionReports.pdf_asset_id`) y las siguientes descargas leen ese binario privado; los borradores siguen generandose bajo demanda. No usar `PUBLIC_MEDIA` para informes, fotos clinicas ni datos antropometricos identificables.
- `GET /api/pacientes/:id/nutrition-measurements/:measurementId/report/render` y `/report/pdf` aceptan `compare_measurement_id=<measurement_id>` para renderizar HTML/PDF contra una medicion concreta y `compare_measurement_id=none` para generar el documento sin comparativa. Tambien aceptan `fat_mass_equation=<code>` para recalcular masa grasa con otra ecuacion disponible. Cuando se usa comparacion o ecuacion alternativa, el backend renderiza bajo demanda y no reutiliza ni reescribe snapshots finales; asi la UI puede cambiar la comparacion/formula sin romper la inmutabilidad clinica del informe cerrado.
- El HTML/PDF de Nutricion debe ser entendible por paciente no tecnico: fraccionamiento molecular/tisular incluye explicaciones cortas, la distribucion adiposa/muscular diferencia `Actual` y `Comparacion` y la somatocarta mantiene etiquetas y valores separados para evitar solapes. La imagen central de distribucion solo localiza zonas; las barras son la fuente visual de valores. Desde `snapshot_version=15`, las cabeceras visuales no incluyen captions bajo la ilustracion, las imagenes de cabecera se integran sin tarjeta/fondo blanco propio, distribucion usa una cabecera visual consistente, cada tejido muestra su barra debajo del texto propio con ilustracion grande, las siluetas de somatotipo usan fondo transparente sin tarjeta blanca alrededor y las comparativas de un solo grupo ocupan todo el ancho para evitar columnas vacias.
- Los assets visuales estaticos del informe viven en `src/assets/nutrition/images` y se embeben como `data:` dentro del HTML/PDF generado por backend. Son ilustraciones genericas sin dato clinico ni paciente; no van a `PUBLIC_MEDIA`. El video de pliegue subido como referencia queda fuera del informe hasta cerrar una ayuda interactiva especifica de mediciones.
- `GET /api/paneles/main` devuelve `inactiveTodayAppointments` además de `todayAppointments`. `todayAppointments` conserva solo citas activas esperadas y no vencidas; `inactiveTodayAppointments` recoge citas del día cerradas, canceladas o reprogramadas para que el frontend explique estados vacíos sin contarlas como citas esperadas. Las citas abiertas vencidas salen en `pastAttendancePending`.
- Para roles `paciente` y `laboratorio`, `GET /api/paneles/main` no entrega bloques internos de clínica: no carga citas operativas, oportunidades, alertas, errores de configuración ni tareas. El aislamiento se aplica en backend aunque el frontend también oculte esas secciones.
- `ClinicalPrivateAssets` es la tabla base para binarios clinicos privados: PDFs finales cacheados, fotos clinicas de Nutricion y futuros adjuntos de historia. En dev usa provider `local_private` con raiz configurable `CLINICAL_PRIVATE_STORAGE_ROOT` y fallback fuera del checkout (`../clinical-private-storage`). La raiz operativa recomendada en el servidor actual es `/home/ubuntu/.clinicaclick-private`; si se anade un disco dedicado, la raiz recomendada pasa a ser `/mnt/clinicaclick-clinical-private`. En ambos casos el directorio debe tener permisos `700`, los objetos no exponen rutas directas y se sirven solo por backend autenticado. El contrato esta preparado para migrar a S3 privado sin exponer URL publica.
- Estrategia futura de almacenamiento privado y backups:
  - Diferenciar storage operativo y backup. El storage operativo es donde la app lee/escribe a diario desde `ClinicalPrivateAssets`; el backup es una copia cifrada para recuperacion y no debe usarse como disco de trabajo.
  - Fase 0, estado actual: mantener `local_private`, limpiar caches/artefactos tecnicos antes de comprar almacenamiento, no cambiar provider clinico, asegurar permisos `700` en la raiz privada y servir assets solo con permisos de backend. No usar `media.clinicaclick.com` para datos clinicos.
  - Fase 1, si crece el almacenamiento activo: anadir disco dedicado barato en la misma zona de la instancia, montarlo en `/mnt/clinicaclick-clinical-private`, permisos `700`, configurar `CLINICAL_PRIVATE_STORAGE_ROOT=/mnt/clinicaclick-clinical-private` y conservar `ClinicalPrivateAssets` como fuente de metadatos. No exponer rutas de filesystem ni URLs publicas.
  - Fase 2, backups economicos: crear bucket S3 privado y cifrado en region UE, preferiblemente `eu-south-2` si DPO/legal lo aprueba o `eu-west-3` por cercania a la infraestructura actual. Usar SSE-S3 o SSE-KMS si se requiere auditoria/control de claves. Subir backups cifrados de storage clinico, base de datos y documentacion operativa. Aplicar lifecycle: primeros dias/semanas en S3 Standard o Standard-IA; archivo antiguo a Glacier Instant/Flexible segun RTO/RPO acordado. Glacier es backup/archivo, no storage operativo diario.
  - Fase 3, evolucion futura: implementar provider S3 privado para `ClinicalPrivateAssets` solo cuando el volumen lo justifique. Acceso siempre por backend autenticado, URLs prefirmadas muy cortas o streaming backend, auditoria de acceso por usuario, clinica, paciente, asset, accion, fecha, IP/contexto y revision DPO/legal antes de produccion clinica real.
  - Costes orientativos a documentar en decisiones: disco Lightsail attached disk alrededor de `0.10 USD/GB-mes`; S3 Standard UE alrededor de `0.023-0.024 USD/GB-mes`; S3 Standard-IA alrededor de `0.0125-0.0131 USD/GB-mes`; Glacier/archivo es mas barato pero solo para backup/archivo.
  - Regla critica: `PUBLIC_MEDIA`/CloudFront es solo para assets publicos como logos, marketing, fotos publicas autorizadas de equipo, frontend o imagenes publicas de WhatsApp. Nunca RX, consentimientos, informes, audios, fotos clinicas, STL, documentos de laboratorio, facturas identificables ni datos de paciente en `PUBLIC_MEDIA`.
- Importaciones reales 2026-07-23: los exports originales deben entrar fuera de
  los repositorios, por ejemplo
  `/home/ubuntu/secure-imports/clinic-real-20260723/incoming/`, con backups en
  `db-backups/` y payloads revisables/pseudonimizados en `review/`. Los
  importadores deben escribir adjuntos en `ClinicalPrivateAssets` con
  `purpose=clinical_attachment` salvo purpose clinico mas especifico, incluir
  `metadata.source_batch`/origen, no poner PII en `object_key`, `public_id`,
  rutas o nombres de carpeta, y exponerlos solo por endpoints autenticados con
  `Cache-Control: private, no-store`. Nunca mover PDFs, fotos clinicas,
  consentimientos, informes, facturas identificables ni documentos de paciente
  a `PUBLIC_MEDIA`.
- Import ClinicCloud BS Medical 2026-07-26/27: el lote real usa
  `source_batch=cliniccloud_bsmedical_real_20260726`. Las citas importadas
  mantienen `source_system='cliniccloud'` para que automatizaciones y
  recordatorios no se disparen retroactivamente. El backfill
  `src/scripts/cliniccloud_backfill_agenda_resources.js` crea/reutiliza
  profesionales o recursos provisionales a partir de `agenda_1.csv`, crea
  instalaciones para cabinas/recursos y enlaza todas las citas por
  `doctor_id`/`instalacion_id` sin borrar datos originales. Batch del backfill:
  `cliniccloud_bsmedical_real_20260726_agenda_resources_v1`; informe ejecutado:
  `/home/ubuntu/secure-imports/clinic-real-20260722/review/cliniccloud_bsmedical_real_20260726_agenda_resources_v1-execute.json`.
  Cada cita enlazada queda marcada en `import_metadata.clinicaclick_agenda_backfill_v1`.
  Para revertir solo este backfill, usar ese batch como filtro: limpiar
  `doctor_id`/`instalacion_id` de citas `source_system='cliniccloud'` marcadas,
  borrar recursos con email `cliniccloud.agenda.*@imports.clinicaclick.local`
  y borrar instalaciones cuya descripcion contiene el batch. No tocar
  pacientes, historiales, bonos ni assets clinicos.
- Las fotos clinicas de Nutricion se guardan con `purpose=nutrition_clinical_photo`, `owner_type=patient_nutrition_measurement`, `owner_id=<measurement_id>`, `patient_id` y `clinic_id`. Listado y descarga quedan protegidos por `nutrition.workspace.view`; subida queda protegida por `nutrition.measurements.create`.
- La pestana `Adjuntos` del paciente consume `GET /api/pacientes/:id/clinical-attachments` y sube pruebas generales con `POST /api/pacientes/:id/clinical-attachments`. El backend filtra por permisos segun `purpose`: `nutrition_report_pdf` y `nutrition_clinical_photo` requieren `nutrition.workspace.view`, `consent_document_pdf` requiere `consents.view`, y `clinical_attachment` requiere `patients.sensitive.view` para lectura y `patients.edit` para subida. La subida general usa `clinical_private_storage`, nunca `PUBLIC_MEDIA`, y puede asociarse a una cita mediante `appointment_id`.
- `GET /api/pacientes/:id/activity` expone cada informe final como evento `nutrition_report_finalized`, con titulo, icono, resumen de medicion/servicio/formula/hash y actor de cierre. El evento solo se adjunta si el usuario tiene `nutrition.workspace.view` en la clínica concreta del informe y esa sede pertenece al scope legible del paciente; el mismo filtro por sede se aplica a citas y eventos de reseñas.
- `GET /api/citas/calendar` incluye `tratamiento.disciplina`, `tratamiento.categoria` y `tratamiento.clinical_config` para que la agenda pueda mostrar `Registrar medicion` cuando el tratamiento tenga perfil de medicion asociado.
- Para citas de Nutricion con perfil de medicion asociado, `GET /api/citas/calendar` y `GET /api/citas/:id` adjuntan `nutrition_latest_measurement` si existe una medicion anterior del paciente. Se calcula en backend con una consulta separada a `PatientNutritionMeasurements` y enriquecimiento por mapa, sin recomponerlo desde Angular.
- `src/scripts/tests/medical_area_contracts.test.js` protege el contrato base de Nutricion: perfiles `none/quick/express_isak`, `required_fields`, campos avanzados Kerr, tipos de servicio, workspace de paciente y accion clinica de agenda. `src/scripts/tests/nutrition_workspace.test.js` protege Durnin-Womersley/Siri, Heath-Carter y una muestra Kerr-Ross completa con error de prediccion controlado.

### WhatsApp coexistencia: regla de gateway

Roadmap funcional y tecnico: `cc-front/src/Documentacion/14.3-whatsapp-coexistencia.md`.

Antes de activar coexistencia sobre un numero real:

- QA real esta bloqueado por ticket Meta abierto el 2026-04-16: Embedded Signup de coexistencia abre correctamente, pero en el caso SOHO el boton `Siguiente` queda deshabilitado tras introducir un numero activo en WhatsApp Business App y no llega mensaje de verificacion a la app movil;
- hasta que Meta responda, no ejecutar `POST /api/whatsapp/phones/:phoneNumberId/coexistence/sync-initial` salvo que el numero haya finalizado onboarding real en coexistencia;
- el webhook WhatsApp ya acepta de forma pasiva `history`, `smb_app_state_sync`, `smb_message_echoes`, `edit` y `revoke` sin romper el inbound actual;
- `history` y `smb_message_echoes` no reanudan automatizaciones ni `wait_response`;
- los mensajes `smb_message_echoes` se persisten como outbound manual con `Messages.metadata.origin = mobile_app` para que la UI muestre `Enviado desde el movil`;
- el historial importado se guarda con `Messages.metadata.origin = history_import`, no suma no leidos y no dispara flujos;
- `edit` actualiza contenido/metadata del mensaje original y `revoke` marca el mensaje como revocado sin borrarlo;
- `account_update` con `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED` o `ACCOUNT_RECONNECTED` actualiza `ClinicMetaAssets.additionalData.coexistence`;
- `POST /api/whatsapp/embedded-signup/callback` acepta `connection_mode=cloud_api|coexistence`;
- en `connection_mode=coexistence`, el backend guarda el modo en `ClinicMetaAssets.additionalData`, marca el registro como activo y omite el registro tecnico del numero porque Meta ya lo devuelve incorporado;
- tras Embedded Signup, la creacion/envio a revision de plantillas WhatsApp no debe encolarse como BullMQ dentro de `QUEUE_PREFIX=gateway`;
- el callback crea un `JobRequest` `whatsapp_template_create` con `payload.__runtime_namespace` resuelto por origen (`crm` -> `staging`, `localhost:4203` -> `dev`, `app` -> `prod`);
- `jobExecutor.service.js` procesa `whatsapp_template_create` ejecutando `createTemplatesFromCatalog(...)`, que transforma placeholders `SIN_CONECTAR` en plantillas enviadas a revision (`PENDING`);
- si el WABA esta asignado a grupo, `createTemplatesFromCatalog(...)` debe resolver todas las clinicas del grupo como objetivo efectivo. Las plantillas aprobadas existen en Meta a nivel de WABA, asi que una clinica nueva del grupo debe enlazar sus overrides locales a esas aprobaciones antes de intentar abrir revisiones nuevas;
- para WABA compartido, si ya existe una plantilla aprobada compatible por `catalog_template_id`/familia en ese WABA, el job debe dejar la copia local de cada clinica en `APPROVED` con el `meta_template_id` existente. No se debe enviar una revision nueva a Meta solo porque una clinica del grupo tuviera placeholders `SIN_CONECTAR`;
- desde 2026-07-28, `createTemplatesFromCatalog(...)` serializa por WABA con un advisory lock MySQL y sincroniza Meta antes de calcular la siguiente version tecnica. Esto evita que dos runtimes creen a la vez la misma traduccion `name + language`, situacion que puede dejar una copia aprobada y otra pendiente con el mismo nombre y provocar `132001` al enviar. Si otro proceso ya tiene el lock, la segunda ejecucion se omite porque la primera recorre el catalogo completo;
- `whatsapp_phones_sync` (cada 15 minutos) actua como red de seguridad: si detecta que un numero ya esta `CONNECTED`/`registered` y quedan plantillas de catalogo sin `meta_template_id` o en `SIN_CONECTAR`/`LOCAL_PENDING`, encola `whatsapp_template_create` con cooldown de 1 hora (`WHATSAPP_TEMPLATE_CREATE_ENSURE_COOLDOWN_MS`). En WABA asignado a grupo debe revisar las plantillas de todas las clinicas del grupo, no solo la clinica principal del activo. Tambien compara cada WABA contra todas las plantillas de catalogo genericas activas (`is_generic=true`): si una plantilla generica nueva no tiene copia remota con `catalog_template_id` y `meta_template_id`, o si la copia remota apunta al mismo catalogo pero su `category/components` ya no coinciden con el contenido Meta-facing actual, se vuelve a encolar la creacion aunque el WABA ya tuviera plantillas anteriores. Esta comparacion normaliza `components` e ignora cualquier `example` de Meta, incluido `HEADER/IMAGE.example.header_handle`, porque Meta sustituye los ejemplos por handles/URLs `scontent.whatsapp.net` y no forman parte del contrato que ve el paciente. Esta ruta salta el cooldown cuando el catalogo esta incompleto/desactualizado para que se abra una nueva version tecnica en Meta. Esto cubre coexistencia cuando Meta termina de habilitar el numero despues del callback inicial, nuevas plantillas admin añadidas a posteriori, cambios de copy en plantillas genericas ya propagadas y clinicas nuevas que heredan WABA de grupo;
- `whatsapp_phones_sync` no debe reintentar automaticamente `PENDING_LOCAL` o `REJECTED`: esos estados significan cambio local no aprobable o rechazo de Meta y requieren accion correctiva sobre el contenido;
- las plantillas de reseñas tienen dos familias genericas: `clinicaclick_solicitar_resena` (solo texto) y `clinicaclick_solicitar_resena_foto` (cabecera `HEADER/IMAGE`). Si `review_team_photo_url` es HTTPS, el producto debe usar la variante con foto; si esa variante no esta `APPROVED`, la UI bloquea prueba/envio con motivo claro en vez de enviar silenciosamente la version sin foto. Para que Meta acepte la revision de cabecera de imagen, el ejemplo debe ser un media handle de Meta, no una URL publica. El backend lo genera automaticamente con la Resumable Upload API usando la URL publica de ejemplo del catalogo (`templates/reviews/team-example.jpg`) y el token del WABA; `WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE`/`WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE` quedan como fallback operativo. Si no puede generar ni resolver el handle, deja la version tecnica en `PENDING_LOCAL` con motivo claro. Si Meta devuelve despues otro handle/URL de ejemplo para la misma cabecera, la plantilla sigue siendo equivalente mientras coincidan formato de cabecera, body, botones y categoria. Cuando `whatsapp_templates_sync` detecta que una copia local de reseñas con foto pasa a `APPROVED`, emite `whatsapp.review_photo_template_approved` con enlace interno a `/marketing/campanas?objective=get_reviews&review_step=summary` para retomar el borrador;
- `GET /api/automations/v2/templates` oculta la base de sistema de reseñas en listados con scope (`review_request_after_completed` / `flw_review_request_system`). Esa base es catálogo; la automatización operativa de reseñas siempre debe ser una copia scoped de clínica/grupo creada desde Campañas > Reseñas. Las copias publicadas e inactivas se tratan como deprecadas y no reactivan visualmente la base global;
- `whatsapp_phones_sync` solo debe encolar WABAs procedentes de `whatsapp_phone_number` activos y asignados a clínica o grupo. Un número `unassigned` no es operativo aunque conserve token de Meta para reasignación o auditoría;
- un número `unassigned` puede permanecer `isActive=true` si se ha desasignado para poder reasignarlo desde Ajustes. La sync remota no debe tratarlo como operativo ni encolar plantillas hasta que vuelva a tener `assignmentScope=clinic|group`;
- la sync remota de teléfonos no puede reactivar un número desconectado/desactivado solo porque Meta lo siga devolviendo. Si se desactivó con la acción destructiva de desconexión, debe permanecer `isActive=false` y `assignmentScope=unassigned`;
- `whatsapp_templates_sync` (cada 20 minutos) solo sincroniza estados remotos existentes. Si Meta sigue devolviendo `PENDING`, ClinicaClick debe mantener `PENDING`; no se marca como aprobada por tener el numero operativo;
- tras sincronizar, una plantilla global de catalogo que lleve mas de 60 minutos en `PENDING`/`IN_REVIEW` puede consumir un unico reenvio automatico. Debe conservar el contrato vigente, identidad remota y WABA operativo, no ser override de clinica ni tener una hermana aprobada. `REJECTED`, `PENDING_LOCAL`, custom, inactivas, supersedidas y filas cuyo intento ya se consumio no se recrean;
- el reenvio se reclama por compare-and-set y persiste en una sola transaccion el placeholder sustituto y un `JobRequest whatsapp_template_create` con `mode=resubmit_stale_pending`. El executor usa un nombre determinista, busca primero esa version en Meta y, ante reintentos tecnicos, completa siempre la misma solicitud. La sustituta nace con `auto_resubmit_attempt_count=1`, por lo que una caida despues del alta remota no puede iniciar un bucle;
- antes de retirar la revision antigua se relee Meta. Si la original paso a `APPROVED` durante la carrera, se reactiva y la sustituta se retira. Mientras ninguna variante este aprobada, el runtime de Automatizaciones V2 conserva el fallback aprobado configurado en el nodo; la recreacion no bloquea el recordatorio habitual;
- la migracion `20260715064500-add-whatsapp-template-auto-resubmit-state.js` añade `pending_since_at`, contadores/fechas/error, enlaces de origen/supersesion y el indice `idx_whatsapp_templates_pending_auto_resubmit`. `WHATSAPP_TEMPLATE_AUTO_RESUBMIT_ENABLED` es el kill switch y `WHATSAPP_TEMPLATE_AUTO_RESUBMIT_PENDING_MINUTES` controla el umbral, 60 por defecto;
- `whatsapp_templates_sync` debe respetar `assignmentScope`: si un WABA esta asignado a `clinic`, solo actualiza los overrides locales de esa clinica aunque el activo conserve `grupoClinicaId` por pertenecer a un grupo; si esta asignado a `group`, entonces si expande a todas las clinicas del grupo. Esto evita que una excepcion como Glories contamine plantillas locales de otras sedes Propdental;
- el webhook inbound debe resolver `metadata.phone_number_id` priorizando activos `whatsapp_phone_number` sobre filas legacy `whatsapp_business_account`. En WABA compartido de grupo, el activo `whatsapp_phone_number + assignmentScope=group` es el origen canonico; desde ahi se busca la conversacion existente por contacto dentro del grupo. Si se deja que una fila legacy de una clinica gane el lookup, las respuestas entran en la clinica propietaria historica del WABA, no en la clinica que envio la cita, y los `wait_response` no se reanudan. Una vez existe el `whatsapp_phone_number` operativo con `wabaId`, token y `businessId`, las filas duplicadas `whatsapp_business_account` del mismo WABA deben retirarse para no reintroducir ambiguedad; los jobs de plantillas enumeran WABAs desde ambos tipos y priorizan el phone asset;
- `GET /api/whatsapp/phones` expone `connection_mode`, `is_on_biz_app`, `coexistence_status`, `coexistence_can_send_api` y estados de importacion inicial para que Ajustes pueda mostrar el modo real;
- Si Meta devuelve `GraphMethodException code=100 error_subcode=33` al enviar o leer un numero en coexistencia, el backend marca `ClinicMetaAssets.additionalData.coexistence.status=disconnected`, `canSendApi=false`, `requiresReconnect=true` y emite la notificacion `whatsapp.coexistence_disconnected` con accion `Reconectar WhatsApp` hacia `/ajustes?tab=whatsapp`. Esto cubre sesiones compartidas caducadas/inactivas, la app de ClinicaClick desinstalada del WABA o tokens que pierden permisos sobre el WABA/phone. El texto operativo indica reconectar desde Ajustes y, en modo compartido, abrir WhatsApp Business en el movil, escribir un mensaje desde ese movil y recibir respuesta antes de cerrar la alerta;
- la sync de telefonos debe normalizar `GET /<phone_number_id>/whatsapp_business_profile`: Meta devuelve el perfil en `data[0]`; de ahi salen `vertical`/categoria, descripcion y foto. No leer `profile.vertical` directamente sin normalizar porque dejaria vacia la categoria en Ajustes;
- `POST /api/whatsapp/phones/:phoneNumberId/coexistence/sync-initial` encola `whatsapp_coexistence_sync_contacts` y `whatsapp_coexistence_sync_history`;
- los jobs de importacion inicial llaman `POST /<BUSINESS_PHONE_NUMBER_ID>/smb_app_data` con `sync_type=smb_app_state_sync` y `sync_type=history`, persistiendo `request_id` y estados en `ClinicMetaAssets.additionalData.coexistence`;
- estos jobs no se lanzan automaticamente al conectar: se solicitan manualmente desde Ajustes cuando el numero ya esta confirmado en coexistencia, para evitar tocar numeros reales sin QA;
- hay fixtures de QA en `src/scripts/fixtures/whatsapp-coexistence/`;
- Propdental se usara como numero de QA, pero no debe relanzarse Embedded Signup ni cambiar el modo de conexion mientras haya mensajes reales de cita pendientes.

## 2026-04-26 - Intake: verificacion Consent Mode v2 y avisos externos

- `GET /api/intake/verify-snippet` no debe decidir compatibilidad de Consent Mode v2 solo por el query param `?v=` del `<script>`.
- Si el snippet instalado apunta a un asset de `*.clinicaclick.com`, el verificador puede inspeccionar el JS servido y leer version/capacidades reales. Esto evita falsos negativos con instalaciones tipo `https://crm.clinicaclick.com/assets/intake.js` sin version en la URL.
- La verificacion devuelve y persiste:
  - `consent_mode_detected`;
  - `consent_mode_domains`;
  - `cookie_notice_detected`;
  - `cookie_notice_provider`;
  - `google_consent_mode_detected`.
- `cookie_notice_detected` se usa para avisar al usuario de posible doble banner cuando activa el Aviso de Cookies + Consent Mode v2 de ClinicaClick en una web que ya carga Complianz, Cookiebot, OneTrust u otro CMP.
- Si el snippet no esta instalado, no se puede verificar el runtime de Consent Mode v2. En ese caso la UI debe apoyarse en el bloque general de verificacion de instalacion, no mostrar una alerta preventiva de Consent.

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
| `POST /api/intake/whatsapp-origin` | Operativo V1 | Registra el `cc_ref` generado por el widget antes de abrir WhatsApp para medir clicks y confirmar inbounds reales. |

Parámetros soportados:

- `clinicId` o `clinica_id`: ID de clínica, CSV de clínicas, `group:ID` o `all`.
- `startDate` / `endDate`: opcionales; por defecto últimos 30 días.

Fuentes que cruza:

- `LeadIntake` para leads, canales, estados y atribución.
- `FormSubmissionEvent` para formularios por URL.
- `WhatsAppWebOrigin` para "WhatsApp desde la web (Clicks)" y "WhatsApp desde la web (Confirmados)".
- `CitasPacientes` para citas vinculadas a leads y asistencia.
- `GoogleAdsInsightsDaily` y `ClinicGoogleAdsAccount` para Google Ads.
- `SocialAdsInsightsDaily`, `SocialAdsActionsDaily`, `SocialAdsAdsetDailyAgg` y `SocialAdsEntity` para Meta Ads.
- `ClinicMetaAssets`, `SocialStatsDaily`, `SocialPosts` y `SocialPostStatsDaily` para Facebook/Instagram orgánico.
- `WebScDaily` y `WebScQueryDaily` para SEO/Search Console.
- `WebGaDaily` para GA4 opcional.
- `ClinicBusinessLocation`, `BusinessProfileDailyMetric` y `BusinessProfileReview` para Perfil Empresa Google.

Meta Lead Ads:

- El webhook `leadgen` puede llegar desde páginas que siguen suscritas a la app de Meta aunque ya no estén conectadas en ClinicaClick.
- El backend solo acepta leads si `page_id` existe como `ClinicMetaAsset` activo de tipo `facebook_page`.
- Si la página no está conectada, se ignora antes de pedir el detalle del lead a Graph API. Esto evita consumo innecesario y ruido por páginas externas.
- El log de páginas no conectadas queda limitado por `META_UNMAPPED_PAGE_LOG_TTL_MS` para no inundar PM2 si Meta reenvía muchos leads de una página antigua.
- La resolución `page_id` -> `ClinicMetaAsset` usa caché corta en memoria (`META_PAGE_MAPPING_CACHE_TTL_MS`, default 5 min) para evitar una query por cada lead externo repetido.

Estado de sincronización:

- La respuesta incluye `sync.active`, `sync.sources[]` y `sync.allSources[]`.
- El estado `connected` de Search Console, GA4, Perfil Google, Google Ads, Meta Ads, Facebook e Instagram debe salir de los mapeos activos (`ClinicWebAssets`, `ClinicAnalyticsProperties`, `ClinicBusinessLocations`, `ClinicGoogleAdsAccounts`, `ClinicMetaAssets`), no de que existan métricas agregadas en el rango consultado. Una fuente puede estar conectada aunque el periodo seleccionado aún no tenga datos.
- El mapping se resuelve como **activo efectivo del scope**, no como una fila local aislada del módulo. Para una clínica se incluyen sus mappings propios y los activos `assignmentScope=group` de `Clinicas.grupoClinicaId`; cuando la vertical usa `GroupAssetClinicAssignments`, también se respetan sus asignaciones explícitas. Informes, onboarding de Campañas y jobs deben compartir el mismo criterio de resolución.
- `connected`, `sync` y presencia de datos son señales distintas. Un job pendiente/error modifica `sync`; cero filas en el rango modifica la presentación de datos; ninguna de las dos situaciones debe devolver `connected=false` si el mapping efectivo sigue activo.
- Vincular una campaña externa a una estrategia (`ExternalCampaignAssignments`) no conecta la cuenta publicitaria. A la inversa, una campaña todavía sin estrategia no hace que `ClinicGoogleAdsAccount` deje de estar conectado. Campañas puede mostrarla como pendiente de asignación mientras Informes mantiene la fuente conectada.
- Regresión de referencia 2026-07-15: una clínica Propdental heredera recuperaba inversión/campañas Google Ads, pero el estado de fuente quedaba `Pendiente` al contar solo `ClinicGoogleAdsAccount.clinicaId=<clinica>`. El contrato es resolver el mismo activo de grupo que usa Campañas y exponer su origen (`group`) sin duplicar mapping.
- Estado de implementación 2026-07-15: `marketingReports.controller.js` consume `resolveEffectiveMarketingAssetInventory`, inventario común de solo lectura, para Google Ads, Meta Ads, Facebook, Instagram, Search Console, GA4 y Perfil Google, incluidos `GroupAssetClinicAssignments`. Está cubierto con tests y smoke real para clínica, grupo y multiclínica. Ads mantiene su atribución histórica por scope; las fuentes owner-centric usan un mapping canónico por identidad remota en agregados de grupo/multiclínica para evitar duplicados. Esta garantía corresponde a Informes; jobs y otros lectores de cada vertical conservan su auditoría específica. Código efectivo actual: backend dev `dd08dff`, backend staging/gateway `7f4062e`.
- La UI que necesita mostrar las conexiones efectivas de Google usa `GET /oauth/google/effective-mappings` con scope explícito y permiso de lectura. El endpoint es DB-only: resuelve una sola vez el inventario común y devuelve `scope`, `descriptors` y `effective_mappings` con `search_console`, `analytics`, `business_profile` y `google_ads`. Cada fila incorpora `assignment_origin`, `inherited`, `read_only=true`, `target_clinic_id`, `owner_clinic_id` y `source_scope`; no consulta Google, no crea asignaciones y no reemplaza los cuatro endpoints físicos `/mappings`, que siguen siendo los editables. En scope clínica, un activo de grupo figura heredado; en scope grupo es nativo, mientras que un activo `shared` permanece heredado y de solo lectura. La UI separa el bloque compartido/read-only de los checkboxes propios y no hace POST sin un diff físico. Regresión canónica: `node src/scripts/tests/oauth_effective_google_mappings.test.js`.
- `sync.active=true` cuando una fuente conectada tiene `JobRequest` pendiente/en ejecución, registros locales pendientes (`ClinicBusinessLocations.sync_status=pending`) o error.
- El endpoint considera terminada una sincronización cuando el último `JobRequest` relevante para la clínica está `completed`, aunque la API externa no haya devuelto filas nuevas. Los jobs globales sin `clinicId` no deben contaminar el estado de una clínica concreta.
- Cuando la clínica consume un activo compartido cuyo mapping físico pertenece a otra sede, el cruce de `JobRequest` amplía el scope con `asset.clinic_id`; así el backfill/error del activo sigue visible para todas sus consumidoras sin considerar globales los jobs sin clínica.
- Si una fuente queda en `state=error`, `sync.message` debe mostrar el mensaje de error de esa fuente, no el texto genérico de "recabando datos".
- En Perfil de Empresa Google, si el último `JobRequest.result_summary.report.errors[]` indica que `mybusiness.googleapis.com` está deshabilitada, el informe debe indicar que Google está rechazando ese servicio exacto como no habilitado en el proyecto afectado y pedir revisar Google Cloud antes de relanzar el resync.
- El frontend usa ese estado para mostrar una barra informativa y refrescar cada 60 segundos mientras haya trabajo pendiente.
- El objetivo es que conectar GA4, Search Console, Perfil de Empresa, Google Ads o Meta Ads no parezca "sin datos" durante los primeros minutos.
- Meta Ads puede llegar a `SocialAdsInsightsDaily` solo con `level='ad'` o `level='adset'` aunque no haya filas `level='campaign'`. El agregador de informes debe sumar primero `campaign` y caer a `adset`/`ad` si el nivel superior no tiene gasto/clicks/impresiones, evitando tanto inversión `0` como doble conteo.
- GA4 se mantiene como fuente opcional de sesiones/histórico, pero `GET /api/marketing/reports/overview` no expone ni usa conversiones nativas de GA4 para el embudo principal.
- El backend entrega KPIs, ratios, funnel con `ratioFromPrevious`, web summary y top páginas ya calculados. El frontend no debe hacer joins ni cálculos de negocio.
- El embudo termina en `Realiza tratamiento`. En V1 se calcula desde `LeadIntake.status_lead='convertido'`; cuando exista una señal clínica canónica de tratamiento realizado, debe reemplazar esta aproximación.
- `webSummary.webConvertedPatients` suma convertidos de canales web propios (`web`, `direct`, `call_click`, `whatsapp`). Los leads con `utm_source` social se asignan a `social_organic`, aunque técnicamente hayan entrado por una URL web, para respetar el primer contacto y evitar doble atribución.
- Los canales de adquisición de Informes no agrupan solo por `LeadIntake.source`: `source=web` puede describir que el contacto entró por chat, formulario o modal telefónico aunque sea publicidad. El agregador prioriza `google_ads_customer_id`, `google_ads_campaign_id`, `gclid`, `gbraid` o `wbraid` como Google Ads y `fbclid` como Meta Ads antes de la fuente explícita y las UTM. La regresión canónica es `node src/scripts/tests/marketing_report_lead_attribution.test.js`.
- El fallback canónico `web` se presenta como **Web propia (sin campaña)**. Incluye formularios, chat y modal telefónico sin señales Ads/SEO/sociales; no equivale solo a formularios ni al canal técnico `direct`.
- Inversión, campañas y serie de gasto usan una ventana publicitaria comparable: `resolvePaidAttributionCoverage` toma el primer `LeadIntake` atribuible a Google Ads o Meta Ads del scope y no suma backfill de gasto anterior. Web, SEO y el resto de datos legítimos conservan el rango solicitado. Desde ese hito se cuentan también los días con gasto y cero leads. La respuesta expone `dataQuality.paidAttributionCoverage` y el frontend avisa si el inicio efectivo ha recortado el rango. El KPI CPL divide esa inversión por leads canónicos de Ads, no por leads web/orgánicos. Sin un hito atribuible no se inventa una fecha. Regresión: `node src/scripts/tests/marketing_report_lead_attribution.test.js`.
- Las filas Google Ads se deduplican por la identidad remota `clinica/grupo + customer + campaign + date + adGroup + network + device`, excluyendo deliberadamente `clinicGoogleAdsAccountId` de esa clave. Un mismo customer puede tener dos mappings locales durante una reasignación o herencia; eso no debe duplicar gasto, clicks ni conversiones. El scope remoto/histórico se conserva, de modo que deduplicar no equivale a ocultar cuentas antiguas legítimas.
- `WhatsApp desde la web (Clicks)` exige un `WhatsAppWebOrigin` creado por el snippet instrumentado. El runtime cubre tanto el widget propio como enlaces existentes `wa.me`, `api.whatsapp.com`, `web.whatsapp.com` y `whatsapp://`: conserva el texto original, añade `[cc_ref:...]` y envía el click con `keepalive` antes de abrir la aplicación. `Confirmados` exige que el usuario envíe el mensaje, que el número destino esté conectado a Clinicaclick mediante Meta y que el inbound conserve la referencia para marcar `used_at`/conversación/mensaje; abrir WhatsApp sin enviar no confirma y un número meramente manual no permite recibir el webhook.

Search Console:

- `web_backfill_for_sites` puede generar cientos de miles de filas en `WebScQueryDaily`.
- Las escrituras de queries se hacen por lotes (`SEARCH_CONSOLE_BULK_CHUNK_SIZE`, por defecto `500`) para no superar `max_allowed_packet` de MySQL.
- Si se ve `Got a packet bigger than max_allowed_packet` seguido de `write EPIPE`, la causa probable es un bulk demasiado grande, no un problema de permisos de Search Console. Relanzar el job después de aplicar el troceado debe cerrar el aviso de `Revisar sync`.

ClinicaClick Analytics V1:

- Desde 2026-04-26 existen `WebEvents`, `WebPageDaily`, `WebClickDaily` y `WebSessionDaily`.
- `POST /api/intake/events` persiste eventos propios desde `intake.js` además de mantener Meta CAPI / Google Ads cuando proceda.
- Si `Aviso de Cookies + Consent Mode v2` está activo para el scope, los envíos server-side a Meta/Google se bloquean hasta consentimiento de marketing explícito.
- Los eventos analíticos propios se guardan solo si hay consentimiento analítico o si Consent Mode no está activado para la clínica.
- `ViewContent` no debe persistirse antes de consentimiento analítico cuando Consent Mode está activo. El runtime lo reintenta una sola vez tras aceptar/guardar consentimiento para no perder la primera visita consentida.
- El backend normaliza variantes emitidas por el runtime (`WhatsAppClick`, `FormSubmit`, etc.) a tipos canónicos (`whatsapp_click`, `form_submit`) antes de agregar. La migración `20260426224500-normalize-web-event-action-types.js` corrige eventos y agregados ya escritos con nombres compactados legacy.
- `consent_update` se persiste siempre para poder auditar cambios de consentimiento.
- Desde `intake.js` v3.2.1, la configuración legal canónica del aviso de cookies es `legal_url`, `cookies_url` y `privacy_url`. `terms_url` queda como alias legacy de `legal_url`.
- `IntakeConfig.config.snippet_verification` conserva `consent_mode_detected` y `consent_mode_domains`; no eliminarlos en el upsert porque Marketing > Web los usa para saber si la web instalada ya carga un runtime compatible.
- `GET /api/marketing/reports/overview` prioriza `WebPageDaily` / `WebSessionDaily` para pageviews, sesiones y visitantes. GA4 queda como fuente opcional/fallback histórico.
- `webEventsAggregate` recalcula agregados para una ventana reciente y limpia eventos brutos antiguos según `WEB_EVENTS_RETENTION_DAYS`.

## 2026-04-21 - Informes de competencia local V1 (histórico, gobernado desde 2026-07-15)

Se añadió backend V1 para `Marketing > Informes > Competencia`. El diseño técnico de Places descrito en este bloque solo puede ejecutarse tras los tres gates contractuales del corte 2026-07-15. El código los mantiene apagados por defecto; la instalación ClinicaClick los activa por configuración operacional desde el 2026-07-15 y conserva el alta manual como alternativa.

Principios:

- Sugerencia automática: requiere gates y API key. En esta instalación autorizada, la primera entrada a Competencia por clínica carga sugerencias una sola vez durante la vida del componente, con máscara de coste reducida y caché de seis horas; después el usuario puede refrescarlas explícitamente. Si faltan los gates o proveedor, `suggestions` devuelve acción de alta manual y no realiza llamadas externas.
- Para sugerir competidores es obligatorio tener una ficha local propia conectada o `Clinica.url_ficha_local` guardada. Si falta, `GET /competition/suggestions` devuelve `setup_required=true`, `setup_code=LOCAL_PROFILE_REQUIRED` y no ejecuta una búsqueda genérica.
- Desde 2026-07-24, una `Clinica.url_ficha_local` manual sin `ClinicBusinessLocation` se resuelve una sola vez antes de construir el informe. El backend sigue únicamente redirecciones HTTPS de hosts Google permitidos, extrae `place_id` directo o la identidad `q/kgmid`, exige coincidencia inequívoca de nombre/web en Places y persiste en `Clinicas.configuracion.marketing_competition_local_profile` la identidad canónica. Dirección, ciudad, provincia, CP y país solo completan columnas vacías; una ficha GBP conectada sigue teniendo prioridad. Los fallos quedan con `retry_after` de una hora y el informe devuelve `LOCAL_PROFILE_URL_UNRESOLVED` en vez de aparentar una configuración válida sin términos.
- Si hay ancla local pero no hay categoría/especialidad suficiente, devuelve `setup_code=LOCAL_CATEGORY_REQUIRED`. No se debe usar fallback a "clínica médica" porque genera ruido en clínicas nuevas.
- Cuando hay ficha local conectada, la categoría/nombre de Google Business Profile tiene prioridad sobre disciplinas mixtas de la clínica para inferir la búsqueda inicial. Ejemplo: si una clínica tiene varias áreas pero su ficha local es `Podólogo`, la competencia se busca como podología, no como otra disciplina secundaria.
- Las sugerencias excluyen la propia ficha local por `place_id` y por nombre normalizado. La propia clínica no debe aparecer como competidor sugerido aunque Google la devuelva en los primeros resultados.
- `GET /competition` devuelve `own_profile`, términos y datos manuales/snapshots autorizados. No consulta Meta/Google Ads en vivo. La identidad propia sale del `ClinicBusinessLocation` efectivo; rating/recuento se agregan desde `BusinessProfileReviews` ya sincronizadas y la foto se toma del contenido GBP persistido (prioridad `PROFILE`, `COVER`, `EXTERIOR`, `INTERIOR`, `ADDITIONAL`). El ranking Places queda vacío mientras el gate contractual esté cerrado.
- Desde 2026-07-22, relevancia y términos priorizan `ClinicBusinessLocation.primary_category + location_name` sobre `Clinicas.configuracion.disciplinas`. Esto evita que un servicio interno secundario cambie el vertical público del benchmark. Estética/cirugía plástica dispone de regla propia y tres variantes locales.
- La serie de Perfil de Empresa descarta de la gráfica los últimos siete días cuando Google sólo ha publicado una parte de las métricas del día; una cola parcial no se presenta como caída real. Los servicios conservan si Google los entrega como libres o estructurados y si la descripción falta en origen.
- `GET /competition/local-heatmap` devuelve `LOCAL_RANKING_PROVIDER_REQUIRED` con los gates apagados. Con proveedor autorizado, el frontend solicita automáticamente la matriz del primer término a `1 km` en la primera entrada de cada clínica; después, seleccionar otro término o un radio de `1`, `3` o `5` km solicita inmediatamente esa matriz, sin un segundo botón. No existe `map_image_data_url`: el frontend dibuja un grid abstracto y solo muestra `Google Maps` como atribución cuando el resultado procede realmente de Google.
- Caché preparada: `MarketingCompetitionHeatmapCaches` solo se lee/escribe con los gates de uso+almacenamiento activos. La clave cubre scope/ficha/término/radio/cuadrícula/algoritmo; dura 7 días `fresh` y hasta 14 `stale`. Un stale encola `marketing_competition_heatmap_refresh` con lease de 30 minutos/dedupe por clave y hasta 4 intentos. `system_data_cleanup` retira filas antiguas/versiones caducadas. La antigua migración `1520` de purga está cancelada y es un no-op; no elimina contenido histórico ni cachés.
- Concurrencia: si el gate contractual se habilita, ranking y heatmap limitan las llamadas (`COMPETITION_GOOGLE_CONCURRENCY`, default 3); apagado, realizan cero llamadas Places.
- Si la ficha propia no aparece en una búsqueda simulada, `aboveMe` y `belowMe` deben ir vacíos y se devuelve `visibleResults` con los resultados encontrados. No tiene sentido hablar de "por encima" o "por debajo" cuando la clínica no aparece.
- Guardar solo competidores confirmados por el usuario.
- Actualizar semanalmente por cron, no en cada render del informe.
- Consultar anuncios mediante la API oficial de Meta Ads Library. Si Meta devuelve `ad_snapshot_url`, el backend puede intentar extraer imagen/vídeo público del snapshot como previsualización best-effort. El `ad_snapshot_url` original puede incluir `access_token`; nunca debe persistirse ni devolverse al front. Se usa solo de forma transitoria durante el refresco y se guardan enlaces públicos seguros (`https://www.facebook.com/ads/library/?id=...` y catálogo de página `view_all_page_id=...`).
- Media de anuncios Meta: el extractor busca `og:video`, `og:image`, `video[src]`, `video[poster]`, `srcset`, `data-src`, backgrounds CSS, recursos cargados por la página y URLs `.mp4/.webm/.mov` e imágenes `.jpg/.png/.webp` incluso si vienen escapadas en HTML/JSON. Se filtran assets internos de Facebook (`static.xx.fbcdn.net`, `rsrc.php`) para no guardar logos o páginas de error como creatividad. Si el snapshot devuelve `400/403` o una página sin media accesible desde servidor, se conserva el enlace oficial a Meta y la UI debe indicar que la creatividad visual no está disponible.
- Recuperación visual Meta con navegador: existe un fallback opcional para ejecutar navegador headless solo durante `competition_refresh`, nunca en el render normal del informe. El modo recomendado es `COMPETITION_META_BROWSER_MEDIA_MODE=auto`: primero se intenta HTML directo; solo si quedan anuncios sin media y con snapshot se despierta el navegador. El runtime es lazy, concurrencia 1, reutiliza el proceso mientras haya trabajo y lo duerme/cierra tras `COMPETITION_META_BROWSER_MEDIA_IDLE_MS`. En servidor se usa `puppeteer-core` como dependencia ligera y `chrome-headless-shell` externo como binario (`COMPETITION_BROWSER_EXECUTABLE_PATH`), evitando descargar Chrome dentro del paquete Node. Si no existe navegador, el snapshot queda como `meta_browser_unavailable` sin fallar el job. `refreshCompetition.report.provider.meta_browser_media` incluye lanzamientos, anuncios intentados/recuperados, errores, duración y delta RSS aproximado para medir impacto.
- Validación 2026-04-25: backfill de 23 competidores conectados en `auto`, límite 5 creatividades Meta por competidor. Tiempo `~124s`, delta RSS del proceso `~86MB`, `attempted_ads=15`, `recovered_ads=15`, `failed_ads=0`, `launches=2`, `sleep_count=2`, sin procesos `chrome-headless-shell` vivos tras finalizar.
- Validación 2026-04-26: refresco focalizado de Abaden Dentistas con `COMPETITION_META_BROWSER_MEDIA_LIMIT=25`. Resultado: `25/25` creatividades Meta con media recuperada, duración `~66s` para ese competidor. El límite 25 solo debe usarse en refresh/backfill cacheado, nunca en render normal del informe; si el volumen de competidores crece, mover esta recuperación a worker dedicado o bajar el límite.
- Resolución de Meta antes del fallback:
  - Primero se usan perfiles sociales ya guardados/manuales y URL de ficha/web. Instagram aporta términos de marca, pero solo un Page ID de Facebook/Ads Library se considera identidad publicitaria canónica.
  - Después se revisa `website_url`: home + páginas internas ligeras de contacto/sobre nosotros/equipo para localizar enlaces públicos a Facebook/Instagram, normalmente en footer.
  - Si hay Facebook URL o usuario, se intenta resolver `page_id` con Graph API; también se extraen IDs de URLs tipo `view_all_page_id`, `search_page_ids`, `page_id`, `id`, `/123456` o slugs con sufijo numérico `nombre-123456`. La extracción cubre `meta_page_url`, `facebook_url`, URL de Biblioteca explícita y perfiles sociales anidados; un `view_all_page_id` aportado se guarda como página numérica canónica y nunca se vuelve a resolver por parecido de nombre.
  - Solo si no existe página exacta se consulta Ads Library por frase exacta. Antes del nombre largo se prueban fragmentos de marca separados por `|`, guion o raya y se descartan segmentos puramente genéricos como `Clínica Dental`; así `Dental Studio Dra. Lorena Herrero - Clínica Dental`, `Instituts Odontològics | Clínica Dental Hospitalet` y `... | Grup Dr. Bladé` buscan su marca, no cualquier clínica local. La concordancia ignora términos genéricos y admite dos raíces largas coincidentes para variantes catalán/castellano, sin rebajar el umbral a una sola palabra genérica.
  - La resolución de identidad usa `ad_active_status=ALL` y únicamente `id,page_id,page_name`, de modo que una página con anuncios históricos pero ninguno activo pueda identificarse sin descargar creatividades; después los anuncios se consultan con `ACTIVE` y `search_page_ids` exacto. Se aceptan solo páginas cuyo `page_name/page_id` encaje con el competidor.
  - No identificar una página no equivale a haber comprobado que tiene cero anuncios: se persiste `status=identity_unresolved` y `META_PAGE_IDENTITY_UNRESOLVED`. Si el Facebook público sí está localizado, la respuesta diferencia `identity_status=facebook_profile_found` y pide el enlace «Ver todos los anuncios»; si hay Page ID, `identity_status=resolved` y la API devuelve también `library_url`. Una página resuelta cuya consulta `ACTIVE` por ID vuelve vacía se considera `completed` con cero filas de API y expone `api_result_status=no_ads_returned`: esto confirma la identidad consultada, pero no debe presentarse como fallo de atribución ni como prueba absoluta de ausencia en la Biblioteca pública. Al leer snapshots antiguos, `completed/0 + fallback_filtered=true + page=null` se normaliza también como `identity_unresolved`.
- Google Ads Transparency:
  - No existe una API oficial de Google Ads para leer anuncios de competidores desde cuentas no autorizadas. Para competencia se consulta el Ads Transparency Center público mediante sus endpoints RPC (`SearchService/SearchSuggestions` y `SearchService/SearchCreatives`), con `X-Same-Domain`, `Referer` oficial y límites bajos.
  - No se lanza navegador/headless ni se hace scraping interactivo de la web. Esto evita carga de CPU, reduce riesgo operativo y permite ejecutar la captura solo en `competition_refresh`.
  - Resolución: primero se buscan creatividades por dominio confirmado manualmente del competidor. Si no hay dominio con anuncios, se buscan anunciantes por nombre/términos y se aceptan solo coincidencias con score mínimo.
  - Las creatividades se guardan en `MarketingCompetitorAdSnapshots` con `provider='google_ads_transparency'`. Se devuelven en `GET /competition` bajo `competitor.google_ads`.
  - Conteo: `ads_count` representa el total estimado de anuncios del anunciante cuando Google devuelve `upper_bound/lower_bound`. `active_ads` contiene solo el set visible recuperado para UI (`visible_ads_count`, por defecto 25). No confundir "25 creatividades visibles" con "25 anuncios totales".
  - Enlaces: cada creatividad mantiene `ad_snapshot_url` al anuncio concreto, pero `library_url/advertiser_url` deben apuntar al catálogo del anunciante para que el usuario vea todos los anuncios disponibles.
  - Media de Google: se priorizan imágenes `tpc.googlesyndication.com/archive/simgad`. Si el preview llega como `content.js`, se descarga solo para los primeros anuncios configurados y se extraen imágenes/vídeos aunque vengan dentro de contenido percent-encoded. Se filtran iconos/material assets (`fonts.gstatic.com`, `www.gstatic.com`, `googlematerialicons`) para no guardar iconos como creatividad. Los vídeos de YouTube se guardan como `external_video_url` con miniatura, no como descarga local.
  - Si Google cambia el contrato RPC o bloquea la consulta, se persiste `status=unavailable` para ese provider y la UI debe mostrar el enlace oficial o estado no disponible sin bloquear el informe.
- El alta/edición de competidor acepta `meta_page_url`. Si la URL contiene un identificador de página, backend extrae automáticamente `meta_page_id` para consultar la página exacta de Meta Ads Library.
- Un `meta_page_id` confirmado manualmente tiene prioridad sobre el perfil vanity
  que pueda redescubrir Places o la web. El refresco solo adopta un Page ID
  descubierto cuando realmente puede extraer un identificador numérico y nunca
  escribe `null` sobre una identidad publicitaria explícita ya guardada.
- En cada refresco se intenta detectar perfiles sociales públicos desde los datos manuales y la web confirmada (`website_url`). Los perfiles se guardan en el payload manual y se añaden a `meta_ads_search_terms` para mejorar la consulta oficial de Meta Ads Library. La detección es best-effort, con destino/redirect/DNS validados, timeout bajo y máximo de páginas limitado.
- Los competidores se etiquetan con `relevance` frente a las disciplinas de la clínica. La especialidad se infiere primero desde `configuracion.disciplinas` y, si falta, desde nombre/servicios/descripción antes de caer a categorías genéricas de Google como `Medical Clinic`. Los que no encajan, por ejemplo competidores médicos genéricos en una clínica capilar, no se borran automáticamente, pero la UI debe marcarlos como `Revisar`.
- Reglas de relevancia V1 cubiertas: capilar, cirugía digestiva/hepatobiliar, podología y dental. Si una disciplina no tiene regla todavía, la UI debe mostrar `Sin regla de relevancia` y no ocultar resultados.
- Mapa de calor local:
  - Tras abrir los gates contractuales, cada tile estima resultados desde su coordenada usando Google Places Text Search con `locationBias` y `rankPreference=RELEVANCE`; con gates cerrados no se ejecuta. Nunca se presenta como posición exacta o garantizada de Google Search.
  - La matriz por defecto es `5x5` (`COMPETITION_LOCAL_HEATMAP_GRID_SIZE=5`, `COMPETITION_LOCAL_HEATMAP_MAX_POINTS=25`) y se mide hasta Top 20 (`COMPETITION_LOCAL_HEATMAP_RESULT_LIMIT=20`). `null` significa que la clínica no aparece en esa profundidad y debe mostrarse como `>20`; posiciones `1..3` son verde, `4..9` naranja y `10..20` rojo.
  - El zoom (`1/3/5 km`) solo separa más o menos los puntos alrededor de la clínica. No debe ampliar la ventana de búsqueda de cada tile, porque entonces el punto `Centro` de 3 km/5 km deja de ser comparable con el de 1 km.
  - No se solicita, descarga, almacena ni reenvía Google Static Maps. Backend tampoco solicita ni sirve teselas OSM: devuelve coordenadas de muestreo y ranking. El navegador carga únicamente las teselas OSM visibles, con atribución, y mantiene separada la atribución del ranking de Google Maps; no superpone nombres ni contenido de fichas Places.
  - La consulta efectiva elimina sufijos geográficos redundantes del término elegido (`"clínica capilar en Alicante"` -> `"clínica capilar"`) y la UI muestra también el término original si cambia.
  - En podología, no usar `"uñas"` como término aislado de ranking/relevancia. Debe ser contexto clínico (`"podólogo uñas encarnadas"`, `"podología"`, `"clínica podológica"`, `"quiropod"`, `"plantilla"`), porque `"uñas"` trae centros de manicura y distorsiona el mapa.
  - El presupuesto por defecto admite términos de hasta 160 caracteres, 12 identidades nuevas por clínica y hora y 60 filas activas por clínica; reutilizar una identidad cacheada no consume alta. Una medición normal exige al menos 20 de los 25 puntos por defecto y, en cualquier cuadrícula, al menos el 80 % o el mínimo configurado.
  - La identidad persistente incluye versión de algoritmo; al cambiar la semántica hay que subirla para no mezclar mediciones antiguas. La respuesta expone `cache.status`, `generated_at`, `fresh_until`, `expires_at`, peticiones de proveedor y estado de refresco.
  - Corrección Badalona 2026-07-15: nunca convertir coordenadas ausentes con `Number(null)`, porque produce `0,0` y centra toda la matriz en el Golfo de Guinea. Se validan pares estrictos/rangos; si GBP no trae `latlng` pero sí `place_id`, se resuelve con Place Details y máscara `id,location`, reutilizando esa ancla durante 12 horas en el caché runtime para términos/radios sucesivos. La versión por defecto pasa a `local-relevance-bias-v2`, por lo que las cachés `v1` incorrectas no se reutilizan.
  - Cada tile solo necesita conocer si el `place_id` propio aparece y en qué índice. Su Text Search usa `X-Goog-FieldMask: places.id`, `pageSize=20`, una llamada por punto y sin fallback. Una única Text Search Pro cacheada por identidad de mapa pide `places.id,places.displayName` para etiquetar los demás puestos. Desde `local-relevance-bias-v5`, si esa búsqueda central no cubre un Place ID que realmente ocupa el top 3 de una celda, se completa su nombre mediante Place Details exacto `id,displayName`, cacheado 12 h, concurrencia 3 y máximo 25 identidades por matriz (`COMPETITION_LOCAL_HEATMAP_IDENTITY_DETAILS_MAX`). Los IDs efímeros viven en un `Symbol` no enumerable y se eliminan antes de persistir/responder. La propia ficha se excluye siempre de `ranked_competitors`.

Incidente real Badalona previo a `local-relevance-bias-v2` (2026-07-15): las dos cachés existentes de radios 1 km y 3 km tenían centro `{latitude:0, longitude:0}`, `25` Text Search cada una y `25/25` posiciones `null`; fueron 50 consultas sin utilidad. No se borran mediante la migración 1520: el cambio de versión las deja fuera de la identidad vigente y el cleanup ordinario podrá retirarlas al expirar. La ficha propia sí estaba conectada (`place_id` correcto) y tenía 174 reseñas sincronizadas, media `4,8563`; los guiones de la UI procedían de que backend devolvía rating/recuento siempre a `null`, no de una conexión ausente.

En costes de Places, la facturación la determina el campo de mayor nivel solicitado. La sugerencia de competidores excluye `rating`, `userRatingCount`, teléfono, web y fotos; esos campos se piden una vez en Details después del alta explícita. Las 25 tiles usan solo IDs y se cruzan primero con una consulta nominal cacheada; v5 añade Details nominales únicamente para huecos top-3 reales, deduplicados, cacheados y limitados. Según el tarifario oficial consultado el 2026-07-16, `places.id` activa **Text Search Essentials (IDs Only)** y ese SKU tiene uso gratuito ilimitado; por tanto, las tiles no generan 25 cargos **Text Search Enterprise**. Puede quedar una llamada Essentials `id,location` para resolver el ancla, una búsqueda Pro nominal y los Details nominales exactos que realmente falten. `provider_request_breakdown.places_identity_details` permite auditar ese coste. Referencias: [campos y SKU de Places](https://developers.google.com/maps/documentation/places/web-service/data-fields), [detalle de SKU](https://developers.google.com/maps/billing-and-pricing/sku-details) y [tarifario global](https://developers.google.com/maps/billing-and-pricing/pricing).

Diagnóstico Meta Badalona 2026-07-15/16: los nueve snapshots del scope estaban almacenados como `completed/0`, pero los nueve tenían `clinicaclick_resolution.page=null` y `fallback_filtered=true`; ninguno había identificado una página. El competidor `57` conserva `instagram_username=clinicaprovenza`; la concordancia exacta normalizada resuelve `page_id=449497955170438` y la consulta `ACTIVE` devuelve **1 anuncio**. No se afloja el umbral para `MORA Clínica Dental`: continúa `identity_unresolved` y la acción correcta pide URL de Ads Library con `view_all_page_id` o Page ID, no repite una URL de Facebook ya conocida. No se afirma recuperación total ni se convierte identidad pendiente en cero anuncios.

Diagnóstico Hospitalet 2026-07-17: el enlace aportado con `view_all_page_id=1438321663093742` se parsea de forma determinista, pero Graph devuelve permiso `#10` para leer nombre/link y Ads Archive devuelve cero filas por ese ID tanto en `ES` como en la prueba multirregión. Sin conocer a qué competidor corresponde, no se asigna por similitud. Tras mejorar términos, las lecturas reales resuelven sin mutar datos `Dental Studio Dra. Lorena Herrero -> 1673128226297489`, `Instituts Odontológicos -> 170744346392742` y `Grup Dr. Bladé -> 101023738733021`; el refresh durable es quien persistirá esos IDs y volverá a consultar anuncios después del despliegue.

Tablas:

| Tabla | Uso |
|:---|:---|
| `MarketingCompetitors` | Competidores activos por clínica/grupo, manuales o confirmados desde sugerencias, con configuración opcional de página Meta. Las filas históricas de Places se conservan; la `1520` destructiva fue cancelada. |
| `MarketingCompetitorSnapshots` | Snapshot histórico. El contenido Places anterior se conserva; la `1520` actual es un no-op. |
| `MarketingCompetitorAdSnapshots` | Snapshot de anuncios activos por provider (`meta_ads_library`, `google_ads_transparency`) o error explícito de disponibilidad. |
| `MarketingCompetitionHeatmapCaches` | Payload y lifecycle 7/14 días por identidad de medición, con coste del proveedor, lease y error de último refresco. |

Endpoints:

| Endpoint | Estado | Uso |
|:---|:---|:---|
| `GET /api/marketing/reports/competition` | Operativo backend V1 | Lista competidores, último snapshot, anuncios activos y estado de proveedores. |
| `GET /api/marketing/reports/competition/suggestions` | Operativo con gate | Con proveedor autorizado alimenta el bootstrap automático y el refresco manual; reutiliza seis horas. Sin gate devuelve proveedor requerido y mantiene el alta manual. |
| `GET /api/marketing/reports/competition/local-heatmap` | Operativo con gate | Alimenta la matriz inicial de 1 km y cada cambio explícito de término/radio; sin gate devuelve proveedor requerido. |
| `POST /api/marketing/reports/competition/competitors` | Operativo backend V1 | Añade un competidor confirmado por el usuario. |
| `PATCH /api/marketing/reports/competition/competitors/:competitorId` | Operativo backend V1 | Edita datos, `meta_page_id`, términos de búsqueda o estado. |
| `DELETE /api/marketing/reports/competition/competitors/:competitorId` | Operativo backend V1 | Desactiva sin borrar histórico. |
| `POST /api/marketing/reports/competition/refresh` | Operativo backend V1 | Refresco de Meta Ads Library + Google Ads Transparency y, solo si está autorizado, del proveedor local. |

Job:

- `competitionSync`, cola `competition_refresh`, schedule por defecto `0 6 * * 1`.
- Variables locales: `GOOGLE_PLACES_API_KEY`/fallbacks no habilitan por sí solos el uso. También deben estar a `true`, con cobertura contractual documentada, `COMPETITION_GOOGLE_PLACES_COMPETITOR_USE_ALLOWED`, `COMPETITION_GOOGLE_PLACES_COMPETITOR_STORAGE_ALLOWED` y `COMPETITION_LOCAL_RANKING_STORAGE_ALLOWED`. El resto de límites `COMPETITION_LOCAL_HEATMAP_*`, cachés runtime y concurrencia solo se aplica después del gate. `COMPETITION_STATIC_MAP_CACHE_TTL_MS` queda retirado.
- Con cualquiera de los tres gates apagado, sugerencias/heatmap devuelven proveedor requerido y cero contenido Places aunque exista API key.
- Si `META_AD_LIBRARY_ACCESS_TOKEN` no está presente, se intenta `META_GRAPH_TOKEN` y después una conexión Meta activa del scope. Si Meta rechaza `ads_archive` con permiso insuficiente, se guarda `status=unavailable` con el error real; esto no debe interpretarse como "sin anuncios activos".
- `COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED=false` desactiva la consulta a Google Ads Transparency sin tocar el resto del informe. Por defecto está activa porque no requiere token, pero siempre se ejecuta con límite bajo y solo en refrescos/syncs.

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
  - conexión propia como override explícito de clínica, también cuando pertenece a un grupo;
  - CTA contextual que conecta exactamente el scope elegido y nunca promociona una autorización clínica al grupo;
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

### Comparación Meta-facing

Las comparaciones de contrato entre catálogo, overrides locales y plantillas remotas normalizan el `BODY.text` antes de decidir si hay cambio real de contenido. En concreto, se eliminan saltos y espacios finales para evitar crear variantes `_vNN` nuevas cuando el único cambio es whitespace no visible para el paciente.

`findSameContractRemoteTemplate(...)` prioriza equivalentes `APPROVED` frente a `PENDING/IN_REVIEW` y `REJECTED`. Esto evita reutilizar una versión rechazada reciente si ya existe una versión aprobada con el mismo contrato efectivo. La migración `20260628083000-normalize-whatsapp-catalog-body-whitespace` limpia el catálogo local de las plantillas operativas afectadas por saltos finales (`clinicaclick_confirmacion_datos_cita_hoy` y `clinicaclick_confirmacion_datos_cita_reprogramada_24`).

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
2. activo compartido asignado explícitamente a la clínica mediante `GroupAssetClinicAssignments`;
3. asset/configuración heredada del grupo;
4. fallback global de entorno solo para:
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

Resolución de formularios interceptados en webs de grupo:

- manda el contrato estricto de **Routing autoritativo de formularios de grupo (2026-07-13)** documentado más abajo; esta regla sustituye al fallback histórico por dominio o clínica predeterminada para formularios que declaran una sede;
- `IntakeConfig.config.locations` contiene los únicos IDs admisibles; etiquetas públicas y nombres internos solo son aliases de esos IDs, no amplían el scope;
- `clinica_id=0`/`clinic_id=0` es un sentinel técnico y se ignora como pista; la etiqueta humana se obtiene después de `form_submission.fields`/`lead_data`;
- desconocido, ambiguo, inactivo o fuera de grupo devuelve `422 invalid_form_location` **antes** de cualquier fallback, persistencia o evento;
- una coincidencia válida queda auditada como `clinic_match_source=configured_location_label` y conserva en `clinic_match_value` la etiqueta recibida.

Chat y modal telefónico mantienen sus resolutores específicos: el chat usa la sede elegida dentro del flujo configurado y el modal resuelve por el teléfono pulsado. No deben reutilizar el fallback estricto de formularios ni atribuirse la fuente `configured_location_label` si la sede procede de otra señal.

Herencia de configuración web al crear grupos:
- `groupAssets.service.copyClinicIntakeConfigToGroup` copia `IntakeConfig` de clínica a grupo conservando dominios, HMAC y `config` completo.
- `updateGroupConfig` la ejecuta automáticamente si el grupo queda con una sola clínica y todavía no existe `IntakeConfig` de grupo.
- La copia añade `config.group_inheritance` con clínica origen, fecha y motivo.
- Para grupos con varias clínicas no hay migración automática: debe elegirse explícitamente la clínica origen o usar `web_assignment_mode=manual`.
- Script operativo para backfills puntuales:
  - `node scripts/copy-intake-config-to-group.js --clinic=<id> --group=<id> [--overwrite] [--reason=texto]`
- Compatibilidad de snippets antiguos: si una web sigue instalada con `data-clinic-id` pero la clínica pertenece a un grupo con `web_assignment_mode=automatic` y existe `IntakeConfig` de grupo, `GET /api/intake/config?clinic_id=<id>` devuelve la configuración efectiva de grupo. Los `PUT` directos a la configuración individual quedan bloqueados con `409`; debe editarse el grupo.

### Pixel de Meta

Estado actual del producto:

- **no** se crea automáticamente ningún pixel desde ClinicaClick;
- el pixel se selecciona entre los pixels existentes del ad account resuelto;
- si la clínica/grupo no tienen pixel configurado, Meta CAPI puede seguir usando el global del entorno si existe;
- si tampoco existe pixel global, no se envía CAPI y el readiness lo marca como incompleto.

Límite operativo vinculante: Meta CAPI es hoy un envío web **best-effort
inline** cuando existe pixel/activo efectivo. No tiene todavía un outbox
durable, reintentos propios, idempotencia y diagnóstico de entrega equivalentes
al carril Google Data Manager, ni materializa como eventos offline Meta los
hitos CRM `qualified_lead`/`schedule`. Por tanto la UI y la documentación no
deben afirmar paridad Google/Meta ni prometer que todo evento compatible llegará
a Meta. Backlog: outbox durable, retry/backoff, clave idempotente, auditoría y
diagnóstico por terminal, además de eventos CRM offline consentidos.

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

## 2026-07-12 - Routing de leads Google Ads en cuentas compartidas

`ClinicGoogleAdsAccount.clinicaId` no es un destino válido cuando
`assignmentScope = group`: algunas cuentas compartidas conservan ahí una clínica
representativa por compatibilidad histórica.

Para `source = google_ads`, el intake aplica este orden:

1. normaliza `customer_id` o su alias `account_id`;
2. si también llega `campaign_id` o `external_campaign_id`, busca una
   `ExternalCampaignAssignment` activa por la identidad completa
   `google_ads + customer_id + campaign_id` y usa su clínica;
3. si la cuenta es de grupo y no hay assignment, mantiene el lead en scope de
   grupo para que nombre de sede o URL canónica resuelvan la clínica;
4. si esas señales tampoco existen, guarda el lead a nivel de grupo y no lo
   adjudica a la clínica representativa ni al primer centro del grupo.

Las cuentas con `assignmentScope = clinic` siguen resolviendo directamente su
`clinicaId`. Si el mismo `customer_id` está activo en scopes distintos y el
request no aporta contexto suficiente, el resolver lo considera ambiguo.

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
- normalizar nombres con `name_format=auto` por defecto. Si el archivo trae
  `Apellidos, Nombre` o `Apellidos Apellidos Nombre`, se reordena antes de
  validar/importar; si trae columna separada de `apellidos`, se une al nombre;
- ejecutar exclusiones;
- comprobar duplicados;
- crear `LeadIntake` y `LeadAttributionAudit` cuando procede.

La importación manual de leads solo crea entradas `LeadIntake`. No debe crear
citas reales ni disparar automatizaciones de agenda/recordatorios por el hecho
de importar el histórico.

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
- conserva `config.source_detail` aunque no exista `campana_id`.

Caso operativo:

- si `source_detail=reactivacion_pacientes`, backend añade la nota interna `Origen: reactivación de pacientes.` al lead importado;
- esto permite reutilizar el importador de `Marketing > Leads` desde `Marketing > Campañas > Reactivar pacientes` sin crear una tabla paralela prematura.

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

## 2026-04-26 - Reactivación de pacientes: sugerencias iniciales

Endpoint:

- `GET /api/marketing/reactivation/suggestions`

Alcance:

- acepta `clinica_id`, `clinic_id` o `scope=group:<id>`;
- calcula sugerencias por tratamiento a partir de `CitasPacientes`;
- considera la última cita por paciente y tratamiento;
- aplica umbrales por tratamiento:
  - ortodoncia: 6 meses;
  - higiene/periodoncia: 9 meses;
  - capilar: 12 meses;
  - resto: 6 meses;
- excluye como no enviables los pacientes con cita futura o teléfono no válido.

Limitación:

- no crea listas persistentes;
- no congela audiencia;
- no encola WhatsApp;
- es una fuente de sugerencias para el MVP de `Marketing > Campañas > Reactivar pacientes`.

## 2026-04-27 - Roadmap backend de campañas: endpoints a preparar

> **Estado:** contrato de backlog. No implementar envío real ni publicación Meta/Google sin las tablas, auditoría, permisos y colas descritas abajo.

### 1. Reactivación de pacientes y listas

Rutas bajo `/api/marketing/reactivation`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/suggestions` | Operativo con datos reales por scope/tratamiento. Si existen playbooks admin activos de `reactivate_patients`, usa su `reactivation_preset`, devuelve `treatment_id`, la automatización asociada y mantiene el preset visible aunque el scope tenga cero candidatos. |
| GET | `/lists` | Listar listas de reactivación por scope, estado y objetivo. |
| POST | `/lists` | Crear lista `draft` desde filtros, manual o importación real. Para `source=import` acepta `import_rows`, `column_mapping`, `custom_fields_schema` e `import_file_name`, relaciona/crea pacientes y persiste items. |
| GET | `/lists/:id` | Detalle con resumen, field schema, plantilla y contadores calculados en backend. |
| PATCH | `/lists/:id` | Editar condiciones propias de clinica (`source=manual_list`) mientras no tenga envios registrados; recalcula items, contadores y refresca la automatizacion visual si estaba activa. |
| POST | `/lists/:id/import/preview` | Subir CSV/XLSX, detectar columnas, sugerir mapeos y validar filas sin persistir items finales. |
| POST | `/lists/:id/import/commit` | Persistir importación, mapping e items calculados. |
| POST | `/lists/:id/mappings/apply` | Aplicar mapeos generales: tratamientos, clínicas, estados, enums y fechas. |
| POST | `/lists/:id/rebuild` | Recalcular cruces con pacientes, citas, LeadIntake, opt-out, cuarentena y duplicados. |
| DELETE | `/lists/:id` | Eliminar listas `draft`; archivar listas ya preparadas/activas para ocultarlas del listado principal sin perder auditoría ni datos. |
| GET | `/lists/:id/items` | Items paginados con filtros por estado, motivo y campos faltantes. |
| PATCH | `/lists/:id/items/:itemId` | Operativo para `action=exclude|restore`: excluye/restaura manualmente un paciente de lista, valida scope, recalcula contadores y audita en `MarketingPatientContactEvents`. |
| POST | `/lists/:id/template-preview` | Calcular variables requeridas, pacientes sin datos y preview antes de aprobar. |
| POST | `/lists/:id/approve` | Congelar audiencia y plantilla. |
| POST | `/lists/:id/schedule` | Crear cola cancelable si todos los gates están OK. |
| POST | `/lists/:id/cancel` | Cancelar lista o cola antes de ejecución efectiva. |
| GET | `/lists/:id/events` | Auditoría por item/contacto/mensaje/respuesta/error. |

Tablas operativas:

- `MarketingPatientLists`
- `MarketingPatientListItems`
- `MarketingPatientContactEvents`

Tablas pendientes:

- `MarketingPatientListImports`
- `MarketingPatientListFieldDefinitions`

#### Importación histórica de pacientes

La importación histórica se usa en `Marketing > Campañas > Conseguir reseñas` y en el flujo de reactivación para convertir un CSV/XLSX clínico en audiencia operativa. No es un importador de leads ni una carga genérica de contactos comerciales.

Puntos de entrada:

- Frontend: `front-dev/src/app/modules/admin/apps/marketing/campanas/campanas.component.ts` y `.html`, bloque de importación de pacientes históricos.
- Backend: `back-dev/src/services/marketingReactivation.service.js`, principalmente `buildImportedItemPayloads`.
- API: `POST /api/marketing/reactivation/lists` con `source=import`, `import_rows`, `column_mapping`, `name_format`, `treatment_mappings`, `custom_fields_schema` e `import_file_name`.

De dónde bebe:

- CSV/XLSX subido por el usuario, parseado en frontend con `xlsx`.
- Mapeo de columnas elegido por el usuario o inferido por alias (`Nombre`, `Móvil`, `Descripción Tratamiento`, `Fecha Fin Realización`, `Ubicación de la Clínica`, etc.).
- Catálogo de `Tratamientos` para enlazar tratamientos existentes o crear nombres importados si se permite.
- `Clinicas`/grupo seleccionado para resolver sede. En scope de grupo, una sede parcial como `eixample` solo se asigna si la coincidencia es única.
- `Pacientes` y `PacienteClinicas` para localizar fichas existentes por teléfono móvil dentro del scope.
- `CitasPacientes` para excluir pacientes con cita futura y para crear contexto histórico completado.
- `MarketingContactOptOut` para bajas comerciales/no contactar.

Qué persiste:

- `Pacientes`: crea ficha real si el móvil no existe en el scope. Si existe, reutiliza la ficha y solo completa campos vacíos (`nombre`, `apellidos`, móviles/fijo, email); no sobrescribe datos ya informados.
- `PacienteClinicas`: vincula el paciente a la sede efectiva si procede.
- `PatientCustomFields`: guarda columnas extra importadas como campos personalizados de paciente/lista, completando solo valores vacíos en importaciones sucesivas.
- `Tratamientos`: puede crear tratamientos importados cuando no hay match y la importación lo permite. En importaciones de reseñas el tratamiento es opcional; si no viene informado, no se crea un tratamiento artificial.
- `CitasPacientes`: crea una cita histórica completada con `motivo = "Importación de pacientes para reactivación"` y título `Histórico: ...` para poder medir última atención/tratamiento cuando existe tratamiento enlazado. Estas citas son contexto, no agenda activa. Si el import de reseñas no trae tratamiento, se conserva la fecha en la lista pero no se crea cita histórica con tratamiento falso.
- `MarketingPatientLists` y `MarketingPatientListItems`: congelan la audiencia importada, estado de cada fila, motivos de exclusión y variables disponibles para la campaña.
- `MarketingPatientContactEvents`: audita acciones posteriores de exclusión/restauración/envío.

Reglas de seguridad operativa:

- La importación histórica no crea `Lead`.
- Las citas históricas importadas no deben disparar `appointment_created`, recordatorios de cita ni automatizaciones de agenda. El runtime las omite por `motivo = "Importación de pacientes para reactivación"` o título `Histórico:`.
- En reseñas, el tratamiento no es obligatorio: bastan nombre, móvil, fecha de atención y sede si el scope es de grupo. En reactivación clínica el tratamiento sigue siendo necesario para aplicar reglas de inactividad por tratamiento.
- Las importaciones de reseñas envían `create_missing_treatments=false`: un valor corto no reconocido en una columna de tratamiento puede conservarse como contexto, pero no crea entradas nuevas en el catálogo. El mapeo de esa columna está desactivado por defecto y el texto libre de más de 255 caracteres se ignora; nunca debe llegar a un `INSERT` de `Tratamientos` ni a una variable de campaña.
- Las filas sin móvil, con teléfono inválido, duplicadas, con sede ambigua/no reconocida, baja comercial o cita futura quedan excluidas con motivo visible; no bloquean la importación completa.
- Si se reimporta el mismo paciente, el teléfono móvil manda. El paciente se actualiza de forma conservadora: se completan huecos, no se machacan datos existentes.

Nombre y apellidos:

- Si el fichero trae columnas separadas (`Nombre` + `Apellidos`), el backend usa ambas.
- Si solo trae una columna de nombre completo, `name_format` decide cómo partirlo. En el flujo de reseñas la UI no debe pedir esta decisión al usuario: se infiere al leer el fichero y se manda el formato calculado al backend.
  - `auto`: invierte `Apellidos, Nombre` si hay coma; sin coma intenta detectar orden `Apellido Nombre`/`Apellidos Nombre` por nombres de pila frecuentes, respeta nombres compuestos y usa formato `Nombre Apellidos` si parece estándar.
  - `first_last`: `Nombre Apellidos`.
  - `last_comma_first`: `Apellidos, Nombre`.
  - `last_last_first`: `Apellido Nombre` o `Apellidos Apellidos Nombre`.
  - `full`: no separa, usa el texto completo como nombre.
- Si el CSV solo trae nombre de pila, como exports donde `Nombre = ABEL/ABRIL/ADRIA`, el front infiere `full`; se importa el nombre pero no se completan apellidos porque no existen en el archivo. La UI debe avisarlo en el paso de mapeo sin bloquear la importación.

Reglas:

- Los campos extra importados van en JSON tipado, no en columnas dinámicas.
- Si el frontend envia `custom_fields_schema` con `source_column`, solo esas columnas extra se guardan como variables personalizadas de lista; la `key` se persiste en formato simple para plantillas, por ejemplo `{{importe_presupuesto}}`.
- Los tratamientos importados deben poder mapearse al catálogo existente o conservarse como campo personalizado.
- Antes de encolar se excluyen cita futura, opt-out/no contactar, teléfono inválido, duplicados, cuarentena y variables personalizadas faltantes.
- Los nombres de pacientes creados/actualizados desde importación se normalizan a formato nombre propio.
- Si la importacion de reactivacion trae nombres en formato `Apellidos, Nombre`, backend debe invertirlos al persistir `Pacientes.nombre`/`Pacientes.apellidos` y al materializar variables de lista. Este caso aparece en CSV historicos de eventos o tratamientos.
- La importacion de pacientes historicos reconoce `phone_landline`/`telefono_fijo` como campo nativo separado de `phone`/`telefono_movil`. `phone` sigue siendo el movil operativo para WhatsApp; `phone_landline` se persiste en `Pacientes.telefono_secundario` cuando se crea el paciente o cuando el paciente existente no lo tenia informado.
- La importacion de pacientes historicos para resenas reconoce alias habituales de CSV clinico: `descripcion_tratamiento`/`nombre_tratamiento` como tratamiento, `fecha_fin_realizacion`/`fecha_fin_tratamiento`/`fecha_inicio_tratamiento` como fecha clinica y `ubicacion_de_la_clinica`/`ubicacion_clinica` como sede. Si hay fecha de inicio y fin, se prioriza la fecha de fin/realizacion. En scope de grupo, una sede abreviada como `eixample` solo se asigna automaticamente si coincide con una unica clinica del grupo; si es ambigua o no existe, la fila queda excluida con motivo.
- La importacion de pacientes historicos para resenas/reactivacion consolida fichas reales en `Pacientes`, no leads. Si el telefono ya existe en la clinica o en una clinica vinculada del grupo, se reutiliza la ficha y solo se completan campos vacios (`nombre`, `apellidos`, `telefono_movil`, `telefono_secundario`, `email` y campos personalizados importados vacios); no se sobrescriben datos clinicos o administrativos ya informados. La respuesta del import devuelve `import_result.patient_summary` con pacientes creados, pacientes que ya existian y fichas completadas para que la UI pueda explicarlo.
- La importacion de reactivacion solo debe crear pacientes cuando el archivo representa historico clinico/tratamiento de la clinica y se necesita evaluar condiciones de reactivacion. No debe usarse como importador generico de contactos comerciales.
- Alias de importación soportados para nombre completo: `nombre`, `nombre_completo`, `nombre_y_apellidos`, `nombre_apellidos`, `nombre_paciente`, `full_name`.
- Los nombres de listas de reactivacion autogeneradas no deben depender del nombre de archivo. Backend compone `Reactivacion · tratamiento · condicion` cuando `source=import` o cuando recibe nombres legacy tipo `Importacion <archivo>`; `criteria.import_file_name` conserva la trazabilidad del fichero.
- `GET /reactivation/lists` omite listas `archived` por defecto.
- `PATCH /reactivation/lists/:id` solo permite editar condiciones creadas por la clinica (`manual_list`). Las listas de catalogo/importacion no se mutan desde este endpoint para no mezclar presets admin con excepciones locales.
- `POST /reactivation/lists/:id/prepare` no envia mensajes. Si recibe `automation.active=true`, crea/actualiza una plantilla real en `AutomationFlowTemplatesV2` con `trigger_type=patient_reactivation`, `entry_node_id=N1` y nodos de solo lectura: activador de reactivacion + accion elegida (`send_whatsapp`, `update_lead_info` o `create_task`).
- `patient_reactivation` esta registrado como trigger V2. Antes de persistir la automatizacion generada desde reactivacion, `marketingReactivation.service` ejecuta una validacion estricta del subconjunto V2 permitido; no debe insertar grafos "a pelo" con tipos o configs fuera de catalogo.
- Si `prepare` recibe `automation=null`, desactiva el flujo `patient_reactivation` asociado por `template_key` cuando existe.
- `patient_reactivation` es representacion operativa/visual para `Automatizaciones`; cliente lo ve en solo lectura y la fuente de verdad sigue siendo la lista de reactivacion.
- En dev se elimino la automatizacion legacy `qa-reactivation-patient-followup-v1` porque usaba `trigger_type=patient_inactive` y nodos obsoletos (`start`, `wait`) incompatibles con V2.
- Sigue pendiente el evaluador periodico de reactivaciones antes de envio real: debe recorrer listas activas por scope con predicados indexables, watermark incremental, lotes, clave idempotente por lista/paciente/condicion y gates justo antes de encolar (opt-out, cuarentena, capping, plantilla aprobada, ventana horaria, cola cancelable). Para reglas con fecha conocida, como presupuesto no aceptado en 7 dias, preferir `JobRequest` programado al crear el presupuesto y cancelarlo al aceptar; el barrido diario queda como red de seguridad, no como scan global.

### 1.1. Envios masivos por listas

Rutas bajo `/api/marketing/bulk-sends`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/campaigns` | Lista campanas `mass_sends` por scope, excluyendo archivadas. |
| POST | `/campaigns` | Crea lista/campana desde importacion, manual o pacientes actuales. Acepta `campaign_name`, `template_usage`, `template_commercial`, `opt_out_text` y `link_tracking` en `criteria`. |
| PATCH | `/campaigns/:id` | Edita borradores/preparadas, asocia plantilla WhatsApp, actualiza tracking, añade contactos a una lista existente con `append_rows`, `column_mapping` y `custom_fields_schema`, o guarda `active_segment_id`. |
| POST | `/campaigns/:id/prepare` | Congela/prepara con plantilla WhatsApp si aplica, sin envio masivo real hasta capping y cola cancelable. |
| POST | `/campaigns/:id/test-send` | Envia una prueba individual con metadata comercial/no comercial para que el opt-out entrante se aplique correctamente. |
| DELETE | `/campaigns/:id` | Archiva la campana/lista. |
| GET | `/r/:token` | Ruta publica de tracking. Registra click de enlace variable y redirige al destino original. |

Reglas:

- `template_usage=promocion` o `template_commercial=true` identifica una comunicacion comercial.
- Solo los mensajes outbound con metadata comercial deben activar baja automatica si el paciente responde con `BAJA`; notificaciones y recordatorios no comerciales no excluyen al contacto de marketing.
- Al crear una plantilla promocional desde campañas, la UI debe guardar el texto principal mas un bloque de baja con la palabra `BAJA`.
- Las plantillas WhatsApp reales exponen `category`/`catalog.category`; la UI lo mapea a `uso=promocion` si Meta devuelve `MARKETING`, y a `notificacion` si no.
- Cuando `whatsapp_templates_sync` detecta una plantilla aprobada y Meta ha cambiado su categoria (por ejemplo de `UTILITY` a `MARKETING`), `marketingBulkSends.enqueueAutoDispatchForApprovedTemplate(...)` actualiza `criteria.template_usage`, `criteria.template_commercial`, `criteria.template_category` y `template_snapshot.category` antes de encolar el envio automatico pendiente por aprobacion.
- Las variables de columnas extra de listas importadas siguen el contrato `custom_fields_schema` y pueden mostrarse como `{{variable}}` al crear la plantilla desde la campana.
- Los segmentos de lista viven en `criteria.segments[]`. Cada segmento define `field`, `operator` (`equals`, `contains`, `not_empty`) y `value`; el backend materializa `count`/`criteria.segment_counts` al editar o preparar la lista.
- Si `prepare` recibe `active_segment_id`, el backend marca `MarketingPatientListItems.selected=true` solo para los items `ready` que cumplen el segmento y el dispatch usa ese subconjunto. Si no hay segmento activo, los items `ready` vuelven a quedar seleccionados.
- En envios masivos, `MarketingPatientList.name` representa el nombre de la lista. El nombre visible de campaña se conserva en `criteria.campaign_name` para permitir vistas separadas de campanas y listas sin crear otra tabla.
- En items importados de `mass_sends`, `MarketingPatientListItems.name` debe representar el nombre de pila/contacto visible. El nombre completo queda en `custom_fields.nombre_completo` para tablas ampliadas, variables y fallback de QuickChat.
- Las listas importadas/manuales de `mass_sends` no crean ni actualizan `Pacientes`, pero `POST /campaigns` cruza cada item con pacientes existentes del scope por telefono/email. Si hay match, guarda `MarketingPatientListItems.paciente_id` y mezcla en `custom_fields` variables estándar del paciente y `PatientCustomFields` existentes.
- Si un contacto externo responde por WhatsApp, el webhook resuelve la conversacion por telefono. Si existe paciente se vincula `patient_id`; si no existe, se conserva contacto externo y el opt-out comercial se aplica por `phone_digits`.
- QuickChat no debe crear `Paciente` ni `LeadIntake` para poder nombrar un contacto externo de una lista. Cuando una conversacion WhatsApp no tiene `patient_id` ni `lead_id`, el backend puede hidratar `conversation.contact` desde `MarketingPatientListItems` por `conversation_id` o telefono normalizado.
- `GET /api/conversations` pagina por `limit/offset` y devuelve `X-Has-More`/`X-Next-Offset`; QuickChat debe consumirlo con scroll infinito. Tambien devuelve `X-Total-Unread`, calculado sobre todo el scope accesible y no sobre la pagina cargada, para que el badge de pendientes no dependa de la paginacion. Desde 2026-07-21 «pendiente» significa inbound posterior al último outbound real, no lectura por usuario. La pestaña visible `Otros` mantiene `filter=leads` por compatibilidad, pero backend incluye `lead_id` y conversaciones externas de campañas presentes en `MarketingPatientListItems.conversation_id`, excluyendo siempre conversaciones con `patient_id`.
- `GET /api/conversations` y `X-Total-Unread` aplican ACL por categoría: conversaciones con `patient_id` requieren `quickchat.read_patients`, `channel=internal` requiere `quickchat.read_team` y conversaciones WhatsApp/externas sin paciente requieren `quickchat.read_leads`. La misma categoría se valida en `GET /api/conversations/:id/messages`, media, marcar leído, envío normal y `send-now`.
- La busqueda de `GET /api/conversations?q=...` debe cubrir pacientes, leads, `contact_id` y contactos externos de listas/campanas (`MarketingPatientListItems.name`, `phone`, `email` y `custom_fields.nombre_completo`). Las busquedas con varias palabras aceptan coincidencia de frase completa o todos los tokens en cualquier campo, para que `Nombre Apellido2` encuentre pacientes con nombre compuesto o dos apellidos. No buscar en todo `Messages.content` desde este endpoint sin un indice/previsualizacion materializada, porque penaliza la bandeja paginada de QuickChat.
- Las coincidencias de contactos externos de listas/campanas solo se aplican a conversaciones sin `patient_id` ni `lead_id`. Si una fila historica de `MarketingPatientListItems.conversation_id` queda apuntando a una conversacion que despues se canoniza como paciente, la busqueda debe priorizar el paciente/lead real y no devolver ese chat por el nombre importado antiguo.
- `POST /campaigns/:id/prepare` y `/test-send` validan todas las variables de la plantilla real contra los items `ready`; si falta algun valor devuelven `409` con `details.missing_variables[]` y no usan ejemplos de plantilla como fallback operativo.
- `GET /campaigns/:id`, `/campaigns/:id/recipients` y `/campaigns/:id/dispatch` hacen una reconciliacion ligera antes de responder: leen `Messages.metadata.wa_status_history`, materializan `sent/delivered/read/failed/replied` en `MarketingPatientListItems`, refrescan contadores y devuelven `report` agregado. Esto corrige informes atrasados sin cargar toda la lista en frontend.
- El `report` de envios masivos expone `opt_out_share` (bajas sobre contactos realmente enviados), `read_hours` (lecturas por hora), clicks de enlaces, clicks por contacto y pais aproximado de click. Los listados detallados de abiertos/no abiertos/respuestas/bajas/clicks deben seguir saliendo de endpoints paginados, no de arrays completos en UI.
- Si un contacto responde `BAJA` tras un outbound comercial, `MarketingContactOptOut` se crea para todas las clinicas del mismo `grupoClinicaId`. En contactos ya enviados no se cambia `status` a excluido: se mantiene el envio histórico y se marca `dispatch_status=replied`, `replied_at` y `opt_out_at`. En contactos pendientes/futuros sí se marca `excluded_opt_out`.
- Para QA manual se permite revocar una baja dejando `MarketingContactOptOut.status=revoked`; si la revocacion referencia el mismo `inbound_message_id`, la reconciliacion posterior no reactiva esa baja antigua.
- `criteria.link_tracking.enabled=true` solo transforma variables cuyo valor final sea URL `http/https`. URLs fijas dentro de una plantilla aprobada no se reescriben sin nueva aprobación de Meta.
- Meta Cloud API no documenta un webhook por destinatario para reporte de spam. El backend expone `spam_reports_supported=false`; la calidad se calcula con bajas, lecturas y calidad/limites WABA cuando estén disponibles.

### 1.2. Automatizaciones basadas en listas

Rutas bajo `/api/marketing/list-automations`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/` | Listar automatizaciones basadas en listas por scope, objetivo y estado. |
| POST | `/` | Crear automatización desde lista/campaña, condiciones, acción y capping. |
| GET | `/:id` | Detalle con lista origen, reglas, próxima reevaluación, métricas y último resultado. |
| PATCH | `/:id` | Editar reglas mientras esté pausada o en draft. |
| POST | `/:id/preview` | Recalcular candidatos sin guardar ni enviar. |
| POST | `/:id/run-now` | Ejecutar reevaluación manual y crear lista/snapshot si procede. |
| POST | `/:id/pause` | Pausar reevaluación automática. |
| POST | `/:id/resume` | Reactivar reevaluación automática. |
| GET | `/:id/metrics` | Métricas de listas generadas, envíos, respuestas, citas y conversiones atribuidas. |

Regla operativa:

- La reevaluación normal debe ejecutarse por job cada 24h o bajo demanda con preview.
- El job no debe enviar directamente: solo crea snapshot/lista o encola si todos los gates de envío están aprobados.

### 2. Campañas gestionadas Meta/Google

Rutas bajo `/api/marketing/managed-campaigns`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/` | Listar specs gestionadas visibles por scope. |
| POST | `/` | Crear `ManagedPaidCampaignSpec` en `draft`; no publica en plataforma. |
| GET | `/:id` | Detalle completo para cliente/admin. |
| PATCH | `/:id` | Editar spec en `draft` o `changes_requested`. |
| POST | `/:id/submit-client-review` | Enviar a visto bueno del cliente si aplica. |
| POST | `/:id/submit-admin-review` | Pasar a revisión ClinicaClick. |
| POST | `/:id/request-changes` | Solicitar cambios y registrar motivo. |
| POST | `/:id/approve-to-launch` | Aprobar internamente; todavía no crea campaña real. |
| POST | `/:id/launch` | Crear/sincronizar en Meta/Google tras `approved_to_launch`. |
| POST | `/:id/pause` | Pausar en ClinicaClick y plataforma si existe `platform_ref`. |
| POST | `/:id/sync` | Refrescar estado, IDs externos, incidencias y métricas. |
| GET | `/:id/metrics` | Métricas normalizadas y contribución a LeadIntake/citas/tratamientos. |

Familias V1:

- Meta: `meta_reach`, `meta_instant_form`.
- Google: `google_search`, `google_pmax`.

Regla: no llamar a APIs de Meta/Google hasta `approved_to_launch`.

### 3. Audiencias manuales y automáticas

Rutas bajo `/api/marketing/audiences`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/` | Listar audiencias por scope, canal, `source_type` y elegibilidad. |
| POST | `/preview` | Calcular tamaño, consentimiento, sensibilidad y elegibilidad sin guardar. |
| POST | `/` | Crear definición interna de audiencia. |
| GET | `/:id` | Detalle con reglas, tamaño, policy status y plataformas permitidas. |
| PATCH | `/:id` | Editar reglas mientras no esté bloqueada por uso activo. |
| POST | `/:id/refresh` | Recalcular tamaño/eligibilidad. |
| GET | `/:id/eligibility` | Explicar por canal si está `available`, `warning` o `blocked`. |
| POST | `/:id/platform-segment` | Crear segmento en Meta/Google solo si elegible y si la campaña está aprobada para lanzamiento. |

Notas Google:

- Google Ads soporta técnicamente segmentos de visitantes web por URL/reglas con Google tag.
- Para `website_visit` y `treatment_page_visit`, el backend debe validar Google tag, consentimiento, tamaño mínimo y política antes de permitir targeting.
- Si el contenido/campaña entra en categoría sensible de salud y la política bloquea segmentos propios, devolver `blocked` con motivo claro.

### 4. Bandeja de aprobaciones admin

Rutas bajo `/api/admin/campaign-reviews`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/summary` | Contadores para badge/notificación. |
| GET | `/` | Cola paginada con filtros por clínica, grupo, objetivo, entidad, estado y prioridad. |
| GET | `/:id` | Detalle de revisión y deep-link a entidad. |
| POST | `/:id/assign` | Asignar responsable. |
| POST | `/:id/approve` | Aprobar recurso/campaña/envío. |
| POST | `/:id/request-changes` | Pedir cambios con motivo. |
| POST | `/:id/block` | Bloquear por política, permisos, tracking, audiencia o recursos. |

### 5. Variables de plantillas

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/marketing/template-variables` | Variables estándar disponibles por scope/contexto. |
| GET | `/api/marketing/lists/:listId/template-variables` | Variables personalizadas disponibles en una lista. |
| POST | `/api/marketing/templates/:templateId/usage-preview` | Validar plantilla contra contexto/lista/pacientes y devolver excluidos por variables faltantes. |

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

Resolución operativa:

1. si la clínica tiene un `whatsapp_phone_number` activo con `assignmentScope=clinic`, ese número gana siempre;
2. si no lo tiene, se hereda el `whatsapp_phone_number` activo del grupo con `assignmentScope=group`;
3. los números `unassigned` se pueden mostrar para reasignación, pero nunca deben usarse para enviar ni para encolar plantillas.

Excepción de sede dentro de un grupo:

- conectar un número desde `/ajustes?action=connect_whatsapp&assignment_scope=clinic&clinic_id=<id>` debe crear/actualizar el activo como propio de esa clínica;
- conectar un número propio de clínica no modifica el WhatsApp de grupo ni el resto de sedes;
- si ya existía otro número propio para la misma clínica, se desasigna antes de activar el nuevo para evitar dos números efectivos compitiendo;
- `POST /api/whatsapp/phones/:phoneNumberId/unassign` desasigna sin desconectar Meta: deja el teléfono/WABA como `unassigned` y permite que la clínica vuelva a heredar el grupo;
- `DELETE /api/whatsapp/phones/:phoneNumberId` sigue siendo acción destructiva de desconexión/desactivación y no debe usarse para "volver a usar el grupo".

Plantillas:

- `assignPhone` y el callback de Embedded Signup encolan `whatsapp_template_create` para el WABA conectado con el scope resultante (`clinic` o `group`);
- las plantillas aprobadas en el WABA de grupo no se copian al WABA propio de una sede: el nuevo WABA debe crear/enviar a revisión sus propias plantillas;
- los envíos futuros resuelven el teléfono efectivo por clínica en runtime. Jobs ya encolados que incluyan `clinicConfig` antiguo pueden conservar el número previo; si hace falta corte estricto, se debe reencolar o cancelar la cola pendiente de esa clínica.

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
- el endpoint `POST /api/whatsapp/messages` exige `auth`, `clinic_id`, membresía
  activa de staff sobre esa clínica y acceso al activo WhatsApp efectivo; esta
  validación también se aplica al texto libre;
- si `POST /api/whatsapp/messages` usa plantilla, el backend resuelve una fila
  activa `APPROVED` del WABA, permite solo catálogo/sistema, una plantilla del
  propio autor o una plantilla histórica no atribuida dentro de su scope, y
  envía el `name`/`language` canónico persistido, sin confiar en esos valores
  aportados por el cliente;
- `POST /api/conversations/:id/messages` aplica asimismo `is_active=true`,
  `status=APPROVED` y la política de sistema, autor o histórico acotado antes de
  encolar una plantilla;
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

Nota operativa:

- `SocialAdsEntities.peak_frequency` y `peak_frequency_date` se recalculan en la sync de Ads desde `SocialAdsInsightsDaily`.
- No usar `GROUP_CONCAT` para resolver la fecha del pico: con históricos largos MySQL puede truncar el agregado (`Row ... was cut by GROUP_CONCAT()`), dejando warnings y picos parciales.
- La consulta debe resolver la fecha con subconsulta ordenada por `frequency DESC, date DESC`, manteniendo el cálculo en BD y evitando trabajo en frontend.

## 2026-03-24 - Cron y variables de entorno operativas

Los horarios efectivos de sincronización salen de `src/jobs/sync.jobs.js`, pero pueden quedar sobreescritos por variables de entorno.

Defaults actuales de interés:

- `JOBS_ADS_SCHEDULE`: `30 0 * * *`
- `JOBS_GOOGLE_ADS_SCHEDULE`: `20 0 * * *`
- `JOBS_WEB_SCHEDULE`: `15 4 * * *`
- `JOBS_ANALYTICS_SCHEDULE`: `45 4 * * *`
- `JOBS_BUSINESS_PROFILE_SCHEDULE`: `10 5 * * *`
- `JOBS_BUSINESS_PROFILE_BACKFILL_SCHEDULE`: `20 5 * * 0`
- `JOBS_WEB_EVENTS_AGGREGATE_SCHEDULE`: `*/15 * * * *`
- `JOBS_ADS_MIDDAY_SCHEDULE`: `0 12 * * *`
- `JOBS_WHATSAPP_PHONES_SCHEDULE`: `*/15 * * * *`
- `JOBS_WHATSAPP_TEMPLATES_SCHEDULE`: `*/20 * * * *`
- `JOBS_AUTOMATION_HEALTH_CHECK_SCHEDULE`: `0 10,16 * * *`
- `WHATSAPP_PROPAGATE_RESYNC_DELAY_MINUTES`: `12`
- `WHATSAPP_TEMPLATE_AUTO_RESUBMIT_ENABLED`: `true`
- `WHATSAPP_TEMPLATE_AUTO_RESUBMIT_PENDING_MINUTES`: `60`

Ventanas y límites asociados:

- `ADS_SYNC_INITIAL_DAYS`
- `WEB_EVENTS_AGGREGATE_DAYS`: días recientes a reagregar en cada pasada, por defecto `3`.
- `WEB_EVENTS_RETENTION_DAYS`: retención de `WebEvents` brutos, por defecto `120`.
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
- `JOBS_AUTOMATION_HEALTH_LOOKBACK_HOURS`
- `JOBS_AUTOMATION_HEALTH_STALE_RUNNING_MINUTES`
- `JOBS_AUTOMATION_HEALTH_OVERDUE_GRACE_MINUTES`
- `JOB_SCHEDULER_RETRY_BASE_DELAY_MS`
- `JOB_SCHEDULER_RETRY_MAX_DELAY_MS`
- `JOB_SCHEDULER_BACKGROUND_INTERVAL_MS`: frecuencia del drain exclusivo de integraciones, `5000` ms por defecto.
- `JOB_REQUEST_ENQUEUE_UNIQUE_TRANSACTION_RETRIES`
- `SYNC_PROVIDER_HTTP_TIMEOUT_MS`: timeout de las llamadas HTTP realizadas por los sync, `30000` ms por defecto.
- `META_PROVIDER_HTTP_TIMEOUT_MS`: override para los helpers de métricas Meta, hereda el anterior.
- `GOOGLE_ADS_HTTP_TIMEOUT_MS`: override de Google Ads; nunca debe volver a `0` (sin límite).

Regla operativa:

- cambiar el default en código no modifica producción/integración si la variable ya existe en `.env` o en PM2;
- si se ajusta el cron, hay que revisar también el valor efectivo en entorno y reiniciar con actualización de variables si aplica.

Perfil de Empresa Google:

- `GET /oauth/google/local/locations` usa Business Information API con `readMask`; Google rechaza la llamada sin ese parámetro y no deben tragarse esos errores como "0 fichas";
- el `readMask` debe incluir `regularHours`, `specialHours`, `moreHours`, `serviceItems` y `latlng`. Sin esos campos, la UI no puede mostrar horario/servicios reales y Competencia no puede reutilizar el ancla geográfica persistida;
- `POST /oauth/google/local/map-locations` guarda `ClinicBusinessLocations`, conserva `raw_payload.accountName` y encola `business_profile_backfill_locations`;
- `businessProfileSync` refresca primero los detalles de la ubicación en Business Information API (`/v1/locations/:id`) para actualizar horario, categoría, teléfono, servicios, coordenadas y metadatos. También lista medios con My Business Media API. Si un bloque auxiliar falla, no debe borrar datos previos ni abortar los demás; su timestamp solo avanza si terminó;
- `businessProfileSync` usa la Google Business Profile Performance API para métricas recientes y las rutas v4 de My Business (`mybusiness.googleapis.com`) para reseñas/publicaciones;
- `businessProfileReviewsSync` es el refresco ligero para conversión de reseñas: por defecto corre cada 15 minutos (`JOBS_BUSINESS_PROFILE_REVIEWS_SCHEDULE`, configurable), solo llama a la API v4 de reseñas, limita páginas con `LOCAL_REVIEWS_SYNC_MAX_PAGES` (5 por defecto) y solo encola conciliación para reseñas nuevas en esa pasada. El sync completo diario sigue siendo el que consolida métricas, publicaciones y reintentos amplios;
- el job persiste métricas, reseñas y posts en sus tablas, y servicios/medios normalizados dentro del `raw_payload` de `ClinicBusinessLocations`. Las fusiones parciales deben serializarse para no perder claves concurrentes;
- `BusinessProfilePosts.summary`, `call_to_action_url` y `media_url` deben ser `TEXT`; Google puede devolver publicaciones o URLs más largas que 1024 caracteres;
- si falta `raw_payload.accountName`, Google devuelve 403/scope insuficiente o `mybusiness.googleapis.com` no está habilitada en el proyecto, la ficha queda con `sync_status=error`; no debe mostrarse como "0 reseñas/publicaciones" completado.
- `GET /api/local/clinica/:clinicaId/status` proyecta `syncStatus`, timestamps, teléfono, web, dirección, horario, categorías y origen de asignación; no expone `rawPayload` completo;
- `GET /api/local/clinica/:clinicaId/dashboard` es la carga inicial agregada de `Marketing > Perfil Google`. Los endpoints individuales `overview|timeseries|seasonality|reviews|posts|content|review-insights` quedan operativos; reseñas/posts aceptan `limit/offset`, reseñas añade filtros y ambos devuelven `total`;
- `POST /api/local/clinica/:clinicaId/photos` publica exclusivamente un `PublicMediaAsset` público/no clínico autorizado para esa clínica.

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
  - Debe estar `true` en un solo proceso por `JOB_RUNTIME_NAMESPACE`. Las réplicas API del mismo namespace deben llevarlo a `false`; `resetRunningJobs()` no implementa ownership ni heartbeat multi-worker.
- `JOBS_CRON_LEADER=true`: este runtime es el que manda y arranca `metaSyncJobs.start()`.
- `JOBS_CRON_LEADER=false`: este runtime no debe encolar cron jobs periódicos.
- Los endpoints administrativos que arrancan o reinician `metaSyncJobs` deben rechazar runtimes no líderes (`cron_not_leader`). Parar jobs se permite para limpiar un runtime que se haya quedado arrancado por error.
- `node-cron` v4 arranca las tareas creadas con `cron.schedule()` al registrarlas, aunque se pase `scheduled:false`. Por eso `src/jobs/sync.jobs.js` debe llamar a `job.stop()` justo después de registrar cada job y dejar que solo `metaSyncJobs.start()` los active. Si se quita ese `stop()`, `dev` vuelve a duplicar cron aunque `JOBS_CRON_LEADER=false`.

#### Orquestación durable única de tareas periódicas (2026-07-13)

Los 30 horarios de `src/jobs/sync.jobs.js` comparten el mismo contrato. El catálogo canónico `src/config/scheduledJobCatalog.js` relaciona nombre visible, tipo de `JobRequest`, prioridad, método `execute*`, payload por defecto, zona horaria y excepciones explícitas de intentos.

- `node-cron` no ejecuta `execute*`: únicamente llama a `enqueueScheduledJob()` para materializar un `JobRequest` con `payload.__runtime_namespace`;
- el scheduler de `JobRequests` reclama únicamente tipos presentes en `JOB_HANDLERS`; el executor resuelve el método declarado por el catálogo y conserva los métodos `execute*` como implementación de negocio, incluidos sus `SyncLog` o reportes persistidos cuando correspondan;
- el endpoint manual de jobs consulta el mismo catálogo y usa `enqueueUniqueJobRequest`. La deduplicación se hace por `type + runtime + alcance`, guardado como `payload.__dedupe_scope`: un barrido global no suprime otro dirigido a una clínica/grupo/mapeo, pero dos solicitudes sobre el mismo conjunto sí se consolidan;
- la deduplicación considera activos `pending`, `queued`, `running` y `waiting`. La lectura y creación se ejecutan en una transacción `SERIALIZABLE`; ante el deadlock posible de dos inserciones simultáneas sobre una fila aún inexistente, se reintenta la transacción completa (`JOB_REQUEST_ENQUEUE_UNIQUE_TRANSACTION_RETRIES`, 3 por defecto). Un job terminal no bloquea el siguiente ciclo. El índice `idx_job_requests_type_status_created_at`, creado por la migración `20260713130000-add-job-request-scheduler-index.js`, evita escanear toda `JobRequests` para cada disparo;
- `queued` es un estado reclamable real, igual que `pending` y `waiting` vencido. Un `waiting` futuro no puede saltarse su `next_run_at` ni siquiera mediante `triggerImmediate()`;
- un fallo devuelto o lanzado pasa a `waiting` con backoff exponencial (`JOB_SCHEDULER_RETRY_BASE_DELAY_MS`, 60 s por defecto; `JOB_SCHEDULER_RETRY_MAX_DELAY_MS`, 30 min por defecto) mientras `attempts < max_attempts`. Al agotar intentos queda `failed`;
- en el arranque, `start()` espera a que `resetRunningJobs()` termine antes de instalar timers o iniciar el primer drain. Si la BD falla, mantiene el worker no-ready y reintenta continuamente con backoff exponencial acotado (`JOB_SCHEDULER_STARTUP_RETRY_BASE_DELAY_MS`, 1 s por defecto; `JOB_SCHEDULER_STARTUP_RETRY_MAX_DELAY_MS`, 30 s por defecto); `stop()` cancela la espera. Devuelve a `waiting` únicamente jobs interrumpidos con intentos disponibles y terminaliza como `failed` los que ya los habían agotado. `triggerImmediate()` comparte ese gate de readiness, por lo que tampoco puede reclamar durante el reset;
- los 30 tipos del catálogo y las seis integraciones dirigidas (`meta_ads_backfill_for_sites`, `web_backfill_for_sites`, `analytics_backfill_properties`, `business_profile_backfill_locations`, `whatsapp_template_sync_delayed`, `marketing_competition_heatmap_refresh`) se ejecutan en un **único carril background global y secuencial**. Las prioridades critical/standard siguen atendiendo CRM, automatizaciones y recordatorios sin esperar a un backfill largo, pero dentro de integraciones un backfill largo sí puede retrasar Diagnostics, revisiones y el resto de syncs: se prioriza exclusión/durabilidad sobre latencia. `automation_whatsapp_quiet_send` permanece en el carril standard/high para no esperar a un backfill. El drain adquiere además un advisory lock MySQL `GET_LOCK` ligado a una conexión para impedir que dos procesos drenen simultáneamente ese carril; el crash de la conexión libera el lock. Este lease es defensa adicional, **no habilita HA ni sustituye el contrato de un solo worker JobRequest por namespace**, porque el reset de arranque no tiene ownership/heartbeat. Un disparo inmediato de integración se une al mismo drain coalescido; no reclama por ID ni puede solapar modos mutables recent/backfill;
- OAuth de Analytics y los endpoints dirigidos encolan sus tipos `*_for_*` y el executor conserva el array exacto de `mappings`, incluso si contiene varias clínicas. `node src/scripts/backfill_ads.js` solo encola en el runtime configurado: no arranca un scheduler auxiliar, no resetea `running` ni compite con el backend;
- estos 36 tipos de background —30 periódicos y seis integraciones dirigidas— no usan el timeout genérico basado en `Promise.race`: esa técnica no cancela el handler original. En su lugar todas las llamadas HTTP del sync usan instancias Axios locales con timeout finito y Google Ads tiene un default no nulo. Así un socket colgado se cancela en el proveedor sin mutar el singleton Axios del resto del backend. Para jobs no background que aún usan el timeout genérico, un timeout es terminal y `retryable=false`;
- los barridos por elementos nunca convierten un fallo total en éxito: `eligible > 0`, `processed = 0` y errores produce `failed` reintentable; si hay elementos procesados y errores queda `completed_with_errors` en el resumen durable. `metricsSync` propaga los errores de cada asset en vez de convertirlos en cero silenciosamente;
- toda escritura normal de settlement (`completed`, `waiting` o `failed`) usa compare-and-set `WHERE id=? AND status='running'`. Cero filas es un conflicto ya resuelto: se relee el job y no se sobrescribe el estado más nuevo dejado por reset/cancelación/otra escritura. Si la escritura lanza un error, no se traga: actualiza `workerState.lastError`, incrementa `settlementFailures`, aborta el drain y se propaga. Antes de depender de un reinicio se repite **solo la escritura de estado** con el mismo compare-and-set; si el handler ya terminó, se persiste `completed` sin volver a ejecutarlo. Si la BD sigue caída, el job queda `running` y `resetRunningJobs()` lo recupera al arrancar. `getStatus().systemChecks.settlementPersistence` expone el último fallo y su recuperación;
- `SyncLogs.status` solo admite `pending|running|completed|failed`: una pausa de cuota/uso de Google Ads cierra ese intento como `completed` con `status_report.waiting=true`, motivo, código y `next_allowed_at`; el `JobRequest` conserva el estado durable `waiting` y el `next_run_at` real. Nunca se escribe el enum inválido `waiting` en `SyncLogs`;
- `sync_log_id` se conserva también durante `waiting`/`failed`. Diagnostics Data Manager enlaza el `SyncLog` nada más crearlo para que incluso un fallo o reinicio deje una relación navegable;
- `automation_health_check` y `google_conversion_goal_policy_audit` tratan sus hallazgos funcionales como `retryable=false`: ese es el resultado del barrido y no deben repetir tres veces las mismas notificaciones. Si cualquiera lanza un error técnico, sí conserva los intentos y el backoff durable comunes.
- `intake_quickchat_summary_materialize` pertenece al carril estándar `high`, no al carril background de proveedores. El lead, su audit exacto y el JobRequest nacen en un único commit; el fast path post-commit reclama el mismo ID y cualquier fallo técnico conserva los reintentos/backoff del scheduler. No usa cron, timer propio, BullMQ repeat/delay ni payload con PII.

El monitor de `node-cron` muestra `enqueued`/`already_queued`, `lastEnqueuedAt` y `lastJobRequestId`. No usa `completed` al terminar de encolar: la finalización de negocio pertenece a `JobRequests`/`SyncLogs`.

BullMQ sigue siendo la cola especializada de WhatsApp y otros transportes inmediatos. En tareas como `whatsapp_templates_sync`, el flujo completo es `cron -> JobRequest durable -> execute* -> BullMQ por WABA`; no existe una ejecución de negocio lateral desde el callback cron. Los envíos por horario silencioso y las resincronizaciones diferidas de plantillas no usan `delay` de BullMQ: esperan en `JobRequests` y solo despachan el transporte cuando vencen.

Regresión canónica: `node src/scripts/tests/scheduled_jobs_orchestration.test.js`. Comprueba cobertura exacta de los 33 horarios vigentes, mappings dirigidos —incluidos `marketing_competition_heatmap_refresh`, generación IA, operaciones gestionadas y la reconciliación Web—, alcance de deduplicación, índice/migración, `queued`, separación y exclusión mutua de carriles, advisory lease, monitor de enqueue, clasificación total/parcial, timeouts HTTP, `sync_log_id`, enum de `SyncLogs`, backoff, agotamiento, startup gate/retry/stop y settlements CAS con conflicto. `durable_whatsapp_scheduling.test.js` cubre las dos programaciones puntuales, la ausencia de PII/tokens en sus payloads, el inventario exacto de 63 handlers y el despacho idempotente del transporte. `intake_quickchat_outbox.test.js` añade atomicidad, rollback, idempotencia y reintento del outbox de intake. Los bridges y la retención tienen además `ops_bridge_runner.test.js` y `pm2_log_retention.test.js`.

Importante:

- `jobScheduler.start()` consume y ejecuta `JobRequests`; `metaSyncJobs.start()` solo activa los disparadores que los encolan. No son intercambiables.
- `staging` debe poder ejecutar sus automatizaciones (`appointment_created`, `wait_response`, resumes) aunque no sea el leader de cron.
- Un solo proceso puede consumir cada namespace. Antes de añadir réplicas del backend hay que mantener `JOBS_WORKER_ENABLED=false` en ellas o diseñar ownership/heartbeat; el advisory lock del background no hace seguro el reset global de `running` para múltiples workers.

Configuración operativa actual:

- `pm2-back-staging`: `JOBS_CRON_LEADER=true`
- `pm2-back-dev`: `JOBS_CRON_LEADER=false`
- `pm2-gateway`: `JOBS_CRON_LEADER=false`

Objetivo:

- evitar duplicados de cualquiera de las 30 tareas periódicas, incluida `whatsapp_templates_sync`;
- evitar que `dev`, `gateway` o cualquier runtime secundario compita con `staging` sobre la misma base de datos;
- poder migrar el liderazgo sin tocar código.

### Regla de migración a staging

Cuando `staging` deba convertirse en el runtime que manda los cron jobs:

1. poner `JOBS_CRON_LEADER=false` en el runtime que deja de mandar;
2. poner `JOBS_CRON_LEADER=true` en el runtime que pasa a mandar;
3. reiniciar ambos procesos con actualización de `.env`;
4. revisar `SyncLogs` durante una hora para confirmar que no aparecen duplicados.

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

> **Estado a 2026-07-15:** runtime multi-conexión e inventario efectivo UI
> publicados; migración `1515` aplicada. Google y Meta tienen `connect` y
> `callback` públicos abiertos. El secreto Meta se rotó de forma coordinada en
> dev, staging y gateway sin copiar su valor a Git, logs ni documentación. El
> smoke posterior validó Graph `debug_token`, coincidencia de App ID, firma HMAC
> válida e inválida, grant efectivo de Badalona y emisión pública de un nuevo
> `state`. El token existente continuó válido, por lo que no fue necesaria una
> reconexión OAuth.

### Limitación que originó la migración (contexto histórico)

Antes del resolver por scope, el backend era principalmente **owner-centric**:

- `MetaConnection` y `GoogleConnection` se resuelven por `userId`;
- gran parte de los endpoints de estado, conexión y desconexión usan `findOne({ where: { userId } })`;
- los mappings clínicos (`ClinicMetaAsset`, `ClinicGoogleAdsAccount`, etc.) cuelgan de esas conexiones técnicas.

Ese modelo permitía operar, pero no resolvía correctamente el caso de negocio:

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

El resolver unificado por proveedor es:

- `resolveMetaConnectionForScope(scope)`
- `resolveGoogleConnectionForScope(scope)`

Precedencia del **grant OAuth** vigente:

1. para un scope explícito `clinic`, assignment propia de la clínica;
2. si no existe override clínico ni tombstone clínico, assignment activa del grupo como fallback heredado;
3. para un scope explícito `group`, únicamente la assignment del grupo;
4. fallbacks legacy controlados durante migración, siempre en modo lectura;
5. si no existe ninguna, scope sin conexión.

El resolver no crea ni promueve assignments. Un `map-*`, una consulta de estado o una lectura de activos solo consume la conexión efectiva. El assignment se escribe en el callback OAuth, después de consumir el `state` y revalidar permisos sobre su scope exacto, o al desconectar explícitamente ese scope.

Esta precedencia es distinta de la selección de **activo**, donde el resolver efectivo prioriza mapping propio, asignación compartida explícita y mapping heredado de grupo.

### Regla operativa aplicada

En la implementación activa para Meta y Google:

- la conexión explícita de clínica es un override de esa clínica;
- si no existe override, la vista clínica puede heredar la conexión del grupo;
- la conexión explícita de grupo nunca se resuelve desde una assignment clínica;
- desconectar una clínica crea/desactiva únicamente su scope y no toca hermanas; desconectar el grupo exige permisos sobre todas sus clínicas;
- los mappings permanecen separados del grant y se limpian solo dentro del scope autorizado.

Esto fija una separación explícita:

- **OAuth connection**: propia del scope conectado, con herencia `clinic -> group` solo como fallback de lectura;
- **asset mapping**: define qué activo consume cada clínica y puede ser propio, heredado/compartido de grupo o asignado explícitamente a varias clínicas sin duplicar el activo remoto.

Este resolver debe usarse en:

- `Ajustes > Cuentas conectadas`
- onboarding técnico de campañas
- WhatsApp/Meta
- Google Ads / Search Console / Analytics / Business Profile
- jobs de sync
- reporting y métricas

La superficie que inició la conexión no forma parte de la identidad. Un mapping creado desde `/clinicas`, `Ajustes`, Campañas o Informes pertenece al scope y todos esos consumidores deben obtener el mismo activo efectivo. Un controlador no puede introducir una conexión privada del módulo ni simplificar la lectura a `clinicaId=<seleccionada>` si el modelo admite `assignmentScope=group`.

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

`GroupAssetClinicAssignments` complementa los campos legacy para expresar que un único activo de grupo se asigna a varias clínicas concretas. `clinicaId` puede conservar una clínica primaria por compatibilidad, pero no debe usarse como prueba de exclusividad. La selección efectiva de Google Ads/Meta se centraliza en `effectiveMarketingAssets.service.js`; la conexión en `scopeConnectionResolver.service.js`; la normalización de scope en `clinicScope.js`. Las verticales con resolver propio, como Perfil Google, deben mantener la misma separación entre conexión, mapping y estado de sync.

Contrato de seguridad de mappings OAuth:

- toda clínica destino se autoriza con permiso de escritura antes de resolver la conexión;
- los IDs de GA4, Search Console, Google Ads, Perfil de Empresa y Meta se vuelven a consultar al proveedor; nombres, estados, tokens y metadatos enviados por el navegador no son autoridad;
- en Perfil de Empresa, `is_verified` se deriva del campo vigente `LocationMetadata.hasVoiceOfMerchant`; `verificationState`, `verificationStatus` y `hasBusinessAuthority` solo se leen como compatibilidad de snapshots legacy, nunca como contrato actual de Google;
- `serializeLocation` expone un estado saneado `verification.state=verified|pending|attention|unknown`, `label`, acción y explicación sin filtrar `raw_payload`. Prioriza el diagnóstico persistido de `getVoiceOfMerchantState`, después `metadata.hasVoiceOfMerchant` y por último la columna legacy. Un booleano `false` sin acción no se inventa como pendiente; `verify`, `waitForVoiceOfMerchant`, `resolveOwnershipConflict` y `complyWithGuidelines` sí producen el motivo concreto. Si la columna quedó rezagada pero el snapshot vigente trae `hasVoiceOfMerchant=true`, prevalece la señal del proveedor (caso real detectado en Badalona);
- `normalizeMediaItem` conserva `mediaFormat`, `isVideo` y solo expone `playbackUrl` cuando el `sourceUrl` real tiene un formato de vídeo reconocido. Para `VIDEO`, `googleUrl` es una previsualización según Google, no una URL reproducible. Las categorías se traducen a etiquetas de producto: un `PHOTO/ADDITIONAL` sin descripción se presenta como «Foto de la clínica» y un `VIDEO` nunca recibe una etiqueta de foto;
- la escritura `POST /api/local/clinica/:id/photos` continúa siendo exclusivamente fotográfica (`mediaFormat=PHOTO`, asset `image/*`). El navegador puede confirmar y procesar varias fotos como una tanda, pero cada imagen conserva asset, autorización y publicación independientes;
- Meta nunca devuelve `pageAccessToken` al frontend;
- reemplazar, mover o eliminar un mapping compartido exige escritura sobre su clínica propietaria y todas las consumidoras de `GroupAssetClinicAssignments`; si falta alguna responde `409 asset_in_use` sin mutar;
- desvincular una cuenta Meta Ads individual no borra caches globales por `ad_account_id`, porque pueden seguir siendo consumidos por otra clínica;
- los listados sin scope explícito se filtran por clínicas legibles y los `DELETE` cargan primero el mapping, autorizan su clínica real y solo después resuelven conexión y mutan.

Los callbacks usan un `state` opaco aleatorio, almacenado en Redis con TTL y consumo atómico de un solo uso. El callback vuelve a autorizar en escritura el scope guardado antes del intercambio de código y del `upsert`. `META_APP_SECRET` y los secretos Google proceden exclusivamente del entorno y el flujo falla cerrado si faltan.

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

1. una clínica usa primero su assignment propia y, si no existe ni está bloqueada, consume la conexión compartida del grupo;
2. el resolver nunca promociona una assignment clínica al grupo ni escribe por normalización;
3. un request `assignmentScope=group` consulta exclusivamente el grupo;
4. la elección de un activo propio de clínica puede prevalecer sobre un activo compartido en la capa de mapping.

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

Además de `wt/back-integracion`, hay que integrar el runtime que sirve
`https://autenticacion.clinicaclick.com`: `pm2-gateway` desde
`/home/ubuntu/wt/gateway`.

Si se mueve solo `cc-back` y no se mueve el auth runtime:

- los callbacks OAuth pueden seguir en lógica antigua;
- `connection-status` puede no reflejar el modelo por scope;
- `disconnect` puede seguir operando con semántica legacy.

El callback público real de `autenticacion.clinicaclick.com` entra por nginx en
el puerto `3000` y lo sirve `pm2-gateway`, cuyo código está en
`/home/ubuntu/wt/gateway`. Para cualquier migración de este bloque, tratar
`cc-back` + `wt/gateway` + esquema como un único paquete funcional. El proceso
OAuth antiguo de `/home/ubuntu/backendclinicaclick` está parado y no es la
fuente de verdad del callback público.

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

### Estado implementado y desplegado a 2026-07-15

El contrato nuevo está implementado y la migración de multi-conexión `1515`
está aplicada. La ventana de mantenimiento terminó el 2026-07-15: Nginx enruta
`connect` y `callback` de Google y Meta al runtime nuevo. El secreto Meta se
rotó simultáneamente en los tres runtimes y el smoke final confirmó que el
grant existente seguía válido, que el App ID coincidía, que las firmas HMAC se
aceptaban/rechazaban correctamente y que el inicio público de OAuth emitía una
URL válida. La rotación del App Secret no invalida por sí sola los tokens de
usuario, así que no se fuerza una reconexión si `debug_token` y permisos siguen
correctos.

Piezas canónicas:

- `src/services/scopeConnectionResolver.service.js`: resolución de clínica
  propia y fallback de grupo, sin escrituras ni promociones silenciosas. El
  fallback legacy por `userId` solo funciona cuando existe exactamente un
  grant; con dos o más devuelve `legacy_user_ambiguous` y falla cerrado.
- `src/services/oauthConnectionPersistence.service.js`: un callback actualiza
  únicamente la fila `(userId, googleUserId)` o `(userId, metaUserId)`. Una
  identidad proveedor distinta crea otro grant. Google conserva el
  `refreshToken` de esa misma identidad si el proveedor no lo devuelve en una
  reautorización.
- `migrations/20260715151500-enable-multiple-oauth-connections.js`: elimina los
  dos índices `UNIQUE(userId)` heredados y la unicidad global de `metaUserId`, y
  crea `UNIQUE(userId, providerUserId)` por proveedor. El `up` aborta si ya hay
  duplicados por pareja; el `down` aborta si el estado nuevo no cabe en las
  unicidades antiguas. Nunca fusiona ni borra grants. Como MySQL hace autocommit
  de DDL, primero crea los índices compuestos y solo al final retira los
  antiguos; el rollback restaura primero los antiguos y luego retira los
  compuestos.
- `src/services/oauthState.service.js`: `state` aleatorio, de un solo uso,
  ligado a proveedor, con TTL y `GETDEL` atómico en Redis. El callback vuelve a
  autorizar el scope guardado antes de intercambiar el código.
- `src/services/oauthScopedDisconnect.service.js`: el disconnect exacto
  desactiva dentro de la misma transacción los mappings operativos del scope y
  escribe su tombstone. Las clínicas con override propio se preservan al
  desconectar un grupo. Si un mapping tiene consumidores fuera del scope, la
  operación completa se bloquea con
  `scope_disconnect_shared_asset_conflict`; nunca rompe silenciosamente al
  consumidor hermano.

Reglas de seguridad del runtime:

- `oauth.routes` delega autenticación en `auth.middleware`; solo callbacks
  públicos y la ruta de test quedan fuera. No decodifica JWT por su cuenta ni
  puede saltarse el bloqueo canónico de usuarios;
- inventarios de proveedor, `connect` y las mutaciones MCC
  `request-link`/`accept-link` exigen scope explícito y permiso de escritura;
- resolver un grant no autoriza al caller: `web.routes`, WhatsApp Embedded y
  diagnósticos comprueban ACL de todas las clínicas destino antes de obtener o
  usar un token central;
- `/api/web` usa el middleware JWT estándar, incluido el bloqueo de identidades
  revocadas, y después aplica ACL `read`/`write` por `:clinicaId`;
- un activo remoto y el bearer que lo consume forman una pareja indivisible:
  análisis, onboarding y conversiones de Google Ads cargan el
  `googleConnectionId` del mapping exacto del customer; el listado/análisis
  Meta agrupa cada cuenta y campaña por su `metaConnectionId`; Search Console
  live y `webSync` obtienen el token de cada
  `ClinicWebAsset.googleConnectionId`. Un override de clínica prevalece sobre
  el mapping heredado del grupo; dos grants distintos para el mismo activo en
  el mismo nivel son ambiguos y no autorizan ninguna llamada;
- las rutas live de `/api/web` consumen el inventario efectivo común, no solo
  `ClinicWebAsset.clinicaId`: incluyen el activo propio, el primario heredado de
  grupo y `GroupAssetClinicAssignments`, conservando en cada caso su
  `connection_id` original;
- el fallo de un grant web se registra por sitio y no impide sincronizar los
  mappings sanos de la misma clínica. Si fallan todos, `webSync` queda `failed`
  y reintentable. PSI y los checks HTTP pueden elegir una URL sin OAuth, pero
  URL Inspection usa necesariamente el grant de ese mismo `ClinicWebAsset`.
  `/api/web/*/status` solo declara Google conectado cuando todos los sitios
  activos tienen un mapping con grant utilizable;
- las rutas globales de validación de tokens Meta requieren admin técnico y las
  estadísticas seleccionan atributos seguros, nunca `accessToken`;
- todo `/metasync/jobs/*`, incluidos backfills dirigidos, reanudación de cuota
  y tail de logs, requiere admin técnico;
- diagnósticos de Meta requieren permisos de escritura y no devuelven prefijos,
  longitudes ni parámetros que contengan bearer tokens;
- `paging.next` de Meta se acepta solo si mantiene HTTPS y el mismo origin de
  Graph API;
- Meta se considera desconectado si falta expiración, ha expirado, `debug_token`
  falla, `is_valid` no es verdadero, el app id no coincide o expiró el acceso a
  datos. Google con expiración desconocida también exige reautorización.

Los mapeos siempre se contrastan contra inventario proveedor obtenido en el
servidor. El navegador no puede aportar nombres, permisos, tokens de página ni
metadatos canónicos. En Google Ads, `replace_existing=false` es aditivo (A+B no
desactiva A); solo `replace_existing=true` desactiva omitidos. Las mutaciones de
activos compartidos incluyen consumidores explícitos y los implícitos de un
mapping `assignmentScope=group`.

El fallback legacy del resolver también falla cerrado si los mappings
efectivos de un scope apuntan a más de un grant: no elige el primero ni cae a
la conexión del usuario. Regresión multi-grant canónica:
`node src/scripts/tests/oauth_multigrant_consumers.test.js`. Cubre dos grants
Google para el mismo customer, override clínica frente a grupo, dos cuentas
Meta enriquecidas con tokens distintos, conexión Meta expirada sin llamada al
proveedor y dos sitios Search Console que conservan su token exacto.

### Cutover obligatorio de multi-conexión

> **Estado operativo del corte (2026-07-15):** completados publicación de
> writers nuevos, reinicios controlados, migraciones `1500`, `1510` y `1515`,
> rotación coordinada del App Secret Meta, smoke del grant/webhook y reapertura
> de `connect`/`callback` para ambos proveedores. La propuesta destructiva
> `1520` fue cancelada el 2026-07-17 y sustituida por un no-op.

La migración `20260715152000-purge-google-places-competition-content.js` ya no
es una razón para evitar `db:migrate`: su `up` y `down` son no-op y no contienen
SQL ni operaciones destructivas. Los demás preflights del entorno siguen siendo
obligatorios antes de aplicar migraciones en bloque.

Como referencia para otros entornos: si `1500`, `1510` y `1515` siguen
pendientes, `--to 1515` ejecuta también las dos anteriores. El corte debe
declararlo y repetir su preflight. Para aplicar primero las migraciones
compatibles de Informes:

```bash
npx sequelize-cli db:migrate --to 20260715151000-dedupe-business-profile-daily-metrics.js
```

Después de publicar y validar todos los writers nuevos sobre el esquema viejo,
la ampliación multi-conexión se aplica aisladamente con (ya ejecutado en la base
compartida el 2026-07-15):

```bash
npx sequelize-cli db:migrate --to 20260715151500-enable-multiple-oauth-connections.js
```

No sustituir ninguno por `db:migrate` sin `--to`.

Orden seguro:

1. bloquear temporalmente nuevos callbacks o abrir una ventana de mantenimiento;
2. portar a `/home/ubuntu/wt/gateway` el state opaco, secretos por entorno,
   persistencia por identidad y guards de este paquete;
3. publicar **y reiniciar de forma controlada** cc-back y gateway con el código
   compatible/fail-closed, tras comprobar que no hay otro reinicio ni
   saturación. Validar sobre el esquema antiguo que no queda ningún proceso
   OAuth legacy; una segunda identidad debe fallar por unicidad sin pisar el
   grant existente;
4. solo con todos los writers nuevos ya activos, aplicar de forma aislada la
   migración `1515`;
5. validar índices, resolución por scope, callback Google/Meta, status y
   disconnect sin reiniciar de nuevo por inercia;
6. rotar el secreto Meta coordinadamente y validar el nuevo entorno;
7. reabrir callbacks. **Completado el 2026-07-15** tras validar grant, App ID,
   HMAC y entrada pública de OAuth.

Alternativa con parada: bloquear por completo `/oauth`, detener todos los
writers legacy, aplicar `1515` y arrancar únicamente los runtimes nuevos. Nunca
aplicar `1515` mientras un proceso legacy siga en memoria.

El gateway activo ya ejecuta el runtime OAuth nuevo y lee el secreto Meta
exclusivamente del entorno. Sin embargo, el valor anterior estuvo versionado y
se considera comprometido: debe rotarse en Meta, actualizarse en el entorno y
validarse antes de retirar los `503` de Meta. Nunca copiar el valor a logs,
commits o documentación.

Estado comprobado el 2026-07-15: `/oauth/meta/connect` y
`/oauth/meta/callback` están abiertos y el grant efectivo de Badalona continúa
válido, sin scopes ausentes ni solicitud de reautorización. Rotar el App Secret
no obliga por sí solo a reconectar OAuth: se conserva el grant/token existente
y se reautoriza únicamente si Meta lo rechaza, está revocado/caducado o faltan
permisos. La entrada canónica para una conexión nueva o una reautorización es
`Ajustes > Cuentas conectadas > Meta`. El smoke cubrió también la aceptación de
una firma HMAC correcta y el rechazo de una inválida; los tres runtimes quedaron
con la misma versión del secreto antes de retirar los `503`.

El contrato multi-cuenta Meta es parcial. `MetaConnections` soporta varias
identidades por usuario y `ClinicMetaAssets` varias cuentas publicitarias por
clínica, pero `MetaConnectionAssignments.scopeKey` mantiene un único grant
efectivo por scope y `POST /oauth/meta/map-assets` rechaza hoy más de un activo
del mismo tipo con `meta_asset_type_conflict`. Reporting ya consume arrays y el
onboarding elige una sola `meta_ad_account_id` por estrategia. Por tanto, varias
cuentas publicitarias bajo el mismo grant/Business Manager requieren abrir el
mapeo múltiple solo para `ad_account`; distintas identidades/grants requieren
además resolución 1:N y token por activo. La UI no debe prometer ninguno de los
dos casos hasta completar sus regresiones.

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
  - `/home/ubuntu/wt/gateway`
  - frontend de `Ajustes`

### Orden recomendado de ejecución

1. código compatible y fail-closed en backend y gateway;
2. migración de schema aislada hasta `1515`;
3. validación de callbacks, assignments y mappings por scope;
4. script de backfill, si el preflight detecta scopes legacy sin assignment;
5. adaptación de `Ajustes`;
6. limpieza legacy cuando ya no exista ningún consumidor directo ambiguo.

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

## 2026-07-15 - ACL de Marketing Leads y selector "todas las clínicas"

- `Marketing > Leads` usa `GET /api/intake/leads/search`, `GET /api/intake/leads`, `GET /api/intake/leads/stats` y rutas de detalle/actividad sobre `/api/intake/leads/:id`.
- El backend no debe interpretar `clinicId=all` como consulta global salvo para admin global (`isGlobalAdmin`). Para usuarios de clínica, `all` significa "todas las clínicas asignadas a este usuario" según `UsuarioClinica`.
- Las consultas por clínica o grupo se intersectan siempre con las clínicas accesibles del usuario. Si se pide una clínica fuera de scope, listados y métricas devuelven cero resultados; detalle, actividad y acciones sobre el lead devuelven `403 lead_scope_forbidden`.
- Los leads con `clinica_id = NULL` y `grupo_clinica_id` solo son visibles si el usuario tiene acceso a alguna clínica de ese grupo. Esto permite trabajar leads de assets de grupo sin exponer leads de otros grupos.
- Endpoints protegidos por este contrato:
  - listado/búsqueda/estadísticas;
  - detalle y actividad;
  - cambio de estado, registro de contacto, búsqueda de citas candidatas, resultado de llamada y borrado.

## 2026-07-17 - Autoría y scope de plantillas personales

- `WhatsappTemplates.created_by_user_id` es la identidad canónica del usuario
  que creó una plantilla personalizada desde ClinicaClick. Es nullable y no se
  rellena históricamente a partir del propietario de Meta.
- Listado, resumen, sync, creación y retirada exigen admin global o una
  membresía activa de staff en la clínica solicitada
  (`estado_invitacion=aceptada|NULL`; roles `propietario`,
  `personaldeclinica` o `agencia`). Una membresía pendiente/cancelada,
  `paciente` o ser propietario de otra clínica no amplía el scope.
- `GET /api/whatsapp/templates` devuelve por defecto catálogo/sistema,
  plantillas personales del usuario autenticado y las históricas no atribuidas
  del scope solicitado. `include_all=1` queda reservado a un admin global como
  inspección técnica y no concede edición.
- Una WABA de grupo permite que el autor consuma y gestione su plantilla desde
  las sedes accesibles que resuelven esa WABA, pero no revela la plantilla a
  otros usuarios ni da acceso a otra clínica del grupo.
- Sistema se identifica por `catalog_template_id`, `origin=catalog` o una
  allowlist exacta de cuatro nombres legacy auditados. Un prefijo abierto
  `clinicaclick_*` no convierte una plantilla externa en sistema.
- El filtro visual no constituye autorización. Al enviar,
  `POST /api/conversations/:id/messages` resuelve la fila dentro de la WABA,
  verifica autoría/scope y encola siempre el nombre e idioma canónicos
  persistidos; los valores del navegador no sustituyen esos campos.
- Crear, reemplazar y retirar una plantilla personal exige ser su autor. Las de
  catálogo/sistema y las históricas sin autor son de solo lectura en la UI.
- Las plantillas activas históricas sin autor verificable no se atribuyen por
  inferencia. El preflight del 19/07/2026 encontró 18 filas no-sistema sin
  `created_by_user_id`: 6 remotas anteriores a ClinicaClick y 12 creadas o
  sincronizadas posteriormente sin una identidad persistida. La conexión Meta,
  el `clinic_id`, el nombre visible y la hora de creación son contexto, no
  evidencia suficiente para adjudicar autoría.
- Esas filas se conservan como `legacy_unassigned`: permanecen seleccionables
  dentro del scope de clínica/WABA ya autorizado, se devuelven con
  `is_legacy_unassigned=true`, `ownership_scope=legacy_unassigned` y
  `can_manage_by_current_user=false`, y la UI las separa bajo «Anteriores».
  Nunca cuentan como «Mis plantillas» y no pueden editarse o retirarse hasta
  una asignación administrativa explícita respaldada por evidencia. Las
  plantillas nuevas sí quedan restringidas estrictamente a su autor.

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
  - `GET /api/tratamientos` con `clinica_id` y `grupo_clinica_id` simultáneos resuelve tratamientos disponibles para esa clínica: propios de clínica, del grupo indicado y de sistema. No debe tratar ambos filtros como un AND estricto porque deja vacíos selectores de scope grupo que conservan sede activa en cabecera.
  - `GET /api/tratamientos` con solo `grupo_clinica_id` devuelve tratamientos de grupo y sistema para vistas agregadas.
  - `POST /api/tratamientos/:id/personalizar` crea una copia de clínica desde un tratamiento de sistema/grupo. Fuerza `origen=clinica`, limpia `grupo_clinica_id` y marca el original como oculto para esa clínica para que el flujo de frontend sea `editar -> Guardar`, sin duplicar el original visible.
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
- Importante 2026-06-30: `PUBLIC_MEDIA` no sustituye esta estrategia. `media.clinicaclick.com` solo puede servir assets publicos/no clinicos.
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

### Outbox durable del resumen QuickChat (2026-07-14)

- Los dos contratos públicos, `source_detail=chatbot` con `chat_state` completo y `source_detail=chatbot_quickchat`, usan el mismo outbox. Para un lead nuevo, `dedupeAndCreateLead` crea en un único commit `LeadIntakes`, su `LeadAttributionAudits` exacto y un `JobRequests.type=intake_quickchat_summary_materialize` de prioridad `high`. Si deduplica, relee y bloquea el lead existente y crea en otra transacción indivisible el audit del **payload actual** y su job exacto; no reutiliza un audit anterior ni pierde el transcript. Si falla audit/enqueue, revierte toda esa unidad y un alta nueva tampoco deja lead huérfano.
- Antes de confirmar ese commit, backend aplica el mismo contrato de contacto que el resumen: teléfono normalizable a 9–15 dígitos y, si se informó email, sintaxis válida. Un `14725` devuelve `422 quickchat_phone_invalid`; un email presente inválido devuelve `422 quickchat_email_invalid`. La guarda corre también antes de crear un lead en el POST directo `source_detail=chatbot_quickchat`, por lo que el fallback del navegador no puede dejar otro lead huérfano. La validación se repite dentro de la transacción como defensa: si el caller la omite, se revierte el lead y quedan cero audit/job.
- `enqueueJobRequest(options, { transaction })` permite que este alta se una a la transacción del caller. El payload durable contiene únicamente `lead_id`, `audit_id` y el `__runtime_namespace` añadido por la cola. No replica nombre, teléfono, email, texto del chat, consentimiento, click IDs ni tokens en `JobRequests`; el handler relee esos datos desde el audit local exacto. El audit sí fija en `attribution_steps.resolved_clinic_id` —y `resolved_group_id` como contexto— la sede ya validada por intake, tanto en alta como en dedupe.
- Tras el commit, `triggerIntakeQuickChatSummaryFastPath(job_id)` intenta reclamar y resolver **ese mismo job** mediante `jobScheduler.triggerImmediate()`. No ejecuta una materialización lateral. Después relee siempre `JobRequest`, incluso si el trigger lanzó error. En producción, `JobExecutor` asienta el resultado seguro bajo el wrapper `result_summary.result`; callers directos y fixtures pueden conservar el objeto seguro en la raíz. El lector admite ambos formatos sin confundirlos. `completed` real permite `quickchat_summary_saved=true`; `pending/queued/running/waiting` responde `202`, `saved=false`, `queued=true`; un estado terminal —incluidos `4xx` seguros como el `409` cross-clinic o un error interno `500`— falla sin disfrazarse de cola. Si también falla la relectura, responde `202` con `quickchat_summary_outcome_unknown=true` y `state=unknown_durable`: el outbox está confirmado, pero no se inventa `pending`. Los fallos transitorios asentados por el scheduler quedan en `waiting` con backoff exponencial y hasta cinco intentos.
- El handler registrado en `JOB_HANDLERS` exige el par `audit_id + lead_id`, comprueba que el audit pertenece a ese lead y acepta audits de ambos `source_detail`. Antes de reutilizar `materializeIntakeQuickChatSummary`, normaliza internamente el source a `chatbot_quickchat` y pasa el `audit_id` como orden durable. La materialización bloquea el lead y consulta bajo la misma transacción todos sus resúmenes: `Messages.metadata.intake_audit_id` mayor gana. Si un outbox antiguo corre después, completa `skipped/stale`, no emite socket, no cambia contenido/metadata, no consolida y no toca `Conversations.last_message_at`. El watermark forma parte de `needsUpdate`: un audit posterior avanza el marcador aunque hash y contenido sean idénticos; del mismo modo, un mensaje legacy idéntico adopta el primer marcador. Reejecutar el mismo audit o recibir ambos POST no crea un segundo mensaje.
- El handler no llama a Meta CAPI, Google Ads/Data Manager, BullMQ ni a un envío real de WhatsApp. Solo persiste el evento interno y emite el socket de interfaz como best effort. Para audits actuales extrae y valida `resolved_clinic_id` y lo pasa al materializador: si el lead pertenece a otra sede, termina sin retry con `409 quickchat_summary_clinic_mismatch`, cero Message/socket. Solo audits legacy sin `resolved_clinic_id` pueden recuperar usando la clínica persistida en el lead; nunca aceptan una sede del payload crudo. Los `4xx` guardan en `result_summary` únicamente `http_status`, `error_code` y un mensaje de allowlist, además de IDs/flags sin contenido/PII, para que el fast path conserve el `409` en vez de degradarlo a `500`. Errores técnicos se reintentan; payload incompleto o mismatch audit/lead quedan terminales no reintentables. Si el lead/audit ya fue limpiado de forma controlada, el job termina como `skipped/audit_not_found`.
- `scripts/cleanup-intake-e2e-run.js` carga y bloquea los outbox por `payload.lead_id`, exige que cada `payload.audit_id` sea el audit exacto del lead y rechaza jobs `running`. En `simulate/apply` borra el JobRequest antes del lead dentro de la transacción y el postcheck exige `quickchat_outbox_jobs=0`, evitando que un job huérfano reconstruya la conversación tras la limpieza.
- Regresión: `node src/scripts/tests/intake_quickchat_outbox.test.js` cubre lead nuevo y deduplicado guardando IDs resueltos, rechazo cross-clinic `409` sin materialización/socket, fallback legacy a la clínica del lead, lectura compatible del wrapper de `JobExecutor` y del formato directo de fixtures, commit atómico, rollback si falla el enqueue, `14725`/email inválido con cero lead-audit-job, unión real de `enqueueJobRequest` a la transacción, par audit/lead, fallo transitorio/reintento para ambos contratos, audit stale sin socket, duplicado idempotente, relectura tras error del trigger, outcome `unknown_durable`, fast path `completed/202 queued` sin falsos positivos, ausencia de proveedores y el inventario de 63 handlers. `intake_quickchat_summary.test.js` protege el orden inverso/doble POST, compatibilidad legacy, contenido y `last_message_at` del ganador, el `422` antes de crear, la ausencia de materialización lateral y los retornos `chatbot` deduplicado anteriores a Meta/Google conservando `409` para el resto; `cleanup_intake_e2e_run.test.js` cubre outbox exacto/running.

**Evidencia live postdeploy:** el chat móvil controlado `CC-E2E-QUICKCHAT-20260713-0110`, con Marketing rechazado y sin click IDs, eligió Sant Martí `56`. El único lead `#7213` produjo audits `#7400/#7401`, jobs `#23818/#23819` completados al primer intento y una sola conversación/mensaje (`#3574/#43072`) cuyo watermark quedó en `7401`; hubo cero intentos Google. El procedimiento `dry-run -> simulate -> apply` retiró después exclusivamente el marcador y devolvió cero en cada postcheck comprometido. Los chats reales huérfanos `#7185/#7195/#7196` se revalidaron y recuperaron por el mismo orquestador mediante `#23820-#23822`, una conversación/resumen Sants `19` por lead; los intentos de proveedor permanecieron `3 -> 3`.

### Routing autoritativo de formularios de grupo (2026-07-13)

- Para un formulario interceptado con scope de grupo, `IntakeConfig.config.locations` define los únicos IDs de clínica admisibles. El nombre interno de `Clinicas` y `label`/`public_label` solo son aliases para los IDs presentes en esa lista; nunca amplían el scope.
- `extractClinicLabelHint` separa etiquetas humanas de campos técnicos. En particular, ignora `clinica_id=0`/`clinic_id=0` y toma después la etiqueta de `form_submission.fields.clinica`. Esto evita que el sentinel del runtime eclipse una sede elegida.
- `resolveConfiguredFormClinicLocation` normaliza mayúsculas y acentos, exige una coincidencia inequívoca y comprueba grupo y estado activo. Desconocido, ambiguo, inactivo o fuera de grupo devuelve `422 invalid_form_location` antes de `resolveFallbackClinicForGroup`, `dedupeAndCreateLead` o cualquier evento.
- Propdental usa cinco destinos configurados: Sants `19`, Nou Barris `35`, Sant Martí `56`, Badalona `58` y Hospitalet `59`. La clínica histórica `55` no participa.
- E2E público del CF7 `77822`: `Propdental Sant Martí` creó un único `web_form` en `56`, `clinic_match_source=configured_location_label` y un `FormSubmissionEvent`. Chat/QuickChat conservaron también `56`, con un resumen interno oculto; el modal de `tel:602480829` creó `tel_modal` en `56` y `CallInitiated` quedó enlazado.
- Las tres pruebas se hicieron sin click IDs y con Marketing denegado; no existieron intentos Google. Dry-run, rollback y limpieza comprometida dejaron cero restos sintéticos y devolvieron el grupo `5` a cuatro leads reales (`MAX(id)=7186`). El procedimiento reproducible está en `docs/intake-e2e-cleanup.md`.
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
- `Conversations.unread_count` se mantiene por compatibilidad. La UI calcula en lote y sin N+1 los inbound visibles posteriores a la lectura de ese usuario y al último outbound válido. `pending_automation_attention` cambia el indicador a amarillo cuando existe una `Notifications.event=automation.system_notification` abierta para `data.quickChatConversationId`; `pending_automation_count` usa ese mismo no leído individual. Abrir hace `ConversationReads.upsert`, limpia el indicador azul o amarillo solo para ese usuario y emite `conversation:read` a `user:{id}` sin agregado global. La notificación de automatización permanece como trazabilidad; un outbound desde CRM o un eco móvil limpia el pendiente para todos. La migración `20260721143000-index-notification-automation-attention.js` indexa `event + is_read`.
- El fallback que completa nombre y datos de contactos externos consulta `MarketingPatientListItems` por `conversation_id` o `phone`. La migración `20260722093000-index-marketing-list-quickchat-lookups.js` indexa ambas columnas: en desarrollo, con unas 279.000 filas, la carga de 50 conversaciones de Propdental pasó de aproximadamente `600-670 ms` a `41-73 ms`. No retirar estos índices mientras `hydrateMarketingContactFallbacks` conserve esas búsquedas.
- El evento `message:created` ya no puede limitarse a `{ content, message_type }`. Debe incluir `metadata` y, cuando el inbound no es texto plano, un `resume_text` explícito para que el runtime V2 no dependa de reconstruir semántica desde la UI.
- Estados WhatsApp outbound:
  - `Messages.sent_at` representa cuándo se envió realmente el mensaje, no cuándo se entregó ni cuándo se leyó.
  - Los webhooks `sent`, `delivered`, `read` y `failed` se guardan en `Messages.metadata.wa_status_history` y el último timestamp por estado en `Messages.metadata.wa_status_timestamps`.
  - La UI puede mostrar doble check / leído usando `Messages.status = read` cuando Meta envía ese evento. Si el paciente tiene confirmaciones de lectura desactivadas o Meta no entrega `read`, solo se puede asegurar `delivered`.
  - El runtime V2 debe calcular timeouts desde el timestamp `sent` del provider (`wa_status_timestamps.sent` o primer `wa_status_history.status=sent`), no desde `Messages.sent_at` si hay datos históricos antiguos. Esto evita que una lectura tardía parezca un envío tardío y reprograme mal esperas o insistencias.

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
- respuesta escrita con emoji positivo equivalente (`👍`, `👌`, etc.) o texto afirmativo inequívoco:
  - también se trata como `confirmado` de forma determinista;
  - para respuestas cortas tipo `sí`, `ok`, `vale`, `perfecto` se exige que sean respuestas breves y sin interrogación; frases largas ambiguas siguen pasando por el análisis normal;
  - esto aplica en ejecución real y en simulación para que el test-run no caiga falsamente por la rama inconclusa.
- reacción negativa o neutra (`👎`, `🤔`, etc.):
  - no se fuerza como éxito;
  - se analiza como respuesta no confirmatoria y debe terminar en `on_fail` salvo que el preset futuro decida otra semántica explícita.
- emoji escrito como texto normal:
  - no se trata como `reaction`;
  - entra como `text`;
  - lo analiza la IA/preset igual que cualquier otra respuesta escrita;
  - si el texto completo es un emoji positivo soportado, se considera confirmación determinista; si llega como sticker sin texto, no.
- sticker recibido como media (`Messages.metadata.media.kind = sticker`):
  - se muestra en QuickChat como miniatura autenticada mediante `GET /api/conversations/messages/:messageId/media`;
  - el `delay/wait_response` puede reanudar la automatización aunque no haya texto y guarda `response_media_kind`, `response_media_id` y `response_media_mime_type` en el contexto;
  - `confirm_appointment` devuelve `decision=incongruente` de forma determinista porque el modelo actual no analiza el contenido visual del sticker;
  - `appointment_unconfirmed_reply` devuelve `decision=duda` para que recepción lo revise;
  - no se confirma, cancela ni reprograma una cita solo por recibir un sticker. Si se añade IA multimodal real, deberá cambiarse esta regla de forma explícita y auditable.
- Corrección operativa 2026-07-21: `confirm_appointment` no debe ejecutarse pegado a `action/send_whatsapp` ni a `control/join`. El patrón válido es `send_whatsapp` -> `delay/wait_response` -> `condition/ai_analysis`; si hay un `join` tras ramas alternativas de WhatsApp, el `wait_response` queda entre el `join` y la IA y el runtime reancla la escucha al último outbound real con `conversation_id`/`message_id`. La migración `20260721101000-add-wait-response-before-confirm-ai` publica una versión nueva de las plantillas activas afectadas y añade un `wait_response` de 12h, sin salida de timeout, antes de la IA.

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
    - si dos clinicas del mismo grupo comparten paciente, telefono o WABA, siguen teniendo conversaciones separadas por `clinic_id`.
    - QuickChat de una clinica no debe mostrar el historico previo de otra clinica del grupo; compartir WABA comparte numero/plantillas, no timeline operativo.
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
- `appointment_no_show`
- `appointment_rescheduled`
- `appointment_cancelled`
- `appointment_completed`
- `appointment_reminder_window`
- `appointment_after`
- `consent_required`
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
   - Si la cita tiene `tratamiento_id` y ese tratamiento tiene `appointment_automation_template_key/version`, ese flujo gana para `appointment_created`.
   - Para eventos complementarios, el runtime lee `Tratamientos.automation_template_bindings` y resuelve el slot compatible: `appointment_after_completed`, `appointment_after_no_show`, `appointment_after_next_session`, `appointment_during_rescheduled` o `appointment_during_cancelled`.
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
- `Tratamientos.automation_template_bindings` guarda bindings auxiliares por bloque de cita:
  - `appointment_before.disabled=true`: el tratamiento no usa la automatizacion general por defecto si no tiene una especifica hasta la cita.
  - `appointment_after_completed`, `appointment_after_no_show`, `appointment_after_next_session`: slots post-cita seleccionados desde la UI de tratamientos.
  - `appointment_during_rescheduled`, `appointment_during_cancelled`: slots durante la cita para reprogramaciones y cancelaciones.
  Este JSON permite que la UI seleccione automatizaciones complementarias sin alterar el contrato principal `appointment_automation_template_key/version`.
- El runtime resuelve primero el binding del tratamiento y después el fallback clinic/group/system. Los slots solo son compatibles con su `trigger_type`: `appointment_completed`, `appointment_no_show`, `appointment_after`, `appointment_rescheduled` o `appointment_cancelled`.
- Para `appointment_created` con `with_treatment + treatment_filter=specific`, `publish` bloquea otra automatización activa del mismo scope si ya cubre alguno de esos tratamientos.
- Si una cita pasa a `cancelada`, `reprogramada`, `completada` o `no_asistio`, las ejecuciones V2 activas/pendientes de esa cita se cancelan antes de lanzar el evento correspondiente. `reprogramada` cancela automatizaciones de la hora anterior, pero la cita sigue siendo accionable manualmente desde UI. Un nodo `action/change_status` no puede resucitar citas realmente cerradas (`cancelada`, `completada`, `no_asistio`); el nodo se marca como `skipped` y el flujo termina.
- Las notificaciones operativas creadas por `action/send_system_notification` para una cita se marcan automáticamente como leídas cuando esa cita queda resuelta (`info_confirmada`, `recordatorio_confirmado`, `cancelada`, `reprogramada`, `completada`, `no_asistio`). El backend emite `notification:updated` para que la campana no mantenga avisos obsoletos si la resolución ocurre en tiempo real.

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
- en `appointment_created`, compara `CitasPacientes.created_at` frente a la fecha local de la cita (`inicio`)
- en `appointment_rescheduled`, compara `CitasPacientes.updated_at` frente a la fecha local de la cita (`inicio`), porque la ventana relevante es cuándo se ha reprogramado, no cuándo se creó originalmente la cita
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
- al propagar desde `AutomationFlowCatalog`, cada copia clínica publicada también ejecuta ese backfill; si no, las citas ya existentes antes de la propagación no tendrían job hasta que se modificasen;
- se crean jobs `appointment_automation_schedule_fire` con `payload`:
  - `appointment_id`
  - `trigger_type`
  - `template_key`
  - `window_identifier`
  - `scheduled_for`
- cuando el job vence, `fireScheduledTrigger(payload)` resuelve la última versión publicada activa del `template_key` y crea una `FlowExecutionV2` normal.
- al ejecutar un job ya creado, `fireScheduledTrigger(payload)` permite una pequeña tolerancia de reloj/worker (`APPOINTMENT_AUTOMATION_FIRE_GRACE_MS`, por defecto 15 minutos). Esta tolerancia solo aplica a jobs ya programados: evita que un recordatorio a las 09:00 se descarte si el worker lo reclama a las 09:00:19. No convierte el backfill ni la resincronización en envíos retroactivos.

Reglas importantes:

- `appointment_reminder_window` no debe programarse si la cita ya ha empezado;
- las citas históricas creadas por importación de pacientes (`motivo = "Importación de pacientes para reactivación"`) son contexto clínico/marketing para segmentación, pero no disparan automatizaciones de cita ni dejan jobs programados. Si entran en `enqueueExecutionForCita`, `syncScheduledTriggersForCita` o `fireScheduledTrigger`, se omiten con `imported_historical_appointment`;
- si el trigger `appointment_reminder_window` tiene `exclude_if_not_confirmed = true`, `fireScheduledTrigger(...)` vuelve a consultar el estado actual de la cita al vencer el job y lo omite con `appointment_not_confirmed` salvo que esté en `info_confirmada`, `recordatorio_confirmado` o `completada`;
- el backfill de publicación no dispara recordatorios retroactivos si la ventana ya pasó; solo deja programadas ventanas futuras;
- `appointment_after` sí puede quedar programado desde la creación inicial de la cita;
- el entorno debe aislar sus colas con `QUEUE_PREFIX` propio;
- tras una migración de namespaces, no dejar jobs `waiting` con `payload.__runtime_namespace` legacy. Si hace falta reclamar aliases, configurar temporalmente `JOB_RUNTIME_NAMESPACE_ALIASES` y retirarlo al terminar la migración;
- una resincronización de cita debe cancelar y recrear jobs programados cuyo `__runtime_namespace` no pertenezca al runtime actual;
- si varios procesos consumen la misma tabla/cola de jobs en un entorno, todos deben conocer `appointment_automation_schedule_fire` o bien solo uno de ellos debe actuar como scheduler. Si no, el síntoma es `No handler registered for job type 'appointment_automation_schedule_fire'`.
- Regla aplicada desde el 2026-03-24: cada scheduler debe reclamar solo los tipos que sabe ejecutar (`claimNextJob(..., allowedTypes)`). Esto evita que runtimes auxiliares como `clinicaclick-auth` fallen jobs de automatización V2 que pertenecen al backend funcional.

### Notificaciones internas desde flujos V2

El nodo `action/send_system_notification` puede asignar destinatario por usuario unico o por rol. En modo rol, `assignee_id` acepta tanto un string legacy (`"admin"`) como un array (`["admin", "propietario"]`). El runtime resuelve todos los usuarios de los roles indicados y los deduplica antes de crear `Notification`.

El filtro `subrole` solo se aplica a `personaldeclinica`; no debe limitar roles agregados como `admin`, `propietario` o `agencia`.

Caso real `2026-04-13`:

- recordatorios del día anterior en Propdental Eixample no salieron a las 09:00;
- algunas citas tenían jobs `waiting` vencidos con `payload.__runtime_namespace = port:3001`, pero `pm2-back-staging` ya reclamaba solo `staging`;
- otras citas no tenían job porque la cita existía antes de publicar/activar el flujo programado;
- no activar aliases ni reclamar jobs vencidos de pacientes reales sin confirmar si se deben enviar tarde.

Caso real `2026-04-20`:

- recordatorios del día anterior en Propdental Eixample sí quedaron programados para `2026-04-20 09:00 Europe/Madrid`;
- el worker los reclamó unos segundos después de la hora exacta (`09:00:19`) y `fireScheduledTrigger(payload)` recalculó la ventana con `Date.now()`;
- al no existir tolerancia en la ruta de ejecución, `computeScheduledRunAt(...)` devolvió `null` y los jobs terminaron como `completed` con `reason = invalid_schedule`, sin crear `FlowExecutionV2`;
- corrección aplicada: la tolerancia de ejecución solo permite disparar jobs previamente programados que vencen con pequeño retraso del worker. La programación inicial sigue sin crear envíos retroactivos si la ventana ya pasó.

Caso real `2026-06-26`:

- los recordatorios del mismo día a las 08:00 de BS Capilar (`clinica_id = 66`) y BS Medical (`clinica_id = 72`) dispararon sus jobs, pero las ejecuciones fallaron antes de enviar WhatsApp con `whatsapp_template_params_missing:4`;
- el parámetro 4 de `clinicaclick_recordatorio_mismo_dia_primera_visita` es `url_como_llegar_clinica` (`{{clinica.url_como_llegar}}`);
- las clínicas sí tenían Perfil de Empresa Google conectado y `googleLocalLinks.service` resolvía `url_como_llegar`; el fallo operativo fue que el worker que ejecutó el cron seguía con runtime anterior al cambio de variable/enriquecimiento;
- al mover una clínica a grupo o reasignarle un WABA compartido, verificar siempre tres capas juntas: `ClinicMetaAssets` efectivo, plantilla WABA compatible aprobada y resolución de variables con datos reales de cita/clinica/paciente;
- después de cambiar variables de plantillas usadas por `appointment_reminder_window`, reiniciar el backend que consume `JobRequests` y hacer un preflight sobre jobs futuros (`appointment_automation_schedule_fire`) antes de esperar al cron real;
- validación posterior: con runtime reiniciado, BS Capilar y BS Medical seleccionan la plantilla aprobada del WABA de grupo `825171709863569` y resuelven los 4 parámetros; los jobs futuros del mismo día no muestran variables faltantes.

Caso real `2026-06-27`:

- una cita QA de BS Capilar (`CitasPacientes.id_cita = 431`, `clinica_id = 66`) validó que el scheduler ya no falla por variables: `JobRequests.id = 1682` se ejecutó a las 08:00 Europe/Madrid y creó `FlowExecutionsV2.id = 691`;
- la ejecución falló en el nodo `action/send_whatsapp`, no en la programación ni en la plantilla, con `whatsapp_send_failed: GraphMethodException code=100 error_subcode=33` sobre `phoneNumberId = 1128272900359750`;
- `ClinicMetaAssets.id = 363` quedó con `additionalData.coexistence.status = disconnected`, `canSendApi = false`, `requiresReconnect = true` y `disconnectReason = meta_object_access_lost`;
- conclusión operativa: un `appointment_automation_schedule_fire` completado solo demuestra que el trigger temporal salió; para dar el WhatsApp por válido hay que comprobar `FlowExecutionsV2.status`, `FlowExecutionLogsV2` y `Messages.status` final. Si Meta devuelve `100/33`, reconectar WhatsApp desde Ajustes antes de esperar a nuevos recordatorios.

### Barrido de salud de automatizaciones

Desde `2026-04-20` existe el cron `automationHealthCheck` en `src/jobs/sync.jobs.js`.

Objetivo:

- detectar a media mañana y media tarde si una automatización importante ha fallado sin depender de que alguien abra el monitor;
- dejar evidencia en `SyncLogs` con `job_type = automation_health_check`;
- avisar a administradores mediante el evento `jobs.automation_health_issue` si hay incidencias críticas.

Horario por defecto:

- `JOBS_AUTOMATION_HEALTH_CHECK_SCHEDULE = 0 10,16 * * *`
- timezone: `JOBS_TIMEZONE`, normalmente `Europe/Madrid`
- ventana: desde el último `automation_health_check` del mismo `JOB_RUNTIME_NAMESPACE`; si no existe, usa `JOBS_AUTOMATION_HEALTH_LOOKBACK_HOURS` como fallback.

Qué revisa:

- `FlowExecutionsV2` en `failed` o `dead_letter` dentro de la ventana reciente;
- ejecuciones `running` atascadas más de `JOBS_AUTOMATION_HEALTH_STALE_RUNNING_MINUTES` minutos;
- ejecuciones `waiting` cuyo `wait_until` ya venció con margen de `JOBS_AUTOMATION_HEALTH_OVERDUE_GRACE_MINUTES`;
- `JobRequests` de `automations_v2_execute` o `appointment_automation_schedule_fire` fallidos;
- jobs de recordatorio vencidos que siguen `pending`, `waiting` o `running`;
- jobs de `appointment_automation_schedule_fire` que terminaron `completed` con `result.reason = invalid_schedule`.

Reglas operativas:

- si encuentra incidencias funcionales, el `SyncLog` queda `failed`, pero el cron no lanza excepción para evitar tres reintentos duplicados del mismo barrido;
- si el propio barrido falla por error técnico de BD/código, sí lanza excepción y entra en el flujo normal de `jobs.failed`;
- `jobs.automation_health_issue` no usa deduplicación diaria de notificaciones porque hay dos barridos diarios y el de la tarde puede detectar una incidencia distinta;
- cada `status_report` guarda `runtime_namespace`, `since`, `since_source` y `previous_sweep_id` para saber exactamente qué ventana se revisó;
- el panel `Settings > Monitorización del sistema` muestra el job programado y el historial;
- no confundir este barrido con el `healthCheck` genérico, que solo valida dependencias técnicas.

### Diagnóstico real de una cita que "no disparó" la automatización

Si una cita parece no haber disparado `appointment_created`, el orden correcto de diagnóstico en integración es:

1. revisar `FlowExecutionsV2` por `trigger_entity_type = appointment` y `trigger_entity_id = <id_cita>`;
2. revisar `FlowExecutionLogsV2` para localizar el nodo exacto que falló;
3. revisar `AutomationFlowTemplatesV2.nodes` de la versión ejecutada, no solo la versión que el editor tenga abierta;
4. revisar la plantilla real en `WhatsappTemplates`, no el nombre lógico del nodo.

Para `appointment_rescheduled`, la automatización debe disparar cada movimiento real de la cita. La idempotencia no puede ser solo `trigger:cita:template`, porque una misma cita puede reprogramarse varias veces. Desde `2026-04-15`, el runtime añade un `window_identifier` con `updated_at`, `inicio`, `fin`, `doctor_id` e `instalacion_id` para que cada reprogramación real cree una ejecución nueva, manteniendo deduplicación solo para reintentos exactos del mismo movimiento.

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
   - el guardado/publicación normaliza `listens_to_node_id`: si existe pero apunta a un nodo no outbound (`change_status`, `ai_analysis`, etc.), backend recorre los predecesores del grafo y lo reancla al `action/send_whatsapp` / `action/send_email` anterior
   - si no puede inferirse un outbound anterior, la validación bloquea el flujo con error de configuración en vez de publicar un listener semánticamente roto
   - si una plantilla antigua apunta por error a un nodo no outbound, el runtime usa como fallback el último output outbound real con `conversation_id` y `message_id`, y persiste ese nodo efectivo en `waiting_meta.listens_to_node_id`

2. `condition/ai_analysis` en preset `confirm_appointment`
   - `on_success` significa `decision = confirmado`
   - `on_fail` significa cualquier otro caso (`no_confirmado`, `dudas` o fallo técnico)
   - esta regla aplica tanto a respuestas de Groq como a reglas deterministas previas; una negativa textual detectada por regla (`_ai_provider = deterministic_rule`) no puede seguir `on_success`
   - no se usa ya un `field_check` intermedio en estos flujos porque complicaba el grafo sin aportar nada al usuario
   - adicionalmente, ciertas reacciones positivas de WhatsApp (`👍`, `✅`, `👌`, `🙌`) se resuelven de forma determinista como `confirmado` antes de pasar por LLM
   - adicionalmente, negativas claras de texto como `no puedo`, `no me viene bien`, `me va mal`, `otro día`, `reprogramar/cancelar` o erratas evidentes como `me va ma ese día` se resuelven de forma determinista como `no_confirmado` antes de pasar por LLM

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
- si el flujo propagado es programado (`appointment_reminder_window` o `appointment_after`), la propagación debe ejecutar también el backfill de scheduler para crear/cancelar `JobRequests` de citas futuras ya existentes;
- la propagación debe resolver siempre el flujo base neutro del catálogo y no reutilizar copias de clínica como fuente;
- cada familia propagada por clínica debe tener `public_id` propio, distinto del asset base del catálogo;
- desactiva la versión publicada anterior de la misma familia en la clínica y publica la nueva versión conservando el estado operativo local: si la clínica había pausado esa automatización, la propagación no debe reactivarla;
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
  - normalizar cualquier `template_key` heredado quitando sufijos previos `__clinic_<id>` y el legacy `_clinic_<id>`;
  - generar el `template_key` final de clínica como `<base>__clinic_<id>`;
  - asignar un `public_id` propio a la familia propagada de esa clínica.

Esto evita dos regresiones:

1. que el `template_key` se vaya concatenando (`base__clinic_1__clinic_19__clinic_22...`);
2. que publicar una copia de clínica desactive por accidente el flujo base del catálogo al compartir `public_id`.
3. que una copia legacy `_clinic_<id>` aparezca como borrador activo adicional si ya existe una familia publicada `__clinic_<id>`.

Regla operativa vigente tras el fix del `2026-04-15`:

- duplicar un item de `AutomationFlowCatalog` debe crear una **nueva familia independiente** en `AutomationFlowTemplatesV2`;
- el item duplicado queda enlazado al nuevo `public_id` de esa familia, no al flujo original;
- la copia V2 nace como borrador editable (`published_at = null`) con el nombre visible del catálogo duplicado, para que `Editar flujo` no modifique el flujo fuente ni muestre el nombre original;
- si el item fuente no tiene flujo V2 enlazado, el duplicado conserva el comportamiento legacy y queda sin copia V2 nueva.

#### Versionado de catálogo vs copias de clínica

No debe mezclarse el versionado del flujo fuente con el versionado operativo de cada clínica:

- `AutomationFlowTemplatesV2.public_id` del catálogo identifica la familia fuente editable desde `catalogo-automatizaciones`.
- `AutomationFlowCatalog.template_key` puede enlazar esa familia por `public_id` durante la transición; la resolución debe aceptar `public_id` y `template_key`.
- `AutomationFlowCatalog.is_default_for_trigger` marca la opción por defecto para un `trigger_type`. El backend valida en `POST/PUT /api/automation-catalog` que no haya dos items marcados como default para el mismo activador y exige que el default esté activo.
- La versión visible del catálogo (`template_version`) es la versión publicada del flujo fuente.
- Al propagar, cada clínica recibe o actualiza su propia familia con `template_key = <base>__clinic_<id>` y `public_id` propio.
- La versión de clínica sube de forma independiente. Ejemplo normal: catálogo `v4` propagado hoy puede crear clínica `v5` si esa familia local ya tenía cuatro versiones previas.
- Que una copia de clínica sea `v5` no implica que exista `v5` en catálogo.
- Que una plantilla WhatsApp esté `APPROVED` no crea una versión nueva del flujo. Solo publicar el flujo fuente desde el editor crea una nueva versión del flujo de catálogo.
- Las copias de clínica propagadas desde catálogo se consideran automatizaciones de sistema operativas. El usuario de clínica puede verlas, pausarlas o duplicarlas para crear una automatización propia, pero no debe editar ni publicar sobre la familia gestionada por catálogo. El admin controla la base desde `automatizaciones-admin` y puede propagar cambios sin pisar desactivaciones locales.
- En automatizaciones de reseñas, la propagación conserva configuración local de clínica en los nodos de reseñas (`whatsapp_template_id`, premio, nombre visible y foto de equipo). El admin gobierna estructura/nodos; la configuración de producto de cada clínica sigue viniendo de `Marketing > Campañas > Conseguir reseñas`.
- En listados operativos (`/marketing/automatizaciones`) con scope de clínica o grupo, la plantilla base global del catálogo no debe mostrarse junto a su copia clínica. La base se consulta desde `automatizaciones-admin`; la pantalla cliente trabaja con la copia propagada/operativa para evitar dobles automatizaciones aparentes.

La columna `Propagada` del catálogo de automatizaciones significa:

- el catálogo fue propagado después de su última edición;
- `last_propagated_template_key/version` coincide con la referencia actual del catálogo;
- no garantiza por sí sola que Meta haya aprobado todas las plantillas WhatsApp usadas por los nodos.

Diagnóstico recomendado si hay dudas:

1. comprobar `AutomationFlowCatalog.template_key/template_version` y `last_propagated_*`;
2. resolver el flujo fuente por `public_id` o `template_key`;
3. revisar la última copia por clínica (`<base>__clinic_<id>`) y confirmar `published_at` + `is_active`;
4. revisar las plantillas WhatsApp por `catalog_template_id` y `clinic_id`, no solo por `template_id` guardado en el nodo.

#### Resolución de plantillas WhatsApp en nodos V2

Los nodos `action/send_whatsapp` pueden conservar referencias históricas como `template_id`, pero la referencia robusta es `catalog_template_id`.

Regla vigente:

- si el nodo tiene `catalog_template_id`, el runtime busca la plantilla activa para la clínica de ejecución;
- dentro de esa familia, prioriza una plantilla no bloqueada (`APPROVED`) frente a estados no enviables;
- si la clinica hereda un WABA de grupo y su override local esta bloqueado (`SIN_CONECTAR`, `PENDING_LOCAL` o `REJECTED`), pero existe una plantilla aprobada de la misma familia en el WABA efectivo, el runtime debe usar la aprobada del WABA;
- solo si no hay `catalog_template_id`, cae a `template_id` o `template_name`;
- por tanto, la UI de diagnóstico debe mostrar la plantilla efectiva resuelta para la clínica, no únicamente el `template_id` persistido en el JSON del nodo.

Esto evita un falso diagnóstico típico: un nodo puede mostrar un `template_id` antiguo o de otra clínica en el JSON, pero ejecutar correctamente porque el runtime resuelve por `catalog_template_id + clinic_id`.

Caso operativo validado el `2026-06-23`: al añadir BS Medical al grupo de BS Capilar con WABA compartido, las plantillas de recordatorio/confirmacion no debian abrir revision nueva porque el WABA ya tenia las familias aprobadas. El provisioning correcto enlaza la clinica nueva a esas aprobaciones y deja fuera solo plantillas con rechazo/local pendiente real, como consentimiento de firma si Meta rechaza el formato.

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
  - La ventana pertenece al `phone_number_id` remitente activo. Una respuesta recibida por el número anterior de la clínica no habilita texto libre desde el número nuevo.
  - El backend contrasta los mensajes inbound recientes y su `metadata.phoneId|phoneNumberId|phone_number_id`. Solo usa el `last_inbound_at` global como compatibilidad cuando ningún inbound reciente conserva identificador de remitente.
  - QuickChat recibe `whatsapp_service_window_open`, `whatsapp_service_window_last_inbound_at` y `whatsapp_service_window_phone_number_id`; el `POST` de texto repite la misma comprobación de forma autoritativa antes de crear el mensaje.
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

- `GET /api/citas`
  - Acepta `paciente_id` / `patient_id` como filtro opcional para la ficha completa de paciente.
  - Mantiene compatibilidad con los filtros existentes `clinica_id`, `startDate` y `endDate`.
  - Incluye `doctor.avatar` cuando existe para reutilizar el avatar del profesional en vistas de pacientes/agenda.

- `GET /api/pacientes/search`
  - La búsqueda multipalabra también evalúa el nombre completo en ambos órdenes (`nombre apellidos` / `apellidos nombre`) y tokens individuales para casos como `hugo tala vidal caceres`.

- `Pacientes.public_id`
  - La tabla `Pacientes` tiene un identificador público opaco (`pac_...`) para URLs y enlaces internos nuevos.
  - Los endpoints `GET/PATCH/DELETE /api/pacientes/:id` aceptan tanto `public_id` como `id_paciente` numérico para compatibilidad.
  - Las rutas de pacientes quedan detrás de `authMiddleware`; una llamada sin token devuelve `401`.

- `GET /api/pacientes/:id/consents`
  - Devuelve los registros de `PacienteConsentimientos` del paciente, ordenados por `createdAt DESC`.
  - El endpoint es solo lectura y acepta `public_id` (`pac_...`) o `id_paciente` numérico por compatibilidad.
  - El uso real actual lo genera marketing/opt-out para bajas comerciales (`tipo = comunicaciones`, `estado = rechazado`). No usar esta tabla para consentimientos clínicos.

## 2026-05-09 - Consentimientos clínicos V2

Se añade un modelo separado para consentimientos clínicos/documentales, sin contaminar `PacienteConsentimientos` de marketing/opt-out.

### Tablas principales

- `ConsentTemplateCatalogs`: plantilla global/admin.
- `ConsentTemplateCatalogVersions`: versiones de plantilla admin.
- `ConsentTemplateCatalogDisciplines`: binding admin por área/disciplina médica.
- `ConsentTemplateCatalogTreatments`: binding admin por tratamiento de sistema cuando aplique. La sincronización/propagación resuelve copias de clínica/grupo por `id_tratamiento_base`.
- `ClinicConsentTemplates`: plantilla editable de clínica.
- `ClinicConsentTemplateVersions`: versiones/snapshot de plantilla de clínica.
- `TreatmentConsentRequirements`: requisitos tratamiento -> plantilla.
- `ConsentSignaturePackages`: paquete de firma por cita/paciente.
- `PatientConsentDocuments`: documento concreto para paciente/cita/tratamiento.
- `ConsentDeliveryEvents`: eventos de entrega mock/real por paquete/documento.
- `ClinicTabletKiosks`: credenciales propias de kiosco tablet por clínica.

La fuente de verdad del documento firmado es JSON/snapshot + metadatos + hash. El PDF se genera bajo demanda con Chromium; no debe guardarse como dato primario.

### API

Prefijo: `/api/consentimientos`

| Método | Endpoint | Uso |
|---|---|---|
| GET | `/admin/templates` | Listar plantillas admin. |
| POST | `/admin/templates` | Crear plantilla admin con primera versión. |
| PUT | `/admin/templates/:id` | Actualizar plantilla admin y crear versión nueva. |
| POST | `/admin/templates/:id/propagate` | Propagar una plantilla admin activa a clínicas existentes compatibles. No sobreescribe copias existentes; si hay un requisito activo para el mismo tratamiento crea la copia como borrador. |
| GET | `/clinic/templates` | Listar plantillas de clínica (`clinica_id` requerido salvo admin global). |
| POST | `/clinic/templates` | Crear plantilla de clínica. |
| PUT | `/clinic/templates/:id` | Actualizar plantilla de clínica y versionar. |
| POST | `/clinic/:clinicId/sync-admin` | Copiar plantillas admin activas al scope clínica. |
| GET | `/clinic/:clinicId/tablet-kiosk` | Consultar tablets/kioscos de firma de la clínica. Devuelve `kiosks[]` y conserva `kiosk` como primer activo por compatibilidad. |
| POST | `/clinic/:clinicId/tablet-kiosk` | Crear una tablet/kiosco adicional para la clínica. |
| POST | `/clinic/:clinicId/tablet-kiosk/reset` | Crear o regenerar el primer kiosco activo, endpoint legacy. |
| POST | `/clinic/:clinicId/tablet-kiosk/:kioskId/reset` | Regenerar contraseña de una tablet concreta. |
| GET | `/treatments/:id/requirements` | Requisitos de consentimiento de un tratamiento. |
| PUT | `/treatments/:id/requirements` | Reemplazar requisitos de un tratamiento para el scope. |
| GET | `/patients/:id/documents` | Documentos clínicos del paciente. Acepta `pac_...` o id numérico. |
| GET | `/patients/:id/treatments-without-consent` | Tratamientos presentes en citas del paciente que no tienen requisitos activos de consentimiento para esa clínica. Alimenta la sección de creación rápida en ficha de paciente. |
| GET | `/appointments/:id/summary` | Resumen de documentos requeridos/pendientes de una cita. |
| POST | `/appointments/:id/package` | Crear o reutilizar paquete de firma para una cita. |
| POST | `/packages/:id/send-mock` | Registrar envío mock (`email`, `whatsapp`, `tablet`, `internal`). |
| POST | `/packages/:id/tablet-session` | Emitir enlace opaco de firma para un paquete. |
| GET | `/documents/:id/render` | Render HTML imprimible autenticado. |
| GET | `/documents/:id/pdf` | PDF bajo demanda autenticado. |
| GET | `/professional/pending` | Documentos firmados por paciente que requieren firma profesional. |
| POST | `/documents/:id/sign-professional` | Registra firma/confirmación del profesional. |
| POST | `/tablet/login` | Login público de kiosco tablet. |
| GET | `/tablet/session` | Validar sesión de kiosco por bearer token propio. |
| GET | `/tablet/packages` | Cola de paquetes pendientes de la clínica del kiosco. |
| POST | `/tablet/packages/:id/session` | Emitir enlace de firma desde kiosco. |
| GET | `/public/:token` | Abrir paquete de firma por token opaco. |
| POST | `/public/:token/sign` | Firmar paquete por token opaco. |

Nota dev 2026-07-22: el middleware de origen web alojado (`webHostedOrigin`)
debe ignorar siempre rutas internas `/api`, `/oauth` y `/socket.io` antes de
resolver hosts publicados. Esto evita que `tablet.clinicaclick.com` intercepte
`GET /api/consentimientos/public/:token` como si fuera una landing alojada y
devuelva `Página no encontrada` para tokens JWT con puntos.

### Seed Admin Base

Migración de datos:

- `migrations/20260509143000-seed-admin-consentimientos-base.js`

Plantillas base creadas en `ConsentTemplateCatalogs`:

- `cc_base_proteccion_datos_asistencia_v1`: información de protección de datos y asistencia sanitaria.
- `cc_dental_ortodoncia_v1`: consentimiento informado de ortodoncia.
- `cc_dental_implantes_v1`: consentimiento informado de implantes dentales.
- `cc_base_imagen_clinica_v1`: autorización de fotografías clínicas.

Las plantillas usan `variable_schema` y HTML editable. El render de snapshot soporta variables como `{{paciente.documento}}`, `{{cita.fecha}}` y `{{profesional.nombre}}`.

Migración de expansión:

- `migrations/20260510191000-seed-consentimientos-expansion-y-whatsapp.js`

Añade plantillas admin reales para portal del paciente, ácido hialurónico, toxina botulínica y microinjerto capilar, además de la plantilla WhatsApp `clinicaclick_envio_consentimiento_firma` con variable de enlace público de consentimiento. Las plantillas invasivas incluyen `variable_schema.automation` con envío recomendado 24h antes y confirmación de explicación.

Meta no acepta variables al inicio o final absoluto de una plantilla. La plantilla `clinicaclick_envio_consentimiento_firma` no debe terminar en `{{enlace}}`/`{{4}}`; el copy actual añade texto posterior (`Gracias.`) y la migración `20260628085000-fix-consent-whatsapp-template-copy` desactiva revisiones locales fallidas sin `meta_template_id` para que la siguiente propagación abra una revisión válida.

Migración de biblioteca por áreas:

- `migrations/20260724062000-seed-consentimientos-area-library.js`

Añade 9 plantillas admin base para Nutrición, Estética, Capilar y financiación/pago aplazado:

- Nutrición: valoración nutricional y antropometría, plan nutricional y seguimiento, imágenes clínicas privadas de nutrición.
- Estética: láser/luz pulsada, peeling químico e imágenes clínicas antes/después.
- Capilar: PRP/mesoterapia capilar e imágenes clínicas capilares.
- Genérica: información/autorización para financiación o pago aplazado.

Estas plantillas usan `ConsentTemplateCatalogDisciplines` para scope por área y `variable_schema.signing_timing`/`clinical_policy` para momento operativo de firma. Son textos base de Clinicaclick para demo y revisión legal de la clínica; no son copia de textos de terceros y no sustituyen validación jurídica antes de uso definitivo.

Script demo reproducible:

```bash
node src/scripts/qa/prepare-consentimientos-area-library-demo.js
```

Sincroniza de forma idempotente la biblioteca admin en clínicas dev compatibles por `Clinicas.configuracion.disciplinas` (`BS Capilar`, `BS Medical`, `Vitaldiet`, `Clínica Segura y Guerrero`, `Clínica Navae` por defecto) y devuelve URLs de `/consentimientos?tab=templates&clinica_id=<id>`. La evidencia 2026-07-24 queda fuera de git en `/home/ubuntu/secure-imports/clinic-real-20260722/review/ui-validation/consentimientos-area-library-20260724/`.

### Propagación admin a clínicas existentes

- Endpoint: `POST /api/consentimientos/admin/templates/:id/propagate`.
- Usa el scope de la plantilla admin: genérica, áreas (`ConsentTemplateCatalogDisciplines`) y/o tratamientos concretos (`ConsentTemplateCatalogTreatments`).
- Para tratamientos del catálogo base resuelve copias activas de clínica/grupo mediante `id_tratamiento_base` y sincroniza los vínculos en `TreatmentConsentRequirements`.
- Si la clínica ya tiene copia de esa plantilla (`source_catalog_id`) se omite por idempotencia.
- Si el tratamiento resuelto ya tiene un consentimiento activo en esa clínica, la copia entra en `status=draft` para no pisar el flujo actual.
- Devuelve contadores `created_count`, `draft_count`, `skipped_count` y motivos de omisión.

Alias de paciente:

- `GET /api/pacientes/:id/consentimientos`
  - Devuelve el mismo contrato que `GET /api/consentimientos/patients/:id/documents`.

### Integración con citas

- `GET /api/citas`
- `GET /api/citas/:id`
- respuestas de cambio de estado de cita

incluyen `consent_summary` cuando la cita tiene tratamiento con requisitos configurados.

Campos principales de `consent_summary`:

- `appointment_id`
- `package_id`
- `total`
- `required_total`
- `pending_required`
- `pending_optional`
- `signed_total`
- `has_pending`
- `documents[]`

La agenda debe usar `has_pending` para avisos visuales y `pending_required > 0` para bloqueos operativos futuros.

### Automatizaciones

`/api/automations/v2/meta` y `/node-types` exponen el trigger:

```text
consent_required
```

Nombre UI: `Consentimiento necesario`.

Estado actual:

- trigger disponible para construir automatizaciones;
- `action/send_email` sigue stub, por lo que envío por email real queda documentado como mock;
- WhatsApp dispone de plantilla admin para enlace de consentimiento, pero el envío real depende de WABA conectado, plantilla aprobada y resolución de `consentimiento.enlace_publico`;
- al crear/reprogramar cita con documentos pendientes, backend crea/reutiliza paquete y dispara `consent_required` con idempotencia por paquete.

El scheduler no envía recordatorios de consentimiento por su cuenta. Los recordatorios deben vivir en Automatizaciones V2 (`consent_required -> wait -> condición pendiente -> canal`). El scheduler queda para ejecutar pasos programados del motor y mantenimiento técnico de caducidad/estado.

### Subdominio tablet dev

- `https://tablet.clinicaclick.com/tablet` está servido por Nginx con certificado Let's Encrypt propio.
- En dev apunta al build `/home/ubuntu/wt/front-dev/dist/fuse` y al backend `127.0.0.1:3004`.
- El site restringe `/api/` a `consentimientos/public/*` y `consentimientos/tablet/*`; no expone el resto del API dev en ese host.
- Al promover a staging hay que cambiar el root a `/home/ubuntu/www/front-staging` y el proxy al backend staging.

### Reglas de negocio vigentes

- Consentimiento clínico y marketing son finalidades separadas.
- Marketing, imágenes publicitarias y comunicaciones comerciales no deben bloquear un acto clínico.
- Clínica puede adaptar plantillas heredadas del admin.
- La sincronización desde catálogo admin a clínica es una operación interna/superadmin en frontend; el cliente no ve el botón por defecto.
- Área médica sirve para herencia/base; tratamiento concreto manda cuando hay riesgo/invasividad.
- La asociación entre consentimiento de clínica y tratamiento es bidireccional: puede guardarse desde `PUT /treatments/:id/requirements` o desde `POST/PUT /clinic/templates` enviando `tratamiento_ids`.
- Las plantillas de clínica solo exponen `apply_to_group` en UI cuando la clínica pertenece a un grupo; el backend sigue validando permisos/scope.
- El momento operativo de firma se guarda en `ConsentTemplate*Version.variable_schema.signing_timing` / `clinical_policy.signing_timing`; valores actuales: `first_visit`, `before_treatment`, `at_treatment`, `before_each_session`, `at_least_24h_before`, `manual`.
- Los resúmenes de cita y el snapshot firmado exponen `signing_timing`, `signing_timing_label`, `due_policy` y `recommended_min_hours_before` para que agenda/paciente/tablet puedan mostrar cuándo debe resolverse la firma.
- No borrar documentos firmados sin trazabilidad: estados esperados `pending`, `sent`, `viewed`, `signed`, `revoked`, `superseded`, `voided`.
- Los consentimientos reutilizables ya firmados (`data_protection` o `validity_mode=manual`) no se regeneran para nuevas citas del mismo paciente y clínica; pendientes antiguos equivalentes se marcan `superseded`.
- `send-mock` y `tablet-session` solo actúan si el paquete contiene documentos pendientes (`pending`, `sent`, `viewed`); si todo está firmado/cerrado devuelven `409 consent_package_has_no_pending_documents`.
- `tablet-session` encola la firma para el kiosco sin duplicar eventos `queued` del mismo documento.
- La firma profesional se guarda en `PatientConsentDocuments.professional_signed_by` y `professional_signed_at`, además de `snapshot_json.professional_signature_evidence`.
- Menores/tutores deben resolverse en la fase de firma usando los datos ya modelados en paciente.
- QA demo 2026-07-23: `src/scripts/qa/prepare-consentimientos-tablet-demo.js` deja el caso pendiente como cita futura confirmada, asigna un profesional activo de la clínica si existe y deja el caso ya firmado como cita pasada `completada`. Así la ficha de `Demo Firmado Consentimientos` enseña `Todo firmado`, `Ver firmado` y `PDF` sin mezclar una tarea ajena de asistencia pendiente ni `Profesional pendiente`. Revalidado con Chromium/CDP en `demo-consentimientos-tablet-current-20260723/validation-after-ux.json` y flujo kiosco `demo-consentimientos-tablet-20260722/tablet-current-flow-20260723.json`, sin errores HTTP/consola ni overflow.

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
    - `clinica.url_perfil_google`
    - `clinica.url_como_llegar`
    - `clinica.url_dejar_resena`

- Criterio
  - `usuario.*` es el usuario operativo que agenda/crea la cita.
  - `profesional.*` es el doctor o profesional asignado a la cita.
  - `cita.usuario_*` se conserva como alias de compatibilidad para plantillas anteriores.
  - `clinica.url_ficha_local` se conserva por compatibilidad legacy. Para enlaces de ruta debe usarse `clinica.url_como_llegar`.
  - El resolvedor `googleLocalLinks.service` prioriza `ClinicBusinessLocations` activas:
    - `url_perfil_google`: `metadata.mapsUri` o URL generada con `placeId`; fallback a `Clinicas.url_ficha_local`.
    - `url_como_llegar`: URL `https://www.google.com/maps/dir/` con `destination_place_id`; fallback a URL de indicaciones generada con nombre/dirección; último fallback a la ficha manual.
    - `url_dejar_resena`: `metadata.newReviewUri` si Google la devuelve.
  - La plantilla de catálogo `clinicaclick_recordatorio_mismo_dia_primera_visita` debe mapear su posición 4 a `url_como_llegar_clinica` (`{{clinica.url_como_llegar}}`), no a `url_perfil_google_clinica`.

## 2026-04-13 - Contacto de clínica separado y WhatsApp efectivo

- `Clinicas.telefono` se mantiene como compatibilidad legacy.
- Nuevos campos persistidos:
  - `telefono_fijo`
  - `telefono_movil`
  - `telefono_whatsapp`
- `GET /api/clinicas/:id` enriquece la respuesta con:
  - `telefono_whatsapp_conectado`
  - `telefono_whatsapp_efectivo`
  - `whatsapp_connected`
  - `whatsapp_connection_scope` (`clinic | group`)
  - `whatsapp_public_source` (`clinic_meta | clinic_manual | group_meta`)
- `telefono_whatsapp` conserva exclusivamente el override público/manual persistido de la sede. `telefono_whatsapp_conectado` se deriva de `ClinicMetaAsset` (`assetType='whatsapp_phone_number'`) priorizando asignación de clínica y usando grupo como fallback; nunca se copia de vuelta al campo manual.
- `telefono_whatsapp_efectivo` es el contacto público: activo Meta propio, después override manual de sede y por último activo Meta de grupo. El remitente para automatizaciones sigue resolviéndose por `whatsappService.getClinicConfig()` y solo puede ser un activo Meta propio/heredado con credenciales; un número público manual no se presenta como remitente API.
- `GET /api/intake/config` construye `available_locations[].whatsapp` con prioridad:
  1. WhatsApp Business conectado a la clínica.
  2. `Clinicas.telefono_whatsapp`.
  3. WhatsApp Business conectado al grupo.
  4. móvil/fijo normalizado como fallback.
- `GET /api/intake/config` añade `available_locations[].opening_hours_text` para variables de chat. Se calcula desde `ClinicaHorarios` activos y agrupa días consecutivos con el mismo horario, por ejemplo `L-J de 9 a 20h y V de 10 a 14h`.
- `normalizeConfiguredLocations()` prioriza siempre los teléfonos efectivos actuales sobre snapshots antiguos guardados en `IntakeConfig.config.locations`; el alias público de nombre sí continúa siendo una personalización del editor. Así, cambiar un número de clínica no deja el widget ni la atribución apuntando al número retirado.
- En `CallInitiated` de scope de grupo, la sede se resuelve contra `telefono`, fijo, móvil, WhatsApp manual, aliases explícitos de location y activos Meta asignados a la clínica. Un activo de grupo no identifica una sede. Si el mismo número coincide en más de una clínica, no se elige la primera: se conserva el scope de grupo hasta tener URL/selección inequívoca.
- El runtime `assets/intake.js` aplica el mismo criterio antes de crear el lead: compara `phone`, fijo, móvil, WhatsApp y aliases; si el número es compartido intenta la URL pública más específica. Los botones automáticos de llamada/WhatsApp solo usan sede elegida, URL inequívoca, única sede o un único número común; queda prohibido usar la primera sede de un grupo como fallback porque produciría atribución y conversiones falsas.
- Los enlaces WhatsApp que ya existan en la web también quedan instrumentados: el click se mide con navegación segura mediante `keepalive` y se añade el `cc_ref` al mensaje sin borrar el texto previo. Esto permite confirmar el inbound cuando el destino es un activo Meta conectado; con un WhatsApp público manual solo puede medirse el click, no leer la conversación ni completar su ciclo offline automáticamente.
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
- El resumen de paciente (`GET /api/pacientes/:id`) usa el mismo criterio operativo para `proxima_cita`/`ultima_cita`: una cita en estado `reprogramada` debe seguir mostrándose en ficha/QuickChat si conserva fecha futura o si está en curso (`fin >= now`). Solo `cancelada` se excluye de estos bounds.
- `reprogramada` no es terminal para acciones manuales de UI: se puede pasar a `info_confirmada`, `recordatorio_confirmado`, `completada`, `no_asistio` o `cancelada`. Sí sigue cancelando ejecuciones de automatización previas cuando se dispara el evento de reagendado, para no enviar mensajes de la hora antigua.

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
- Cuando `response_buffer_enabled=true`, el runtime agrupa respuestas partidas del paciente durante 90 segundos por defecto antes de reanudar el flujo. Esto evita falsos negativos si el paciente responde en dos mensajes seguidos, por ejemplo `Buenos días` y después `sí confirmo`. Se puede ajustar por nodo con `response_buffer_delay_seconds` o por entorno con `AUTOMATIONS_V2_RESPONSE_BUFFER_SECONDS`.
- `waiting_meta.runtime_namespace` y `payload.__runtime_namespace` deben apuntar al mismo runtime que reclama jobs en ese entorno.
- Si el mensaje outbound escuchado salió más tarde por horario silencioso, `wait_starts_at` debe anclarse a esa hora efectiva de salida, no a la entrada inicial al nodo.
- En guardado/publicación, `listens_to_node_id` solo es válido si apunta a un nodo outbound real (`action/send_whatsapp`, `action/send_email` o `action/request_review`). Los duplicados o plantillas antiguas pueden arrastrar IDs existentes pero incorrectos; backend los normaliza recorriendo el grafo hacia atrás y, si no encuentra outbound, rechaza la configuración.
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
| POST | `/api/marketing/google-ads/conversions/data-manager/validate` | Operativo | valida formato, acceso y destino con `validateOnly`; no ingiere una conversión |
| POST | `/api/marketing/google-ads/conversions/enhanced/activation-gate` | Interno/compatibilidad | preview del gate Enhanced; no pulsa el switch de Google ni sustituye el reconciliador automático |
| GET | `/api/marketing/campaign-optimization/status` | Operativo/read-only | estado y evaluaciones del lifecycle de optimización; no aplica transiciones |

El bootstrap mantiene separado el scope solicitado del scope web efectivo. En una clínica incluida explícitamente en `groupRecord.config.locations`, `scope.web_measurement_scope=group`, `web_measurement_source=group_web_location` y `web_measurement_group_id` identifican que dominios, HMAC y `consent_readiness` proceden de la configuración compartida. Esto evita que un `IntakeConfig` local vacío o histórico oculte una medición de grupo ya verificada; cuentas y activos publicitarios siguen resolviéndose con sus reglas de ownership habituales.

Los `external_targets` guardados dentro de una estrategia son un snapshot editable, no la fuente del estado actual de Google/Meta. Al listar o abrir una estrategia, backend superpone `name` y `status` desde `ExternalCampaignInventory` por identidad `provider + account + campaign`, conservando el snapshot y sus métricas. El selector de campañas aplica la misma superposición después de agregar históricos; `MAX(campaignStatus)` no puede decidir si una campaña está activa y `active_only` se filtra solo después de incorporar el inventario actual.

#### Contrato seguro de conversiones Google Ads (2026-07-11)

- la comprobación de dominio emite una attestation firmada de corta duración: solo puede enviarse como prueba nueva durante 15 minutos; una vez aceptada por backend, readiness revalida siempre firma, scope, dominio, HMAC y hash de configuración, pero usa una vigencia operativa separada de 24 horas (`INTAKE_PERSISTED_VERIFICATION_TTL_SECONDS`, máximo 7 días). Cambiar dominios, proveedor, URLs legales o HMAC invalida la prueba aunque siga dentro de esa ventana;
- listado y `ensure` requieren `clinic_id` o `group_id`; ya no toman la conexión Google del usuario como credencial implícita;
- la conexión OAuth y la cuenta Ads se resuelven por scope y se valida que `customer_id` esté asignado a ese mismo scope y conexión;
- `POST .../ensure` es de solo lectura por defecto (`create_missing=false`); para crear acciones externas exige simultáneamente `create_missing=true` y `confirm_external_mutation=true`;
- el `login_customer_id` se toma del mapeo `ClinicGoogleAdsAccount`, no del request ni de una cuenta manager global;
- la carga server-side no acepta que el navegador sustituya `customer_id` o `conversion_action` configurados;
- un evento puede tener varios destinos mediante `events.<evento>.destinations`; cada destino resuelve de forma independiente la conexión OAuth y el `ClinicGoogleAdsAccount` que contiene su `customer_id`;
- cada intento viable queda en `GoogleAdsConversionUploadAttempts` con `destination_key`, scope, conexión resuelta, estado, motivo y metadatos saneados; el click id se conserva solo como hash y no se guardan email ni teléfono;
- `dedupe_key` evita repetir un evento ya aceptado en el mismo `customer_id + conversion_action`; destinos Google distintos se deduplican de forma independiente y los reintentos fallidos conservan un historial acotado;
- el agregado devuelve `accepted=true` si al menos un destino fue aceptado (en este intento o previamente por dedupe), `sent_count` para las subidas nuevas y `partial=true` cuando otro destino falla o se omite; un fallo de una cuenta no invalida la aceptación de la otra;
- solo `lead`, `contact`, `qualified_lead`, `schedule` y `purchase` pueden subir conversiones; eventos de navegación como `ViewContent` no hacen fallback a `lead` aunque lleven `gclid`; `qualified_lead` exige siempre un destino explícito y nunca hereda la acción global legacy de Lead;
- una denegación de consentimiento bloquea la llamada externa y se registra como `skipped/consent_not_granted`;
- los tests dirigidos no llaman a Google: `node src/scripts/tests/google_ads_conversion_tracking.test.js`.

#### Activación automática y consentimiento de Conversiones mejoradas (2026-07-13)

- `ad_personalization` ya no se fija a `DENIED`: cuando existe un envío permitido, el uploader deriva la elección real por visitante y la envía a Data Manager como `GRANTED` al aceptar marketing/todo o `DENIED` al rechazar personalización. Un rechazo completo de marketing bloquea la llamada externa como `consent_not_granted`; no se fabrica un envío únicamente para comunicar `DENIED`;
- el aviso frontend v5 agrupa `ad_user_data` y `ad_personalization` bajo una única elección comprensible de **Marketing**. El backend no fusiona el contrato: conserva, valida y transmite ambas señales por separado, y la PII hasheada solo se habilita con `ad_user_data=GRANTED`;
- `features.ad_personalization_enabled=true` es una capacidad para reflejar esa elección, no una concesión de consentimiento. El default usa `ad_personalization_consent_source=visitor_choice`; si falta una elección válida, no se envía user data;
- no se habilitan Customer Match, listas basadas en conversiones, audiencias ni remarketing. Tampoco se envían URL, tratamiento o contexto clínico junto a email/teléfono;
- el job `googleDataManagerDiagnostics`, ya programado cada 30 minutos, empieza con una reconciliación **global** de la capacidad `visitor_choice`: pagina por `IntakeConfig.id`, relee cada fila dentro de una transacción con `SELECT ... FOR UPDATE` y materializa únicamente `features.ad_personalization_enabled=true`, `ad_personalization_consent_source=visitor_choice` y su audit v2 con el scope real. Conserva todo el resto de `locked.config`, procesa las filas de forma aislada y acepta el audit v1 ya aplicado al grupo Propdental. Repetir el barrido no escribe ni cambia `applied_at`. Para resultados Data Manager, el ciclo solo selecciona intentos `accepted` cuyo `updated_at` tenga al menos 30 minutos; cuando alcanzan `succeeded`, `partial_success` o `failed` no vuelve a consultarlos;
- Google recomienda esperar 30 minutos antes del primer `RetrieveRequestStatus`, aplicar backoff exponencial `1.3` hasta un máximo de 60 minutos y admitir hasta 24 horas de procesamiento ([Diagnostics, Data Manager API](https://developers.google.com/data-manager/api/devguides/diagnostics)). Por eso un `PROCESSING` no se fuerza ni se sondea manualmente cada diez minutos: queda al scheduler durable hasta terminal;
- esta fase global no consulta Google, no habilita user data y declara siempre `grants_consent=false`: solo permite que el runtime refleje una elección futura del visitante. Después, de forma separada, el mismo job reconcilia la activación Enhanced **solo** del grupo Propdental cuando todas las cuentas configuradas están mapeadas, tienen términos aceptados, devuelven `enhanced_conversions_for_leads_enabled=true`, Consent Mode/attestations están vigentes y OAuth dispone de Ads + Data Manager y quota project. Una activación nueva o una reconfiguración continúa exigiendo esa prueba vigente;
- ambas reconciliaciones solo actualizan `IntakeConfig`: no crean ni modifican acciones, objetivos, pujas o campañas en Google. Los errores de una fila global no interrumpen las siguientes y quedan en `SyncLog.status_report.visitor_choice_personalization_reconciliation`; el job se marca fallido para hacerlo visible y vuelve a intentarlo en el siguiente ciclo. El gate Enhanced conserva su propia clave SHA-256, allowlist y control de concurrencia;
- `GET /campaign-onboarding/bootstrap` es estrictamente read-only: expone `active`, `pending_reconciliation` o `blocked`, pero nunca ejecuta la activación. No hay dependencia del botón Play;
- el audit embebido conserva versión, clave, fuente, scope y resultado de cada fase; `SyncLog.status_report.visitor_choice_personalization_reconciliation` registra el barrido global y `internal_enhanced_conversion_activation` el gate Propdental. Ambos reportes carecen de PII y declaran `google_ads_mutated=false`;
- una attestation operativa caducada tiene semántica de **renovación de la observación web**, no de retirada retroactiva de la autorización del anunciante. `assessConsentMeasurementReadiness` devuelve `verification_current=false`, `renewal_required=true` y `runtime_configuration_ready=true` solo si firma, scope, dominio, hash de configuración y señales persistidas siguen siendo coherentes. El gate ya aplicado puede responder `already_active + ready=true` con ese aviso, pero no concede consentimiento: cada evento sigue necesitando la elección viva del visitante. Una firma inválida, cambio de configuración, dominio sin cubrir, cuenta apagada, allowlist incoherente o cualquier drift no temporal continúa bloqueando. La renovación se obtiene volviendo a **Comprobar web**; no se amplía el token ni se inventa una verificación desde el scheduler;
- tras un gate Enhanced sano, `googleDataManagerDiagnostics` llama a `reconcileVerifiedConnectOnlyStrategyActivationReadiness`: relee acciones y ejecuta Data Manager `validateOnly` con `createMissing=false`; solo las clínicas `19/35/56/58/59` declaradas en `groupRecord.config.locations` pueden heredar la configuración web de `propdental.es`, mientras Francia `36` y Eixample `57` quedan bloqueadas hasta tener `IntakeConfig` propio válido. Para cada request Propdental `active + connect_only + new_patients + Google`, revalida snapshots ausentes, caducados o con drift de clave/scope/cuentas, exige evidencia completa por action/target y vuelve a comprobar fingerprints bajo locks antes de corregir únicamente `solicitud.activation_readiness`. Guarda scope validado, snapshot anterior y clave de reconciliación, tolera concurrencia, es idempotente y se audita en `SyncLog.status_report.connect_only_strategy_readiness_reconciliation`. Declara `external_mutation_performed=false`/`google_ads_mutated=false`, no toca `Campaign`, goals, pujas o Google y no activa Piloto automático;
- la auditoría durable `googleConversionGoalPolicyAudit` (`17 2 * * *`) ya no descubre solo `google_ads.goal_policy.enabled`. Mantiene esa auditoría de Piloto automático y añade como target `connect_only_measurement` la configuración de medición efectiva de cada estrategia activa `connect_only + new_patients + Google`. Una fila de grupo cubre una sola vez sus `locations`; no se vuelven a auditar sus overrides de clínica. Para **Mide y entiende** (`connect_only`, antes **Conecta y mejora**) relee acciones canónicas, compara el ID configurado de cada destino con el ID canónico observado, comprueba estado/counting/secundaria, scopes/quota, ejecuta Data Manager `validateOnly`, valida allowlist Enhanced y clasifica consentimiento/renovación. El `SyncLog` separa `goal_policy_target_count` y `connect_only_measurement_target_count`; `target_count` es su suma. No autorepara ni muta campañas, goals, pujas, acciones o configuración Google. Una attestation caducada coherente es warning; el drift real es critical y activa el flujo `jobs.failed`;
- cada target `connect_only_measurement` añade `campaign_quality`, generado por `googleAdsConnectOnlyQualityAudit.service.js`. Ensambla la unión deduplicada por `customer_id + campaign_id` de las referencias Google declaradas en `external_targets`, `targets` o `measurement.external_targets` de la estrategia y los `campaign_ids` de los destinos canónicos de medición. Estos destinos ya proceden del gate scoped; cada cuenta ha pasado por `resolveScopedGoogleAdsRuntime` y el auditor comprueba que el runtime, nuevo o reutilizado desde la caché del mismo ciclo, corresponde a esa cuenta. Incorporar una campaña usada para enrutar conversiones no amplía clínicas, grupos ni cuentas. La estrategia conserva la etiqueta cuando una referencia aparece en ambos orígenes. Usa exclusivamente `POST customers/{id}/googleAds:search`, troceando el inventario en lotes de hasta 200 IDs por cuenta: una consulta agregada de los últimos 30 días para existencia, estado, canal/subtipo, puja, presupuesto, estado primario/motivos, coste, impresiones, clics, conversiones/valor y `optimization_score`; una lectura de `conversion_goal_campaign_config`/custom goal; y, si la consulta con métricas omite una campaña, un fallback de existencia sin métricas. Si la versión/cuenta rechaza `optimization_score`, repite la lectura sin ese campo y lo declara no disponible. Una prueba de 201 campañas confirmó dos consultas de calidad + dos de goals y 201/201 observadas. Otra regresión con cuentas conceptuales `185...`/`599...` cubre campañas solo de medición, solo de estrategia y duplicadas, sin cruzar cuentas ni emitir mutaciones. El resultado clasifica campañas ausentes, eliminadas/pausadas, limitaciones de entrega, score inferior al 70 %, gasto sin conversiones y alineación con una única señal canónica de puja; genera recomendaciones, nunca las aplica. En una campaña pausada, la ausencia de mapping canónico es warning, no un fallo que bloquee medición;
- `campaign_quality` persiste en la allowlist de `SyncLog.status_report.connect_only_measurement_targets`: no conserva tokens ni claves arbitrarias del proveedor y fuerza `autorepair=false`, `external_mutation_count=0` y `google_ads_mutated=false`. Sus incidencias permanecen dentro del subreporte de calidad: no alteran `runtime_ready`, no convierten por sí solas el job en fallo y un error técnico de esa lectura se expone como warning exterior. El gate de medición/Enhanced conserva sus propios críticos. Evidencia live del 2026-07-16: se descubrieron 3 targets **Mide y entiende** y 0 de goal policy. El grupo Propdental (`IntakeConfig #24`) quedó `measurement_healthy=true`, `runtime_ready=true`, 8/8 destinos `validateOnly`, 0 críticos y un warning renovable de attestation. El primer corte observó 30/30 campañas del snapshot de estrategia. Tras corregir la unión, el segundo corte ejecutado con el código nuevo observó **35/35** referencias únicas —17/17 en `185...` y 18/18 en `599...`—, incluyó las cuatro Smart, incluida `Buenos Dentistas y Personal`, y devolvió 0 críticos y 92 incidencias/recomendaciones consultivas. `ChangeEvent` fue 0 en ambas cuentas, no se creó `SyncLog` y el contrato mantuvo `autorepair=false`, `external_mutation_count=0` y `google_ads_mutated=false`; las campañas activas siguen heredando goals legacy a nivel de cuenta. Francia mostró 4/10 observables porque `599...` no está asignada a esa clínica y Eixample 0/4 porque ninguna cuenta está asignada a su scope. Son gaps explícitos de asignación/remediación, no permiso para ampliar scopes o mutar Google;
- la política de valores v1 usa Lead `0 EUR`, Contact `0 EUR`, Qualified Lead `10 EUR` y Schedule `40 EUR` como pesos de reporting/optimización (`value_is_revenue=false`). Schedule es una cita agendada/vinculada, no necesariamente confirmada o atendida. Purchase no se materializa por este gate: aunque el servicio actual puede construirlo con `Tratamientos.precio_base` o `0`, Propdental lo mantiene deshabilitado porque ese catálogo no demuestra ingreso/margen real. Este flujo no cambia automáticamente la estrategia de puja ni los objetivos de Google;
- estado live verificado el 2026-07-13 `09:38:42 UTC`, con staging backend `323e4a4` y frontend `a1c875ea`: una lectura directa a Google devolvió términos aceptados y `enhanced_conversions_for_leads_enabled=true` para `1851215478` y `5992356722`; Data Manager aceptó `validateOnly` en ambas. El reconciliador post-Verificar devolvió `already_active`, `ready=true`, fue idempotente y declaró `google_ads_mutated=false`. La activación interna no depende de Play ni muta Google Ads;
- reconciliación global `visitor_choice`: 18 `IntakeConfig` examinadas, 17 `activated`, 1 `already_active`, 0 errores y `grants_consent=false`. `features.ad_personalization_enabled=true`, user data y Enhanced son capacidades server-side; ninguna concede Marketing por el visitante;
- cierres publicitarios naturales por etapa: el intento Lead `#7`, enlazado a `LeadIntake #7184`, usó action `7680195320` y destino `propdental_parallel_185` y terminó `SUCCESS` con `record_count=1`. `LeadIntake #7193`, Badalona `58`, `paid`, `web/tel_modal`, originó el intento Contact `#10` hacia el mismo destino, customer `1851215478` y action `7680195323`; con consentimiento `GRANTED` y GCLID pasó `accepted -> SUCCESS`, un registro, cero warnings/errores y `attempt_count=1`, sin duplicado. Ambos eran GCLID-only y no acreditan identificadores Enhanced;
- prueba controlada post-fix: `JobRequest #23703` / `SyncLog #65186` completó a las `20:12:50 UTC`. El intento Lead `#22`, action `7680195320`, destino `propdental_parallel_185` y `provider_request_id=82561176-073e-40f5-a659-ed8fd4ef24d7`, registró `user_data_requested=true`, `user_data_sent=true`, dos identificadores `[email, phone]`, `record_count=1` y cero warnings. Diagnostics terminó `FAILURE/INVALID_GCLID` exclusivamente porque el click ID era sintético. Esto acredita normalización/hash, inclusión, transporte, recepción y diagnóstico asíncrono de user data sobre el mismo mapping Lead que el cierre natural `#7`; no acredita una conversión atribuida. Los intentos controlados `#19/#21` cerraron con el mismo error esperado de click ID sintético;
- evidencia histórica de reconciliación: `JobRequest #23801` / `SyncLog #65272` observó el intento `#20` todavía en `PROCESSING`; ese estado no era terminal y no se interpreta como cero conversiones. El scheduler, no un sondeo manual, conservó su responsabilidad. Esta fotografía queda superada como criterio global por los siete terminales Enhanced naturales posteriores de `185...`;
- limpieza controlada: `LeadIntake #7207/#7209/#7210` y sus artefactos pasaron `dry-run -> simulate -> apply` con reconocimiento explícito de que borrar localmente no retracta eventos externos; el postcheck devolvió cero. Los naturales `#7184/#7193/#7194` permanecieron intactos. La evidencia funcional todavía pendiente es un terminal natural postmigración en `599...` y los hitos `qualified_lead`/`schedule` cuando el equipo avance leads reales. No deben simularse desde documentación ni inferirse de Lead/Contact;
- regresión QA verde con `node src/scripts/tests/<nombre>.test.js`: `google_data_manager_conversion`, `enhanced_conversion_activation_gate`, `google_ads_conversion_tracking`, `intake_config_write_merge`, `visitor_choice_personalization_reconciliation`, `google_ads_clinicaclick_goal_policy`, `cleanup_intake_e2e_run`, `google_lead_lifecycle_conversion`, `appointment_lead_milestone_conversion`, `campaign_conversion_readiness`, `campaign_optimization_lifecycle` —12 casos—, `managed_campaign_optimization_policy`, `scheduled_jobs_orchestration`, `intake_lead_consent`, `intake_form_clinic_location`, `intake_page_clinic`, `intake_snippet_runtime`, `intake_quickchat_summary`, `intake_quickchat_outbox`, `lead_attribution_view`, `google_ads_campaign_attribution_suffix` e `intake_legacy_chat_detector`. Cubren transporte, gates, ownership, consentimiento, routing/labels, atribución de campaña, chat legacy, snippet, QuickChat durable, hitos, readiness, optimización y jobs. Qualified Lead/Schedule están cubiertos en código, pero eso no sustituye sus terminales naturales pendientes.
- lectura Google live read-only `21:23-21:24 UTC`: en `1851215478`, Lead `7680195320`, Contact `7680195323`, Qualified Lead `7682299115` y Schedule `7680638785`; en `5992356722`, Lead `7540337982`, Contact `7540337985`, Qualified Lead `7682721076` y Schedule `7540337988`. Las ocho acciones estaban `ENABLED`, `UPLOAD_CLICKS`, `MANY_PER_CLICK`, `primary_for_goal=false`, fuera de `include_in_conversions_metric`, con default `0` y `always_use_default_value=false`. La policy de payload sigue `0/0/10/40` como pesos no económicos. Purchase está deshabilitado y fuera de estas ocho/Enhanced;
- evidencia natural Enhanced al corte `2026-07-15 15:30 UTC`: los siete intentos reales `#25/#26/#27/#28/#30/#32/#33` terminaron `succeeded/SUCCESS`, todos con `consent_status=GRANTED`, `explicit_ad_user_data=GRANTED`, elección de personalización presente, `user_data_sent=true` y dos identificadores `[email, phone]`. El transporte normaliza y aplica SHA-256 antes de construir `event.userData`; la auditoría solo conserva flags/tipos, nunca email, teléfono ni sus hashes reutilizables. Los siete corresponden todavía a Lead de la cuenta `1851215478`: acreditan el terminal asíncrono enriquecido real, pero no sustituyen terminales naturales de Qualified Lead/Schedule ni prueban la cuenta `5992356722`;
- dry audit live read-only `2026-07-15 23:42 UTC` sobre `IntakeConfig #24`: `8/8` destinos Lead/Contact/Qualified Lead/Schedule de ambas cuentas coincidieron con la acción canónica y pasaron Data Manager `validateOnly`; `critical_count=0`, allowlist activa y `runtime_ready=true`. Solo quedó el warning renovable de attestation de `propdental.es`. No persistió `SyncLog`, no creó conversiones y declaró cero mutaciones Google;
- las acciones canónicas permanecen deliberadamente **secundarias globales**. Por eso esos terminales enriquecen atribución y aparecen en **Todas las conversiones / All conversions**, pero no entran por sí solos en la columna `Conversions` ni cambian la puja de campañas existentes. **Mide y entiende** nunca las hace primarias. Piloto automático deberá hacer opt-in explícito por cohorte mediante su custom goal de una única etapa aprobada; no se cambia `primary_for_goal` global ni se reescribe la historia de conversiones del cliente;
- auditoría de campañas live 2026-07-16: en `185...`, Badalona Search tiene fuerza `POOR`; Hospitalet/Nou Barris/Sant Martí concentran keywords con quality score `<=4`; los ocho asset groups PMax revisados están `AVERAGE` y varios limitados por política/activos, con presión de presupuesto en Nou Barris/Badalona. En `599...`, las cuatro Smart activas (`Dentista en Hospitatet`, `Clinica Dental Badalona`, `Clinica Dental en Badalona`, `Buenos Dentistas y Personal`) mantienen `TARGET_SPEND` y objetivos legacy. Las campañas heredadas todavía optimizan un catálogo amplio de acciones primarias/valores históricos del anunciante, no las etapas ClinicaClick. Son gaps de recomendación; `connect_only` no autoriza su mutación;
- llamadas: `call_reporting_enabled=false` en las dos cuentas. Se conservan teléfonos, call assets y acciones históricas; no hay Google forwarding numbers ni duración dentro del objetivo nuevo. La presencia de una acción `AD_CALL`/Smart legacy habilitada no contradice este estado y no debe confundirse con reporting activo;
- prueba negativa de mutación en el mismo corte: cero custom goals ClinicaClick, cero `CampaignOptimizationPolicies`, cero `ChangeEvent` de hoy sobre las 19 campañas/recursos revisados, todas las estrategias Propdental en `connect_only` y el único `ManagedCampaign` en `draft + observe`, no aprobado. `#20` seguía `accepted/provider_processing` por separado. No se cambiaron campañas, goals, pujas, presupuesto o estados.

#### Ownership y escrituras seguras de `IntakeConfig` (2026-07-13)

`IntakeConfig.config` mezcla campos editables desde Marketing > Web con estado que solo puede materializar el backend. No se puede normalizar un payload del navegador y usarlo como reemplazo completo del JSON persistido: los normalizadores de Google/Meta son deliberadamente *lossy* para lectura y omiten auditorías, policies y campos futuros.

- `POST/PUT` del editor parte siempre de la fila más reciente bajo `SELECT ... FOR UPDATE`. Solo aplica una allowlist de campos realmente editables y conserva por defecto cualquier clave desconocida.
- `features.ad_personalization_consent_source`, `features.ad_personalization_activation_audit` y las banderas `google_ads_user_data_*` pertenecen al reconciliador. `google_ads.user_data_enabled`, `google_ads.enhanced_conversions`, `google_ads.goal_policy`, `qualified_lead`, destinos, valores y campos futuros son también server-owned.
- La personalización publicitaria no tiene un segundo interruptor manual en Marketing > Web: es una capacidad automática. La decisión efectiva sigue siendo la elección `Marketing` de cada visitante; rechazarla conserva `DENIED`.
- `googleDataManagerDiagnostics` materializa esa capacidad cada 30 minutos en todas las filas legacy, no solo en Propdental. El barrido pagina identidades y fusiona sobre cada `locked.config`; un audit canónico devuelve `already_active` sin escritura y nunca concede consentimiento.
- `mutation_kind=snippet_verification` es una mutación estrecha. Bajo el mismo lock reutiliza dominios, HMAC y config actuales, reconstruye la prueba confiable desde attestations y modifica únicamente `snippet_verification`. No guarda una snapshot del editor.
- `mutation_kind=domain_add` es la escritura estrecha equivalente para el asistente de campañas: canonicaliza un único dominio, relee la fila bajo el mismo lock y lo añade por unión a los dominios actuales. Conserva HMAC, configuración y estado server-side; no permite que una pantalla todavía cargando reenvíe una snapshot antigua del editor ni sobrescriba la configuración compartida del grupo. Si el usuario opera una clínica incluida explícitamente en `group.config.locations`, mantiene la autorización sobre esa clínica y backend resuelve la fila web grupal para esta mutación estrecha; leer el admin config, obtener el snippet y verificar siguen el mismo criterio. Una escritura completa del grupo continúa exigiendo permiso de grupo y devuelve `409` desde scope clínica.
- Las attestations confiables conservan también `legacy_chat_detected` y `legacy_chat_provider`. Al reconstruir `snippet_verification`, backend agrega por dominio esa señal firmada; la UI solo puede aconsejar retirar JoinChat u otro chat anterior cuando la detección real sea positiva. La ausencia o falta de comprobación no se convierte en una advertencia inventada.
- Los writers de onboarding de `campaigns`, Google y Meta adquieren el mismo lock. El provisioning de acciones superpone su resultado normalizado sobre el objeto Google raw, por lo que no elimina Enhanced, valores o `goal_policy`.
- La propagación de plantillas de chat recalcula cada `flows` desde `locked.config` dentro de una transacción por clínica; nunca guarda la snapshot precargada antes de que otro writer materialice estado server-side.
- El endpoint público proyecta un `config` saneado: no devuelve attestations, hash de verificación, audits Enhanced o `goal_policy`. El endpoint admin autenticado conserva la vista completa necesaria para operar.
- `snippet_verification` no es decoración: participa en Consent readiness, en el gate Enhanced y en la reconciliación de `activation_readiness`. Diagnostics es una red de seguridad ante drift, no un sustituto de escrituras aisladas.
- Regresiones canónicas: `node src/scripts/tests/intake_config_write_merge.test.js` y `node src/scripts/tests/intake_verification_attestation.test.js`. Deben conservar `google_ads.goal_policy`, unknown fields, Enhanced, valores/destinos y comprobar locks, mutaciones estrechas, señales firmadas de chat anterior y proyección pública saneada.
- comprobación live post-deploy: Chromium admin pulsó Verificar a las `09:38:42 UTC`; el fingerprint protegido abreviado `a04c971…044b` permaneció idéntico antes/después y solo cambió `snippet_verification.verified_at`. Enhanced, user data y personalización quedaron activos, los valores `Lead=0`, `Contact=0`, `Qualified Lead=10`, `Schedule=40` se conservaron y Purchase siguió deshabilitado. El GET público no expuso attestations, hash, HMAC, Enhanced, `goal_policy` ni auditorías.

Formato de configuración multi-cuenta por evento:

```json
{
  "google_ads": {
    "enabled": true,
    "currency": "EUR",
    "events": {
      "lead": {
        "enabled": true,
        "destinations": [
          {
            "key": "cuenta_paralela_185",
            "enabled": true,
            "customer_id": "1851215478",
            "conversion_action_id": "<ID_ACCION_LEAD_185>",
            "currency": "EUR"
          },
          {
            "key": "cuenta_principal_599",
            "enabled": true,
            "customer_id": "5992356722",
            "conversion_action_id": "<ID_ACCION_LEAD_599>",
            "currency": "EUR"
          }
        ]
      }
    }
  }
}
```

Se repite el mismo esquema en `contact`, `qualified_lead`, `schedule` y `purchase`, usando en cada uno el ID de su acción. `qualified_lead` exige destinos explícitos y nunca hereda el mapping legacy de Lead. `key` es una etiqueta estable de auditoría y no la aporta el navegador. Si la propiedad `destinations` no existe, continúa vigente el formato histórico de un único `customer_id`/`conversion_action_id` por evento. Un `destinations: []` explícito no hace fallback: deja el evento sin destinos y, por tanto, sin subida. En modo multi-destino, cualquier `customer_id`, `conversion_action`, `conversion_action_id` o `send_to` recibido desde el navegador invalida la selección completa y audita todos los destinos como `request_target_override_not_allowed`.

#### `new_patients`: Mide, Mejora y Piloto automático (2026-07-17)

La respuesta de bootstrap ofrece `connect_only`, `guided_improvement` y `managed_service`; `managed_self` permanece en `legacy_modes` exclusivamente para lectura histórica. El frontend lo rotula como solo lectura, oculta edición y transiciones y bloquea también la entrada directa al wizard; el backend aplica la misma frontera antes de normalizar el payload o procesar el lifecycle y devuelve `409 legacy_mode_read_only` ante edición, creación o transición de estado. `connect_only` mide, atribuye y sube conversiones consentidas sin crear ni aplicar un destino nuevo. La única excepción de mutación es un rollback de seguridad, automático o solicitado manualmente: puede restaurar exclusivamente el `beforeState` capturado por una operación autorizada antes del downgrade a Mide y entiende; nunca acepta una URL arbitraria ni reutiliza el binding para aplicar su `desiredState`. `guided_improvement` trabaja sobre campañas existentes y puede gestionar el objetivo de conversión y publicar una landing para campañas Google Search/PMax vinculadas, después de guardar la autorización cliente v1 con los scopes exactos `conversion_goal`, `landing_publish` y `campaign_destination`; nunca puede tocar pujas, presupuesto, segmentación ni activar/pausar campañas. Con esa autorización válida, `mode_contract.publish_landings=true`, `change_destinations=true`, el hook `marketing_web.landing_published.v1` queda `available` y el destino queda `available_after_landing_published`. Publicar no cambia Google automáticamente: materializa un binding auditable y el usuario debe confirmar una segunda operación acotada al digest exacto del destino, las cuentas seleccionadas y `readback_required=true`. El worker serializado aplica URL final en anuncios Search o en asset groups PMax, persiste la decisión explícita sobre expansión de URL, relee Google y solo marca éxito si todo coincide. Un fallo parcial encola rollback compensatorio al estado anterior; la auditoría diaria `marketing_campaign.destination_drift_audit.v1` detecta cambios posteriores sin autorepararlos. Los destinos web solo admiten URL HTTPS públicas y estables, sin credenciales, fragmento, host privado ni parámetros efímeros de atribución/firma/caducidad. `managed_service` usa el mismo puente únicamente dentro de una `ManagedCampaign` aprobada y de sus constraints; guardar la estrategia solo provisiona una spec por canal en `draft + observe`, junto con su cuenta `unfunded`, y no llama a Google/Meta.

El resultado de esa auditoría se persiste como
`CampaignDestinationBindingEvent.event_type=drift_detected`, no como texto de
log efímero. La migración aditiva `20260718225000` incorpora el valor al ENUM;
el job está registrado en `scheduledJobCatalog`/`sync.jobs` con horario diario
`5 3 * * *`. No se reduce a 30 minutos ni existe un cron paralelo.

`POST /api/marketing/campaign-onboarding/start` configura exclusivamente `connect_only` o `guided_improvement`. Aunque `managed_service` continúa expuesto en bootstrap y legible en configuraciones históricas, intentar seleccionarlo o transicionar hacia él por este endpoint devuelve `409 managed_service_request_required`, `next_action=request_managed_campaign` y la ruta canónica `/api/marketing/managed-campaigns/request`. La guarda se evalúa antes de resolver el scope, comprobar transiciones o crear un `CampaignRequest`; por tanto no deja onboardings parciales. El alta de Piloto automático debe entrar siempre por la solicitud gestionada y sus gates de presupuesto, financiación, propuesta y aprobación.

Cambiar entre niveles es una operación explícita: el cliente debe confirmar exactamente `from_mode` y `to_mode`; el backend bloquea el cambio si queda otra estrategia no completada o una policy activa/pausada en el alcance. Esto incluye la salida desde el histórico `managed_self`. No se sobrescriben ni eliminan policies para aparentar una migración. Mejora no admite una estrategia Meta-only: debe existir al menos una campaña Google vinculada. En campañas externas `channels[].percentage` no expresa reparto gestionado y se conserva en cero en vez de inventar un 100/0.

Rutas cliente actuales:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/marketing/managed-campaigns?clinic_id=` | Proyección segura sin comisión, neto de medios ni refs internas. |
| POST | `/api/marketing/managed-campaigns/request` | Solicitud con presupuesto orientativo, benchmark congelado, observación + funding vacío. |
| GET | `/api/marketing/managed-campaigns/:id` | Detalle cliente por scope. |
| POST | `/api/marketing/managed-campaigns/:id/approve` | Aprobación cliente cuando está en `pending_client_review`. |
| POST | `/api/marketing/managed-campaigns/:id/request-changes` | Cambios del cliente con motivo obligatorio. |

Rutas internas actuales bajo `/api/admin/managed-campaigns`:

- dashboard/listado/detalle/creación/edición;
- transición de lifecycle y `activate-management`;
- top-ups manuales con comisión fija/porcentual y snapshots de gasto;
- inventario de campañas, propuestas fuzzy, confirmación y archivado/tombstone campaña -> clínica;
- cola interna por empleado con responsable, siguiente acción, bloqueo operativo y auditoría append-only;
- briefing/propuesta, plan de publicación dry-run determinista y adaptador Google Ads dry-run versionado para Search/PMax, sanitizados, idempotentes y auditables;
- `POST /:id/goal-policy/preview` y `POST /:id/goal-policy/apply` para el executor gestionado de objetivos Google, con aprobación admin, digest, lease, `validateOnly`, control de drift y readback;
- movimientos bancarios manuales, propuestas y confirmación de conciliación parcial.

El executor de goal policy es una excepción estrecha al carácter dry-run de la publicación. Al entrar una `ManagedCampaign` Google Search/PMax aprobada en `launching/active`, puede provisionar idempotentemente una `CampaignOptimizationPolicy` de Qualified Lead y aplicar el custom goal inmutable de una sola cuenta/cohorte. En `guided_improvement`, activar la estrategia provisiona una policy separada por `strategy_id` —protegida también por el índice único `uniq_campaign_optimization_policy_strategy`, cuya migración aborta si el preflight detecta duplicados—, verifica que toda la cohorte proceda del inventario y sea Search/PMax, y delega el preview/apply/readback a un `JobRequest` duradero y deduplicado. El alta de la policy y su `JobRequest` comparten la transacción de activación: el servicio de enqueue único acepta una transacción llamadora y no publica un job que pueda observar un aggregate posteriormente revertido. Cada cuenta se aplica y persiste por separado para respetar el radio de impacto unitario de Google y conservar qué cuentas quedaron `applied` o `failed` ante un fallo parcial. Editar una estrategia con policy no puede cambiar silenciosamente su cohorte Google; pausar o completar sincroniza la policy y detiene nuevas evaluaciones, salvo que exista un lease de ejecución vivo. Las acciones canónicas siguen globalmente secundarias y no se modifican las acciones del cliente. `connect_only`, `operation_mode=observe` y Smart nunca llegan a este executor.

##### Ejecución gestionada Google Search: desplegada y cerrada por flags (2026-07-19)

El runtime incorpora un carril real de proveedor para Piloto, desplegado y
acreditado estructuralmente en staging, pero **no está habilitado**. Los flags
`MANAGED_CAMPAIGN_PROVIDER_EXECUTION_ENABLED` y
`MANAGED_CAMPAIGN_PROVIDER_ACTIVATION_ENABLED` se interpretan de forma
estricta: solo el texto `true` abre cada capacidad y ambos permanecen apagados
por defecto. No se ha realizado una llamada Google real con este carril. La
migración aditiva
`20260719103000-create-managed-campaign-provider-executions.js` pasó `up`,
segundo `up` idempotente, contrato de columnas/FKs/índices y `down` en una
instancia MySQL aislada y está aplicada en staging.
La migración histórica `20260715152000` continúa cancelada: su `up` y su
`down` son no-op y este rollout no la reactiva.

El registry de ejecución contiene una sola clave:
`google_ads:google_search:create_new`, adaptador
`managed-google-search-execution-adapter/v3`. Es una allowlist, no un fallback:
Google PMax, Meta, `update_existing` y cualquier combinación desconocida
fallan antes de llamar al proveedor. El adaptador dry-run continúa calculando
planes para Search/PMax y specs Meta, pero esa simulación no concede por sí
misma capacidad de ejecución. Para la ruta registrada se crea una campaña
Search nueva, presupuesto no compartido, grupo de anuncios, RSA, keywords de
frase, ubicaciones, idiomas y horario explícito; toda la jerarquía nace en
`PAUSED`, con `MAXIMIZE_CONVERSIONS`, sin red de Display, partners ni Search
Network. Nombre y recursos incluyen una marca durable derivada de
`execution_id + plan_hash` para distinguir exclusivamente lo creado por
ClinicaClick.

Las rutas administrativas, todas bajo
`/api/admin/managed-campaigns/:id`, son:

| Método | Ruta relativa | Contrato |
|---|---|---|
| `GET` | `/publishing-plan` | Recalcula el plan y anuncia elegibilidad, pero nunca permite ejecutar hasta persistir el dry-run; no llama al proveedor. |
| `POST` | `/publishing-dry-run` | Persiste el plan revisado con `expected_plan_hash`, confirmación e idempotencia; conserva `provider_call_performed=false`. |
| `GET` | `/publishing-executions` | Devuelve flags, contrato de activación e historial saneado con `Cache-Control: no-store`. |
| `POST` | `/publishing-executions` | Reserva fondos y encola creación; la respuesta `202` solo acredita `JobRequest`, no una mutación Google. |
| `POST` | `/publishing-executions/:executionId/activate` | Encola por separado `PAUSED -> ENABLED`; usa `Idempotency-Key` de cabecera y no llama a Google desde el request HTTP. |
| `POST` | `/publishing-executions/:executionId/rollback` | Con `confirm_rollback=true` encola retirada de recursos propios y readback de ausencia. |

El enqueue de creación bloquea en una sola transacción campaña, funding,
top-ups, dry-run y ejecuciones. Exige `autopilot + managed`, estado
`approved_to_launch`, cuenta Google Ads todavía asignada/autorizada para el
scope, dry-run `ready` sin llamada de proveedor, versión/hash/manifest
vigentes, prepago con `payment_verified=true`, saldo y moneda exactos, ninguna
otra ejecución activa y cinco confirmaciones explícitas:
`confirm_external_mutation`, `confirm_budget_commitment`,
`confirm_policy_compliance`, `confirm_tracking_configuration` y
`confirm_creative_rights`. También exige operador, `idempotency_key` y
`change_reference`. La reserva crea un asiento `media_reserve`; la ejecución,
el `JobRequest` y el paso local a `launching` se confirman o revierten juntos.
El índice único `managed_campaign_id + idempotency_key` es la última barrera
frente a dos requests concurrentes.

Creación, activación y rollback son jobs distintos del orquestador común:

- `managed_campaign.google_search_create.v1`, prioridad `high`, hasta cinco
  reclamaciones;
- `managed_campaign.google_search_activate.v1`, prioridad `critical`, hasta
  cinco reclamaciones;
- `managed_campaign.google_search_rollback.v1`, prioridad `critical`, hasta
  tres reclamaciones.

No existen cron, Bull worker ni bucle lateral para estas mutaciones. Los tres
handlers comparten `JobRequest` y el carril serializado de proveedores. Cada
fase reclama un lease de 30 minutos con `lease_owner`, `lease_version` y
`lease_expires_at`; antes de cada posible mutación renueva el lease y vuelve a
comprobar versión de campaña, lifecycle, `managed_execution_id`, refs propias,
reserva/moneda, aprobación y asignación vigente de la cuenta. Las llamadas
Google son `singleAttempt`, tienen timeout de dos minutos y nunca reciben como
autoridad un plan del navegador: el snapshot procede del dry-run persistido y
se contrasta con estado bloqueado del servidor.

La creación ejecuta primero `validateOnly`, después un `googleAds:mutate`
atómico con `partialFailure=false` y finalmente un readback exacto de toda la
jerarquía `PAUSED`, incluido presupuesto, URL, creatividades, keywords,
ubicaciones, idiomas, horarios y propiedad. Una respuesta ambigua no dispara
otra creación a ciegas: se busca la marca durable y solo se recupera como
`succeeded` si el árbol completo coincide. Un árbol parcial, lease expirado con
resultado incierto, revocación posterior a una posible llamada o cambio del
fence termina `manual_recovery_required` y conserva reserva/referencias.

La activación solo parte de una ejecución `succeeded`, todavía `PAUSED`, y
requiere una idempotencia nueva, `change_reference`, hash exacto y las seis
confirmaciones `confirm_activation`, `confirm_budget_commitment`,
`confirm_targeting_configuration`, `confirm_schedule_configuration`,
`confirm_policy_compliance` y `confirm_recent_approval`. La aprobación caduca a
las 24 horas. Se releen primero moneda y zona horaria de la cuenta; el job
provisiona/aplica la policy canónica de `qualified_lead` y exige su readback
saludable antes de tocar estados. Solo entonces cambia campaña, grupo y anuncio
de `PAUSED` a `ENABLED` en una mutación atómica y exige un segundo readback
exacto. Un fallo de goal policy o un rechazo definitivo deja Google `PAUSED` y
permite rollback; un `ENABLED` verificado que no pueda finalizarse localmente
queda en recuperación manual, nunca se presenta como fallo sin mutación.

El rollback automático solo acepta `succeeded`, `active` o
`activation_failed`, otra clave idempotente y evidencia de propiedad completa.
Congela una autorización con campaña/versión/estado, plan, funding, reserva,
actor y refs; antes de retirar vuelve a comprobarla. El adaptador elimina en
orden los recursos identificados por esa ejecución y confirma por readback que
ya no existe la campaña marcada. Solo una ausencia verificada libera la reserva
y deja la campaña interna `blocked` para preparar un plan nuevo. Si la
propiedad, la autorización o el resultado no son demostrables, no toca recursos
ajenos ni libera fondos: termina `manual_recovery_required`.

Estados persistidos en `ManagedCampaignProviderExecutions`:

| Estado | Significado operativo |
|---|---|
| `queued` / `executing` | Creación pendiente o con lease. Todavía no demuestra recursos Google. |
| `succeeded` | Jerarquía propia creada y releída exactamente en `PAUSED`; no sirve anuncios. |
| `activation_queued` / `activating` | Activación separada pendiente o con lease; sigue sin considerarse activa. |
| `active` | Goal `qualified_lead` y jerarquía `ENABLED` verificados por readback. |
| `activation_failed` | Rechazo definitivo sin activación ambigua; recursos propios permanecen retirables. |
| `failed` / `cancelled` | Creación definitivamente rechazada o cancelada antes de mutar; la reserva se libera solo si el fence lo demuestra. |
| `manual_recovery_required` | Resultado externo, propiedad o finalización local inciertos; prohíbe reintento/liberación automáticos. |
| `rollback_queued` / `rolling_back` | Retirada de recursos propios pendiente o con lease. |
| `rolled_back` | Ausencia de recursos verificada y reserva liberada. |

Apagar los flags no simula éxito. Con ejecución apagada, altas y rollbacks
devuelven `503`; si se apaga tras encolar una creación, esta se cancela antes de
la llamada cuando puede demostrarlo, y un lease expirado incierto exige
recuperación manual. Con activación apagada, el handler ya encolado permanece en
`waiting` sin proveedor. Las transiciones genéricas de lifecycle tampoco pueden
imitar `launching/active` para una Google Search gestionada: tanto backend como
frontend obligan a usar create/activate. Esto es la política no-op/fail-closed
de proveedores no admitidos y de flags cerrados.

La UI vive en `Marketing > Operación de campañas`. Solo monta el panel para
Google Search `autopilot/managed`, compara el contrato completo anunciado por
backend y falla cerrado ante una clave, flag, safety manifest o confirmación
distinta. Requiere un dry-run persistido que coincida, referencia de cambio y
checkboxes explícitos; muestra flags, reserva, refs, policy y estados saneados.
Mientras hay estados transitorios hace polling cada cinco segundos, máximo 24
veces, y desactiva las transiciones legacy concurrentes. El botón de rollback
solo aparece en estados admitidos y con marca/ref de propiedad; la UI no es la
autoridad final, porque todos los gates se revalidan de nuevo en transacción y
justo antes de cada mutación.

Runbook de promoción segura: desplegar primero código y migración con ambos
flags apagados; comprobar listado/capability, esquema, jobs y ausencia de
llamadas Google; mantener Meta/PMax/update como no soportados. Un piloto real
requiere después autorización operativa expresa, campaña controlada, prepago
verificado, dry-run nuevo y flags abiertos por fases: primero solo ejecución
para acreditar `PAUSED` + readback, después activación para acreditar policy QL
+ `ENABLED` + readback. Ante cualquier ambigüedad se detiene el rollout y se
reconcilia manualmente; no se repite, no se libera reserva y no se usa el cambio
de estado genérico. Para retirar el piloto se usa exclusivamente el rollback de
la misma ejecución y se exige readback de ausencia antes de cerrar.

Las transiciones automáticas de Mejora `qualified_lead → schedule → purchase` consumen exclusivamente una evaluación diaria append-only que esté `ready`, sin blockers y con digest válido. La evaluación conserva una decisión de lifecycle verificable; después de su CAS local, el job se deduplica por `evaluation_id`, adquiere un lease de la policy y reutiliza como aprobación cliente la autorización inicial persistida. El job diario ejecuta además un reconciliador: escanea la última evaluación de cada policy Mejora activa y vuelve a encolar cualquier `ready` no aplicado, cerrando una caída del proceso entre commit de evaluación y creación del `JobRequest`. La etapa local solo avanza después de `validateOnly`, apply y readback saludable de todas las cuentas. Si falta la acción canónica de la etapa, la evaluación fue sustituida, cambió el scope, falla el digest o Google no confirma el readback, no hay transición; la policy conserva la etapa anterior y sigue activa para medición.

Schedule construye 12 semanas completas con la fecha efectiva `CitasPacientes.inicio`, obteniendo el `id_cita` del `event_id`; si una carga no se puede resolver, añade `SCHEDULE_EFFECTIVE_DATE_COVERAGE_INCOMPLETE` y no promociona. Purchase lee la procedencia no sensible guardada en `GoogleAdsConversionUploadAttempts.request_metadata`: importes de factura/pago/ingreso/margen/tratamiento aceptado cuentan como reales; `Tratamientos.precio_base` queda marcado explícitamente como fallback. Una procedencia desconocida añade `PURCHASE_VALUE_PROVENANCE_INCOMPLETE`. Así la automatización usa hechos del negocio y no `attempted_at`, un precio de catálogo ni una aceptación inventada.

La asociación asistida no acepta IDs de cuenta escritos a ciegas como autoridad. `GET /matching/options` construye, solo desde base de datos, un catálogo de grupos con clínicas activas y cuentas Google/Meta mapeadas. La respuesta usa una lista blanca (`group_id`, nombre, número de clínicas elegibles y, por cuenta, proveedor, ID externo de presentación, nombre, origen, estado de autorización y `selectable`); nunca serializa conexiones, tokens, correos, `login_customer_id`, `additionalData` ni errores internos de OAuth. Una autorización `reauthorization_required` puede mostrarse, pero no permite consultar ni confirmar inventario.

`GET /matching/proposals`, `POST /matching/confirm`, `POST /matching/archive` y ambos endpoints `/inventory` vuelven a comprobar en servidor `group_id + provider + customer_id` contra ese scope activo; el selector frontend no constituye autorización. Archivar exige `group_id`. Confirmar reconsulta y bloquea dentro de la misma transacción clínicas, mapeos y autorizaciones, y guarda mediante `create` o actualización de una fila ya validada, nunca mediante un `upsert` que pudiera moverla por carrera. La pertenencia histórica usa todas las clínicas que siguen dentro del grupo; la selección de destino usa solo activas y no-test. Así una decisión legacy de una clínica desactivada puede reasignarse o archivarse, pero esa clínica no reaparece como destino. Si una decisión previa pertenece a otro grupo devuelve `matching_assignment_scope_conflict` sin escribir. El archivo revalida y bloquea en su propia transacción clínicas, autorización y decisión externa global antes del tombstone. El `POST /inventory` revalida una sola vez bajo los mismos locks y agrupa todos los upserts en esa transacción: una revocación aborta el lote antes de su primera escritura. El catálogo y estos guards no llaman a Google/Meta ni refrescan credenciales.

La identidad externa canónica es `provider + account_id + customer_id + campaign_id` (los dos campos de cuenta se normalizan al mismo ID autorizado y `external_campaign_id` es el alias de presentación de `campaign_id`). Métricas, deduplicación, conflictos de estrategia y análisis usan esa identidad completa: el mismo `campaign_id` en dos cuentas no colisiona ni mezcla gasto. El análisis exige también `account_id` o `customer_id`; no resuelve una campaña solo por proveedor e ID.

La revisión de target se opera sin inferencias por nombre:

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/matching/issues` | Asociaciones activas, issue honesto y catálogo allowlisted de estrategias/targets válidos para la misma clínica. |
| PATCH | `/matching/assignments/:id/target` | Asigna o cambia target con `expected_version`, estrategia y request, confianza y explicación. |
| DELETE | `/matching/assignments/:id/target` | Limpia el target con CAS y motivo obligatorio. |
| GET | `/matching/assignments/:id/audits` | Historial append-only de clínica, reactivación, archivo y cambios de target. |

Un target válido apunta a un `CampaignRequest` de la misma clínica cuya estrategia está `active`, tiene `objective_id=new_patients` y `mode_snapshot=connect_only|guided_improvement`; la campaña asociada debe estar activa y no gestionada. `generic` solo es válido para una estrategia genérica. Un target `treatment` debe figurar en los tratamientos de esa estrategia y seguir activo, visible y dentro del scope de la clínica. PATCH/DELETE bloquean grupo, autorización, asociación, requests y catálogo dentro de la transacción, aplican CAS por `version` y sincronizan `CampaignRequest.solicitud.external_targets` sin borrar targets que queden con `campaigns: []`. La identidad canónica evita duplicarla en dos targets. Una asociación con target no se puede mover de clínica hasta limpiarlo explícitamente.

`ExternalCampaignAssignmentAudits` no admite update/destroy. Registra `clinic_assigned`, `reactivated`, `archived`, `target_assigned`, `target_changed` y `target_cleared`, con actor, versiones y cambios. La migración crea además un punto inicial `clinic_assigned_backfill`/`archived_backfill` para cada decisión preexistente; si no existe usuario histórico, declara actor `system` en vez de inventarlo. El backfill no asigna targets. Reactivar limpia el tombstone de la fila actual, pero conserva los eventos históricos.

El tombstone automático continúa limitado deliberadamente a Google Ads. Su sync real consulta asociaciones activas y archivadas antes de fuzzy/default. El sync Meta todavía no consume `ExternalCampaignAssignment`; por eso `POST /matching/archive` devuelve `archive_provider_not_supported` para Meta y no promete una protección que no existe.

La coordinación interna usa exclusivamente estas rutas:

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/operators` | Operadores de la allowlist que existen y continúan con `estado_cuenta=activo`; DTO limitado a ID, nombre visible, email y avatar. |
| PATCH | `/:id/coordination` | Patch por presencia de `assigned_to_user_id`, `next_action` y/o `operational_blocker`, con `expected_version` entero obligatorio. `null` desasigna/limpia; texto en blanco se normaliza a `null`. |
| GET | `/:id/coordination-audits` | Historial descendente append-only, 30 filas por defecto y máximo 100. |

El PATCH bloquea `completed/cancelled`, pero permite coordinar una campaña `active`, `launching`, `paused` o `blocked` sin reabrir ni alterar su lifecycle. Actor y nuevo responsable se vuelven a validar como operadores allowlisted activos dentro de la transacción. La campaña se bloquea, se compara la versión vista por el navegador y se actualiza con `WHERE id + version`; un conflicto devuelve `operation_version_conflict`. Un patch normalizado sin diferencias devuelve `changed=false`, conserva versión/`updated_at` y no crea audit, pero una versión obsoleta falla incluso si el valor enviado coincide.

Cada cambio real incrementa una sola versión y crea en la misma transacción una fila `coordination_updated` con actor, versión anterior/nueva y únicamente `{before, after}` de los campos modificados. Si falla el audit, también se revierte la campaña. El modelo de auditoría rechaza update/destroy y la API no expone rutas para mutarlo. `POST /` y el `PATCH /:id` genérico rechazan campos de coordinación para que no exista una vía sin CAS, validación de responsable y auditoría. `review_config.client_next_action` sigue siendo exclusivamente la acción visible para el cliente; `next_action` y `operational_blocker` son internos y no aparecen en el DTO cliente.

Tablas reales: `ManagedCampaigns`, `ManagedCampaignFundingAccounts`, `ManagedCampaignLedgerEntries`, `ManagedCampaignSpendSnapshots`, `ManagedCampaignBankTransactions`, `ManagedCampaignReconciliationMatches`, `ManagedCampaignPublishingAudits`, `ManagedCampaignProviderExecutions`, `ManagedCampaignOperationAudits`, `CampaignOptimizationPolicies`, `CampaignOptimizationEvaluations`, `ExternalCampaignInventories`, `ExternalCampaignAssignments` y `ExternalCampaignAssignmentAudits`. `ManagedCampaignProviderExecutions` pertenece al runtime desplegado y existe en staging tras aplicar `20260719103000`; sus flags permanecen apagados.

Límites que no deben ocultarse:

- `active/launching/paused` siguen siendo estados internos. Search/PMax dispone de adaptador **dry-run**; solo Search `create_new` dispone además del adaptador real desplegado y gated, y siempre entra por su carril create `PAUSED` -> activate `ENABLED`. Meta, PMax y actualización de campañas existentes permanecen sin adaptador real y fallan cerrado;
- el importe preparado para Google sale exclusivamente del menor entre neto de medios, saldo neto disponible y asignación neta del presupuesto aprobado; el bruto y la comisión nunca alimentan `amount_micros`. Se valida `bruto cobrado - comisión = neto`, `disponible <= neto`, prepago completo y moneda, y la conversión mensual usa `floor` en micros para no superar el saldo;
- el dry-run no es ejecución. El carril real reconstruye autoridad desde campaña, funding y audit persistidos bajo lock, verifica hash/versión/registry y no acepta el plan del navegador como fuente. Con flags apagados no existe mutación ni éxito simulado; el selector genérico tampoco permite crear/publicar/activar/pausar, cambiar presupuesto o creatividades fuera del contrato Search nuevo descrito arriba;
- el dry-run persistido exige `expected_plan_hash`; cambios concurrentes en spec, saldo o gates devuelven `publishing_plan_changed` y no crean una auditoría distinta de la mostrada;
- propuesta cliente, edición admin, transición y activación usan revisión/versión compare-and-swap; URLs de destino deben ser HTTP(S) públicas sin credenciales y la preview exige HTTPS;
- `recordTopup` exige `payment_verified=true`, bloquea la cuenta de fondos dentro de la transacción y deduplica por `funding_account_id + entry_type + external_ref`; `activate-management` requiere saldo + al menos un asiento de cobro verificado. Esto demuestra una comprobación manual, no un `ReconciliationMatch` bancario;
- `recordSpend` bloquea la cuenta de fondos y actualiza snapshot, saldo y asiento en una sola transacción; un reintento concurrente con el mismo total no duplica gasto;
- la conciliación actual vincula movimiento bancario con funding/cobro cliente, no snapshot de gasto con cargo real de proveedor; `bank_difference` sigue `null`, `provisional_margin` contiene la comisión y `realised_margin` permanece `null`;
- no hay payment provider, fiscalidad, refund/chargeback, importación bancaria, disputa ni cierre de periodo;
- frontend y backend consultan la misma allowlist `ADMIN_USER_IDS` + `CAMPAIGN_OPERATOR_USER_IDS`; salvo el probe fail-closed `/access`, todo el router administrativo exige además una cuenta de usuario activa. Siguen faltando capacidades granulares separadas;
- esa allowlist continúa siendo una capacidad global de backoffice. El scope grupo/cuenta evita cruces y corrupción entre clientes, pero no convierte a un operador allowlisted en usuario tenant-scoped;
- la estrategia legacy no puede pasar directamente a `active` si es `managed_service`: debe operarse desde este lifecycle interno.

Snapshot Propdental en DB dev:

- dos cuentas: `1851215478` (25 campañas, 19 asignadas, 6 sin asignar) y `5992356722` (51 campañas, 25 asignadas, 26 sin asignar);
- total revisado: 76 campañas, 44 asignaciones activas a ocho sedes y 32 sin asignar;
- distribución combinada: Francia 10, Badalona 7, Hospitalet 7, Eixample 4, Sant Marti 4, Nou Barris 4, Sants 4 y Glories 4;
- el matcher excluye clínicas cuyo nombre contiene `test` y no modifica el proveedor;
- las decisiones revisadas rehacen también la atribución histórica (`clinicMatchSource=reviewed_campaign`);
- el unique de `GoogleAdsInsightsDaily` incluye campaña/fecha/cuenta/ad group/network/device normalizados para evitar multiplicar totales de campaña.
- existe una spec piloto controlada en `draft + observe + unfunded`, con financiación/gasto/saldo a cero; conserva sus referencias/destinos y un benchmark histórico congelado. Las cifras comerciales permanecen en la base y en las vistas autorizadas, no en la documentación versionada; no hay piloto activo ni movimientos financieros reales.
- archivar una asignación Google registra motivo/actor/fecha y hace que el sync persista métricas futuras sin clínica (`reviewed_campaign_archived`) hasta una reactivación manual, incluso en cuentas con default manual; no borra historia ni toca Ads. El endpoint rechaza Meta hasta que su sync consuma estas decisiones, para no prometer un tombstone falso.

Tracking Propdental: el `IntakeConfig` de grupo conserva el destino legacy `185...` y añade dos `destinations` explícitos por evento para `185...` y `599...`. `lead`, `contact`, `qualified_lead` y `schedule` están habilitados; QL usa `7682299115` en `185...`, `7682721076` en `599...` y el peso `10 EUR`. Schedule usa `40 EUR`; ambos valores son pesos de reporting/optimización, no ingresos. `purchase` permanece apagado hasta disponer de un evento y valor fiable. `send_to=null` es coherente con acciones offline `UPLOAD_CLICKS` y no implica inyección de tag web. Aunque la medición Enhanced ya está activa, la spec gestionada continúa en `draft + observe`: no existe aún un piloto activo ni una policy aplicada a Propdental.

Instalación web segura: leer el secreto, guardar configuración y verificar el snippet exige permiso sobre todas las clínicas del scope. El verificador solo acepta dominios autorizados, resuelve todas sus IP, rechaza rangos privados/loopback/link-local/reservados, fija el DNS en el agente HTTP para impedir rebinding y revalida cada redirección. La inspección del runtime solo admite `clinicaclick.com` o subdominios, con el mismo control; nunca sigue automáticamente una redirección ni permite `localhost`.

`GET /api/intake/config` restringe siempre `available_locations` a los IDs presentes en `config.locations`, aunque el caller omita `domain`; una configuración de clínica vacía cae únicamente en su propia clínica y un scope de grupo sin lista explícita devuelve cero sedes. El editor usa `GET /api/intake/config/admin`, protegido y autorizado por scope, para recibir candidatas sin convertir una lista vacía en selección: rechaza mezclar `clinic_id` y `group_id`; en una configuración propia de clínica solo devuelve sedes a las que el usuario tiene acceso y en una edición completa de grupo exige acceso a todas. La excepción deliberada es una clínica ya incluida en `group.config.locations`: las lecturas web efectivas (`admin`, `secret` y verificación) devuelven la fila compartida porque ese mismo HMAC y esa lista cerrada gobiernan el runtime instalado para todas esas URLs; el usuario no puede sustituir la lista ni la configuración completa desde scope clínica y solo dispone de `domain_add` por unión y `snippet_verification` firmada. `locations` sigue representando exclusivamente la selección persistida. El `PUT` completo valida la lista final ya fusionada —tanto si llegó en root como en `config.locations`— contra las clínicas candidatas y administrables del scope; un ID ajeno devuelve `location_scope_forbidden` antes del `upsert`. El CORS externo se limita a las rutas públicas exactas y no incluye `/config/admin` ni endpoints `/secret`. Esto evita que la omisión de un query param, una lista vacía o un scope ambiguo convierta en destino una clínica interna, histórica o de prueba, y deja explícito el límite de ownership de un activo web compartido.

En los chats de scope grupo, la sede elegida viaja en `chat_state.data.location` y se valida antes de aplicar cualquier clínica fallback: debe existir, estar activa, pertenecer al grupo efectivo y formar parte de `config.locations`. Los runtimes nuevos replican también el ID como `clinic_id`, pero el backend conserva compatibilidad segura con `intake.js` 3.2.1. Una sede enviada pero inválida se rechaza; solo se usa el fallback histórico cuando el flujo no envía ninguna sede. `locations[].public_label` permite mostrar un nombre contextual sin cambiar el ID ni el routing clínico.

La acción `send_quickchat_summary` se reconoce exclusivamente por `source_detail=chatbot_quickchat`. Tanto si crea lead como si reutiliza un `LeadIntake` deduplicado, conserva audit actual + outbox y solo el handler crea o revincula su conversación canónica y guarda un único `Message` interno de tipo `event`, idempotente y oculto al paciente. Este camino retorna antes de FormSubmission, Meta CAPI y Google Ads y no contiene ninguna salida WhatsApp. Si el fast path queda esperando responde `202 queued`; los reintentos actualizan/consolidan el mismo resumen en lugar de duplicar mensajes.

`save_lead` encola también el resumen interno cuando recibe el estado final del chatbot, incluso si deduplica contra un lead anterior. En ese dedupe específico responde con el outcome del outbox (`200 saved`, `202 queued/unknown_durable` o `500` terminal) **antes** de Meta CAPI/Data Manager para no contar dos veces la misma conversión; cualquier otro dedupe conserva el `409` general. La acción pública posterior `send_quickchat_summary` pasa por el mismo mecanismo durable como reintento idempotente, no como una materialización alternativa. Esta separación evita el fallo observado en `LeadIntake #7184`: el navegador agotó el margen de navegación, Nginx registró `499`, el lead sobrevivió porque ya estaba creado y la segunda solicitud nunca llegó a ejecutarse. En un lead nuevo, la respuesta de `save_lead` permanece después del tracking best-effort; lo que deja de depender de esa respuesta es la aparición del lead en QuickChat.

### 3. Reglas de negocio activas hoy

- **Una estrategia en curso por objetivo y scope.** Backend bloquea crear otra estrategia activa/en curso para el mismo objetivo.
- **`connect_only` requiere campañas externas vinculadas.** No es válido como estrategia "vacía".
- **Una campaña externa no se reutiliza entre estrategias en curso.**
- **`connect_only` nace activa.** No sigue workflow de aprobación.
- **`managed_service` usa dos capas.** La estrategia legacy conserva su estado de negocio; la operación real usa el lifecycle más rico de `ManagedCampaign` y bloquea activar la estrategia fuera del panel interno.

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

**Contrato de métricas v2:**
- `crm_metrics.leads`, `qualified_leads`, `appointments` y `crm_conversions` proceden de `LeadIntake`, no de la cifra de conversiones de la plataforma publicitaria; `qualified_leads` incluye los estados desde `cualificado` en adelante, `appointments` los estados `citado | acudio_cita | convertido`, y `cost_per_lead` divide el gasto del proveedor entre esos leads CRM;
- `crm_metrics.unassigned_clinic_leads` cuenta, para el proveedor solicitado y el mismo periodo, los leads de la clínica cuya campaña real no forma parte de la estrategia;
- `provider_metrics.spend` y `provider_metrics.conversions` conservan por separado las métricas agregadas que devuelve Google Ads o Meta;
- `unassigned_campaigns` expone únicamente proveedor, cuenta, campaña y número de leads, sin PII, para que la UI pueda pedir que se complete el mapeo;
- el periodo CRM usa días naturales de `Europe/Madrid`: por ejemplo, el 13 de julio comprende `[12/07 22:00 UTC, 13/07 22:00 UTC)`;
- `rows[].leads` se conserva temporalmente como alias compatible de conversiones del proveedor; cada fila devuelve también `provider_conversions` y `metric_contract.rows_leads_semantics=provider_conversions_legacy`. Ningún consumidor nuevo debe etiquetar ese alias como leads CRM.

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

La atribución CRM usa `LeadIntake` y solo se acepta cuando el match con la campaña externa es no ambiguo. La identidad rica `google_ads_customer_id + google_ads_campaign_id` tiene prioridad y se compara con la identidad canónica `provider + account + campaign`; si apunta a una campaña ajena a la estrategia no se permite que un UTM antiguo la reasigne por nombre. Para registros legacy sin identidad completa se mantiene el fallback no ambiguo por ID/nombre en `utm_campaign` o `source_detail`. Los leads pagados resolubles que no encajan en ninguna campaña vinculada se devuelven como `unassigned_clinic_leads`, en lugar de desaparecer silenciosamente.

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

- una plantilla inactiva de catálogo no debe propagarse a clínicas ni abrir revisión en Meta; backend devuelve `catalog_template_inactive`;
- primero se activa y guarda la plantilla, después se pulsa `Propagar`;
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

### 7.3. Relación con flujos V2 que usan plantillas WhatsApp

La aprobación de una plantilla WhatsApp y la publicación de un flujo V2 son procesos independientes:

- aprobar una plantilla en Meta actualiza `WhatsappTemplates.status`;
- propagar una plantilla puede crear una nueva revisión técnica de la plantilla dentro de la misma familia lógica (`catalog_template_id`);
- ninguna de esas dos acciones debe incrementar `AutomationFlowTemplatesV2.version`;
- una nueva versión del flujo solo aparece al guardar/publicar el flujo desde el editor V2;
- al propagar una automatización de catálogo, las copias de clínica sí pueden subir de versión local aunque el flujo fuente siga en la misma versión.

Caso normal:

- catálogo de automatización: `Recordatorio y confirmacion`, flujo fuente `v4`;
- plantillas WhatsApp usadas por sus nodos: aprobadas;
- propagación a Eixample: copia local `v5`;
- interpretación correcta: el catálogo sigue en `v4`, Eixample ejecuta su copia local `v5` y las plantillas se resuelven por `catalog_template_id`.

Para QA no usar solo el número de versión como prueba de aprobación. Hay que verificar:

1. flujo fuente publicado (`AutomationFlowTemplatesV2` sin `clinic_id`);
2. copia de clínica publicada y activa;
3. plantillas efectivas de la clínica en `WhatsappTemplates` con `status = APPROVED`;
4. si el nodo tiene `catalog_template_id`, resolver por ese campo antes que por `template_id`.

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

Antes de renderizar `title` y `message`, el nodo debe enriquecer el contexto con el mismo resolvedor de plantillas que usan los envíos WhatsApp. Esto garantiza que variables como `{{paciente.nombre}}`, `{{cita.fecha}}`, `{{clinica.nombre}}` o datos derivados de la cita existan aunque el `FlowExecutionV2.context` original solo incluya IDs.

Comportamiento de navegación:
- si existe conversación, la notificación guarda `quickChatConversationId`
- el front puede abrir QuickChat directamente desde la notificación
- si no hay conversación, el fallback navegable es la ficha del paciente

Tiempo real:
- cada `Notification.create(...)` que nace de `POST /api/common/notifications`, `notifications.service.dispatchEvent(...)`, `action/create_task`, `action/send_system_notification` o jobs internos debe emitir `notification:created` al room `user:{id_usuario}`
- el DTO público se centraliza en `src/lib/notification-dto.js` para que HTTP y socket no diverjan en `read`, `time`, `link`, `data` o `clinicaId`
- si una notificación aparece tras refrescar pero no en vivo, revisar primero `/socket.io` y `src/services/notificationsRealtime.service.js`, no la consulta HTTP

## Personal: carga de citas e impacto de horarios

El endpoint canónico de horario de personal enriquece los tramos expandidos:

- `GET /api/personal/:id/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/personal/me/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD`

Cada entrada de `clinicas[].horarios_expandidos[]` puede incluir:

- `appointments_count`: número de citas activas solapadas con ese tramo.
- `appointments_preview`: lista corta de citas con paciente, hora, estado, instalación y tratamiento.

Reglas:

- Se excluyen citas `cancelada`.
- El cálculo se hace en backend para evitar que el Gantt cargue y filtre todas las citas en frontend.
- El solape se evalúa contra fechas reales expandidas y zona horaria de la clínica.

Preview antes de modificar horarios:

- `POST /api/personal/:id/clinicas/:clinicaId/horarios/impact-preview`
- `POST /api/personal/me/clinicas/:clinicaId/horarios/impact-preview`

Payload mínimo:

```json
{
  "action": "update_shift",
  "horario_id": 123,
  "fecha": "2026-04-16",
  "original_start": "09:00",
  "original_end": "14:00",
  "next_start": "10:00",
  "next_end": "13:00"
}
```

Respuesta:

```json
{
  "has_affected_appointments": true,
  "affected_count": 2,
  "intervals": [{ "fecha": "2026-04-16", "start": "09:00", "end": "10:00", "reason": "shorten_start" }],
  "appointments": []
}
```

Uso esperado:

- borrar tramo: detectar citas solapadas con el tramo completo
- acortar inicio: detectar citas en el intervalo retirado
- acortar fin: detectar citas en el intervalo retirado
- bloqueo: detectar citas solapadas con el bloqueo

El movimiento batch de citas afectadas queda como contrato posterior sobre endpoints específicos del asistente de reprogramación. No debe resolverse con cálculo libre en frontend.

Reglas de solape forzable usadas por `/api/citas/:id/reagendar` y `/api/disponibilidad/check`:

- `INSTALLATION_OVERLAP` es forzable: permite agendar y solapar junto a otra cita existente en la misma instalación.
- `STAFF_OVERLAP` es forzable solo cuando el choque es del mismo profesional dentro de la misma clínica.
- Bloqueos, fuera de horario y choques del profesional en otra clínica no son forzables.
- En `GET /api/disponibilidad/slots` y `GET /api/disponibilidad/grid`, los intervalos visuales de `include_unavailable` priorizan `STAFF_OUT_OF_HOURS`: si el profesional no tiene horario efectivo en esa clínica, no se añade además `STAFF_OVERLAP` por una cita activa en otra clínica para ese mismo tramo. La validación puntual conserva el bloqueo duro al intentar guardar.

## Marketing: Envíos Masivos WhatsApp

Actualización 2026-05-06:

- `mass_sends` usa `MarketingPatientLists` y `MarketingPatientListItems` como audiencia congelada y tabla de materialización de estado.
- El envío real WhatsApp se ejecuta con `JobRequests.type = marketing_bulk_send_dispatch`.
- El job envía lotes de 100 contactos, programa el siguiente lote con `next_run_at = now + 2 minutos` y respeta la ventana 09:00-22:00 `Europe/Madrid` por defecto (`MARKETING_BULK_SEND_START_HOUR` permite ajustar la hora de inicio, con mínimo operativo 08:00).
- Antes de cada batch se recalculan contadores materializados y se pausa si `opt_out_rate > 3%`. La tasa de lectura queda como métrica de informe, no como bloqueo de calidad.
- `POST /api/marketing/bulk-sends/campaigns/:id/send` no encola si faltan gates: plantilla WABA aprobada, opt-out/consentimiento, audiencia congelada, auditoría, capping y cola cancelable.
- `cancel` marca `cancel_requested`; el job corta en el siguiente punto de control. `resume` vuelve a encolar solo si quedan items `ready` pendientes.
- Los informes/listados deben consultar agregados y paginación (`/recipients`, `/dispatch`). No cargar todos los items en frontend para calcular abiertos/no abiertos.
- `/recipients` busca por nombre, teléfono, email y `custom_fields` JSON, siempre paginado. No traer la lista completa al frontend para filtrar campos importados.
- La reconciliación defensiva de informes contra `Messages` solo se ejecuta durante la ventana activa configurada por `MARKETING_BULK_SEND_STATS_RECONCILE_WINDOW_MS` (30 días por defecto) o si la campaña sigue viva/pausada/programada. Pasada esa ventana, los informes usan contadores materializados para no reescanear campañas antiguas en cada lectura.
- Los mensajes salientes de pruebas y campañas emiten `message:created/message:updated` a QuickChat por socket con metadata `source=marketing_bulk_sends`. QuickChat debe reflejar el envío en vivo sin recargar todo el histórico.
- Los contactos externos de campañas no se convierten en lead ni paciente para aparecer en QuickChat. La conversación se hidrata desde `MarketingPatientListItems` y queda en el filtro `Otros` mientras no haya `patient_id`.
- Las campañas pueden prepararse contra toda la lista o contra `active_segment_id`; el contador operativo de `counters.ready` representa receptores seleccionados para el envío, mientras `counters.ready_total` conserva los contactos `ready` totales de la lista.
- `PATCH /api/marketing/bulk-sends/campaigns/:id` con `whatsapp_template_id` valida que la plantilla sea WABA del scope y guarda `template_snapshot` también en borrador. No usar `MessageTemplates` legacy para campañas nuevas.
- Los webhooks WhatsApp materializan `sent/delivered/read/failed/replied` en `MarketingPatientListItems` usando `app_message_id`, `provider_message_id` y metadata `source = marketing_bulk_sends`.
- Como red de seguridad, las lecturas de detalle (`GET /campaigns/:id`, `/recipients`, `/dispatch`) vuelven a reconciliar de forma idempotente contra `Messages`. Esto no sustituye a actualizar gateway cuando se promociona: solo evita que un informe quede desfasado si un webhook llegó antes de desplegar el materializador.
- Los inbound con `BAJA` solo aplican opt-out si el outbound previo tiene metadata comercial; no se debe excluir a pacientes por responder `baja` a recordatorios operativos.
- Cuando una baja comercial se aplica, se persiste un `Messages.message_type=event` interno con `metadata.reason=marketing_opt_out`. Es aviso operativo para QuickChat; no se envía al paciente.
- El job de envío lo ejecuta el API del namespace (`dev`, `staging`, `prod`). Gateway no ejecuta jobs de negocio, pero al promocionar hay que llevarle `src/workers/queue.workers.js` porque recibe webhooks externos y materializa estados/respuestas.
- Si se prepara una campaña con plantilla WhatsApp no aprobada y `auto_send_when_template_approved = true`, queda en `dispatch.status = waiting_template_approval`. La sincronización WABA la reencola automáticamente cuando esa plantilla pase a `APPROVED`.
- La sincronización WABA respeta `WhatsappTemplateCatalog.is_active=false` y no debe reactivar plantillas retiradas. Las plantillas activas del catálogo pueden volver a quedar operativas tras sincronizarse desde Meta si el flujo vigente las necesita.
- Campañas Admin expone `GET/PUT /api/admin/campaign-playbooks/bulk-send-settings` para configurar ajustes de envíos masivos WhatsApp: batch size, delay y baja máxima. `prepare` guarda snapshot en `criteria.dispatch`; el delay mínimo efectivo es 2 minutos por lote. Email y otros canales deberán tener ajustes propios cuando se conecten.
- Una campaña pausada con `dispatch.status=paused_quality` solo puede reanudarse con usuario admin global cuando el motivo es calidad real bloqueante (`opt_out_rate_high` o futuros motivos equivalentes). Las pausas legacy por `read_rate_low` son reanudables porque la lectura ya no bloquea envíos.
- El seguimiento de enlaces usa `MarketingTrackedLinks`, `MarketingTrackedLinkClicks` y `GET /r/:token`. `token` debe ser opaco/no semántico; no derivarlo de URL, lista, campaña, paciente ni variable. En staging/prod, gateway/DNS debe enrutar `envios.clinicaclick.com/r/:token` o el subdominio elegido al backend correcto.
- El error de pago WhatsApp `131042` se guarda en `ClinicMetaAsset.additionalData.payment` cuando llega por webhook `failed`. Un webhook posterior `sent`/`delivered`/`read` del mismo phone/WABA limpia la marca con `whatsappPaymentStatus.service.js`; no mostrar bloqueos de pago anteriores a `payment.last_success_at`.
- El error Meta `100/33` en envios WhatsApp se trata como perdida de acceso al activo. `whatsappConnectionStatus.service.js` actualiza el asset y crea una alerta cerrable para admin/propietario/recepcion. La alerta indica el procedimiento operativo: abrir WhatsApp Business en el movil vinculado, comprobar el numero compartido, escribir un mensaje desde ese movil y recibir respuesta antes de validar de nuevo la API. Embedded Signup en modo coexistencia y cualquier envio/status posterior correcto limpian el marcador tecnico, marcan leidas las notificaciones de desconexion de ese phone/WABA y emiten `whatsapp.coexistence_reconnected` para dejar constancia positiva de que ClinicaClick vuelve a tener acceso.
- En reconexiones de coexistencia, `POST /api/whatsapp/embedded-signup/callback` debe buscar el telefono por `assetType=whatsapp_phone_number + phoneNumberId`, no por `metaConnectionId`, porque Meta puede devolver el mismo numero bajo una conexion nueva. El callback actualiza ese activo, desactiva duplicados activos del mismo `phoneNumberId` y devuelve `reconnectCleanup` con notificaciones cerradas y duplicados limpiados. `whatsapp_phones_sync` tambien llama a `clearDisconnectedAfterSuccess` si Meta devuelve el numero como `CONNECTED`, de forma que un refresh manual desde Ajustes sanea estados antiguos sin esperar a un envio nuevo.
- En coexistencia, Meta no expone una cuenta atras fiable antes de desconectar por inactividad del movil principal. No se debe crear una alerta preventiva basada solo en fechas internas. La deteccion fiable se hace por `account_update`/`ACCOUNT_OFFBOARDED` de Meta o por error API `100/33`. Si `disconnection_info.reason = PRIMARY_INACTIVITY`, la notificacion usa texto especifico: abrir WhatsApp Business en el movil vinculado, enviar un mensaje desde ese movil y recibir respuesta para reactivar la sesion.
- `POST /api/whatsapp/phones/:phoneNumberId/display-name` debe solicitar el cambio de nombre visible con `new_display_name` contra Graph API. `verified_name` es de lectura y no debe usarse como payload de escritura. El endpoint persiste `requestedDisplayName`, `requestedDisplayNameAt`, `newDisplayName`, `newNameStatus`, `nameStatus` y errores de Meta en `ClinicMetaAsset.additionalData`; si Meta rechaza la solicitud, responde error y no simula exito local. `GET /api/whatsapp/phones` expone `new_display_name`, `new_name_status` y `display_name_requested_at` para Ajustes.
- QuickChat no debe mostrar como burbuja independiente los fallos tecnicos `automation_send_whatsapp_preflight`: el mensaje real fallido conserva la admiracion roja, el detalle tecnico vive en el tooltip y el listado de conversaciones ignora esas filas como preview si existe un mensaje real anterior.
- `GET /api/marketing/review-requests/automation-status?clinicId=<id>` es la lectura ligera para módulos que solo necesitan saber si **Conseguir reseñas** está activa. Reutiliza `authMiddleware`, `resolveReviewRequestSummaryScope` y por tanto los permisos del summary; exige una única clínica y devuelve `clinic_id`, `automation_enabled` y el scope resuelto. Internamente solo llama a `getReviewAutomationTemplate(scope, { includeInactive: true })`: no construye candidatos, tratamientos, métricas, readiness de WhatsApp ni Perfil Google. Scope vacío, grupo, `all` o multiclínica devuelve `400 REVIEW_AUTOMATION_SINGLE_CLINIC_REQUIRED`.
- `GET /api/marketing/review-requests/summary` devuelve el resumen operativo del objetivo de reseñas para el `review_source` solicitado: pacientes posibles, preview de candidatos con tratamiento, peticiones enviadas, valoraciones internas `1-4` y `5`, reseñas publicas conciliadas en Google (`google_reviews_matched`), `treatment_options` con contador de pacientes elegibles por tratamiento, estado de automatización, disponibilidad de la plantilla WABA aprobada de solicitud, disponibilidad informativa del recordatorio, disponibilidad de WhatsApp y disponibilidad de `url_dejar_resena`. La preview acepta `preview_limit` y devuelve `candidates_preview_total`/`candidates_preview_limit` para que el front pueda enseñar más candidatos sin confundirlo con el total. Las métricas `requests_sent`, `ratings_1_to_4`, `ratings_5`, `google_reviews_matched` y `low_rating_reasons` solo cuentan items/eventos de reseñas con solicitud real enviada, en cola o ya respondida; se excluyen envíos de prueba `mass_campaign_test` y valoraciones sueltas sin solicitud real para no inflar conversión. `google_reviews_matched` se calcula con `BusinessProfileReviews.matched_contact_event_id`, por lo que mide reseñas Google vinculadas, no pacientes que solo respondieron `5/5` en privado. Si la automatización está activa, `automation_template` incluye también `review_gift_enabled`, `review_gift_description`, `review_display_clinic_name` y `review_sender_name` para que la UI explique si opera con premio/sin premio, nombre visible, remitente y audiencia. Acepta `review_treatment_ids` como lista separada por comas para filtrar varios tratamientos; `review_treatment_id` sigue soportado como compatibilidad. En este endpoint, si llegan `scope=group:<id>` y `clinic_id` juntos, el backend debe priorizar `scope` para que el front pueda conservar una sede activa sin perder el desglose de grupo. En scope de grupo añade `clinic_statuses`, `group_total_clinics`, `group_ready_clinics` y `group_blocked_clinics`: cada sede se evalua por candidatos posibles, `url_dejar_resena` disponible, WhatsApp conectado, plantilla WABA aprobada de solicitud y automatización individual de clínica. Cada `clinic_status` expone labels/hints listos para UI (`google_status_label`, `whatsapp_status_label`, `template_status_label`, `status_label`, `status_hint`, `automation_label`, `automation_hint`) para que el front no deduzca estados complejos. Si una automatización está activa pero la sede no está lista, se etiqueta como `Configurada, sin enviar`. La UI no muestra switches por sede: usa un interruptor general de grupo como operación masiva y un desglose por clínica para explicar qué sedes están listas y cuántos pacientes posibles aporta cada una. Las sedes no listas quedan fuera del envío hasta resolver el motivo; las listas usan el enlace de reseña de la sede de cada item, no un enlace global del grupo.
- El resumen de reseñas y cada `clinic_status` exponen `approved_photo_template_available`/`approved_photo_template_id` para que la UI bloquee foto de equipo solo cuando realmente falta la variante WABA con cabecera `HEADER/IMAGE`.
- Alias de ficha local para reseñas: por defecto, Reseñas consume la misma ficha efectiva conectada/mapeada para la clínica; no mantiene una conexión propia. Una ficha de Google Business Profile sigue siendo única en `ClinicBusinessLocations.location_id` y no debe duplicarse entre clínicas. Si una sede debe pedir reseñas usando la ficha de otra sede, se configura en `Clinicas.configuracion.reviews.google_business_profile_alias_clinic_id` y/o `google_business_profile_alias_location_id`. Esto solo afecta a `url_dejar_resena`, metadatos `review_profile_alias_*` y al estado de reseñas (`GET /api/local/clinica/:id/status?purpose=reviews`); la configuración general de clínica, Informes, datos de ubicación y `Marketing > Perfil Google` siguen mostrando únicamente la ficha realmente asignada a esa clínica. El alias no duplica OAuth, no transfiere propiedad administrativa y no debe convertirse en fallback general de Perfil Google.
- Edicion del alias de reseñas 2026-07-27: `POST /oauth/google/local/map-locations` con `mapping_purpose=reviews` exige una sola clínica destino y una sola ubicación, ya activa y mapeada a su clínica real. Valida acceso de escritura al destino, lectura sobre el origen y pertenencia al mismo grupo; después actualiza solo `Clinicas.configuracion.reviews.google_business_profile_alias_*`. No mueve `ClinicBusinessLocations.clinica_id`, no desactiva ubicaciones y no encola backfill. `GET /oauth/google/local/mappings?mapping_purpose=reviews&clinic_id=<id>` devuelve la selección efectiva para precargar el mapeador contextual.
- En vista de grupo, el interruptor de reseñas no representa una plantilla operativa de grupo. Al activarlo se crean/actualizan las automatizaciones individuales de las clínicas del grupo; al pausarlo se desactivan las automatizaciones existentes de esas clínicas. Esto evita herencias/overrides difíciles de explicar al usuario.
- `PATCH /api/marketing/review-requests/automation` activa/desactiva una plantilla `AutomationFlowTemplatesV2` por clínica con `trigger_type=appointment_completed`. Para activarla exige Perfil Google con `url_dejar_resena`, WhatsApp conectado, remitente de reseñas (`review_sender_name`) y plantilla WABA aprobada de solicitud; el recordatorio de sin respuesta es opcional y no bloquea el primer envío. Si falta algo devuelve `409 review_automation_requirements_missing` con `warnings` (`template_not_approved`, `sender_name_missing`, etc.). Si recibe `scope=group:<id>`, ejecuta la misma operación clínica para cada sede del grupo y devuelve `group_result` con sedes actualizadas/activas/fallidas; no crea `review_request_after_completed__group_*`. La plantilla actual es V2 y encadena `delay/fixed` de 24h tras `appointment_completed` -> `action/request_review` con `review_source=completed_treatment` -> `delay/wait_response` de 24h. Si hay respuesta entra en `condition/field_check`, que comprueba `last_response_context.response_rating >= 5`; si es verdadero continúa por `action/review_followup` con `followup_kind=google_review`, y si es falso continúa por `action/review_followup` con `followup_kind=private_feedback`. Si no responde en 24h, intenta `action/request_review_reminder` con la plantilla `clinicaclick_recordatorio_resena_sin_respuesta` si existe activa; si no existe, salta a `action/review_no_response` y cierra el flujo sin bloquear el primer mensaje. La acción `request_review` conserva en su configuración `review_gift_enabled`, `review_gift_description`, `review_display_clinic_name`, `review_sender_name` y `review_team_photo_url`; el runtime los traslada a la lista generada automáticamente.
- Las solicitudes de reseñas se materializan como `mass_sends` con `criteria.review_request = true` y `template_usage = solicitud_resena`. Si `list_source=current_patients`, el backend crea candidatos desde `CitasPacientes` completadas o desde pacientes actuales en selección manual. La selección manual considera tanto `Pacientes.clinica_id` como vínculos en `PacienteClinicas`, para que un paciente cuya clínica principal sea otra sede del grupo pueda usarse como ejemplo o receptor si está vinculado a la clínica activa. Cuando se filtra por tratamientos, guarda `criteria.review_treatment_ids` y conserva `criteria.review_treatment_id` con el primer valor para consumidores legacy.
- En selección manual de reseñas, el candidato se enriquece con la última cita `completada` del paciente dentro del scope para personalizar `tratamiento`, `fecha_cita` y `referencia_visita`. `referencia_visita` es una variable interna de plantilla; en UI debe explicarse como última atención/fecha de atención. Las citas históricas importadas pueden usarse como contexto de reseñas, pero el runtime de citas las omite en automatizaciones y jobs programados por `motivo = "Importación de pacientes para reactivación"` o `titulo` `Histórico:`.
- La importación histórica para reseñas/reactivación acepta aliases de fecha tipo `fecha_tratamiento`, `fecha_de_tratamiento`, `fecha_realizacion`, `fecha_ultima_cita` y `fecha_ultimo_tratamiento`. Si el CSV trae nombres como `Apellidos Apellidos Nombre`, el frontend debe inferir `name_format=last_last_first` y el backend mantiene la misma lógica automática como red de seguridad; así se separan nombre/apellidos para evitar que el WhatsApp salude por el apellido. Estas citas importadas son datos de contexto: nunca deben lanzar `appointment_created` ni recordatorios de cita; si aparecen en actividad de paciente deben mostrarse como tratamiento histórico importado.
- En candidatos de reseñas, `tratamiento` no debe rellenarse con valores técnicos genéricos (`visita`, `cita`, `Importación de pacientes...`). Si la cita histórica tiene `titulo = "Histórico: ..."` se limpia el prefijo y solo se usa cuando queda un tratamiento real. Si no existe tratamiento identificable, el front debe mostrarlo como no asignado.
- Fuentes soportadas para reseñas: `first_completed_or_completed_treatment`, `first_completed_appointment`, `completed_treatment`, `manual_selection`. Las dos primeras se mantienen para leer automatizaciones históricas. La automatización operativa nueva debe usar `completed_treatment`: envía 24h después de una cita completada que tenga tratamiento asociado y excluye cualquier paciente que ya tenga una solicitud previa enviada/en cola para evitar duplicados.
- En reseñas, `appointment_completed` significa que la cita se ha marcado con `estado = completada`, es decir, el paciente ha acudido o la clínica la da por realizada. No equivale a `info_confirmada` ni a `recordatorio_confirmado`, que solo indican confirmación previa del paciente. La automatización vigente no envía en ese instante: entra primero en `delay/fixed` de 24h.
- La escala de reseña es `1-5`; el filtro público queda fijado en `5/5`. Las plantillas WABA `solicitud_resena` y `recordatorio_resena_sin_respuesta` ya no usan botones rápidos: WhatsApp colapsa 5 opciones bajo "ver todas las opciones" y Meta rechaza emojis/formato en botones. Ambas muestran la escala con estrellas en el cuerpo en orden descendente (`5 ⭐⭐⭐⭐⭐` ... `1 ⭐`) y el paciente responde escribiendo `1`, `2`, `3`, `4` o `5`. El copy base actual incluye `firma_resenas`/`review_sender_name` para firmar el mensaje inicial y abre con: `Soy {{firma_resenas}} de {{nombre_clinica}}. ¿Te puedo hacer una pregunta? Como viste, en la clínica somos una pequeña familia...`; muestra directamente las cinco opciones. En reseñas, las variables `{{nombre}}`, `{{nombre_paciente}}` y equivalentes deben resolverse solo con nombre de pila para que el saludo sea natural; `{{nombre_completo}}` queda reservado para usos explícitos. Al recibir la respuesta, `materializeInboundReply` crea `review_rating_received`; si la valoración es `5/5` envía follow-up con `{{clinica.url_dejar_resena}}` como URL visible en texto, y si es `1-4` pide motivo como opinión privada. Si el paciente responde con valoración y motivo en el mismo mensaje (`4 estrellas. El doctor...`), el backend separa la nota del comentario, guarda ese comentario como `review_private_feedback_received` y no envía otra pregunta pidiendo el motivo. Si responde `1-4` y después `5`, se ignora el cambio para no llevarlo a Google; si responde `5` y después baja a `1-4`, se pide motivo privado una sola vez. El texto que llega después de un `review_private_feedback_request` se trata siempre como motivo privado y no se vuelve a parsear como valoración, aunque contenga números como tiempos de espera o fechas; la valoración mostrada se conserva desde el mensaje que originó la petición de motivo. Si por reintento/webhook tardío el mismo inbound ya quedó registrado como `review_rating_received`, no se guarda de nuevo como `review_private_feedback_received` ni se pinta en actividad/resumen como motivo. Se evita `interactive cta_url` para reseñas porque puede abrir Google en un contexto que obliga a iniciar sesión, mientras el enlace directo conserva mejor el flujo de escritura de reseña. Los follow-ups tras respuesta usan texto libre porque el inbound del paciente abre ventana de 24h; si en el futuro se diferencian o retrasan fuera de esa ventana deberán tener fallback por plantilla aprobada. Si el paciente deja motivo, se guarda como `review_private_feedback_received` y se envía acuse `review_private_feedback_ack` para cerrar la conversación. Si el paciente no contesta a la primera solicitud, el backend intenta enviar recordatorio 24h después solo si existe plantilla activa; si no existe, cierra el flujo como sin respuesta sin bloquear el primer envío. Las solicitudes manuales en cola (`mass_sends`) usan la misma política opcional de recordatorio/no-respuesta por item para no comportarse distinto a la automatización futura. En envíos de prueba (`mass_campaign_test`), el follow-up debe enviarse al número de prueba guardado en `metadata.recipient`, no al teléfono del contacto usado para renderizar variables; además, cada prueba se evalúa por `trigger_message_id` para poder repetir tests sobre el mismo contacto/lista sin bloquear el nuevo follow-up.
- Si una campaña/lista de reseñas se prepara con premio, `criteria.review_gift_enabled` y `criteria.review_gift_description` gobiernan el follow-up de `5/5`. Sin premio: mensaje corto con URL visible para publicar en Google. Con premio: texto corto con la descripción del regalo, URL visible y la instrucción de escribir al WhatsApp para tramitarlo. Este follow-up no es plantilla WABA: se envía como mensaje de sesión justo después de recibir la valoración del paciente, aprovechando la ventana de 24h abierta por ese inbound. El backend usa un margen operativo de 23h50; si el webhook/materialización llega fuera de ventana, no intenta enviar texto libre y registra `review_rating_followup_skipped` con `reason=whatsapp_session_window_expired`.
- Desde 2026-07-14 el follow-up positivo acepta `criteria.review_team_members_text` tanto sin premio como con premio para humanizar el cierre: si existe, añade `Si mencionas a alguien del equipo en la reseña, como a Dario el dentista o Vero en recepción, les haremos llegar el detalle...`; si no existe, mantiene el fallback genérico `Si mencionas a alguien del equipo en la reseña...`. Este texto se guarda en criterios de la lista y en la configuración del nodo `action/request_review`, se usa también en campañas automáticas futuras y no requiere aprobación de Meta porque se envía como mensaje de sesión tras la respuesta `5/5`, no como plantilla WABA.
- En envíos de prueba de reseñas, `sendTest` persiste antes de enviar los campos editados en el paso `Mensaje` (`review_display_clinic_name`, `review_sender_name`, `review_team_photo_url`, color y `review_team_members_text`) y los copia también a la metadata del mensaje disparador. Esto evita carreras: si el paciente de prueba responde `5` inmediatamente, el follow-up lee el copy actualizado aunque la UI siga en el stepper. Las pruebas se deduplican por `trigger_message_id`, no por contacto/lista global, para poder repetir un test sobre el mismo paciente de ejemplo sin que una respuesta anterior bloquee la nueva.
- Además, `sendTest` no debe generar un disparador de reseña sin configuración humana si existe una configuración útil anterior en el mismo scope. Si el body de la prueba llega sin remitente/foto/miembros por una carrera de UI o debounce, el backend completa los campos desde la lista actual y, si hace falta, desde `last_request_template`; esos valores se copian a `metadata.review_*` del mensaje disparador para que el follow-up de `5/5` pueda renderizar el texto correcto.
- El resumen de `Campañas > Reseñas` incluye `last_request_template` con la última configuración manual/preparada del scope que tenga datos reales de mensaje (`review_sender_name`, foto, miembros o premio). El frontend debe usarlo como fallback cuando no haya borrador de sesión ni automatización activa, para que al reentrar al flujo se vean los campos ya guardados aunque la automatización futura no esté activada. No debe restaurar listas vacías o preparadas accidentalmente solo con nombre visible, porque podrían tapar una configuración útil anterior.
- La resolución de plantillas de reseñas prioriza copias `APPROVED` cuyo BODY coincide exactamente con el catálogo vigente y contiene el remitente configurable (`firma_resenas`/placeholder 3). Si una automatización antigua apunta a un `whatsapp_template_id` aprobado pero con copy obsoleto, el backend busca primero una copia aprobada del mismo catálogo/WABA con el cuerpo actual antes de reutilizarla; si no existe, no desbloquea el envío. En listados efectivos de plantillas, una copia aprobada compatible tiene prioridad sobre una copia más nueva en revisión para que `Marketing > Plantillas` muestre las plantillas de sistema utilizables como solo lectura. Desde 2026-07-02, `syncTemplatesForWaba` mantiene localmente inactivas las copias de `clinicaclick_solicitar_resena` y `clinicaclick_solicitar_resena_foto` cuyo BODY no incluya el remitente (`firma_resenas`/`review_sender_name`), aunque sigan existiendo en Meta como histórico aprobado/rechazado. Desde 2026-07-28 también se aceptan copias externas aprobadas para `solicitud_de_opinion`/`opinion_tras_visita` cuando son `MARKETING`, no tienen botones, contienen remitente (`firma_resenas` o `Soy {{2}}/{{3}}`) y muestran escala `1-5`; el recordatorio de sin respuesta se expone por separado y no bloquea que la sede pueda pedir reseñas.
- Primer mensaje administrativo 2026-07-27: `POST /api/whatsapp/templates/custom` admite `template_usage=solicitud_resena` solo para administradores globales. Estas copias `origin=custom`, de categoría `MARKETING`, pueden sustituir el copy del primer mensaje sin alterar la automatización posterior; deben mantener el contrato de valoración textual 5-1 y solo son elegibles cuando están `APPROVED`. Si llega `header_image_url`, el backend crea `HEADER/IMAGE`, genera el media handle de muestra requerido por Meta y conserva ese componente en `WhatsappTemplates.components`; la foto dinámica del paciente/campaña se sigue resolviendo desde `review_team_photo_url` al enviar. Una plantilla explícita personalizada nunca debe caer silenciosamente a la plantilla genérica: el selector comprueba aprobación, WABA, cabecera con/sin imagen y contrato de reseñas.
- Contrato de medio 2026-07-29: en solicitudes de reseña, `review_team_photo_url` y `HEADER/IMAGE` deben coincidir exactamente. Si hay foto, el resolvedor solo acepta una plantilla aprobada con cabecera de imagen; si no hay foto, solo acepta una plantilla sin ella. Esto aplica a pruebas, preparación, envío, automatización y reemplazo de una versión de catálogo en otro WABA. No se permite enviar el BODY de texto ignorando una foto configurada ni reutilizar una plantilla `IMAGE` sin parámetros de cabecera.
- Separación Campañas/QuickChat 2026-07-29: las plantillas con uso `solicitud_resena`/`review_request`, catálogo `9/32/34` o familia técnica oficial de reseñas pertenecen al flujo de `Campañas > Conseguir reseñas`; no son mensajes manuales. `GET /api/whatsapp/templates?...&context=quick_chat` las excluye tanto de `Mis plantillas` como del resto de categorías y `POST /api/conversations/:id/messages` rechaza con `409 whatsapp_template_requires_workflow` cualquier intento de forzar su ID. El selector de Campañas conserva las variantes administrativas únicamente cuando el administrador las elige de forma explícita; la opción por defecto solo puede representar el BODY vigente del catálogo, con remitente configurable y escala descendente 5-1. Así la vista previa, la prueba y el envío resuelven el mismo texto, y una variante personalizada no sustituye silenciosamente a la plantilla del sistema.
- Alias de destino de reseñas 2026-07-28: `mapping_purpose=reviews` es una relación muchos-a-uno independiente del mapeo general de Perfil de Empresa. Varias clínicas del mismo grupo pueden usar la misma ficha canónica para solicitar reseñas; guardar Glòries o Eixample no traslada `ClinicBusinessLocations.clinica_id`, no elimina el alias de otra clínica y no requiere una conexión Google propia en la clínica destino. La lectura contextual resuelve el alias antes de la conexión general para que el selector siga preseleccionándolo. La ficha propia para contacto, horarios y métricas continúa siendo exclusiva de su sede.
- En solicitudes manuales de reseñas, `criteria.review_exclusion_rules.phone_prefixes` permite excluir países/prefijos internacionales antes de preparar el envío. El frontend envía prefijos normalizados sin `+` ni `00` (por ejemplo `33` para Francia) y `applyReviewRequestExclusions` marca esos items como `selected=false`, `exclusion_reason=phone_prefix` y motivo `Prefijo telefónico +XX`. Estas exclusiones son solo de esa solicitud/lista y no crean bajas globales. Desde 2026-07-28, `GET /api/marketing/review-requests/summary` aplica también las reglas recibidas, calcula `review_exclusions_total` y `review_exclusion_breakdown` sobre toda la audiencia y conserva los excluidos en la preview. La generación y el resumen comparten un límite operativo configurable mediante `MARKETING_REVIEW_REQUEST_CANDIDATE_LIMIT` (10.000 por defecto, máximo 50.000), evitando que una campaña manual quede recortada a los 500 contactos históricos del fallback general.
- En listados de automatizaciones V2 con scope de clínica/grupo, la base global de reseñas no debe mostrarse como automatización operativa. Las filas publicadas deprecadas/inactivas tampoco se muestran en `Todos`; si una clínica no tiene copia operativa activa o borrador visible, `Campañas > Conseguir reseñas` es el punto de activación/configuración. Esto evita que una base de catálogo parezca activa para una clínica.
- El wizard de reseñas envía `dispatch_config`, `schedule_mode` y `scheduled_at` en `prepare`/`send`. `dispatch_config` define si sale poco a poco o en tandas (`mode`, `batch_size`, `delay_ms`) y si se usa horario de clínica o una ventana concreta (`time_mode`, `business_hours`, `scheduled_time`, `window_start_time`, `window_end_time`). Para `context=review_request`, el backend permite el ritmo recomendado de 1 envío/minuto; el resto de envíos masivos mantienen el mínimo operativo general de 2 minutos. El worker de `marketing_bulk_send_dispatch` debe usar este snapshot guardado en `criteria`, no recalcularlo desde la configuración actual de la clínica. Si `time_mode=specific_time`, la ventana explícita es autoritativa durante preparación, inicio, reanudación, cada lote y sus recordatorios; solo `time_mode=clinic_hours` se hidrata desde `ClinicaHorarios` o, como fallback de reseñas, desde la ficha local efectiva.
- Nomenclatura operativa: la plantilla global editable/inspeccionable desde admin se llama `Reseñas automáticas` y debe mostrarse con badge `Sistema`, no con el prefijo en el título. No dispara envíos por sí sola. Las automatizaciones que sí operan por clínica se nombran `Reseñas automáticas · Clínica: {nombre}`.
- La sincronización de plantillas contra Meta no debe reactivar copias de un `WhatsappTemplateCatalog` inactivo. Si Meta sigue devolviendo una plantilla remota de una familia retirada, `syncTemplatesForWaba` la conserva/actualiza con `is_active=false` y no dispara callbacks de aprobación.
- Limpieza catálogo 2026-07-03: las entradas históricas inactivas sin `template_key` se mantienen como referencia legacy pero no son propagables. Cualquier item activo del catálogo debe resolver a una familia V2 publicada por `public_id` o `template_key`; la automatización QA `qa_reactivation_patient_followup` se desactiva si no existe base publicada válida. Las copias scoped de reseñas deben conservar `template_key=review_request_after_completed__clinic_<id>` y `public_id=flw_review_req_clinic_<id>` para que el colapso de listados y la propagación puedan identificar una única familia por clínica.
- `GET /api/marketing/review-requests/summary` incluye `low_rating_reasons` como panel operativo de valoraciones recientes `1-5`, no como listado bruto de Google. Cada fila devuelve `patient_id`, `conversation_id`, `clinic_id`, `clinic_name` y, si se pudo conciliar, `google_review_comment`, `google_reviewer_name` y `google_review_matched` para explicar por qué una valoración de `5/5` aparece sin comentario interno de WhatsApp. Para `5/5` se muestra el comentario real de Google cuando existe, sin prefijos redundantes porque el front ya muestra `Google: {autor}`; si no, se indica que no comentó en Google o que no se pudo relacionar el usuario público. Para `1-4` se cruza el motivo privado si el paciente lo respondió. Las métricas y motivos recientes se atribuyen solo a listas/campañas con `criteria.review_request = true` o `template_usage = solicitud_resena`, excluyen eventos `mass_campaign_test_*` para no medir conversiones de pruebas y usan solo la última valoración válida por contacto dentro del scope (`paciente_id`, teléfono, email o nombre normalizado) para que respuestas antiguas duplicadas no inflen contadores ni tabla.
- El mismo endpoint devuelve `review_response_heatmaps` para pintar mapas de calor de respuestas por día/hora sin otra petición de front. La clasificación estacional usa el momento de envío de la solicitud (`MarketingPatientListItems.sent_at`) y separa `winter` (diciembre-febrero) y `summer` (junio-agosto). Los días se devuelven con inicial compacta española (`L M X J V S D`) y cada celda se calcula sobre la última valoración válida por contacto en el scope. También devuelve `google_rating_summary`, calculado sobre `BusinessProfileReviews` sincronizadas, con media pública, total, reseñas de 5 estrellas, `needed_five_star_reviews_for_5` y `rating_targets`. `rating_targets` contiene hitos redondeables (`visible_average`, `target_average`, `needed_five_star_reviews`) para que el front muestre cuántas reseñas de 5 hacen falta para subir al siguiente tramo visible y a 5,0.
- Las reseñas nuevas de Perfil Empresa Google se concilian mediante `JobRequests.type=business_profile_review_match`. Al sincronizar `BusinessProfileReviews`, el backend encola un job de baja prioridad que compara `reviewer_name` con pacientes/list items que recibieron el follow-up de Google (`MarketingPatientContactEvents.event_type=review_rating_followup_sent` con `payload.kind=review_google_link_followup`) en las 48h previas en la misma clínica. El scoring normaliza acentos, admite iniciales públicas (`Noemí V.C.`), nombre+apellido compactado (`Jesusramos`) y una errata leve en tokens largos, pero mantiene un umbral prudente para no vincular autores dudosos. Si el score de nombre supera el umbral, marca `BusinessProfileReviews.matched_paciente_id`, `matched_contact_event_id`, `match_confidence`, `match_reason`, `matched_at` y crea un evento `MarketingPatientContactEvents.event_type=google_review_matched` para que aparezca en la actividad del paciente/QuickChat. Las métricas separan `google_reviews_matched` (match directo y prudente paciente-reseña) de `google_reviews_attributed` (reseñas públicas creadas en una ventana de 72h tras enviar un enlace Google real de campaña/lista, excluyendo pruebas). Si no hay candidato claro, no vincula automáticamente a un paciente, pero la card de conversión puede medir impacto con la atribución temporal.
- Al completar una cola manual de reseñas, `criteria.dispatch` conserva `completed_at`, `completed_banner_expires_at`, `review_pending_replies` y `review_pending_reminders`. `review_pending_reminders` se calcula desde `JobRequests.type=marketing_review_request_no_response` en estado pendiente y solo para items enviados que todavía no respondieron; `getDispatchStatus` recalcula esos valores para campañas completadas antiguas si el front consulta el estado directo. Esto permite que el front mantenga unos días el aviso de cola completada sin decir que el flujo terminó del todo mientras quedan recordatorios reales en espera.
- `GET /api/marketing/bulk-sends/campaigns/:id/recipients?status=ready` filtra por `MarketingPatientListItems.status='ready'`, `selected=true` y `dispatch_status` vacío/pendiente. No debe interpretarse como `dispatch_status='ready'`, porque ese estado no existe y rompería selectores de prueba en campañas/reseñas.
- `GET /api/marketing/bulk-sends/campaigns` acepta `context=mass_sends|reviews|all`. Como las solicitudes de reseña reutilizan `MarketingPatientLists.objective_id=mass_sends`, `context=mass_sends` excluye desde SQL listas con `criteria.review_request=true`, `template_usage=solicitud_resena` o `dispatch.context=review_request`; `context=reviews` devuelve solo esas colas para `Marketing > Campañas > Conseguir reseñas`. No borrar estas listas históricas para limpiar la UI: deben quedar medibles desde reseñas, pero no contaminar `Envíos masivos`.
- Los mensajes WhatsApp encolados por horario silencioso (`metadata.queued_by_quiet_hours=true`) se muestran en QuickChat como programados y pueden forzarse con `POST /api/conversations/messages/:messageId/send-now`. La espera vive en `JobRequests.type=automation_whatsapp_quiet_send`; al vencer relee mensaje, conversación y credenciales activas y encola un transporte BullMQ inmediato con ID estable por mensaje. Si el mensaje ya quedó `sent/delivered/read`, lo omite para evitar duplicados.
- La automatización admin de reseñas debe resolver siempre a la plantilla global `public_id=flw_review_request_system`, `template_key=review_request_after_completed`, versión 2. Las clínicas tienen copias operativas con `template_key=review_request_after_completed__clinic_<id>` y `public_id=flw_review_req_clinic_<id>`. El catálogo admin enlaza contra el `public_id` global para poder editar e inspeccionar el flujo base sin mezclarlo con las copias de clínica.
- La automatización admin `Cancelar cita sin confirmar la noche anterior` queda registrada como `public_id=flw_cancel_unconfirmed_appt_night_before`, `template_key=system_cancel_unconfirmed_appointment_night_before`, `trigger_type=appointment_reminder_window` y `trigger_config={ schedule_moment: day_before, schedule_time_mode: custom, custom_time: 21:00, only_if_not_confirmed: true }`. Envía la plantilla de catálogo `clinicaclick_aviso_cita_sin_confirmar_noche` con copy natural, sin opciones rígidas tipo "responde confirmo/reprogramar/cancelar"; espera 1h y clasifica la intención con `preset_key=appointment_unconfirmed_reply`. Si confirma, marca `recordatorio_confirmado`; si pide reprogramar, cancela la cita para liberar el hueco y crea una notificación interna para recepción; si cancela o no responde, cambia a `cancelada`; si la respuesta es inconclusa, crea una notificación interna y no cierra la cita automáticamente. El runtime evalúa `only_if_not_confirmed` en la hora real del job para no avisar a citas que se confirmaron después de programar el disparo.
- El nodo de WhatsApp de ese flujo usa `require_current_catalog_body=true`: cuando se actualiza la copia del catálogo, el motor no reutiliza una versión antigua aprobada por Meta con texto obsoleto. Si la versión nueva aún está `PENDING`, el envío queda bloqueado hasta aprobación en lugar de mandar un mensaje rígido al paciente.
- Auditoría dev 2026-06-30: la automatización `Cancelar cita sin confirmar la noche anterior` está activa y encola `appointment_automation_schedule_fire` con `payload.__runtime_namespace=staging` para citas futuras. En BS Capilar existen ejecuciones reales recientes (`FlowExecutionsV2.id=693/694`) completadas; no se observaron disparos vencidos posteriores sin procesar en la muestra revisada.
- QA dev 2026-06-27: se lanzó la automatización real contra BS Capilar para el paciente QA Carlos BS (`CitasPacientes.id_cita=435`, `FlowExecutionsV2.id=692`, `Messages.id=31732`, conversación `2142`). El envío usó la plantilla aprobada `clinicaclick_aviso_cita_sin_confirmar_noche_v10` del WABA `825171709863569` y dejó el flujo esperando en `delay/wait_response` (`N3`) para validar que el webhook inbound reanuda con `preset_key=appointment_unconfirmed_reply`.
- QA dev 2026-06-22: `review-requests/summary` validado para `first_completed_appointment`, `completed_treatment` y `manual_selection`; `PATCH /review-requests/automation` activó la plantilla clínica `review_request_after_completed__clinic_66`; `action/request_review` se probó con cita completada y devolvió `approved_review_template_missing` sin enviar mensajes cuando no hay plantilla WABA aprobada.
- QA Meta 2026-06-22: el payload con botones `1⭐`-`5⭐` fue rechazado por Meta con `code=100`, `error_subcode=2388060`, `Button Format is Incorrect` y mensaje `Buttons can't have any variables, newlines, emojis, or formatting characters.`. Tras cambiar los botones a `1`-`5`, Meta aceptó y aprobó la revisión de `clinicaclick_solicitar_resena` para BS Capilar (`meta_template_id=2747631985622377`, estado `APPROVED`).
- QA Meta 2026-06-24: se actualizó el catálogo `clinicaclick_solicitar_resena` con copy más humano (`¡Hola {{1}}! Nos encantaría conocer tu opinión...`) y se propagó a WABAs conectados. Para BS Capilar quedó creada y aprobada la versión técnica `clinicaclick_solicitar_resena_v9` (`meta_template_id=1678832034252619`). Durante cambios de copy, `findApprovedReviewWhatsappTemplate` puede aceptar versiones aprobadas sin botones y con escala visible de estrellas aunque el BODY exacto sea anterior; esto mantiene el envío operativo hasta que Meta apruebe la nueva copia.
- QA Meta 2026-06-24: tras probar en móvil, WhatsApp mostró solo `1`, `2` y "ver todas las opciones" para los cinco botones. Se cambia el catálogo a una plantilla sin botones y con estrellas en el cuerpo, de forma que la previsualización de la app coincida con el WhatsApp real. La migración `20260624162000-deactivate-old-review-request-template-versions` deja inactivas las versiones locales antiguas con botones; no borra plantillas en Meta.
- Decision producto 2026-07-02: la escala visible en las plantillas de reseñas se ordena de mayor a menor (`5 ⭐⭐⭐⭐⭐` ... `1 ⭐`) para favorecer que el paciente vea primero la mejor valoración. Las copias operativas antiguas con orden `1` a `5` no deben seleccionarse para nuevos envíos.
- QA dev 2026-06-24: el acuse de opinión privada se materializa en gateway con `review_private_feedback_ack`. La migración `20260624184500-update-review-request-template-question-copy` actualiza el catálogo al copy con pregunta inicial. Durante la transición, el selector acepta versiones aprobadas sin botones que mantengan la escala visible con estrellas aunque el BODY exacto aún sea el de la versión previa, para no cortar envíos mientras Meta aprueba la nueva revisión.
- Pendiente de roadmap: contadores de límites por clínica para WhatsApp enviados, pacientes alcanzados, automatizaciones activas/ejecutadas e instalaciones. No resolver esos límites desde frontend.

## 2026-06-30 - PUBLIC_MEDIA S3/CloudFront

`PUBLIC_MEDIA` es un storage exclusivo para assets publicos/no clinicos. No debe usarse para RX, consentimientos, informes, audios de pacientes, fotos clinicas, STL, documentos de laboratorio ni cualquier fichero con dato clinico o identificable de paciente.

Infraestructura objetivo:

- Bucket: `clinicaclick-public-media-eu-west-3`
- Region: `eu-west-3`
- Cuenta AWS recursos: `137819318729`
- CloudFront distribution: `E3TRXQ4DMSYUVL`
- CloudFront ARN: `arn:aws:cloudfront::137819318729:distribution/E3TRXQ4DMSYUVL`
- Base URL: `https://media.clinicaclick.com`

Variables:

- `AWS_DEFAULT_REGION`
- `PUBLIC_MEDIA_BUCKET`
- `PUBLIC_MEDIA_BASE_URL`
- `CLOUDFRONT_DISTRIBUTION_ID`
- `PUBLIC_MEDIA_ASSUME_ROLE_ARN` opcional si el servidor debe asumir un rol en la cuenta propietaria de los recursos.
- Credenciales por rol IAM/AssumeRole o `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` en `.env` seguro. No subir secretos a git.

Estado de cuentas 2026-07-01:

- la instancia llama como `arn:aws:sts::468355432137:assumed-role/AmazonLightsailInstanceRole/i-0b2967e8de0866910`;
- bucket y CloudFront reales estan en `137819318729`;
- no sirve conceder `cloudfront:CreateInvalidation` al rol de Lightsail contra un ARN de CloudFront construido con la cuenta `468355432137`, porque la distribucion real no esta en esa cuenta;
- opcion A: configurar `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` de minimo privilegio de la cuenta `137819318729`;
- opcion B: crear `arn:aws:iam::137819318729:role/ClinicaclickPublicMediaUploader` con confianza a `arn:aws:iam::468355432137:role/AmazonLightsailInstanceRole` y definir `PUBLIC_MEDIA_ASSUME_ROLE_ARN` en el servidor. El rol de la cuenta `468355432137` solo necesita `sts:AssumeRole` sobre ese rol.
- 2026-07-01: queda aplicada la opcion A en dev con usuario IAM `clinicaclick-public-media-uploader` en la cuenta `137819318729` e inline policy `ClinicaclickPublicMediaPolicy`. La access key esta solo en `.env` seguro del servidor (`chmod 600`), no en git.
- 2026-07-01: el rol destino `ClinicaclickPublicMediaUploader` tambien existe, pero no se usa en dev porque `sts:AssumeRole` desde `AmazonLightsailInstanceRole` de la cuenta `468355432137` devuelve `AccessDenied 403` sin la mitad de permisos de esa cuenta.

Implementacion:

- Modelo: `PublicMediaAsset`
- Tabla: `PublicMediaAssets`
- Migracion: `20260630233000-create-public-media-assets.js`
- Servicio: `src/services/publicMediaStorage.service.js`
- Controlador: `src/controllers/publicMedia.controller.js`
- Ruta: `GET /api/public-media/status`
- Ruta: `POST /api/public-media/upload`

Contrato `POST /api/public-media/upload`:

```json
{
  "clinic_id": 66,
  "purpose": "review_team_photo",
  "file_name": "equipo.jpg",
  "content_type": "image/jpeg",
  "data_url": "data:image/jpeg;base64,...",
  "owner_type": "review_request",
  "owner_id": 123,
  "non_clinical_asserted": true
}
```

Respuesta:

```json
{
  "success": true,
  "asset": {
    "url": "https://media.clinicaclick.com/whatsapp/reviews/team/clinic-66/2026/06/uuid.jpg",
    "key": "whatsapp/reviews/team/clinic-66/2026/06/uuid.jpg",
    "content_type": "image/jpeg",
    "size_bytes": 12345,
    "cache_control": "public, max-age=31536000, immutable"
  },
  "usage": {
    "asset_count": 1,
    "size_bytes": 12345
  }
}
```

Reglas:

- S3 sube sin `ACL` y sin `public-read`.
- El bucket debe permanecer privado; la exposicion publica es via CloudFront/DNS.
- Las keys se generan opacas y no incluyen nombres de paciente, DNI, diagnostico ni tratamiento.
- `size_bytes` se persiste por clinica/grupo para futura facturacion de almacenamiento.
- Si se sobrescribe una key existente, el servicio puede crear invalidacion CloudFront con `CLOUDFRONT_DISTRIBUTION_ID`.

Uso actual:

- `Marketing > Campanas > Conseguir resenas` permite subir la foto del equipo para plantillas WhatsApp de resenas. La URL devuelta se guarda como `review_team_photo_url` en criterios de lista/campana y en la configuracion de automatizacion recurrente.
- Si la plantilla de reseñas usa cabecera de imagen, el backend prepara la foto en `sendDispatchItem`/`sendTest`: descarga la foto base desde PUBLIC_MEDIA, compone una imagen JPEG 1200x675 compatible con WhatsApp con una banda solida y texto blanco `¡Hola {nombre}!`, y sube la derivada como `purpose=whatsapp_image`. Para evitar recortes, la foto se encaja completa dentro del formato y el sobrante se rellena con una version desenfocada de la misma imagen. Esta es una excepcion controlada de producto para cabecera WhatsApp de reseñas: solo puede incluir nombre de pila, nunca apellidos completos, telefono, diagnostico, tratamiento ni dato clinico. El color se guarda en `review_team_photo_overlay_color`. La key sigue siendo opaca y determinista por foto/nombre/color; si se repite una prueba con la misma combinacion se actualiza el registro `PublicMediaAssets` existente en vez de fallar por duplicado. `PublicMediaAssets.metadata` marca `patient_name_present=true`, `patient_data_in_public_media=true`, `image_fit=contain_with_blurred_cover_background` y `public_media_patient_data_exception=review_whatsapp_header_greeting`. La derivada se recomprime por debajo del limite de WhatsApp de 5 MB; si no se puede garantizar ese limite, no se envia la foto original como fallback porque Meta la rechazaria. Si la transformacion falla por un error transitorio no relacionado con tamano, se usa la foto base; si la URL no pertenece a PUBLIC_MEDIA, se bloquea. Las subidas `review_team_photo`/`whatsapp_image` se normalizan a JPEG antes de guardarse cuando no son JPEG o cuando superan 5 MB, evitando que una foto aceptada por PUBLIC_MEDIA falle despues al pedir el `header_handle` de Meta.
- El catalogo `clinicaclick_solicitar_resena_foto` usa `https://media.clinicaclick.com/templates/reviews/team-example.jpg` solo como imagen publica/no clinica de ejemplo para que Meta genere el `header_handle` de revision. No se reutiliza como imagen enviada al paciente; en el envio real se pasa la foto de equipo configurada y, si aplica, su version personalizada.

Estado QA 2026-06-30:

- AWS CLI no esta instalado en el servidor.
- El SDK AWS esta instalado en backend, fijado a `@aws-sdk/client-s3@3.600.0` y `@aws-sdk/client-cloudfront@3.600.0`, compatible con Node 18.
- No hay variables `AWS_*`/`PUBLIC_MEDIA_*` en shell ni PM2; se usan los defaults no secretos y credenciales por metadata.
- Existe rol de metadata `AmazonLightsailInstanceRole`; STS devuelve `arn:aws:sts::468355432137:assumed-role/AmazonLightsailInstanceRole/i-0b2967e8de0866910`.
- Los recursos PUBLIC_MEDIA reales pertenecen a la cuenta AWS `137819318729`.
- `HeadBucket`, `ListObjectsV2`, `GetObject` y `PutObject` contra `clinicaclick-public-media-eu-west-3` fallan con `AccessDenied 403`.
- `cloudfront:CreateInvalidation` contra `E3TRXQ4DMSYUVL` falla con `AccessDenied 403`.
- La prueba `test/health.txt` y la subida API de una imagen dummy fallaban con `AccessDenied 403` antes de configurar credenciales propias de la cuenta `137819318729`. El codigo soporta `PUBLIC_MEDIA_ASSUME_ROLE_ARN`, pero en dev se deja vacio porque se usa la opcion A.
- En dev estan aplicadas las migraciones `20260630143000-update-review-request-template-photo-variant.js`, `20260630170000-mark-review-automation-catalog-propagated.js` y `20260630233000-create-public-media-assets.js`; el catalogo `clinicaclick_solicitar_resena_foto` existe con cabecera `IMAGE`.
- Script de prueba repetible: `node src/scripts/test_public_media_upload.js` y despues `curl -I https://media.clinicaclick.com/test/health.txt`.

Estado QA 2026-07-01:

- IAM usuario `clinicaclick-public-media-uploader` creado en `137819318729` con policy minima para S3 PUBLIC_MEDIA e invalidacion CloudFront.
- `.env` del servidor dev contiene solo las credenciales de ese usuario, fuera de git y con permisos `600`; backup previo movido a `/home/ubuntu/.clinicaclick-env-backups/`.
- `node src/scripts/test_public_media_upload.js` devuelve `success: true` y sube `test/health.txt`.
- `curl -I https://media.clinicaclick.com/test/health.txt` devuelve `HTTP/2 200`, `x-cache: Hit from cloudfront` y metadatos `purpose=test_health`, `sensitivity=public`.
- `pm2-back-dev` reiniciado con `--update-env` y queda `online`.

Documento canonico frontend/producto: `src/Documentacion/32-storage-publico-y-clinico.md`.

Webhooks y colas:

- `POST /api/whatsapp/webhook` responde rápido y encola el payload en BullMQ `webhook_whatsapp` mediante `src/services/queue.service.js`; no procesa 1000 respuestas en la request HTTP.
- `src/workers/queue.workers.js` consume esa cola, persiste `Messages`, socket/realtime y materializa estados de `mass_sends` de forma idempotente.
- `marketing_bulk_send_dispatch` no es BullMQ: es `JobRequests` del runtime propietario. La recepción de webhooks sí es BullMQ. Mantener esa separación evita que gateway ejecute jobs de negocio.
- Para informes de abiertos/no abiertos/respuestas/bajas, usar contadores materializados y `/recipients` paginado. Si se necesita un listado filtrado nuevo, añadir filtro backend paginado; no resolverlo trayendo todos los contactos al frontend.

Plantillas:

- Las plantillas creadas desde campañas usan `POST /api/whatsapp/templates/custom` y crean `WhatsappTemplates`, no `MessageTemplates` legacy.
- El backend acepta variables semánticas (`{{nombre}}`, `{{apellido}}`, `{{telefono_clinica}}`, `{{url_como_llegar_clinica}}`, custom de lista), las transforma a placeholders posicionales de Meta y guarda el contrato en `WhatsappTemplates.variables`.
- `WhatsappTemplates.status` es la fuente de verdad WABA. Una plantilla `MessageTemplates` pendiente no está aprobada ni sincronizable por Meta si no existe registro WABA.
- `PENDING_LOCAL` en una plantilla WABA custom significa que ClinicaClick la guardó localmente, pero Meta no dejó abierta una revisión real. La UI debe mostrarla como `No enviada a Meta` y no como aprobada ni en revisión.
- `DELETE /api/whatsapp/templates/:id` devuelve `409 template_linked_to_campaigns` si la plantilla está referenciada por campañas/listas no archivadas. La UI debe pedir confirmación explícita antes de ocultarla; las campañas conservan `template_snapshot`, pero no deben poder reutilizar una plantilla oculta.
- La retirada manual de una plantilla personal escribe `is_active=false`,
  `retired_at` y `retired_by_user_id`. `retired_at` es el tombstone funcional;
  no se falsifica `status`, porque ese campo continúa reflejando el estado que
  devolvió Meta (`APPROVED`, `REJECTED`, etc.). Si el usuario desaparece,
  `retired_by_user_id` puede quedar a `NULL`, pero `retired_at` se conserva.
- Sustituir una plantilla personal marca la versión anterior con
  `is_active=false` y `superseded_by_template_id=<id_nuevo>`. La sincronización
  WABA respeta tanto el tombstone manual como el enlace de sustitución y nunca
  reactiva esas filas aunque Meta siga devolviéndolas. Una fila meramente
  inactiva, rechazada o temporalmente desconectada, sin ninguno de esos dos
  marcadores, no se confunde con una retirada y puede volver a reflejar el
  estado remoto vigente.

## Contrato backend: ayuda de acceso a la clinica (2026-07-14)

`Clinicas.configuracion.access_guidance` tiene el contrato:

```json
{
  "enabled": true,
  "directions": "Entra por el pasaje lateral junto a la farmacia.",
  "image_asset_id": 123,
  "image_url": "https://media.clinicaclick.com/.../access.jpg"
}
```

La ausencia del subarbol equivale a desactivado. Desactivar conserva texto e
imagen; retirarla pone sus dos campos a `null`. El PATCH de clinica fusiona
`configuracion` sin sustituir el documento completo y debe preservar
`agenda_settings`, `disciplinas` y claves concurrentes/desconocidas. La frontera
backend valida booleano, texto de hasta 500 caracteres, id positivo y URL HTTPS.

Los endpoints de clinica dejaron de confiar solo en la UI: lectura requiere JWT,
scope efectivo y `clinic.settings.view`; PATCH requiere
`clinic.settings.edit`. `POST /api/public-media/upload` aplica el mismo scope de
edicion para `purpose=clinic_access_image`, exige
`non_clinical_asserted=true`, valida el contenido y normaliza a JPEG sin EXIF.
El asset conserva auditoria de usuario, clinica, grupo, hash, MIME y key opaco.
Cada sustitucion genera un key nuevo y versionado. Desactivar o retirar solo
cambia la referencia de `Clinicas.configuracion`: hoy no borra fisicamente S3,
por lo que el asset anterior queda huerfano pero auditable hasta que exista un
ciclo seguro de retencion, comprobacion de referencias y cleanup por
`JobRequest`.

La capacidad de edicion de ficha no autoriza operaciones de administracion
global: crear o eliminar una clinica queda limitado al admin global. Mover una
clinica entre grupos o desvincularla exige ser admin global o propietario
explicito de todas las clinicas que integran cada grupo afectado, tanto origen
como destino; un grupo vacio solo puede recibir su primera clinica mediante
admin global. Las respuestas de solo lectura omiten `datos_fiscales_clinica`;
los editores autorizados lo reciben en el detalle. El rol `unknown` conserva
lectura de ajustes por compatibilidad con asignaciones antiguas, nunca edicion.

Automatizaciones V2 aplana el subarbol como
`clinica.indicaciones_acceso` e `clinica.access_guidance_image_url`. La variable de
catalogo `indicaciones_acceso_clinica` se enlaza con la primera; es distinta del
alias legacy `indicaciones`, que sigue significando URL de como llegar.

La automatizacion de las 08:00 expone la decision en su grafo publicado. Como
las versiones publicadas son inmutables, la migracion crea una version nueva de
cada familia afectada y conserva intacta la anterior y sus ejecuciones. El tramo
queda asi: activador -> `condition/field_check` sobre
`clinica.access_guidance_reminder_enabled` -> envio variante o envio base ->
`control/join` -> el `condition/ai_analysis` que ya existia. El booleano solo es
verdadero para `primera_sin_trat`/`primera_con_trat` con la opcion marcada; las
citas recurrentes entran siempre en la rama base.

El envio de la rama especial vuelve a comprobar texto, asset, plantilla
`APPROVED`, cuerpo vigente y WABA antes de materializar. Si alguna precondicion
falla, usa dentro de ese mismo nodo la plantilla base declarada en
`fallback_*`, dejando `access_guidance_fallback_reason` observable. No se usa
`on_fail -> otro envio`: ese patron podria duplicar si el resultado del POST a
Meta fuera ambiguo. El `Message` guarda rama, parametros y
`template_components`; el envio inmediato y el job de quiet hours usan ese
snapshot sin volver a decidir.

Antes de seleccionar la variante, el runtime vuelve a comprobar que
`image_asset_id` siga siendo un `PublicMediaAsset` activo, publico, con
`purpose=clinic_access_image`, perteneciente a la misma clinica y con la misma
URL. Un fallo o mismatch cae a la base y queda en
`access_guidance_fallback_reason`; nunca envia una URL arbitraria guardada por
fuera del PATCH validado.

La materializacion ordinaria de `action/send_whatsapp` usa
`flow:<execution_id>:node:<node_id>`. Los dos nodos alternativos de este
recordatorio declaran el mismo `delivery_slot=same_day_first_visit_reminder`, de
modo que ambos resuelven a
`Messages.automation_delivery_key=flow:<execution_id>:slot:same_day_first_visit_reminder:outbound`.
La clave es unica globalmente por la migracion
`20260714121000-add-message-automation-delivery-key.js`. El guard se ejecuta
antes de releer plantilla, conversacion o credenciales, por lo que un replay no
duplica el recordatorio aunque se reevalúe la condicion o cambie el telefono del
paciente. El evento interno usa la misma familia con sufijo `:event`.

Para primeras visitas con la opcion activada, incluso cuando se usa fallback a
la base, el handoff es durable: primero persiste `Message`, rama, cabecera,
destinatario, WABA/phone y el `jobId` determinista; despues publica BullMQ. Las
quiet hours persisten ademas `queued_by_quiet_hours` y `scheduled_for` antes de
crear `JobRequest(type=automation_whatsapp_quiet_send)`. Si falla ese handoff,
la misma `FlowExecutionV2` queda `waiting` en el nodo actual y el JobRequest la
reanuda con `retry_current_node`, backoff exponencial y maximo cinco intentos.
Las citas recurrentes conservan el transporte historico sin este opt-in de
reintentos.

El worker relee credenciales activas, pero exige que `phoneNumberId` y `wabaId`
coincidan con el snapshot que selecciono la plantilla. Un cambio de remitente
falla observablemente en lugar de intentar una plantilla sobre otro WABA. Solo
se reintentan fallos seguros anteriores a una respuesta del proveedor (DNS de
conexion, 429 o 5xx explicitos). Timeout, `ECONNRESET` o respuesta ambigua se
marcan `delivery_unknown` y no repiten el POST; un WAMID ya aceptado tampoco se
reenvia aunque falle despues una escritura local. Bull conserva completados 24
horas/1000 jobs y fallidos 7 dias/5000 jobs.

Que el log del nodo o la `FlowExecutionV2` termine en success significa que el
handoff durable quedo confirmado, no que Meta ya entrego. La fuente final es
`Messages.status`, `metadata.wamid`/`outbound_retry` y el webhook. El catalogo
alternativo usa BODY con texto fijo despues de `{{5}}` (`Si necesitas ayuda,
respóndenos por aquí.`), porque Meta rechaza cuerpos que terminan en variable.
La migracion de catalogo es transaccional e idempotente: reutiliza una definicion
canonica existente y aborta si encuentra otra incompatible. Para cada familia
publica `MAX(version)+1`, desactiva solo la version activa anterior y nunca
reescribe historicos. Un segundo `up` reutiliza la version marcada; `down`
reactiva la predecesora y deja catalogo/version nueva inactivos, sin borrar
plantillas ni filas que puedan estar referenciadas por ejecuciones.

## Marketing Web: control plane, editor y compilador W0-W2 (2026-07-18)

**Corte posterior vigente:** backend `c9fe9dc`/`68360ed`, promovido a staging
mediante `4bbc299`, eleva el compilador a
`clinicaclick-web-renderer/1.5.0` y hace durable `drift_detected`.
Frontend `a2580f4d`, promovido mediante `dccaa992`, incorpora la galería
semántica; el runtime staging usa `main.5d23dcd3057ad1f6.js` y su `index.html`
tiene SHA-256
`4451d0ba00320451acb788b48ed939d4de30e649fa259e2d383caf3e441cca6c`.
Chromium a `1440` y `390` confirmó bloque/sección Galería sin errores. La tanda
feature posterior añade autoría Página/Cabecera/Pie (`5ed9f5fd`, 92/92 antes
de la unión), archivo/restauración y gestión de plantillas
(`/marketing/web/plantillas`, frontend `f7e50367`; ownership backend
`d5ce548`); todavía requiere promoción/QA. En aquel corte el artefacto público
WordPress no se actualizó; el cierre posterior acreditó multi-route y recompiló
la revisión piloto de `/cita/` a renderer `1.5.0`. Hosted/custom permanecen
cerrados.

La migración aditiva
`20260718225000-add-campaign-destination-drift-event.js` valida tabla/columna y
ENUM, añade `drift_detected` de forma idempotente, falla cerrada ante un schema
incompatible y rehúsa `down` si existen eventos. Su suite pasa 3/3. La
auditoría diaria `campaign_destination_drift_audit` usa el orquestador común
(`5 3 * * *`), no autorepara ni muta campañas. La suite canónica de Campañas
recorre 34 contratos y pasa 46/46.

**Corte integrado base (histórico):** backend `dev` llega a `4e4b555` y staging a
`5e57431`; `pm2-back-staging` ya ejecuta ese último corte y el smoke público de
autenticación devuelve el `401` esperado sin errores de arranque. El corte
funcional frontend llega a `305d4eae` en `dev` y `5f8f8858` en staging; los
commits documentales posteriores no cambian el runtime. Su artefacto de
producción limpio se construyó con hash `5a08e6a108414a76` y quedó desplegado
atómicamente: index/source SHA-256
`c54b4f254b803a1cd7419660f76be4cb8e0cb5df2912f014e709b9d0822bafc7`, 481/481
ficheros y assets principales/readback en `200`. Incluye hardening del handoff WordPress,
rollout por scope, canonicalización segura `apex/www`, persistencia/recuperación
del artefacto preparado, CSP del artefacto público, disponibilidad efectiva por
canal y previews de plantilla verificadas. Las migraciones
`19000..25000` están aplicadas tras backup y crearon 17 tablas/cinco plantillas
sin crear policies o bindings reales. La suite local vigente del código integrado
pasó **223/223** contratos Node, **26/26** contratos PHP/WordPress y **3/3**
pruebas de interoperabilidad. El frontend Marketing Web local pasó
**153/153** y el build staging de producción terminó verde con hash
`5a08e6a108414a76`. Chromium final de solo lectura cubrió onboarding, editor,
CTA, Medios, SEO/Social/Schema, revisiones y CMS en `1440`/`360`: 13 capturas,
cero errores, mutaciones Marketing Web u overflow. El fix `305d4eae` conserva
la identidad referencial de las opciones CTA por documento/página/nodo y usa
`trackByOptionId`, cerrando el bucle de CPU/`TargetClose` reproducido por
Chromium. Backend, frontend y plugin WordPress están desplegados;
Nginx quedó activo y el smoke público de auth devuelve el `401` esperado. Las
integraciones MySQL destructivas se omiten de forma
explícita cuando `WEB_EDITOR_TEST_MYSQL_URL` no está definido. Esta integración
no autoriza una campaña.

Esos totales pertenecen al baseline promovido. El corte `alpha.8` del 2026-07-19 sí
volvió a ejecutar el runner canónico completo: Marketing Web **320/320**,
WordPress **40/40**, interoperabilidad **3/3** y Campañas 34 contratos/46
pruebas. El frontend integrado pasa 168/168 focales y 252/252 de Marketing,
además de TypeScript, i18n y build de producción. Esos resultados quedaron
promovidos; los hashes y la evidencia live vigentes están en el corte de
apertura de este documento.

El runner canónico neutraliza explícitamente
`MARKETING_WEB_ENABLED_SCOPES`, `MARKETING_WEB_DISABLED_SCOPES` y
`MARKETING_WEB_PUBLISHING_SCOPES` para sus fixtures. Así la allowlist real de
staging no altera la suite y los contratos prueban su propio scope de forma
hermética; no se relaja ningún gate del proceso desplegado.

W0 establece la frontera de seguridad y despliegue. El editor y la publicación
son gates distintos y ambos nacen apagados:
`MARKETING_WEB_EDITOR_ENABLED=false` y
`MARKETING_WEB_PUBLISHING_ENABLED=false`. El segundo nunca evita el primero.
`MARKETING_WEB_ENABLED_SCOPES=clinic:66,group:4` permite acotar el editor;
`MARKETING_WEB_PUBLISHING_SCOPES=group:4` restringe de forma independiente qué
scopes pueden mutar publicaciones aunque el editor esté permitido. Ausente o
vacío conserva el comportamiento global del gate correspondiente; con valores
solo esos scopes pasan. Las listas son explícitas, no consultan la base de
datos ni infieren herencia.
`MARKETING_WEB_DISABLED_SCOPES=clinic:66,group:4` actúa como kill switch y
siempre tiene precedencia. Ambas listas fallan cerrado ante sintaxis inválida.
El parser de rutas editoriales admite como máximo 1 MiB de JSON, el
`WebDocument` canónico como máximo 512 KiB, y las escrituras tienen rate limits
por actor. Las rutas públicas del plugin tienen límites distribuidos por
instalación/IP con Redis y degradación local explícita; no comparten el JWT de
la UI.

La matriz se aplica en backend, no es solo metadata de frontend:

- `marketing.web.view`: propietario, agencia, assistant, reception y
  admin_staff;
- `marketing.web.edit`: propietario, agencia, reception y admin_staff;
- `marketing.web.advanced_edit`: preparado para propietario, agencia y
  admin_staff, pero aún sin superficie avanzada publicada;
- `marketing.web.review`: propietario, agencia y admin_staff;
- `marketing.web.publish` y `marketing.web.domains.manage`: propietario y
  admin_staff;
- `marketing.web.templates.manage`: todos los roles de clínica quedan
  denegados por defecto; solo lo obtiene un administrador global o una
  delegación explícita y auditable en `AccessPolicyOverride`.

W1 persiste el editor como datos tipados en `WebProjects`, `WebPages`,
`WebDrafts`, `WebRevisions`, `WebTemplates` y `WebAuditEvents`. No se guarda
HTML/CSS arbitrario. `WebDocument v1` usa un JSON Schema cerrado, IDs UUID,
límites de profundidad/nodos/páginas/bindings y canonicalización Unicode
determinista. Rechaza propiedades de código/estilo, markup ejecutable, objetos
no JSON, getters, ciclos y claves peligrosas. El borrador se guarda mediante
CAS (`lock_version`); crear, enviar y aprobar revisiones adquiere locks en orden
`WebProject -> WebRevision`. Las revisiones aprobadas son inmutables. Las
plantillas builtin se siembran versionadas y las instancias regeneran todos los
IDs estructurales para no compartir referencias entre proyectos.

`PATCH /api/marketing/web-projects/:projectId` exige `version` y solo admite
que el usuario lleve el proyecto a `draft` o `archived`; `active` pertenece al
flujo de publicación. El cambio bloquea la fila, aplica CAS, incrementa versión
y audita `web.project.updated`. La UI interpreta restaurar como
`archived -> draft`: nunca activa una publicación ni reutiliza un deployment.
Mientras el proyecto está archivado, editor/publicación permanecen en lectura.

El catálogo autenticado admite
`GET /api/marketing/web-templates?include_preview=true`. El servicio pagina y
aplica ACL/scope antes de cargar documentos, por lo que solo consulta los IDs
ya visibles de esa página. Cada `preview_document` se valida como
`WebDocument v1`, se canonicaliza y se contrasta con su hash almacenado; un
documento corrupto o cuyo hash no coincide falla cerrado con `503` y nunca se
envía al navegador. Sin el flag no se carga ni proyecta el documento. La
muestra paginada se calcula en base de datos, deduplicando por
`catalog_key/version` según prioridad del scope; proyecta `source_scope`,
`source_scope_id`, `managed_by_scope`, `is_public`, `status`, `created_at` y
`updated_at`. Solo `managed_by_scope=true` autoriza edición/archivo; una
plantilla global o heredada permanece visible en lectura y el frontend no
puede convertir su badge en autorización. La ruta visual correspondiente es
`/marketing/web/plantillas`; no existe una publicación independiente en esa
URL.

La
migración idempotente
`20260718103000-normalize-web-qualification-template-category.js` normaliza la
categoría builtin histórica `form` a `qualification`; el selector frontend no
debe reintroducir aliases ni elegir una primera plantilla arbitraria.

La creación desde campaña repite esa política en la API y falla cerrado. El
backend vuelve a validar el `campaign_context`, que la plantilla solicitada
existe, es visible para el scope efectivo y es compatible con propósito,
target/categoría y tratamiento cuando corresponda. El filtro o el estado del
diálogo nunca autorizan por sí solos la creación; una combinación obsoleta,
cruzada entre tenants o incompatible no crea proyecto ni vínculo parcial.
`strategy_id` identifica exclusivamente `Campaign.id`; un
`CampaignRequest.id` no se acepta como alias porque el consumidor de destinos
también resuelve la estrategia por la campaña canónica.

Errores observables de ese preflight transaccional:

- `422 campaign_template_required|campaign_template_incompatible` para ausencia
  o categoría/propósito de plantilla no compatible;
- `503 campaign_context_validation_unavailable` si no puede validarse de forma
  autoritativa; no degrada a confianza en el cliente;
- `404 campaign_strategy_not_found` cuando desapareció la estrategia;
- `409 campaign_strategy_scope_mismatch`,
  `campaign_strategy_campaign_invalid`,
  `campaign_strategy_campaign_not_found` o
  `campaign_strategy_campaign_scope_mismatch` para ownership/campaña canónica;
- `422 campaign_target_incompatible` y `409 campaign_treatment_unavailable`
  para target/tratamiento incoherente, inactivo o fuera de scope.

W2 compila una revisión aprobada a un `WebArtifact` determinista e inmutable.
La clave de identidad cubre revisión, renderer, entorno, URL base y runtime
confiable; manifest, ficheros, hashes y QA se persisten juntos. El compilador
escapa texto, genera HTML semántico, CSS, sitemap/robots, JSON-LD y formularios
nativos. Producción obliga a `/_clinicaclick/intake` y emite el relay
`/_clinicaclick/events`; ambos son same-origin. La clínica y el
`content_snapshot` quedan congelados antes de compilar, por lo que una
publicación no consulta contenido vivo a mitad de despliegue. Ed25519 firma el
manifest y tanto WordPress como el origen alojado verifican hash, tamaño,
allowlist y firma antes de activar. `status` es el único campo mutable de un
artefacto; las actualizaciones masivas están sujetas al mismo hook.

Desde `clinicaclick-web-renderer/1.3.0`, `document.globals.header_node_id` y
`document.globals.footer_node_id` dejan de ser una ayuda exclusiva del editor:
el compilador los inserta en **cada** página como `<header>` y `<footer>`
semánticos, marcados con `data-cc-global`, y los incluye en el cálculo de
alcanzabilidad SEO. No se duplican como nodos locales ni se recompilan desde
contenido vivo. La previsualización Angular y el artefacto público consumen la
misma referencia global congelada.

`clinicaclick-web-renderer/1.4.0` es un incremento posterior y compatible que
no reemplaza ni reescribe la historia de globales de `1.3.0`. El corte
`4345683`, posteriormente promovido a staging, amplió
el JSON Schema cerrado de siete a nueve tipos con dos hojas de estructura:

- `divider` exige `children=[]`, no admite bindings y limita sus propiedades a
  `line_style=solid|dashed|dotted` y `tone=muted|brand|accent`. Se compila como
  `<hr>` semántico y sus variantes solo seleccionan clases CSS allowlisted;
- `spacer` exige `children=[]`, no admite bindings y limita `size` a
  `xs|sm|md|lg|xl|2xl`. Se compila como un elemento sin contenido,
  `aria-hidden=true` y `role=presentation`, con altura determinada por tokens.

El contrato rechaza propiedades adicionales, hijos, bindings o valores fuera
de esos enums. La identidad del artefacto sigue incluyendo la versión del
renderer, por lo que compilar la misma revisión con `1.4.0` genera un corte
explícito, determinista y auditable; nunca modifica un artefacto `1.2.1` o
`1.3.0` ya congelado.

`clinicaclick-web-renderer/1.5.0` añade `gallery` como décimo tipo cerrado. Es
una hoja sin hijos ni bindings con entre 2 y 12 items y assets únicos. Limita
columnas a `2|3|4`, `fit` a `cover|contain`, proporción a
`1:1|4:3|3:2|16:9` y exige por item un asset válido, foco X/Y acotado y texto
alternativo o marca decorativa; el pie es opcional. `webResourceResolver`
congela el recurso por la ruta exacta del item. El compilador genera
`figure/img/figcaption`, dimensiones y lazy loading, usa las columnas
configuradas en escritorio, dos en tablet y una en móvil. No admite HTML/CSS,
clases ni placeholders aportados por el usuario.

`clinicaclick-web-renderer/1.6.0` fue la candidata posterior de este corte. Ya
está live y verificada con los identificadores y hashes completos del corte
vigente al inicio del documento. Hace
coherentes formulario, Social y Schema sin reescribir revisiones congeladas:

- un selector `preferred_contact` solo ofrece email cuando el mismo formulario
  incluye el campo `email`; las plantillas integradas que ofrecen esa opción ya
  incorporan el campo;
- la imagen Social explícita de la página o del proyecto alimenta Open Graph,
  Twitter y `image` de `Dentist`/`MedicalClinic`, con texto alternativo. Si no
  existe, puede usar como fallback la imagen pública HTTPS de la clínica;
- una imagen de clínica relativa, privada o no segura se omite porque es un
  fallback opcional. `website` y `booking_url` continúan fallando cerrado si no
  son URLs públicas HTTPS;
- cada página añade `og:site_name`, tarjetas Twitter y un favicon SVG `data:`
  determinista derivado del nombre. La CSP abre `data:` solo para imágenes y
  mantiene scripts, conexiones, formularios y demás recursos en sus allowlists.

La versión del renderer sigue formando parte del hash de entrada y del
artefacto. El paso de 1.5 a 1.6 exigió revisión nueva/aprobada, preview,
publicación controlada, readback público y rollback acreditado; nunca modificó
en sitio el artefacto 1.5 histórico.

El compilador resuelve además una única canonical efectiva por página. Esa URL
alimenta `<link rel="canonical">`, `og:url` y las URL/`@id` de `WebPage` y
`FAQPage`. `sitemap.xml` solo incorpora canónicas indexables cuyo origen
coincida con el de publicación; una canonical externa se conserva en HTML y se
excluye del sitemap del host. El test de compilador cubre expresamente esta
coherencia.

El formulario global también se materializa por ruta. El manifest no lo trata
como un único formulario sin contexto, sino como un contrato `scope=global`
con `page_contracts[page_id]`. Cada contrato conserva los campos y la identidad
canónica de la página desde la que se envía. El relay y la atribución resuelven
el contrato de esa página antes de aceptar el intake; una ruta firmada sin su
contrato global, una página ajena o campos distintos fallan cerrado. Esto
permite reutilizar visualmente el mismo formulario en todas las páginas sin
perder `WebPage`, publicación, revisión o atribución.

El rollout operativo es deliberado:

1. aplicar las migraciones W1-W5 en un MySQL 8 aislado y repetir
   `up -> up -> down -> down -> up` antes de cada primera implantación;
2. configurar gates, claves Ed25519, bootstrap AES, almacenamiento y secretos
   de intake fuera de Git;
3. habilitar editor en un scope de prueba, compilar preview y revisar QA;
4. instalar el plugin u origen Nginx, comprobar handshake y lectura firmada;
5. habilitar publicación solo en ese scope, publicar un disposable, probar
   formulario + eventos y ejecutar rollback;
6. ampliar scopes gradualmente. Desactivar publicación bloquea nuevas
   mutaciones, pero no borra artefactos ni rompe la página activa.

Estado de staging del piloto: editor/publicación globales activos, editor
allowlisted para `group:5` y clínicas `19/35/36/56/57/58/59`, y publicación
solo para `group:5`. Hospitalet acredita handshake, publicación, E2E público,
limpieza, rollback y monitor saludable. No ampliar esa lista hasta cerrar
multi-route y los gates operativos indicados en W5/W6.

La suite canónica es `npm test`: encadena los contratos Web y los contratos de
campañas, además de los 26 contratos PHP, compatibilidad Ed25519 Node/PHP,
compilador real y ZIP provisionado. Si `WEB_EDITOR_TEST_MYSQL_URL` está
definida también ejecuta las
integraciones destructivas sobre esa base **aislada**; nunca se apunta a dev,
staging ni producción.

## Marketing Web: CMS y biblioteca de medios W3 (2026-07-17)

El CMS Web persiste intención editorial tipada, nunca HTML, CSS, scripts,
iframes ni payloads libres. `WebContentEntries` mantiene la versión actual con
CAS; `WebContentEntryVersions` conserva una fila inmutable por versión. Los
tipos admitidos son `value_proposition`, `benefit`, `faq`, `treatment_copy`,
`professional_bio`, `testimonial`, `legal_copy`, `article` y `category`, cada
uno con un contrato JSON cerrado. Estados: `draft -> review -> published` y
`archived`; editar una entrada publicada crea una nueva versión en `review`.
Publicar o archivar exige `marketing.web.review`; leer y editar usan
`marketing.web.view|edit` dentro del scope explícito.

Desde el corte del 2026-07-20, `WebContentEntries` y
`WebContentEntryVersions` incluyen `schema_config` versionado. El valor por
defecto es `{ enabled: true, profile: 'auto', include_sources: false }`. Los
perfiles son cerrados y se validan por tipo de contenido: `faq` solo admite
`auto|FAQPage|WebPage`, `article` `auto|Article|WebPage`,
`professional_bio` `auto|Person|WebPage`, `testimonial`
`auto|Review|CreativeWork`, `treatment_copy` `auto|MedicalWebPage|WebPage`,
`category` `auto|CollectionPage|WebPage`, y los textos generales/legales solo
sus variantes seguras `WebPage|CreativeWork`. Desactivar schema normaliza el
perfil a `auto` y `include_sources=false`. El campo participa en el hash de
contenido y en cada versión, por lo que cambiarlo es un cambio editorial
auditable; no existe JSON-LD libre en API, frontend ni generación asistida.

La API proyecta autorización efectiva, no obliga al frontend a inferirla:
`capabilities.can_create`, `can_edit_own` y `can_review` describen al actor, y
cada fila devuelve `can_edit` y `read_only`. El autor puede modificar su propio
recurso cuando mantiene `marketing.web.edit`; otro actor solo puede hacerlo si
posee `marketing.web.review`. Los recursos heredados de grupo son siempre
`read_only` en un scope de clínica. Estas comprobaciones se repiten en cada
mutación backend: ocultar un botón no constituye control de acceso.

El flujo editorial expuesto es literal: un borrador se edita con CAS, **Enviar
a revisión** lo mueve de `draft` a `review`, y solo un revisor puede pasarlo a
`published`. Editar una entrada publicada no altera la versión visible: crea
la siguiente versión en `review`.
`GET /api/marketing/web-content/:contentId/versions` conserva el historial
inmutable y se puede consultar incluso cuando la entrada efectiva sea heredada
o de solo lectura.

Los contratos tipados exponen campos editoriales semánticos —entre otros
`headline`, `summary`, `question`, `answer`, `display_name`, `role`,
`biography`, `quote`, `attribution`, `text`, `version_label` y `excerpt`—. Los
bindings apuntan al campo de negocio exacto, nunca al título interno de la
entrada CMS. En particular, un bloque FAQ enlaza `question -> question` y
`answer -> answer`; el snapshot y el renderer solo generan `FAQPage` cuando
ambos valores están completos y visibles.

La biblioteca `WebMediaAssets` no guarda binarios ni credenciales. Envuelve un
`PublicMediaAsset` marcado como no clínico; la
API solo devuelve URL pública, MIME, tamaño, variantes saneadas, alt, foco,
derechos y metadatos técnicos mínimos. Nunca proyecta bucket, región, object
key, ETag, provider, HMAC ni metadata cruda. La subida sigue siendo
`POST /api/public-media/upload` en JSON/base64 con
`purpose=web_editor_media`; ese purpose exige que el feature flag esté activo,
`marketing.web.edit`, un máximo de 30 subidas por actor/hora y las cuotas por
scope configuradas en `MARKETING_WEB_MEDIA_MAX_ASSETS_PER_SCOPE` y
`MARKETING_WEB_MEDIA_MAX_BYTES_PER_SCOPE`. Genera una key opaca bajo
`marketing/web-editor`, pero la respuesta no devuelve URL ni object key.

La subida se decodifica y recodifica a WebP con Sharp antes de almacenarla. Ese
desarme de contenido elimina EXIF, GPS, XMP y bytes anexos. **No existe todavía
un antivirus externo**: se registra honestamente `malware_scan_status=not_available`
y el contrato queda fail-closed a imágenes raster que Sharp pueda decodificar;
vídeo, SVG y binarios generales no están soportados en W3. El activo queda con
`status=quarantine`, `sensitivity=internal` y caducidad. Después se registra el
`asset.id` en el CMS; creación de wrapper y activación del activo ocurren en la
misma transacción. Si falla la fila inicial se elimina el objeto opaco. La
función interna `cleanupExpiredQuarantinedMedia` reclama cada cuarentena
caducada bajo lock con estado `cleanup_pending` y lease antes de tocar S3. El
registro concurrente queda así bloqueado: o activa primero el medio y el
cleanup lo omite, o encuentra el claim y lo rechaza. El borrado S3 es
idempotente; un fallo devuelve el activo a cuarentena y una caída después del
borrado deja el claim recuperable al vencer el lease. Solo admite keys con
prefijo `marketing/web-editor/(clinic|group)-<id>/`. `system_data_cleanup` la
invoca desde el orquestador común de `JobRequest`; no existe un cron paralelo.

El POST W3 no acepta multipart ni binario.

APIs autenticadas y paginadas:

- `GET/POST /api/marketing/web-content`;
- `PATCH /api/marketing/web-content/:contentId` con `version` obligatorio;
- `GET /api/marketing/web-content/:contentId/versions`;
- `GET/POST /api/marketing/web-media`;
- `PATCH /api/marketing/web-media/:mediaId` con `version` obligatorio.

La lectura de medios añade el filtro estricto `ids`/`ids[]`: solo acepta UUID
v4, deduplica y limita el lote a 100. El editor lo usa para hidratar en una
petición las imágenes referenciadas por nodos y por los assets sociales/globales
de página; no convierte una URL del documento en autoridad ni expone metadata
de almacenamiento.

En una galería `1.5.0`, cada item conserva su `asset_id` y metadata editorial
propia. La aprobación resuelve/congela el asset por la ruta exacta del item;
reordenar o reemplazar no permite que otra posición herede silenciosamente el
recurso. La selección UI puede paginar, pero la snapshot final exige entre 2 y
12 recursos reales, únicos y autorizados.

Scope se declara como `scope_type=clinic|group` y `scope_id`. Las listas usan
`page`, `limit` (máximo 100), `status`, `search` y filtros de tipo/locale/kind.
Una clínica solo ve activos del grupo cuando pide explícitamente
`include_inherited_group=true`; cada resultado heredado devuelve
`scope.inherited=true` y `read_only=true`. Un grupo nunca puede leer recursos
de una clínica concreta. Contenido y medios solo los modifica su autor; un
usuario distinto necesita `marketing.web.review`. Los endpoints por UUID
devuelven 404 uniforme si el scope no es accesible. Las escrituras de contenido
están limitadas a 120 por actor/10 minutos y las de medios a 60 por actor/hora,
además del parser JSON W0 de 1 MiB. Errores, conflictos CAS y rate limit conservan el contrato
`error.code`, `error.message`, `details` y `request_id`.

Al aprobar una `WebRevision`, el backend adquiere locks siempre en orden
`WebProject -> WebRevision`, resuelve los UUID externos y congela un
`content_snapshot` tipado e inmutable. Medios deben estar `ready`, sus derechos
no pueden haber caducado y el `PublicMediaAsset` debe seguir autorizado;
contenido debe estar `published` y exponer el campo solicitado. Una referencia
UUID grupal elegida por un proyecto de clínica cuenta como herencia explícita.
Los bindings vivos de clínica se congelan como descriptores
`clinic_public_v1` con un allowlist de campos públicos; un proyecto de grupo
siempre requiere clínica explícita. Los resolvers tipados ya implementados son:

- `treatment`: `name`, `title`, `description`, `short_description` y
  `price_from`;
- `professional`: `name`, `title` y `alt_text`;
- `intake_config`: solo identidad y procedencia (`id`, `scope`, `inherited`).
  Nunca congela configuración privada, secretos, HMAC ni credenciales.

Cada resolver comprueba scope y existencia antes de congelar; no improvisa
campos fuera de su allowlist. Si queda alguna referencia, la aprobación responde 422
`web_revision_not_ready` con las rutas no resueltas y no cambia estado. La
snapshot solo contiene campos publicables y rechaza nombres sensibles como
`token`, `secret`, `hmac_key`, `bucket` u `object_key`. Las URLs de fuentes no
admiten query ni fragmento, y la snapshot omite referencias internas de
licencias o consentimiento.

## Marketing Web: asistente de borradores IA (2026-07-19)

El asistente forma parte del CMS W3 y **solo prepara borradores**. No puede
publicar, aprobar revisiones, cambiar campañas ni elegir experimentos. La
acción nace de un clic explícito en `Marketing > Web > Contenidos`, se ejecuta
server-side y, tras enseñar el resultado, requiere otro clic independiente
para convertirlo en una `WebContentEntry` con estado `draft`. Aceptar no llama
de nuevo al proveedor y tampoco consume la cuota de generación.

La API autenticada es:

- `GET /api/marketing/web-content/generations/configuration`: catálogo cerrado
  y disponibilidad del proveedor;
- `POST /api/marketing/web-content/generations`: crea la fila y el
  `JobRequest` durable; exige `Idempotency-Key`;
- `GET /api/marketing/web-content/generations/:generationId`: consulta el
  progreso o terminal;
- `POST /api/marketing/web-content/generations/:generationId/accept`: crea una
  sola entrada CMS en borrador de forma transaccional e idempotente.

Generar exige `marketing.web.edit`; consultar exige `marketing.web.view` y
aceptar vuelve a exigir edición más ownership/revisión editorial. Una
denegación de scope se proyecta como `404`, de modo que un UUID no sirve para
enumerar datos de otra clínica o grupo. El contexto no admite texto libre:
solo un tema general allowlisted o el ID de un tratamiento del catálogo. La
resolución de tratamientos falla cerrada usando `Tratamientos.origen`:

- `clinica` exige la clínica exacta y ninguna columna de grupo;
- `grupo` exige el grupo efectivo y ninguna clínica concreta;
- `sistema` exige ambas columnas tenant vacías;
- orígenes desconocidos, propiedad mixta, tratamiento inactivo o una clínica
  hermana devuelven `404 generation_context_not_found`.

Los tipos generables son `value_proposition`, `benefit`, `faq`,
`treatment_copy`, `article` y `category`. Biografías profesionales,
testimonios y texto legal permanecen manuales porque requieren identidad,
evidencia o revisión especializada. Objetivo, tono, locale y tema proceden de
enums cerrados. El snapshot enviado contiene únicamente perfil público
estructurado de clínica/grupo y el contexto seleccionado; no acepta historias,
mensajes, citas, leads ni campos de pacientes.

El proveedor es OpenAI Responses API desde backend:

- modelo configurable con `OPENAI_WEB_CONTENT_MODEL`, por defecto `gpt-5.6`;
- `store:false`, sin herramientas ni búsqueda web;
- reglas de desarrollador separadas del JSON de contexto no confiable;
- Structured Outputs con JSON Schema estricto por tipo de contenido;
- texto plano, sin HTML, Markdown o enlaces;
- timeout acotado por `OPENAI_WEB_CONTENT_TIMEOUT_MS` —90 segundos por
  defecto—;
- `OPENAI_API_KEY`, `OPENAI_PROJECT_ID` y `OPENAI_ORGANIZATION_ID` viven solo
  en secretos de servidor y nunca se copian a filas, jobs, frontend o logs.

Antes de persistir la petición se verifica que la credencial existe. El output
vuelve a pasar por el validador canónico de `WebContentEntry`; un JSON válido
para OpenAI no basta si incumple el contrato Clinicaclick. La propuesta puede
incluir `schema_config`, pero se valida con el mismo contrato cerrado antes de
aceptarse como borrador CMS; no puede publicar ni saltarse revisión. La procedencia
audita proveedor, modelo efectivo, `response_id`, fecha, tokens,
`application_state_store=false`, Structured Outputs y fuentes estructuradas.
`estimated_cost_micros` y moneda quedan `null` hasta disponer de una tarifa
versionada; no se inventa coste a partir de precios cambiantes.

La idempotencia se conserva en base de datos. Se guarda el hash de una clave
compuesta por actor, scope y `Idempotency-Key`, además del hash canónico del
payload. Repetir la misma clave y payload relee el mismo intento; reutilizarla
con otro payload devuelve `409 idempotency_payload_mismatch`. La aceptación
bloquea la generación, crea contenido y guarda `accepted_content_entry_id` en
una transacción; un replay devuelve esa misma entrada.

`web_content_generation` es un tipo dirigido del orquestador común
`JobRequest`, prioridad baja y máximo de dos reclamaciones de job. Esto **no
significa dos llamadas al proveedor**. La fila pasa
`queued -> running -> completed|failed -> accepted` y
`execution_attempt_token_hash` actúa como fence one-shot. Desde el momento en
que una reclamación marca `running`, un timeout, pérdida de conexión, `429`,
`5xx`, respuesta incompleta o caída del worker puede ocultar un POST ya
aceptado por el proveedor. Por ello el intento termina
`web_content_ai_result_unconfirmed` y nunca se redispara automáticamente. Un
`running` vencido se cierra del mismo modo sin llamar a OpenAI. Solo una nueva
acción consciente del usuario crea otra clave y otro intento. Los settlements
usan CAS; si se pierde el ACK de MySQL después de guardar un terminal, el
worker relee la fila y conserva el ganador.

Hay dos capas de capacidad para generación: rate limit HTTP de 12 por
actor/hora y contadores MySQL transaccionales con locks en orden fijo, 12 por
usuario+scope/hora y 300 globales/hora por defecto. Se configuran con
`WEB_CONTENT_GENERATION_HOURLY_USER_SCOPE_LIMIT` y
`WEB_CONTENT_GENERATION_HOURLY_GLOBAL_LIMIT`. La aceptación tiene un rate
limit separado de 60/h y no incrementa esos buckets. Los buckets caducan y los
retira `system_data_cleanup`; no existe timer lateral. Las generaciones
terminales no aceptadas se retienen 180 días por defecto
(`WEB_CONTENT_GENERATION_RETENTION_DAYS`, rango 30–365). Una generación
aceptada conserva la relación de auditoría con el contenido CMS.

Persistencia aditiva:

- `WebContentGenerations`: scope XOR, input/idempotencia, estado, propuesta,
  procedencia, error público, job y contenido aceptado;
- `WebContentGenerationQuotaBuckets`: contador global o usuario+scope por hora;
- migración `20260719113000-create-web-content-generations.js`, con checks,
  FKs e índices únicos para idempotencia, job y contenido aceptado.

La migración pasó en MySQL aislado `up`, segundo `up` idempotente,
introspección de columnas/checks/índices/seis FKs y `down`, y ya está aplicada
en staging. Las regresiones viven en
`web_content_generation.test.js` y
`web_content_generation_migration.test.js`, incluidas concurrencia de cuota,
scope cruzado, prompt injection, PII, one-shot, CAS, aceptación y limpieza.

## Marketing Web: publicación WordPress y puente de campañas W4/W5 (2026-07-18)

Estado público histórico del 2026-07-18: `clinicaclick-web`
`2.0.0-alpha.7` quedó instalado y activo en Propdental. El legado
`clinicaclick` `1.1.7` sigue activo; v2 evita
su loader global duplicado sin desactivarlo y tanto la home como la landing
conservan un único loader. `ccw_sync_event` está programado cada 15 minutos y,
si se ejecuta manualmente, debe correr como el usuario del sitio para no crear
caché propiedad de `root`.

Estado histórico de ese corte: Propdental y la fila de control reportaban
`clinicaclick-web 2.0.0-alpha.8`; el estado live posterior es `alpha.9` y está
descrito al principio de este documento.
El baseline histórico `alpha.7` consume el manifest de formularios globales por página
emitido por renderer `1.3.0` y valida que todo
formulario global cubra las rutas/páginas firmadas que lo usan y que sus campos
coincidan entre contratos; no relaja firma, hash, scope, host, ruta ni
allowlists. El rollout se realizó con paquete provisionado, activación como
usuario del sitio, PHP lint y sincronización; la DB y WP-CLI reportan ya la
misma versión.

El primer `activation_handshake` normalizó de forma auditable el alta inicial
`https://propdental.es` a la URL canónica declarada por WordPress
`https://www.propdental.es`. Esa excepción solo se permite cuando la
instalación sigue realmente virgen (`pending`, sin `last_seen`, versión ni
publicaciones); después se exige coincidencia estricta. La instalación
`524c2f73-6b69-42f2-8cb0-c8d171575d94` está `connected` y reporta
`plugin_version=2.0.0-alpha.8`. El runbook histórico conservó un rollback real
de `alpha.6` con `config/installation.php` y un ZIP provisionado `alpha.7`
root-only; después de schema 2 el rollback operativo mantiene `alpha.8` + LKG.
El paquete genérico de transporte no se usa como instalación gestionada.
Después de que un paquete genérico
sobrescribiera temporalmente la configuración en una recuperación histórica se
rotó el token, se reprovisionó y se verificó de nuevo el handshake sin
conservar el token anterior.

El piloto público queda identificado y reproducible así:

- proyecto `edd77d09-6ac5-4944-98e3-084d5285594c`, revisión aprobada activa
  `ead78c6d-f28f-478d-9058-bc189c846421` y clínica `59`;
- publicación `5d55b1ef-c6fa-4e73-8aa8-2fd9ff41a526` en `/cita/`;
- renderer activo `clinicaclick-web-renderer/1.5.0` y revisión 2
  `ead78c6d-f28f-478d-9058-bc189c846421`;
- hash del artefacto activo `d875201…`, body SHA `e851688…`, con `document_hash`
  `ba60…` y `content_snapshot_hash` `5f447…`; la recompilación conservó
  contenido, SEO y Schema;
- `https://www.propdental.es/cita/` responde `200`, sirve el título
  `Dentista en Hospitalet | Propdental`, marker de artefacto y formulario
  nativo firmado; contiene exactamente un `/assets/loader.js` y no expone
  HMAC, token de instalación ni clave privada.

No se cambió URL, goal, puja, presupuesto o estado de ninguna campaña para
obtener esta evidencia. La publicación sigue acotada a `group:5`.

Una landing de campaña puede congelar en `WebProjects.campaign_context` el
vínculo opcional `{strategy_id, target_kind, treatment_id}`. El objeto solo se
admite en proyectos `purpose=landing`, tiene contrato cerrado y es inmutable
después de crear el proyecto. La publicación copia ese contexto desde el
proyecto; nunca confía en un valor recibido en el body. Cuando un deployment
queda verificado y su puntero activo se confirma, la misma transacción inserta
el `JobRequest` idempotente `marketing_web.landing_published.v1`, con id estable
`webpub:<publication_id>:<artifact_id>`. De este modo el consumidor de campañas
recibe URL pública canónica, scope, estrategia, target y hash sin una ventana
entre publicación y outbox.

El schema integrado se instala en orden: `19000` (proyectos/editor), `20000`
(contenido/media), `21000` (modo Mejora), `21100` (unicidad de policy por
estrategia), `21500` (plantillas builtin), `22000` (artefactos), `23000`
(dominios/publicaciones/deployments), `24000` (atribución de intake), `24500`
(contexto de campaña), `25000` (bindings, cuentas y eventos de destino) y
`20260718225000` (valor `drift_detected` en el ENUM de eventos),
`20260718230000` (multi-publicación WordPress), `20260718233000` (token staged),
`20260719090000` (reconciliación de runtime de intake), `20260719091500`
(cifrado reanudable de secretos legacy) y `20260719093000` (lookup dirigido
deployment/artefacto), seguido de `20260719094500` (marcador durable de
idempotencia para recuperación administrativa) y `20260719100000` (claim
único y demostrable del sitio WordPress). Estas siete migraciones posteriores
a `20260718225000` están aplicadas en staging. Los
`up` validan el contrato completo de cualquier tabla
preexistente y fallan cerrado ante drift; solo pueden reparar la variante
legacy exacta de `ON UPDATE CASCADE` en las FKs de scope cuando destino,
columna referenciada, `ON DELETE` y datos permiten la sustitución segura. Los
`down` se ejecutan en orden inverso y son repetibles.

La migración `20260718225000` es aditiva e idempotente: falla cerrada si falta
la tabla/columna o el ENUM no tiene el contrato esperado; no reconstruye una
tabla desconocida y su `down` rechaza eliminar el valor mientras haya filas
`drift_detected`. La migración destructiva
`20260715152000-purge-google-places-competition-content.js` está cancelada y
sus `up`/`down` son no-op; no pertenece a este rollout ni queda pendiente.

`WebPublicationDeployments` es un log append-only con secuencia monotónica. La
petición crea deployment + `JobRequest` en una transacción; el worker bloquea
deployment y publicación, verifica versión esperada y pasa por
`queued -> running -> verified|failed|superseded`. Solo campos operativos de
estado/resultado pueden cambiar, también en bulk. Activar un artefacto cambia
el puntero de publicación únicamente después del readback público. Rollback no
recompila contenido vivo: exige un artefacto de producción previamente
`verified`, lo vuelve a verificar y crea otra secuencia auditable.

El hardening del piloto impide inyectar un `artifact_id` arbitrario: solo el
worker que posee el deployment `running` y bloqueado puede persistir el
artefacto preparado; escrituras bulk, queued o terminales fallan cerradas.
Si rota el HMAC/runtime entre preparación y entrega, el publisher invalida el
descriptor de almacenamiento anterior, regenera manifest/ficheros y exige
provider, hash, HTTPS same-origin y conjunto exacto de ficheros antes de
continuar.

Los dominios propios separan ownership, routing y TLS. El job durable
`marketing_web_domain_reconciliation` corre por defecto a los minutos
`7,22,37,52`; revalida pendientes y reduce las comprobaciones de dominios
estables a una vez al día. El proveedor Cloudflare se usa solo server-side y
el modo manual conserva DNS/TLS explícitos. Ninguna publicación custom-domain
se activa hasta que ownership, ruta y certificado estén listos en la misma
reconciliación.

Los artefactos WordPress admiten dos proveedores mediante
`MARKETING_WEB_ARTIFACT_STORE_MODE=authenticated_db|s3`:

- `authenticated_db` reutiliza el manifest y los ficheros inmutables ya
  guardados en `WebArtifacts`; no duplica bytes. Es el fallback automático si
  no hay configuración S3 y genera URLs HTTPS bajo el mismo API.
- `s3` conserva el almacén público inmutable existente y exige bucket, base
  HTTPS y credenciales del servidor. Si no se declara modo, solo se selecciona
  S3 cuando están configurados bucket y base URL.

En `authenticated_db`, las rutas públicas respecto a JWT de UI son:

- `GET /api/marketing/web-installations/:installationId/artifacts/:artifactHash/manifest`;
- `GET /api/marketing/web-installations/:installationId/artifacts/:artifactHash/envelope`;
- `GET /api/marketing/web-installations/:installationId/artifacts/:artifactHash/files/:pathToken`.

No son anónimas. Exigen `Authorization: Bearer <token de instalación>` y
`X-Clinicaclick-Plugin-Version`, aplican rate limit por instalación/IP y vuelven
a resolver el único artefacto deseado. Solo sirven el hash exacto de esa
instalación, el manifest canónico, su envelope Ed25519 regenerado de forma
determinista y las rutas declaradas en el manifest. Un hash anterior o ajeno,
un token de otra instalación o un `pathToken` no canónico fallan cerrado. Las
respuestas son `private, no-store` y nunca exponen bucket, key ni credenciales.
Manifest y envelope públicos respecto al contrato —pero siempre autenticados
con el token de instalación— se proyectan desde una metadata saneada que
excluye `files` y `qaReport`. El bundle autenticado admite como máximo 8 MiB; la
caché de bytes verificados es LRU/TTL acotada a 32 MiB, 8 MiB por entrada, 64
entradas, dos minutos y cuatro cargas completas concurrentes, con singleflight
por hash. Cada petición vuelve a comprobar en base de datos que el artefacto
sigue `ready`; una retirada invalida el servicio aunque queden bytes en RAM.

Tanto el plugin histórico `2.0.0-alpha.7` como `alpha.8` y el live `alpha.9`
deciden las
cabeceras por origen: añaden bearer y versión únicamente cuando el origen
completo de la descarga coincide con `api_base`; nunca los reenvían a S3/CDN.
En ambos modos conservan la segunda barrera: firma, key id exacto, hash, tamaño,
allowlist y contenido deben verificarse antes de cualquier cambio atómico.

El onboarding ya no tiene dependencia circular. La secuencia válida es:

1. backend crea `WebWordpressInstallation(status=pending)` sin reservar la URL,
   genera un challenge independiente de 256 bits y un ticket opaco AES-256-GCM
   ligado a actor, instalación, token, challenge y caducidad; persiste solo el
   hash del token y el hash/caducidad del challenge;
2. el usuario autenticado descarga el ZIP provisionado aunque todavía no haya
   publicación; contiene identidad, token, challenge y ancla pública Ed25519;
3. al activar, WordPress registra/actualiza rewrites y expone temporalmente
   `/.well-known/clinicaclick-wordpress-claim` con instalación, digest y
   `home_url` canónico, nunca el challenge raw;
4. el backend obtiene ese documento por HTTPS/443 con DNS revalidado, socket
   fijado, sin redirects/proxy/descompresión y con límites estrictos; bajo
   transacción compara el digest y reclama el `claimed_site_hash` único. Solo
   entonces pasa a `connected`; un heartbeat sin prueba no reclama el sitio;
5. el reporte aceptado devuelve `site_claim_acknowledged=true` y el plugin deja
   de exponer la prueba temporal. Revocar libera el claim, pero reconectar exige
   un challenge nuevo;
6. se puede preparar una publicación mientras está `pending`, pero el backend
   rechaza su activación hasta que la instalación esté `connected`;
7. tras publicar, `desired-state` entrega runtime firmado y artefacto; los
   siguientes reportes confirman el hash activo.

No se ha relajado ninguna firma ni autenticación. El token sigue persistido
solo como hash en backend y como opción `autoload=false` en WordPress; el ZIP
es `private, no-store` y el ticket dura 15 minutos. Un ZIP recién emitido lleva
siempre el descriptor público vigente, aunque `public_key_id` conserve todavía
la clave anterior hasta recibir el ACK firmado de WordPress.

La rotación Ed25519 operativa usa dos fases y no permite self-bootstrap:

1. la pareja vigente pasa a `MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM` /
   `MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM`; durante la ventana de transición se
   declaran además `MARKETING_WEB_SIGNING_ROTATION_FROM_KEY_ID=<old>` y
   `MARKETING_WEB_SIGNING_PREVIOUS_PRIVATE_KEY_PEM=<old-private>`;
2. una instalación cuyo `public_key_id` ya es vigente recibe descriptor sin
   envelope de transición. Una instalación en `<old>` recibe el descriptor
   nuevo firmado por la privada old, mientras runtime/registro y envelopes
   autenticados se firman con la nueva;
3. WordPress persiste esa clave como pendiente, verifica y aplica todo el estado
   deseado, y solo si todas las rutas terminan `active`/`retired` sin
   `manual_hold`, pendientes ni fallos la promueve localmente. Conserva el ID
   anterior como retirado para bloquear downgrade/replay;
4. `sync_result` reporta `signing_key_id` y `configuration_sequence`. El backend
   promueve `WebWordpressInstallation.public_key_id` únicamente en schema 2,
   bajo el lock de instalación, tras revalidar token/site, secuencia y conjunto
   exacto de rutas/artefactos dentro de la misma transacción. Schema 1,
   heartbeat, ACK parcial, clave distinta o secuencia vieja no promueven;
5. `reported_state.signing_key_history` conserva hasta 32 IDs retirados. El
   desired-state rechaza que una configuración vuelva a seleccionar uno de
   ellos. Cuando todas las instalaciones activas reportan el ID vigente se
   retiran las dos variables temporales y se destruye la privada old.

El plugin no usa el conjunto completo de claves históricas para verificar un
desired-state nuevo. Tras aceptar el descriptor vigente, liga a su `key_id` la
firma del runtime/registro y de cada manifest descargado. Las claves retiradas
pueden permanecer para inspección de artefactos inmutables locales, pero una
firma nueva hecha con ellas falla aunque el response conserve el descriptor
vigente; esto evita key-confusion después de una rotación.

Si la clave old se pierde o compromete no existe fallback remoto: se congela la
publicación y se hace reanclaje público fuera de banda por instalación (ZIP/token
rotados + importación local explícita del descriptor), seguido de reconciliación
manual y auditada del `public_key_id` del control plane. Nunca se emite una firma
falsa ni se acepta un header como prueba de confianza.

### Orden seguro para renderer 1.5.0, globales y galería

La compatibilidad es deliberadamente asimétrica: una revisión legacy o una que
solo use cabecera/pie globales no requiere el nuevo contrato de intake, pero
**no se debe publicar en WordPress una revisión con formulario global usando
un plugin anterior a `2.0.0-alpha.7`**. La API/worker aplica ese mínimo de
versión de forma fail-closed; no depende del frontend. Responde `409`
`web_wordpress_global_intake_plugin_outdated` con
`actual_plugin_version`/`required_plugin_version`, sin encolar ni alterar el
deployment. El
orden operativo obligatorio es:

1. construir y verificar el ZIP `2.0.0-alpha.7` con los **26/26** contratos PHP
   y las **3/3** pruebas de interoperabilidad;
2. guardar un rollback **real** de `alpha.6`, incluido su
   `config/installation.php`, y actualizar con el ZIP **provisionado** de
   `alpha.7`; no usar el ZIP genérico ni perder identidad/token/descriptor,
   runtime o caché/LKG;
3. invocar `CCW_Plugin::activate(false)` como el usuario propietario del sitio
   `propdental.es`, nunca como `root`, para forzar el heartbeat inmediato en
   vez de depender de la cadencia ordinaria de hasta 24 horas;
4. comprobar que la instalación sigue `connected`, que la DB ya reporta
   exactamente `2.0.0-alpha.7`, y verificar sincronización, página existente y
   rollback sin cambiar el artefacto activo;
5. solo entonces aprobar/publicar una revisión compilada por
   `clinicaclick-web-renderer/1.5.0` que contenga formulario global y, para
   acreditar el corte vigente, una galería real;
6. verificar cada permalink, `data-cc-global`, canonical/OG/JSON-LD/sitemap,
   recursos de galería, contrato de formulario por página, un envío controlado,
   atribución, ausencia de duplicados y rollback antes de ampliar scopes.

Los pasos 1-4 quedaron acreditados en Propdental el 2026-07-18: WP-CLI y DB
reportan `alpha.7`, `/cita/` sigue en `200` y el artefacto activo no cambió.
Los pasos 5-6 estuvieron pendientes en ese corte histórico y quedaron cerrados
después por la publicación y rollback real del renderer `1.6.0` documentados
al inicio. Si otra instalación no reporta `alpha.7`
—incluidos los estados atrasados `alpha.5` o `alpha.6`—, la publicación de un
formulario global debe quedar
bloqueada o pospuesta de forma observable; nunca se fuerza el manifest nuevo ni
se sacrifica el last-known-good. Este orden no habilita hosted/custom ni
multi-route: conservan sus gates y E2E independientes.

El gate de versión no degrada ni retira publicaciones legacy y no bloquea una
revisión que solo tenga header/footer globales. Aun así, para el rollout real
se recomienda promover `alpha.7` antes de estrenar cualquier artefacto `1.5.0`,
de modo que plugin y renderer se observen como una sola tanda reversible.

Durante un diagnóstico controlado se mostró accidentalmente un HMAC de intake
en la salida privada de la herramienta y se trató como comprometido. La
rotación quedó cerrada mediante reconciliación
`889cc3a4-7d09-4cb0-accb-65acbdbfbb61`, generación 1, estado `completed`. El
finalizer `JobRequest #32179` terminó el `2026-07-19T07:24:30Z`, con dos
intentos y sin error. Target y source fueron aceptados durante la gracia;
después se eliminaron ambos envelopes, quedó una única clave aceptada y se
restauró la gracia normal a `86400000` ms. Staging permaneció online. Nunca se
debe imprimir la configuración runtime completa para diagnosticar este canal.

El plugin live `2.0.0-alpha.9` despliega el contrato multi-route. Una
instalación conserva el piloto histórico `/cita/` y admite rutas adicionales
inmutables `/cita/<slug>/`; backend y plugin resuelven por el prefijo más largo.
El desired state schema 2 firma un registro de hasta 20 rutas y acota cada sync
a 400 ficheros únicos, 500 descargas y 768 KiB de control. El plugin valida el
plan completo antes de descargar, comparte releases inmutables por hash —aunque
esta versión puede repetir descarga/verificación si varias rutas apuntan al
mismo artefacto—, conmuta punteros por ruta bajo lock, conserva LKG por ruta y reporta ACK estable con
`registry_sequence + route_prefix + artifact_hash`. Un estado vacío también se
firma para poder retirar el último tombstone sin resucitar el piloto legacy.
El rollback local de `/cita/` restaura también el runtime de esa ruta en
`routes.json`; el resolver comprueba siempre que `desired_artifact_hash`
coincida con el puntero activo y, durante los dos renames atómicos por fichero,
usa únicamente el par coherente o falla cerrado. La regresión automatizada ejecuta dos
artefactos/runtimes distintos, rollback y tráfico real de los bridges intake y
eventos. El E2E público desechable quedó cerrado sobre el proyecto
`f758cce8…` y la publicación `69f06cf0…`: ruta A
`e2de500c…`/artefacto `831177bc…` y ruta B
`4c1f3005…`/artefacto `0b9a41a2…` verificadas, con rollback A acreditado. El
formulario devolvió `303` y creó `LeadIntake #7269` con clínica `59`/grupo `5`
y proyecto/revisión/publicación/artefacto/formulario exactos, además de
`FormSubmissionEvent #24` y `WebEvent #38157`; no llevaba click IDs ni produjo
intentos Ads. La limpieza `dry-run -> simulate -> apply` dejó cero filas en 11
categorías. Proyecto archivado, publicación/ruta retirada y tombstone
desired=reported sequence `12`; la ruta respondió `410` mientras estuvo activo.
Después de liberarlo, el readback live final devuelve `404` y solo queda el
piloto activo. `/cita/` conservó body SHA `f3ddf142…` y artefacto durante esa
prueba.

Después se recompiló deliberadamente el mismo proyecto/revisión piloto desde
renderer `1.2.1` a `1.5.0`. `document_hash=ba60…` y
`content_snapshot_hash=5f447…` demuestran el mismo documento; contenido, SEO y
Schema permanecen iguales. El artefacto añade `web_artifact_input_hash`
antifraude y el CSS de `divider`/`spacer`/`gallery`. El artefacto público de
aquel corte
tiene hash `d875201…`, body SHA `e851688…` y ETag `304` acreditado tanto por
Cloudflare como por origen.

La comprobación **Guardar** de Consent fue solo de harness: un diagnóstico
saneado acreditó persistencia del handler, retirada del banner, inicialización
del runtime y cero `pageerror`; no sustituye una prueba pública de guardado.
El QA público posterior en Chromium real a `390px` obtuvo
`scrollWidth=390`; el único overflow es el honeypot deliberadamente fuera de
pantalla. **Aceptar todo** ocupa el ancho completo, el aviso desaparece al
aceptar, `cc_consent_v2` persiste y el formulario conserva 11 campos, sin
excepciones ni fallos de red. El router corrige el magic-quotes aplicado por
WordPress a `HTTP_IF_NONE_MATCH`; el fix `5d11cf8`/staging `e562936` está live
y Cloudflare/origen responden `304` con el ETag exacto.

El audit de aquel artefacto detectó dos defectos editoriales del piloto: la revisión
declara email como contacto preferido, pero el formulario no incluye un campo
email; además, los datos Social y Schema están incompletos. Ni los 11 campos ni
la recompilación determinista acreditan completitud semántica. Debe crearse una
revisión nueva y aprobada que añada email o cambie el canal preferido y complete
Social/Schema; no se reescribe silenciosamente la revisión congelada. La
revisión `1.6.0` posterior ya incorpora email coherente, Social y Schema y está
publicada con readback y rollback acreditados.

El renderer 1.6 del corte posterior evitó que nuevas compilaciones volvieran a anunciar un
canal email inexistente y completa la salida Social/Schema cuando recibe una
imagen pública válida. La revisión nueva ya fue creada, publicada y verificada;
el artefacto 1.5 queda únicamente como historial y punto de rollback probado.

La promoción posterior reconcilió aquel diff: el hotfix backend `de7b461` llegó
a staging mediante `8ebf5bc`. Ese hito 1.6 queda como baseline histórica. El
corte vigente al inicio del documento es `3f0c0e0`/staging `a22b773`, con
renderer `1.7.0`, migración `20260719170000` aplicada y primera
publicación/readback acreditada; la advertencia de no paridad queda como riesgo
ya resuelto de la promoción anterior.

Retirar una publicación WordPress ya es una operación de producto explícita:
`POST /api/marketing/web-publications/:publicationId/retire` exige
`marketing.web.publish`, bloquea proyecto, instalación y todas sus rutas,
rechaza deployments activos, marca `retired_at`, incrementa versión y audita.
La ruta permanece reservada; solo el tombstone confirmado libera uno de los 20
slots. `publication_count` representa capacidad ocupada, mientras
`route_history_count`/`requires_additional_route` impiden que la UI vuelva a
tratar una instalación con historial como virgen. El historial total queda
acotado a 200 rutas para mantener finito el conjunto bloqueado.

La rotación de token también es staged. En instalaciones conectadas el token
nuevo caduca por defecto en 24 horas y solo un reporte schema 2 válido de
`alpha.8` y posteriores lo promueven bajo lock; el anterior sigue sirviendo
hasta ese ACK y
falla inmediatamente después. Reemitir invalida el candidato previo y revocar
borra ambos. Una instalación `pending` sí reemplaza su token primario al
reemitir porque todavía no existe tráfico que preservar. La descarga de
artefactos ya no recorre todas las rutas: resuelve el hash solicitado por el
índice `artifact_id,status,publication_id`, vuelve a demostrar publicación y
deployment deseados y usa una caché LRU corta solo para bytes inmutables.
Cada request vuelve a consultar que `WebArtifact.status=ready`; un artefacto
fallido o retirado deja de servirse aunque sus bytes sigan en caché. La
normalización/verificación criptográfica del bundle se memoriza por hash con
TTL y LRU acotados, de modo que manifest, envelope y N ficheros no vuelven a
hashear el bundle completo N veces. `desired-state` conserva ETag/304, pero se
entrega como `Cache-Control: private, no-store, max-age=0` y `Pragma: no-cache`:
el bearer, runtime y registro deseado nunca deben persistir en cachés
intermedias o compartidas.

Los cambios de `IntakeConfig` que alteran HMAC o runtime no conmutan primero la
configuración y después las landings. Una reconciliación durable prepara los
artefactos de todas las publicaciones afectadas, conserva source/target durante
despliegue y gracia, exige readback público —incluido ACK real de ruta en
WordPress— y solo entonces finaliza el cambio. Los deployments internos llevan
un marker exacto que suprime el falso evento `landing_published`; providers de
storage no pueden inventarlo ni borrarlo. Fallo/superseded despiertan el
finalizador en la misma transacción. Hosted, custom-domain y WordPress usan el
mismo modelo de identidad de artefacto, sin confiar en un hash aportado solo por
el navegador.

La identidad exacta se transporta en dos capas: los renderers nuevos incluyen
`web_artifact_input_hash` en formularios/eventos y WordPress añade
`X-Clinicaclick-Web-Artifact` desde su manifest firmado. Para el piloto legacy
renderer `1.2.1`, `alpha.7` completa el marker server-side desde ese manifest;
un valor enviado por el navegador que no coincida se rechaza. Hosted y custom
domain mantienen source activo y el target exacto durante un deployment de
contenido, pero el target solo se admite si es el artefacto del deployment
publish/rollback más reciente y conserva el hash del runtime comprometido; un
tercer artefacto falla cerrado.

Las transiciones grupo/clínica que se solapan se serializan bajo el mismo lock
de grupo. El finalizador respeta el orden global instalación → publicación →
deployment. Si una de N rutas target falla después de que otra ya haya
conmutado, no se limpia ni expira el target: se crean rollbacks durables hacia
cada artefacto source, se espera deployment verificado y ACK/puntero source en
todas las rutas y solo entonces se desbloquea el scope. Una gracia por identidad
de artefacto se conserva incluso cuando source y target usan el mismo HMAC.
`bulkCreate`/`bulkUpdate`/`bulkDestroy` fuerzan hooks por fila, `truncate` se
rechaza y borrar un `IntakeConfig` con publicaciones servidas falla cerrado.

`failed` no activa ninguna autorreparación silenciosa. Solo un admin global de
Clinicaclick puede invocar
`POST /api/admin/web-runtime-reconciliations/:id/recover`, con `confirmed=true`,
motivo, `Idempotency-Key` (o `X-Request-Id`) aportado por el operador y una acción explícita: `retry_target` o
`rollback_source`. El servicio vuelve a bloquear `IntakeConfig`,
reconciliación, instalaciones, publicaciones, deployments y artefactos en el
orden global; demuestra que current sigue siendo source/target y que cada
artefacto conserva estado, entorno, runtime hash y linaje exactos. Un retry
crea siempre otra generación y otro `JobRequest`, resealing los envelopes para
el AAD nuevo. Conserva además el linaje de rutas ya target+verified: las rutas
source reciben deployments frescos y las ya conmutadas se fusionan en el set
esperado, de modo que otro fallo puede restaurarlas todas. Un rollback crea
deployments source nuevos y no reutiliza rollbacks terminales de la generación
fallida. La acción queda en `WebAuditEvents`; el modelo guarda request id, hash
estable de acción+motivo, acción y generación. El lock de reconciliación hace
esta idempotencia visible aun bajo MySQL `REPEATABLE READ`: mismo key+payload
es replay y mismo key con payload distinto responde 409. Actor y permisos se
toman exclusivamente del JWT; un admin de clínica no puede falsear el actor en
el body.

Los HMAC source/target de una reconciliación no se duplican en plaintext. La
tabla conserva envelopes AES-256-GCM con IV aleatorio y AAD que liga UUID de
reconciliación, scope, scope ID, generación y slot source/target. La subclave
se deriva por HKDF-SHA256 desde `MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY` con salt e
info exclusivos/versionados para este uso; opcionalmente puede provisionarse
`MARKETING_WEB_RUNTIME_ENVELOPE_KEY` como clave dedicada de 32 bytes y un
`MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID` estable. Clave ausente/malformada,
envelope alterado o AAD cruzado fallan cerrados. La migración posterior
`20260719091500-encrypt-web-intake-runtime-secrets.js` recupera de forma
reanudable una tabla experimental que ya tuviera columnas `*_hmac_key`, valida
cualquier envelope parcial y elimina el plaintext. Si existen columnas legacy,
la migración exige explícitamente
`MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED=true`: antes hay que detener
todos los API/workers que puedan escribir `IntakeConfig` o reconciliaciones,
comprobar que no queda ningún writer antiguo, ejecutar la migración con ese flag
solo en su proceso, retirarlo y arrancar exclusivamente el código nuevo. El
proceso adquiere además, en una conexión dedicada, un fence MySQL verificable
con `LOCK TABLES` de escritura sobre reconciliaciones y de lectura sobre
`IntakeConfigs`; espera a writers previos y bloquea writers antiguos o nuevos
durante el backfill y la revalidación. Como `ALTER TABLE` libera ese lock, las
escrituras quedan después cercadas por tres triggers temporales fail-closed
creados en orden `BEFORE DELETE` → `BEFORE INSERT` → `BEFORE UPDATE`, sin
referencias a columnas legacy, que sobreviven
al commit implícito. Tras una segunda revalidación, las dos columnas legacy se
eliminan en un único `ALTER` atómico y solo entonces se retiran los triggers. Un
rerun detecta y verifica su definición exacta; si el proceso cayó después del
`DROP`, los limpia aunque ya no queden columnas legacy, y nunca elimina un
trigger homónimo ajeno. Si revalidación o `ALTER` fallan y aún queda cualquier
columna plaintext, los triggers permanecen bloqueando DML hasta un rerun
correcto/manual. Como los tres `CREATE TRIGGER` son secuenciales, se compara
además un fingerprint canónico exacto de todas las filas antes/después de
instalarlos; así también un `DELETE` en esa transición aborta. El backfill usa
compare-and-set por hash/longitud;
autentica también envelopes
existentes cuyo plaintext sea NULL/vacío y aborta sin borrar columnas ante
drift, clave/AAD inválidos, fence no disponible o falta de quiescencia. El flag
certifica además que no se reiniciarán workers entre DDLs y no debe quedar en el
entorno permanente. Su `down` es
deliberadamente no-op porque nunca se vuelve a materializar un secreto.

Bloqueo de promoción: antes de ejecutar `20260719091500` fuera de una base
desechable hay que pasar un preflight sobre MySQL de la misma versión real. Debe
acreditar espera efectiva de `LOCK TABLES` frente a un writer concurrente,
definiciones recuperables desde `information_schema.TRIGGERS`, rechazo DML de
los tres triggers, supervivencia al commit implícito de `CREATE TRIGGER`, `ALTER`
atómico, caída simulada antes/después del `DROP` y rerun/cleanup. Los stubs
unitarios protegen el contrato del código, pero no sustituyen esta prueba de
dialecto; sin su evidencia no se autoriza migración/deploy.

Ese bloqueo quedó satisfecho para el corte alpha8 el 2026-07-19 sobre MySQL
8.0.42. La primera ejecución detectó que el usuario de aplicación no puede
crear triggers con binlog y `log_bin_trust_function_creators=0`, sin tocar
tablas reales. La prueba completa se repitió con la cuenta de mantenimiento
solo dentro del proceso, sin conceder `SUPER` ni cambiar el global; además
descubrió y corrigió que el DDL podía devolver una conexión al pool conservando
el READ lock de `IntakeConfigs`. El helper ejecuta ahora `UNLOCK TABLES`
explícito incluso si el DDL ya lo hizo. El test exige cleanup y el inventario
posterior fue cero tablas/triggers de scratch.

La resolución efectiva de runtime es común a intake público, formularios,
deployments, instalaciones WordPress y defaults de proyectos web. Una fila
clínica con `runtime_inheritance` conserva sus dominios/campañas/textos locales,
pero dereferencia siempre el runtime/HMAC actual del grupo y valida pertenencia
y `locations`. Antes de autenticar, los hints explícitos y los records hallados
por dominio deben describir una única clínica/grupo; cualquier cruce responde
409. Se elige un único dueño de credencial por precedencia clínica → grupo →
dominio y solo se prueban sus candidatos de transición: una firma válida de un
grupo más amplio nunca rescata un HMAC clínico inválido.

El cierre E2E WordPress quedó verificado:

- el formulario público se probó dos veces. El terminal final fue
  `LeadIntake #7261`, resuelto a clínica `59`/grupo `5`, con consentimiento y
  atribución Web exacta de proyecto/revisión/página/publicación/artefacto/form.
  Antes de limpiar existían su `FormSubmissionEvent` y
  `LeadAttributionAudit`; no tenía click IDs, no generó conversiones externas y
  la simulación + limpieza retiró el lead y artefactos sintéticos. El marker de
  postcheck quedó en `0`;
- para rollback se publicó la revisión temporal 3
  `c01c20ec…` mediante deployment `9c53ec42…` (secuencia 5, job `31698`,
  artefacto `545c1672…`), verificada en público. Después el deployment de
  rollback `48df4e4e…` (secuencia 6, job `31699`) reactivó y verificó la
  revisión 2 CSP-fixed y el LKG
  `a43e7c4a-9ef3-4aef-aad3-70f12f927c31`. El borrador se restauró a su hash
  original;
- durante la reprovisión temporal, el deployment `583dc38f…` (secuencia 3)
  falló de forma explícita. La recuperación limpia
  `a944709d…` (secuencia 4, job `31696`) activó el artefacto CSP-fixed sin
  alterar campañas.

El cierre posterior de `alpha.6` verificó además el relay público de la landing
y la atribución canónica `clinicaclick_web_publication`: backend reconstruye
proyecto, revisión, página, publicación y artefacto a partir de la identidad
firmada y no degrada esos eventos a una fuente web genérica. En el borde de
`crm.clinicaclick.com`, la ruta exacta `POST /_clinicaclick/events` admite hasta
80 KiB y sustituye `X-Forwarded-For` por `$remote_addr` antes de proxificar a
`127.0.0.1:3001`; no existe un catch-all de escritura equivalente. El E2E
público terminó sin duplicados ni intentos de subida a Google y se eliminaron
todos los leads, eventos y filas WhatsApp sintéticos usados por la prueba.
La copia previa del plugin `alpha.5` queda únicamente como rollback operativo
en `/home/propdentalssh/ccw-alpha6-20260718T1254Z/alpha5-backup/`; no es la
versión live.

El defecto CSP descubierto por el piloto quedó corregido en el renderer
`clinicaclick-web-renderer/1.2.1` y en las validaciones allowlisted del plugin.
Chromium desktop/móvil confirmó cero bloqueos CSP, consentimiento y chat con
estilos, exactamente un loader y ningún HMAC en el documento público.

Los receptores públicos `POST /api/intake/leads`,
`POST /api/intake/events` y `POST /api/intake/whatsapp-origin` también son
fail-closed. Aceptan el HMAC del
`IntakeConfig` aplicable o, solo cuando ese scope no tiene secreto, el HMAC
server-to-server configurado en `INTAKE_WEB_SECRET`. Un secreto global nunca
puede sustituir ni saltarse el secreto más estrecho de clínica o grupo. El
relay de landings sigue este mismo contrato: valida publicación, revisión,
artefacto, host y ruta, reconstruye un body canónico y lo firma server-side;
ninguna cabecera aportada por el navegador actúa como autenticación.

Para el canal alojado, Nginx expone exactamente dos rutas de escritura:
`POST /_clinicaclick/intake` y `POST /_clinicaclick/events`; cualquier otro
POST queda denegado. La segunda permite 80 KiB para alojar el payload canónico
validado de hasta 64 KiB y su wrapper. El runbook versionado está en
`ops/nginx/README-marketing-web.md` y exige `nginx -t`, CSP, formulario,
chat/teléfono/WhatsApp, readback y rollback antes de abrir un scope real.

### Hardening Web live `alpha.7` integrado y desplegado (2026-07-18)

Este bloque conserva el contrato histórico en `dev` `4e4b555`, staging/backend
`5e57431` y el piloto WordPress entonces live `2.0.0-alpha.7`. El despliegue no abre por
sí mismo hosted/custom: esos canales continúan apagados y fallan cerrado hasta
que su infraestructura externa complete DNS/TLS/origen/proveedor y E2E.

La disponibilidad deja de ser un booleano ambiguo:

- `publishing_rollout_available` refleja gate global + allowlist del scope;
- `publishing_available` exige además al menos un canal operativo;
- `publishing_channels` proyecta `wordpress`, `clinicaclick_hosted` y
  `custom_domain`, cada uno con `available` y `unavailable_reason`;
- WordPress se autodetecta si su override queda vacío y exige API HTTPS sin
  path, bootstrap de al menos 32 caracteres, almacén válido y pareja Ed25519;
- hosted/custom son opt-in (`false` por defecto) y exigen root absoluto seguro,
  host/modo o proveedor/target/credenciales completos;
- `assertWebPublishingChannelEnabled` protege creación, dominio, instalación y
  ejecución. El worker relee el gate dentro de su lock, antes de compilar o
  mutar; si se cerró, deja el deployment en espera observable sin publicación
  parcial. Reconciliar dominios con custom apagado se omite sin proveedor.

La pareja de firma no se valida por longitud: Node parsea privada/pública,
exige `ed25519`, deriva la pública desde la privada y compara ambas en tiempo
constante. El hosting root rechaza `/`, rutas relativas, NUL y valores
demasiado cortos.

Desired-state de WordPress consulta `WebArtifact` con metadata allowlisted
(`id`, proyecto, entorno, estado, hash y manifest), nunca con `files`. El set de
rutas descargables se valida contra `Object.keys(manifest.files)` y el budget de
8 MiB antes de construir v1/v2. El contrato de regresión cubre v1 y un poll v2
al máximo de 20 rutas: 20 lecturas metadata-only, cero bodies y cero ejecución
del validador completo de bundle; este último queda reservado al endpoint
autenticado que sirve un recurso concreto.

El publisher/origin hosted endurecido:

- materializa artefactos inmutables y, también al reutilizarlos, compara el
  conjunto exacto de ficheros y contenido de manifest, envelope y assets;
- rechaza ficheros extra, alteración, symlinks y punteros fuera de
  `artifacts/<sha256>`;
- el origin verifica `manifest.json` + `manifest.sig.json`, firma Ed25519,
  hashes y tamaños antes de responder; cualquier incoherencia falla `503`;
- una publicación no puede solapar otra del mismo host por relación
  antecesor/descendiente. El precheck transaccional y el host lock del
  filesystem aplican la misma regla; un fallo elimina solo directorios vacíos
  creados por ese intento;
- el health de hosted/custom verifica primero el bundle/puntero local completo
  y después el marker público.

Preflight de infraestructura 2026-07-18: existen
`/var/lib/clinicaclick-web-hosting` (`ubuntu:ubuntu`, `0755`) y
`/var/www/letsencrypt/.well-known/acme-challenge`; las listas Cloudflare
oficiales se revalidaron y coinciden exactamente con el snippet. Esto no abre
el canal: faltan control DNS, vhost, certificado y flag. El host continúa con
HTTP `302` de DonDominio y HTTPS `521`; no hay E2E hosted.

El job durable `marketing_web_publication_health_monitor` está programado por
defecto a `11 * * * *`, lote 25 (máximo 100). Selecciona publicaciones
`published` con artefacto activo, hace un único GET público por fila y persiste
solo si el puntero no cambió. Audita transiciones `unhealthy`/`recovered`. Un
readback fallido es resultado funcional: no reintenta agresivamente el lote,
no hace rollback, no republica y no consulta/muta plataformas publicitarias.
La observación controlada del `2026-07-18T13:01:04.689Z` comprobó una
publicación y obtuvo `1 healthy`, `0 degraded`.

El WordPress de aquel corte `2.0.0-alpha.7` usa presencia, no truthiness, para
clasificar identidad Web: ausencia total mantiene una página ordinaria; IDs
presentes vacíos/incompletos devuelven `422`. Una landing completa reenvía sus
eventos por `/_clinicaclick/events`, donde backend reconstruye
proyecto/revisión/página/publicación/artefacto y firma server-side. La barrera
pre-DB usa identidad derivada de IDs + origin/path + IP, con un techo global por
IP; después de resolver la publicación aplica el bucket canónico. Así varias
rutas legítimas de un WordPress compartido no colapsan en un único bucket, pero
rotar IDs/ruta tampoco elimina el límite global.

Estado de aceptación de esta tanda:

1. suite Marketing Web, PHP e interoperabilidad: cerradas;
2. backend promovido/reiniciado con smoke verde; frontend build
   limpio `5a08e6a108414a76` desplegado con 481/481 ficheros, readback de assets en
   `200`, auth pública `401` esperada y Nginx activo;
3. `alpha.7` instalado preservando la configuración, con rollback real
   `alpha.6` y DB/heartbeat alineados;
4. E2E público del relay/intake atribuido y datos sintéticos limpiados;
5. observación real del monitor: saludable;
6. hosted/custom permanecen deliberadamente apagados hasta
   DNS/TLS/vhost/flag/proveedor y E2E; el preflight de directorios/Cloudflare no
   sustituye esos gates. En este cierre histórico `alpha.7`, WordPress
   multi-route y la rotación Ed25519 operativa aún no existían. El corte
   `alpha.8` posterior ya fue migrado/desplegado y su E2E desechable de dos
   rutas quedó cerrado con rollback, cleanup y tombstone. La rotación HMAC,
   recompilación pública `1.5.0` y readback ETag `304` también quedaron
   cerrados. Lighthouse y validadores externos generales quedan fuera.

La auditoría Figma afecta al frontend, no a este runtime: se reutiliza la UX de
editor/biblioteca/plantillas/inspector/onboarding/CMS, pero nunca el backend,
renderer o plugin ModSuite. Tailwind pertenece al shell Angular; el backend
persiste `WebDocument` tipado y el compilador produce el CSS público.

El webhook de Meta conserva el GET de verificación, pero cada POST exige
`META_APP_SECRET`, el cuerpo crudo y una cabecera
`X-Hub-Signature-256: sha256=<hex>` válida. La ausencia de secreto o firma se
rechaza; no existe bypass implícito por entorno. Las pruebas solo pueden crear
el validador con una dependencia explícita `allowUnsignedForTests: true`.
`META_APP_SECRET` se captura al cargar el módulo: rotarlo exige actualizar el
secreto en todos los procesos y reiniciarlos de forma controlada; un worker con
el valor anterior rechazará firmas nuevas.

## Idioma preferido del paciente (2026-07-20)

### Persistencia y valores canónicos

La migración `20260720090000-add-patient-preferred-language.js` añade
`Pacientes.idioma_preferido ENUM('es','ca','en') NOT NULL DEFAULT 'es'`. Es idempotente
frente a una columna ya existente. Los únicos valores de negocio aceptados son:

| Valor | Etiqueta API | Uso |
|---|---|---|
| `es` | Español | valor por defecto y compatibilidad de registros previos |
| `ca` | Catalán | comunicaciones en catalán |
| `en` | Inglés | comunicaciones en inglés |

No se guarda `cat`: ese id pertenece únicamente al catálogo Transloco
histórico del frontend. `src/lib/patient-language.js` concentra normalización,
etiquetas, default y actualización explícita para que citas, pacientes y
automatizaciones no mantengan reglas divergentes.

### Contrato API

- Las serializaciones de paciente y calendario exponen
  `idioma_preferido` y `idioma_preferido_label`.
- `POST /api/pacientes` acepta el campo; si se omite crea en `es`.
- `PATCH /api/pacientes/:id` permite cambiarlo respetando exactamente el ACL y
  scope de edición de la ficha. Un valor distinto de `es|ca|en` responde `400`
  con `allowed`.
- `POST /api/citas` acepta `paciente.idioma_preferido`.
  - campo omitido + paciente existente: conserva el idioma;
  - campo omitido + paciente nuevo: usa `es`;
  - campo presente: aplica la preferencia explícita.

`createAppointmentWithPatientLanguage` ejecuta `CitaPaciente.create(...)` y la
actualización explícita del idioma dentro de **la misma transacción Sequelize**.
Si falla cualquiera de las dos escrituras, se revierten ambas: no queda un
cambio de idioma sin cita ni una cita fantasma con el idioma anterior, y el
runtime de automatizaciones solo se encola después del commit. El alta
histórica de un paciente nuevo puede haber creado antes su ficha base en `es`,
pero nunca persiste el idioma alternativo si la cita no llega a confirmarse.

### Compatibilidad y pruebas

La columna con default `es` hace compatibles las filas históricas y los
clientes API antiguos. Omitir no equivale a enviar `es`: la distinción protege
a pacientes ya configurados en catalán o inglés.

`node --test src/scripts/tests/patient_preferred_language.test.js` cubre default,
preservación sin escritura, cambio explícito, validación, contrato de
migración/modelo/PATCH, propagación de la transacción y rollback de la cita
cuando falla la escritura del idioma.

## 2026-07-20 - Idioma de paciente por mensaje y rollout WhatsApp `es/ca/en`

Este corte añade el contrato backend para que las automatizaciones WhatsApp
puedan enviar en español, catalán o inglés siguiendo el idioma vigente del
paciente en cada nuevo mensaje, sin duplicar ni alterar mensajes ya
materializados. Depende del contrato de paciente que persiste
`Pacientes.idioma_preferido` como `ENUM('es','ca','en') NOT NULL DEFAULT 'es'`.
No se infiere el idioma a partir de mensajes, nombres, navegador ni clínica.

### Resolución por mensaje con replay durable

Al crear una `FlowExecutionV2`, tanto el endpoint manual como el scheduler de
citas leen el idioma del paciente y guardan una copia en
`context.communication_language` como fallback operativo. Antes de cada nodo
`send_whatsapp`, el motor enriquece el contexto desde `Pacientes` y resuelve el
idioma con esta precedencia:

- `patient/paciente.preferred_language` o `idioma_preferido` recién leído de
  base de datos;
- `context.communication_language`, para ejecuciones antiguas o contextos sin
  paciente enriquecido;
- `es`, como default histórico seguro.

Así, si una clínica envía el primer recordatorio en español y después cambia el
paciente a catalán, los siguientes nodos de esa automatización saldrán en
catalán. En cambio, un reintento del mismo `Message` no vuelve a decidir idioma:
reutiliza la plantilla, parámetros y locale guardados en `Messages.metadata`.
Esto evita envíos duplicados y cambios de idioma dentro del mismo mensaje ya
preparado.

La selección localizada vive en `config.language_routing`:

```json
{
  "enabled": true,
  "source": "patient_preferred_language",
  "variants": {
    "ca": { "language_code": "ca", "catalog_template_id": 101 },
    "en": { "language_code": "en_US", "catalog_template_id": 102 }
  }
}
```

La configuración española sigue siendo la base del nodo. Los códigos internos
son `es`, `ca` y `en`; al hablar con Meta se usan `es`, `ca` y `en_US`. Para
`ca/en` se exige catálogo de la misma familia, locale exacto, contrato de
variables compatible, WABA efectivo y estado `APPROVED`. La ausencia de una
variante requerida termina con `whatsapp_language_variant_missing:<locale>` o
`whatsapp_language_template_unavailable:<locale>`; nunca cae silenciosamente a
español.

El `Message` se materializa antes del transporte con idioma, familia, plantilla,
parámetros y componentes resueltos. La clave idempotente depende de ejecución y
nodo/`delivery_slot`, no del locale. Un replay busca primero ese `Message` y
reutiliza su snapshot: no vuelve a leer al paciente ni elige otra plantilla.
Esto cubre transporte inmediato, horario silencioso y reintentos de handoff.

Las reglas deterministas de respuesta de cita reconocen confirmación,
cancelación y reprogramación en español, catalán e inglés antes de recurrir a
IA. El locale del mensaje saliente no altera la semántica del estado de cita.

### Familias de catálogo y traducciones

`WhatsappTemplateCatalog` incorpora:

- `family_key`: identidad funcional estable compartida por idiomas;
- `locale`: `es`, `ca` o `en`;
- índice único `(family_key, locale)`.

`name` continúa siendo único para identificar la fila local. En Meta, todas las
variantes de una familia comparten el nombre técnico/versionado y se distinguen
por idioma. La migración de esquema rellena `family_key=name` y `locale=es` para
el histórico. La migración editorial crea borradores inactivos `ca/en` para las
34 familias españolas existentes, conserva exactamente sus placeholders, copia
disciplinas y no sobrescribe una traducción que una persona ya haya editado.
No llama a Meta ni modifica flujos.

El CRUD admin expone `family_key`/`locale` y permite crear una traducción desde
la variante española. La traducción nace inactiva, con disciplinas copiadas y
contrato de placeholders validado. En el editor de automatizaciones, activar
"elegir el mensaje según el idioma del paciente" muestra las variantes `ca/en`
y solo ofrece plantillas aprobadas de la misma familia e idioma.

### Rollout durable, acotado y atómico

El rollout no se ejecuta al desplegar migraciones ni al abrir la UI. Solo puede
iniciarlo un admin mediante `POST /api/whatsapp/template-catalog/language-rollout`.
Su estado se consulta con `GET` sobre la misma ruta. Corre como un único
`JobRequest.type=whatsapp_language_rollout`; no usa un cron lateral ni abre un
segundo worker. La respuesta de estado combina el `result_summary` ya asentado
con `payload.progress`, por lo que también muestra la operación en curso.

Fases:

1. `prepare`: inventaría únicamente las versiones publicadas activas, nodos
   WhatsApp, contratos manuales y familias realmente referenciadas;
2. `propagate`: activa los borradores necesarios y envía una familia/locale por
   ejecución del job;
3. `sync`: sincroniza solo los WABA efectivos del alcance calculado;
4. `audit`: espera aprobación por familia, locale y WABA objetivo;
5. `publish`: bajo locks de base de datos vuelve a auditar y publica versiones
   nuevas, desactivando las anteriores en la misma transacción.

El alcance no usa la aplicabilidad genérica del catálogo. Un flujo de clínica
solo aporta esa clínica; uno de grupo expande únicamente las clínicas del
grupo; un flujo global heredado deriva clínicas/WABA de las instancias
españolas que ya referencia. Las clínicas sin WABA efectivo no abren llamadas a
Meta. Una referencia global sin instancia resoluble o una familia sin scope
efectivo bloquea el preflight de forma observable. La auditoría usa exactamente
el mismo mapa `family -> clinic_ids/waba_ids`; un rechazo de otra cuenta no
bloquea este rollout y tampoco se crea allí una plantilla.

Antes de cada llamada remota se guarda `propagation_inflight` y el progreso. La
identidad idempotente de Meta es `nombre técnico + idioma`. Si el proceso cae
después de que Meta acepte la plantilla pero antes del checkpoint local, el
reintento sincroniza el WABA y reutiliza el mismo contrato. Si Meta responde
"already exists", se repite la sync; si aún no es visible, el job espera y
reintenta la misma identidad en vez de inventar una versión. Solo después se
avanza `catalog_cursor`.

No se publica ningún flujo mientras falte una aprobación. Un rechazo, cambio de
scope, draft paralelo o modificación del conjunto activo aborta sin tocar las
versiones anteriores. La publicación revalida catálogos e instancias con locks;
si todos los nodos ya estaban localizados, el job termina idempotentemente sin
crear versiones adicionales.

El preflight de lectura sobre los datos de desarrollo del 2026-07-20 encontró
155 versiones activas, 905 nodos WhatsApp, 21 contratos canónicos, 15 familias,
13 clínicas conectadas y 11 WABA efectivos. La suite de volumen añade un fixture
equivalente de 158 versiones, 929 nodos y 24 contratos para conservar el tamaño
del corte auditado anterior. También cubre cambio `ca -> es` entre ejecuciones,
legacy sin snapshot, ausencia de variante, WABA ajeno, caída tras respuesta de
Meta, replay de plantilla/locale y respuestas entrantes en los tres idiomas.

El párrafo anterior describía el gate previo a la ejecución. El cierre
operativo posterior está registrado al inicio de este documento: migraciones
aplicadas, job durable `#32802` completado, 30/30 aprobaciones, 905/905 nodos
localizados y un único canary autorizado leído. No se deben fabricar mensajes
ni citas para repetir esa validación; cualquier nuevo canary exige destinatario
QA explícitamente autorizado y conserva idempotencia por ejecución/nodo.

## 2026-07-21 - Leads: WhatsApp manual y descarte por información

Este corte ajusta el contrato operativo de Leads/QuickChat:

- `POST /api/conversations/:id/messages`, cuando envía un WhatsApp desde una conversación asociada a `LeadIntake`, registra el envío como intento de contacto del lead. Actualiza `historial_contactos`, incrementa `num_contactos`, rellena `ultimo_contacto` y crea `LeadContactAttempt` con `canal=whatsapp`. No degrada estados ya avanzados (`cualificado`, `citado`, `acudio_cita`, `convertido`, `descartado`).
- `POST /api/intake/leads/:id/call-outcome` con `outcome=informacion` cierra el lead como `descartado` y persiste `motivo_descarte=solo_pidio_informacion`. La auditoría y la cancelación de recordatorios pendientes se mantienen.
- La migración `20260721121500-seed-lead-first-visit-whatsapp-template.js` añade al catálogo `clinicaclick_lead_primera_visita_programar`, plantilla `UTILITY` genérica para responder a una solicitud de primera visita. No crea ni modifica automatizaciones; la propagación usa el servicio estándar de plantillas.

## 2026-07-28 - Leads: comparativa operativa por grupo

`GET /api/intake/leads/stats` conserva los contadores históricos y añade
`competition` como bloque opcional reutilizable por otros paneles. El scope por
defecto compara solo clínicas del mismo grupo. Un usuario no global debe tener
acceso directo a la clínica seleccionada y permiso efectivo `leads.manage`;
recepción y administración pueden así consultar la comparativa agregada de las
sedes del grupo aunque su membresía operativa pertenezca a una sola clínica. El
endpoint no amplía el acceso a filas de leads ni a PII: únicamente abre nombres
de sede y métricas agregadas del ranking. Una clínica de BS Medical no se
compara con Propdental salvo que se implemente un scope global administrativo
explícito. Si no hay grupo o no hay al menos dos sedes comparables, el bloque
devuelve `ready=false` con `reason`.

La métrica principal es el tiempo hasta el primer contacto humano. Cuenta
`LeadContactAttempts` con `usuario_id` no nulo y también mensajes WhatsApp
outbound no fallidos en `Messages` cuando la conversación está vinculada al
lead o coincide por teléfono dentro de la misma clínica. Esto cubre mensajes
enviados desde Clinicaclick y ecos importados desde el móvil/WhatsApp conectado.
Quedan excluidas automatizaciones propias por `automation_delivery_key` o
metadata de Automatizaciones V2; si Meta expone un indicador explícito de
respuesta automática de WhatsApp Business, se trata igual que una
auto-respuesta. Como fallback operativo, si el lead ya tiene una cita vinculada
y no existe intento normalizado, la creación de esa cita cuenta como señal de
atención. Si hay auto-respuesta de leads y el paciente contesta después, el
reloj empieza en esa respuesta del paciente; si no contesta, el lead no se
marca como enfriado solo por el paso del tiempo desde la auto-respuesta. El
cálculo usa horario de clínica `ClinicaHorarios`; si alguna sede no lo tiene
configurado, se marca `business_hours_applied=false` y para esa sede se usa
tiempo natural como fallback visible.

El bloque también devuelve `appointment_conversion_rate`: porcentaje de leads
del periodo que han terminado en cita (`citado`, `acudio_cita`, `convertido` o
cita vinculada). Esta métrica mide efectividad de conversión a cita sobre el
total de leads, no volumen de citas.

La comparativa acepta periodo propio sin alterar los contadores superiores del
endpoint: la UI debe pedirla de forma explícita con `includeCompetition=true`;
si no llega ese flag, `competition` se devuelve como `null` y no se calcula el
ranking. Con `competitionMode=summary` devuelve solo el bloque compacto necesario
para el titular competitivo inicial. Con `competitionMode=full` devuelve ranking,
tarjetas y gráficas; por compatibilidad, `includeCompetition=true` sin modo
equivale a `full`. Con el flag activo acepta `competitionPeriod=30d|90d|365d`
o, para rangos explícitos, `competitionStartDate`/`competitionEndDate`. La
respuesta completa incluye `competition.period.key` y
`competition.trend.buckets`; cada bucket expone leads, contactos humanos,
tiempo medio, ratio dentro de objetivo, leads enfriados y conversión a cita. Si
hay clínica seleccionada, `trend.buckets` representa esa clínica;
`trend.group_buckets` queda disponible para usos agregados posteriores.

Para proteger rendimiento, la comparativa usa una ventana por defecto de los
últimos 30 días cuando la petición no trae rango temporal y se cachea por
usuario, grupo, clínica seleccionada y filtros ligeros. Las lecturas devuelven
valor cacheado si está fresco; si está obsoleto se devuelve stale y se refresca
en segundo plano. La UI puede repedir una vez cuando `refreshing=true`, pero no
debe hacer polling permanente.

## 2026-07-27 - Resumen ligero del calendario

`GET /api/citas/calendar` admite `summary=1` para indicadores agregados de la
agenda, como los puntos del minicalendario. Conserva el mismo scope ACL y los
mismos filtros de clínica, rango y paciente que la respuesta completa, pero
selecciona únicamente `clinica_id`, `doctor_id`, `instalacion_id` e `inicio`.

La respuesta añade `inicio_local`, calculado con la zona horaria de cada clínica,
para agrupar por día sin desplazar citas cercanas a medianoche. No incluye
paciente, tratamiento, notas, flujos, consentimientos ni otras relaciones. La
cabecera `X-Agenda-Endpoint: calendar-summary` permite identificar esta variante
en QA y trazas. La agenda diaria y el drawer continúan usando el contrato
completo.

## 2026-07-28 - Resenas: colas y clasificacion de respuestas

Las colas manuales de resenas mantienen dos acciones distintas:

- pausar: `POST /api/marketing/bulk-sends/campaigns/:id/cancel` conserva el
  estado historico `paused`/`dispatch.cancelled` por compatibilidad y retiene
  los pacientes pendientes;
- cancelar cola: `DELETE /api/marketing/bulk-sends/campaigns/:id` archiva la
  lista, marca `dispatch.status=archived` y libera pacientes pendientes para
  una nueva seleccion. El worker de `marketing_bulk_send_dispatch` corta tambien
  un lote en curso si detecta la lista archivada.

`getReviewRequestedPatientIds` considera `l.status='paused'`, por lo que una
cola pausada no devuelve pacientes al pool. Las colas `archived` quedan fuera
del pool y de las metricas activas.

`materializeInboundReply` sigue usando primero reglas deterministas para
valoraciones `1-5`. Se anade reconocimiento de expresiones largas tipo
`os doy un 5`. Si no hay nota determinista y el mensaje responde a una solicitud
de resena, se llama a un fallback Groq-compatible (`REVIEW_RATING_AI_MODEL`,
por defecto `GROQ_MODEL_FAST`) enviando solo el texto del inbound, sin nombre ni
telefono. Solo se acepta si devuelve `rating` entero `1..5` con confianza >=
`REVIEW_RATING_AI_MIN_CONFIDENCE` (0.78 por defecto). El evento conserva
`inference_source`, `inference_confidence` y `inference_model`.

## 2026-07-31 - Busqueda de pacientes y apertura auditada de WhatsApp

`GET /api/pacientes/contact-targets` resuelve candidatos sin exponer un censo
completo. Acepta telefono exacto normalizado o prefijos de nombre/apellidos,
aplica ACL de `patients.sensitive.view` y limita la consulta a clinica o grupo
autorizado. No usa comodines iniciales. Los indices
`idx_pacientes_phone`, `idx_pacientes_name_surname` e
`idx_pacientes_surname_name` sostienen este contrato.

La busqueda existente de conversaciones tambien evita escaneos correlacionados
de `MarketingPatientListItems`: resuelve una vez las coincidencias externas por
scope y prefijo, apoyada por los indices `(clinica_id,name)` y
`(clinica_id,email)`. La QA de desarrollo deja telefono y nombre conocidos en
decenas de milisegundos; el frontend cancela peticiones anteriores y no hace
polling con una consulta activa.

`POST /api/conversations/start-patient-contact` crea de forma transaccional la
ficha minima solo cuando no existe, la autorizacion operativa y la conversacion
canonica. `PatientOperationalEvents` es un registro append-only del alta y del
inicio de contacto: conserva usuario, clinica, paciente, origen y metadata sin
convertir la declaracion puntual del operador en consentimiento comercial
global. Los origenes actuales son `patient_list`, `agenda`, `lead_conversion`,
`header_search` y `quick_chat`.

La familia generica `clinicaclick_abrir_con_saludo` queda separada de resenas y
automatizaciones. Meta rechazo el cuerpo inicial por exceso de variables para
su longitud; la version que se propaga tras ese rechazo es
`¡Hola {{1}}! Soy {{2}} de {{3}} 😊 ¿Te puedo escribir por aquí para ayudarte
con cualquier duda o consulta que tengas?`. Las tres
variables son paciente, usuario y clinica. Las clinicas sin WABA conservan un
placeholder `SIN_CONECTAR`; las conectadas generan su version tecnica mediante
la cola durable estandar y nunca envian un mensaje durante la propagacion. Una
copia aprobada anterior sigue utilizable mientras Meta revisa la nueva version.

Las importaciones de resenas/reactivacion tratan fecha y tratamiento como datos
de segmentacion. `buildImportedItemPayloads` no crea `CitasPacientes` por
defecto: solo lo haria si un flujo futuro envia el booleano estricto
`create_historical_appointments=true`; valores ausentes, falsos o la cadena
`"true"` no activan el comportamiento. La UI actual no envia ese opt-in.

La limpieza correctiva del 2026-07-31 retiro 4.427 citas artificiales del grupo
Propdental identificadas exclusivamente por `estado=completada`, titulo
`Historico:*` y motivo `Importacion de pacientes para reactivacion`: 1.095 de
Sant Marti, 506 de Eixample y 2.826 de Glories. Antes de borrar, el script
comprobo todas las FK y no encontro dependencias. El backup restaurable con
permisos `0600` esta en
`/home/ubuntu/secure-imports/clinicaclick-cleanups/propdental-all-imported-history-2026-07-31T16-55-31-910Z.json`.
Auditoria: `node src/scripts/cleanup-propdental-future-imported-historical-appointments.js --all-imported-history`.
Restauracion: el mismo script con `--restore=<ruta>`.

## 2026-07-31 - Horarios Google one-shot y busquedas locales comparables

### Horarios especiales de Google: endpoint directo vigente y rutas V2 legacy

Desde 2026-08-01 el producto ya no crea horarios especiales de Google como
Automatizaciones V2. La UI de `Perfil Google > Horarios` usa el publicador
directo `PUT /api/local/clinica/:clinicaId/special-hours`, que valida y publica
el plan completo `specialHoursPlan` contra Google. No se crean `JobRequest`,
`FlowExecutionV2` ni tarjeta en `Automatizaciones disponibles` para este caso.

Quedan rutas V2 one-shot como compatibilidad tecnica/legacy, pero no forman
parte del flujo de producto actual:

Las rutas de lectura/escritura son:

- `GET /api/local/clinica/:clinicaId/special-hours/automations`;
- `POST /api/local/clinica/:clinicaId/special-hours/automations`;
- `PATCH /api/local/clinica/:clinicaId/special-hours/automations/:publicId`.

Las escrituras reutilizan la autorizacion de la ficha efectiva/compartida. El
servicio crea transaccionalmente una plantilla gestionada
`managed_feature=google_special_hours`, version, ejecucion y `JobRequest`. El
grafo es `scheduled_once -> delay/wait_until ->
action/update_google_special_hours -> control/end`; la fecha se convierte desde
la zona horaria IANA de la clinica y no desde la zona del servidor. Backend
exige que el inicio sea posterior al dia local actual; un payload directo no
puede convertir una programacion pasada o del mismo dia en una publicacion
inmediata accidental.

`action/update_google_special_hours` admite simulacion, rechaza una plantilla
inactiva y llama al publicador canonico de Perfil Google. La mezcla de periodos
preserva los futuros no solapados y aplica el nuevo periodo en los dias
coincidentes. Tras publicar registra `last_executed_at` y desactiva la plantilla.
Una ejecucion completada no admite reactivacion. Pausar cancela ejecucion/job
pendientes; reanudar materializa una ejecucion nueva sobre la version existente.

Este flujo queda documentado como legado. El catalogo admin sigue siendo la
fuente de las familias reutilizables, como resenas y respuesta a leads, no de
ejecuciones one-shot con datos fechados.

### Busquedas guardadas del mapa de calor

La API anade:

- `GET /api/marketing/reports/competition/local-heatmap/searches`;
- `POST /api/marketing/reports/competition/local-heatmap/searches`;
- `DELETE /api/marketing/reports/competition/local-heatmap/searches/:searchId`.

`MarketingCompetitionHeatmapSearches` guarda termino/radio por clinica. Existe
una opcion incluida no eliminable y las busquedas adicionales son eliminables.
La API valida scope, normaliza terminos y no ejecuta el proveedor al guardar:
la medicion se solicita despues mediante el endpoint existente de heatmap.

`MarketingCompetitionHeatmapSnapshots` conserva una instantanea semanal por
clinica, termino normalizado, radio y semana. El servicio compara una medicion
con la semana anterior equivalente y expone por punto
`position_delta = previous_position - current_position` y
`position_change` (`+N`, `-N` o `=`). Si falta una posicion comparable el
delta queda nulo. La retencion actual es de 180 dias; los indices unicos evitan
duplicar tanto busquedas como semanas durante peticiones concurrentes. Una
lectura de cache valida materializa idempotentemente su instantanea, de modo que
las caches anteriores al despliegue sirven como primer punto de comparacion.

Migracion: `20260731170000-create-marketing-heatmap-search-history.js`. Pruebas
de contrato: `google_special_hours_automation.test.js` y
`marketing_competition_heatmap_cache.test.js`.

## 2026-08-01 - Respuestas de reseñas y logo desde Perfil Google

`/api/local/clinica/:clinicaId/reviews/:reviewId/reply` permite crear o editar
la respuesta pública de una reseña usando Google Business Profile
`reviews.updateReply`. La ruta exige JWT, scope de marketing de escritura y
permisos sobre la ficha efectiva si está compartida. Tras la confirmación de
Google actualiza `BusinessProfileReviews.reply_comment`,
`reply_update_time`, `has_reply` y `raw_payload.reviewReply`; no espera al
siguiente job de sincronización para que la UI refleje el cambio. Existe
`DELETE /api/local/clinica/:clinicaId/reviews/:reviewId/reply` como operación
técnica de corrección.

`POST /api/local/clinica/:clinicaId/import-logo` toma una foto ya sincronizada
desde la ficha de Google marcada como `LOGO` o `PROFILE` y copia su URL a
`Clinicas.url_avatar`. No sube datos clínicos ni toca `CLINICAL_STORAGE`; el
logo de clínica sigue clasificado como asset público/branding. La acción no
publica nada nuevo en Google.

La futura funcionalidad de revisión de reseñas negativas debe modelarse como
cola interna de triaje legal/ops, no como borrado automático: el backend puede
calcular candidatas por baja puntuación, ausencia de texto, posible mención de
datos personales o señales de incumplimiento, pero la denuncia real depende de
las políticas de Google y del resultado de cada caso.

## 2026-08-03 - Orden cronologico y actividad compartida en conversaciones

Los endpoints de conversaciones (`GET /api/conversations`, `/:id/messages`,
`/by-patient/:patientId` y `/by-lead/:leadId`) ordenan los mensajes por
`COALESCE(Messages.sent_at, Messages.createdAt)`. `Messages.sent_at` es la hora
real del proveedor o del eco de WhatsApp móvil; `createdAt` solo indica cuándo
se materializó en nuestra base de datos. No usar `createdAt` como orden primario
en chats reales, porque los ecos `smb_message_echoes` y la sincronización de
historial pueden entrar minutos u horas después y romper el orden visible.

La búsqueda de conversaciones externas también resuelve nombres procedentes de
`MarketingPatientListItems` aunque el item pertenezca a otra clínica: primero se
obtiene el teléfono del contacto y después el `GET /api/conversations` mantiene
el filtro final por las clínicas visibles. Esto permite buscar por el mismo
nombre que QuickChat ya muestra en una conversación visible, sin abrir
conversaciones fuera del scope autorizado.

QuickChat y el drawer de Leads deben consumir la misma actividad canónica de
citas. Los cambios de estado de cita se escriben en `PatientOperationalEvents`
mediante `appointmentActivity.service.js`; el runtime V2 ya usa
`recordAppointmentStatusChange`, y las rutas manuales deben hacerlo también. Si
una cita aparece confirmada pero no hay evento append-only, la UI no debe
inventarlo: hay que corregir el camino que cambió el estado o backfillear el
evento con auditoría explícita.

`GET /api/pacientes/:id/activity` devuelve la línea temporal en orden
cronológico ascendente, igual que el drawer de Leads. Las pantallas pueden
agruparla visualmente, pero no deben invertirla por defecto: lo más antiguo va
arriba y lo más reciente abajo.

Caso verificado: conversación `6544` / Juan Francisco / Propdental Nou Barris.
La API devuelve los ecos móviles `70663`, `70647`, `70683` ordenados por
`sent_at` (`13:24:25`, `13:24:28`, `13:24:34`) aunque sus `createdAt` fueran
posteriores y desordenados. Los envíos automáticos fallidos de esa cadena fueron
aceptados inicialmente por Meta y después devueltos con `131026 Message
undeliverable`; no fue un bloqueo de quiet hours ni ausencia de disparo del
flujo. También se backfilleó el evento operativo `appointment.status_changed`
faltante de la cita `74577` para reflejar el cambio manual a
`recordatorio_confirmado` hecho el `2026-08-03 15:20:07 UTC`.
