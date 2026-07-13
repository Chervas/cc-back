# Runbooks operativos del backend

Este índice separa la arquitectura general de los procedimientos que deben usarse para operar o verificar Marketing. La fuente canónica de arquitectura es `src/Documentacion/13-backend.md`; su copia en el repositorio frontend es un espejo completo para conservar enlaces internos y debe sincronizarse después de cada cambio.

## Marketing, intake y Google Ads

| Documento | Cuándo usarlo |
|---|---|
| [Google Data Manager: conversiones server-side](./google-data-manager-conversions.md) | Contrato de transporte, Conversiones mejoradas, Consent, evidencia controlada, estados asíncronos, reconciliadores y runbook de atribución real. |
| [Política de goals Google Ads v4](./google-ads-goal-policy-v4.md) | Custom goals, cohortes, lifecycle, aprobaciones, executor y límites entre `connect_only` y `managed_service`. |
| [Google Ads Standard Access](./google-ads-standard-access.md) | Límites de acceso/proveedor y resumen externo del diseño actual. |
| [E2E controlado de intake y limpieza](./intake-e2e-cleanup.md) | Formulario/chat/teléfono, routing estricto, datos sintéticos y limpieza segura. |

## Orden de verificación

1. Para una incidencia de entrada o sede incorrecta: `intake-e2e-cleanup.md` y la sección de routing autoritativo en `src/Documentacion/13-backend.md`.
2. Para una conversión que no aparece: `google-data-manager-conversions.md`; distinguir intake, intento local, aceptación, Diagnostics terminal y reporting atribuido.
3. Para objetivos o pujas: `google-ads-goal-policy-v4.md`; readiness de conversiones no autoriza una mutación de campaña.

No se deben interpretar un HTTP 200, una acción secundaria creada o un snapshot `activation_readiness` verde como Piloto automático activo. Propdental continúa en `connect_only` hasta que exista y se apruebe una orden gestionada separada.

En producto, `connect_only` se llama **Conecta y mejora**: conecta cuentas existentes, importa/unifica leads, atribuye su ciclo, envía conversiones consentidas mejoradas/offline y muestra diagnósticos/recomendaciones. No cambia campañas, custom goals, pujas, presupuesto ni estados.

Estado desplegado 2026-07-13: el catálogo tiene 30 tareas periódicas y 5 integraciones dirigidas/background bajo `JobRequest`; el executor registra 46 handlers. También son durables `automation_whatsapp_quiet_send` y `whatsapp_template_sync_delayed`: no esperan mediante `delay` de BullMQ y sus payloads no guardan PII ni tokens. `pm2-back-staging` opera con cron leader + worker; las cinco líneas OPS se retiraron del crontab. `#23664-#23670` validaron los bridges y `payloadDefaults`; `#23672` completó la retención real. `SyncLogs` (auditoría funcional BD) y ficheros PM2 (stdout/stderr, 60 días) son retenciones independientes.

Fix Enhanced desplegado: el normalize/merge de activos efectivos conserva flags y autorización Enhanced en top/event/destino. Los leads `#7200/#7202/#7203` fueron previos y viajaron sin identificadores. La prueba controlada `#22` ya acredita `user_data_sent=true`, dos hashes `[email, phone]`, un registro recibido y cero warnings; terminó `INVALID_GCLID` porque el click ID era sintético. Esto prueba transporte/procesamiento, no atribución. `#23779/#65252` comprobó un intento a las `23:30:04 UTC` y mantuvo `#20` en `PROCESSING`, `record_count=0`, sin errors/warnings; el cierre real espera un lead paid consentido con click ID válido.

Release actual: backend staging `9643fb8`, frontend `b796439c`, build `60e0edc03c6c9306`. Consent v5 está live y el QA móvil confirmó `Aceptar todo` concediendo `ad_user_data` + `ad_personalization` y chat esperando desde la resolución del aviso. Propdental sigue en **Conecta y mejora**; no se activa Piloto ni se cambian goals, pujas o presupuesto. Meta Francia no tiene todavía cuenta publicitaria/píxel configurados. `Conseguir más reseñas` está cerrado/listo.

Feedback de calidad: pasar un lead a `descartado` requiere `motivo_descarte` y deja auditoría. `tratamiento_no_ofrecido` y `consulta_no_asistencial` son dos opciones visibles, no un enum backend cerrado: primero se comprueba catálogo/derivación o circuito interno. El motivo sirve para diagnóstico y recomendaciones; nunca se adjunta a Google/Meta como texto del paciente.
