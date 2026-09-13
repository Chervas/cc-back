# Interfaz de autorización exclusiva de WhatsApp

13/09/2026. Corte de código local con proveedores ficticios. Sin despliegue,
configuración Meta instalada, migración compartida ni activación de envíos.
**No acredita una reconexión operativa segura.**

## Recorrido

Ajustes conserva la selección de clínica/grupo y modalidad Cloud API/coexistencia,
pero abre el diálogo específico sin exigir MetaConnection general. El retorno
connect_whatsapp tampoco espera su estado ni inicia OAuth publicitario. Se elimina
el diálogo que aseguraba permisos configurados y proponía un túnel DEV, además
del callback que guardaba tokens en la API general y registraba automáticamente
el número después de Embedded Signup.

El nuevo diálogo solo funciona en los orígenes HTTPS exactos app/crm y usa
https://autenticacion.clinicaclick.com/api/whatsapp/onboarding. El servidor
[exige sesión gestionada con correo y ámbito completo](whatsapp-onboarding-gateway.md).
El navegador no elige otro gateway, proveedor, runtime, App ID, configuración o
redirect URI. Estos tres últimos datos llegan del binding verificado del broker.
La selección del modo no amplía permisos.

Solo se admite el canal principal de clínica/grupo. Alta sin asignación para
Director de pacientes y canales secundarios muestran indisponibilidad explícita;
no se convierten silenciosamente en otro ámbito. Siguen pendientes su contrato
y pruebas. La modalidad viaja al SDK como selección de interfaz, **todavía no
forma parte del estado durable firmado ni acredita el modo operativo del número**.
La futura activación debe comprobar y fijar modo/rol antes de usarlos.

## Ventana de Meta y fronteras de confianza

GET /window sirve una página estática desde gateway, bajo el mismo gate del
alta y sin datos de clínica, JWT, estado OAuth o credencial en HTML/URL. Rechaza
query strings. Usa no-store, no-referrer, nosniff y CSP con nonce; solo app/crm
pueden embeberla. No exige Bearer para descargar esa página pública vacía.
Los cuatro POST conservan la autenticación y el contrato estricto anteriores.

Cada intento abre un iframe nuevo con sandbox que permite scripts, mismo origen
del gateway, formularios y ventanas de Meta; no permite navegación de la página
principal. El SDK se carga allí, separado del SDK general de la aplicación y
del almacenamiento del origen app/crm. Esto no es aislamiento del sistema
operativo ni protección frente a una aplicación o un gateway comprometidos.

El padre inicia cc.wa.hello tras load. La página comprueba el WindowProxy del
padre y su origen; responde al origen exacto con nonce aleatorio de 32 bytes.
El padre comprueba origen gateway, WindowProxy exacto del iframe y nonce, y
envía una única configuración con UUID/plazo. Resultado/cancelación/error deben
conservar nonce/UUID y campos exactos. No se usan destinos * ni almacenamiento
de códigos, estados OAuth, JWT adicionales o tokens de proveedor.

El SDK solo se inicia tras ese intercambio y FB.login requiere pulsación del
usuario. Solicita respuesta code y rechaza respuestas que contengan un bearer.
El código solo se acepta en el callback SDK de esa ventana. Los eventos
WA_EMBEDDED_SIGNUP admiten orígenes Meta exactos, JSON acotado y IDs de texto;
IDs contradictorios cancelan el resultado. **No se ha acreditado la correlación
con el WindowProxy exacto de la ventana interna de Meta**: esos IDs son pistas
no confiables. La identidad, grants, WABA única y pertenencia del número se
comprueban de forma independiente en el broker antes de guardar una candidata.

SDK Graph v24.0 es la versión de compatibilidad del proyecto. Se elimina
sessionInfoVersion:3; no se declara probada la configuración real ESU v4,
su redirect URI, el canje o coexistencia. La CSP real del proxy, sus posibles
cabeceras X-Frame-Options y la compatibilidad del SDK deben verificarse en el
canary aprobado. No abrir CSP, probar URI alternativas o ampliar scopes para
forzar el resultado. Referencia de integración del proveedor:
[colección oficial Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup?entity=folder-9cba98a6-088f-4d7a-914e-8c3024b708aa).

## Cierre, incertidumbre y renovación de sesión

SessionStorage conserva únicamente la referencia del intento, modalidad y dos
indicadores de envío/cancelación, en una clave vinculada a usuario, sesión y
ámbito. Decodificar el JWT en el navegador sirve solo para asociar esa referencia;
la autorización sigue siendo del servidor. Un cambio de usuario/sesión no
recupera el marcador anterior. Al reabrir se consulta el mismo UUID, sin canjear
automáticamente un código ni generar un intento alternativo ante incertidumbre.

El indicador de código enviado se guarda antes del POST finish. Su respuesta
perdida requiere status. Begin se puede recuperar explícitamente con el mismo
UUID. Cerrar conserva el intento y elimina estado OAuth/listeners/iframe; no
equivale a cancelar. Cancelar conserva el mismo UUID y no afirma confirmación
hasta que el DTO acredite ambos registros. Solo la cancelación confirmada deja
preparar un nuevo UUID desde el diálogo. No se promete cancelación previa a la
emisión local, recuperación desde otra sesión o limpieza de candidatas huérfanas.

El estado MySQL admite un JWT renovado de la misma sesión verificada con
expiración igual o posterior a la original. No cambia la expiración almacenada,
HMAC, plazo original ni el límite de diez minutos. Se rechazan JWT anteriores,
otra sesión y expiraciones fuera de los límites de la sesión durable. Sigue
exigiendo prueba de correo y revalidando permisos/bloqueos.

awaiting_activation se presenta como autorización guardada pendiente de
activación; nunca como canal conectado. No se llama a registro, suscripción,
envío o rutas legacy de fallback.

## Validación, instalación y rollback

QA aislada correcta: 40 pruebas Node backend, 12 frontend, 16 grupos de
comprobaciones en MySQL propio con cierre 0, build Angular y Chromium desktop/
móvil con 18 capturas y cero llamadas externas. Meta/AWS/SDK son ficticios.

Pruebas de contrato/interfaz, frame y rutas con datos ficticios; MySQL propio
para renovación y límites de sesión. Chromium usa el componente Angular,
interceptor de autenticación y frame/CSP reales con orígenes HTTPS virtuales:
todas las solicitudes se responden con fixtures o se bloquean. El SDK, los
proveedores y HTTP de negocio son ficticios. No es validación real de Meta.
Evidencia privada: whatsapp-ui-*.log, whatsapp-onboarding-ui/result.json y
capturas desktop/móvil; build privado whatsapp-onboarding-front-build.
El primer build agotó el heap por defecto de Node; pasó al repetir con los
6144 MiB documentados y dos workers. No se cambió ningún runtime operativo.

No hay variables ni DDL nuevas en este corte. Persisten las migraciones de
MFA/sesiones/bloqueos/auditoría y 20260913150000 pendientes de corte compartido.
No hay gasto AWS/Meta por estas pruebas. Costes en Ajustes, Budget/CloudFormation,
retención y cifrado conservan sus pendientes; OPS puede seguir apagado.

Antes de instalar: configuración Meta exclusiva de WhatsApp con grants reales
separados de Ads/leads/páginas/Instagram, validación de código/SDK/URI, MFA efectiva,
aislamiento de identidades/claves/SQL/Redis, candidata/activación y consumidores
staging con recepción durable desde gateway sin duplicados. App separada o
configuración de una app existente debe evaluarse también por el riesgo del
secreto de aplicación compartido; dos botones no acreditan independencia.
DEV permanece fuera de la operación.

El lote aprobado detallará versiones, procesos, interrupción y rollback.
Revertir cierra las altas nuevas conservando estados, códigos consumidos,
cancelaciones, candidatas y bloqueos. No restaurar el OAuth general como requisito
de WhatsApp, tokens revocados ni envíos legacy. Publicación Git no es despliegue.
