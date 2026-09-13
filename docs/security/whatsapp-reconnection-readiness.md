# WhatsApp y acceso: condiciones de reconexión

13/09/2026. **Reconexión todavía no validada.** No se ha demostrado el vector del
incidente ni verificado estas protecciones en los procesos que sirven tráfico.
El código de contención mantiene WhatsApp cerrado a escrituras y Meta sin salida.

El usuario aclara que OPS solo consume datos de ClinicaClick para paneles. Puede
seguir apagado: no es dependencia de ClinicaClick. Se priorizan WhatsApp API y
login con códigos por correo; cuentas publicitarias después. No se espera a
terminar costes, paneles OPS ni todas las integraciones para este cierre.

## Destino público y valoración de la separación

Confirmación del usuario: staging es la API y ejecutor de negocio; gateway sirve
OAuth/webhooks y entradas externas sin workers de negocio; DEV queda fuera de
la reconexión, con pausas y pruebas aisladas. Esto no autoriza reactivar Meta.

La distribución es adecuada, pero aún no constituye una frontera de seguridad:

1. La observación de metadatos de procesos del 13/09/2026 a las 17:15:04 UTC
   (19:15:04 CEST) encuentra `pm2-back-dev`, `pm2-back-staging` y `pm2-gateway`
   bajo UID 1000. Una clave privada del mismo usuario no aísla staging de un
   proceso DEV comprometido. El lote debe separar identidades del sistema y
   accesos a claves/secretos; no basta cambiar variables o prefijos.
2. En el entorno de arranque observado: DEV tiene namespace/prefijo `dev` y
   scheduler/cron apagados; staging usa `staging` y ambos activos; gateway usa
   `gateway` y ambos apagados. Es un snapshot de arranque, no una prueba de toda
   la configuración cargada después desde archivos ni de workers efectivos.
3. El código de los tres checkouts crea `webhook_whatsapp` sin pasar por la
   exclusión de workers del gateway. Ese consumidor persiste conversaciones,
   trata medios y coordina automatizaciones. El flujo histórico documentado
   reside allí. Trasladarlo a staging exige un traspaso explícito de recepción;
   apagarlo sin ese traspaso dejaría los eventos en una cola sin consumidor.
4. Los prefijos Redis de gateway y staging son distintos. Se necesita una cola
   pública de entrada específica y un único propietario de consumo, conservando
   las restantes colas y pausas. Un prefijo evita cruces accidentales; no impide
   acceso malicioso si los usuarios Redis y del sistema conservan permiso global.
5. Compartir BD con permisos amplios de escritura permitiría a DEV alterar
   usuarios, correo de recuperación, sesiones, trabajos o bindings operativos.
   El lote debe acreditar grants SQL mínimos. Preferencia de seguridad: BD de
   desarrollo separada y datos de prueba. Si se mantiene la BD compartida,
   separar usuario/grants y cerrar escrituras operativas desde DEV es requisito;
   no se promete compatibilidad con desarrollo que necesite escribir esos datos.
6. Un POST a Meta con respuesta perdida puede haber sido aceptado. El broker y
   el worker deben conservar un ID durable de intención y el resultado desconocido,
   sin generar otro envío automáticamente. La firma antirreplay del transporte
   no sustituye esta deduplicación de negocio.

Se han observado HEADs distintos en staging (`ac1b1dd`) y gateway (`4cf8e23`);
no se infiere de ellos la versión efectiva cargada en memoria. Antes del corte
se conciliará un candidato compatible en ambos. No se ha cambiado ningún proceso.
La política de MFA del entorno real sigue sin acreditarse: ausencia de una
variable en `/proc` no demuestra su valor después de cargar la configuración.

### Lote que se concretará antes de pedir activación

La conexión previa de Meta forma parte obligatoria del lote. El código actual
redirige WhatsApp al OAuth general con permisos de páginas/publicidad/leads y
el callback Embedded Signup exige MetaConnection previa. Se sustituirá esa
dependencia por alta específica de WhatsApp: MFA por correo, estado/código de
un uso, ámbito e identidad verificados y canje en broker. Tokens fuera de API,
frontend y BD compartida; gestión/alta separadas del permiso operativo de envío.
Configuración Embedded Signup/coexistencia por verificar; alta todavía pendiente.

| Componente | Cambio y validación requeridos |
| --- | --- |
| Proveedor inicial | Solo WhatsApp, WABA/números y plantillas expresamente inventariados; Ads, páginas y otros permisos fuera. No usar tokens revocados. |
| `pm2-gateway` | Validación de firma/ámbito y persistencia de recepción; publicación durable en la cola pública. Sin consumo de negocio, sin emisión de mensajes ni acceso al token WABA. |
| `pm2-back-staging` | Único consumidor de recepción y ejecutor de envíos autorizados; conserva pausas/canales existentes, sesión/MFA y permisos. |
| Workers afectados | `webhook_whatsapp`, `outbound_whatsapp`, `whatsapp_template_create`, `whatsapp_template_sync`, `whatsapp_phone_sync`; además los JobRequests/automatizaciones que produzcan esos trabajos. La creación de plantillas permanece cerrada hasta su autorización específica. |
| Broker | Único poseedor del token WABA; identidad distinta para cada servicio, operaciones/activos/plantillas limitados, auditoría y resultado desconocido durable. DEV sin principal operativo ni acceso de lectura a secretos. |
| BD/Redis | DDL exacta y grants revisados; cola pública separada, propiedad del consumo y backlog anterior conciliados. No cambiar el prefijo global como atajo ni reclamar jobs DEV. |
| Interrupción | Ventana acotada para frenar productores/consumidores afectados, resolver trabajos en curso y cambiar el propietario de recepción. La duración se medirá con ensayo; aún no se promete una cifra ni entrega para esta noche. |
| Regreso/rollback | Pausar envíos ante duda; conservar recepción durable, bloqueos, historial y exigencia del correo. Revertir consumidores únicamente a una versión revisada, con un solo dueño de cola. No restaurar tokens antiguos, envíos inciertos ni el webhook sin firma. |

El lote no está listo para ejecutar: motor WABA y cliente tipado probados
aisladamente, pero faltan su conexión al registro y los consumidores,
las barreras de acceso del entorno y el ensayo completo gateway → cola → staging
→ broker, incluidos errores y reinicios. La atribución Meta puede continuar en
paralelo; no se presenta como requisito esperar indefinidamente una respuesta
forense para preparar estas protecciones.

## Hechos y estado

Avance posterior: [motor y cliente de envío](whatsapp-broker-messaging.md)
probados con secretos/proveedor ficticios, recibo durable y plantilla fijada.
232 tests broker + 59 backend; no conectados aún a consumidores ni registro real.
No confundir este motor con la migración terminada del recorrido WhatsApp.

| Control | Evidencia de código | Pendiente antes de reabrir |
| --- | --- | --- |
| Login por correo | Primera entrega backend `a393740`, front `622fa35a`; código de un uso, caducidad, límites y sesiones con prueba de correo. | DDL/configuración y `enforce` en todos los emisores/verificadores de ClinicaClick, rechazo de sesiones antiguas y entrega de correo real probados. Publicado no significa activo. |
| Recepción WhatsApp | Este corte cierra aceptación sin secreto, exige firma sobre bytes originales y elimina selección de clínica desde URL/campo adicional. | Verificar secreto de la app correcta, proxy/parser y eventos reales de la cohorte, después de aprobar el canary. |
| Ámbitos | Este corte vincula WABA/teléfono exactos a mappings activos, bloqueos independientes y clínicas registradas; restringe listados y estado. | Conciliar mappings reales y comprobar aislamiento en todos los consumidores/colas, también en el momento de procesar. |
| Token WABA | Revocación, retirada de tokens almacenados y parada de envíos reportadas por el usuario, sin comprobación activa. Motor aislado y cliente staging probados con ficticios; alta y salida públicas cerradas. | Registro y migración de consumidores todavía pendientes: el esquema/escritores heredados permiten guardar `waAccessToken` y `getClinicConfig` lo entrega a la API general si vuelve a existir. Esto no contradice la retirada de valores reales reportada por el usuario. No insertar un token nuevo en ese recorrido como prueba. |
| Cuenta/app Meta | No hay acceso ni revisión real en este corte. La atribución visual de actividad a ClinicaClick no demuestra origen. | Determinar evidencia del incidente; revisar administradores, socios, usuarios de sistema, apps y sesiones desde un dispositivo de confianza. Resolver accesos comprometidos y credenciales afectadas antes de emitir nuevas. El código de correo de ClinicaClick no controla sesiones ni tokens de Meta. |
| Publicidad | Conserva cuarentena y hotfix. | Segunda prioridad, lote separado; no habilitar `ads_management` ni consumidores Ads al reabrir una cohorte WhatsApp. |

## Informe del incidente recibido del propietario

Hechos comunicados y tratados como evidencia aportada, no como verificaciones
independientes de esta sesión: actividad no autorizada en varios clientes el
11/09 (campañas, anuncios, publicaciones, biografías/enlaces); una credencial
SYSTEM_USER sin caducidad programada y con permisos de publicidad, páginas,
Instagram, leads y WhatsApp podía enumerar 47 cuentas y 20 páginas. Su existencia
no prueba que ejecutara las acciones. Se informan 81 pagos en 23 cuentas.

El 12/09 a las 21:00:16–17 UTC (23:00:16–17 CEST) se crearon 55 plantillas
WhatsApp externamente, detectadas por sincronización y bloqueadas/retiradas a
las 21:58:19 UTC. No hay envíos fraudulentos de WhatsApp/Messenger confirmados.
Tampoco se confirman nuevos administradores/partners maliciosos; los objetos
«unknown» siguen sin atribuir. No se visitan los destinos sospechosos.

Se reportan cambio de contraseña, retirada de asignaciones y permisos de
publicidad/páginas, revocación posterior de WhatsApp, retirada de tokens en BD
y parada de envíos. Se conserva la excepción de una asignación publicitaria
bloqueada por facturación; no se presupone que mantenga permisos efectivos.
La respuesta OAuth 190/460 de una credencial anterior no valida todas las demás.

Consecuencia para el próximo lote: separar credenciales/activos WhatsApp de
Ads/páginas y la gestión de plantillas del envío ordinario cuando lo permitan
los permisos y tareas oficiales. Registrar y autorizar plantillas en ClinicaClick:
la aprobación de Meta o su descubrimiento por sync no equivalen a aprobación
local. Ningún token global con alcance multicliente se habilita como atajo.
La correlación definitiva requiere registros Meta de actor/app/credencial/sesión,
IP y request ID; no se acusa a un módulo ni al webhook por estos hallazgos.

## Correcciones de este corte

- `POST /api/whatsapp/webhook`: `FACEBOOK_APP_SECRET` o el alias existente
  `APP_SECRET` obligatorios; falta de secreto/bytes originales = 503, nunca
  aceptación sin firma. Un único `x-hub-signature-256`, formato SHA-256 exacto,
  HMAC y comparación constante. El payload de negocio se obtiene de esos bytes;
  no se reconstruye la firma con `JSON.stringify(req.body)`.
- JSON sin compresión, máximo 1 MiB. El parser global captura los bytes antes del
  handler; el límite de este módulo se comprueba tras el parser, no sustituye
  los límites HTTP del proxy. GET de suscripción admite un desafío numérico
  acotado y responde texto plano sin caché. El verify token de GET no autentica POST.
- El worker actual recibe una clínica/contacto por job. Se rechazan múltiples
  entries/changes, más de un mensaje/eco o historiales de distintos contactos,
  sin encolar parcialmente. Es una limitación funcional explícita: lotes reales
  de esos tipos requieren separación segura y pruebas antes de reabrirlos.
- Identidad por `entry.id` (WABA) y `metadata.phone_number_id`, sin fallback a
  otro número, nombres, últimos dígitos ni JSON libre. Si no hay teléfono, se
  requiere el mapping WABA exacto. Ámbitos ambiguos se rechazan. La consulta de
  recepción no selecciona `waAccessToken` ni `pageAccessToken`.
- La clínica sale del mapping y de asignaciones registradas del director de
  pacientes. Referencias `cc_ref` ausentes, vencidas o de otra clínica/grupo se
  rechazan si venían en el mensaje; no se pasan al worker para que las recupere
  sin validar. Los bloqueos de ámbito se consultan antes de buscar pacientes o
  escribir cola. Falta de tabla/estado produce indisponibilidad, no fallback.
- `GET /api/whatsapp/status` exige permiso de lectura de la clínica. `/phones`
  comprueba filtros de clínica/grupo y contexto de routing. Ser propietario de
  una clínica no otorga lectura de todas las clínicas ni sus activos. Se filtran
  roles/membresías con el helper de permisos vigente. Los errores son fijos.
- `/phones` excluye columnas de tokens y muestra información persistida; abrir
  el listado no hace Graph refresh, no encola un token en Redis, no registra el
  teléfono ni guarda metadata. No se presenta ese estado como consulta en vivo.
- Las escrituras públicas bajo `/api/whatsapp` exigen sesión y devuelven 503
  `meta_security_quarantine` antes del handler, incluidas asignaciones, catálogo,
  envíos, altas, registro y borrados. Esta barrera adicional no transforma en
  seguro un worker antiguo ni constituye un permiso para quitar la cuarentena.
- Los errores del webhook no imprimen payload, teléfono, configuración ni SQL.
  No se añade en este corte un registro externo durable de cada rechazo público.

La firma acredita integridad/autenticidad con el secreto de app; **no impide por
sí sola reproducir un evento firmado**. Falta cerrar deduplicación durable y
revalidación de ámbito en workers, el manejo de todos los eventos de coexistencia
y la migración del envío/medios/plantillas al broker. No se declara WhatsApp
completamente protegido ni utilizable por la mera presencia de este parche.

Referencia primaria del mecanismo de firma: [documentación oficial del SDK
WhatsApp de Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/).
Ese SDK está archivado; se usa como referencia del mecanismo, no como dependencia
ni evidencia de compatibilidad actual de toda la API. La configuración real y
los eventos de la cohorte se verificarán en el corte autorizado.

## Activación y regreso al servicio

El lote de MFA conserva las dependencias de [la primera entrega](meta-email-stage1.md).
Este parche no añade DDL. El webhook ahora depende del registro `MetaScopeBlocks`
(`20260913140000`) y del esquema existente de director de pacientes. Verificar
dependencias concretas antes del despliegue; no ejecutar migraciones en masa.

Para un visto bueno de reconexión faltan: terminar broker/consumidores WhatsApp,
resolver evidencias y accesos del incidente, conciliar las versiones exactas del entorno público confirmado (staging/gateway), aplicar el lote MFA, verificar permisos/aislamiento del nuevo
secreto y hacer un canary autorizado de recepción/envío a una cuenta de prueba.
Se presentará un lote concreto a su propietario, independiente de OPS. No se
han movido secretos, tocado AWS/BD compartida, cambiado pausas ni enviado mensajes.

Ante fallo, conservar rechazos de sesión sin correo, registro de bloqueos y
cuarentena. No volver al webhook que acepta firmas ausentes ni a la lectura
global por rol de una clínica. El backlog previo no se vacía ni se reproduce
en este corte: debe revisarse antes de arrancar workers.

## QA

Peticiones HTTP reales contra servidores de prueba locales propios, modelos y
colas ficticios, red exterior bloqueada y carga del modelo clínico real prohibida.
**38 pruebas pasan**, incluidas 18 nuevas de HTTP/WhatsApp. Se prueban firmas ausentes/alteradas/duplicadas, bytes originales, desafío GET,
WABA/número erróneo, scope ambiguo/bloqueado, clínica inyectada, referencias de
otra clínica y routing legítimo del director; además listados/estado/roles y
escrituras cerradas antes de efectos secundarios. Se conservan pruebas del
hotfix, contención, bajas y contrato MFA. Acta privada: `whatsapp-reconnection-*`
en `/home/ubuntu/qa-evidence/security-migration-20260912`.

Las pruebas no atribuyen el hackeo, no prueban tokens revocados ni acreditan
despliegue o correo real. El borrador de contadores sociales del broker se
conserva localmente fuera de esta publicación; no es un adaptador WhatsApp.
