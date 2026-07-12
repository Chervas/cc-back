# Google Data Manager: conversiones server-side

## Transporte y contrato

Las conversiones de ClinicaClick se envían mediante `POST https://datamanager.googleapis.com/v1/events:ingest`.
El destino contiene la cuenta operativa de Google Ads, la cuenta manager usada para acceder y el ID numérico de la acción `UPLOAD_CLICKS`.

Cada evento conserva:

- `gclid`, `gbraid` o `wbraid` como identificador publicitario, cuando existe;
- `transactionId` estable para deduplicación también en Google;
- fecha en RFC 3339, valor, moneda y origen;
- `eventName`;
- `adUserData` y `adPersonalization` cuando existe una decisión explícita y separada del visitante.

El transporte estándar de conversiones offline no transmite IP, email, teléfono, nombre, dirección, `clientId`, `userId`, propiedades de usuario, URL ni atributos de sesión. Usa únicamente el identificador publicitario permitido y los datos del evento. ClinicaClick conserva en su CRM los datos first-party necesarios.

Existe una capacidad técnica separada para Conversiones mejoradas, siempre desactivada por defecto. Está limitada en código a Propdental, a las cuentas `1851215478` y `5992356722` y a Lead, Contact y Schedule. Si se habilitara con autorización válida, solo normalizaría y enviaría email y teléfono como hashes SHA-256 HEX; fuerza `adUserData=GRANTED`, `adPersonalization=DENIED` y excluye nombre, dirección, URL, tratamiento, Customer Match, listas basadas en conversiones, audiencias y remarketing. Cada cuenta/evento necesita una allowlist y referencias de orientación de Google y autorización del anunciante; el audit guarda el digest y las referencias, nunca la PII cruda.

La política pública vigente de Google dice expresamente que las conversiones relacionadas con salud o servicios médicos no pueden medirse con Enhanced Conversions. La conversación aportada con el equipo de cuenta y la autorización del anunciante se registran honestamente como orientación, no como una excepción formal a esa política. Por ello la configuración live mantiene `enhanced_conversions.enabled=false` y `user_data_enabled=false`. Un email de soporte, el ajuste visible en Google Ads, un `validateOnly` correcto o un HTTP 200 no sustituyen una autorización de política aplicable a estas cuentas y eventos.

Sin un click ID permitido, o sin user data expresamente autorizado, el evento se audita como `no_permitted_identifiers` y no sale a Google. El dedupe propio usa cuenta, acción, evento y el hash del identificador disponible; ni el click ID ni la PII se guardan en claro.

Si un evento tiene más de un destino configurado, no se envía a todos por defecto. `customer_id` solo puede seleccionar una cuenta que ya figure en la configuración; también puede usarse una asociación configurada de `campaign_id`. Sin un selector inequívoco se devuelve `ambiguous_destination`. El cliente nunca puede indicar ni sustituir `conversion_action`, `conversion_action_id` o `send_to`.

Un HTTP 200 solo deja el intento en `accepted`: Google procesa la petición de forma asíncrona. El job `googleDataManagerDiagnostics` consulta `requestStatus:retrieve` y cierra el intento como `succeeded`, `partial_success` o `failed`.

## Requisitos antes del despliegue

1. Habilitar Data Manager API en el proyecto de Google Cloud del OAuth client.
2. Añadir el scope sensible `https://www.googleapis.com/auth/datamanager` a la pantalla de consentimiento y completar la verificación OAuth requerida para usuarios externos.
3. Configurar `GOOGLE_OAUTH_SCOPES` con los scopes actuales más `datamanager`.
4. Configurar `GOOGLE_DATA_MANAGER_QUOTA_PROJECT` con el ID del proyecto Cloud y conceder `serviceusage.services.use` al principal OAuth. Todas las peticiones REST envían ese valor en `x-goog-user-project`.
5. Reconectar cada asignación Google usada por marketing. Un refresh token previo no adquiere scopes nuevos.
6. La cuenta de acceso debe tener permiso de escritura sobre la cuenta operativa. Para cuentas sanitarias/dentales, mantener desactivada la PII mientras la política pública siga prohibiéndola o hasta recibir una autorización formal inequívoca aplicable al caso.
7. Ejecutar el endpoint autenticado `POST /api/marketing/google-ads/conversions/data-manager/validate` para cada cuenta/acción. Usa `validateOnly=true` y no ingiere una conversión.

El dry-run usa el placeholder publicitario `GCLID_1` de la documentación oficial, `validateOnly=true` y cero PII. Comprueba formato, scope, acceso, destino y restricciones síncronas; no genera `requestId` utilizable en Diagnostics ni demuestra atribución. La validación completa requiere una conversión consentida con click ID real, seguida de Diagnostics al menos 30 minutos después.

### Evidencia Propdental del 2026-07-12

- El OAuth del grupo `5` conserva ocho scopes e incluye `https://www.googleapis.com/auth/datamanager`.
- Lead, Contact y Schedule devolvieron HTTP 200 con `validateOnly=true` en `1851215478` y `5992356722`: seis validaciones correctas y cero conversiones ficticias ingeridas.
- Otras seis peticiones `validateOnly=true`, esta vez con email y teléfono **sintéticos**, hasheados en el request de Data Manager, devolvieron HTTP 200 y `requestId` de validación para las mismas combinaciones. Verifican formato, OAuth y aceptación síncrona; no acreditan permiso de política ni generan conversiones.
- Las acciones Purchase de ambas cuentas devolvieron también HTTP 200 y `requestId` con click ID sintético, `validateOnly=true` y cero PII antes de habilitar el hito de tratamiento.
- Ambas cuentas tienen aceptados los términos de datos. `enhanced_conversions_for_leads_enabled` se relee como `false` —el escalar protobuf se omite—, por lo que el interruptor de Google Ads tampoco está activo.
- Chromium mostró el paso 5 listo, sin bloqueos de medición ni errores de API. No se ejecutó el paso, no se pulsó `Play` y no se aplicó ningún custom goal.
- El contacto real `LeadIntake 7180`, atribuido por GCLID a Sant Martí y con `ad_user_data=granted`, había fallado previamente porque Google rechazó `UploadClickConversions` para una integración nueva. El primer reintento por Data Manager destapó una contaminación del destino: el evento `contact` conservaba su ID específico, pero heredaba el resource global de `Lead`, que tenía prioridad al construir la petición.
- El selector se corrigió para resolver `conversion_action`, `conversion_action_id` y `send_to` como una única alternativa por evento/destino. Hay regresiones para Lead, Contact, Schedule y Purchase en las dos cuentas. En staging resuelven respectivamente a las acciones canónicas esperadas y ya no heredan el resource de Lead.
- Tras desplegar la corrección se reenvió el contacto únicamente a `Contact - ClinicaClick` de `1851215478`, con el mismo evento, click ID y consentimiento, sin PII. Diagnostics confirmó el Contact correcto. El envío previo a Lead también llegó a materializarse y se retiró mediante `ConversionAdjustment` con el mismo `transactionId`; Google aceptó la retracción y el audit quedó marcado como `retracted_wrong_action`.

## Hitos offline del CRM

- `Schedule` se genera cuando una cita vinculada a un lead se agenda. Es una conversión offline del CRM aunque su valor sea cero.
- Una cita completada sin tratamiento actualiza el lead a `acudio_cita`; no se reutiliza una acción de Google con semántica incorrecta.
- Una cita completada con `tratamiento_id`, o de tipo `primera_con_trat`, actualiza el lead a `convertido` y genera `Purchase - ClinicaClick` con ID idempotente `appointment-{id}-treatment-completed`.
- Purchase usa el `precio_base` válido del tratamiento o `0 EUR` cuando no hay un valor fiable. No envía el nombre ni el tipo de tratamiento ni ningún dato clínico como parámetro.
- Lead y Contact brutos continúan como señales secundarias. El plan inicial de puja incluye solo Schedule; Purchase se observará como señal de negocio antes de decidir una promoción posterior.

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

El plugin no ve llamadas directas desde el anuncio porque el usuario no visita la web. Aun así, en Propdental el anunciante ha priorizado mostrar su número directo y evitar prefijos ajenos: `call_reporting_enabled=false` en ambas cuentas. No se borraron los recursos ni los teléfonos, pero Google deja de asignar el número de desvío y de ofrecer duración y `call_view`; por coherencia, `AD_CALL` queda fuera del custom goal.

Evidencia de Propdental al 2026-07-12:

- `1851215478` ya tenía el reporting de llamadas desactivado. Sus acciones históricas `AD_CALL` no se borraron, pero no entran en la nueva política de puja.
- En `5992356722` se cambió el ajuste de cuenta de `true` a `false` mediante Google Ads API v24 y se releyó el valor. Se conservaron `callConversionReportingEnabled`, los call assets y los números reales. El cambio puede tardar hasta 24 horas en reflejarse en todos los anuncios.
- En esa cuenta afecta a las Smart activas `Dentista en Hospitatet`, `Clinica Dental Badalona`, `Clinica Dental en Badalona` y `Buenos Dentistas y Personal`. Google declara obligatorio el GFN para Smart nuevas con teléfono en países compatibles; la mutación fue aceptada para las campañas existentes.
- Las acciones de clic telefónico observadas no deben convertirse en señal principal como sustituto de una llamada real.
- Una consulta live read-only forzada a Google Ads API v24 devolvió correctamente los campos usados y la mutación de cuenta se validó y aplicó con esa versión. El transporte de conversiones de clic usa Data Manager; el resto del cliente general de Google Ads debe seguir su promoción a v24 con regresiones independientes.

## Monitorización

- Diagnostics de cargas Data Manager: cada 30 minutos.
- Auditoría read-only de acciones, custom goal y campañas opt-in estables: una vez al día, a las 02:17. El `apply` hace además una verificación inmediata antes y después de cualquier cambio aprobado.
- La auditoría no autorepara ni hace mutaciones externas; cualquier cambio exige preview, digest vigente y confirmación explícita.

## Referencias oficiales

- https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade
- https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade/field-mappings
- https://developers.google.com/data-manager/api/devguides/events/send-events
- https://developers.google.com/data-manager/api/devguides/diagnostics
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- https://developers.google.com/google-ads/api/docs/conversions/goals/overview
- https://support.google.com/google-ads/answer/7475709
