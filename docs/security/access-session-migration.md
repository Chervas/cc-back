# Sesiones persistentes: preparación del corte

12/09/2026. Implementado y probado con usuarios ficticios; **no desplegado ni
activado**. La BD compartida y PM2 no se han modificado. Los JWT de usuario
siguen siendo independientes de la identidad Ed25519 del broker.

## Contrato

`src/services/accessSession.service.js` concentra emisión y validación.
`AUTH_SESSION_MODE` admite `legacy` (valor inicial) y `enforce`. Una configuración
inválida falla cerrada. Enforce exige `PLATFORM_AUDIT_AUTH_ENABLED=true` y
`PLATFORM_AUDIT_AUTH_POLICY=auth-durable-v1`; una cola de 10000 eventos o una
antigüedad de una hora impide nueva emisión/renovación. Revocar sigue disponible
con su propia escritura durable, sin depender de que se vacíe la cola.
En legacy no se consulta BD para validar un JWT antiguo;
se conserva HS256 y se exige actor numérico positivo y expiración. Se rechazan
tokens con propósito/issuer/audiencia de otro producto. En enforce se rechazan
todos los JWT antiguos, incluidos los que ya tienen JTI pero carecen de
`sessionVersion=1`. El cambio requiere volver a iniciar sesión.

Los JWT persistentes incluyen `sessionVersion=1`, `type=cc_access`, issuer
`clinicaclick`, audiencia `clinicaclick-platform`, JTI UUID, actor, email,
isAdmin derivado del helper canónico y tiempos firmados. Se comprueban contra
`AuthSessions` y el usuario en un único SELECT consistente, sin caché REST.
**Un JWT persistente siempre consulta su revocación, incluso si un runtime
vuelve a legacy.** Esto no autoriza volver a un middleware antiguo que ignore
esas comprobaciones.

La tabla contiene solo referencia de sesión/usuario, fechas, estado, fin y
un HMAC del identificador, hash de contraseña y email actuales, con separación
de contexto usando la clave de firma existente. No persiste JWT, contraseña,
hash bcrypt ni email. Ese vínculo se compara con el usuario actual en cada
validación: un cambio de contraseña o email invalida los JWT previos aunque el
escritor utilice un UPDATE directo. La contraseña permanece en el modelo de
usuario existente; esta tabla no cambia ese almacenamiento. Un usuario
inactivo/provisional se rechaza mientras conserve ese estado. Reactivar la
cuenta no equivale a una revocación permanente: usar la operación de revocar
sesiones y completar la cohorte de administración de cuentas/permisos.

Emiten por el mismo servicio sign-in, unlock, token sign-in, sign-up e invitación.
La emisión persistente relee/bloquea el usuario y compara la prueba de
credenciales para rechazar una contraseña verificada antes de un reset
concurrente. La invitación bloquea usuario y pivot antes de consumirlos.
Crear usuario/reclamar invitación y emitir sesión se confirma junto al evento
de auditoría. En autenticación persistente, último login, sesión, evento v2 y
resultado v1 habilitado comparten transacción. Una falla no devuelve un token.
El intento v1 previo puede quedar sin resultado si falla su confirmación;
el monitor lo trata como desconocido, sin reconstruir un éxito.

Propuesta incorporada al modo todavía apagado: TTL de acceso de
`AUTH_ACCESS_TOKEN_TTL_SECONDS` (300–86400 segundos, default 43200), límite
absoluto de sesión de 24 horas y máximo 100 sesiones vigentes por usuario.
Una invitación mantiene TTL de 24 horas. Renovar conserva el JTI del dispositivo
y extiende su expiración hasta el límite absoluto. Varias pestañas pueden
renovar simultáneamente; los JWT anteriores siguen sujetos a su propio `exp`
y a la misma revocación. No hay renovación ilimitada ni tokens refresh separados.
Estas duraciones y límites se incluyen en la aprobación del corte.

## API y frontend

| Ruta | Resultado |
|---|---|
| GET `/api/auth/me` | JWT verificado; proyección real de usuario sin hash y estado managed/expiración, `private, no-store` |
| POST `/api/auth/sign-out` | Bearer propio; revoca esa sesión con auditoría transaccional. Repetir mientras el JWT no expire confirma la misma revocación |
| POST `/api/auth/revoke-sessions` | Bearer propio activo; revoca todas sus sesiones vigentes en la transacción. No acepta actor ajeno del body/query |

Respuestas cerradas: `{status:'revoked',revoked:true}` o, para un JWT legacy,
`{status:'local_only',revoked:false}`. Una firma/expiración inválida devuelve 401;
BD/configuración no disponibles, 503. Un logout de JWT expirado no afirma haber
revocado la fila. Revoke-all requiere sesión activa y no permite reutilizar
una sesión ya revocada para revocar sesiones creadas posteriormente.

El front limpia inmediatamente su estado local y comienza una sola petición de
logout aunque el llamador no se suscriba. Conserva el Bearer capturado únicamente
para esa petición, con timeout de cinco segundos. Muestra pendiente, confirmado,
solo local o no confirmado; una caída no se presenta como revocación exitosa.
El interceptor no inicia otro logout ante la respuesta del propio logout ni
elimina una sesión nueva por un 401 de una petición con un token anterior.
`check()` restaura identidad desde `/me`: desaparecen el usuario ficticio y la
aceptación basada solo en localStorage. No se registran respuestas de auth con
JWT en consola. Respuestas tardías de comprobación/refresh no restauran el
token eliminado; renovaciones concurrentes del mismo JTI no acortan la vigencia
que ya guardó otra pestaña.

## Sockets y auditoría

REST común, login por token, rutas de clínicas y sockets usan el mismo
verificador. El socket valida handshake y mensajes entrantes, tiene temporizador
de expiración y consulta cada cinco segundos con deadline de 1,5 segundos.
Ante error o revocación abandona la conexión y sus rooms. Límite esperado para
cortar tráfico saliente tras revocación: intervalo + deadline (6,5 segundos),
más retrasos del event loop/red; no es una garantía de entrega instantánea.
Una consulta SQL que exceda el deadline puede seguir ejecutándose, pero su
resultado tardío no reconecta el socket. Las peticiones ya autorizadas/en vuelo
no se cancelan retroactivamente. Se comprueba conexión antes de incorporar
rooms después de cargas asíncronas.

Los permisos de clínica se cargan al conectar; este bloque **no** implementa
la invalidación/reconstrucción de grants o roles de sockets tras modificarlos.
Esa cohorte sigue pendiente, junto con revocación por administrador,
suplantación/delegación, auditoría de cambios de contraseña/email/estado y
auditoría de denegaciones de cada lectura/acción/logout. Los tokens públicos
de firma clínica, kiosco y aserciones Google no se convierten en sesiones de
usuario; tienen un inventario y corte separados.

Eventos cerrados v2: `session.issued`, `session.renewed`, `session.revoked`,
`session.expired`. Solo actor/usuario sujeto, referencias UUID, scope plataforma,
resultado, motivo enumerado, política `managed-session-v1` y fechas UTC.
Partición S3 `app/platform/v2/…`; los eventos v1 conservan sus bytes/partición.
Usan el outbox y writer existentes; no hay lectura de AWS al autenticar ni logout.
El registro de una transición confirma el estado del servidor, no la recepción
de la respuesta por el navegador. No incluye contenido clínico ni credenciales.

Job `authSessionExpiry` / `auth_session_expiry`, cada cinco minutos en
Europe/Madrid, apagado con `AUTH_SESSION_EXPIRY_ENABLED` ausente/false. Procesa
como máximo 100 filas por ejecución mediante locks SQL/SKIP LOCKED; almacena
una vez el momento efectivo de expiración y el momento en que se observó.
La validez se comprueba aunque el job esté apagado. No elimina registros.
La retención de tabla/outbox/S3 y la política DPD siguen pendientes; no se
equiparan 183 días con seis meses naturales.

## Lote que requiere aprobación independiente

1. Verificar todos los runtimes que aceptan estos JWT y sus clientes/copias
   externas, incluyendo dev, staging y gateway. Inventario estático en
   `access-session-inventory.json`; no acredita versiones ejecutándose.
2. Respaldar y aplicar **solo** `20260912220000-create-auth-sessions`, con su
   dependencia `20260912210000-create-platform-audit-events` si no existe.
   Ambas siguen sin aplicar en la BD compartida. No ejecutar migrations all.
3. Desplegar primero soporte v1/v2 de outbox/writer y verificadores comunes en
   todos los runtimes, conservando pausas/hotfix. Desplegar `/me` y logout en
   backend antes del front que los requiere. No basta un push a dev.
4. Aprobar el cambio de autenticación simultáneo, TTL/límite/umbral de cola,
   aviso de nuevo login y coste/carga SQL de HTTP y sockets. Activar captura y
   writer/monitor solo con su lote AWS aprobado; comprobar destino protegido.
   Propuesta de ventana: 20 minutos, todavía sin reservar ni autorizar.
5. Activar `AUTH_SESSION_MODE=enforce` en todos los aceptadores y el job de
   expiración en el scheduler autorizado, sin reactivar cron/proveedores
   pausados. QA sintética en los runtimes y confirmación de entrega externa.

Rollback: conservar migraciones, filas, revocaciones, el verificador de JWT
persistentes, proyecciones sin password y hotfix. Ambos down preservan evidencia.
Si no es posible mantener esos controles, detener el acceso afectado y acordar
el corte; no retornar al middleware que acepta cualquier JTI. Volver a emitir
JWT legacy requiere una decisión explícita porque vuelve a admitir sesiones
sin revocación. No se rotan claves ni se toca IAM/red para este bloque local.

## Evidencia aislada

`access_sessions_mysql.integration.js`: migración real en mysqld propio sin TCP,
renovación concurrente, fallo de outbox, revocación tras reinicio, carrera con
contraseña, claim/signup y REST/Socket.IO reales con datos ficticios. Diez
comprobaciones en `sessions-mysql.log` y resultado privado de su fixture.
Pruebas frontend ejercitan el servicio real transpilado; Chromium usa el
componente real de logout y traducciones con respuestas ficticias, desktop/móvil.
Build de desarrollo fuera de rutas servidas; sin source maps. Un primer intento
agotó heap de Node; se repitió con 6 GiB y dos workers en el proceso QA.
Evidencias consolidadas en `sessions-offline-qa.json` y publicación en
`sessions-publication.json`, fuera del repositorio y de rutas públicas.
