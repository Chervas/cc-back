# Administradores: rotación y cierre de sesiones desplegados

Estado final del 13/09/2026 22:25:03 UTC: la rotación solicitada y el corte de código
que invalida los JWT administrativos antiguos están aplicados. La recuperación
frontend está publicada. El MFA por correo sigue pendiente de activación pública.
WhatsApp permanece fuera de este corte. Versiones, evidencia y relevo:
[acta del despliegue aprobado](admin-session-deployment-20260913.md).

## Operación real autorizada

A las 21:10:33 UTC (23:10:33 Europe/Madrid) se sustituyeron las contraseñas de
los dos administradores globales canónicos, IDs 1 y 44. La transacción verificó
las identidades inventariadas, el motor InnoDB y ambos cambios antes del COMMIT.
Cada reemplazo usa 48 bytes aleatorios y bcrypt con coste 12. No se conserva ni
entrega la contraseña aleatoria; el titular debe recuperar acceso desde su buzón.
No se modificaron cuentas de propietarios de clínicas. La revocación de enlaces
pendientes formó parte de la misma transacción: no había ninguno pendiente.

Recibo privado `admin-password-rotation-receipt.json`, operación
`7244fdc1-b4ed-49c1-89b3-2b688b724f6b`, en el directorio de evidencias de seguridad.
Solo contiene IDs, fecha, resultado y contadores. El script se niega a repetir
una operación con ese recibo, incluso ante COMMIT dudoso. No ejecutarlo de nuevo.
La contraseña nueva de recuperación que elija el titular no debe recopilarse.

**El código público anterior no vinculaba el JWT al hash de contraseña. Por eso
la rotación por sí sola no cerraba las sesiones antiguas.** El corte aprobado ya
instalado añade esa comprobación. El recibo de rotación conserva su estado
histórico; no se presenta la contención completa ni el MFA como terminados.

## Corte pequeño de código instalado

`adminCredentialSession` añade a los JWT legacy de administración global un
HMAC, con dominio separado, de ID/hash de contraseña/email y una versión de
contrato. Se comprueba la firma HS256, el vencimiento, la cuenta activa y sus
credenciales actuales. No se expone el hash de contraseña. Los JWT anteriores
sin prueba se rechazan antes de SQL; un fallo de SQL no concede acceso.
Renovar exige que la prueba siga correspondiendo al usuario recién leído, para
que una recuperación concurrente no se convierta en una sesión nueva mediante
un JWT viejo. Los usuarios sin administración global conservan compatibilidad.

Los candidatos cubren login, desbloqueo, renovación, invitación, middleware,
el verificador propio de clínicas y Socket.IO. Los sockets se comprueban en
conexión, cada paquete y cada cinco segundos; el vencimiento o la pérdida de
credenciales cierra también las salas de salida. En el camino público legacy
se elimina además `password_usuario` de la respuesta de login. El código DEV
ya usa una proyección cerrada de usuario.

| Destino | Base exacta del candidato | Artefacto |
| --- | --- | --- |
| API/worker staging | `ac1b1dd84231083fc8003fffbe5d507ac255a1b3` | [Parche staging](cuts/admin-session-staging.patch) |
| Gateway | `4cf8e23eadfaf9c96b816e6eb0dd9361a11dc51d` | [Parche gateway](cuts/admin-session-gateway.patch) |
| DEV | Commit propio de esta entrega, sobre `34806d1a62614afd0b42b1a1da0a3dc61f1db42e` | Helper y `accessSession.service`; no promover toda DEV al público. |

Cada parche recoge ocho archivos: siete cambios y la copia del hotfix ya
existente. SHA256 del hotfix:
`0d14de2cb70b183e35e88f4561a48e190fc164c8bcb0628021e727f48770b8c5`.
Los parches pasan `git apply --check` contra los worktrees públicos actuales
excluyendo `src/controllers/socialstats.controller.js`, cuyos bytes se conservan.
No aplicar un parche sobre otra base sin reconciliarla. Estos dos parches no
incluyen cambios de campañas, DDL, frontend, claves, variables, colas ni permisos Meta.

El complemento de recuperación frontend está preparado sobre la base pública
`341103cfb79f86655cb25a611971a95aa313a4e5`, en el candidato privado
`security-admin-session-front-20260913`. Su parche versionado es
`front-dev/src/Documentacion/cuts/password-reset-public.patch`: solo modifica
`app.routes.ts`, `auth.service.ts` y `reset-password.component.ts`. Permite abrir
el enlace de recuperación aunque el navegador conserve una sesión y, tras una
respuesta correcta, borra la sesión local y reemplaza la URL por `/sign-in`.
El token de un solo uso sigue validándose en el backend. Los errores permanecen
en el formulario. No incorpora el frontend completo de DEV ni activa MFA.

## Lote operativo aprobado y ejecutado

El siguiente procedimiento fue autorizado expresamente y ejecutado; los SHAs
instalados y resultados están en el acta enlazada arriba. No constituye una
autorización reutilizable para otro corte de MFA o integraciones.

1. Comprobar de nuevo HEAD/diff y guardar copias privadas solo de los siete
   archivos sustituidos; registrar también hashes de configuración y overrides
   sin sus valores. Mantener el hotfix. Revisar todo `origin/dev..HEAD` antes del
   push propio; el push no instala el código.
2. Instalar únicamente los parches revisados en staging/gateway, excluyendo el
   hotfix tras comprobar su hash. El servicio DEV necesita cargar también su
   nuevo verificador: dejar una API DEV accesible con el código anterior no
   cierra el acceso de los JWT robados a la BD compartida.
3. Reinicios acotados de `pm2-back-dev`, `pm2-back-staging` y `pm2-gateway`,
   conservando la configuración efectiva. No usar `--update-env` ni habilitar
   jobs/cron en DEV o gateway. Staging conserva sus workers autorizados. La
   ventana implica reconexión de sockets e interrupción breve de las peticiones;
   no se ha medido una duración real. No se invocan proveedores ni trabajos de
   negocio para comprobarla. No reiniciar servicios ajenos.
4. Publicar el build del complemento frontend, guardando antes una copia privada
   del build público y su manifiesto de hashes. Revalidar las tres rutas del
   parche sobre la base pública; el build de QA no autoriza copiar toda DEV.
   No requiere reinicio de Nginx ni cambio de proxy. Verificar carga de assets,
   formulario de recuperación y navegación con datos ficticios. Si falla, puede
   restaurarse solo el build frontend anterior; esto no revierte el cierre de
   JWT del backend. El formulario anterior no garantiza la redirección corregida.
5. Verificar configuración, listeners y rechazos de un JWT sintético sin prueba
   en cada entrada; sin reutilizar JWT reales antiguos. El usuario recupera la
   contraseña y prueba su acceso. Ningún paso autoriza Meta, WhatsApp ni Ads.
6. Si falla el canary, mantener cerrado el acceso administrativo y reparar sobre
   el candidato seguro, o detener el proceso afectado. No restaurar un verificador
   que vuelva a aceptar JWT antiguos. Conservar las contraseñas rotadas y los
   recibos; no hay rollback hacia contraseñas anteriores. Registrar cualquier
   interrupción y estado de las colas antes de continuar.

Coste del corte pequeño: no crea infraestructura ni envía correo por sí mismo;
añade una lectura de usuario por validación administrativa. No reemplaza el MFA,
la separación de claves/usuarios de sistema/SQL, ni la migración de credenciales
Meta. Una copia compartida de la clave de firma y de la BD sigue siendo un riesgo
que debe resolverse antes de declarar la reconexión segura.

## Recuperación solicitada por el usuario

La cuenta elegida para la prueba es `carlos@clinicaclick.com`. Está en la lista
de destinatarios permitidos de staging; la otra cuenta administrativa no está
en esa lista y necesita un lote de configuración antes de recuperar por correo.
No se amplió la lista ni se enviaron correos desde las herramientas del agente.

La primera solicitud del usuario, 21:29:05 UTC, creó EmailMessage 162 / job 85544
en namespace `dev`: quedó pendiente porque sus workers están pausados.
La segunda, desde `https://crm.clinicaclick.com/forgot-password`, creó
EmailMessage 163 / job 85550 en `staging` a las 21:36:07 UTC. Se registraron
envío y entrega SES a las 21:36:26 UTC, con destinatario comprobado por hash y
respuesta SMTP `250 2.0.0 Ok`. Remitente `no-contestar@clinicaclick.com`.
El usuario confirmó recepción y el enlace quedó consumido a las 21:46:18 UTC
(23:46:18 Europe/Madrid). No se recopilaron su contraseña nueva ni el token.
Al solicitar el segundo enlace se revocó el primero. El aviso de cola atascada
correspondía precisamente a ese primer intento: se cancelaron únicamente
EmailMessage 162 y job 85544 en una transacción, tras comprobar que el enlace
estaba revocado y que el posterior se había usado. Recibo privado
`cancel-superseded-reset-162.json`; se conserva el historial. No se movió el job
DEV ni se reactivaron sus consumidores. Esta recuperación completada no prueba
un login con doble factor, que sigue sin desplegar.

La URL del correo se verificó en memoria: origen CRM y ruta `/reset-password`
correctos. La causa exacta de la primera pantalla observada por el usuario no
quedó demostrada; su segundo intento funcionó sin despliegue. La ruta estaba
dentro de `NoAuthGuard`, lo que sí podía desviar una recuperación con sesión
guardada. El complemento descrito arriba elimina esa dependencia y cumple su
petición de volver al login tras el cambio. Quedó publicado en este corte.

Nginx observado: `crm.clinicaclick.com/api/` apunta a staging 3001;
`app.clinicaclick.com/api/` y autenticación externa a gateway 3000.
El gateway observado tiene el fallback de URL de recuperación localhost y no
debe usarse para este canary sin revisar su configuración. DEV usa su proxy 3004.

## Conservación al promover DEV a staging

DEV es la fuente versionada de esta entrega. El helper administrativo y su
integración en `accessSession.service`, la recuperación y las pruebas se
publican en los respectivos `origin/dev`. Los parches legacy públicos son una
adaptación a sus bases anteriores, documentada en ese mismo commit; no una
corrección que exista únicamente en staging. El corte público quedó también
registrado en commits de staging y de la rama explícita del gateway,
preservando el hotfix y anotando los SHAs realmente desplegados en el acta.

Antes de cada promoción que afecte a autenticación:

1. Comparar el candidato con el último manifiesto público aprobado, conservar
   las correcciones de seguridad y revisar el diff completo. Resolver conflictos
   por comportamiento, sin sobrescribir staging con todos los archivos de DEV.
2. Ejecutar `npm run test:security:auth-cut` en backend y frontend. El contrato
   comprueba rechazo de JWT administrativos antiguos, cambio de contraseña,
   renovación concurrente, MFA y recuperación/navegación. Para cambios de esquema
   o del verificador, repetir además los MySQL aislados y el canary del candidato
   aplicables al corte. Estos comandos quedan disponibles en `package.json`;
   no se afirma que una protección remota de rama los ejecute automáticamente.
3. Conciliar por separado las DDL aprobadas y la configuración de MFA, sesiones,
   auditoría y correo. Una copia de código no instala migraciones ni configura
   claves. No degradar modos activos para hacer pasar un despliegue.
4. Conservar los roles de ejecución: staging opera sus workers autorizados,
   gateway solo las entradas externas y DEV sus pausas. Las credenciales y los
   permisos operativos no se trasladan a DEV al promover o sincronizar código.

La configuración compartida observada más abajo sigue siendo un pendiente real;
estos controles de promoción no sustituyen el aislamiento de identidades.

## Preparación del MFA completo y pendientes reales

Hay tres worktrees privados `security-email-login-{back,gateway,front}-candidate-20260913`,
con el login y sus dependencias separados de publicidad. No contienen `.env` y
sus dependencias enlazadas son únicamente para QA. La inspección de metadata
por socket local confirma que faltan las tablas `AuthSessions`,
`AuthEmailChallenges`, `PlatformAuditEvents` y `PlatformAuditDeliveryStates`.
Las DDL exactas pendientes para ese candidato son:

- `20260912210000-create-platform-audit-events.js`.
- `20260912213000-create-platform-audit-delivery-states.js`.
- `20260912220000-create-auth-sessions.js`.
- `20260913003000-add-platform-audit-result-part.js`.
- `20260913130000-create-auth-email-challenges.js` (DDL múltiple no atómica).

Las migraciones existentes de correo/reset y JobRequests sí figuran aplicadas.
No se ejecutó DDL compartida. No habilitar MFA global mientras la lista de
correo solo permite cuatro destinatarios. Falta definir y aprobar su alcance
sin liberar correos de otras colas. Faltan también la clave MFA privada,
entrega/conciliación externa de auditoría y su identidad/runtime autorizados:
sin vaciado, el límite de una hora cerraría la emisión de sesiones.

La configuración observada de DEV y staging comparte UID, identidad de BD,
JWT_SECRET y clave de cifrado de correo. La comprobación compara valores en
memoria y solo guarda booleanos; combina `.env` actual y entorno de arranque,
sin afirmar que sea un volcado de configuración efectiva dentro de Node.
El aislamiento no queda demostrado por cambiar nombres de namespaces.

QA del corte pequeño: seis pruebas del contrato, pruebas HTTP/Socket.IO de
ambos candidatos y seis grupos de comprobaciones con MySQL propio para rotación
atómica, rollback y COMMIT incierto. Regresión backend: 51 pruebas correctas.
Recuperación frontend: 11 pruebas correctas, build de producción correcto y
Chromium sobre el Angular compilado, con API interceptada y sesión ficticia:
dos recuperaciones correctas, redirección al login y cuatro capturas de
escritorio/móvil. El build conserva avisos de tamaño, temas Material y CommonJS.
El candidato MFA tiene además MySQL propios de código/sesiones/auditoría,
14 pruebas del writer, siete de frontend, build Angular y 18 capturas Chromium
escritorio/móvil. Los proveedores de QA son ficticios. El envío del usuario
descrito arriba es evidencia real independiente y no valida todavía el MFA.
El build y las 18 capturas del candidato MFA completo son anteriores al último
complemento de recuperación; sus hashes actualizados no equivalen a un nuevo
build completo. El manifiesto privado distingue esa limitación.
