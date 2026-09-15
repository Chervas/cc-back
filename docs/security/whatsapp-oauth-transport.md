# Transporte privado de canje y prueba de pertenencia WhatsApp

> **Tipo:** contrato técnico y procedimiento de canje.
> **Fuente de verdad:** transporte de códigos del SDK, límites y pruebas; madurez en [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).
> **Última revisión del canje SDK:** 2026-09-15.

Integrado en el [broker durable del alta](whatsapp-onboarding-broker.md).
La instalación y una prueba ficticia no acreditan autorización real de Meta.

## Canje con configuración fijada

`createWhatsappOAuthHttp({appId,redirectUri,...})` fija al construir el transporte
una aplicación y la URI HTTPS de la página que inicia el SDK, sin usuario,
puerto, query o fragmento. El nombre `redirectUri` se conserva por compatibilidad
del binding/DTO: **no es el retorno OAuth manual**. `FB.login` construye su propio
canal de retorno. No enviar `redirect_uri` en sus opciones; el canje de ese código
usa `redirect_uri` vacío, como el helper JavaScript oficial. No ofrecer variantes
ni reintentar con la URI de ClinicaClick. La configuración
procederá del lote aprobado, nunca del cuerpo del callback. Se ejecuta un único
GET a `graph.facebook.com/v24.0/oauth/access_token`, sin redirección, reintento,
variantes de URI o credenciales alternativas. TLS verificado, mínimo TLS 1.2,
JSON sin compresión, máximo 32 KiB y 8 s de plazo de red por defecto.

El protocolo de canje lleva código y app secret en la query HTTPS directa a
Meta. No registrar URL, parámetros, errores crudos, cabeceras ni trazas APM de
esa salida. Tampoco devolver esa URL al navegador/API. El transporte no añade
instrumentación de logs. Al integrarlo, la clave debe leerse desde Secrets Manager
dentro del broker, sin usar el `.env` de la API general; esa unión está preparada
en el runtime de alta, pendiente de instalación/configuración real.

`withExchangedToken({code,appSecret,signal?}, callback)` toma buffers y los copia
antes del primer await. Solo el callback interno recibe el token canjeado y
la caducidad comunicada en `expires_in`, cuando existe. Caducidad ausente requiere
contraste con el inspector; no se traduce en duración ilimitada verificada.
La operación completa tiene plazo de 25 s y propaga cancelación al callback.

`token_type` es una pista opcional en la respuesta JSON del canje; cuando
aparece debe ser `bearer` (sin distinguir mayúsculas). Ausencia no acredita
tipo, validez ni permisos: siguen verificándose con `debug_token` antes de
guardar una candidata. Valores nulos, tipos distintos o un token ausente se
rechazan. La [guía oficial para Tech Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider/)
describe el business token como resultado sin exigir esa pista adicional.

Si se interrumpe antes de guardar una candidata, la auditoría conserva además
un motivo fijo `whatsapp_failed_<fase>` (lectura de aplicación, canje,
inspección de permisos, pertenencia del número o preparación de candidata).
Las fases proceden del código, nunca de mensajes del proveedor. No se conservan
respuestas crudas para diagnosticar; un intento interrumpido no vuelve a canjear
su código y requiere una nueva autorización humana después de corregir el fallo.

El resultado externo del helper solo admite App ID, sujeto, WABA, número, tipo
de token, scopes WhatsApp/public_profile y expiraciones. Rechaza campos extra,
Ads/leads/business_management, ampliación de caducidad, secretos en valores y
errores crudos del callback. El callback debe **verificar** identidad, permisos
y pertenencia antes de devolver esa metadata; el formato por sí solo no prueba
que Meta haya autorizado la cuenta. La prueba de composición usa el inspector
real con respuestas ficticias, no una afirmación del navegador.

Se borran las copias propias de código, app secret, buffers de respuesta y token
al salir, también por error o cancelación. La copia de comprobación se conserva
separada del buffer prestado, para que una mutación del callback no eluda la
comprobación de fuga. Las cadenas JS/HTTP/JSON y copias que haga código interno
no permiten prometer borrado físico completo. Cancelar la espera no deshace una
escritura remota ya aceptada ni fuerza a parar un callback que ignore la señal.

## WABA y número

El transporte WhatsApp añade la acción **interna** `phones`, GET fijo
`/{WABA}/phone_numbers?fields=id&limit=100`, Bearer y appsecret_proof. No expone
otra operación en `/v1/execute` ni amplía los grants del principal de envío.
`createWhatsappPhoneVerifier` acredita la presencia del ID del número en ese
edge. Un ID recibido del navegador no se acepta como prueba de pertenencia.

Solo se consume el cursor acotado del proveedor, reconstruyendo el endpoint
fijo; nunca se sigue `paging.next`, que puede contener URL y token. Máximo 20
páginas de 100 IDs, rechazo de duplicados, cursor repetido/inválido, página
incompleta o agotamiento del límite. Un número ausente produce `scope_denied`.
No devuelve nombres, teléfonos visibles, calidad o perfiles. Esto prueba la
relación WABA/número, no su asignación a una clínica en ClinicaClick: ese control
corresponde al registro de alta y al conjunto de clínicas ya autorizado.

## Activación y rollback

Ejecutar desde las operaciones del broker con [estado durable y MFA](whatsapp-authorization-state.md),
que registran el intento antes del canje. El helper no aporta idempotencia por sí
solo ni debe exponerse en otra ruta. No registra números, suscribe WABAs ni envía.
La candidata queda separada de las credenciales operativas. Ante un resultado
incierto consultar el mismo intento; no reutilizar el código ni probar otra URI.

La revisión con el titular contrasta configuración/permisos Meta, dominios SDK,
página de inicio y credencial nueva. El estado de despliegue y DDL está en 19/99;
no lanzar migraciones como parte de este canje. Revertir detiene el alta y conserva
intentos, candidata, bloqueos y recibos. No restaurar OAuth general o tokens de BD.

## Evidencia y fuentes

46 tests de transporte, comprobación de pertenencia y composición pasan;
regresión completa del broker: 294 tests, incluidos 31 nuevos. Tras reforzar
aislamiento del buffer prestado y saneamiento de errores se repiten los 46
afectados, todos correctos. AWS/Meta ficticios, guard de red, sin BD clínica.
Hotfix intacto. Evidencia privada `whatsapp-oauth-transport-*.log`.

- [SDK oficial archivado de Facebook: OAuth2Client](https://raw.githubusercontent.com/facebookarchive/php-graph-sdk/5.x/src/Facebook/Authentication/OAuth2Client.php)
  fundamenta GET de canje y el valor vacío por defecto de redirect_uri. Es una
  referencia histórica, no prueba de la configuración Embedded Signup actual.
- [Colección oficial Meta: Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup)
  documenta diagnóstico del token y WABA compartido; sus ejemplos no acreditan
  todos los campos/granularidad exigidos por el inspector para SYSTEM_USER.
- [SDK oficial Meta: WhatsAppBusinessAccount](https://github.com/facebook/facebook-php-business-sdk/blob/main/src/FacebookAds/Object/WhatsAppBusinessAccount.php)
  define GET del edge phone_numbers con selección de campos.

La documentación web actual de implementación y el anuncio de Embedded Signup
v4 devolvieron 429 en esta revisión. Se detuvieron esos intentos; no se sustituye
su validación por ejemplos de terceros. Graph v24.0 es la versión de compatibilidad
del código existente, no una afirmación de que sea la última disponible.

La inspección del [SDK JavaScript servido por Meta](https://connect.facebook.net/es_ES/sdk.js)
el 15/09/2026 confirma que el transformador OAuth sustituye el redirect por su
propio canal. El [helper de signed request](https://raw.githubusercontent.com/facebookarchive/php-graph-sdk/5.x/src/Facebook/Helpers/FacebookSignedRequestFromInputHelper.php)
invoca el canje del código sin URI manual. Esta evidencia fundamenta la corrección
del transporte; el SDK archivado no acredita por sí solo aceptación de ESU actual.
La prueba de proveedor sigue siendo necesaria y no se amplían permisos para forzarla.
