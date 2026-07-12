# Google Data Manager: conversiones server-side

## Transporte y contrato

Las conversiones de ClinicaClick se envían mediante `POST https://datamanager.googleapis.com/v1/events:ingest`.
El destino contiene la cuenta operativa de Google Ads, la cuenta manager usada para acceder y el ID numérico de la acción `UPLOAD_CLICKS`.

Cada evento conserva:

- `gclid`, `gbraid` o `wbraid` como identificador publicitario, cuando existe;
- `transactionId` estable para deduplicación también en Google;
- fecha en RFC 3339, valor, moneda y origen;
- `eventName`, `clientId`, `userId` y propiedades del usuario cuando están disponibles;
- email, teléfono y nombre/dirección completos normalizados y convertidos a SHA-256 hexadecimal según corresponda;
- `adUserData` cuando el consentimiento está disponible.

No se transmite la IP. Un evento puede usar datos proporcionados por el usuario aunque no haya click ID, siempre que tenga al menos un identificador válido. El dedupe propio usa cuenta, acción, evento y el hash del click ID o, en su ausencia, una huella de los identificadores ya hasheados; los valores personales nunca se guardan en la auditoría.

Si un evento tiene más de un destino configurado, no se envía a todos por defecto. `customer_id` solo puede seleccionar una cuenta que ya figure en la configuración; también puede usarse una asociación configurada de `campaign_id`. Sin un selector inequívoco se devuelve `ambiguous_destination`. El cliente nunca puede indicar ni sustituir `conversion_action`, `conversion_action_id` o `send_to`.

Un HTTP 200 solo deja el intento en `accepted`: Google procesa la petición de forma asíncrona. El job `googleDataManagerDiagnostics` consulta `requestStatus:retrieve` y cierra el intento como `succeeded`, `partial_success` o `failed`.

## Requisitos antes del despliegue

1. Habilitar Data Manager API en el proyecto de Google Cloud del OAuth client.
2. Añadir el scope sensible `https://www.googleapis.com/auth/datamanager` a la pantalla de consentimiento y completar la verificación OAuth requerida para usuarios externos.
3. Configurar `GOOGLE_OAUTH_SCOPES` con los scopes actuales más `datamanager`.
4. Configurar `GOOGLE_DATA_MANAGER_QUOTA_PROJECT` con el ID del proyecto Cloud y conceder `serviceusage.services.use` al principal OAuth. Todas las peticiones REST envían ese valor en `x-goog-user-project`.
5. Reconectar cada asignación Google usada por marketing. Un refresh token previo no adquiere scopes nuevos.
6. En cada cuenta de Google Ads, aceptar los términos de datos de clientes y de conversiones mejoradas y habilitar las conversiones mejoradas. La cuenta de acceso debe tener permiso de escritura sobre la cuenta operativa.
7. Ejecutar el endpoint autenticado `POST /api/marketing/google-ads/conversions/data-manager/validate` para cada cuenta/acción. Usa `validateOnly=true` y no ingiere una conversión.

El dry-run comprueba formato, scope, acceso, destino y restricciones síncronas. No genera `requestId` utilizable en Diagnostics y no demuestra atribución. La validación completa requiere una conversión consentida con click ID real, seguida de Diagnostics al menos 30 minutos después.

## Provisioning de acciones

La creación de acciones continúa en Google Ads API porque Data Manager es el transporte de eventos, no el gestor de acciones de conversión. El provisioning:

- solo reutiliza nombres canónicos exactos de ClinicaClick (`Lead - ClinicaClick`, `Contact - ClinicaClick`, `Schedule - ClinicaClick` y `Purchase - ClinicaClick`);
- requiere `create_missing=true` y `confirm_external_mutation=true`;
- crea únicamente las acciones canónicas ausentes, las deja como secundarias (`primaryForGoal=false`) y usa `MANY_PER_CLICK`, necesario para admitir `gbraid`/`wbraid` en Data Manager;
- no actualiza, desactiva ni elimina acciones preexistentes del cliente.

La promoción posterior a acción primaria o su incorporación a un objetivo personalizado no forma parte de este flujo. Solo podrá ejecutarse como una mutación separada, explícita y auditada después de que Diagnostics confirme eventos correctos; nunca se degradan ni desactivan automáticamente las acciones del cliente. Si ya existe una acción con el nombre canónico exacto, se reutiliza sin duplicarla ni cambiar su estado o prioridad.

Una acción canónica preexistente con `ONE_PER_CLICK` también se reutiliza sin modificarla. Los eventos con `gclid` o solo `UserData` pueden seguir procesándose, pero Google puede rechazar sus eventos `gbraid`/`wbraid` con `PROCESSING_ERROR_REASON_ONE_PER_CLICK_CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID`. Corregir esa acción requiere una decisión y mutación explícitas; Diagnostics conserva el motivo para que no se confunda con una conversión correcta.

## Referencias oficiales

- https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade
- https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade/field-mappings
- https://developers.google.com/data-manager/api/devguides/events/send-events
- https://developers.google.com/data-manager/api/devguides/diagnostics
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- https://developers.google.com/google-ads/api/docs/conversions/goals/overview
