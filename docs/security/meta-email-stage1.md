# Primera etapa: contención Meta y acceso con código por correo

> **Tipo:** runbook del corte de acceso y su relación con la contención Meta.
> **Estado vigente:** [19, seguridad](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).
> **Evidencia del corte de MFA:** [99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-mfa-publico-2026-09-14).

El usuario eligió expresamente códigos por correo. El producto OPS queda fuera del foco;
no es una dependencia de ClinicaClick ni de esta activación.
El objetivo completo de integraciones, auditoría, costes y cifrado sigue abierto.

## Resultado y límites

La API prepara un acceso en dos pasos: contraseña y código enviado al correo de
la cuenta. Antes del segundo paso no emite una sesión ni carga permisos en el
front. La contención Meta conserva el hotfix de estadísticas y añade una
cuarentena de salida en los consumidores inventariados, incluida WhatsApp.
La cuarentena es global para Meta en este corte de código: **no permite reactivar
Meta desde Ajustes, variables de entorno, otros tokens ni borrando conexiones**.
Retirarla requiere otro corte revisado después de preparar el broker.

Esto no prueba el vector del incidente, no revoca tokens en Meta y no retira aún
las credenciales antiguas de la BD/API general. Los tokens WABA fueron reportados
como revocados por el usuario; no se han usado ni comprobado. La siguiente capa
debe aislar las credenciales y migrar cada consumidor antes de reabrir una cohorte.
El correo añade una comprobación de acceso al buzón; no ofrece resistencia al
phishing ni un factor independiente cuando ese mismo buzón recupera la contraseña.

## Acceso y recuperación

- `AUTH_EMAIL_MFA_MODE=off` es el valor de compatibilidad; `enforce` exige el paso
  por correo **a todas las sesiones ordinarias**, incluidos administradores,
  desbloqueo, cuentas nuevas e invitadas. No hay excepción por usuario o clínica.
- Exige `AUTH_SESSION_MODE=enforce`, `PLATFORM_AUDIT_AUTH_ENABLED=true` y
  `PLATFORM_AUDIT_AUTH_POLICY=auth-durable-v1`. Las sesiones anteriores sin prueba
  de correo son rechazadas al activar la política, incluida su renovación y los
  controles de sesión de callbacks/sockets. No se amplía la vida absoluta de 24 h.
- Código aleatorio de seis dígitos, cinco minutos, un solo consumo. Prueba de la
  contraseña con máximo absoluto de diez minutos. Cinco intentos fallidos cierran
  el desafío; volver a enviar no reinicia intentos. Sesenta segundos entre envíos,
  máximo tres por desafío y cinco por usuario/hora. El cómputo de la hora es
  conservador y conserva todos los envíos de un desafío cuyo último envío cae en
  la ventana, para no omitir reenvíos cercanos al límite.
- `AuthEmailChallenges` conserva solamente hash del portador aleatorio de 256
  bits, HMAC del código, vínculo de credenciales, hash del correo y estado. El
  HMAC usa una clave separada de 32 bytes desde `AUTH_EMAIL_MFA_KEY_FILE`: ruta
  absoluta real, archivo privado, sin enlaces simbólicos ni permisos de grupo/
  otros. Ni la clave ni el portador se instalan desde el navegador.
- El código viaja en la plantilla `auth.email_verification` de la cola de correo
  existente, con prioridad `critical`. El contexto y destinatario se cifran con
  el mecanismo AES-256-GCM existente y `EMAIL_DATA_ENCRYPTION_KEY`; el código no
  aparece en asunto, logs, auditoría ni contexto de outbox en claro. La respuesta
  202 acredita encolado, **no entrega**. El worker comprueba desafío, destinatario,
  credenciales, vencimiento y mensaje vigente antes de enviar. Una carrera después
  de esa comprobación puede entregar un correo viejo; su código ya no autentica.
- Consumo, sesión y auditoría se confirman en una sola transacción, con bloqueo
  del usuario antes del desafío. Fallos de correo/auditoría no permiten sesiones
  parciales. Los rechazos sí conservan intentos/estado. Dos verificaciones
  simultáneas solo pueden consumir una vez.
- Login/desbloqueo conservan el desafío solo en memoria. Cancelar, cerrar sesión
  o comenzar otro login descarta respuestas tardías; no se guarda el código ni
  el desafío en localStorage. Una respuesta 401 de verificación permite otro
  intento dentro del límite. La UI muestra caducidad, reenvío, bloqueo y fallo.
- Registro e invitaciones devuelven `signInRequired:true` sin JWT cuando se exige
  correo. El usuario continúa en login y completa ambos pasos.
- Los editores genéricos de Usuarios/Personal rechazan cambios de correo de acceso
  o contraseña con 409 cuando se exige correo, antes de guardar otros campos.
  La recuperación de contraseña usa el enlace del buzón existente, conserva
  consumo único y audita su cambio en la misma transacción. Cambiar contraseña
  invalida sesiones y desafíos anteriores; no emite un JWT ni omite el código.
- Pérdida de acceso al buzón: recuperación asistida con identidad comprobada,
  titularidad/autorización documentadas y un lote específico. Mantener bloqueada
  la cuenta mientras se resuelve; no usar Usuarios/Personal, apagar la política
  ni una credencial compartida como atajo. El lote debe revocar sesiones,
  desafíos y enlaces de recuperación anteriores, registrar responsable y cambio
  de correo, y exigir nuevo login. No se entrega un endpoint de recuperación sin
  buzón ni se ejecuta aquí ese procedimiento con usuarios reales.

## Contención y permisos Meta

`metaQuarantineHttp` no importa un cliente de red: rechaza sus métodos y `create`
con `meta_security_quarantine`, 503, sin configuración/URL/cuerpo en el error y
sin reintento. Está congelado y no tiene interruptor de apertura.

| Recorrido de producción inventariado | Protección en este corte |
| --- | --- |
| `metaClient`, `metaBatch`, sincronización actual y servicio legacy metasync | Transporte cerrado; también cubre jobs y consumidores que usan estos adaptadores. |
| OAuth Meta, suscripciones de página | Cliente Meta separado del cliente Google; connect/callback/map-assets cerrados antes de ejecutar handlers. Persistencia de conexiones y promoción de assignments también cerradas. |
| Diagnósticos Meta | Superficie `/api/metasync/diagnostic` restringida a administración técnica y cerrada antes de leer secretos o devolver respuestas crudas. |
| Controlador/servicio WhatsApp, teléfonos y plantillas | Transporte cerrado, incluidos envíos, registro, perfiles, medios y URLs arbitrarias. |
| Embedded signup WhatsApp | Callback cerrado antes de guardar tokens; transporte cerrado para el resto del módulo. |
| CAPI, recepción de leads nativos y plantillas de notificaciones de sistema | Transporte de producción cerrado. Los dobles inyectados de QA no son una opción de la API pública. |
| Lecturas históricas | Continúan bajo permisos. `/api/metasync/metrics/:clinicaId` valida ACL antes de métricas, ID estricto y fechas reales ordenadas (máximo 366 días); no selecciona `pageAccessToken` y responde con error fijo si falla SQL. Se elimina su registro de ruta duplicado. |

No se presenta esto como firewall de toda la instancia. Scripts operativos
independientes (`src/scripts/push_ops_global_discovery.js` y
`scripts/backfill-whatsapp-legacy-scope.js`), navegadores, procesos que todavía
ejecuten una versión anterior y herramientas externas no quedan protegidos por
estos imports. No se han ejecutado. El lote operativo debe conservarlos parados
y verificar todos los procesos, además del aislamiento de red de la capa 2.

`MetaScopeBlocks` es un registro sin FK ni cascadas, sin API de desbloqueo. La DDL
importa assignments existentes `disconnected`/`revoked`. Las bajas nuevas guardan
el ámbito y las clínicas heredadas afectadas, junto a la auditoría y desactivación
de mappings, en una transacción. El resolver consulta el registro antes de usar
asignaciones o fallback de grupo/usuario. La ausencia de tabla falla cerrada.
No se reconstruyen bajas históricas que ya fueron borradas antes de esta DDL;
la cuarentena global sigue cubriendo la salida mientras se concilia ese historial.

La comprobación de afectados incluye propietario, asignaciones compartidas,
clínicas de mappings de grupo y grupos que referencian un activo como primario
Facebook/Instagram, incluso con política dormida. Se bloquean lecturas de esas
referencias durante la baja. Si hay alguna clínica fuera del ámbito solicitado,
la baja devuelve conflicto sin mutación parcial. Este cambio también refuerza
la comprobación usada por el hotfix sin editar sus bytes.

## Auditoría

v13: `auth.email_code` registra encolado/reenvío/verificación y denegaciones,
incluido el intento de sustituir credenciales desde un editor genérico.
`auth.password_reset` registra la recuperación confirmada. v14:
`integration.meta.scope_block` registra el bloqueo local confirmado; **no afirma
revocación del proveedor**. Contratos cerrados, UUID opacos y actores/ámbitos;
sin código, portador, email, contraseña ni token Meta. Writer/reader aceptan
v13/v14 y el visor permite filtrar las acciones. La captura se cierra si la cola
tiene 10.000 pendientes o un registro pendiente de una hora.

La entrega a S3 y su retención efectiva requieren los roles/configuración y corte
de auditoría ya documentados. La nueva captura local no prueba entrega externa.
No se purgan desafíos, revocaciones ni registros históricos en esta etapa. La
retención/recuperación de estos datos se debe conciliar con el DPD.

## Procedimiento de activación

Para un corte limitado a login, usar el candidato específico de cinco migraciones
de sesiones/auditoría y sus parches sobre cada base pública. Ese corte no incluye
`MetaScopeBlocks`, migraciones Google ni reconexión de consumidores. La secuencia
siguiente describe también dependencias de la etapa Meta completa: no ejecutarla
íntegra por haber autorizado MFA. El acta enlazada gobierna el lote aplicado.

1. Conciliar versiones y DDL reales de DEV/staging/gateway y workers: comparten
   BD. Revisar todo el rango de commits; no aplicar un despliegue de toda DEV ni
   ejecutar todas las migraciones pendientes. Mantener las pausas actuales y
   Meta sin salida durante toda la ventana.
2. Dependencias específicas: Usuarios/Clinicas/grupos y asignaciones Meta
   existentes; `20260912210000` (auditoría), `20260913003000` (result_part),
   `20260912220000` (sesiones), `20260829120000` (correo/reset) y JobRequests
   `20251020100000`, con sus ampliaciones ya requeridas por el código desplegado.
   El candidato completo conserva también las dependencias Google del checkpoint
   anterior, incluida `20260913120000`; no es un lote autónomo para una BD vacía.
3. Respaldo y restauración de prueba, inventario solo de metadatos y conteos de
   filas; aprobar ventana/locks. Ejecutar **solo**
   `20260913130000-create-auth-email-challenges.js` y
   `20260913140000-create-meta-scope-blocks.js` cuando sus dependencias estén
   verificadas. Ambas deben preceder al código, incluso si MFA queda apagado.
   La primera contiene DDL múltiple, no atómica; ante interrupción, conciliar
   columnas/tablas antes de reanudar. Ningún `down` permite borrar historia poblada.
4. Instalar primero reader/writer compatibles con v13/v14 y después código en
   todos los procesos afectados. Preparar la clave MFA privada separada y las
   claves/configuración existentes de sesiones y cifrado del correo tanto para
   el emisor como para el worker; no imprimirlas ni regenerarlas por rutina.
   Verificar SES existente, destinatarios permitidos, cola `email_send`, prioridad
   y latencia menor de cinco minutos. Un proveedor `mock` no valida correo real.
5. Canary con cuenta/buzón de prueba y autorización explícita del envío. Confirmar
   entrega, código único, error/reenvío, recuperación, login/invitación, logout,
   sesiones antiguas rechazadas, auditoría externa y todos los puntos de entrada.
   Coordinar `AUTH_EMAIL_MFA_MODE=enforce` en todos los emisores/verificadores y
   workers; no dejar un proceso que emita sesiones con contraseña sola.
6. Rollback: conservar tablas/historia, hotfix, cuarentena y rechazo de sesiones
   sin segundo paso. Ante fallo del correo, mantener acceso cerrado mientras se
   repara; no bajar MFA/sesiones a off/legacy ni volver a código vulnerable.
   Cualquier reversión de política de acceso necesita otro lote expresamente
   revisado. El corte de recuperación solo se da por verificado tras el canary.

Responsable de aprobar ventana, buzón de prueba, secretos/configuración y corte:
propietario de ClinicaClick. El apagado del producto OPS no impide preparar este
lote. La reconexión de WhatsApp tiene además los pendientes concretos descritos
en [whatsapp-reconnection-readiness.md](whatsapp-reconnection-readiness.md).
Coste: no se crean recursos AWS. El incremento esperado son correos de acceso/
reenvío y almacenamiento/entrega de auditoría; falta medir volumen y coste real
tras canary. El Budget reportado y su conciliación CloudFormation, Cost Explorer,
etiquetas, retención y cifrado/restauración de BD mantienen su estado pendiente.

## Verificación de esta entrega

Evidencia privada `meta-email-stage1-*` en
`/home/ubuntu/qa-evidence/security-migration-20260912`, fuera de rutas públicas.
QA con datos ficticios: contratos/HTTP/backend, auditoría Node 24, MySQL propios
con red exterior bloqueada y apagado comprobado, pruebas de AuthService e
interceptor, build Angular y Chromium escritorio/móvil sobre el componente real
con transporte simulado. El acta final conserva fallos previos de harness,
correcciones y ejecuciones finales, sin sumarlas como verificaciones reales.
No se ha iniciado la aplicación contra la BD compartida, enviado correo real,
usado Meta/AWS, reiniciado PM2 ni desplegado. Push a DEV no equivale a activación.

## DEV aislado: correo de acceso y auditoría

`isolated-security-v2` conserva BD, Redis, JWT y UID propios. La API usa los
mismos controladores de sesiones/MFA que staging, pero solo encola correo. No
recibe claves SES ni claves del writer/reader AWS. `clinicaclick-dev-security`
consume únicamente `email_send` del namespace DEV para códigos y recuperación
de usuarios registrados y entrega su outbox de auditoría con claves distintas.
No importa el scheduler ni arranca recordatorios, Meta, Google o colas de negocio.

El visor usa `/var/lib/clinicaclick-dev-security/audit.sock`: el proceso separado
verifica sesión DEV y cada recibo contra la BD DEV antes de consultar AWS. No
admite referencias conocidas únicamente en staging. El archivo S3 es compartido;
el índice de cada entorno y la identidad firmante de entrega son independientes.
No copiar el índice/recibos público a DEV. La captura cubre acceso, sesiones,
permisos y las consultas sensibles ya instrumentadas; no supone cobertura de
cualquier edición/exportación del producto.

Procedimiento: comprobar el contrato SQL, generar claves DEV, añadir solo sus
claves públicas a writer/reader conservando las públicas, instalar la unidad
`ops/security/systemd/clinicaclick-dev-security.service`, publicar el código
comprometido con `publish-isolated-dev.py`, drenar auditoría y comprobar SES antes
de activar MFA. El consumidor usa `flock`; un resultado de envío incierto no se
repite automáticamente. La clave SES heredada solo existe en el consumidor
protegido: su traslado al vault sigue pendiente de activación. El adaptador SES
tipado y sus pruebas aisladas están preparados; límites, deduplicación y pasos
pendientes en [email-vault-migration.md](email-vault-migration.md). El rol
administrativo SSO del operador no participa en los envíos.

Para desarrollo local, el retorno de recuperación puede ser exactamente
`http://localhost:4200`; la excepción solo pertenece al consumidor DEV. Los
dispositivos recordados mantienen el requisito de HTTPS del contrato público.
No desactivar MFA público ni reutilizar contraseñas, cookies, JWT o tokens de
proveedores para igualar entornos. Rollback: detener el consumidor y restaurar
configuración/release DEV previas; conservar outbox, sesiones, pruebas y recibos.
