# Automatizaciones con IA: conservación del contexto durante la migración

> **Tipo:** runbook de aceptación y recuperación.
> **Fuente de verdad:** alcance de pruebas, corte Bedrock y límites por consumidor.
> **Última revisión:** 2026-09-20.
> **Relacionado con:** [vault IA](ai-vault-migration.md).

Revisión 2026-09-20. Complementa [el runbook IA](ai-vault-migration.md).
**La API CRM ya usa Bedrock por el broker, con los mismos modelos y prompts.**
Su clave de proveedor se retiró de `.env` y del arranque PM2 persistido.
Gateway/fresh-inbound aún conservan copias anteriores; no se declara completada
la custodia de todos los consumidores ni la migración de Groq/OpenAI/Gemini.

## Corte CRM y aceptación del 20/09

Inventario revalidado antes del corte: 1521 versiones/4470 nodos IA, 644 activos
y ocho configuraciones activas, sin diferencias respecto de las definiciones
anteriores. Candidata `08fc93a5` compuesta sobre CRM `20e7abe3`: adapta el transporte
y su admisión sin promover todo DEV, cambiar dependencias, modelos ni esquema.
Preflight de 27 tablas correcto. Solo se reinicia la API; se restituyen los
estados previos de sus colas y se conservan MFA, pausas y demás procesos.
`clinicaclick-bedrock-staging` queda habilitado al arranque sin reiniciarlo.

Pruebas de esta entrega:

- 23 casos unitarios del candidato. Matriz aislada firmada: 4470 resultados
  esperados, incluidas 17 recetas retiradas; 1904 decisiones y 40 fallos,
  sin diferencias de hash de petición/salida respecto del transporte anterior.
- 22/22 casos contra AWS/Bedrock reales sin credenciales de proveedor locales
  en el harness. No se cambian modelos para obtener este resultado.
- Interfaz CRM con sesión/MFA existentes y backend real: tres controles del
  mismo caso antes/después del corte y tras retirar las claves locales, todos
  completados. Después, 22/22 casos sobre las ocho configuraciones activas;
  22 decisiones posteriores evaluadas y cero errores JS.
- La interfaz inicia los jobs reales. Solo para el borrador propio de QA se
  añade `initial_context` ficticio al POST: no se simula backend ni proveedor,
  ni se leen conversaciones de pacientes. Los nodos IA conservan el hash de
  configuración original; sus condiciones posteriores se copian y sus acciones
  finales se sustituyen por `control/end`. Esto prueba transporte, semántica y
  evaluación de ramas; no prueba envíos ni modificaciones clínicas reales.
- 92 recibos de 46 solicitudes Bedrock contrastados independientemente por
  versión, SHA256 y KMS en S3. Backlog del broker vacío en esa lectura.
- 18 regresiones WhatsApp con transporte ficticio y tres transiciones TLS de
  auditoría con servidor local correcto. El primer lanzamiento de las tres
  últimas usó un guard incompatible y bloqueó el loopback; se conserva ese
  fallo del harness y se repite usando el guard local propio de la suite.

Las 25 ejecuciones UI propias (3018–3042) y sus logs se exportaron a evidencia
privada antes de borrar el único borrador temporal, nunca publicado ni activado.
El borrado se verificó por API; no se borran flujos del usuario ni recibos S3.
El resultado histórico 21/22 descrito más abajo permanece válido: evidencia
variabilidad semántica también por vía directa. Las nuevas tandas correctas no
demuestran clasificación infalible ni eliminan la derivación segura existente.

Evidencia privada en `qa-evidence/security-close-20260920/`: inventario y matrices,
`canary-matrix-ui.json`, capturas de escritorio/móvil, `canary-archive.private.json`,
`canary-cleanup-result.json`, `broker-audit-final-receipts.json` y logs de pruebas.
No subir snapshots de definiciones, claves, sesiones ni registros privados a Git.

Recuperación del corte: conservar versión/configuración previa en
`/var/lib/clinicaclick-consumer-recovery/bedrock-crm-20260920` y
`/var/lib/clinicaclick-consumer-recovery/bedrock-local-copy-removal-20260920`,
ambos privados. Los publicadores de esta entrega están consumidos: no repetirlos.
Ante una incidencia, detener nuevas admisiones, conciliar jobs en curso y aplicar
una recuperación acotada; no volver al proveedor directo automáticamente ni
reproducir resultados inciertos. No detener el servicio AWS ya utilizado.

DEV conserva el transporte desactivado y carece de claves Bedrock. Falta conciliar
gateway/fresh-inbound y sus arranques antes de retirar sus copias; no rotar el par
IAM ni afectar consumidores ajenos. El resto de este documento conserva la
evidencia y secuencia histórica del 18/09; sus estados «sin activar» no describen
el corte posterior de la API CRM.

## Recorridos que deben conservarse

- Audio WhatsApp → transcripción Groq → texto del mensaje/lote → nodo IA.
  El enlace temporal pertenece solo al audio; el nodo analiza su transcripción.
- Nodo `condition/ai_analysis` → selección de contexto en CRM → orquestador →
  Bedrock/Nova → resultado estructurado → condiciones posteriores del flujo.
  El broker no consulta la BD ni elige otra conversación. La operación
  tipada recibe exactamente el texto ya seleccionado y devuelve el mismo
  contrato; no convertir la conversación en un archivo público o en un enlace.
- Confirmación actual: `last_response_context`, cita y evento. No añadir un
  histórico completo para compensar un fallo de transporte. Clasificación de
  intención y receta personalizada conservan su contexto configurado.

El historial tiene ventanas existentes de 60/160/240 líneas y 12000/24000/36000
caracteres para hoy/año/completo. Se conservan autores, orden, Unicode,
transcripciones y exclusión de revocados. Estos límites son del contexto, no
del tamaño de la lectura SQL: el lector actual aún carga todos los mensajes
antes de recortar. Una optimización futura debe demostrar equivalencia y no
retirar mensajes recientes silenciosamente.

## Inventario y pruebas ejecutadas

Lectura SQL en transacción de solo lectura, sin mensajes ni contextos de
ejecuciones: 1521 versiones, 4470 nodos IA y 22 configuraciones distintas.
207 versiones tienen `is_active=1`; sus 644 nodos IA usan ocho configuraciones:
100 clasificadores de intención, 476 confirmaciones y 68 recetas personalizadas.
Eso no significa 644 flujos simultáneos ni que se hayan activado para probar.
Tres ejecuciones estaban esperando; no se reanudaron ni alteraron.

También se inspeccionaron 30 flujos legacy, dos plantillas de chat, nueve
entradas de catálogo y cero plantillas de cita legacy. Los 22 nodos resumidos
del catálogo son descriptores con configuración vacía; la ejecución usa sus
versiones enlazadas, incluidas en las 1521. Los catálogos 1 y 16 conservan sus
familias inactivas; no se reactivan para cubrir una prueba.

Pruebas aisladas con las definiciones guardadas y conversaciones ficticias:

- 4470/4470 resultados esperados: 4453 nodos interpretados y 17 recetas
  históricas retiradas rechazadas deliberadamente. Ninguna receta retirada
  está activa. Peticiones al SDK y resultados idénticos entre staging y DEV
  corregido para los contextos válidos probados.
- 1904 decisiones posteriores a confirmaciones: con/sin pregunta,
  no confirmación y confianza baja. Las ramas coinciden antes/después.
- 40 fallos en las ocho configuraciones activas: pausa, permisos, timeout,
  respuesta mal formada e indisponibilidad. La pausa no llama al proveedor;
  los errores no se convierten en confirmación. Fallback solo según la política
  existente y cuando hay un modelo alternativo distinto.
- 58 regresiones iniciales pasan, más seis comprobaciones enfocadas de contexto,
  incluyendo audio transcrito y lote incompleto. Una suite mixta antigua intentó
  acceder a MySQL y fue detenida por el bloqueo de red; no se ejecutó contra la
  BD clínica ni se contabiliza como aprobada.
- 22/22 casos con Bedrock real, misma identidad/modelos EU existentes: las ocho
  configuraciones activas interpretan confirmación, confirmación con pregunta,
  cambio de cita y solicitud/no solicitud de nueva cita. Texto exclusivamente
  ficticio, BD/pausa/telemetría inyectadas; ningún envío ni cambio clínico.
  Esta es prueba del proveedor actual, no del futuro broker ni de UI.

Evidencia local `qa-evidence/security-resume-20260917/automation-ai/`:
`inventory.json`, `snapshot-comparison.json`, `snapshot-back-{dev,staging}.json`,
`real-bedrock-result.json`, `context-before.log`, `context-after.log` y
`regression-offline-tests.log`. Los snapshots privados de definiciones no se
suben al repositorio. Los prompts/respuestas ficticios no contienen pacientes.

## Defectos previos reproducidos y corrección

El lector aceptaba un ID explícito sin contrastarlo con la clínica o participante
conocido esperado. Se añade una comprobación anterior a la lectura de mensajes;
un desajuste produce `automation_conversation_scope_mismatch`, sin contenido.
Esto es una defensa adicional, no sustituye las ACL del iniciador. Se conserva
la compatibilidad de conversaciones de lead aún sin paciente asociado.

El preset de reseñas se evaluaba antes del bloque de simulación y podía invocar
al proveedor. En simulación pasa ahora por la salida ficticia configurada.
Ambos defectos fallaron en las pruebas previas y pasan con la corrección.
No hay evidencia en esta revisión de una mezcla real de conversaciones.

Ambas correcciones están publicadas: staging `553db422`, gateway `d8b81de7`
y DEV aislado `1b74ab2d` (incluye la corrección `245f7c51`). Se comprobaron los procesos API y fresh-inbound,
los flags efectivos de MFA/jobs/IA y los 18 contratos SQL antes del reinicio.
El importador pasivo de WhatsApp no se modificó ni reinició.

## Preparación del 18/09: transporte Bedrock todavía sin activar

La operación `ai.bedrock.converse.v1` usa un servicio independiente del de
OCR/Groq: audiencia `clinicaclick:bedrock:<entorno>:v1`, clave de firma,
política, ledger y cuatro plazas de ejecución propios. La política solo admite
Bedrock, finalidades inventariadas —incluida `custom`— y modelos EU Nova
micro/lite/pro en `eu-south-2`. El consumidor conserva el cuerpo nativo Converse;
el SDK firma dentro del runtime aislado con el par IAM obtenido del vault.

No hay lookup de conversaciones en AWS ni enlaces para el historial. Solo viaja
el contexto que el CRM ya seleccionó. El contrato rechaza archivos, herramientas
arbitrarias, endpoints/modelos ajenos y campos adicionales. Una petición firmada
tiene un máximo de 1 MiB; se rechaza el exceso, sin recortar texto. Respuesta del
proveedor limitada a 1 MiB antes de deserializar. El ledger conserva referencias,
digest y resultado operativo, sin prompts, conversaciones ni respuesta clínica.

Se preservan los dos intentos del SDK directo ante errores transitorios y el
fallback controlado del orquestador; la operación firmada no se reenvía ni se
reproduce. Un error de admisión, permisos, secreto o auditoría del broker no se
disfraza de throttling del proveedor y no desencadena otro modelo. Con el flag
activo, el consumidor no lee credenciales Bedrock locales ni vuelve a ellas si
falla el broker. `BEDROCK_ENABLED=false` y las pausas siguen bloqueando llamadas.

Pruebas del candidato:

- Suite del broker: 526/526. Consumidores/contexto/recetas: 46/46 en Node18.
  Tres scripts históricos que requieren BD/proveedor fueron detenidos por el
  guard de red; no se ejecutaron contra MySQL ni se cuentan como aprobados.
- Las 4470 definiciones vuelven a pasar por el broker firmado, adaptador de
  secretos y adaptador Bedrock con respuesta SDK ficticia: mismas peticiones y
  salidas que staging, incluidas las 17 recetas retiradas. Se conservan las
  1904 ramas posteriores y 40 fallos de las ocho configuraciones activas.
  El reloj de admisión es virtual en esta matriz para no confundir una ráfaga
  de QA con tráfico operativo; la admisión real se prueba por TLS aparte.
- Transporte SDK real con proveedor inyectado: texto Unicode largo, tool/schema
  idénticos, firma solo al endpoint regional fijado, permisos, errores,
  reflexión de secretos, respuesta excesiva, aborto y ausencia de replay.
- Cuatro peticiones OCR/audio retenidas no impiden la respuesta del runtime
  Bedrock separado. No equivale a una prueba de contención de CPU en AWS.
- Capacidad en un proceso separado con TLS/SDK real y proveedor inyectado:
  heap128 MiB, pico RSS144,5 MiB; una entrada960 KiB y cuatro entradas200 KiB
  simultáneas con cuatro respuestas960 KiB. Exceso de 1 MiB rechazado antes del
  proveedor. Propuesta de MemoryMax256 MiB pendiente de validar en el host AWS.

Evidencia adicional: `bedrock-broker-suite.log`, `bedrock-offline-regressions.log`,
`snapshot-broker-back-dev.json`, `snapshot-broker-comparison.json` y
`bedrock-capacity-result.json` en el mismo directorio privado de QA. Estos pases
no sustituyen la prueba del proveedor a través de AWS ni la interfaz autenticada.
En ese corte de preparación todavía no existían servicio/vault Bedrock; el
despliegue y la evidencia posteriores se detallan a continuación. Los flags de
consumidores continúan apagados.

Configuración del consumidor preparada para staging: `BEDROCK_BROKER_ENABLED`,
`BEDROCK_BROKER_ENVIRONMENT`, `BEDROCK_BROKER_ORIGIN`, `BEDROCK_BROKER_AUDIENCE`,
`BEDROCK_BROKER_CONNECTION_REF`, `BEDROCK_BROKER_KEY_ID`,
`BEDROCK_BROKER_KEY_FILE` y `BEDROCK_BROKER_CA_FILE`. Los ficheros de identidad
deben ser privados, sin symlinks. Preparar una release con su propio lock y
node_modules: el runtime incorpora SDK Bedrock3.1131.0 y no debe modificar las
dependencias compartidas por servicios AWS anteriores. La aplicación mantiene
su SDK existente. Inventariar workers/colas del gateway y fresh-inbound antes
del corte; no deducir su inactividad únicamente de `JOBS_WORKER=false`.

## AWS real del 18/09: despliegue aislado y discrepancia semántica conservada

Desplegada la release `1b74ab2d` en `clinicaclick-bedrock-staging`, UID987,
puerto8449, heap128 MiB, MemoryMax256 MiB, MemoryHigh224 MiB, CPUQuota75%.
Tiene su instalación de dependencias y permanece desactivada al arranque mientras
no haya consumidores migrados. Solo admite conexiones desde el origen CRM /32
ya usado por el servicio IA. Staging dispone de una identidad de firma propia;
no se ha concedido una identidad gateway ni DEV en este runtime.

El slot `/clinicaclick/integrations/prod/ai/bedrock/key` contiene una copia del
par IAM existente de staging, comparado con gateway. No se ha rotado ni creado
una clave IAM. No hubo ampliación IAM: el rol EC2 ya tenía lectura del prefijo
prod y uso de la clave KMS correspondiente. Seed mediante memoria/memfd y TLS,
sin claves en argumentos, evidencia o archivos nuevos de aplicación. Las claves
locales de los consumidores públicos siguen presentes hasta su corte verificado.

Pruebas AWS con datos exclusivamente ficticios y sin BD/colas/envíos clínicos:

- Siete controles de acceso pasan: placeholder sin proveedor, entorno/finalidad/
  conexión/modelo ajenos, firma ajena y audiencia de OCR/audio rechazados.
  El UID998 de DEV no puede leer la nueva clave de firma staging.
- Las 22 invocaciones de las ocho configuraciones activas completan transporte
  y respuesta estructurada reales. **21/22 cumplen todas las aserciones
  semánticas**. Una petición de cambio de cita devuelve `confirma_asistencia=false`
  y, de forma incorrecta, `requiere_respuesta=false`. No se ha ocultado ni
  convertido en verde esa discrepancia mediante reintentos.
- Diagnóstico limitado a tres repeticiones por vía, conservando la misma
  petición nativa: la discrepancia aparece dos veces con Bedrock directo y una
  por broker. El SHA256 del cuerpo coincide en las seis. Es comportamiento del
  modelo que también existe en el recorrido anterior; no se cambió prompt,
  modelo, definición ni campo para forzar el resultado.
- En las seis observaciones el nodo posterior deriva a revisión humana. Además,
  952 evaluaciones aisladas de las 476 confirmaciones activas prueban
  `confirma_asistencia=false`/`requiere_respuesta=false` con confianza alta y baja:
  todas terminan en notificación de revisión, sin ejecutar acciones clínicas.
  Esto acredita esa protección concreta; no demuestra clasificación infalible.
- Cuatro análisis reales simultáneos, cada uno con contexto ficticio de 36049
  caracteres/49549 bytes, responden en 943–975 ms mientras las cuatro plazas del
  runtime OCR/audio están retenidas por peticiones de QA sin cuerpo. Cero llamadas
  al proveedor de archivos durante la retención. Al terminar se cierran esas
  peticiones. Pico RSS94,4 MiB; pico cgroup46,9 MiB, cero OOM/límites/reinicios.
  Ambas medidas son distintas: la memoria compartida no se imputa igual.
- 64 eventos y recibos verificados independientemente en S3 mediante versión,
  SHA256 y KMS: 30 solicitudes, 29 completadas, cuatro denegaciones y el fallo
  esperado del placeholder. Backlog cero y respuestas del modelo no persistidas.
- Certificado enrolado en mantenedor/publicador. Renovación real sin reinicio
  del proceso, preservando clave/identidad/CA; siete identidades sanas. Servicios
  WhatsApp y OCR/Groq conservaron sus PIDs; solo el publicador reinició al añadir
  el nuevo destino.

DEV aislado publicado a `release-1b74ab2d42a601d004171fe6c539ab65b63f5e95`, con
flags de broker apagados, API UID998 sin claves de proveedor, MFA/sesiones enforce
y jobs clínicos desactivados. El publicador original se detuvo antes del corte
al detectar el lock nuevo. Se instaló la dependencia en un directorio propio,
se comparó cada archivo preparado con Git, se pasó el preflight SQL y se completó
el mismo cambio de symlink/reinicio con recuperación. No se alteró el guard del
publicador ni las dependencias de la release previa.

Evidencia privada: `qa-evidence/security-resume-20260917/bedrock-runtime/`, en
particular `real-bedrock-broker-result.json`, `cannot-attend-diagnosis.json`,
`not-confirmed-routing.json`, `installed-capacity-result.json`,
`installed-capacity-metrics.json`, `audit-receipts.json`,
`certificate-renewal.json` y `dev-runtime-verified.json`.

La migración de consumidores sigue pendiente: actualizar inventario de
definiciones/workers antes de activar, evaluar la limitación
semántica y su impacto en la validación funcional y completar el recorrido visual autenticado.
La discrepancia semántica no se contabiliza como un test aprobado, aunque el
flujo probado mantiene revisión humana. No se declara este bloque terminado.

Recuperación del runtime preparado, mientras ningún consumidor use el flag:
retirar solo su destino de ambos mantenedores conservando los demás; validar y
reiniciar únicamente el publicador; detener el servicio y retirar únicamente
la regla ingress8449 de esta entrega. Preservar vault, ledger y recibos. Backups
AWS en `/var/lib/clinicaclick-bedrock-deployment-20260918`; configuración local
anterior en `/var/backups/clinicaclick-security/bedrock-staging-20260918`.

## Monitor y candidato exacto de staging, 18/09 02:30 UTC

`bedrockAiProvider.checkModel` real pasa con los tres modelos EU Nova Micro,
Lite y Pro, por la identidad de firma staging y sin claves AWS en el harness.
La BD está bloqueada y la telemetría inyectada; no es una prueba de UI. Los seis
eventos tienen recibos independientes S3 verificados por versión/SHA256/KMS.
Backlog cero y sin reinicios del servicio Bedrock ni del servicio OCR/audio.

La promoción limitada `3c3eacc7`, subida a
`security/automation-ai-context-staging-20260918`, conserva su propio motor,
telemetría y pausas: solo cambia el adaptador, la finalidad enviada y el perfil
del cliente firmado. No incorpora todo DEV ni cambia ningún flag público.
4470/4470 resultados esperados vuelven a pasar, con cero diferencias en los
hashes de petición/salida respecto de staging, 1904 ramas y 40 fallos iguales.
Además pasan 46 regresiones aisladas, 13 pruebas TLS/runtime usando su cliente
exacto y 18 controles del consumidor WhatsApp existente. Dos scripts históricos
de citas intentaron MySQL bajo el guard de red y se detuvieron; no forman parte
de los 46 pases ni se han ejecutado contra datos clínicos.

Ocho fallos adicionales del broker se inyectan en cada uno de los 644 nodos
activos: saturación, timeout del proveedor y del cliente, permisos, secreto,
auditoría, resultado incierto y respuesta inválida. Pasan 5152/5152 comprobaciones:
una sola llamada por evaluación, sin segundo modelo ni proveedor local, y nunca
una confirmación. 5144 devuelven una excepción; ocho (una receta por los ocho
errores) devuelven proveedor no disponible y terminan sin nodo siguiente. No
afirmar que todos los fallos notifican a un humano: eso depende del flujo.
Estas pruebas no ejecutan el worker ni sus reintentos de jobs, ni acciones
clínicas; prueban el nodo y orquestador concretos ante fallos de transporte.

El grafo de errores tiene 438 destinos directos de notificación y 206 nodos sin
`on_fail`, todos alcanzables; no hay referencias colgantes. De estos últimos,
204 son confirmaciones, uno es `custom` y uno es `classify_intent`. El caso que
termina sin nodo siguiente es `1472/N3`, clasificación de intención: comportamiento
previo de salida segura, no una rama añadida por el broker. No se modificaron las
definiciones ni se afirma que la revisión humana sea inmediata en todos los casos.
El monitor existente corre a las 10:00 y 16:00 Europe/Madrid; su último barrido
guardado del 17/09 a las14:00UTC registró dos ejecuciones fallidas. Su estado
`failed` también representa incidencias encontradas, no necesariamente fallo
interno del monitor. La entrega/lectura de esas notificaciones no se ha probado.

Lectura acotada de fallos de las últimas24h a las02:40UTC:26 ejecuciones, todas
en `action/send_whatsapp`, ninguna en nodo IA. Veinte son `whatsapp_config_missing`
y pertenecen a clínicas sin binding operativo autorizado; no abrir su alcance
para convertirlos en verde. Las seis restantes son cuatro `rate_limited` y dos
`whatsapp_delivery_unknown` dentro de clínicas con binding. Requieren diagnóstico
del transporte WhatsApp antes de declarar el conjunto operativo sin fallos.
No se reenvió ningún mensaje, liberó histórico ni alteró esas ejecuciones.
Que Bedrock todavía siga directo excluye atribuir esos fallos al nuevo corte IA.

Inventario de procesos y Redis de solo lectura a las 02:25 UTC:

- Staging tiene seis workers BullMQ; gateway mantiene `webhook_whatsapp` aunque
  su planificador `JOBS_WORKER_ENABLED` esté apagado. Ninguna de las doce colas
  consultadas tiene trabajos activos, esperando, pausados o diferidos. Gateway
  conserva seis fallos históricos, sin leer sus cuerpos ni reintentarlos.
- `fresh-inbound` importa la configuración de staging y debe incluirse en el
  corte/reinicio. Tiene credenciales presentes heredadas; su presencia no prueba
  que ejecute todos los proveedores. La API y gateway conservan Bedrock/Groq
  locales. No basta con editar un `.env` para retirarlos de procesos vivos.
- DEV API UID998 sigue sin claves de proveedor. El worker de seguridad UID996
  conserva SES; los jobs clínicos continúan apagados y MFA/sesiones enforce.
- El audio gateway aún solicita `response_format=json`, y staging usa
  `verbose_json` con telemetría. Su promoción necesita un parche específico y
  prueba de compatibilidad; no copiar el consumidor completo silenciosamente.

Evidencia: `bedrock-runtime/model-health-qa.json`,
`model-health-audit-receipts.json`, `automation-ai/runtime-consumers.json`,
`snapshot-broker-candidate-comparison.json`,
`bedrock-candidate-offline-regressions.log`, `bedrock-candidate-transport.log`
y `broker-failures-active.json`.
El grafo y el monitor constan en `active-ai-error-routes.json`,
`health-monitor-metadata.json` y `recent-failure-metadata.json` (IDs/categorías y
hash del error; sin conversaciones, destinatarios ni cuerpos de mensajes).
Son snapshots puntuales, no garantía de inactividad futura. El candidato sigue
separado del runtime público y no cierra la aceptación visual ni funcional real.

## Ráfagas antes del corte: espera acotada del consumidor

El candidato incorpora una cola en memoria compartida por los consumidores
Bedrock de un mismo proceso: hasta tres solicitudes activas, un presupuesto
activo de1 MiB,32 solicitudes esperando/4 MiB y espera máxima30s. Se separan los
inicios300ms para no agotar el límite de240/minuto de la identidad staging.
El cálculo incluye2048bytes de margen para el sobre firmado. Se captura el JSON
antes de esperar, sin cambiarlo ni truncarlo si el llamador muta su objeto.
No se reintenta automáticamente una petición ya enviada ni un resultado incierto.
`broker_queue_full` y `broker_queue_timeout` son rechazos locales explícitos sin
llamada a AWS ni fallback a otra clave/modelo. La pausa funcional se vuelve a
consultar justo antes de enviar, además del control inicial del orquestador.

La cola no es distribuida ni durable. La activación exige un único proceso
consumidor Bedrock: el inventario actual identifica la API staging. Fresh-inbound
transcribe y encola el dispatch; no ejecuta el análisis. Gateway y DEV no tienen
grant en ese runtime. Cualquier ampliación de procesos exige coordinación de
admisión; no multiplicar estas cuotas por worker. El trabajo durable continúa
siendo responsabilidad de JobRequests y las ejecuciones existentes.

Validación del candidato con este ajuste:

- 53 regresiones aisladas pasan, incluidas concurrencia, cuotas por bytes,
  orden de espera, expiración sin envío, pausa/desactivación durante la espera
  e inmutabilidad del contexto encolado.
- 4470 resultados esperados, cero diferencias en peticiones/salidas,1904 ramas
  y40 fallos iguales a staging;4453 comprobaciones de pausa adicionales antes
  del envío. La admisión temporal se inyecta en esta matriz masiva para probar
  el contenido sin esperar22min; su comportamiento real se prueba aparte.
- 6440 fallos inyectados (diez por cada nodo activo), incluidos los dos nuevos
  errores locales: ninguna confirmación ni segundo intento.6430 excepciones
  y10 finales sin nodo siguiente para el caso1472/N3 ya descrito.
- Ráfaga real de12 controles Micro por el consumidor exacto:12/12 correctos,
  3825ms totales, pico de dos llamadas simultáneas,297ms de separación mínima
  observada en el cliente. Contenido ficticio, sin BD/telemetría de aplicación.
  24 eventos solicitados/completados, recibos S3 comprobados independientemente
  por versión/SHA256/KMS y sin backlog; PIDs/reinicios de Bedrock,
  OCR/audio y WhatsApp autorizado sin cambios.

Evidencia: `bedrock-paced-regressions.log`,
`snapshot-paced-broker-candidate-comparison.json`,
`broker-failures-paced-active.json` y `bedrock-runtime/paced-burst-qa.json`.
La discrepancia semántica real21/22 se conserva; esta ráfaga de salud no la
reclasifica como aprobada. Corte público y recorrido visual siguen pendientes.

Código `ff0d9a85` publicado en DEV aislado por el publicador original, con
preflight SQL previo, API UID998 y worker UID996. API sin claves de proveedor,
MFA/sesiones enforce y jobs clínicos apagados. El candidato staging con la cola
es `1f2e4dfa` en la misma rama de preparación, ya subido. La API pública staging,
gateway y fresh-inbound conservaron sus PIDs y configuración;401 en auth/me de
los tres puertos. La publicación DEV no activó ningún flag ni grant Bedrock.

El diagnóstico WhatsApp correlacionó únicamente IDs, estados y auditoría:
cuatro rechazos `rate_limited` carecen de comando reservado; hay20 envíos
completados en ese minuto. El runtime admite ocho operaciones simultáneas y
60/minuto; sin el contador histórico no se puede distinguir con certeza cuál
límite se alcanzó. Los dos resultados inciertos constan `unknown` en el ledger
y `provider_failed` en auditoría. Sus cuatro recibos S3 están verificados, pero
ese error fijo no permite reconstruir la respuesta de Meta ni acreditar entrega.
Conservarlos sin replay. No se subieron límites ni se reactivaron mensajes.
Ver `whatsapp-failure-correlation.json`, `whatsapp-failure-audit-source.json`,
`whatsapp-failure-audit-receipts.json` y `whatsapp-rate-window.json`.

## Condiciones antes de migrar Bedrock

1. Conservar región/modelos, selección de contexto, tool `submit_analysis`,
   campos/confianzas y comportamiento ante errores. Incluir la finalidad real
   `custom`, además de `classify_intent`, `confirm_appointment` y las demás
   funciones inventariadas; no suponer que solo existen recetas predefinidas.
2. Comparar los bytes del texto y el JSON estructurado antes/después del broker
   con esta misma matriz. Repetir las pruebas reales sin claves Bedrock en CRM.
3. Medir límites en bytes con conversaciones largas y Unicode, preservar el
   lote reciente y rechazar excesos explícitamente. Los 11431 bytes máximos de
   la muestra ficticia no demuestran un máximo de producción.
4. Asegurar capacidad para análisis de conversaciones cuando haya OCR/audios
   lentos. No incorporar Bedrock sin más al cupo compartido de cuatro peticiones:
   una saturación de Groq podría retrasar o rechazar decisiones del flujo.
5. Mantener pausas, deduplicación, intervención humana, aislamiento por clínica,
   estados de espera y prohibición de reanudar históricos. Auditar metadata,
   nunca copiar conversaciones, prompts o respuestas clínicas al ledger.
6. Verificar interfaz autenticada, editor/simulación, estado de error y consumo
   IA con MFA legítimo. El acceso de pruebas sigue pendiente del titular.

Las credenciales Bedrock y flags actuales permanecen sin cambiar durante esta
revisión. La retirada de claves y el corte siguen formando parte del objetivo.

## Esperas vencidas y cambios durante validación, 18/09 04:31 UTC

Se reprodujeron tres casos de fallo antes del corte público: una continuación
de promesa podía admitir trabajo vencido antes de ejecutarse su temporizador;
el interruptor/entorno/conexión del broker podían cambiar durante el guard
asíncrono sin volver a comprobarse; y desactivar el proveedor durante ese guard
no impedía la llamada. Corrección `343f6a57`, publicada en DEV aislado, y
`e157f3a2` en la candidata de staging todavía sin activar.

La admisión comprueba el plazo monótono antes de reservar capacidad. Tras el
guard se vuelven a comprobar interruptor y ámbito; el adaptador también relee
`BEDROCK_ENABLED` sin consultar credenciales locales si cambia el flag del
broker. Los límites, orden FIFO, tres plazas, memoria, contratos y errores
existentes se conservan. `checkModel` comparte `analyzeStructured` y sus controles.

- Los tres casos fallan antes y pasan después. Regresiones aisladas:36/36 en
  DEV y30/30 en la candidata, con BD/red externa bloqueadas y proveedor ficticio.
- Matriz de las definiciones guardadas:4470 resultados esperados, incluidos17
  rechazos de recetas retiradas,644 nodos activos y ocho configuraciones. Los
  hashes de peticiones/salidas,1904 ramas y40 fallos coinciden tanto con staging
  directo como con la candidata anterior. La admisión temporal se prueba aparte;
  la matriz usa una admisión inmediata para no confundirla con carga operativa.
- Publicación DEV por el publicador original, dependencias sin cambio respecto
  a la release SES preparada, preflight18 tablas compatible. Configuraciones
  privadas conservan SHA256; MFA/sesiones enforce y jobs clínicos apagados.
  Los procesos públicos conservan PID y los flags del broker siguen apagados.

Evidencia: `automation-ai/delayed-admission-{before,after,regressions}.log`,
`delayed-candidate-regressions.log`, `snapshot-delayed-broker-candidate.log` y
`delayed-admission-matrix-comparison.json`. El snapshot no sustituye actualizar
el inventario antes del corte. Tampoco reemplaza la discrepancia semántica real
21/22 ni el recorrido autenticado de interfaz, que siguen pendientes.


## Persistencia de la revisión tras la discrepancia (18/09/2026)

El nuevo inventario de solo lectura mantiene 1.521 versiones, 207 activas,
4.470 nodos IA y 644 activos. Las definiciones coinciden byte a byte con la
captura anterior (SHA256 `9d290f98bfd6b67be3e4ba00783a9b982f322e451a746c74d3cd79b04e1b2128`).
No se consultaron mensajes de pacientes ni se modificaron definiciones.

`automation_ai_manual_review_mysql.integration.js` conserva deliberadamente la
respuesta incorrecta `confirma_asistencia=false, requiere_respuesta=false`.
Ejecuta el nodo de decisión y recorre en simulación la ruta de notificación
hasta su fin. Después utiliza el motor y el servicio reales de persistencia en
un MySQL temporal propio: 476 confirmaciones activas por dos niveles de
confianza, **952/952** casos. El estado queda `review`, con
`manual_action_required=true` aunque `needs_response=false`. Tanto el evento de
socket como el DTO que se consulta al recargar conservan revisión y mensaje de
origen. Una ejecución antigua u otra clínica no puede sustituir el propietario.
Las citas y mensajes ficticios quedan intactos; ninguna notificación se entrega.

La prueba frontend `quickchat_ai_manual_review.test.js` consume además un payload
ficticio emitido por esa persistencia real. Ejecuta el mapper, manejador de socket
y métodos del componente reales: conserva tarjeta de revisión, indicador ámbar,
mensaje de origen y acción pendiente en el detalle del paciente, tanto al
recargar como al recibir un evento. Es una prueba de comportamiento del código,
**no un navegador autenticado ni una prueba visual**. Dos casos nuevos y cuatro
regresiones de reconciliación pasan.

Esta evidencia amplía la protección acreditada más allá del siguiente nodo.
No corrige la interpretación del modelo, no cambia prompts, modelos ni flags,
y **no convierte 21/22 semántico en 22/22**. La aceptación visual con login/MFA
normal y la calidad semántica siguen pendientes. No se pide al usuario aprobar
el caso incorrecto; su dependencia concreta es el acceso a una cuenta QA.

Reproducción sin red clínica/proveedores:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/automation_ai_manual_review_mysql.integration.js
# Para todas las definiciones: aportar una captura privada revisada mediante
# AUTOMATION_AI_DEFINITIONS_FILE; nunca conectar el test a la BD de aplicación.
```
