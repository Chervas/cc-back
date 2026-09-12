# Auditoría de plataforma: primer bloque de autenticación

Estado 12/09/2026: código y QA aislada, **sin activar ni desplegar**. Solo
`POST /api/auth/sign-in`, `/sign-in-with-token` y `/unlock-session` preparan
captura semántica. No existe todavía worker instalado, bootstrap de identidad
AWS, visor autorizado ni cobertura completa. No activar el gate hasta acabar
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
conectado a un cron/job/cliente con identidad AWS efectiva.

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
Faltan alarma durable, receptor operativo, política de recuperación y worker;
no confundir métricas disponibles con alertas ya conectadas.
`down` rechaza borrar evidencia. No hay purga automática, siquiera de entregados:
DPD debe definir seis meses, originales/versiones/índices/copias, holds y borrado.
La cola local contiene metadatos sensibles y requiere acceso/backup/cifrado
aprobados; un hash local no protege frente a control total de la aplicación.

## Cobertura y siguientes lotes

Inventario `docs/security/platform-audit-route-inventory.json`: heurístico de
60 archivos/869 declaraciones literales, 3 preparadas y apagadas. Plantillas
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

Antes del corte: completar worker/alarma/visor, identidad runtime writer y
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

Paquete: Node 24 `npm test` con red bloqueada, cinco casos de esquema/S3.
Backend: Node 18 con preload `security_offline_runtime.cjs`, seis casos de
autenticación (incluye HTTP con router/middleware reales en puerto propio),
11 regresiones HTTP de `getAssetStats` y 28 del sistema de correo.
`CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/platform_audit_mysql.integration.js`
crea su propio mysqld/socket/datadir: ocho comprobaciones de persistencia,
concurrencia, atomicidad, caída/reconciliación y conservación. No usa `.env`,
clínicas, cuentas ni proveedores reales. El S3 del ensayo es un doble en
memoria; no certifica una entrega o retención AWS real.

Evidencia saneada: `/home/ubuntu/qa-evidence/security-migration-20260912/platform-audit-offline-qa.json`.
