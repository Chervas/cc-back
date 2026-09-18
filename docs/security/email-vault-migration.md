# Correo SES mediante vault y operación tipada

Estado 2026-09-18: implementación preparada y pruebas aisladas aprobadas. No se
ha creado un runtime SES en AWS, trasladado su credencial, activado consumidores
ni enviado correos reales en este corte. El correo de acceso sigue usando el
transporte anterior. Complementa [el contrato de acceso](meta-email-stage1.md).

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

Red externa y BD bloqueadas durante QA. TLS, firmas, SQLite y serialización/firma
del SDK son reales locales; SES, vault, S3 y modelos de app son ficticios. Una
prueba anterior de eventos intentó MySQL: el guard la detuvo. Se corrigió su
fixture/transacción y se conservó el log fallido; no se cuenta como prueba real.

## Antes del corte

1. Preparar unidades, usuarios Unix, vault, identidades DEV/staging separadas,
   red restringida, memoria y renovación TLS. No usar SSO administrativo para SES.
2. Instalar dependencias en una release independiente: cambió el lock del broker.
   El publicador DEV exige preparar dependencias; no eludir su guard. Backend
   DEV continúa en `ff0d9a85`, sin esta implementación activa.
3. Inventariar todos los productores/workers, cohortes/allowlist/plantillas,
   tamaños y concurrencia. Marketing y email genérico siguen apagados. Verificar
   ráfagas y latencia antes de caducidad de códigos: probar dos plazas no acredita
   carga real ni cuota SES. Congelar entrada durante el cambio para no mezclar
   intentos directos/broker del mismo mensaje.
4. Canary con buzón QA expresamente autorizado: contraseña→correo→código,
   reenvío, caducidad, reset, eventos/recibos S3, aislamiento y UI autenticada.
   Sigue pendiente la cuenta de QA de la pregunta previa.
5. Solo tras corte verificado, retirar la clave de todos los procesos que la
   heredan, incluido fresh-inbound si conserva el entorno staging. No reenviar
   históricos/resultados inciertos. Sustitución y rotación de claves aplazadas.

Recuperación de esta preparación: mantener flag apagado y release activa. Tras
un corte real, detener nuevas salidas y conciliar outbox/eventos/ledger; no
activar directo como fallback, borrar ledger ni repetir inciertos. MFA/sesiones
siguen exigidos. El objetivo global de seguridad conserva sus demás pendientes.
