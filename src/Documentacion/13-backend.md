> **Módulo:** Arquitectura del Backend
> **Última actualización:** 2026-04-15
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
- El feedback positivo de ejemplo no se devuelve; cuando se reactive debe venir como señal real atribuible a ClinicaClick.

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
- `feature_key`: `marketing`, `clinic.settings.edit`, `team.manage`, `billing.reports.view`, `patients.view`, `patients.edit`, `appointments.view`, `appointments.manage`, `consents.manage`, `quickchat.read_patients`, `quickchat.read_team`, `quickchat.read_leads`, `nutrition.workspace.view`, `nutrition.measurements.create`, `nutrition.reports.finalize`.
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
- Agenda separa lectura y escritura: `appointments.view` permite abrir la vista de agenda en frontend; `appointments.manage` se reserva para mutaciones reales de cita (`POST /api/citas`, `PATCH /api/citas/:id/estado`, `PATCH /api/citas/:id/nota` y `PATCH /api/citas/:id/reagendar`). Las lecturas de agenda quedan fuera de este permiso de escritura.
- Nutrición consume estos permisos en backend: `nutrition.workspace.view` protege la ficha, informes HTML y PDF; `nutrition.measurements.create` protege alta de mediciones y snapshots persistidos, siempre junto a `nutrition.workspace.view`; `nutrition.reports.finalize` protege el cierre de informes como snapshot final. Por defecto propietario y doctor pueden cerrar informes; auxiliar puede registrar mediciones pero no cerrar informes salvo override.
- Consentimientos consume `consents.manage` de forma parcial en adjuntos clínicos: los assets `consent_document_pdf` se listan/descargan desde `GET /api/pacientes/:id/clinical-attachments` solo si el rol tiene esa capacidad. Las acciones internas de `/api/consentimientos/*` siguen pendientes de enforcement granular por esta misma capacidad.
- QuickChat consume `quickchat.read_patients`, `quickchat.read_team` y `quickchat.read_leads` en `GET /api/conversations/permissions` para mostrar u ocultar pestañas según el scope activo. El acceso a conversaciones sigue validando pertenencia a clínica; el endurecimiento por categoría en todos los endpoints de mensajes queda como siguiente capa si se quiere convertir estas capacidades en ACL estricta de lectura.

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
| `GET /api/pacientes/:id/clinical-attachments/:attachmentId` | Operativo V1 dev | Sirve un asset clinico privado por `public_id` o `id`, con `Cache-Control: private, no-store` y sin URL publica. |
| `GET /api/pacientes/:id/activity` | Operativo V1 dev | Incluye eventos `nutrition_report_finalized` para informes finales de Nutricion cuando el rol puede ver `nutrition.workspace.view`. |
| `GET /api/especialidades/area-contracts` | Operativo V1 dev | Devuelve contrato versionado por area medica para catalogo, agenda y workspaces: perfil de tratamiento, ejemplos de servicio, pasos de alta, secciones de contrato, reglas estructuradas de protocolo, accion clinica de agenda y opciones/schemas especificos de Nutricion. |
| `GET /api/especialidades/area-contracts/:code` | Operativo V1 dev | Devuelve el contrato de un area concreta con fallback `general`. |
| `PUT /api/especialidades/area-contracts/:code` | Operativo V1 dev | Persiste override del contrato de un area medica en `MedicalAreaContracts` manteniendo fallback al contrato base. |

Contrato:

- `Tratamientos.clinical_config` guarda configuracion clinica por area. Para Nutricion se usa `clinical_config.nutrition.service_kind` (`consultation`, `follow_up`, `quick_measurement`, `isak_study`, `nutrition_plan_pack`) y `clinical_config.nutrition.measurement_profile_code` con `none`, `quick` o `express_isak`.
- `Tratamientos.clinical_config.appointment_type_prices` puede guardar overrides opcionales de precio por tipo de cita con claves `primera_con_trat`, `continuacion`, `revision` y `urgencia`. Agenda usa ese importe como propuesta visual cuando existe; si falta, usa `Tratamientos.precio_base`. No aplica a `primera_sin_trat` porque no hay tratamiento/servicio asociado.
- El contrato de area medica se sirve desde backend como `medical-area-contracts-v1`. La tabla `MedicalAreaContracts` permite overrides por `code`; si no hay override o la tabla aun no existe en un runtime, el servicio vuelve al contrato base estatico. El front conserva fallback local para tolerar runtimes sin endpoint. El contrato incluye `patient_workspace` para indicar si un area activa debe abrir una pestaña clinica propia en ficha de paciente; Nutricion activa `nutricion` y Capilar deja `capilar` definido pero desactivado hasta crear el workspace real. Tambien incluye `appointment_action` para que agenda lea etiqueta, detalle, icono, ruta y si requiere perfil clinico desde backend en vez de hardcodearla en Angular. Desde 2026-07-06 incluye `protocol_rules`: reglas estructuradas con origen, destino, espera minima, condicion, accion y alcance para que `/areas-medicas-admin` gobierne dependencias/protocolos sin depender de texto libre.
- En Nutricion, cada `nutrition_service_kind_options` incluye defaults operativos para el alta de tratamiento: `recommendedName`, `defaultCategory`, `recommendedProfile`, `defaultGenerateReport`, `defaultComparePrevious` y `defaultSessions`. Los overrides parciales de `MedicalAreaContracts` se normalizan por `value` contra el contrato base para no perder defaults ni borrar otras opciones de servicio.
- Nutricion declara en ese contrato `nutrition_measurement_profile_options`, `nutrition_measurement_profile_schemas` y `nutrition_measurement_fields`. Cada grupo de schema puede declarar `required_fields`: el normalizador los reinyecta si un override antiguo o manual intenta quitarlos, porque sostienen calculos como IMC, somatotipo y diametros/perimetros corregidos. El perfil tecnico `express_isak` se muestra como `Completa` e incluye tambien campos avanzados opcionales para Kerr-Ross (`sitting_height_cm`, `head_cm`, perimetros de antebrazo/muslo/torax, diametros biacromial/biiliocrestal y diametros toracicos). El workspace nutricional consume esos campos para devolver `profiles` y `fields`, normalizar `raw_values_json`, validar requeridos/rangos y renderizar informes con labels vigentes. `POST /api/pacientes/:id/nutrition-measurements` rechaza perfiles incompletos con `missing_required_measurement_fields`. Los codigos tecnicos de perfiles/campos permanecen cerrados en esta fase para no romper formulas ni historico; los nombres visibles no deben usar marcas de terceros.
- El contrato base de Nutricion expone ejemplos de servicio cobrable (`Consulta nutricional`, `Valoracion nutricional`, `Seguimiento nutricional`, `Estudio antropometrico completo`, `Plan de seguimiento mensual`) para que el catalogo no empuje a crear tratamientos llamados `Primera cita` o `Revision`.
- Al crear una especialidad profesional propia de clínica o añadir una especialidad de sistema a una clínica, los endpoints de especialidades devuelven `disciplinas` con la lista actualizada de áreas médicas de la clínica, normalizada en minúsculas y sin duplicados. El frontend usa esa lista para mostrar áreas activas formateadas y no inferir estados intermedios.
- `PatientNutritionMeasurements` guarda mediciones por `patient_id`, `clinic_id`, `professional_id`, `appointment_id`, `treatment_id`, `profile_code`, `raw_values_json`, `calculated_values_json`, `formula_version` y `quality_flags_json`.
- El motor `nutrition-basic-v3` calcula en backend IMC, ratio cintura/cadera, suma de pliegues, perimetros corregidos, somatotipo Heath-Carter cuando hay datos suficientes, composicion corporal estimada con ecuacion seleccionable, fraccionamiento Kerr-Ross de cinco componentes cuando esta completo el bloque avanzado y proyeccion lineal simple con las ultimas dos mediciones. Las mediciones historicas pueden conservar `nutrition-basic-v1` o `nutrition-basic-v2` en su snapshot.
- Workspace e informes exponen `calculation_profile=clinicaclick-anthropometry-v3`: la formula guardada por defecto de masa grasa es Durnin-Womersley + Siri, pero `render`/`pdf` aceptan recalculo bajo demanda con Faulkner, Jackson-Pollock 4 sitios, Katch-McArdle, Sloan, Withers, Yuhasz-Carter o Slaughter. Heath-Carter, Kerr-Ross y proyeccion lineal siguen siendo bloques automaticos de calculo/trazabilidad.
- El contrato de workspace e informes incluye `formula_references` con bases publicas/metodologicas usadas por `nutrition-basic-v3` para que el frontend y el HTML/PDF puedan mostrar la trazabilidad de calculo. Incluye IMC, perfil antropometrico completo, somatotipo Heath-Carter, la ecuacion de masa grasa aplicada en ese informe, Kerr-Ross cinco componentes y la proyeccion lineal simple propia.
- Informes V1 se materializan en `PatientNutritionReports` como snapshot JSON/HTML con `snapshot_hash`, `formula_version`, `report_type`, `measurement_id`, `patient_id`, `clinic_id`, `appointment_id` y `treatment_id`. Al crear una medicion se intenta crear automaticamente el snapshot activo; `POST /api/pacientes/:id/nutrition-measurements/:measurementId/report/snapshot` permite materializarlo para mediciones antiguas. `POST /api/pacientes/:id/nutrition-measurements/:measurementId/report/finalize` crea un snapshot `final`, marca los borradores `active` como `superseded` y anota `finalized_by/finalized_at`; render y PDF priorizan siempre `final` sobre `active`. El contrato de workspace/informe expone `clinical_storage` para indicar `clinical_private`, snapshot privado en base de datos y `public_media=false`. Desde `ClinicalPrivateAssets`, el primer PDF solicitado de un informe `final` se cachea como asset clinico privado (`PatientNutritionReports.pdf_asset_id`) y las siguientes descargas leen ese binario privado; los borradores siguen generandose bajo demanda. No usar `PUBLIC_MEDIA` para informes, fotos clinicas ni datos antropometricos identificables.
- `GET /api/pacientes/:id/nutrition-measurements/:measurementId/report/render` y `/report/pdf` aceptan `compare_measurement_id=<measurement_id>` para renderizar HTML/PDF contra una medicion concreta y `compare_measurement_id=none` para generar el documento sin comparativa. Tambien aceptan `fat_mass_equation=<code>` para recalcular masa grasa con otra ecuacion disponible. Cuando se usa comparacion o ecuacion alternativa, el backend renderiza bajo demanda y no reutiliza ni reescribe snapshots finales; asi la UI puede cambiar la comparacion/formula sin romper la inmutabilidad clinica del informe cerrado.
- El HTML/PDF de Nutricion debe ser entendible por paciente no tecnico: fraccionamiento molecular/tisular incluye explicaciones cortas, la distribucion adiposa/muscular diferencia `Actual` y `Comparacion` y la somatocarta mantiene etiquetas y valores separados para evitar solapes. La imagen central de distribucion solo localiza zonas; las barras son la fuente visual de valores. Desde `snapshot_version=14`, las cabeceras visuales no incluyen captions bajo la ilustracion, distribucion usa una cabecera visual consistente, cada tejido muestra su barra debajo del texto propio con ilustracion grande, las siluetas de somatotipo usan fondo transparente sin tarjeta blanca alrededor y las comparativas de un solo grupo ocupan todo el ancho para evitar columnas vacias.
- Los assets visuales estaticos del informe viven en `src/assets/nutrition/images` y se embeben como `data:` dentro del HTML/PDF generado por backend. Son ilustraciones genericas sin dato clinico ni paciente; no van a `PUBLIC_MEDIA`. El video de pliegue subido como referencia queda fuera del informe hasta cerrar una ayuda interactiva especifica de mediciones.
- `GET /api/paneles/main` devuelve `inactiveTodayAppointments` además de `todayAppointments`. `todayAppointments` conserva solo citas activas esperadas y no vencidas; `inactiveTodayAppointments` recoge citas del día cerradas, canceladas o reprogramadas para que el frontend explique estados vacíos sin contarlas como citas esperadas. Las citas abiertas vencidas salen en `pastAttendancePending`.
- Para roles `paciente` y `laboratorio`, `GET /api/paneles/main` no entrega bloques internos de clínica: no carga citas operativas, oportunidades, alertas, errores de configuración ni tareas. El aislamiento se aplica en backend aunque el frontend también oculte esas secciones.
- `ClinicalPrivateAssets` es la tabla base para binarios clinicos privados: PDFs finales cacheados, fotos clinicas de Nutricion y futuros adjuntos de historia. En dev usa provider `local_private` con raiz configurable `CLINICAL_PRIVATE_STORAGE_ROOT` y fallback fuera del checkout (`../clinical-private-storage`). El contrato esta preparado para migrar a S3 privado sin exponer URL publica.
- Las fotos clinicas de Nutricion se guardan con `purpose=nutrition_clinical_photo`, `owner_type=patient_nutrition_measurement`, `owner_id=<measurement_id>`, `patient_id` y `clinic_id`. Listado y descarga quedan protegidos por `nutrition.workspace.view`; subida queda protegida por `nutrition.measurements.create`.
- La pestana `Adjuntos` del paciente consume `GET /api/pacientes/:id/clinical-attachments`. El backend filtra por permisos segun `purpose`: `nutrition_report_pdf` y `nutrition_clinical_photo` requieren `nutrition.workspace.view`, `consent_document_pdf` requiere `consents.manage`, y `clinical_attachment` requiere `patients.view`. La subida general queda pendiente hasta cerrar categorias clinicas y permisos de escritura; no se debe volver al mock ni a `PUBLIC_MEDIA`.
- `GET /api/pacientes/:id/activity` expone cada informe final como evento `nutrition_report_finalized`, con titulo, icono, resumen de medicion/servicio/formula/hash y actor de cierre. El evento solo se adjunta si el usuario tiene `nutrition.workspace.view` en la clinica del paciente, para que QuickChat, agenda y la ficha del paciente compartan la misma actividad sin duplicar consultas en Angular.
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
- `whatsapp_phones_sync` (cada 15 minutos) actua como red de seguridad: si detecta que un numero ya esta `CONNECTED`/`registered` y quedan plantillas de catalogo sin `meta_template_id` o en `SIN_CONECTAR`/`LOCAL_PENDING`, encola `whatsapp_template_create` con cooldown de 1 hora (`WHATSAPP_TEMPLATE_CREATE_ENSURE_COOLDOWN_MS`). Tambien compara cada WABA contra todas las plantillas de catalogo genericas activas (`is_generic=true`): si una plantilla generica nueva no tiene copia remota con `catalog_template_id` y `meta_template_id`, o si la copia remota apunta al mismo catalogo pero su `category/components` ya no coinciden con el contenido Meta-facing actual, se vuelve a encolar la creacion aunque el WABA ya tuviera plantillas anteriores. Esta comparacion normaliza `components` e ignora cualquier `example` de Meta, incluido `HEADER/IMAGE.example.header_handle`, porque Meta sustituye los ejemplos por handles/URLs `scontent.whatsapp.net` y no forman parte del contrato que ve el paciente. Esta ruta salta el cooldown cuando el catalogo esta incompleto/desactualizado para que se abra una nueva version tecnica en Meta. Esto cubre coexistencia cuando Meta termina de habilitar el numero despues del callback inicial, nuevas plantillas admin añadidas a posteriori y cambios de copy en plantillas genericas ya propagadas;
- las plantillas de reseñas tienen dos familias genericas: `clinicaclick_solicitar_resena` (solo texto) y `clinicaclick_solicitar_resena_foto` (cabecera `HEADER/IMAGE`). Si `review_team_photo_url` es HTTPS, el producto debe usar la variante con foto; si esa variante no esta `APPROVED`, la UI bloquea prueba/envio con motivo claro en vez de enviar silenciosamente la version sin foto. Para que Meta acepte la revision de cabecera de imagen, el ejemplo debe ser un media handle de Meta, no una URL publica. El backend lo genera automaticamente con la Resumable Upload API usando la URL publica de ejemplo del catalogo (`templates/reviews/team-example.jpg`) y el token del WABA; `WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE`/`WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE` quedan como fallback operativo. Si no puede generar ni resolver el handle, deja la version tecnica en `PENDING_LOCAL` con motivo claro. Si Meta devuelve despues otro handle/URL de ejemplo para la misma cabecera, la plantilla sigue siendo equivalente mientras coincidan formato de cabecera, body, botones y categoria. Cuando `whatsapp_templates_sync` detecta que una copia local de reseñas con foto pasa a `APPROVED`, emite `whatsapp.review_photo_template_approved` con enlace interno a `/marketing/campanas?objective=get_reviews&review_step=summary` para retomar el borrador;
- `GET /api/automations/v2/templates` oculta la base de sistema de reseñas en listados con scope (`review_request_after_completed` / `flw_review_request_system`). Esa base es catálogo; la automatización operativa de reseñas siempre debe ser una copia scoped de clínica/grupo creada desde Campañas > Reseñas. Las copias publicadas e inactivas se tratan como deprecadas y no reactivan visualmente la base global;
- `whatsapp_phones_sync` solo debe encolar WABAs procedentes de `whatsapp_phone_number` activos y asignados a clínica o grupo. Un número `unassigned` no es operativo aunque conserve token de Meta para reasignación o auditoría;
- un número `unassigned` puede permanecer `isActive=true` si se ha desasignado para poder reasignarlo desde Ajustes. La sync remota no debe tratarlo como operativo ni encolar plantillas hasta que vuelva a tener `assignmentScope=clinic|group`;
- la sync remota de teléfonos no puede reactivar un número desconectado/desactivado solo porque Meta lo siga devolviendo. Si se desactivó con la acción destructiva de desconexión, debe permanecer `isActive=false` y `assignmentScope=unassigned`;
- `whatsapp_templates_sync` (cada 20 minutos) solo sincroniza estados remotos existentes. Si Meta sigue devolviendo `PENDING`, ClinicaClick debe mantener `PENDING`; no se marca como aprobada por tener el numero operativo;
- `whatsapp_templates_sync` debe respetar `assignmentScope`: si un WABA esta asignado a `clinic`, solo actualiza los overrides locales de esa clinica aunque el activo conserve `grupoClinicaId` por pertenecer a un grupo; si esta asignado a `group`, entonces si expande a todas las clinicas del grupo. Esto evita que una excepcion como Glories contamine plantillas locales de otras sedes Propdental;
- el webhook inbound debe resolver `metadata.phone_number_id` priorizando activos `whatsapp_phone_number` sobre filas legacy `whatsapp_business_account`. En WABA compartido de grupo, el activo `whatsapp_phone_number + assignmentScope=group` es el origen canonico; desde ahi se busca la conversacion existente por contacto dentro del grupo. Si se deja que una fila legacy de una clinica gane el lookup, las respuestas entran en la clinica propietaria historica del WABA, no en la clinica que envio la cita, y los `wait_response` no se reanudan. Una vez existe el `whatsapp_phone_number` operativo con `wabaId`, token y `businessId`, las filas duplicadas `whatsapp_business_account` del mismo WABA deben retirarse para no reintroducir ambiguedad; los jobs de plantillas enumeran WABAs desde ambos tipos y priorizan el phone asset;
- `GET /api/whatsapp/phones` expone `connection_mode`, `is_on_biz_app`, `coexistence_status`, `coexistence_can_send_api` y estados de importacion inicial para que Ajustes pueda mostrar el modo real;
- Si Meta devuelve `GraphMethodException code=100 error_subcode=33` al enviar o leer un numero en coexistencia, el backend marca `ClinicMetaAssets.additionalData.coexistence.status=disconnected`, `canSendApi=false`, `requiresReconnect=true` y emite la notificacion `whatsapp.coexistence_disconnected` con accion `Reconectar WhatsApp` hacia `/ajustes?tab=whatsapp`. Esto cubre sesiones compartidas caducadas/inactivas, la app de ClinicaClick desinstalada del WABA o tokens que pierden permisos sobre el WABA/phone. El texto operativo indica reconectar desde Ajustes y, en modo compartido, abrir WhatsApp Business en el movil, escribir un mensaje desde ese movil y recibir respuesta antes de cerrar la alerta;
- la sync de telefonos debe normalizar `GET /<phone_number_id>/whatsapp_business_profile`: Meta devuelve el perfil en `data[0]`; de ahi salen `vertical`/categoria, descripcion y foto. No leer `profile.vertical` directamente sin normalizar porque dejaria vacia la categoria en Ajustes;
- `POST /api/whatsapp/phones/:phoneNumberId/coexistence/sync-initial` encola `whatsapp_coexistence_sync_contacts` y `whatsapp_coexistence_sync_history`;
- los jobs de sync inicial llaman `POST /<BUSINESS_PHONE_NUMBER_ID>/smb_app_data` con `sync_type=smb_app_state_sync` y `sync_type=history`, persistiendo `request_id` y estados en `ClinicMetaAssets.additionalData.coexistence`;
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
- `sync.active=true` cuando una fuente conectada tiene `JobRequest` pendiente/en ejecución, registros locales pendientes (`ClinicBusinessLocations.sync_status=pending`) o error.
- El endpoint considera terminada una sincronización cuando el último `JobRequest` relevante para la clínica está `completed`, aunque la API externa no haya devuelto filas nuevas. Los jobs globales sin `clinicId` no deben contaminar el estado de una clínica concreta.
- Si una fuente queda en `state=error`, `sync.message` debe mostrar el mensaje de error de esa fuente, no el texto genérico de "recabando datos".
- En Perfil de Empresa Google, si el último `JobRequest.result_summary.report.errors[]` indica que `mybusiness.googleapis.com` está deshabilitada, el informe debe indicar que Google está rechazando ese servicio exacto como no habilitado en el proyecto afectado y pedir revisar Google Cloud antes de relanzar el resync.
- El frontend usa ese estado para mostrar una barra informativa y refrescar cada 60 segundos mientras haya trabajo pendiente.
- El objetivo es que conectar GA4, Search Console, Perfil de Empresa, Google Ads o Meta Ads no parezca "sin datos" durante los primeros minutos.
- Meta Ads puede llegar a `SocialAdsInsightsDaily` solo con `level='ad'` o `level='adset'` aunque no haya filas `level='campaign'`. El agregador de informes debe sumar primero `campaign` y caer a `adset`/`ad` si el nivel superior no tiene gasto/clicks/impresiones, evitando tanto inversión `0` como doble conteo.
- GA4 se mantiene como fuente opcional de sesiones/histórico, pero `GET /api/marketing/reports/overview` no expone ni usa conversiones nativas de GA4 para el embudo principal.
- El backend entrega KPIs, ratios, funnel con `ratioFromPrevious`, web summary y top páginas ya calculados. El frontend no debe hacer joins ni cálculos de negocio.
- El embudo termina en `Realiza tratamiento`. En V1 se calcula desde `LeadIntake.status_lead='convertido'`; cuando exista una señal clínica canónica de tratamiento realizado, debe reemplazar esta aproximación.
- `webSummary.webConvertedPatients` suma convertidos de canales web propios (`web`, `direct`, `call_click`, `whatsapp`). Los leads con `utm_source` social se asignan a `social_organic`, aunque técnicamente hayan entrado por una URL web, para respetar el primer contacto y evitar doble atribución.

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

## 2026-04-21 - Informes de competencia local V1

Se añade backend V1 para una futura subpestaña `Marketing > Informes > Competencia`.

Principios:

- Sugerir competidores locales en la primera configuración con Google Places.
- Para sugerir competidores es obligatorio tener una ficha local propia conectada o `Clinica.url_ficha_local` guardada. Si falta, `GET /competition/suggestions` devuelve `setup_required=true`, `setup_code=LOCAL_PROFILE_REQUIRED` y no ejecuta una búsqueda genérica.
- Si hay ancla local pero no hay categoría/especialidad suficiente, devuelve `setup_code=LOCAL_CATEGORY_REQUIRED`. No se debe usar fallback a "clínica médica" porque genera ruido en clínicas nuevas.
- Cuando hay ficha local conectada, la categoría/nombre de Google Business Profile tiene prioridad sobre disciplinas mixtas de la clínica para inferir la búsqueda inicial. Ejemplo: si una clínica tiene varias áreas pero su ficha local es `Podólogo`, la competencia se busca como podología, no como otra disciplina secundaria.
- Las sugerencias excluyen la propia ficha local por `place_id` y por nombre normalizado. La propia clínica no debe aparecer como competidor sugerido aunque Google la devuelva en los primeros resultados.
- `GET /competition` devuelve también `own_profile`, `ranking_terms` y `local_ranking`: ficha propia resuelta con Places, términos por especialidad/ciudad y posición estimada frente a competidores. No debe consultar Meta/Google Ads en vivo; lee snapshots persistidos y solo usa Places para ranking local, cubierto por caché corta.
- `GET /competition/local-heatmap` calcula bajo demanda un mapa de calor local para una búsqueda y zoom (`1`, `3` o `5` km). El front lo lanza automáticamente en la primera carga con `1 km` y lo recalcula al cambiar búsqueda o alcance, sin botón manual. Para que cada tile represente realmente su zona, el backend elimina de la query efectiva la ubicación explícita (`clínica capilar en Alicante` -> `clínica capilar`) y usa Google Places `locationRestriction` rectangular por punto con `rankPreference=DISTANCE`; si la zona no devuelve resultados, cae puntualmente a `locationBias` como fallback. Por defecto mide matriz `5x5` y profundidad `20` resultados para diferenciar `Top 3`, `#4-#9`, `#10+` y `>20`. Devuelve posición, score y primeros resultados por punto. Si `Maps Static API` está habilitada en la misma key, el backend devuelve `map_image_data_url` en base64 para pintar el mapa real sin exponer la API key al navegador.
- Caché runtime V1: el servicio mantiene caché en memoria con TTL e in-flight dedupe para evitar segunda consulta pesada y colapsar llamadas concurrentes. Se cachean listado (`COMPETITION_REPORT_CACHE_TTL_MS`, default 3 min), sugerencias (10 min), provider status (1 min), Places Search (6 h), Place Details/fotos (12 h), heatmap (6 h) y Static Maps (6 h). Las respuestas de heatmap exitosas sin `map_image_data_url` y los mapas estáticos fallidos no se cachean, para no conservar fondos esquemáticos por errores transitorios/configuración antigua. Mutaciones (`create/update/delete/refresh`) limpian la caché local del proceso. La fuente autoritativa siguen siendo snapshots persistidos; la caché no sustituye al cron. El `competition_refresh` fuerza detalles de Places frescos para no reescribir snapshots con datos cacheados.
- Primera consulta optimizada: ranking local y heatmap ejecutan llamadas Google Places con concurrencia limitada (`COMPETITION_GOOGLE_CONCURRENCY`, default 3) para no hacer un bucle secuencial lento ni saturar cuota.
- Si la ficha propia no aparece en una búsqueda simulada, `aboveMe` y `belowMe` deben ir vacíos y se devuelve `visibleResults` con los resultados encontrados. No tiene sentido hablar de "por encima" o "por debajo" cuando la clínica no aparece.
- Guardar solo competidores confirmados por el usuario.
- Actualizar semanalmente por cron, no en cada render del informe.
- Consultar anuncios mediante la API oficial de Meta Ads Library. Si Meta devuelve `ad_snapshot_url`, el backend puede intentar extraer imagen/vídeo público del snapshot como previsualización best-effort. El `ad_snapshot_url` original puede incluir `access_token`; nunca debe persistirse ni devolverse al front. Se usa solo de forma transitoria durante el refresco y se guardan enlaces públicos seguros (`https://www.facebook.com/ads/library/?id=...` y catálogo de página `view_all_page_id=...`).
- Media de anuncios Meta: el extractor busca `og:video`, `og:image`, `video[src]`, `video[poster]`, `srcset`, `data-src`, backgrounds CSS, recursos cargados por la página y URLs `.mp4/.webm/.mov` e imágenes `.jpg/.png/.webp` incluso si vienen escapadas en HTML/JSON. Se filtran assets internos de Facebook (`static.xx.fbcdn.net`, `rsrc.php`) para no guardar logos o páginas de error como creatividad. Si el snapshot devuelve `400/403` o una página sin media accesible desde servidor, se conserva el enlace oficial a Meta y la UI debe indicar que la creatividad visual no está disponible.
- Recuperación visual Meta con navegador: existe un fallback opcional para ejecutar navegador headless solo durante `competition_refresh`, nunca en el render normal del informe. El modo recomendado es `COMPETITION_META_BROWSER_MEDIA_MODE=auto`: primero se intenta HTML directo; solo si quedan anuncios sin media y con snapshot se despierta el navegador. El runtime es lazy, concurrencia 1, reutiliza el proceso mientras haya trabajo y lo duerme/cierra tras `COMPETITION_META_BROWSER_MEDIA_IDLE_MS`. En servidor se usa `puppeteer-core` como dependencia ligera y `chrome-headless-shell` externo como binario (`COMPETITION_BROWSER_EXECUTABLE_PATH`), evitando descargar Chrome dentro del paquete Node. Si no existe navegador, el snapshot queda como `meta_browser_unavailable` sin fallar el job. `refreshCompetition.report.provider.meta_browser_media` incluye lanzamientos, anuncios intentados/recuperados, errores, duración y delta RSS aproximado para medir impacto.
- Validación 2026-04-25: backfill de 23 competidores conectados en `auto`, límite 5 creatividades Meta por competidor. Tiempo `~124s`, delta RSS del proceso `~86MB`, `attempted_ads=15`, `recovered_ads=15`, `failed_ads=0`, `launches=2`, `sleep_count=2`, sin procesos `chrome-headless-shell` vivos tras finalizar.
- Validación 2026-04-26: refresco focalizado de Abaden Dentistas con `COMPETITION_META_BROWSER_MEDIA_LIMIT=25`. Resultado: `25/25` creatividades Meta con media recuperada, duración `~66s` para ese competidor. El límite 25 solo debe usarse en refresh/backfill cacheado, nunca en render normal del informe; si el volumen de competidores crece, mover esta recuperación a worker dedicado o bajar el límite.
- Resolución de Meta antes del fallback:
  - Primero se usan perfiles sociales ya guardados/manuales y URL de ficha/web si son Facebook o Instagram.
  - Después se revisa `website_url`: home + páginas internas ligeras de contacto/sobre nosotros/equipo para localizar enlaces públicos a Facebook/Instagram, normalmente en footer.
  - Si hay Facebook URL o usuario, se intenta resolver `page_id` con Graph API; también se extraen IDs de URLs tipo `view_all_page_id`, `search_page_ids`, `page_id`, `id`, `/123456` o slugs con sufijo numérico `nombre-123456`.
  - Solo si no existe página exacta se consulta Ads Library por frase exacta y se aceptan anuncios cuyo `page_name/page_id` encaje con el competidor. Los resultados ruidosos se descartan y se persiste `0` anuncios, no anuncios de terceros.
- Google Ads Transparency:
  - No existe una API oficial de Google Ads para leer anuncios de competidores desde cuentas no autorizadas. Para competencia se consulta el Ads Transparency Center público mediante sus endpoints RPC (`SearchService/SearchSuggestions` y `SearchService/SearchCreatives`), con `X-Same-Domain`, `Referer` oficial y límites bajos.
  - No se lanza navegador/headless ni se hace scraping interactivo de la web. Esto evita carga de CPU, reduce riesgo operativo y permite ejecutar la captura solo en `competition_refresh`.
  - Resolución: primero se buscan creatividades por dominio del competidor (`website_url`/Google Places). Si no hay dominio con anuncios, se buscan anunciantes por nombre/términos y se aceptan solo coincidencias con score mínimo.
  - Las creatividades se guardan en `MarketingCompetitorAdSnapshots` con `provider='google_ads_transparency'`. Se devuelven en `GET /competition` bajo `competitor.google_ads`.
  - Conteo: `ads_count` representa el total estimado de anuncios del anunciante cuando Google devuelve `upper_bound/lower_bound`. `active_ads` contiene solo el set visible recuperado para UI (`visible_ads_count`, por defecto 25). No confundir "25 creatividades visibles" con "25 anuncios totales".
  - Enlaces: cada creatividad mantiene `ad_snapshot_url` al anuncio concreto, pero `library_url/advertiser_url` deben apuntar al catálogo del anunciante para que el usuario vea todos los anuncios disponibles.
  - Media de Google: se priorizan imágenes `tpc.googlesyndication.com/archive/simgad`. Si el preview llega como `content.js`, se descarga solo para los primeros anuncios configurados y se extraen imágenes/vídeos aunque vengan dentro de contenido percent-encoded. Se filtran iconos/material assets (`fonts.gstatic.com`, `www.gstatic.com`, `googlematerialicons`) para no guardar iconos como creatividad. Los vídeos de YouTube se guardan como `external_video_url` con miniatura, no como descarga local.
  - Si Google cambia el contrato RPC o bloquea la consulta, se persiste `status=unavailable` para ese provider y la UI debe mostrar el enlace oficial o estado no disponible sin bloquear el informe.
- El alta/edición de competidor acepta `meta_page_url`. Si la URL contiene un identificador de página, backend extrae automáticamente `meta_page_id` para consultar la página exacta de Meta Ads Library.
- En cada refresco se intenta detectar perfiles sociales públicos del competidor desde Google Places, datos manuales y su web (`website_url`). Los perfiles se guardan en `raw_place_payload.clinicaclick_social_profiles` y se añaden a `meta_ads_search_terms` para mejorar la consulta oficial de Meta Ads Library. La detección es best-effort, con timeout bajo, máximo de páginas limitado, y no bloquea el refresco de Google Places.
- Los competidores se etiquetan con `relevance` frente a las disciplinas de la clínica. La especialidad se infiere primero desde `configuracion.disciplinas` y, si falta, desde nombre/servicios/descripción antes de caer a categorías genéricas de Google como `Medical Clinic`. Los que no encajan, por ejemplo competidores médicos genéricos en una clínica capilar, no se borran automáticamente, pero la UI debe marcarlos como `Revisar`.
- Reglas de relevancia V1 cubiertas: capilar, cirugía digestiva/hepatobiliar, podología y dental. Si una disciplina no tiene regla todavía, la UI debe mostrar `Sin regla de relevancia` y no ocultar resultados.
- Mapa de calor local:
  - Cada tile simula una búsqueda desde la coordenada del tile usando Google Places Text Search con `locationRestriction.rectangle`.
  - La matriz por defecto es `5x5` (`COMPETITION_LOCAL_HEATMAP_GRID_SIZE=5`, `COMPETITION_LOCAL_HEATMAP_MAX_POINTS=25`) y se mide hasta Top 20 (`COMPETITION_LOCAL_HEATMAP_RESULT_LIMIT=20`). `null` significa que la clínica no aparece en esa profundidad y debe mostrarse como `>20`; posiciones `1..3` son verde, `4..9` naranja y `10..20` rojo.
  - El zoom (`1/3/5 km`) solo separa más o menos los puntos alrededor de la clínica. No debe ampliar la ventana de búsqueda de cada tile, porque entonces el punto `Centro` de 3 km/5 km deja de ser comparable con el de 1 km.
  - El mapa de Google Static Maps debe ser solo fondo visual, sin `markers`. Los marcadores se pintan en frontend con los resultados calculados; si se añaden marcadores al PNG aparece duplicado el punto central (`label:5`) bajo el marcador propio.
  - La consulta efectiva elimina sufijos geográficos redundantes del término elegido (`"clínica capilar en Alicante"` -> `"clínica capilar"`) y la UI muestra también el término original si cambia.
  - En podología, no usar `"uñas"` como término aislado de ranking/relevancia. Debe ser contexto clínico (`"podólogo uñas encarnadas"`, `"podología"`, `"clínica podológica"`, `"quiropod"`, `"plantilla"`), porque `"uñas"` trae centros de manicura y distorsiona el mapa.
  - La caché del heatmap incluye `COMPETITION_CACHE_VERSION`; al cambiar la semántica del cálculo hay que subir la versión para no mezclar mediciones antiguas.

Tablas:

| Tabla | Uso |
|:---|:---|
| `MarketingCompetitors` | Competidores activos por clínica/grupo, con `google_place_id`, ficha pública y configuración opcional de página Meta. |
| `MarketingCompetitorSnapshots` | Snapshot diario/semanal de rating, reseñas, categoría, web, teléfono y estado Google Places. |
| `MarketingCompetitorAdSnapshots` | Snapshot de anuncios activos por provider (`meta_ads_library`, `google_ads_transparency`) o error explícito de disponibilidad. |

Endpoints:

| Endpoint | Estado | Uso |
|:---|:---|:---|
| `GET /api/marketing/reports/competition` | Operativo backend V1 | Lista competidores, último snapshot, anuncios activos y estado de proveedores. |
| `GET /api/marketing/reports/competition/suggestions` | Operativo backend V1 | Sugiere competidores con Google Places para una clínica concreta. |
| `GET /api/marketing/reports/competition/local-heatmap` | Operativo backend V1 | Calcula bajo demanda posición local por puntos alrededor de la clínica. |
| `POST /api/marketing/reports/competition/competitors` | Operativo backend V1 | Añade un competidor confirmado por el usuario. |
| `PATCH /api/marketing/reports/competition/competitors/:competitorId` | Operativo backend V1 | Edita datos, `meta_page_id`, términos de búsqueda o estado. |
| `DELETE /api/marketing/reports/competition/competitors/:competitorId` | Operativo backend V1 | Desactiva sin borrar histórico. |
| `POST /api/marketing/reports/competition/refresh` | Operativo backend V1 | Refresco manual de Google Places + Meta Ads Library + Google Ads Transparency para todos o algunos competidores. |

Job:

- `competitionSync`, cola `competition_refresh`, schedule por defecto `0 6 * * 1`.
- Variables: `GOOGLE_PLACES_API_KEY`, `GOOGLE_MAPS_API_KEY`, `META_AD_LIBRARY_ACCESS_TOKEN`, `JOBS_COMPETITION_SCHEDULE`, `COMPETITION_SUGGESTION_LIMIT`, `COMPETITION_META_AD_LIMIT`, `COMPETITION_META_AD_COUNTRY`, `COMPETITION_META_BROWSER_MEDIA_MODE`, `COMPETITION_META_BROWSER_MEDIA_LIMIT`, `COMPETITION_META_BROWSER_MEDIA_IDLE_MS`, `COMPETITION_BROWSER_EXECUTABLE_PATH`, `COMPETITION_LOCAL_HEATMAP_GRID_SIZE`, `COMPETITION_LOCAL_HEATMAP_MAX_POINTS`, `COMPETITION_LOCAL_HEATMAP_RESULT_LIMIT`, `COMPETITION_GOOGLE_CONCURRENCY`, `COMPETITION_CACHE_MAX_ENTRIES`, `COMPETITION_REPORT_CACHE_TTL_MS`, `COMPETITION_SUGGESTIONS_CACHE_TTL_MS`, `COMPETITION_PROVIDER_CACHE_TTL_MS`, `COMPETITION_PLACES_CACHE_TTL_MS`, `COMPETITION_PLACE_DETAILS_CACHE_TTL_MS`, `COMPETITION_PLACE_PHOTO_CACHE_TTL_MS`, `COMPETITION_HEATMAP_CACHE_TTL_MS`, `COMPETITION_STATIC_MAP_CACHE_TTL_MS`, `COMPETITION_SOCIAL_DISCOVERY_TIMEOUT_MS`, `COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED`, `COMPETITION_GOOGLE_ADS_TRANSPARENCY_AD_LIMIT`, `COMPETITION_GOOGLE_ADS_TRANSPARENCY_SCRIPT_MEDIA_LIMIT`, `COMPETITION_GOOGLE_ADS_TRANSPARENCY_TIMEOUT_MS`.
- Si `GOOGLE_PLACES_API_KEY` no está presente, las sugerencias devuelven proveedor no configurado.
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

Reglas:

- Los campos extra importados van en JSON tipado, no en columnas dinámicas.
- Si el frontend envia `custom_fields_schema` con `source_column`, solo esas columnas extra se guardan como variables personalizadas de lista; la `key` se persiste en formato simple para plantillas, por ejemplo `{{importe_presupuesto}}`.
- Los tratamientos importados deben poder mapearse al catálogo existente o conservarse como campo personalizado.
- Antes de encolar se excluyen cita futura, opt-out/no contactar, teléfono inválido, duplicados, cuarentena y variables personalizadas faltantes.
- Los nombres de pacientes creados/actualizados desde importación se normalizan a formato nombre propio.
- Si la importacion de reactivacion trae nombres en formato `Apellidos, Nombre`, backend debe invertirlos al persistir `Pacientes.nombre`/`Pacientes.apellidos` y al materializar variables de lista. Este caso aparece en CSV historicos de eventos o tratamientos.
- La importacion de pacientes historicos reconoce `phone_landline`/`telefono_fijo` como campo nativo separado de `phone`/`telefono_movil`. `phone` sigue siendo el movil operativo para WhatsApp; `phone_landline` se persiste en `Pacientes.telefono_secundario` cuando se crea el paciente o cuando el paciente existente no lo tenia informado.
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
- `GET /api/conversations` pagina por `limit/offset` y devuelve `X-Has-More`/`X-Next-Offset`; QuickChat debe consumirlo con scroll infinito. Tambien devuelve `X-Total-Unread`, calculado sobre todo el scope accesible y no sobre la pagina cargada, para que el badge de pendientes no dependa de la paginacion. La pestaña visible `Otros` mantiene `filter=leads` por compatibilidad, pero backend incluye `lead_id` y conversaciones externas de campañas presentes en `MarketingPatientListItems.conversation_id`, excluyendo siempre conversaciones con `patient_id`.
- La busqueda de `GET /api/conversations?q=...` debe cubrir pacientes, leads, `contact_id` y contactos externos de listas/campanas (`MarketingPatientListItems.name`, `phone`, `email` y `custom_fields.nombre_completo`). Las busquedas con varias palabras aceptan coincidencia de frase completa o todos los tokens en cualquier campo, para que `Nombre Apellido2` encuentre pacientes con nombre compuesto o dos apellidos. No buscar en todo `Messages.content` desde este endpoint sin un indice/previsualizacion materializada, porque penaliza la bandeja paginada de QuickChat.
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

Regla operativa:

- cambiar el default en código no modifica producción/integración si la variable ya existe en `.env` o en PM2;
- si se ajusta el cron, hay que revisar también el valor efectivo en entorno y reiniciar con actualización de variables si aplica.

Perfil de Empresa Google:

- `GET /oauth/google/local/locations` usa Business Information API con `readMask`; Google rechaza la llamada sin ese parámetro y no deben tragarse esos errores como "0 fichas";
- el `readMask` debe incluir `regularHours`, `specialHours` y `moreHours`. Sin esos campos, la UI de `Marketing > Perfil Google` no puede mostrar el horario real de la ficha;
- `POST /oauth/google/local/map-locations` guarda `ClinicBusinessLocations`, conserva `raw_payload.accountName` y encola `business_profile_backfill_locations`;
- `businessProfileSync` refresca primero los detalles de la ubicación en Business Information API (`/v1/locations/:id`) para actualizar horario, categoría, teléfono y metadatos. Si este refresco auxiliar falla, no debe abortar métricas/reseñas/publicaciones;
- `businessProfileSync` usa la Google Business Profile Performance API para métricas recientes y las rutas v4 de My Business (`mybusiness.googleapis.com`) para reseñas/publicaciones;
- `businessProfileReviewsSync` es el refresco ligero para conversión de reseñas: por defecto corre cada 15 minutos (`JOBS_BUSINESS_PROFILE_REVIEWS_SCHEDULE`, configurable), solo llama a la API v4 de reseñas, limita páginas con `LOCAL_REVIEWS_SYNC_MAX_PAGES` (5 por defecto) y solo encola conciliación para reseñas nuevas en esa pasada. El sync completo diario sigue siendo el que consolida métricas, publicaciones y reintentos amplios;
- el job persiste en `BusinessProfileDailyMetrics`, `BusinessProfileReviews` y `BusinessProfilePosts`;
- `BusinessProfilePosts.summary`, `call_to_action_url` y `media_url` deben ser `TEXT`; Google puede devolver publicaciones o URLs más largas que 1024 caracteres;
- si falta `raw_payload.accountName`, Google devuelve 403/scope insuficiente o `mybusiness.googleapis.com` no está habilitada en el proyecto, la ficha queda con `sync_status=error`; no debe mostrarse como "0 reseñas/publicaciones" completado.
- `GET /api/local/clinica/:clinicaId/status` expone `syncStatus`, `lastSyncedAt`, teléfono, web, dirección, horario y `rawPayload` procedentes de `raw_payload`;
- `GET /api/local/clinica/:clinicaId/overview|timeseries|reviews|posts` son los endpoints reales que alimentan `Marketing > Perfil Google`. `posts` acepta `limit/offset` y devuelve `total`.

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
- Los endpoints administrativos que arrancan o reinician `metaSyncJobs` deben rechazar runtimes no líderes (`cron_not_leader`). Parar jobs se permite para limpiar un runtime que se haya quedado arrancado por error.
- `node-cron` v4 arranca las tareas creadas con `cron.schedule()` al registrarlas, aunque se pase `scheduled:false`. Por eso `src/jobs/sync.jobs.js` debe llamar a `job.stop()` justo después de registrar cada job y dejar que solo `metaSyncJobs.start()` los active. Si se quita ese `stop()`, `dev` vuelve a duplicar cron aunque `JOBS_CRON_LEADER=false`.

Importante:

- `jobScheduler.start()` y `metaSyncJobs.start()` ya no significan lo mismo.
- `staging` debe poder ejecutar sus automatizaciones (`appointment_created`, `wait_response`, resumes) aunque no sea el leader de cron.

Configuración operativa actual:

- `pm2-back-staging`: `JOBS_CRON_LEADER=true`
- `pm2-back-dev`: `JOBS_CRON_LEADER=false`
- `pm2-gateway`: `JOBS_CRON_LEADER=false`

Objetivo:

- evitar duplicados horarios de `whatsapp_templates_sync`;
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
- En listados operativos (`/automatizaciones`) con scope de clínica o grupo, la plantilla base global del catálogo no debe mostrarse junto a su copia clínica. La base se consulta desde `automatizaciones-admin`; la pantalla cliente trabaja con la copia propagada/operativa para evitar dobles automatizaciones aparentes.

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
- solo si no hay `catalog_template_id`, cae a `template_id` o `template_name`;
- por tanto, la UI de diagnóstico debe mostrar la plantilla efectiva resuelta para la clínica, no únicamente el `template_id` persistido en el JSON del nodo.

Esto evita un falso diagnóstico típico: un nodo puede mostrar un `template_id` antiguo o de otra clínica en el JSON, pero ejecutar correctamente porque el runtime resuelve por `catalog_template_id + clinic_id`.

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
- `GET /api/marketing/review-requests/summary` devuelve el resumen operativo del objetivo de reseñas para el `review_source` solicitado: pacientes posibles, preview de candidatos con tratamiento, peticiones enviadas, valoraciones internas `1-4` y `5`, reseñas publicas conciliadas en Google (`google_reviews_matched`), `treatment_options` con contador de pacientes elegibles por tratamiento, estado de automatización, disponibilidad de plantillas WABA aprobadas de solicitud y recordatorio, disponibilidad de WhatsApp y disponibilidad de `url_dejar_resena`. La preview acepta `preview_limit` y devuelve `candidates_preview_total`/`candidates_preview_limit` para que el front pueda enseñar más candidatos sin confundirlo con el total. Las métricas `requests_sent`, `ratings_1_to_4`, `ratings_5`, `google_reviews_matched` y `low_rating_reasons` solo cuentan items/eventos de reseñas con solicitud real enviada, en cola o ya respondida; se excluyen envíos de prueba `mass_campaign_test` y valoraciones sueltas sin solicitud real para no inflar conversión. `google_reviews_matched` se calcula con `BusinessProfileReviews.matched_contact_event_id`, por lo que mide reseñas Google vinculadas, no pacientes que solo respondieron `5/5` en privado. Si la automatización está activa, `automation_template` incluye también `review_gift_enabled`, `review_gift_description`, `review_display_clinic_name` y `review_sender_name` para que la UI explique si opera con premio/sin premio, nombre visible, remitente y audiencia. Acepta `review_treatment_ids` como lista separada por comas para filtrar varios tratamientos; `review_treatment_id` sigue soportado como compatibilidad. En este endpoint, si llegan `scope=group:<id>` y `clinic_id` juntos, el backend debe priorizar `scope` para que el front pueda conservar una sede activa sin perder el desglose de grupo. En scope de grupo añade `clinic_statuses`, `group_total_clinics`, `group_ready_clinics` y `group_blocked_clinics`: cada sede se evalua por candidatos posibles, `url_dejar_resena` disponible, WhatsApp conectado, plantillas WABA aprobadas de solicitud/recordatorio y automatización individual de clínica. Cada `clinic_status` expone labels/hints listos para UI (`google_status_label`, `whatsapp_status_label`, `template_status_label`, `status_label`, `status_hint`, `automation_label`, `automation_hint`) para que el front no deduzca estados complejos. Si una automatización está activa pero la sede no está lista, se etiqueta como `Configurada, sin enviar`. La UI no muestra switches por sede: usa un interruptor general de grupo como operación masiva y un desglose por clínica para explicar qué sedes están listas y cuántos pacientes posibles aporta cada una. Las sedes no listas quedan fuera del envío hasta resolver el motivo; las listas usan el enlace de reseña de la sede de cada item, no un enlace global del grupo.
- El resumen de reseñas y cada `clinic_status` exponen `approved_photo_template_available`/`approved_photo_template_id` para que la UI bloquee foto de equipo solo cuando realmente falta la variante WABA con cabecera `HEADER/IMAGE`.
- En vista de grupo, el interruptor de reseñas no representa una plantilla operativa de grupo. Al activarlo se crean/actualizan las automatizaciones individuales de las clínicas del grupo; al pausarlo se desactivan las automatizaciones existentes de esas clínicas. Esto evita herencias/overrides difíciles de explicar al usuario.
- `PATCH /api/marketing/review-requests/automation` activa/desactiva una plantilla `AutomationFlowTemplatesV2` por clínica con `trigger_type=appointment_completed`. Para activarla exige Perfil Google con `url_dejar_resena`, WhatsApp conectado, remitente de reseñas (`review_sender_name`) y plantillas WABA aprobadas de solicitud y recordatorio; si falta algo devuelve `409 review_automation_requirements_missing` con `warnings` (`template_not_approved`, `reminder_template_not_approved`, `sender_name_missing`, etc.). Si recibe `scope=group:<id>`, ejecuta la misma operación clínica para cada sede del grupo y devuelve `group_result` con sedes actualizadas/activas/fallidas; no crea `review_request_after_completed__group_*`. La plantilla actual es V2 y encadena `delay/fixed` de 24h tras `appointment_completed` -> `action/request_review` con `review_source=completed_treatment` -> `delay/wait_response` de 24h. Si hay respuesta entra en `condition/field_check`, que comprueba `last_response_context.response_rating >= 5`; si es verdadero continúa por `action/review_followup` con `followup_kind=google_review`, y si es falso continúa por `action/review_followup` con `followup_kind=private_feedback`. Si no responde en 24h, ejecuta `action/request_review_reminder` con la plantilla `clinicaclick_recordatorio_resena_sin_respuesta`, espera otras 24h y cierra con `action/review_no_response` si sigue sin contestar. La acción `request_review` conserva en su configuración `review_gift_enabled`, `review_gift_description`, `review_display_clinic_name`, `review_sender_name` y `review_team_photo_url`; el runtime los traslada a la lista generada automáticamente.
- Las solicitudes de reseñas se materializan como `mass_sends` con `criteria.review_request = true` y `template_usage = solicitud_resena`. Si `list_source=current_patients`, el backend crea candidatos desde `CitasPacientes` completadas o desde pacientes actuales en selección manual. La selección manual considera tanto `Pacientes.clinica_id` como vínculos en `PacienteClinicas`, para que un paciente cuya clínica principal sea otra sede del grupo pueda usarse como ejemplo o receptor si está vinculado a la clínica activa. Cuando se filtra por tratamientos, guarda `criteria.review_treatment_ids` y conserva `criteria.review_treatment_id` con el primer valor para consumidores legacy.
- En selección manual de reseñas, el candidato se enriquece con la última cita `completada` del paciente dentro del scope para personalizar `tratamiento`, `fecha_cita` y `referencia_visita`. `referencia_visita` es una variable interna de plantilla; en UI debe explicarse como última atención/fecha de atención. Las citas históricas importadas pueden usarse como contexto de reseñas, pero el runtime de citas las omite en automatizaciones y jobs programados por `motivo = "Importación de pacientes para reactivación"` o `titulo` `Histórico:`.
- La importación histórica para reseñas/reactivación acepta aliases de fecha tipo `fecha_tratamiento`, `fecha_de_tratamiento`, `fecha_realizacion`, `fecha_ultima_cita` y `fecha_ultimo_tratamiento`. Si el CSV trae nombres como `Apellidos Apellidos Nombre`, el cliente debe enviar `name_format=last_last_first`; el backend separa nombre/apellidos para evitar que el WhatsApp salude por el apellido. Estas citas importadas son datos de contexto: nunca deben lanzar `appointment_created` ni recordatorios de cita; si aparecen en actividad de paciente deben mostrarse como tratamiento histórico importado.
- En candidatos de reseñas, `tratamiento` no debe rellenarse con valores técnicos genéricos (`visita`, `cita`, `Importación de pacientes...`). Si la cita histórica tiene `titulo = "Histórico: ..."` se limpia el prefijo y solo se usa cuando queda un tratamiento real. Si no existe tratamiento identificable, el front debe mostrarlo como no asignado.
- Fuentes soportadas para reseñas: `first_completed_or_completed_treatment`, `first_completed_appointment`, `completed_treatment`, `manual_selection`. Las dos primeras se mantienen para leer automatizaciones históricas. La automatización operativa nueva debe usar `completed_treatment`: envía 24h después de una cita completada que tenga tratamiento asociado y excluye cualquier paciente que ya tenga una solicitud previa enviada/en cola para evitar duplicados.
- En reseñas, `appointment_completed` significa que la cita se ha marcado con `estado = completada`, es decir, el paciente ha acudido o la clínica la da por realizada. No equivale a `info_confirmada` ni a `recordatorio_confirmado`, que solo indican confirmación previa del paciente. La automatización vigente no envía en ese instante: entra primero en `delay/fixed` de 24h.
- La escala de reseña es `1-5`; el filtro público queda fijado en `5/5`. Las plantillas WABA `solicitud_resena` y `recordatorio_resena_sin_respuesta` ya no usan botones rápidos: WhatsApp colapsa 5 opciones bajo "ver todas las opciones" y Meta rechaza emojis/formato en botones. Ambas muestran la escala con estrellas en el cuerpo en orden descendente (`5 ⭐⭐⭐⭐⭐` ... `1 ⭐`) y el paciente responde escribiendo `1`, `2`, `3`, `4` o `5`. El copy base actual incluye `firma_resenas`/`review_sender_name` para firmar el mensaje inicial y abre con: `Soy {{firma_resenas}} de {{nombre_clinica}}. ¿Te puedo hacer una pregunta? Como viste, en la clínica somos una pequeña familia...`; muestra directamente las cinco opciones. En reseñas, las variables `{{nombre}}`, `{{nombre_paciente}}` y equivalentes deben resolverse solo con nombre de pila para que el saludo sea natural; `{{nombre_completo}}` queda reservado para usos explícitos. Al recibir la respuesta, `materializeInboundReply` crea `review_rating_received`; si la valoración es `5/5` envía follow-up con `{{clinica.url_dejar_resena}}` como URL visible en texto, y si es `1-4` pide motivo como opinión privada. Si responde `1-4` y después `5`, se ignora el cambio para no llevarlo a Google; si responde `5` y después baja a `1-4`, se pide motivo privado una sola vez. El texto que llega después de un `review_private_feedback_request` se trata siempre como motivo privado y no se vuelve a parsear como valoración, aunque contenga números como tiempos de espera o fechas; la valoración mostrada se conserva desde el mensaje que originó la petición de motivo. Si por reintento/webhook tardío el mismo inbound ya quedó registrado como `review_rating_received`, no se guarda de nuevo como `review_private_feedback_received` ni se pinta en actividad/resumen como motivo. Se evita `interactive cta_url` para reseñas porque puede abrir Google en un contexto que obliga a iniciar sesión, mientras el enlace directo conserva mejor el flujo de escritura de reseña. Los follow-ups tras respuesta usan texto libre porque el inbound del paciente abre ventana de 24h; si en el futuro se diferencian o retrasan fuera de esa ventana deberán tener fallback por plantilla aprobada. Si el paciente deja motivo, se guarda como `review_private_feedback_received` y se envía acuse `review_private_feedback_ack` para cerrar la conversación. Si el paciente no contesta a la primera solicitud, se envía recordatorio 24h después; si tampoco responde en 24h tras ese recordatorio, se cierra el flujo. Las solicitudes manuales en cola (`mass_sends`) programan el mismo recordatorio/no-respuesta por item para no comportarse distinto a la automatización futura. En envíos de prueba (`mass_campaign_test`), el follow-up debe enviarse al número de prueba guardado en `metadata.recipient`, no al teléfono del contacto usado para renderizar variables; además, cada prueba se evalúa por `trigger_message_id` para poder repetir tests sobre el mismo contacto/lista sin bloquear el nuevo follow-up.
- Si una campaña/lista de reseñas se prepara con premio, `criteria.review_gift_enabled` y `criteria.review_gift_description` gobiernan el follow-up de `5/5`. Sin premio: mensaje corto con URL visible para publicar en Google. Con premio: texto corto con la descripción del regalo, URL visible y la instrucción de escribir al WhatsApp para tramitarlo. Este follow-up no es plantilla WABA: se envía como mensaje de sesión justo después de recibir la valoración del paciente, aprovechando la ventana de 24h abierta por ese inbound. El backend usa un margen operativo de 23h50; si el webhook/materialización llega fuera de ventana, no intenta enviar texto libre y registra `review_rating_followup_skipped` con `reason=whatsapp_session_window_expired`.
- La resolución de plantillas de reseñas prioriza copias `APPROVED` cuyo BODY coincide exactamente con el catálogo vigente y contiene el remitente configurable (`firma_resenas`/placeholder 3). Si una automatización antigua apunta a un `whatsapp_template_id` aprobado pero con copy obsoleto, el backend busca primero una copia aprobada del mismo catálogo/WABA con el cuerpo actual antes de reutilizarla; si no existe, no desbloquea el envío. En listados efectivos de plantillas, una copia aprobada compatible tiene prioridad sobre una copia más nueva en revisión para que `Marketing > Plantillas` muestre las plantillas de sistema utilizables como solo lectura. Desde 2026-07-02, `syncTemplatesForWaba` mantiene localmente inactivas las copias de `clinicaclick_solicitar_resena` y `clinicaclick_solicitar_resena_foto` cuyo BODY no incluya el remitente (`firma_resenas`/`review_sender_name`), aunque sigan existiendo en Meta como histórico aprobado/rechazado.
- En listados de automatizaciones V2 con scope de clínica/grupo, la base global de reseñas no debe mostrarse como automatización operativa. Las filas publicadas deprecadas/inactivas tampoco se muestran en `Todos`; si una clínica no tiene copia operativa activa o borrador visible, `Campañas > Conseguir reseñas` es el punto de activación/configuración. Esto evita que una base de catálogo parezca activa para una clínica.
- El wizard de reseñas envía `dispatch_config`, `schedule_mode` y `scheduled_at` en `prepare`/`send`. `dispatch_config` define si sale poco a poco o en tandas (`mode`, `batch_size`, `delay_ms`) y si se usa horario de clínica o una ventana concreta (`time_mode`, `business_hours`, `scheduled_time`, `window_start_time`, `window_end_time`). Para `context=review_request`, el backend permite el ritmo recomendado de 1 envío/minuto; el resto de envíos masivos mantienen el mínimo operativo general de 2 minutos. El worker de `marketing_bulk_send_dispatch` debe usar este snapshot guardado en `criteria`, no recalcularlo desde la configuración actual de la clínica.
- Nomenclatura operativa: la plantilla global editable/inspeccionable desde admin se llama `Reseñas automáticas` y debe mostrarse con badge `Sistema`, no con el prefijo en el título. No dispara envíos por sí sola. Las automatizaciones que sí operan por clínica se nombran `Reseñas automáticas · Clínica: {nombre}`.
- La sincronización de plantillas contra Meta no debe reactivar copias de un `WhatsappTemplateCatalog` inactivo. Si Meta sigue devolviendo una plantilla remota de una familia retirada, `syncTemplatesForWaba` la conserva/actualiza con `is_active=false` y no dispara callbacks de aprobación.
- Limpieza catálogo 2026-07-03: las entradas históricas inactivas sin `template_key` se mantienen como referencia legacy pero no son propagables. Cualquier item activo del catálogo debe resolver a una familia V2 publicada por `public_id` o `template_key`; la automatización QA `qa_reactivation_patient_followup` se desactiva si no existe base publicada válida. Las copias scoped de reseñas deben conservar `template_key=review_request_after_completed__clinic_<id>` y `public_id=flw_review_req_clinic_<id>` para que el colapso de listados y la propagación puedan identificar una única familia por clínica.
- `GET /api/marketing/review-requests/summary` incluye `low_rating_reasons` como panel operativo de valoraciones recientes `1-5`, no como listado bruto de Google. Cada fila devuelve `patient_id`, `conversation_id`, `clinic_id`, `clinic_name` y, si se pudo conciliar, `google_review_comment`, `google_reviewer_name` y `google_review_matched` para explicar por qué una valoración de `5/5` aparece sin comentario interno de WhatsApp. Para `5/5` se muestra el comentario real de Google cuando existe, sin prefijos redundantes porque el front ya muestra `Google: {autor}`; si no, se indica que no comentó en Google o que no se pudo relacionar el usuario público. Para `1-4` se cruza el motivo privado si el paciente lo respondió. Las métricas y motivos recientes se atribuyen solo a listas/campañas con `criteria.review_request = true` o `template_usage = solicitud_resena`, excluyen eventos `mass_campaign_test_*` para no medir conversiones de pruebas y usan solo la última valoración válida por contacto dentro del scope (`paciente_id`, teléfono, email o nombre normalizado) para que respuestas antiguas duplicadas no inflen contadores ni tabla.
- El mismo endpoint devuelve `review_response_heatmaps` para pintar mapas de calor de respuestas por día/hora sin otra petición de front. La clasificación estacional usa el momento de envío de la solicitud (`MarketingPatientListItems.sent_at`) y separa `winter` (diciembre-febrero) y `summer` (junio-agosto). Los días se devuelven con inicial compacta española (`L M X J V S D`) y cada celda se calcula sobre la última valoración válida por contacto en el scope. También devuelve `google_rating_summary`, calculado sobre `BusinessProfileReviews` sincronizadas, con media pública, total, reseñas de 5 estrellas, `needed_five_star_reviews_for_5` y `rating_targets`. `rating_targets` contiene hitos redondeables (`visible_average`, `target_average`, `needed_five_star_reviews`) para que el front muestre cuántas reseñas de 5 hacen falta para subir al siguiente tramo visible y a 5,0.
- Las reseñas nuevas de Perfil Empresa Google se concilian mediante `JobRequests.type=business_profile_review_match`. Al sincronizar `BusinessProfileReviews`, el backend encola un job de baja prioridad que compara `reviewer_name` con pacientes/list items que recibieron el follow-up de Google (`MarketingPatientContactEvents.event_type=review_rating_followup_sent` con `payload.kind=review_google_link_followup`) en las 48h previas en la misma clínica. El scoring normaliza acentos, admite iniciales públicas (`Noemí V.C.`), nombre+apellido compactado (`Jesusramos`) y una errata leve en tokens largos, pero mantiene un umbral prudente para no vincular autores dudosos. Si el score de nombre supera el umbral, marca `BusinessProfileReviews.matched_paciente_id`, `matched_contact_event_id`, `match_confidence`, `match_reason`, `matched_at` y crea un evento `MarketingPatientContactEvents.event_type=google_review_matched` para que aparezca en la actividad del paciente/QuickChat. Las métricas separan `google_reviews_matched` (match directo y prudente paciente-reseña) de `google_reviews_attributed` (reseñas públicas creadas en una ventana de 72h tras enviar un enlace Google real de campaña/lista, excluyendo pruebas). Si no hay candidato claro, no vincula automáticamente a un paciente, pero la card de conversión puede medir impacto con la atribución temporal.
- Al completar una cola manual de reseñas, `criteria.dispatch` conserva `completed_at`, `completed_banner_expires_at`, `review_pending_replies` y `review_pending_reminders`. `review_pending_reminders` se calcula desde `JobRequests.type=marketing_review_request_no_response` en estado pendiente y solo para items enviados que todavía no respondieron; `getDispatchStatus` recalcula esos valores para campañas completadas antiguas si el front consulta el estado directo. Esto permite que el front mantenga unos días el aviso de cola completada sin decir que el flujo terminó del todo mientras quedan recordatorios reales en espera.
- `GET /api/marketing/bulk-sends/campaigns/:id/recipients?status=ready` filtra por `MarketingPatientListItems.status='ready'`, `selected=true` y `dispatch_status` vacío/pendiente. No debe interpretarse como `dispatch_status='ready'`, porque ese estado no existe y rompería selectores de prueba en campañas/reseñas.
- `GET /api/marketing/bulk-sends/campaigns` acepta `context=mass_sends|reviews|all`. Como las solicitudes de reseña reutilizan `MarketingPatientLists.objective_id=mass_sends`, `context=mass_sends` excluye desde SQL listas con `criteria.review_request=true`, `template_usage=solicitud_resena` o `dispatch.context=review_request`; `context=reviews` devuelve solo esas colas para `Marketing > Campañas > Conseguir reseñas`. No borrar estas listas históricas para limpiar la UI: deben quedar medibles desde reseñas, pero no contaminar `Envíos masivos`.
- Los mensajes WhatsApp encolados por horario silencioso (`metadata.queued_by_quiet_hours=true`) se muestran en QuickChat como programados y pueden forzarse con `POST /api/conversations/messages/:messageId/send-now`. El worker ignora el job diferido si el mensaje ya quedó `sent/delivered/read` para evitar duplicados.
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
- Si la plantilla de reseñas usa cabecera de imagen, el backend prepara la foto en `sendDispatchItem`/`sendTest`: descarga la foto base desde PUBLIC_MEDIA, compone una imagen JPEG 1200x675 compatible con WhatsApp con una banda solida y texto blanco `¡Hola {nombre}!`, y sube la derivada como `purpose=whatsapp_image`. Para evitar recortes, la foto se encaja completa dentro del formato y el sobrante se rellena con una version desenfocada de la misma imagen. Esta es una excepcion controlada de producto para cabecera WhatsApp de reseñas: solo puede incluir nombre de pila, nunca apellidos completos, telefono, diagnostico, tratamiento ni dato clinico. El color se guarda en `review_team_photo_overlay_color`. La key sigue siendo opaca y determinista por foto/nombre/color; si se repite una prueba con la misma combinacion se actualiza el registro `PublicMediaAssets` existente en vez de fallar por duplicado. `PublicMediaAssets.metadata` marca `patient_name_present=true`, `patient_data_in_public_media=true`, `image_fit=contain_with_blurred_cover_background` y `public_media_patient_data_exception=review_whatsapp_header_greeting`. La derivada se recomprime por debajo del limite de WhatsApp de 5 MB; si no se puede garantizar ese limite, no se envia la foto original como fallback porque Meta la rechazaria. Si la transformacion falla por un error transitorio no relacionado con tamano, se usa la foto base; si la URL no pertenece a PUBLIC_MEDIA, se bloquea. Las subidas `review_team_photo`/`whatsapp_image` recibidas como WebP o GIF se normalizan a JPEG antes de guardarse para evitar rechazos de Meta por formato no soportado.
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
