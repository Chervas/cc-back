# Corte administrativo desplegado y relevo para importación

El usuario aprobó el primer corte de sesiones administrativas y recuperación,
su publicación y el relevo posterior a otro Codex. Se ejecutó el 13/09/2026 entre
22:16:30 y 22:17:45 UTC: 14/09/2026 entre 00:16:30 y 00:17:45 Europe/Madrid.
**MFA por correo y reconexión WhatsApp siguen pendientes; no están activados.**

## Versiones del código instalado

| Destino | Rama / referencia | Commit de código |
| --- | --- | --- |
| Backend DEV | `dev` | `1fa5357fb925049672b47295cd2da061379bf4ff` |
| Backend staging | `staging` | `3607ea09e6c67500bb1afb10df5f47aff8555c00` |
| Gateway | `security/admin-session-gateway-20260913` | `acd1fd741159edb86871612b473df3aaf6c91816` |
| Frontend DEV, fuente | `dev` | `075faf5a4bcc1a736801e7face8e2d171f585788` |
| Frontend staging, publicado | `staging` | `49a9c3dd3743f94e39e84af4cf83815dfacf75d2` |

Los commits posteriores de documentación en DEV no requieren otro reinicio.
La fuente frontend DEV está publicada en Git; no se ha sustituido el preview
estático DEV como parte de este corte público.

Gateway conservó su base `4cf8e23e`, que era anterior a `ac1b1dd8` de staging.
Se publicó su corte en una rama de despliegue explícita para evitar incorporar
los cambios de automatizaciones/WhatsApp/importación intermedios. No hacer
`pull origin staging` ni cambiarle de rama sin revisar el siguiente corte.
La rama no cambia su namespace ni su función de entrada externa.

El hotfix de `src/controllers/socialstats.controller.js` quedó versionado en
ambos cortes públicos, conservando sus bytes. SHA256:
`0d14de2cb70b183e35e88f4561a48e190fc164c8bcb0628021e727f48770b8c5`.
Los otros siete archivos backend coinciden con los candidatos probados. Solo
tres archivos funcionales del frontend se incorporaron al público.

## Comportamiento y comprobaciones

- Los administradores globales necesitan JWT vinculados a sus credenciales
  actuales. Sus JWT antiguos ya se rechazan en HTTP, renovación y Socket.IO.
  Cambiar la contraseña invalida los nuevos JWT vinculados. SQL indisponible no
  concede acceso administrativo. Se elimina el hash de contraseña del login público.
- La recuperación se puede abrir aunque el navegador conserve una sesión.
  Tras confirmar el cambio se limpia esa sesión y se reemplaza la URL por
  `/sign-in`. Un error de recuperación permanece en el formulario.
- Reinicios, uno por proceso: DEV respondió a los 4,077 segundos, staging a los
  4,071 y gateway a los 4,898. Son tiempos hasta observar HTTP 401 con una petición
  sin autenticación, no una medición continua de todas las peticiones afectadas.
- Se conservaron los hashes de `.env` y del entorno de overrides PM2 y los flags
  inventariados. DEV y gateway mantienen worker/cron en `false`; staging conserva
  ambos en `true`. Los gates de campañas/resume DEV continúan pausados.
- Doce comprobaciones HTTP locales rechazaron JWT sintéticos administrativos
  sin la prueba nueva. Tres comprobaciones HTTPS los rechazaron en CRM,
  autenticación y app; tres conexiones WebSocket se rechazaron. Los JWT sintéticos
  no se guardaron ni imprimieron. No se usaron sesiones antiguas del incidente.
- Los tres procesos permanecieron online, con un solo reinicio adicional cada
  uno. Antes del corte había cero JobRequests en ejecución y 18 pendientes.
- QA previo: 51 pruebas backend, 11 frontend, HTTP/Socket.IO sobre candidatos,
  MySQL aislados de sesión/rotación, build de producción y cuatro capturas
  Chromium de recuperación escritorio/móvil con API ficticia.

CRM sirve `main.132436ec280e1389.js`. El SHA256 de su `index.html` es
`d99552f568d49f9a7401b3f86ed980545b774bddc76b6c0e20c6060ae9490e99`.
Se verificó por HTTPS el mismo index en `/index.html`, `/reset-password` y
`/sign-in`, y el hash del bundle. Se conserva `no-cache, no-store,
must-revalidate`. La publicación se hizo mediante intercambio atómico de
directorios, reteniendo 109 assets antiguos con hash para las pestañas abiertas.
No hubo recarga de Nginx, DDL, cambio de configuración, envío de correo desde
herramientas ni habilitación de integraciones. Los workers ya autorizados de
staging conservaron su operación normal; el canary no ejecutó jobs de negocio.

## Continuidad para el siguiente Codex

Puede continuar su encargo de importación de pacientes desde DEV. Leer primero
este acta y el handoff frontend; comprobar HEAD/diff/fetch antes de editar o
publicar. La importación no autoriza una promoción completa de DEV a staging,
ejecutar todas las migraciones pendientes ni activar consumidores DEV.

Mantener los cambios de seguridad presentes en DEV al resolver conflictos con
el público. Ejecutar `npm run test:security:auth-cut` en ambos repositorios si
se toca autenticación; para el resto, aplicar el QA propio de la importación.
No hay una protección remota automática que sustituya la revisión del corte.
Ver [conservación al promover DEV](admin-password-session-cut.md#conservación-al-promover-dev-a-staging).

No volver a rotar las contraseñas: la operación solicitada sobre IDs 1 y 44 ya se
completó, y el usuario recuperó después su cuenta desde CRM. Tampoco reenviar
el correo DEV obsoleto: EmailMessage 162 y JobRequest 85544 están cancelados,
con historial conservado. La cuenta elegida para la futura prueba manual sigue
siendo `carlos@clinicaclick.com`; no recopilar su contraseña ni códigos.

El corte MFA requiere las cinco DDL concretas, configuración de correo/clave,
entrega de auditoría y alcance descritos en
[pendientes del MFA](admin-password-session-cut.md#preparación-del-mfa-completo-y-pendientes-reales).
Las cuatro tablas nuevas siguen pendientes en BD compartida. DEV y público
comparten actualmente identidad SQL, UID y parte de las claves: el aislamiento
operativo sigue sin acreditarse. No reconectar Meta/WhatsApp ni reutilizar
credenciales revocadas. OPS puede permanecer apagado y no es dependencia.

## Respaldo y rollback

Evidencia privada: `/home/ubuntu/qa-evidence/security-migration-20260912/admin-session-deploy-20260913/`.
Contiene copias de los archivos sustituidos, build anterior y manifiestos de
hashes, configuración saneada, tiempos y comprobaciones. No publicar esa carpeta.

El frontend puede volver a su build previo si se necesita, sin deshacer el
cierre del backend. En backend no restaurar un verificador que acepte JWT
administrativos antiguos: reparar hacia delante o detener el proceso afectado,
conservando contraseñas rotadas, hotfix, recibos y pausas. La prueba manual de
login real queda pendiente del usuario; el MFA público no se presenta como listo.

Terminada esta entrega, el agente de seguridad se detiene para ceder el espacio
de trabajo al Codex de importación, hasta que el usuario lo retome.
