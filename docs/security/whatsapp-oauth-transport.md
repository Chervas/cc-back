# Transporte privado de canje y prueba de pertenencia WhatsApp

13/09/2026. Implementación interna del broker, probada con proveedor ficticio.
No está registrada como operación pública ni conectada a gateway, rutas OAuth,
Secrets Manager o consumidores. No permite todavía completar un alta real.

## Canje con configuración fijada

`createWhatsappOAuthHttp({appId,redirectUri,...})` fija al construir el transporte
una aplicación y URI HTTPS sin usuario, puerto, query o fragmento. La configuración
procederá del lote aprobado, nunca del cuerpo del callback. Se ejecuta un único
GET a `graph.facebook.com/v24.0/oauth/access_token`, sin redirección, reintento,
variantes de URI o credenciales alternativas. TLS verificado, mínimo TLS 1.2,
JSON sin compresión, máximo 32 KiB y 8 s de plazo de red por defecto.

El protocolo de canje lleva código y app secret en la query HTTPS directa a
Meta. No registrar URL, parámetros, errores crudos, cabeceras ni trazas APM de
esa salida. Tampoco devolver esa URL al navegador/API. El transporte no añade
instrumentación de logs. Al integrarlo, la clave debe leerse desde Secrets Manager
dentro del broker, sin usar el `.env` de la API general; esa unión sigue pendiente.

`withExchangedToken({code,appSecret,signal?}, callback)` toma buffers y los copia
antes del primer await. Solo el callback interno recibe el token canjeado y
la caducidad comunicada en `expires_in`, cuando existe. Caducidad ausente requiere
contraste con el inspector; no se traduce en duración ilimitada verificada.
La operación completa tiene plazo de 25 s y propaga cancelación al callback.

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

## Integración que sigue pendiente

Conectar el [estado durable con MFA](whatsapp-authorization-state.md) a una
operación autenticada del broker que registre el intento **antes** del canje,
fije aplicación/configuración/URI y WABA/número, preserve cancelación y bloquee
repetición tras respuesta perdida o reinicio. El helper de transporte no aporta
idempotencia durable por sí solo; no invocarlo desde rutas independientes.

La credencial candidata debe permanecer en Secrets Manager, con estado de
preparación, versión e identidad/ámbito verificados y conciliación tras fallo.
La identidad Meta nueva se verificará/registrará sin exigir MetaConnection general.
Una credencial de alta con varios permisos WhatsApp no se puede copiar en los
dos roles operativos de envío/gestión del motor y presentarlos como separados.
La compatibilidad de ese aprovisionamiento con Meta sigue por acreditar.

El cierre incluye sustituir el alta general en frontend/gateway, su correlación
documentada con Embedded Signup, la configuración real de productos/grants,
coexistencia/registro/suscripción cuando procedan y recepción durable en staging.
No registrar números, suscribir WABAs, crear plantillas o activar envíos como
efecto de este helper. La independencia frente a Ads/leads se comprobará en Meta.

Sin nueva DDL, UI, runtime o clave instalados. La DDL 20260913150000 sigue pendiente
para el estado en gateway; ninguna migración compartida ejecutada. Sin interrupción
actual. El futuro rollback debe conservar intentos/resultados y cerrar altas,
sin reactivar el canje general ni borrar evidencia de códigos consumidos.

## Evidencia y fuentes

46 tests de transporte, comprobación de pertenencia y composición pasan;
regresión completa del broker: 294 tests, incluidos 31 nuevos. Tras reforzar
aislamiento del buffer prestado y saneamiento de errores se repiten los 46
afectados, todos correctos. AWS/Meta ficticios, guard de red, sin BD clínica.
Hotfix intacto. Evidencia privada `whatsapp-oauth-transport-*.log`.

- [SDK oficial archivado de Facebook: OAuth2Client](https://raw.githubusercontent.com/facebookarchive/php-graph-sdk/5.x/src/Facebook/Authentication/OAuth2Client.php)
  fundamenta GET de canje con client_id/client_secret/code/redirect_uri. Es una
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
