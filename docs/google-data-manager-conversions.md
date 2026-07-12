# Google Data Manager: conversiones server-side

## Transporte y contrato

Las conversiones de ClinicaClick se envían mediante `POST https://datamanager.googleapis.com/v1/events:ingest`.
El destino contiene la cuenta operativa de Google Ads, la cuenta manager usada para acceder y el ID numérico de la acción `UPLOAD_CLICKS`.

Cada evento conserva:

- `gclid`, `gbraid` o `wbraid` como identificador publicitario, cuando existe;
- `transactionId` estable para deduplicación también en Google;
- fecha en RFC 3339, valor, moneda y origen;
- `eventName`;
- `adUserData` cuando el consentimiento está disponible.

No se transmiten IP, email, teléfono, nombre, dirección, `clientId`, `userId`, propiedades de usuario ni atributos de sesión. ClinicaClick conserva en su CRM los datos first-party necesarios. La política publicada de Google prohíbe usar Enhanced Conversions para conversiones relacionadas con categorías sensibles e incluye la información sanitaria o médica; no aclara literalmente si una solicitud genérica de primera cita dental, sin diagnóstico ni tratamiento, queda dentro o fuera. Por eso `user_data_enabled` vale `false` por defecto y el backend fuerza `user_data_policy=blocked_healthcare` aunque una configuración intente habilitarlo.

Una futura habilitación de user-provided data debe ser fail-closed y por cuenta/acción. Requiere confirmación escrita del equipo de Políticas de Google con cuentas, evento, campos autorizados y `case ID`, además de consentimiento válido y revisión legal. Una recomendación verbal, la activación del ajuste en Google Ads, un `validateOnly` correcto o un HTTP 200 no bastan. Customer Match, las listas basadas en conversiones y la detección automática de PII permanecen fuera de este contrato.

Sin un click ID permitido el evento se audita como `no_permitted_identifiers` y no sale a Google. El dedupe propio usa cuenta, acción, evento y el hash del click ID; el valor del click tampoco se guarda en claro.

Si un evento tiene más de un destino configurado, no se envía a todos por defecto. `customer_id` solo puede seleccionar una cuenta que ya figure en la configuración; también puede usarse una asociación configurada de `campaign_id`. Sin un selector inequívoco se devuelve `ambiguous_destination`. El cliente nunca puede indicar ni sustituir `conversion_action`, `conversion_action_id` o `send_to`.

Un HTTP 200 solo deja el intento en `accepted`: Google procesa la petición de forma asíncrona. El job `googleDataManagerDiagnostics` consulta `requestStatus:retrieve` y cierra el intento como `succeeded`, `partial_success` o `failed`.

## Requisitos antes del despliegue

1. Habilitar Data Manager API en el proyecto de Google Cloud del OAuth client.
2. Añadir el scope sensible `https://www.googleapis.com/auth/datamanager` a la pantalla de consentimiento y completar la verificación OAuth requerida para usuarios externos.
3. Configurar `GOOGLE_OAUTH_SCOPES` con los scopes actuales más `datamanager`.
4. Configurar `GOOGLE_DATA_MANAGER_QUOTA_PROJECT` con el ID del proyecto Cloud y conceder `serviceusage.services.use` al principal OAuth. Todas las peticiones REST envían ese valor en `x-goog-user-project`.
5. Reconectar cada asignación Google usada por marketing. Un refresh token previo no adquiere scopes nuevos.
6. La cuenta de acceso debe tener permiso de escritura sobre la cuenta operativa. Para cuentas sanitarias/dentales, mantener desactivada por defecto la PII de conversiones mejoradas hasta disponer de la confirmación escrita descrita arriba.
7. Ejecutar el endpoint autenticado `POST /api/marketing/google-ads/conversions/data-manager/validate` para cada cuenta/acción. Usa `validateOnly=true` y no ingiere una conversión.

El dry-run usa el placeholder publicitario `GCLID_1` de la documentación oficial, `validateOnly=true` y cero PII. Comprueba formato, scope, acceso, destino y restricciones síncronas; no genera `requestId` utilizable en Diagnostics ni demuestra atribución. La validación completa requiere una conversión consentida con click ID real, seguida de Diagnostics al menos 30 minutos después.

### Evidencia Propdental del 2026-07-12

- El OAuth del grupo `5` conserva ocho scopes e incluye `https://www.googleapis.com/auth/datamanager`.
- Lead, Contact y Schedule devolvieron HTTP 200 con `validateOnly=true` en `1851215478` y `5992356722`: seis validaciones correctas y cero conversiones ficticias ingeridas.
- Chromium mostró el paso 5 listo, sin bloqueos de medición ni errores de API. No se ejecutó el paso, no se pulsó `Play` y no se aplicó ningún custom goal.
- El contacto real `LeadIntake 7180`, atribuido por GCLID a Sant Martí y con `ad_user_data=granted`, había fallado previamente porque Google rechazó `UploadClickConversions` para una integración nueva. Se reintentó por Data Manager con el mismo identificador idempotente, sin PII y solo contra el destino `1851215478`; Google devolvió `requestId` y el intento quedó `accepted`, pendiente de Diagnostics.

## Provisioning de acciones

La creación de acciones continúa en Google Ads API porque Data Manager es el transporte de eventos, no el gestor de acciones de conversión. El provisioning:

- solo reutiliza nombres canónicos exactos de ClinicaClick (`Lead - ClinicaClick`, `Contact - ClinicaClick`, `Schedule - ClinicaClick` y `Purchase - ClinicaClick`);
- requiere `create_missing=true` y `confirm_external_mutation=true`;
- crea únicamente las acciones canónicas ausentes, las deja como secundarias (`primaryForGoal=false`) y usa `MANY_PER_CLICK`, necesario para admitir `gbraid`/`wbraid` en Data Manager;
- no actualiza, desactiva ni elimina acciones preexistentes del cliente.

La promoción posterior a acción primaria o su incorporación a un objetivo personalizado no forma parte de este flujo. Solo podrá ejecutarse como una mutación separada, explícita y auditada después de que Diagnostics confirme eventos correctos; nunca se degradan ni desactivan automáticamente las acciones del cliente. Si ya existe una acción con el nombre canónico exacto, se reutiliza sin duplicarla ni cambiar su estado o prioridad.

Una acción canónica preexistente con `ONE_PER_CLICK` también se reutiliza sin modificarla. Los eventos con `gclid` pueden seguir procesándose, pero Google puede rechazar sus eventos `gbraid`/`wbraid` con `PROCESSING_ERROR_REASON_ONE_PER_CLICK_CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID`. Corregir esa acción requiere una decisión y mutación explícitas; Diagnostics conserva el motivo para que no se confunda con una conversión correcta.

## Llamadas: contrato separado

La retirada anunciada por Google afecta a los anuncios exclusivamente de llamada (`call-only ads`): no pueden crearse desde febrero de 2026 y dejarán de recibir impresiones en febrero de 2027. No se retiran los recursos de llamada ni la medición telefónica.

- `AD_CALL` mide una llamada real desde un anuncio o recurso de llamada mediante un número de desvío de Google y un umbral de duración.
- `WEBSITE_CALL` mide una llamada real desde la web sustituyendo dinámicamente el teléfono tras un clic publicitario.
- `CLICK_TO_CALL` y algunas acciones `GOOGLE_HOSTED` miden un clic o una estimación, no demuestran una conversación.
- `UPLOAD_CALLS` permite importar desde CRM/centralita el resultado y valor de una llamada que pasó por un número de desvío de Google. Sigue usando Google Ads API; la migración a Data Manager descrita aquí corresponde a conversiones derivadas de clic.

El plugin no ve llamadas directas desde el anuncio porque el usuario no visita la web. Por ello un custom goal de captación no puede sustituir ciegamente las acciones telefónicas por Contact. Debe conservar acciones `AD_CALL` verificadas mediante un allowlist explícito, sin modificarlas, y mantener aparte cualquier goal ajeno como `Leads FRANCIA`.

Evidencia de Propdental al 2026-07-12:

- `1851215478` conserva `Llamadas desde anuncios PROPDENTAL` y la variante Francia como `AD_CALL`, ambas con umbral de 5 segundos. `call_view` devolvió 13 llamadas en los 90 días anteriores: seis recibidas y cuatro de al menos 60 segundos. El umbral actual no debe cambiarse sin revisar calidad y obtener aprobación.
- `5992356722` usa para sus Smart campaigns la acción Google `Calls from Smart Campaign Ads` con umbral de 30 segundos. La campaña Smart de Hospitalet registró tres `Business profile - Call` en los últimos 30 días.
- Las acciones de clic telefónico observadas no deben convertirse en señal principal como sustituto de una llamada real.

## Monitorización

- Diagnostics de cargas Data Manager: cada 30 minutos.
- Auditoría read-only de acciones, custom goal y campañas opt-in: cada hora, en el minuto 17.
- La auditoría no autorepara ni hace mutaciones externas; cualquier cambio exige preview, digest vigente y confirmación explícita.

## Referencias oficiales

- https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade
- https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade/field-mappings
- https://developers.google.com/data-manager/api/devguides/events/send-events
- https://developers.google.com/data-manager/api/devguides/diagnostics
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- https://developers.google.com/google-ads/api/docs/conversions/goals/overview
- https://support.google.com/google-ads/answer/7475709
