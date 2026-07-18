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

Estado 2026-07-18:

- backend integrado en `dev` hasta `6533357` y staging hasta `0d42abb`;
- migraciones `19000..25000` aplicadas tras backup; 17 tablas y cinco
  plantillas; cero policies/bindings reales creados;
- gates de staging: editor para scopes Propdental y publicación solo
  `group:5` mediante `MARKETING_WEB_PUBLISHING_SCOPES`;
- plugin WordPress `2.0.0-alpha.5` instalado/activo en Propdental junto al
  legado `1.1.7`, con un único loader/bootstrap;
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
- hosted/custom domain no están disponibles;
- un WordPress compartido por varias clínicas exige multi-route antes de
  ampliar el piloto, y la rotación Ed25519 operativa sigue siendo gate de GA.

Evidencia: suite backend Web 188/188; contratos WordPress 22/22 y artefacto/
plugin 22/22, además de readback, lead/limpieza y rollback públicos descritos.

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

Estado de arquitectura del corte anterior (2026-07-16): el catálogo tenía 30 tareas periódicas y 48 handlers. Tras integrar Web/Campañas el arranque de staging registra 32 tareas; la publicación y los destinos continúan dentro del mismo `JobRequest`, nunca en un cron paralelo. El detalle histórico siguiente sobre outbox/retención se conserva: también son durables `marketing_competition_heatmap_refresh`, `automation_whatsapp_quiet_send`, `whatsapp_template_sync_delayed` e `intake_quickchat_summary_materialize`. Este último es un outbox de prioridad alta compartido por `source_detail=chatbot` y `chatbot_quickchat`: cada payload aceptado conserva en una transacción su audit exacto y job, tanto para un lead nuevo como para uno deduplicado. El JobRequest solo guarda `lead_id + audit_id` más el namespace técnico añadido por la cola; la sede validada queda en `audit.attribution_steps.resolved_clinic_id`. El handler exige esa sede y un mismatch con el lead termina `409` sin Message/socket; solo audits legacy sin marcador caen de forma segura en la clínica del lead. `Messages.metadata.intake_audit_id` impone orden durable: bajo lock del lead, el audit mayor gana y cualquier job antiguo completa como `skipped/stale` sin cambiar contenido, socket ni `last_message_at`; el watermark avanza aunque hash/contenido sean idénticos y un mensaje legacy idéntico adopta el primer marcador. El fast path admite el `result_summary` envuelto por `JobExecutor` y el formato directo compatible de callers/tests, devuelve `saved=true` solo si terminó, `202 + queued` si queda reintentable y preserva `4xx` seguros como el `409` de sede. Si falla el disparo, relee `JobRequest`; si tampoco puede releerlo responde `202 unknown_durable`, no inventa `pending`. Un `chatbot` deduplicado termina con ese outcome antes de Meta/Google para no duplicar conversiones, mientras los demás dedupes conservan `409`. Teléfonos fuera de 9–15 dígitos y emails presentes inválidos devuelven `422` antes de confirmar el lead. `pm2-back-staging` opera con cron leader + worker; las cinco líneas OPS se retiraron del crontab. `#23664-#23670` validaron los bridges y `payloadDefaults`; `#23672` completó la retención real. `SyncLogs` (auditoría funcional BD) y ficheros PM2 (stdout/stderr, 60 días) son retenciones independientes.

Fix Enhanced verificado: el normalize/merge conserva flags y autorización en top/event/destino. La prueba controlada `#22` acreditó formato/transporte; después, siete intentos naturales `#25/#26/#27/#28/#30/#32/#33` de `1851215478` terminaron `succeeded/SUCCESS` con consentimiento, `user_data_sent=true` y `[email, phone]`. `5992356722` mantiene acciones/readiness y `validateOnly` verdes, pero todavía no un terminal natural posterior a la migración. Las ocho acciones canónicas siguen secundarias, fuera de `Conversions` y con default Google `0`: Mide y entiende enriquece atribución, pero no gobierna la puja.

Auditoría Google live 2026-07-16: las campañas heredadas continúan optimizando acciones legacy; Badalona Search presenta fuerza `POOR`, hay bolsas de keywords con score `<=4`, los ocho asset groups PMax revisados están `AVERAGE`/varios limitados, y las cuatro Smart de `599...` mantienen `TARGET_SPEND` y goals antiguos. La auditoría durable diaria incorpora ahora calidad de campaña read-only: 3 targets Conecta y mejora, 0 goal-policy; el grupo Propdental quedó con medición saludable, `runtime_ready=true` y 8/8 destinos válidos. El primer corte observó 30/30 campañas del snapshot de estrategia; al unir estrategia y campañas autorizadas por medición, el segundo corte observó **35/35** referencias únicas —17 en `185...` y 18 en `599...`—, incluyó las cuatro Smart y devolvió 0 críticos + 92 recomendaciones consultivas. Ambos cortes declararon cero mutaciones y `ChangeEvent=0`. Francia quedó en 4/10 y Eixample en 0/4 por cuentas no asignadas a esos scopes. La calidad no bloquea por sí sola el runtime de medición. `call_reporting_enabled=false` en ambas cuentas sin borrar teléfonos, assets ni histórico. Cualquier corrección de objetivos/campañas pertenece a un Piloto aprobado, no a `connect_only`.

ACL operativa: agencia es marketing-only y solo recibe atribución/pacientes/leads seudonimizados dentro de scopes explícitos. No abre PII, Chat/Registro, QuickChat, Agenda/citas, consentimientos, Personal/equipo, settings, instalaciones, nutrición, dashboard operativo o fusiones. `reception`/`admin_staff` conservan `clinic.settings.edit` + `team.manage` local, pero nunca gestionan owners; backend preserva `owner_membership_manage_forbidden` y `owner_unlink_forbidden`.

Release funcional histórica previa a Web: backend staging `9b82958`, frontend
`3c4593ae`, build `8ca8e450c563e9ee`. El corte Web actual está documentado
arriba (`0d42abb` backend; frontend staging `ca2e5e8a`, build
`d7dabcf5fb4f8963`). Consent v5 sigue vigente. Propdental continúa en
`connect_only`; no se activa Mejora/Piloto ni se cambian goals, URLs, pujas o
presupuesto. Meta Francia no tiene todavía cuenta publicitaria/píxel
configurados. `Conseguir más reseñas` está cerrado/listo.

QA público postdeploy: un chat móvil controlado con Marketing rechazado y sin click IDs seleccionó Sant Martí `56`; `chatbot` respondió `201`, `chatbot_quickchat` deduplicó con `200`, y los outbox `#23818/#23819` completaron al primer intento sobre los audits `#7400/#7401`, una conversación y un único mensaje con watermark `7401`. Hubo cero intentos Google. El lead sintético `#7213` pasó después por `dry-run -> simulate -> apply`; el postcheck comprometido dejó cero restos. Los chats reales huérfanos `#7185/#7195/#7196` se recuperaron exclusivamente mediante los jobs estándar `#23820-#23822`: una conversación/resumen por lead, sede Sants `19`, un intento por job y la cuenta de intentos publicitarios permaneció `3 -> 3`.

Feedback de calidad: pasar un lead a `descartado` requiere `motivo_descarte` y deja auditoría. `tratamiento_no_ofrecido` y `consulta_no_asistencial` son dos opciones visibles, no un enum backend cerrado: primero se comprueba catálogo/derivación o circuito interno. El motivo sirve para diagnóstico y recomendaciones; nunca se adjunta a Google/Meta como texto del paciente.
