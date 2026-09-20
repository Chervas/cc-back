# Correo SES mediante vault y operación tipada

Estado 2026-09-20: transporte broker activo en la API CRM y en el worker de
seguridad DEV; ambos servicios SES AWS habilitados al arranque. Un aviso autorizado
desde la interfaz CRM queda entregado por SES y conciliado en el outbox. Sus dos
recibos S3 se verifican por versión/SHA256/KMS. Siguen pendientes la aceptación
MFA posterior al corte, el recorrido DEV y la retirada de copias locales.
Complementa [el contrato de acceso](meta-email-stage1.md).

## Transporte y separación

`email.ses.send.v1` se sirve desde `email-main.js`, en un proceso separado de
WhatsApp, Google, OCR/audio y Bedrock. Audiencia `clinicaclick:email:<entorno>:v1`,
principal/conexión `email:<entorno>`, tenant `platform:<entorno>`. Cada runtime
admite una conexión y una identidad; DEV solo permite las dos plantillas de
autenticación. Gateway sigue encolando hacia staging y no recibe claves SES.

El envelope `{version, provider: "aws_ses", connectionRef, credentials}` se lee
del vault bajo `.../<dev|prod>/email/ses/`, comprobando ARN, KMS y versión actual.
El SDK SES 3.1131.0 pertenece al paquete aislado, sin cambiar el SDK de la app.
Usa credenciales explícitas, región `eu-west-3`, HTTPS y ruta fija
`POST /v2/email/outbound-emails`, nunca una cadena de credenciales por defecto.

Contrato cerrado: un destinatario, remitente/reply-to y configuration set
autorizados, asunto/texto/HTML UTF-8 y etiquetas existentes. Sin adjuntos,
Raw/MIME, CC/BCC, cabeceras arbitrarias, endpoints ni marketing. Se conserva
exactamente el cuerpo nativo de las cinco plantillas, incluida una automatización
ficticia mayor de 32 KiB. Su contrato no activa email genérico ni el producto OPS.

Límites: petición 256 KiB (margen conservador de 2048 bytes para el sobre), dos
peticiones concurrentes, reserva agregada 512 KiB, respuesta SES 8 KiB, timeout
SES máximo 20 s y un intento SDK. Se rechaza exceso sin truncar. El cuerpo del
correo atraviesa este proceso; no transporta archivos ni ocupa las plazas IA.

El consumidor comparte una admisión por proceso entre jobs críticos, normales
y manuales: una petición activa, hasta 16 esperando/1 MiB, diez segundos de
espera y al menos 300 ms desde que termina una petición hasta iniciar otra.
Esto incluye el tiempo de comprobación asíncrona de permisos; una comprobación
lenta no elimina la separación entre POST. Se comprueba el vencimiento con reloj
monótono antes de admitir, incluso si el temporizador se retrasa por CPU.
Exceso/caducidad **antes** de llamar al transporte permiten reintento del outbox;
no permiten hacerlo una vez enviado el POST. No es una cuota distribuida.

## Duplicados y resultado incierto

[SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
no incluye token de idempotencia del cliente. `MessageId` acredita aceptación;
el evento posterior determina entrega o rechazo definitivo.

El SQLite privado conserva dos registros:

- `commands`: digest y recibo por intento firmado. ID estable derivado de outbox
  opaco y `JobRequests.attempts`; sobre, nonce y firma son nuevos.
- `email_deliveries`: exclusión durable por entorno/outbox, compartida entre
  intentos e identidades rotadas. Guarda digest del contenido y resultado
  operativo, nunca destinatario, asunto, cuerpo, código ni URL.

Un aceptado devuelve su recibo sin otro POST, aunque cambie el intento. Un envío
en curso, interrumpido o ambiguo queda retenido tras reinicio. Cambiar contenido,
destinatario, plantilla, remitente, conexión o configuration set para el mismo
outbox produce conflicto. Solo `TooManyRequestsException` HTTP429 explícito de
SES permite un intento posterior reclamado por el outbox. Otros rechazos 4xx
tipados son terminales. Respuestas perdidas/malformadas, 5xx, timeouts, errores
del vault/auditoría y 429 del broker no permiten reenviar.

La aceptación se persiste antes del recibo genérico y sobrevive al fallo de ese
commit o a una respuesta posterior al timeout. Una finalización tipada con
`accepted:false` se audita como fallo. No se purgan comandos ni cambia retención.

## Acceso, consumidor y monitor

`EMAIL_BROKER_ENABLED=true` selecciona el transporte sin leer claves SES locales
ni volver a SES directo/mock. Exige región, identidad y configuración coherentes:
`EMAIL_BROKER_ENVIRONMENT`, `EMAIL_BROKER_ORIGIN`, `EMAIL_BROKER_AUDIENCE`,
`EMAIL_BROKER_CONNECTION_REF`, `EMAIL_BROKER_KEY_ID`, `EMAIL_BROKER_KEY_FILE` y
`EMAIL_BROKER_CA_FILE`. Origen HTTPS y archivos privados. Flag ausente conserva
la ruta anterior.

El worker sigue comprobando supresión, desafío vigente, cuenta activa, vínculo
de contraseña, caducidad y coincidencia exacta entre contenido y outbox cifrado.
Fuera de allowlist solo admite `registered-account` para autenticación. El
broker confía en esa comprobación del **worker firmante**; no consulta la BD ni
acredita por sí mismo la existencia de la cuenta/desafío. Su política limita
esa modalidad a las dos plantillas expresamente declaradas; para otros correos
exige allowlist. API DEV sigue produciendo jobs y su worker ya pasa el intento
reclamado a `runEmailSendJob`.

Al salir de la espera se comprueba otra vez que el mensaje sigue `sending`,
no está suprimido y su desafío/enlace siguen vigentes. La política de cuenta se
verifica sobre una copia del contenido anterior a la espera. Un evento de
entrega concurrente conserva su estado; una consulta fallida detiene el envío.

`email_provider_broker_unknown_outcome` es terminal sin reintento automático,
preserva el token de recuperación y permite conciliación posterior por evento
SES con `cc_outbox`. Un evento concurrente no se degrada al asentar el worker.
Monitor distingue configuración del broker de ausencia de claves SES locales.
`brokerConfigured` valida configuración declarada: no prueba vault, red ni entrega.

## Pruebas y límites de la evidencia

Logs privados en `qa-evidence/security-resume-20260917/`:

- `email-full-broker-regressions.log`: 541/541, incluidos los primeros 15 casos
  de correo. Después se añadió fallo de commit tras aceptación:
  `email-broker-tests-final.log`, 16/16.
- `email-consumer-regressions-final.log`: 66 aprobadas, cero fallos, una omitida
  (comparación opcional CloudFormation con especificación externa no suministrada).
  Cubre cifrado, cinco plantillas, MFA/reset, destinatarios, conciliación, monitor
  e idempotencia del outbox.
- `email-shared-client-regressions.log`: 27/27 Bedrock, IA y WhatsApp.
- `email-front-typecheck.log`: TypeScript sin errores; no es prueba visual.
- `email-vault/runtime-metadata.json`: snapshot sin secretos, 03:26 UTC.
  Staging y worker DEV conservan SES local, API DEV/gateway carecen de clave y
  flag broker ausente en los cuatro. MFA/sesiones `enforce`, jobs clínicos DEV
  apagados. Remitentes DEV/staging tienen distinto formato: conservar cada valor
  exacto en su política. Staging tiene cuatro destinatarios en allowlist, DEV cero;
  ambos mantienen la política de autenticación para cuentas registradas.

En esas suites, red externa y BD bloqueadas. TLS, firmas, SQLite y serialización/firma
del SDK son reales locales; SES, vault, S3 y modelos de app son ficticios. Una
prueba anterior de eventos intentó MySQL: el guard la detuvo. Se corrigió su
fixture/transacción y se conservó el log fallido; no se cuenta como prueba real.

## Instalación AWS y comprobaciones sin envío

Dos procesos sobre release `f74098ce`, con `npm ci` independiente: staging en
8451/UID986 y DEV en8452/UID985, heap96 MiB y MemoryMax192 MiB cada uno. Las dos
reglas SG solo admiten el host CRM/32. Habilitados al arranque el20/09, sin reiniciar esos servicios.
Estado, política, firma y certificado son propios de cada entorno. Staging
permite autenticación y las dos plantillas operativas existentes; DEV solo
autenticación. No se ha dado grant a `automation.generic` ni a marketing.

Slots `/clinicaclick/integrations/{prod,dev}/email/ses/key`, cifrados con la KMS
existente. Copia del par IAM efectivo, sin crear ni rotar claves: ambos pares
corresponden actualmente al mismo usuario SES staging. La nueva política IAM
solo añade Describe/Get del ARN exacto DEV al rol de EC2. No confundir usuarios
Unix/políticas separadas con roles IAM separados: comparten el rol de EC2.

Evidencias en `email-vault/`:

- `vault-probe.json`: lectura real de cada slot y STS con su credencial desde
  UID986/985, ARN/KMS/envelope válidos; claves/configuración Unix del otro
  servicio denegadas. No invoca SendEmail.
- `client-unix-isolation.json`: UID998 no puede leer ninguna firma; UID996 solo
  la de DEV y UID1000 solo la de staging. API DEV sigue sin clave de proveedor.
- `signed-denials.json` y `audit-receipts.json`: diez rechazos TLS/firmados
  (destinatario, remitente, plantilla, tenant y firma cruzada). Ocho denegaciones
  autenticadas tienen recibo S3 verificado por versión/SHA256/KMS; las dos firmas
  inválidas no se atribuyen a un principal. Cero comandos autorizados/envíos.
- `certificates-renew-{staging,dev}.json`: dos renovaciones reales, nueva hoja
  observada desde CRM y sin reiniciar los procesos de correo. Nueve identidades
  sanas; unidad endurecida del firmante termina correctamente. Claves privadas
  de servidores permanecen en AWS y CA privada permanece en CRM.
- `admission-regressions-final.log`: 59/59 (admisión, outbox, sistema de correo,
  política MFA/reset); incluye CPU que retrasa temporizadores, guard lento,
  supresión/entrega/caducidad durante espera. La reproducción anterior del
  temporizador falló y se conserva. `paced-runtime-regressions.log`: 16/16.
- Pruebas Python de publicador/firmante: 6+5, ejecutadas como root con CA
  ficticia. Las primeras ejecuciones sin root fallaron por permisos y no cuentan.
- Monitor actualizado para reconocer IA/Bedrock y ambos correos: 14/14 pruebas
  en DEV y staging. Solo esa corrección se publicó en staging (`38dfe7f8`), con
  cero jobs/envíos/flujos ejecutándose y colas activas vacías antes del reinicio.
  Flags protegidos y presencia de claves contrastados después; `/auth/me`401,
  otros procesos intactos. La comparación inicial del entorno PM2 completo
  falló; no se afirma igualdad de toda su metadata. UI/entrega de alerta pendientes.

SES declara cuota de14/s en la lectura de este corte. Una API staging y un worker
DEV son los consumidores inventariados; la admisión propuesta limita cada uno a
menos de3,34/s. Esto no acredita entrega real ni capacidad de todos los procesos
futuros. Los servicios nuevos consumen aproximadamente36/37 MiB en reposo; falta
medir una carga autorizada completa. El host tiene memoria compartida con los
demás servicios: los límites por proceso no prueban capacidad total.

## Secuencia y aceptación del corte

1. Revalidar las unidades, vault, identidades, red restringida y TLS preparados;
   comprobar capacidad bajo carga autorizada. No usar SSO administrativo para SES.
2. Preparación de dependencias completada para DEV: release `fcf5a080`, con
   instalación independiente del SDK SES, 2217 archivos cotejados con Git y
   las resoluciones existentes del lock sin cambios. El guard original del
   publicador se conserva. Se publicó después `343f6a57`, que añade defensas
   de espera IA y reutiliza esas dependencias sin modificarlas. Flag SES broker
   apagado: estar instalado no significa que haya cambiado el transporte.
3. Actualizar el inventario de productores/workers, cohortes y concurrencia
   inmediatamente antes del corte. Marketing y email genérico siguen apagados. Verificar
   ráfagas y latencia antes de caducidad de códigos: probar dos plazas no acredita
   carga real ni cuota SES. Congelar entrada durante el cambio para no mezclar
   intentos directos/broker del mismo mensaje.
4. Canary con buzón QA expresamente autorizado: contraseña→correo→código,
   reenvío, caducidad, reset, eventos/recibos S3, aislamiento y UI autenticada.
   El titular autorizó su buzón el20/09; la prueba humana de MFA está solicitada.
5. Solo tras corte verificado, retirar la clave de todos los procesos que la
   heredan, incluido fresh-inbound si conserva el entorno staging. No reenviar
   históricos/resultados inciertos. Sustitución y rotación de claves aplazadas.

Recuperación de esta preparación: mantener flag apagado y release activa. Tras
un corte real, detener nuevas salidas y conciliar outbox/eventos/ledger; no
activar directo como fallback, borrar ledger ni repetir inciertos. MFA/sesiones
siguen exigidos. El objetivo global de seguridad conserva sus demás pendientes.

## Publicación DEV del 18/09 04:31 UTC

Sobre la copia instalada pasan77 pruebas de app/admisión/monitor/aislamiento y
16 del runtime correo. El preflight comprueba18 tablas de seguridad, sin
migración ni cambios de modelos. La prueba efectiva bajo UID998 y restricciones
systemd accede solo a SQL/Redis DEV: rechaza tablas públicas, secretos del host,
Redis público, APIs staging/gateway, AWS ajeno y salida general. API DEV continúa
sin claves de proveedores; el worker conserva su transporte SES anterior.

Antes y después del corte: cero jobs en ejecución, correos en cola/envío, citas
y pacientes en la BD DEV. La primera comprobación usó por error `Citas` y paró
antes de modificar servicios; se corrigió al nombre real `CitasPacientes`.
Los dos archivos privados de configuración conservan su SHA256 y los procesos
públicos mantienen PID. MFA/sesiones enforce y jobs clínicos apagados.
`/api/auth/me` devuelve401 sin sesión. Evidencia `email-vault/dev-publication/`.

La publicación usa las unidades aisladas existentes y recuperación del enlace
de release, sin tocar PM2 público. Ante un problema de esta preparación con el
broker todavía apagado, volver a la release aislada anterior preservando sus
configuraciones; nunca restaurar el antiguo DEV compartido. Aceptación de envío
y UI autenticada permanecen pendientes.


## Corte de transporte del 20/09

Gateway recibe primero la conciliación del resultado incierto; después la API
CRM activa ocho parámetros `EMAIL_BROKER_*`, sin cambios de MFA, destinatarios,
pausas o DDL. DEV cambia únicamente la configuración de su worker existente y
lo reinicia con drenado; no se reinicia la API ni se habilitan jobs de negocio.
La API DEV sigue sin claves de proveedor ni de firma SES.

Aceptación parcial real: un clic en «Enviar prueba», con Email exclusivamente,
produce un único aviso autorizado. Se fija el título/texto de prueba en su POST
porque el formulario no ofrece esos campos; no se simula ninguna respuesta.
SES devuelve aceptación y después eventos `send` y `delivery`, conciliados tanto
en `EmailMessages` como en `SystemNotificationDeliveries`. Dos recibos externos
S3 comprobados y cero pendientes del broker. No demuestra MFA, recuperación,
carga sostenida ni el envío DEV; no se alteran las reglas globales de avisos.

Fuente CRM `498c75ec`, gateway `4416da8c`; DEV conserva su release `23d34d95`.
46 pruebas de correo,25 regresiones compartidas Bedrock/WhatsApp y dos de gateway
correctas; ambos preflight SQL de27 tablas compatibles. Evidencia privada:
`qa-evidence/security-finish-20260920/`. Diarios consumidos de publicación y DEV
bajo `/var/lib/clinicaclick-consumer-recovery/email-{crm,gateway,dev}-20260920`.
No volver a ejecutar esos publicadores ni reintentar el aviso ya entregado.
Las credenciales locales aún se conservan hasta cerrar la aceptación pertinente;
no hay fallback automático directo y no se ha rotado ninguna clave.
