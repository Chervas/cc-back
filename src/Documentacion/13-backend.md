> **Módulo:** Arquitectura del Backend
> **Última actualización:** 2026-02-24
> **Relacionado con:** [20.1-motor-flujos-v2](./20.1-motor-flujos-v2.md)

---

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

- `GET /api/conversations`
  - Cuando se consulta por `lead_id` y todavía no existe conversación, backend puede crear una conversación WhatsApp on-demand si el lead tiene teléfono.
  - El objetivo es que drawers y vistas embebidas no queden bloqueados en estado vacío cuando el lead ya es contactable pero aún no ha abierto hilo.

- `CitasPacientes`
  - Se añaden `created_by` y `updated_by` para persistir el actor operativo que crea o modifica la cita.
  - Estos campos se rellenan en:
    - creación de cita
    - cambio de estado
    - reagendado

- `GET /api/pacientes/:id/activity`
  - Nuevo endpoint de actividad operativa del paciente.
  - Devuelve eventos de cita construidos desde `CitasPacientes` con actor resuelto desde `Usuarios`.
  - Esto permite que el registro del paciente muestre acciones como `Cita agendada` indicando qué usuario ejecutó la operación.


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

- Conversaciones de lead
  - El modelo canónico para marketing es `LeadIntake`.
  - La vinculación correcta queda así:
    - `LeadIntake.clinica_id`
    - `Conversation.clinic_id`
    - `Conversation.lead_id -> LeadIntake.id`
  - `Lead` legacy no debe usarse ya en código nuevo de marketing/chat.

### Contrato canónico del catálogo de automatizaciones

El endpoint `/api/automation-catalog` acepta solo estos `trigger_type`:

- `lead_nuevo`
- `appointment_created`
- `appointment_confirmed`
- `appointment_cancelled`
- `appointment_reminder_window`
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

- Ventana de 24h en WhatsApp
  - Enviar una plantilla no abre la sesión libre.
  - La sesión pasa a abierta solo cuando entra una respuesta inbound del lead (`last_inbound_at`).
