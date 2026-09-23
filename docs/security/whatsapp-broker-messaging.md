# WhatsApp: motor de envío aislado y cliente staging

Contrato del transporte WhatsApp. El runtime de autorización descrito primero
conserva las pausas y exige revisión por número. Madurez y despliegues vigentes
en [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones)
y [99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md).
Los apartados del motor separado posterior conservan su alcance de preparación;
no acreditan por sí solos [las condiciones de reapertura](whatsapp-reconnection-readiness.md).

## Envío con autorización de Embedded Signup

El runtime `src/whatsapp-authorized-main.js` usa la cohorte
`whatsapp-authorized-v1`. Es una alternativa explícita al contrato separado
sender/template-reader descrito después: acepta la candidata de Embedded Signup
ya verificada, con su conjunto WhatsApp declarado y sus propietarios contrastados.
No copia el mismo token a dos roles ni presenta eso como separación de permisos.
La madurez instalada vive en el documento central 19.

La configuración privada fija `authorizationId`, digest y versión inmutable,
WABA/número, ámbito y caducidad local. `templates` queda como metadata legacy
opcional sin efecto de autorización para el runtime `whatsapp-authorized-v1`. El ledger de alta se
abre en solo lectura; otro SQLite conserva idempotencia y auditoría de operaciones.
Una autorización empieza con `enabled:false`; autorizar no concede permiso de envío.
No mover la candidata a `AWSCURRENT`: una versión posterior del slot no sustituye
silenciosamente la versión revisada.

La operación `meta.whatsapp.authorized.send.v1` recibe únicamente
`{authorizationId,phoneId,message}`. `message` admite las formas de Graph que usa
la aplicación: texto, plantilla y botón CTA URL. No compara huellas ni consulta
el estado de una plantilla antes de enviar. Conserva la validación cerrada del
payload, ámbito y operación; no permite un endpoint arbitrario.

Operaciones adicionales `meta.whatsapp.authorized.templates.{list,create,delete,header}.v1`:
WABA explícito contrastado con el binding y el mismo grant de clínica/número.
`list` pagina hasta 100 resultados y devuelve solo el catálogo y cursor, nunca
la URL de Graph. `create` acepta definición normal de Meta; `delete` exige
nombre e ID; `header` descarga imagen pública por HTTPS sin credenciales y la
sube a Graph. DNS fijado, destinos privados/redirecciones rechazados y máximo 5 MB.
Las escrituras conservan recibos e idempotencia. La preparación de imagen tiene
identidad propia; crear/retirar se deduplican por autorización y payload.

Cada uso valida la versión inmutable/digest del secreto, su vinculación local,
revocación y expiración, con prueba de clave de aplicación. No ejecuta un
`debug_token` ni consultas de propiedad por mensaje. Esas consultas se conservan
en la revisión administrativa (`verifyProvider:true`) y al incorporar una
credencial. El control `meta.whatsapp.authorized.phone.revoke.v1` mantiene la
baja por clínica incluso si el número se comparte.

Para desplegar: ampliar exclusivamente los grants existentes de `staging:whatsapp`
con las cuatro operaciones de plantillas; los grants de control siguen solo con
revocación. No crear conexiones ni ampliar clínicas en este cambio. Conservar
configuración y release anteriores para rollback; no borrar SQLite, recibos ni
bloqueos. La migración SQL aditiva se aplica antes de reiniciar la API. Restaurar
la release y grants anteriores revierte código, conservando evidencia y DDL.

El adaptador de staging conserva los constructores de mensajes, opt-out, salud
del canal y elección primary/secondary. Su archivo
`/etc/clinicaclick-whatsapp-authorized/staging/config.json` contiene referencias,
clave de firma y CA locales; nunca tokens Meta ni secretos AWS. Cada binding
incluye `connectionRef,authorizationId,clinicId,assetId,phoneId,wabaId,revision,sendEnabled`.
`sendEnabled:false` bloquea antes de HTTP y prevalece sobre cualquier credencial
legacy residual. Un activo inactivo solo participa si coincide exactamente con
ese binding; no se reactivan los flags de la BD.

El archivo exige `messageNotBefore` en UTC. El worker y el productor comprueban
antes de cambiar estado que el mensaje sea saliente, pendiente/en envío y creado
desde ese corte. Se rechazan marcadores de cuarentena, cancelación, aceptación o
resultado incierto; el adaptador vuelve a leer Message/conversación y comprueba
su clínica antes de HTTP. No hay excepción implícita para recuperar históricos.

La revisión administrativa se ejecuta con `src/whatsapp-authorized-review.js`
pasando la configuración AWS y connectionRef. Solo admite GET de verificación,
teléfono, suscripciones y plantillas. Permite revisar una autorización pausada,
conservando todos sus controles de versión, ámbito, bloqueo y caducidad. Devuelve
metadatos y digests, sin tokens ni contenido. No usar esa vista de revisión para
ejecutar envíos. Una suscripción del WABA no acredita por sí sola entrega o
recepción completa; verificar también la importación de mensajes en CRM.

El UUID de operación deriva de `Message.id` y se conserva al reintentar o
reiniciar. El worker resuelve de nuevo el remitente desde la conversación y el
snapshot guardado, sin usar credenciales de jobs antiguos. La respuesta conserva
`messages[].id` y `message_status`, incluido `held_for_quality_assessment`.
Un error que podría haberse producido después del POST queda como entrega
incierta; no se interpreta como permiso para reenviar con otra identidad.

Para preparar un corte, mantener ambos permisos de envío apagados, fijar el
catálogo revisado, verificar recepción y elaborar el lote de mensajes autorizado
por el titular según [reconexión](whatsapp-reconnection-readiness.md). El runtime
arrancado o un test offline correcto no acreditan entrega real ni permiten
reanudar automáticamente las colas históricas.

## Recepción atascada y recuperación de confirmaciones

El inbox cifra cada evento antes de acusar su recepción a Meta. Esto no prueba
su importación en CRM. El consumidor confirma únicamente después del commit SQL.
Un evento no resoluble conserva su cuerpo y recibo; `/defer`, exclusivo del
principal consumidor mTLS, registra una razón acotada y espera exponencial de
1 a 60 minutos. La selección gira por último intento, de modo que un evento
antiguo tampoco acapara el turno si el consumidor cae antes de diferirlo.
La tabla aditiva `whatsapp_inbox_retry` no altera ciphertext, AAD ni recibos.

`GET /pending` incorpora salud por ámbito, sin texto ni contactos. El consumidor
publica atómicamente `/run/clinicaclick-whatsapp-inbox-health/health.json` en su
`RuntimeDirectory`: solo él escribe; la API lee. Una muestra ausente o mayor de
90 segundos, una entrada ordinaria con más de 120 segundos de demora o una revisión
de contenido/ámbito impiden inferir que el paciente no respondió. Los eventos
administrativos conocidos (`played`, `edit`, `revoke`) y estados sin mensaje local
se conservan para revisión sin bloquear todos los recordatorios. Un lote mixto
que también contiene una respuesta real sí bloquea hasta resolverse.

Los timeouts de citas con WhatsApp autorizado vuelven a una espera durable de
un minuto mientras falla la recepción; no mandan el segundo mensaje ni cancelan
la cita por silencio. Al recuperarse comprueban la cita actual. Desde el 23/09
se retira la cancelación adicional `reply_already_received`: la entrega de una
respuesta al nodo corresponde al mecanismo nativo, sin cancelar la ejecución
por encontrar una fila inbound antes de su despacho. No se reabren ejecuciones
ni se reproducen respuestas históricas. Las peticiones de recuperación solo se permiten
para una cita de hoy aún futura, sin petición ya materializada hoy para esa misma
cita/hora. Una clave única compartida entre ejecuciones evita dos recuperaciones
concurrentes. Se descartan los timeouts obsoletos y las cancelaciones nocturnas
atrasadas, sin cancelar la cita. El flujo futuro conserva sus plazos configurados.
Los mensajes de texto generados por timeout también vuelven a comprobar vigencia
de la cita y salud inmediatamente antes del envío.

El dispatcher admite texto/botón/interactivo, adjuntos recuperables y reacciones
frescas. Para una reacción exige dirección entrante, `message_type` y
`provider_type` de reacción, emoji no vacío y WAMID objetivo válido. Conserva
todos los demás límites: binding exacto, recibo durable, corte por número, máximo
24 horas, `historical=false` y ausencia de marcas de recuperación. Una reacción
eliminada, un histórico o un eco saliente nunca reanuda una espera.

Recuperación operativa: publicar primero la barrera de timeouts y el filtro del
dispatcher. Arrancar después el importador con `WHATSAPP_INBOX_RECOVERY_HOLD=true`
y un corte UTC `WHATSAPP_INBOX_RECOVERY_NOT_BEFORE`. Los mensajes recuperados
guardan `recovery_without_automation:true`; el dispatcher los excluye tanto en
SQL como al validar cada fila. Los estados de entrega y las conversaciones sí
se actualizan. El corte también se aplica al despachar filas ya existentes;
una recepción retenida más de dos minutos se importa de forma pasiva incluso
en una parada posterior. Cualquier recibo ordinario pendiente aplaza el timeout,
aunque aún no alcance el umbral de incidencia. Antes de retirar el hold comprobar backlog, conflictos y citas;
fijar el corte al instante de reapertura y conservarlo en reinicios. No vaciar
colas de envío ni crear mensajes nuevos a partir de un check pendiente.

Un placeholder `unsupported` puede recibir después contenido real con el mismo
WAMID. Se completa exclusivamente la fila pasiva del mismo teléfono, clínica,
contacto y dirección; nunca se sobrescribe contenido real contradictorio ni se
duplica el mensaje. La recuperación queda excluida de automatizaciones y conserva
las claves de idempotencia y recibos originales.

Pruebas: `whatsapp-inbox.test.js` y `whatsapp-inbox-runtime.test.js` (SQLite/mTLS
aislados), `whatsapp_inbox_{import,scopes}_mysql.test.js` (MySQL temporal sin red),
`whatsapp_timeout_{recovery,engine}.test.js`, `whatsapp_fresh_inbound.test.js` y
`whatsapp_appointment_eligibility.test.js` (sin proveedores). Al desplegar actualizar
por separado broker AWS, API, dispatcher y release del importador; un push a
staging no actualiza los procesos dedicados.

Tras el commit de cada hijo, `whatsappFreshPostImport.service` concilia los ecos
salientes del móvil y los estados de entrega. El eco cuenta como intervención
humana y puede cerrar la atención pendiente, pero no entra como mensaje del
paciente ni llama a IA. Los estados avanzan entrega, colas y salud de forma
idempotente. Solo después se publica el refresco de vista con IDs, sin contenido.

Meta `131042` se materializa como bloqueo crítico del activo emisor con motivo
`meta_error_131042_payment_missing`; puede estar conectado y a la vez no poder
enviar. Las notificaciones se crean por ámbito vinculante e indican rol,
propósitos y acción configurada. La remediación abre únicamente una URL HTTPS
validada de `business.facebook.com`, obtenida del error de Meta o construida para
el WABA y negocio. No conduce a Ajustes internos ni crea incidentes o apelaciones
de cumplimiento. No hay fallback ni reintento implícito.

`last_detected_at` usa el timestamp del estado de Meta o, si falta, la fecha del
mensaje fallido. La hora de una conciliación posterior no sustituye la hora del
fallo, y un fallo histórico no pisa otro posterior. Un `sent`, `delivered` o
`read` de un mensaje local posterior en el mismo activo limpia la incidencia y
recupera su salud; un estado atrasado anterior, `CONNECTED`, una reconexión local
o un diagnóstico realizado con otra credencial no bastan. No se debe probar el
pago saltándose el broker o el cortacircuitos.

## Contrato y autoridad

Runtime `services/integrations-broker/src/whatsapp-main.js`, Node 24, cohorte
`whatsapp-messaging-v1`. No carga `.env`, modelos ni BD clínica. Reutiliza HTTPS,
firma Ed25519, audiencia, nonce, ventana temporal, límites e idempotencia del
protocolo privado `POST /v1/execute`. No añade rutas públicas ni abre cuarentena.

| Operación privada | Payload exacto | Resultado |
| --- | --- | --- |
| `meta.whatsapp.text.send.v1` | `to`, `body`, `previewUrl` | `{messageId}` |
| `meta.whatsapp.template.send.v1` | `to`, `templateKey`, `parameters` | `{messageId}` |
| `meta.whatsapp.phone.revoke.v1` | `{}` | `{revoked:true}` |

Destinatario de 7–15 dígitos sin `+`, texto de 1–4096 caracteres y booleano
previewUrl explícito. Plantilla: hasta 20 parámetros textuales de 1–1024
caracteres, cantidad exacta registrada. El caller no elige host, versión Graph,
credencial, WABA, emisor ni nombre/idioma de plantilla o JSON libre para Meta.
La respuesta descarta contactos y campos adicionales. Un `wamid` acredita
aceptación del proveedor, **no entrega al destinatario**.

Solo `staging:whatsapp` envía; `control:whatsapp` solo revoca. Claves Ed25519
distintas, máximo 60 peticiones/minuto por principal y grants concordantes por
clínica/conexión/`wa-phone:<phoneId>`. DEV/gateway no tienen principal operativo.
La revocación es local al grant: no revoca el token en Meta ni desconecta otras
clínicas que usen el número. La baja funcional debe conservar su comprobación
transaccional de usos compartidos y activos primarios.

## Plantillas y secretos del motor separado de preparación (no runtime vigente)

Cada conexión fija App ID, sujetos de envío/consulta distintos, WABA, emisor,
caducidad local y versiones concretas de tres secretos distintos: envío,
consulta de plantilla y app. Hasta 64 conexiones, un número por conexión y
100 plantillas registradas por conexión. Cada plantilla fija clave local, ID
Meta, nombre, idioma, digest SHA-256 del contenido y cantidad de parámetros BODY.
Descubrirla por sync o estar aprobada en Meta no equivale a aprobación local.

Antes de enviar se lee por ID y se comprueban estado APPROVED, identidad,
idioma, digest y posiciones `{{1}}…{{n}}`. El digest incluye componentes/texto/
formato en orden, con claves canónicas; omite ejemplos. Solo admite BODY
textual y HEADER/FOOTER textuales estáticos. Botones, cabeceras dinámicas,
medios, flujos y parámetros nombrados quedan fuera. No crea/edita/borra plantillas.

**No hay precondición atómica de versión remota:** Meta recibe nombre/idioma al
enviar, no nuestro digest. Puede existir un cambio entre lectura y POST. Se
deben retirar accesos comprometidos y limitar gestión remota; este control no
sustituye esas medidas.

Sobres JSON v1 exactos de los secretos:

- Envío/consulta: `version`, `provider`, `connectionRef`, `appId`, `subjectId`,
  `wabaId`, `phoneId`, `accessToken`, `expiresAt`, `scopes`. Providers respectivos
  `meta_whatsapp` y `meta_whatsapp_template_reader`; scope exclusivo respectivo
  `whatsapp_business_messaging` o `whatsapp_business_management`.
- App: `version`, `provider: "meta-app"`, `appId`, `appSecret` de 32 hex.
- Caducidades en epoch **milisegundos**. El token puede tener `expiresAt:null`;
  la autorización local de la conexión siempre exige vencimiento.

Los IDs/scopes del sobre son afirmaciones registradas. Ahora se contrastan con
`debug_token` dentro del broker antes de cada uso de la credencial; esa lógica
está probada con ficticios, **no verificada todavía en Meta real**. El token de consulta conserva permiso remoto de gestión,
aunque el adaptador solo exponga GET; no se presenta como permiso remoto de
solo lectura. Antes de migrar, verificar sujetos/asignaciones, WABA/números y
ausencia de acceso a activos o permisos publicitarios/páginas no aprobados.
No copiar un token global en distintos secretos para simular separación.

### Inspección de permisos e identidad del proveedor

`whatsapp-credential-inspector.js` comprueba App ID, sujeto exacto, tipo USER o
SYSTEM_USER, validez, expiración del token y del acceso a datos, scopes exactos y
granularidad. Cada permiso WhatsApp esperado debe declarar **solo el WABA fijado**;
faltan datos, otro WABA, varios targets, permisos adicionales o identidad distinta
impiden llegar al POST. El motor operativo exige exclusivamente messaging o
management según el rol del secreto, sin mezclar ambos. El verificador puede
reutilizarse en el alta con una whitelist WhatsApp explícita y public_profile;
eso no cambia los requisitos del motor operativo ni implementa Embedded Signup.

No se acepta un JSON diagnóstico enviado por el navegador ni se deduce validez
del sobre almacenado. La inspección se ejecuta al cargar cada secreto; repetir
un recibo completado no carga tokens. Si la respuesta indica invalidación, el
bloqueo de conexión se persiste y no se vuelve a sondear con nuevas peticiones.
Si falla la inspección, no se usa una validación antigua como fallback.

Meta documenta `GET /debug_token?input_token=...`: esa query sensible solo viaja
por TLS directamente a Meta; app access token en Authorization. No es una URL
del navegador ni una respuesta de API. El transporte nativo no la registra,
y elimina errores crudos, headers y cuerpos del proveedor. Prohibido activar
trazas/APM/proxies que registren esa URL o sus cabeceras completas. Las buffers
del candidato/app se borran al terminar, con el límite de strings/GC ya indicado.

Referencia primaria: [Debug Token en Embedded Signup de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup?entity=request-13382743-32e8d1af-a608-4bf1-bf4b-c8fc5e6551a4).
El ejemplo documenta granularidad management; **no demuestra que todos los tipos
de token devuelvan todos los campos exigidos por este motor**. Esa compatibilidad,
especialmente messaging/SYSTEM_USER, debe verificarse antes del canary. Ausencia
de evidencia implica rechazo; no declarar una configuración real compatible con
fixtures inventados. Si Meta no aporta ese dato, habrá que implementar otra
comprobación documentada de asignaciones; no eliminar el control para reabrir.

La introspección no impide por sí sola usar externamente una credencial robada ni
es atómica con cambios de permisos posteriores. Sigue siendo necesaria la
separación real de grants/tokens/apps y la retirada de accesos comprometidos.

Secrets Manager: cuenta, región eu-west-3, prefijo prod y KMS fijados; Describe
sin eliminación programada, VersionId fijado y AWSCURRENT comprobados en Describe
y Get, con revalidación al terminar. Sin caché, renovación, fallback ni búsqueda
de otra versión. Cambio de pin rechaza el resultado. OAuth 190/102 bloquea la
conexión de forma durable. Buffers del callback se borran al terminar/invalidate;
los strings internos SDK/JSON dependen del recolector de JavaScript, sin promesa
de borrado de todas las copias en memoria.

HTTPS fijo a graph.facebook.com, Graph `v24.0`, TLS verificado. Envío/consulta de
plantilla: Bearer en cabecera y HMAC `appsecret_proof`; inspección con el protocolo
anterior. Sin redirecciones, compresión, respuestas no JSON,
respuestas de más de 128 KiB ni reintentos HTTP. Calcular la prueba no acredita
que Meta la exija frente a un token robado: verificar configuración de la app.
La versión conserva compatibilidad del código existente; no se afirma que sea
la última ni que se haya validado contra la cohorte real.

## Cliente y envío durable

`src/lib/whatsappBrokerClient.js` recibe `{messageId, clinicId, assetId,
operation, payload}` y un loader de binding inyectado que devuelve exactamente
`{connectionRef, phoneId, clinicId, assetId, revision, active}`. Requiere scope
exacto y revisa de nuevo binding/entorno al recibir respuesta. **Todavía no se
conecta a un registro independiente, `whatsapp.service.js` o workers reales.**

Antes de consulta/red exige `RUNTIME_ROLE=api`, `JOB_RUNTIME_NAMESPACE=staging`,
`QUEUE_PREFIX=staging` y `JOBS_WORKER_ENABLED=true`. Evita errores de configuración;
no aísla procesos con el mismo UID o acceso a claves. Faltan barreras reales
del sistema, IAM, SQL y Redis; gateway debe limitarse a recepción.

El ID persistente de Message deriva un requestId estable. Nonce nuevo para cada
firma, pero misma intención tras reintento/reinicio. SQLite privado reserva
`(principal, requestId)` y digest antes del proveedor:

- Mismo ID/contenido completado: recibo previo, sin otro POST.
- Mismo ID con intención distinta: conflicto, sin envío.
- Empezado/respuesta perdida: `outcome_unknown`, sin reenvío automático.
- Bloqueos/permisos preceden incluso a recuperar el recibo; reiniciar no los borra.

Tras los awaits de plantilla se revalida el bloqueo durable inmediatamente
antes del POST y antes de confirmar recibo. No se puede deshacer un envío ya
aceptado por Meta. Perder/restaurar un estado anterior de SQLite, cambiar el ID
Message o usar brokers con estados independientes anula esa protección. El
corte requiere un dueño del estado, respaldo y conciliación; no es un cluster
ni una garantía global de envío exactamente una vez.

Respuesta perdida o cambio tras llamar: `whatsapp_delivery_unknown`,
`delivery_unknown:true`, `retryable:false`. También trata conservadoramente
como desconocidos los rechazos recibidos después de iniciar transporte. El
clasificador compartido prioriza esa marca sobre 429/5xx y códigos de red. No
crear otro Message para repetir. Pendiente conciliar estados de webhook o
intervención controlada; no inventar confirmación de entrega.

## Auditoría, configuración y coste

Auditoría técnica v2: actor servicio, operación y referencias. SQLite conserva
digest/estado/recibo opaco; no texto, destinatario ni tokens en comandos/auditoría.
No sustituye la auditoría humana futura; hashes/referencias siguen protegidos,
no son datos anónimos. Backlog lleno impide llamadas nuevas. Sink externo probado
con ficticios; retención, inmutabilidad y permisos reales siguen pendientes.

JSON privado de runtime exacto: `enabled`, `cohort`, `listenAddress`, `port`,
`stateFile`, `tlsCertFile`, `tlsKeyFile`, `policy`. Archivos privados, estado fuera
del árbol público, claves de control fuera de API/DEV. Bootstrap AWS reutiliza
identidad EC2/IMDSv2 y writer separado fijados al inventario. No se instala
configuración ni se ejecuta AWS real. IAM requiere revisión/reducción al lote;
validar JSON no acredita permisos remotos.

Sin caché: texto = 2 GetSecretValue + 4 DescribeSecret; plantilla = 4 GetSecretValue
y 8 DescribeSecret, además de consulta/envío Meta. Máximo 8 peticiones en vuelo,
plazo total 25 s y transporte Meta 8 s por llamada. Capacidad pendiente de ensayo.
La inspección añade una llamada Graph por secreto usado: texto tiene una
inspección + envío; plantilla dos inspecciones + consulta de plantilla + envío.
Comparten el plazo total de 25 s. Cuotas del endpoint diagnóstico y carga real
deben medirse antes de activar; no confundir límites de mensajería con su cuota.
No hay medición ni estimación monetaria real nueva. Costes Ajustes, CE/etiquetas,
Budget frente a CloudFormation y retención conservan los pendientes del runbook.

## QA, dependencias y siguiente corte

El propietario confirma que WhatsApp requiere conectar antes Meta. Revisado:
`_tryStartWhatsappConnectFromQuery` llama `_connectMeta('whatsapp')` cuando falta
la cuenta; esta llamada usa `/oauth/meta/connect`, cuyo scope también incluye
páginas, publicidad y leads. El callback Embedded Signup exige una MetaConnection
previa, canjea en API y contempla `waAccessToken` en assets y tokens alternativos
de entorno para suscripción. Es código legacy actualmente cerrado por middleware,
no evidencia de que queden tokens reales almacenados ni prueba del vector.

El cierre incluye **login con código de correo → autorización Meta específica
para WhatsApp → verificación WABA/número/ámbito → activación en broker**. Se
sustituirá la dependencia de la conexión general; páginas/Ads quedan separados.
La separación exigida comprende los grants y credenciales emitidos por Meta,
no solo los botones de ClinicaClick. Verificar configuraciones de acceso y si
conviene una app dedicada; compartir App ID o pedir menos scopes no demuestra
por sí solo independencia de permisos ya concedidos. No hay cambios remotos.
Estado/código de un uso ligados a usuario/sesión/ámbito y expiración, retorno
fijado y canje en broker, sin acceso del frontend/API/BD compartida a tokens.
Los IDs del postMessage del navegador no autorizan por sí solos una asignación.

El motor de envío de este corte **no implementa esa alta**. Hay que verificar
qué permisos/configuración exige Embedded Signup para cada modalidad, incluida
coexistencia, y cómo producir credenciales operativas con la separación que
exige el motor. No se asume que el token del alta ya cumpla los scopes mínimos,
ni se copian dos sobres del mismo token para aparentar separación. Cualquier
permiso de gestión necesario al alta tendrá autoridad y propósito separados de
los envíos; sin fallbacks o activación automática de trabajos/plantillas. Este
recorrido y la UI correspondiente se probarán antes del canary real.

232 pruebas broker correctas, incluidas 49 WhatsApp; 59 backend, incluidas 10
del cliente. HTTPS real solo en loopback propio, SQLite privados, AWS/Meta
ficticios, guard de red y prohibición de modelos clínicos reales. Cobertura:
pins/secretos/permisos, plantilla alterada, bloqueo externo durante consulta,
duplicado concurrente, reinicio, respuesta perdida/timeout, auditoría/backlog,
DEV/gateway y regresión de contención/MFA. Evidencia privada
`whatsapp-broker-*.log`, `/home/ubuntu/qa-evidence/security-migration-20260912`.

Regresión posterior de inspección: **263 pruebas broker correctas, 80 WhatsApp**,
incluidas 31 nuevas de identidad/scopes/targets/expiración/transporte y rechazo
previo a envío. TLS local usa el inspector real con HTTP Meta ficticio. Evidencia
`whatsapp-inspector-tests.log` y `whatsapp-inspector-regression.log` en el mismo
directorio privado. No se vuelve a contar la ejecución backend anterior como
prueba nueva de este cambio; no hay modificaciones de consumidores, DDL o UI.

Sin nueva DDL clínica ni UI. Pendientes: alta Meta/Embedded Signup segura,
registro de bindings/aprobaciones,
conexión a productores/worker de salida, recepción durable gateway → cola →
staging con revalidación/deduplicación, medios/eventos y ensayo de fallos. Después
se presentará lote de identidades/permisos, versiones, DDL, backlog, ventana,
correo MFA, canary autorizado y rollback. OPS puede continuar apagado.

Rollback: mantener cuarentena y conservar SQLite/recibos/bloqueos/auditoría.
No volver a tokens en BD/API, restaurar credenciales revocadas, arrancar workers
DEV ni reproducir intenciones inciertas. Este código no autoriza reconexión.

Contratos primarios Meta consultados: [texto](https://www.postman.com/meta/whatsapp-business-platform/request/0arw2jw/send-text-message-with-preview-url),
[plantilla textual](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text)
y [consulta por ID](https://www.postman.com/meta/whatsapp-business-platform/request/llkzy9g/get-template-by-id-default-fields).
No constituyen evidencia de llamadas con credenciales reales.
