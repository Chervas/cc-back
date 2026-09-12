# Auditoría de plataforma: primer bloque de autenticación

## Lector/visor y eventos v3 (12/09/2026, sin activar)

El contrato vigente de este bloque está en
[lectura y conciliación](../../docs/security/audit-reader-view-migration.md).
`reader-main.js` prepara HTTPS Node 24, IMDSv2/STS, validación de cuenta/roles,
GET de versiones y journal local. Firma Ed25519 distinta por permiso: visor
con cuerpos verificados y conciliador con recibos solamente. El codec admite
`audit.records.read` cerrado bajo `app/platform/v3/`; conserva los bytes v1/v2.
La UI usa el índice entregado local y exige comprobar cada versión S3, sin
alternativa local ante fallos. Esto no demuestra que el índice esté completo.

No hay lector instalado ni identidad AWS asignada. Verificar topología,
trusts y permiso KMS de GetObject antes del corte; aprobar retención/respaldo
del journal. Las referencias inferiores a lector/visor pendientes describen
el estado operativo: código preparado no equivale a servicio disponible.

## Eventos de sesión v2 (12/09/2026, sin activar)

El codec/writer acepta además eventos cerrados de emisión, renovación,
revocación y expiración observada bajo `app/platform/v2/`. El formato/bytes v1
se conservan. La transición y su evento comparten transacción SQL. Desplegar
este soporte antes de activar sesiones persistentes; no acredita entrega AWS
real ni retención. Contrato en `docs/security/access-session-migration.md` del
repositorio backend. Visor/reader y auditoría completa siguen pendientes.


Estado 12/09/2026: código y QA aislada, **sin activar ni desplegar**. Solo
`POST /api/auth/sign-in`, `/sign-in-with-token` y `/unlock-session` preparan
captura semántica. Worker y bootstrap writer preparados; no hay instalación ni identidad AWS
asignada. Visor autorizado, lector operativo y cobertura completa pendientes. No activar el gate hasta acabar
esos componentes y aprobar el lote operativo. No se ha creado una tabla real.

## Contrato y límites

`src/event.js` no necesita SDK y funciona en Node 18. El adaptador S3 pertenece
a este paquete Node 24 separado; la API general no importa el SDK ni obtiene
credenciales AWS. El broker conserva su contrato distinto `app/v1`; la
plataforma escribe `app/platform/v1/fechaUTC/eventId-sha256.json`, dentro de
`app/*` permitido en la plantilla recibida. Cuenta, bucket y KMS son constantes
de esa entrega, todavía no verificadas en AWS.

Evento cerrado y canónico: UUID de evento/correlación generados en servidor,
fecha UTC, acción, etapa, resultado/motivo enumerados, actor interno,
referencia de sesión, scope/recurso y política de captura. El intento es
anónimo/desconocido; el resultado identifica usuario solo tras verificar
contraseña o JWT y resolver la cuenta en BD. La referencia de sesión es el
`jti` UUID del JWT recién preparado, nunca su valor ni hash. Un rechazo por
token expirado permanece anónimo; no se decodifica para atribuir identidad.
Los JWT nuevos (incluido registro) incorporan `jti`; los anteriores siguen
siendo compatibles. No implica revocación del JWT anterior ni cambio de TTL.

`success` significa credenciales verificadas y token preparado antes de
responder; no acredita recepción HTTP en el cliente. Se guarda el resultado
antes de devolver el token. La actualización legacy de `ultimo_login` ocurre
antes y aún no comparte transacción con el resultado: una caída puede dejar
ese timestamp actualizado sin token entregado. El intento durable conserva
la incertidumbre. `append(event, { transaction })` permite atomicidad con
mutaciones de dominio futuras y tiene QA real de rollback sintético.

No se guardan email, password/hash, JWT, cookies, headers, formularios ni
contenido clínico. Se registra exclusivamente la IP válida del socket como
`direct_peer`; puede ser la del proxy. No se usa `req.ip` ni X-Forwarded-For
hasta verificar la cadena confiable. `effectiveActor` y
`authorizationPolicyVersion` son null: no existe delegación ni política de
autorización reconstruible en esta captura. Scope plataforma/recurso sesión;
el esquema rechaza clínicas, acciones nuevas y texto libre por ahora.

Los tres accesos dejan de serializar `password_usuario` y sus errores internos
son cerrados. Esto no certifica la ausencia de errores sensibles en todos los
controladores legacy; registro/reset y otros dominios siguen por revisar.

## Persistencia, entrega y fallos

Migración explícita `20260912210000-create-platform-audit-events.js`, modelo
`PlatformAuditEvent`, repositorio y servicio en `src/services/platformAudit.*`.
La tabla conserva bytes/digest, índice único de correlación/etapa, estado,
reintentos, lease y recibo. Mismo ID/bytes es idempotente; cambiar el resultado
o reutilizar la correlación para otro resultado falla. Leases SQL de 120 s,
`FOR UPDATE SKIP LOCKED`, ACK condicionado al dueño vigente y digest.
Backoff desde 2 s hasta 1 h, sin descartar eventos al agotar intentos.
`drain` limita cada ejecución a 100 eventos como máximo; todavía no se ha
conectado a una identidad AWS efectiva. El worker por lotes descrito debajo ya tiene
registro de cron/JobRequest, desactivado.

El writer solo invoca PutObject con propietario esperado, If-None-Match,
checksum SHA-256 y SSE-KMS exacto; no usa multipart ni Bucket Keys. Solo
confirma versión no nula, checksum y cifrado coincidentes. Fallo de transporte
reintenta; 412/ACK incompleto pasan a `reconcile`, sin acceso lector desde el
writer. El conciliador recibe por separado un cliente reader: descarga hasta
4096 bytes, coteja bytes/checksum/KMS y conserva VersionId. No enumera todo el
bucket ni constituye un visor paginado. Los clientes inyectados y sus roles
deben ser identidades independientes; los dobles de QA no prueban IAM.

La [semántica documentada de escrituras condicionales S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
solo protege la versión actual frente a esa petición condicional. La plantilla
no impone If-None-Match en bucket policy; no acreditar inmutabilidad frente a
un writer comprometido o administradores. Verificar con identidades autorizadas
las operaciones efectivas de [GetObject SSE-KMS/checksum](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html),
incluidas políticas de clave. El reader reportado solo tiene Decrypt/DescribeKey;
cualquier permiso adicional que demuestre necesitar la prueba se tramita en el
lote IAM, sin elevarlo automáticamente ni reutilizar al aprovisionador.

`PLATFORM_AUDIT_AUTH_ENABLED` ausente/false no consulta la cola. true exige
`PLATFORM_AUDIT_AUTH_POLICY=auth-durable-v1`; cualquier valor erróneo impide
esos accesos. Política **propuesta, pendiente de aprobación antes de activar**:

| Situación | Comportamiento preparado |
|---|---|
| Fallo al guardar intento | HTTP 503 antes de consultar credenciales |
| Fallo al guardar resultado | HTTP 503 sin token; no inventar resultado alternativo |
| Destino externo caído con cola sana | Seguir guardando durablemente y reintentar entrega |
| >=10.000 eventos sin confirmar o antigüedad >=1 h | Rechazar nuevos accesos de esta cohorte con 503 |
| Proceso cae sin completar | Intento desconocido; health cuenta ausencia de resultado, sin fabricarlo |
| Clínicas, otros endpoints y sesiones abiertas | Aún sin instrumentar por este bloque; no se aplica este gate globalmente |

Los umbrales son controles de admisión, no una cuota transaccional exacta de
disco. Health ofrece backlog/edad, conciliaciones e intentos sin resultado.
Alarma durable de panel y worker preparados en el bloque siguiente, sin
activación. El vigilante externo del host y la respuesta operativa siguen
pendientes; no se ha enviado ningún aviso real.
`down` rechaza borrar evidencia. No hay purga automática, siquiera de entregados:
DPD debe definir seis meses, originales/versiones/índices/copias, holds y borrado.
La cola local contiene metadatos sensibles y requiere acceso/backup/cifrado
aprobados; un hash local no protege frente a control total de la aplicación.

## Cobertura y siguientes lotes

Inventario `docs/security/platform-audit-route-inventory.json`: heurístico de
60 archivos/870 declaraciones literales, 3 preparadas y apagadas. Plantillas
locales; comentarios, rutas dinámicas/condicionales, sockets/jobs/scripts
requieren revisión adicional. No es porcentaje de cobertura operativa.

| Cohorte | Estado / trabajo pendiente |
|---|---|
| Tres accesos anteriores | Captura semántica, outbox y QA preparados, apagados |
| Registro/invitación/recuperación/reset | Instrumentación transaccional y pruebas pendientes |
| Logout/revocación/caducidad de sesión/delegación | Logout frontend solo local; falta ciclo de sesión servidor; expiración aquí solo detectada al intentar login con token |
| Permisos/asignaciones/elevación | Instrumentar decisiones y versionar política/grants reconstruibles |
| Pacientes/agenda/tratamientos/consentimientos/documentos | Lecturas/búsquedas/escrituras por scope autorizado, sin datos clínicos; pendiente |
| Exportaciones/descargas/enlaces firmados | Diferenciar enlace emitido de descarga observada; pendiente |
| Jobs/integraciones/configuración/aprobaciones | Intento/aceptación/finalización; auditorías de dominio actuales no sustituyen entrega global |
| Visor/exportador de auditoría | Lector paginado con autorización específica y auditoría de su acceso; pendiente |

Antes del corte: completar lector/visor, vigilante externo, identidad runtime writer y
reader distinta, TLS/canal de despliegue, verificación SSO mínima y prueba
ficticia autorizada en AWS; acordar política de fallos/retención, estimar coste
con volumen y métricas. Dos objetos por intento con resultado, más reintentos,
S3/KMS/almacenamiento/lecturas y coste de copias locales; los 60 USD reportados
no autorizan un volumen ilimitado ni son un límite duro. Preparar respaldo
privado, migración **solo esta tabla**, hosts/consumidores/ventana y rollback.
Nada de ello se ha aplicado a servicios utilizados.

Rollback de código debe mantener exclusión del hash de contraseña, hotfix Meta,
cola/recibos y JWT emitidos compatibles; no volver a una respuesta vulnerable
ni borrar pendientes. Desactivar una captura ya activa necesita el procedimiento
operativo acordado y un evento de cambio; no silenciarla automáticamente.

## QA reproducible sin servicios externos

Paquete: Node 24 `npm test` con red bloqueada, diez casos de esquema/S3,
lotes, bootstrap con SDK inyectado y CLI real con guard de red.
Backend: Node 18 con preload `security_offline_runtime.cjs`, seis casos de
autenticación (incluye HTTP con router/middleware reales en puerto propio),
11 regresiones HTTP de `getAssetStats` y 28 del sistema de correo.
`CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/platform_audit_mysql.integration.js`
crea su propio mysqld/socket/datadir: ocho comprobaciones de persistencia,
concurrencia, atomicidad, caída/reconciliación y conservación. No usa `.env`,
clínicas, cuentas ni proveedores reales. El S3 del ensayo es un doble en
memoria; no certifica una entrega o retención AWS real.

Evidencia saneada: `/home/ubuntu/qa-evidence/security-migration-20260912/platform-audit-offline-qa.json`.

## Worker y monitor preparados (quinto bloque, sin despliegue)

`src/services/platformAudit.delivery.js` consume hasta 50 registros en un lote,
con selección limitada a 15 s; lanza un proceso Node 24 fijo con solo bytes y
digest por stdin. Nunca envía modelos, credenciales de BD, JWT o campos del
JobRequest. El payload de ejecución no puede elegir modo lector, endpoints,
bucket, claves ni límites. Sin registros no consulta AWS.

`writer-main.js` valida todo el lote y cuenta/región antes de crear clientes.
Solo IMDSv2 de `169.254.169.254`; config y credentials files apuntan a `/dev/null`,
endpoints HTTPS STS/S3 fijos en París y sin redirección de región. Verifica el
rol de origen configurado, después asume **solo** el writer de la entrega por
900 s y verifica su identidad antes de PutObject. No admite usuarios IAM,
root, roles SSO reservados ni usar directamente el writer como origen.
`PLATFORM_AUDIT_WRITER_SOURCE_ROLE_ARN` debe ser el ARN aprobado del rol del
host real; cuenta de ese host y trust todavía sin verificar. No inventar que
el instance role del broker está asignado al host de la BD/worker.

Cuatro puts simultáneos como máximo, sin retry de clientes STS/S3 (IMDS puede
reintentar una vez); red con conexión
2 s/petición 5 s, señal de aborto 60 s y proceso hijo propio limitado a 75 s.
El padre elimina solo su hijo agotado. Leases por evento de 120 s y un lease
global de 270 s en `PlatformAuditDeliveryStates` impiden barridos concurrentes
en runtimes que comparten BD; un proceso viejo no puede sobrescribir el estado.
Si los límites de tiempo se superan, se conserva incertidumbre y se recupera
por lease/reintento. La validación completa de la respuesta evita aceptar ACK
parciales de un lote alterado; registros con 412 quedan para el lector separado.
No hay fallback a credenciales del backend ni privilegios reader en este job.

La migración adicional `20260912213000` crea únicamente estado de entrega,
lease, contadores y episodio de alarma. Solo aplicada a MySQL ficticio; `down`
conserva la evidencia. El monitor guarda sus transiciones y notificaciones
atómicamente en los modelos existentes de `Notifications`, solo para usuarios
canónicos de administración técnica 1/44 existentes. No email, WhatsApp ni
configuración del servidor de correo; tampoco encola un dispatch de proveedor.
Un fallo revierte todo el lote de avisos y permite reintentar. No se hace push
socket: los avisos aparecen en la siguiente lectura habitual del panel.

| Job | Horario Europe/Madrid | Gate apagado por defecto |
|---|---|---|
| `platform_audit_delivery` | Cada minuto | `PLATFORM_AUDIT_DELIVERY_ENABLED` |
| `platform_audit_monitor` | Cada 5 minutos | `PLATFORM_AUDIT_MONITOR_ENABLED` |

Ambos pertenecen al scheduler durable existente, respetan leader/pausas y no
ocupan el carril de integraciones publicitarias. Un intento de job por ciclo;
los reintentos por evento los gobierna la cola. `PLATFORM_AUDIT_NODE_BINARY`
debe identificar el Node 24 autorizado/instalado en el host del worker.

Alarma crítica por 10.000 pendientes, antigüedad >=1 h, fallo de identidad o
integridad, o heartbeat >5 minutos/ausente. Aviso por 1.000 pendientes, edad
>=5 minutos, resultado desconocido antiguo, conciliación o fallo de entrega.
Recuperación única al salir del episodio. Los dos jobs pueden caer juntos:
el panel y el endpoint no sustituyen un watchdog externo. Ninguna alarma real
ni cambio de pausas se ha ejecutado. El umbral de admisión de auth sigue el
contrato anterior; avisos y heartbeat no modifican permisos de sesión.

`GET /api/system-monitoring/audit/health`: JWT + administrador técnico global,
`private, no-store`. Solo contadores cerrados/fechas UTC/estado, sin leer AWS,
publicar jobs o devolver eventos/actores/ARNs. Todos los gates ausentes devuelve
`disabled` sin BD. Falta tabla: 503 `audit_migration_required`; fallo cerrado
503 `audit_monitor_unavailable`. Este endpoint de salud no es el visor de
actividad y todavía no emite su propio evento de consulta.

La capacidad nominal es hasta 50 intentos de PutObject por minuto (72.000 al
día si cada ciclo se llena), incluidos reintentos; dos eventos por login con
resultado. No es una cuota IAM ni de facturación: SDK/operador/otros escritores
pueden generar costes adicionales. Antes de activar, dimensionar volumen,
S3/KMS, retención y copias con el Budget incremental reportado de 60 USD; la
prueba con 55 eventos no acredita capacidad ni coste de producción.

QA adicional: 5 casos de servicio de entrega/monitor y 10 de regresión de costes, 1 caso HTTP de salud,
regresión de 42 definiciones/executores del scheduler y 9 comprobaciones MySQL
de lease global, lote 50+6, ACK perdido, dedupe concurrente, rollback de avisos,
conciliación/recuperación y heartbeat. S3 sigue siendo un doble, no verificación
AWS. Evidencia privada `platform-audit-delivery-offline-qa.json` y publicación
`platform-audit-delivery-publication.json` en el directorio de QA ya indicado.

El mismo cierre de archivos AWS e IMDS fijo se aplica al proceso hijo del
colector de costes existente, probado con ejecución inyectada; no cambia su
filtro, cron, permisos ni estado de activación.

Un ciclo vacío o esperando backoff conserva el error anterior: no declara
recuperación sin un nuevo envío confirmado. `writer.lastConfirmedAt` distingue
la última entrega con recibo del simple heartbeat del proceso; este último
no acredita permisos AWS ni que la instalación esté aceptada.
