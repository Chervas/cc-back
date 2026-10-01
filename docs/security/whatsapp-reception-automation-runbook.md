# WhatsApp: recepción, automatizaciones y capacidad

Runbook operativo del recorrido vigente en staging. Complementa el contrato de
[broker y mensajería](whatsapp-broker-messaging.md), el de
[autorización](whatsapp-authorization-state.md) y la documentación de producto
[14.1](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/14.1-whatsapp-integracion-meta.md).
Una conexión autorizada, un webhook recibido y un mensaje entregado son hechos
distintos. No inferir uno a partir de otro.

## Recorrido y propietarios

1. Meta envía un POST firmado al gateway. El gateway transmite los bytes
   originales al inbox AWS por TLS mutuo; no interpreta el contenido ni posee
   la credencial operativa de envío.
2. `clinicaclick-whatsapp-inbox.service` verifica firma, app y ámbito
   WABA/teléfono, cifra el lote completo en SQLite con AES-256-GCM y escribe
   auditoría durable. Solo entonces responde 200. Un 200 acredita custodia,
   **no** importación clínica ni ejecución de una automatización. Si no puede
   conservarlo, responde error reintentable; nunca confirmar por comodidad.
3. `clinicaclick-whatsapp-inbox-consumer.service` consulta `/pending`, arrienda
   recibos y los importa mediante una transacción SQL en CRM. Confirma el recibo
   AWS solo tras el commit. Un fallo conserva ciphertext y recibo; `/defer`
   registra la razón y aplica espera exponencial. El pulso
   `/run/clinicaclick-whatsapp-inbox-health/health.json` se publica cada sondeo.
4. `whatsappFreshInbound.service.js` comprueba binding, recibo importado, corte
   temporal por número, antigüedad, deduplicación y marcas de recuperación.
   Encola `automation_inbound_dispatch`; no entrega históricos ni ecos del
   móvil al motor. Que QuickChat muestre el texto solo acredita importación.
5. El job nativo reclama la respuesta una vez y reanuda la espera de la
   automatización. `condition/ai_analysis` usa el broker Bedrock, con salida
   estructurada y revisión manual ante error. `action/change_status` y el
   mensaje saliente son pasos posteriores distintos.
6. El envío autorizado verifica de nuevo clínica, destinatario, cita, estado,
   remitente, plantilla aprobada en **esa** WABA, pausas, cuarentena y
   `messageNotBefore`. La identidad de envío deriva de `Message.id`. Una
   respuesta HTTP incierta se concilia: no se crea otro mensaje para reintentar.
   Los estados de entrega de Meta se importan aparte.

El broker de credenciales y el inbox no son el motor de automatizaciones. API,
inbox AWS, importador, dispatcher y worker de jobs son despliegues separados;
un push o reinicio de la API no actualiza los demás. Los flujos existentes
conservan su versión. Las respuestas recuperadas con
`recovery_without_automation` actualizan el chat pero no se reproducen en IA.

## Prioridad y barreras

`GET /pending` entrega hasta 20 recibos: primero nuevos, dando precedencia a
`messages`, y reserva como máximo una quinta parte para reintentos que ya
vencieron, con una sola plaza para `review_required` o `unsupported_event`.
Los reintentos recuperables siguen cada 1-60 minutos; las revisiones sin una
acción nueva esperan 24 horas. Los reintentos se ordenan por último intento; un recibo antiguo o
una caída del consumidor no puede monopolizar el lote. `review_required`,
`unsupported_event` y `unmatched_status` nunca equivalen a silencio del
paciente. Un lote mixto que contenga una respuesta real conserva la barrera.

La salud tiene dos dimensiones: `oldestPendingAt` mide atraso ordinario;
`blockingReview` conserva conflictos de contenido/ámbito. Los contactos
atribuibles se aíslan mediante claves SHA-256, sin teléfono ni texto en el
pulso; lo no atribuible conserva bloqueo general. Si el pulso falta o supera
90 segundos, los timeouts esperan y vuelven a comprobar al minuto. Un
timeout atrasado no manda seguimientos obsoletos ni cancela citas a ciegas.

El inbox tiene límites explícitos de filas, bytes cifrados y auditorías
pendientes. El broker los publica en `health.capacity`; el importador los
propaga sin contenido clínico. La notificación
`whatsapp.inbox_capacity_warning` avisa al alcanzar 75% de **cualquiera** de
los tres límites y emite un aviso crítico
independiente `whatsapp.inbox_capacity_critical` desde 90%, incluso sin un
remitente activo. Así la espera entre avisos no oculta la escalada. Si se
agota un límite, el webhook deja de confirmar para permitir reintentos de
Meta. El archivo externo está activo desde el 01/10. Con `recoveryArchive`
habilitado, un 200
requiere copia S3 cifrada verificada; `archive.pending`,
`archive.untaggedImported` y la alerta de dos minutos comprueban atrasos aun
cuando la importación CRM esté al día. El ensayo de reconstrucción completa
sobre el inventario real aún debe cerrarse antes de considerar validada la
recuperación. Una copia o etiqueta fallida espera
por recibo de uno a sesenta minutos sin monopolizar el barrido. La
apertura del listener exige primero respaldar el manifiesto de clave envuelto
por KMS en `meta/<keyId>.json`; restaurar requiere ese manifiesto y la misma
clave KMS, nunca generar otra. La
limpieza local exige importación, copia y etiqueta S3, más 24 horas. Los
objetos importados expiran a los ocho días; los no importados no expiran
automáticamente. La restauración e integridad con datos sintéticos ya se probó.
No borrar filas de SQLite ni aumentar límites sin
comprobar espacio, auditoría y recuperación.
El restaurador estricto se detiene ante cualquier objeto ilegible o de otra
aplicación. Solo un manifiesto privado opcional con clave S3, ETag, versión y
SHA-256 exactos permite excluir un objeto **ya importado** que no sea JSON o
que declare otra App ID. El operador debe verificar fuera del restaurador que
no existe recibo clínico en CRM y registrar la exclusión. Un sobre válido de
ClinicaClick o un recibo pendiente no son excluibles. El 01/10 se localizaron
dos artefactos sintéticos: 64 bytes no JSON y un sobre `appId=101`; ambos
marcados importados y sin recibo en CRM. No borrar esos objetos ni relajar el
restaurador para omitir otros fallos.
Si el primer despliegue de `ops/security/whatsapp-inbox-recovery.yaml` dejó el
bucket retenido tras un rollback, importar **ese mismo bucket** con
`ops/security/whatsapp-inbox-recovery-import.yaml` y revisar el ChangeSet antes
de ejecutarlo. La importación no aplica las propiedades de seguridad; actualizar
después el stack con la plantilla completa y verificar cifrado, bloqueo público,
versionado, ciclo de vida, política y permiso del rol antes de habilitar
`recoveryArchive`. Nunca borrar el bucket retenido para repetir la creación.
El rol CloudFormation necesita las acciones IAM `s3:PutEncryptionConfiguration`,
`s3:GetEncryptionConfiguration`, `s3:PutBucketPublicAccessBlock` y
`s3:GetBucketPublicAccessBlock` sobre ese bucket. Los nombres de API
`PutBucketEncryption` y `PutPublicAccessBlock` no son permisos IAM válidos
para esas llamadas; comprobar la política efectiva antes del ChangeSet.
Durante un despliegue gradual, un broker anterior no publica `capacity`:
el importador la deja en `null` y no se emite una falsa alerta de capacidad.
La alarma solo queda operativa tras desplegar broker, importador y API.

## IA y carga

Las solicitudes de análisis de conversación pasan por
`bedrockBroker.service.js`: como máximo 3 inferencias concurrentes, 32 en
espera, 4 MiB acumulados en espera, 30 segundos de espera y separación de
300 ms entre inicios **por proceso**. No es un limitador distribuido; no se
deben levantar workers adicionales sin revisar el presupuesto conjunto.
El proveedor tiene timeout nominal de 20 segundos y solo errores propios de
Bedrock pueden activar el fallback. Un rechazo por cola, autorización,
secreto o auditoría no provoca una segunda inferencia. La receta de cita no
debe confirmar ni cancelar por un fallo de IA; conserva revisión manual.

Comprobar `AiUsageDaily` por fecha, modelo y `use_case`: peticiones, errores,
fallback y latencia. Correlacionar con `FlowExecutionLogsV2` de tipo
`condition/ai_analysis`, `JobRequests` de tipo
`automation_inbound_dispatch` y el pulso de recepción. Un total bajo de
errores de IA **no** acredita recepción: un webhook retenido nunca llama al
modelo. La cola de Bedrock es de admisión en memoria, no una cola durable;
los jobs nativos conservan el trabajo y las salidas clínicas seguras ante
fallos. Las transcripciones de audio usan un proceso de admisión distinto.

## Diagnóstico sin datos de pacientes

1. Comprobar la hora del pulso y el servicio AWS. Registrar capacidad, número
   de recibos por estado, motivo y `kinds`, y la fecha del más antiguo; no
   imprimir cuerpos descifrados, teléfonos, tokens ni claves.
2. Diferenciar `message_template_status_update` y
   `template_category_update` (eventos administrativos), `messages` (puede
   contener mensaje o estado), `smb_message_echoes` (eco saliente) y `history`
   (recuperación). Un `review_required` no prueba una respuesta perdida.
3. Para una conversación concreta, seguir recibo AWS -> `WhatsappInboxImports`
   y `WhatsappInboxMessageKeys` -> `Messages.metadata` -> claim/job ->
   `FlowExecutionLogsV2` -> cambio de cita -> `Message.id` saliente -> recibo
   y estado Meta. Respetar siempre clínica, WABA y `phoneId`.
4. Leer los códigos técnicos del importador. Desde esta revisión,
   `WHATSAPP_INBOX_POLL_UNAVAILABLE` distingue transporte de `/pending`,
   HTTP no 200, respuesta inválida y fallo de publicación de salud, sin
   devolver payloads. Los errores anteriores a ese cambio solo permiten
   afirmar que el sondeo falló, no cuál fue su causa.
5. Nunca liberar, confirmar o reproducir en bloque `review_required`.
   Clasificar cada familia y resolver el contrato o binding que corresponda;
   mantener los HOLD de importación y los cortes de recuperación. Un envío
   `whatsapp_delivery_unknown` tampoco autoriza un segundo POST.

## Corte y verificación

Publicar primero el broker AWS y verificar versión, hash, TLS, servicio y
`/pending` sin extraer contenido. Publicar después importador/pulso, API y
dispatcher, manteniendo el corte de recuperación. Observar al menos un evento
nuevo que pase de custodia a importación y, cuando proceda, a job/ejecución;
no usar un lote histórico como prueba de automatización. Verificar un envío
solo con autorización explícita y remitente/pago operativos.

Para rollback, restaurar la release anterior y el drop-in de systemd del
servicio afectado; conservar SQLite, recibos, auditoría y cortes. Una
reconexión de WABA no sustituye una prueba de importación. La ausencia de
mensajes nuevos durante la ventana de observación deja la validación extremo
a extremo pendiente, aunque todos los tests offline pasen.

## Fotografía del 30/09/2026

Inspección agregada a las 17:24 UTC: 18.758 recibos importados y 1.329
arrendados/pendientes en AWS. De 934 `review_required`, 746 eran actualizaciones
de estado de plantillas, 30 cambios de categoría, 114 lotes `messages` y 44
ecos del móvil; los últimos 158 requerían clasificación individual, no ACK
masivo. Los eventos de mensajes/eco retenidos databan del 15 al 29/09;
no había nuevos `review_required` de esas dos familias el día 30 hasta esa
hora. El pulso de staging de las 18:56 UTC estaba fresco y sin bloqueos
generales; conservaba contadores de revisión histórica.

Los logs del importador registraron 3.605 sondeos fallidos entre 00:00 y
05:00 UTC. El formato antiguo ocultaba la causa, por lo que no se atribuye
sin evidencia a Meta, certificados o red. Tras la recuperación se importaron
832 eventos `messages` y 500 ecos ese día hasta la inspección. En CRM,
`AiUsageDaily` mostró 19 análisis Nova Lite correctos y cero errores; 410
jobs de despacho entrante de las últimas 24 horas estaban completados.
También hubo 23 fallos de salida `whatsapp_config_missing` en Vitaldiet, que
carecía de configuración WhatsApp operativa, y uno
`whatsapp_delivery_unknown` en otra clínica. Esos fallos de salida no son
saturación de Bedrock ni prueba de pérdida de recepción.

La auditoría de jobs encontró 415 claims frescos del día completados, con
415 mensajes marcados como despachados, y 12 jobs pendientes desde el 03 al
10/09 en el namespace antiguo `gateway`. Tienen cero intentos y no pertenecen
al worker `staging` vigente. No promoverlos ni cambiarles el namespace para
"vaciar la cola": antes se debe conciliar cada conversación, corte de
recuperación y estado de cita, sin generar acciones retrospectivas.

## Verificación del 01/10/2026

La sesión SSO de mantenimiento no-root abrió Session Manager y su marcador
apareció en CloudWatch Logs. La lectura S3 se limitó al archivo y a la clave
KMS de payload. Una instantánea en memoria de 20.536 objetos se restauró a una
SQLite privada nueva: 20.534 recibos, de los cuales 19.194 `imported` y 1.340
`held`; `PRAGMA integrity_check=ok`. Se excluyeron explícitamente dos objetos
sintéticos ya importados, fijados por clave, ETag, versión y SHA-256. La SQLite
temporal se eliminó. No se detuvo el receptor y los objetos nuevos que llegaron
después del inventario no se incluyeron; una recuperación real requiere un
inventario estable con el receptor detenido.

En staging, la tabla `WhatsappInboxAdminSync` y el permiso `SELECT,INSERT` del
usuario SQL restringido estaban preparados antes de activar el interruptor.
El importador usa el release `admin-sync-b0bc4fc6-20261001` por drop-in de
systemd; `WHATSAPP_INBOX_ADMIN_SYNC_ENABLED=true` está presente en ese servicio
y en la API de staging. Para rollback, poner el interruptor a `false`, reiniciar
los dos procesos y volver al `WorkingDirectory` anterior, sin borrar tabla,
recibos ni filas conciliadas.

Un webhook nuevo de aprobación de la plantilla técnica de BS Capilar, Meta ID
`1990184844992231`, entró a las 08:13 UTC. La verificación del payload
descifrado en memoria confirmó `message_template_id` y `APPROVED`; el recibo S3
quedó etiquetado `imported`. Se insertó y después se concilió una fila
administrativa a las 08:14:24 UTC. La plantilla local estaba `APPROVED` a las
08:14:15 UTC. No hubo fila clínica en `WhatsappInboxImports` ni job de despacho
de automatización para ese recibo. A las 08:09 UTC, los 748 avisos históricos
de estado y 30 cambios de categoría tenían cero reintentos elegibles; el
primero vence a las 22:44 UTC por el `defer` de 24 horas. No adelantar ni
confirmar estos recibos manualmente.

El receptor AWS pasó de `release-archive-e297c7cd` a
`release-archive-progress-a0402a4c-20261001` mediante un drop-in nuevo
`zzzzzzzz-archive-progress.conf`. Se copiaron únicamente
`whatsapp-inbox.js` y `whatsapp-inbox-scopes.js`, cotejando SHA-256 de origen
y destino, y se verificó sintaxis con el usuario del servicio. Los 52 tests
del inbox pasaron antes del reinicio. Después, el servicio quedó `active`, sin
errores de journal y con pulso fresco que incluía `lastArchivedAt` y
`lastTaggedAt`; archivo, etiquetado y auditoría tenían cero pendientes. En CRM
entraron nueve recibos nuevos, dos con mensaje y ambos despachos completados.
Para rollback, desactivar solo ese drop-in, hacer `daemon-reload` y reiniciar
el servicio; conservar ambos releases y toda la SQLite. La columna aditiva
`restored_at` no requiere reversión. No se ha provocado un fallo real de S3,
por lo que la escalada de la alerta ante fallo sigue sin prueba operativa.

La inspección privada de las 08:37 UTC verificó en memoria los 1.356 sobres
retenidos: 778 avisos de plantillas, 294 `played`, 103 ediciones, 92 borrados
y 89 estados de entrega/lectura. Ninguno contenía un texto o audio nuevo
pendiente del motor. 159 correspondían a ámbitos antiguos; no reparar esos
ámbitos automáticamente ni cambiar citas a partir de controles de mensaje.
La auditoría de la hora anterior entregó 494 eventos con p95 0,99 s y cero
pendientes.

El registro pasivo de `played` requiere la migración
`20261001085000-whatsapp-inbox-playback-imports.js`, `SELECT,INSERT` sobre
`WhatsappInboxPlaybackImports` para el usuario restringido y
`WHATSAPP_INBOX_PLAYBACK_ENABLED=true` en el importador. Aplicar únicamente
esa migración; no ejecutar las pendientes ajenas. La API no necesita el flag.
La ruta confirma solo lotes puros y con titularidad vigente; no escribe
mensajes, conversaciones ni jobs. Los 268 lotes archivados de ámbitos
actuales pasaron el parser en una comprobación de solo lectura. Para rollback,
desactivar el flag y volver al release previo del importador; conservar la
tabla y sus recibos, sin modificar la SQLite AWS.

La prueba `whatsapp-inbox-recovery-alerts.test.js` conecta receptor, SDK S3 y
colector de alertas con un transporte local aislado que falla y se recupera.
Verifica 503, recibo conservado, aviso sin contenido, archivo único, marcado
obligatorio antes de limpieza y deduplicación tras limpieza. No se ha
provocado un fallo del bucket productivo ni un envío de correo de prueba.
