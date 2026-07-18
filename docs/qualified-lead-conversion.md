# Lead válido y conversión `qualified_lead`

> **Actualización 2026-07-18:** Mejora provisiona QL al activar y puede promocionar automáticamente a Schedule con evidencia suficiente; Piloto mantiene el gate de operador.

`LeadIntake.status_lead = cualificado` representa un contacto con datos utilizables, que ha respondido y muestra interés real. `contactado` no equivale a cualificado.

Al marcar explícitamente el estado mediante `PATCH /api/intake/leads/:id`, el backend intenta enviar `qualified_lead` con el ID idempotente `lead-{id}-qualified`. Una cita real enlazada asegura primero ese mismo hito y después `Schedule` con `appointment-{id}`. Un fallo de Google no revierte el trabajo CRM; queda reflejado por el pipeline de auditoría y se puede reintentar con el mismo ID.

La acción canónica es `Qualified Lead - ClinicaClick`, categoría oficial `QUALIFIED_LEAD`, tipo `UPLOAD_CLICKS`, `MANY_PER_CLICK` y `primaryForGoal=false`. Un onboarding nuevo habilita el evento, pero cada cuenta sigue necesitando un destino explícito para `google_ads.events.qualified_lead`; nunca hereda ambiguamente el mapping legacy de Lead. En Propdental existen destinos separados para `1851215478` (`7682299115`) y `5992356722` (`7682721076`); el evento selecciona una única cuenta mediante la configuración/atribución y nunca replica una conversión ambiguamente en ambas.

La política de valores configura Qualified Lead con `10 EUR`. Es un peso relativo de reporting/optimización (`value_is_revenue=false`), no ingreso, precio, margen ni ROAS; el hito no fija un importe propio y el uploader hereda ese valor de la configuración.

Las conversiones mejoradas de este evento mantienen la allowlist estricta de email y teléfono. El aviso frontend v4 agrupa `ad_user_data` y `ad_personalization` bajo la elección de Marketing para simplificar la UX, pero el backend conserva ambas señales separadas: solo incluye los hashes con `ad_user_data=GRANTED` y transmite la elección real de personalización cuando el evento está permitido. No se envían notas, tratamiento, motivo de consulta, URL ni otros datos clínicos.

En **Mejora**, activar una estrategia Google Search/PMax después de aceptar el mandato inicial crea la policy directamente en `qualified_lead` y encola un apply durable. La medición es un gate previo, no una etapa persistida. El executor usa preview y digest vigentes, `validateOnly`, comprobación de drift y readback, y no convierte la acción en primaria global ni modifica acciones del cliente.

El salto posterior de QL a Schedule sí es automático en **Mejora**: el evaluador construye 12 semanas con `CitasPacientes.inicio`; cuando supera los umbrales y dos evaluaciones separadas al menos 24 horas, un `JobRequest` reutiliza como aprobación cliente el mandato inicial, aplica el goal de Schedule y solo avanza la etapa con readback saludable. No requiere otro clic ni aprobación de operador.

En **Piloto automático**, `managedCampaignOptimizationPolicy.service.js` puede usar QL como único objetivo de puja de una cohorte gestionada. La entrada en `launching/active` requiere aprobación admin persistida y provisiona la policy idempotentemente. Las promociones posteriores siguen siendo operativas: una evaluación `ready` no se aplica sin aprobación del operador. En Propdental esta capacidad está implementada, pero el snapshot actual sigue en `draft + observe`, sin una policy aplicada ni un piloto activo.

La migración `20260712123000-add-qualified-lead-status.js` amplía el ENUM. Su `down` transforma `cualificado` a `info_recibida` antes de restaurar el catálogo anterior, sin borrar leads.
