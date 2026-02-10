# Intake: WhatsApp Web Origin (`cc_ref`)

Objetivo: atribuir conversaciones entrantes de WhatsApp a un origen web (UTMs/gclid/fbclid + page_url) incluso cuando el usuario inicia el chat desde la web y **no deja su teléfono** en el widget antes de abrir WhatsApp.

## Cómo funciona

1. El snippet genera un token corto por click (12 hex) y lo añade al texto pre-rellenado:

```text
Hola...

[cc_ref:abcdef123456]
```

2. El snippet registra el token en backend con contexto de atribución:

`POST /api/intake/whatsapp-origin`

3. Cuando entra el mensaje por webhook de WhatsApp:

- Se extrae `cc_ref` del texto.
- Se busca en tabla `WhatsAppWebOrigins`.
- Se fuerza la asignación del inbound a la `clinic_id` del origen (útil cuando el número es compartido por grupo).
- El worker **elimina el token del texto** antes de guardar el mensaje y guarda la atribución en `Message.metadata.web_origin`.
- Se marca el origen como usado (`used_at`, `used_conversation_id`, `used_message_id`).

Limitación: si el usuario borra el token antes de enviar el mensaje, no se puede enlazar el inbound con el origen web (best-effort).

## Endpoint: `POST /api/intake/whatsapp-origin` (público)

### Body (JSON)

- `ref` (string, requerido): hex `[a-f0-9]{8,64}`, recomendado 12 chars.
- `clinic_id` (number, requerido si no hay `group_id`): sede destino.
- `group_id` (number, opcional): grupo al que pertenece la config/snippet.
- `domain` (string, recomendado): hostname de la web instaladora.
- `page_url` (string, recomendado)
- `referrer` (string, opcional)
- `utm_source|utm_medium|utm_campaign|utm_content|utm_term` (opcionales)
- `gclid|fbclid|ttclid` (opcionales)
- `metadata` (object, opcional): info adicional (p. ej. `wa_phone`, `location_id`, `mode`).

### Seguridad

- **CORS abierto** para `/api/intake/*` (ver `src/app.js`), pero el controlador aplica:
  - allowlist de dominios si existe `IntakeConfig.domains`
  - HMAC obligatorio si existe `IntakeConfig.hmac_key`

Headers relevantes:

- `X-CC-Signature-SHA256`: HMAC del body (hex sha256).
- `X-CC-Event-ID`: se persiste en `event_id` (opcional, debug).

### Respuesta

```json
{
  "success": true,
  "ref": "abcdef123456",
  "id": 123,
  "created": true,
  "expires_at": "2026-02-17T23:29:26.503Z"
}
```

## Persistencia

Tabla: `WhatsAppWebOrigins` (migración `20260210233000-create-whatsapp-web-origins.js`)

Campos clave:

- `ref` (unique)
- `clinic_id`, `group_id`
- `domain`, `page_url`, UTMs, `gclid`, `fbclid`, `ttclid`
- `expires_at` (TTL)
- `used_at`, `used_conversation_id`, `used_message_id`

TTL configurable:

- `WHATSAPP_WEB_ORIGIN_TTL_DAYS` (default: `7`)

## Webhook y worker

- Route: `src/routes/whatsapp-webhook.routes.js`
  - extrae `cc_ref` del payload y lo pasa al job (`web_origin_ref`)
  - si existe `WhatsAppWebOrigin`, prioriza `clinic_id`/`group_id` del origen para asignación
- Worker: `src/workers/queue.workers.js` (`webhook_whatsapp`)
  - elimina el token del texto antes de guardar `Message.content`
  - adjunta atribución en `Message.metadata.web_origin`
  - marca `WhatsAppWebOrigins.used_*` (best-effort, no bloquea)

