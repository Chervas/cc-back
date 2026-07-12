# Lead válido y conversión `qualified_lead`

`LeadIntake.status_lead = cualificado` representa un contacto con datos utilizables, que ha respondido y muestra interés real. `contactado` no equivale a cualificado.

Al marcar explícitamente el estado mediante `PATCH /api/intake/leads/:id`, el backend intenta enviar `qualified_lead` con el ID idempotente `lead-{id}-qualified`. Una cita real enlazada asegura primero ese mismo hito y después `Schedule` con `appointment-{id}`. Un fallo de Google no revierte el trabajo CRM; queda reflejado por el pipeline de auditoría y se puede reintentar con el mismo ID.

La acción canónica es `Qualified Lead - ClinicaClick`, categoría oficial `QUALIFIED_LEAD`, tipo `UPLOAD_CLICKS`, `MANY_PER_CLICK` y `primaryForGoal=false`. No forma parte de los eventos activados por defecto: solo se usa cuando cada cuenta tiene un destino explícito para `google_ads.events.qualified_lead`.

Las conversiones mejoradas de este evento mantienen la allowlist estricta de email y teléfono. No se envían notas, tratamiento, motivo de consulta, URL ni otros datos clínicos.

La migración `20260712123000-add-qualified-lead-status.js` amplía el ENUM. Su `down` transforma `cualificado` a `info_recibida` antes de restaurar el catálogo anterior, sin borrar leads.
