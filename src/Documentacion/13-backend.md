> **Módulo:** Arquitectura del Backend
> **Última actualización:** 2026-03-18
> **Relacionado con:** [20.1-motor-flujos-v2](./20.1-motor-flujos-v2.md)

---

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

### Cómo se rellena

No depende de llamadas live continuas en UI.

El análisis de campaña hace:

1. intenta leer `GoogleAdsAdInsightsDaily`
2. si no hay cache para esa campaña/rango:
   - hace un warm-up controlado contra Google Ads API
   - persiste el resultado
3. vuelve a leer desde cache

Esto deja el patrón correcto:

- primera carga: posible warm-up
- siguientes cargas: cache local

### Alcance actual

Esto ya permite en `Campañas > Análisis` para Google Ads:

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
  "input_text": "{{context.last_response}}",
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
  - Ejemplo: `Mensaje previo: {{context.last_prompt}}\nRespuesta: {{context.last_response}}`

### Variables de entorno

En `.env` / `.env.example`:

- `GROQ_API_KEY`
- `GROQ_API_BASE_URL` (default `https://api.groq.com/openai/v1`)
- `GROQ_MODEL_COMPLEX` (default `llama-3.1-70b-versatile`)
- `GROQ_MODEL_FAST` (default `llama-3.1-8b-instant`)
- `GROQ_TIMEOUT_MS` (default `20000`)
- `GROQ_STT_MODEL` (default `whisper-large-v3-turbo`, para transcripción de audio inbound WhatsApp)

### Notas operativas

- La API key de Groq se usa **solo en backend**.
- Si `GROQ_API_KEY` falta, `condition/ai_analysis` falla en runtime con `groq_api_key_not_configured`. Eso no impide el trigger ni el envío inicial de WhatsApp; bloquea el avance al llegar al nodo IA.
- El output del nodo guarda además metadatos técnicos (`_ai_provider`, `_ai_model`, `_ai_analysis_mode`, `_ai_usage`) para auditoría y depuración.
- Requisito de producto pendiente: persistir consumo por usuario/clinic para facturación por uso.

### Audio inbound (WhatsApp) y hoja de ruta local

- Estado actual:
  - Los audios entrantes de WhatsApp se transcriben en backend usando Groq STT (`GROQ_STT_MODEL`).
  - Se persiste la transcripción en `Messages.content` y metadata técnica en `Messages.metadata`.
  - **No** se persiste aún el binario de audio ni media estática propia.
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
  "appointment_type_without_treatment": "any | primera_sin_trat | urgencia | revision"
}
```

Reglas:

- Solo aplica a `trigger_type = appointment_created`.
- Para el resto de triggers, `trigger_config = null`.
- Si `appointment_scope !== without_treatment`, `appointment_type_without_treatment` se normaliza a `any`.

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
   - Para `without_treatment`, la prioridad es:
     - tipo exacto (`primera_sin_trat`, `urgencia`, `revision`)
     - `any`
     - `all`

Consecuencias:

- No debe dispararse más de un flujo V2 por el mismo `appointment_created`.
- Un template `without_treatment` no debe asignarse desde `PUT /api/tratamientos/:id/automation-template`.

### Scheduler de cita

`appointment_reminder_window` y `appointment_after` se ejecutan mediante `JobRequests`, no por cambio de estado.

Contrato operativo:

- al crear, editar o reagendar una cita, backend llama a `syncScheduledTriggersForCita(cita)`;
- se crean jobs `appointment_automation_schedule_fire` con `payload`:
  - `appointment_id`
  - `trigger_type`
  - `template_key`
  - `window_identifier`
  - `scheduled_for`
- cuando el job vence, `fireScheduledTrigger(payload)` resuelve la última versión publicada activa del `template_key` y crea una `FlowExecutionV2` normal.

Reglas importantes:

- `appointment_reminder_window` no debe programarse si la cita ya ha empezado;
- `appointment_after` sí puede quedar programado desde la creación inicial de la cita;
- el entorno debe aislar sus colas con `QUEUE_PREFIX` propio;
- si varios procesos consumen la misma tabla/cola de jobs en un entorno, todos deben conocer `appointment_automation_schedule_fire` o bien solo uno de ellos debe actuar como scheduler. Si no, el síntoma es `No handler registered for job type 'appointment_automation_schedule_fire'`.

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
  - `profesional.*` es el alias público recomendado para el usuario operativo que agenda la cita.
  - `cita.usuario_*` se conserva como alias de compatibilidad para plantillas anteriores.
  - No se inventan valores derivados: la URL de ficha local solo se expone si existe en `Clinicas.url_ficha_local`.

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
  - La propagación a clínicas crea o actualiza borradores V2 por clínica, enlazados operativamente por `template_key`.
  - `template_version` queda como campo histórico de transición y deja de ser binding operativo.

- Tratamientos y cita
  - El contrato vigente es `GET/PUT /api/tratamientos/:id/automation-template`.
  - La resolución canónica es:
    - tratamiento guarda `appointment_automation_template_key`;
    - runtime resuelve la última versión publicada activa (`published_at != null`, `is_active = true`);
    - las versiones publicadas anteriores del mismo `template_key` pasan a `deprecadas`.
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
