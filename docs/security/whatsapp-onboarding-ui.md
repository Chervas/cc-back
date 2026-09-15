# Interfaz de autorización exclusiva de WhatsApp

> **Tipo:** procedimiento técnico de interfaz y QA.
> **Fuente de verdad:** ventana, intercambio, recuperación y validación de la UI; instalación en el manual central 19/99.
> **Última revisión:** 2026-09-15 (Europe/Madrid).

Las pruebas con proveedores ficticios se distinguen de las pruebas reales. Consultar
[19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones)
para distinguir código, DDL y despliegue. No acredita reconexión operativa.

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

Se admite autorizar principal o secundario de clínica/grupo. El rol viaja como
`channelRole` y queda vinculado al estado firmado; no cambia por sí mismo la
asignación de un activo existente. Alta sin asignación para Director de pacientes
sigue sin soporte y muestra indisponibilidad explícita; no se convierte en otro
ámbito. La modalidad viaja al SDK como selección de interfaz, **todavía no
forma parte del estado durable firmado ni acredita el modo operativo del número**.
La futura activación debe comprobar modo y asignación antes de usarlos.

## Listado durable en Ajustes

Al cargar Ajustes y cerrar el diálogo se consulta
`POST /api/whatsapp/onboarding/authorizations`, con el ámbito concreto del selector
o `scope:null` para todos los permitidos. Este listado no depende del marcador
sessionStorage del intento ni de la sesión que realizó OAuth. El contrato de
ámbitos, MFA y estados es el de [14.3](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/14.3-whatsapp-coexistencia.md#autorizaciones-guardadas-en-ajustes);
el [runbook del gateway](whatsapp-onboarding-gateway.md#consulta-de-autorizaciones-guardadas)
detalla las comprobaciones y los límites de lectura.

Las candidatas con `localPhone` se integran en las fichas existentes, con
«Autorizado · Envíos pausados», perfil y salud local fechada. Las colecciones de
presentación son distintas de los teléfonos operativos; sin metadatos inequívocos
se presenta el recibo sin fabricar un perfil. Se mantienen los controles previos
y se explica la indisponibilidad de acciones legacy mientras el canal siga pausado. No aumentan el contador
de canales conectados, no se usan como remitentes y no modifican `isActive`.
El plazo OAuth ya vencido no oculta un recibo `awaiting_activation`. Un estado
bloqueado se muestra sin selección de número y no se ofrece como operativo.

`incomplete:true`, un fallo HTTP o un contrato inválido muestran «Estado pendiente
de verificar»; nunca se convierten en «no vinculada». No abrir otro popup ni
repetir OAuth para resolver un fallo de listado. La respuesta no contiene el
bloque `authorization`, estados OAuth, códigos ni secretos.

QA visual: comprobar escritorio y móvil, fichas existentes, perfil, salud,
principal/secundario, añadir otro número, acciones pausadas, scope concreto/global, un recibo
pendiente, bloqueo, lista incompleta y fallo de transporte. Cambiar de ámbito
no debe mostrar el resultado tardío de otro. Cerrar el diálogo y recargar deben
recuperar el mismo recibo sin abrir Meta. La publicación se verifica por el índice
y assets servidos; actualizar la rama staging no publica esa interfaz.

## Ventana de Meta y fronteras de confianza

GET /window sirve una página estática desde gateway, bajo el mismo gate del
alta y sin datos de clínica, JWT, estado OAuth o credencial en HTML/URL. Rechaza
query strings. Usa no-store, no-referrer, nosniff y CSP con nonce; solo app/crm
pueden embeberla. No exige Bearer para descargar esa página pública vacía.
Los POST conservan autenticación y contrato estricto; el listado durable adicional
usa la sesión MFA actual según el runbook del gateway.

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

`redirectUri` identifica la página de inicio aprobada del SDK. No se pasa como
retorno manual a `FB.login`: el SDK de Meta construye su propio canal. El broker
canjea esos códigos con URI vacía; véase [transporte](whatsapp-oauth-transport.md).

El SDK solo se inicia tras ese intercambio y FB.login requiere pulsación del
usuario. Solicita respuesta code y rechaza respuestas que contengan un bearer.
El código solo se acepta en el callback SDK de esa ventana. Los eventos
WA_EMBEDDED_SIGNUP admiten orígenes Meta exactos, JSON acotado y IDs de texto;
IDs contradictorios cancelan el resultado. **No se ha acreditado la correlación
con el WindowProxy exacto de la ventana interna de Meta**: esos IDs son pistas
no confiables. La identidad, grants, WABA única y pertenencia del número se
comprueban de forma independiente en el broker antes de guardar una candidata.

SDK Graph v24.0 es la versión de compatibilidad del proyecto. Se solicita
`extras.sessionInfoVersion: '3'` explícitamente para recibir los datos de cierre
también con configuraciones anteriores de Embedded Signup. La
[documentación oficial de coexistencia](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
mantiene ese parámetro y el evento de finalización versión 3. La versión de
Graph no acredita la versión del flujo Embedded Signup. No se declara probada la configuración real ESU v4,
su redirect URI, el canje o coexistencia. La CSP real del proxy, sus posibles
cabeceras X-Frame-Options y la compatibilidad del SDK deben verificarse en el
canary aprobado. No abrir CSP, probar URI alternativas o ampliar scopes para
forzar el resultado. Referencia de integración del proveedor:
[colección oficial Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup?entity=folder-9cba98a6-088f-4d7a-914e-8c3024b708aa).

## Cierre, incertidumbre y renovación de sesión

El callback del SDK y el evento con los activos pueden llegar en cualquier
orden. La ventana indica cuál falta y, tras 25 segundos con respuesta parcial,
avisa de que Meta no devolvió todos los datos. No publica códigos parciales,
no repite el login y sigue aceptando la segunda parte hasta el plazo original.
Finalizar en Meta no acredita por sí solo que CRM haya guardado la candidata.

SessionStorage conserva únicamente la referencia del intento, modalidad y dos
indicadores de envío/cancelación, en una clave vinculada a usuario, sesión y
ámbito. Decodificar el JWT en el navegador sirve solo para asociar esa referencia;
la autorización sigue siendo del servidor. Un cambio de usuario/sesión no
recupera el marcador anterior. Al reabrir se consulta el mismo UUID, sin canjear
automáticamente un código ni generar un intento alternativo ante incertidumbre.

El indicador de código enviado se guarda antes del POST finish. Si falla su
respuesta, la interfaz borra su copia del código y consulta status una sola vez
con el mismo UUID y sesión. Si tampoco puede confirmar esa lectura, muestra
resultado pendiente y permite Consultar estado; nunca reenvía finish ni crea
otro intento automáticamente. Begin se puede recuperar explícitamente con el
mismo UUID. Un begin rechazado por otra autorización abierta conserva ese UUID,
explica que debe terminarse/cancelarse desde su pestaña original o caducar, y no
arrastra el texto de cancelación del intento anterior.

### Cierre de ventanas y cancelación automática

Cerrar el diálogo (botón, Escape, fondo o navegación) solicita cancelar el
intento que todavía no ha enviado su código. Si begin estaba en curso, conserva
el marcador de cancelación y la ejecuta al resolverse la emisión. Al retirar el
iframe se manda `cc.wa.dispose` vinculado a origen, ventana, nonce y UUID; su
`pagehide` también cierra la ventana Meta capturada. La captura de `window.open`
se limita al iframe aislado y conserva argumentos/retorno del SDK; nunca afecta
al `window.open` de CRM ni lee contenido, cookies o URL de la ventana abierta.
Cerrar la ventana capturada es best effort: el navegador puede separar su
referencia por políticas de aislamiento.

`Window.closed` y un callback SDK sin código no prueban un cierre físico:
COOP puede separar el WindowProxy y ambos indicadores aparecen aunque Meta siga
abierto. No se cancela por esas señales. El callback vacío muestra un aviso para
terminar en Meta o pulsar Cancelar si ya se cerró; conserva el intento y admite
un resultado completo posterior una sola vez. El evento `CANCEL` explícito de
Meta, el botón Cancelar y el cierre de CRM sí solicitan cancelación. No prometer
detección automática de cualquier cierre de la ventana externa.
Referencia del navegador: [Window.open y COOP](https://developer.mozilla.org/en-US/docs/Web/API/Window/open#return_value).
Errores terminales y caducidad también solicitan cancelación antes de permitir
otro intento. Tras confirmarla, la UI conserva una explicación local fija del
error; si cancelar falla, conserva el error de recuperación de ese intento.

El plazo visual se limita a diez minutos y usa un deadline local en el iframe:
un reloj de navegador ligeramente atrasado no rechaza una emisión válida por
superar aparentemente los 600000 ms. El `expiresAt` recibido se conserva intacto;
la expiración firmada y comprobada en servidor sigue siendo autoritativa.

Una vez enviado finish, cerrar el diálogo conserva el resultado para consulta:
no aborta automáticamente `processing` ni `awaiting_activation`. El botón
explícito Cancelar autorización sigue siendo una acción distinta. La cancelación
mantiene el mismo UUID y solo se confirma si el DTO acredita MySQL y broker.
En navegación se intenta un POST autenticado `keepalive`; no es garantía frente
a falta de red o terminación forzada del navegador. El marcador pendiente se
reconcilia al volver; el plazo de servidor sigue siendo el límite de respaldo.
No se revocan permisos de Meta ni se activan envíos al cerrar una ventana.

El estado MySQL admite un JWT renovado de la misma sesión verificada con
expiración igual o posterior a la original. No cambia la expiración almacenada,
HMAC, plazo original ni el límite de diez minutos. Se rechazan JWT anteriores,
otra sesión y expiraciones fuera de los límites de la sesión durable. Sigue
exigiendo prueba de correo y revalidando permisos/bloqueos.

awaiting_activation se presenta como autorización guardada pendiente de
activación; nunca como canal conectado. No se llama a registro, suscripción,
envío o rutas legacy de fallback.

En coexistencia se acepta la finalización oficial con WABA sin número: el broker
debe resolver un único miembro. La UI muestra la observación de coexistencia
devuelta por ese recorrido, manteniendo el estado pendiente. Campo desconocido,
número discordante o indicador de activación incoherente invalidan el DTO.

## Validación, instalación y rollback

QA: contratos Node, MySQL propio, build Angular y
`scripts/tests/whatsapp_onboarding_chromium_qa.js` en frontend. El runner admite
`WHATSAPP_QA_OUTPUT` para evidencia privada por corte. Meta/AWS/SDK son ficticios;
incluye WABA sin número y candidata pendiente en escritorio/móvil.

Pruebas de contrato/interfaz, frame y rutas con datos ficticios; MySQL propio
para renovación y límites de sesión. Chromium usa el componente Angular,
interceptor de autenticación y frame/CSP reales con orígenes HTTPS virtuales:
todas las solicitudes se responden con fixtures o se bloquean. El SDK, los
proveedores y HTTP de negocio son ficticios. No es validación real de Meta.
Evidencia privada: whatsapp-ui-*.log, whatsapp-onboarding-ui/result.json y
capturas desktop/móvil; build privado whatsapp-onboarding-front-build.
El primer build agotó el heap por defecto de Node; pasó al repetir con los
6144 MiB documentados y dos workers. No se cambió ningún runtime operativo.

No aplicar migraciones desde QA de interfaz. La presencia y compatibilidad de
MFA/sesiones/bloqueos/auditoría y 20260913150000 se verifica en el precheck del corte.
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
