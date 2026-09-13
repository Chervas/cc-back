# WhatsApp: motor de envío aislado y cliente staging

13/09/2026. Código y QA aislada; **cero credenciales reales migradas, cero envíos,
cero despliegues**. Cuarentena Meta y pausas conservadas. Este corte no acredita
[las condiciones de reapertura](whatsapp-reconnection-readiness.md).

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

## Plantillas y secretos

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

IDs/scopes del sobre son afirmaciones registradas, **no verificación de permisos
efectivos en Meta**. El token de consulta conserva permiso remoto de gestión,
aunque el adaptador solo exponga GET; no se presenta como permiso remoto de
solo lectura. Antes de migrar, verificar sujetos/asignaciones, WABA/números y
ausencia de acceso a activos o permisos publicitarios/páginas no aprobados.
No copiar un token global en distintos secretos para simular separación.

Secrets Manager: cuenta, región eu-west-3, prefijo prod y KMS fijados; Describe
sin eliminación programada, VersionId fijado y AWSCURRENT comprobados en Describe
y Get, con revalidación al terminar. Sin caché, renovación, fallback ni búsqueda
de otra versión. Cambio de pin rechaza el resultado. OAuth 190/102 bloquea la
conexión de forma durable. Buffers del callback se borran al terminar/invalidate;
los strings internos SDK/JSON dependen del recolector de JavaScript, sin promesa
de borrado de todas las copias en memoria.

HTTPS fijo a graph.facebook.com, Graph `v24.0`, TLS verificado, Bearer en cabecera
y HMAC `appsecret_proof`. Sin redirecciones, compresión, respuestas no JSON,
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
