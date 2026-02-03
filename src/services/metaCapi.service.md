# Meta CAPI quick reference

- Pixel: `META_PIXEL_ID=1934640910745789`
- Token: `META_CAPI_TOKEN=<token>` (no registrar en logs).
- API version: `META_API_VERSION=v25.0` (fallbacks en `META_API_FALLBACKS`).

## Eventos
- `ViewContent`: visita landing (snippet).
- `Lead`: ingesta formulario / intake.
- `Contact`: formulario “Te llamamos” / click tel interceptado / chat web.
- `Schedule`: cita confirmada.
- `Purchase`: tratamiento realizado (`value` = precio, `currency=EUR`).

## Campos enviados
- `event_name`, `event_time`, `event_id` (dedupe), `action_source=website`, `event_source_url` (si aplica).
- `custom_data`: `clinic_id`, `source`, `source_detail`, `utm_campaign`, `value`/`currency` para Purchase.
- `user_data` (SHA-256 salvo ip/ua/fbp/fbc): `em`, `ph`, `external_id`, `client_ip_address`, `client_user_agent`, opcional `fbp`, `fbc`.

## Código
- Servicio: `src/services/metaCapi.service.js`
- Uso típico:
```js
const { sendLead, buildUserData } = require('./metaCapi.service');
const userData = buildUserData({ email, phone, ip, ua, fbp, fbc, externalId: lead.id });
await sendLead({ eventName: 'Lead', eventId: `lead-${lead.id}`, eventSourceUrl, clinicId, source, sourceDetail, utmCampaign, userData });
```

## Notas
- No enviar tokens por logs.
- Deduplicar con el mismo `event_id` si hay envío browser-side.
- Mantener valores E.164 en teléfono antes de hash.
