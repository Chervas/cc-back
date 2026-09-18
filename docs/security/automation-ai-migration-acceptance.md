# Automatizaciones con IA: conservación del contexto durante la migración

Revisión 2026-09-18. Complementa [el runbook IA](ai-vault-migration.md).
El transporte Bedrock todavía no está migrado al broker. Esta revisión no
autoriza a declarar el corte ni la comprobación visual terminados.

## Recorridos que deben conservarse

- Audio WhatsApp → transcripción Groq → texto del mensaje/lote → nodo IA.
  El enlace temporal pertenece solo al audio; el nodo analiza su transcripción.
- Nodo `condition/ai_analysis` → selección de contexto en CRM → orquestador →
  Bedrock/Nova → resultado estructurado → condiciones posteriores del flujo.
  El broker no consulta la BD ni elige otra conversación. La futura operación
  tipada debe recibir exactamente el texto ya seleccionado y devolver el mismo
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
y DEV aislado `245f7c51`. Se comprobaron los procesos API y fresh-inbound,
los flags efectivos de MFA/jobs/IA y los 18 contratos SQL antes del reinicio.
El importador pasivo de WhatsApp no se modificó ni reinició.

## Transporte Bedrock preparado y probado, todavía sin activar

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
No se han creado aún el servicio/vault Bedrock ni activado flags de consumidores.

Configuración del consumidor pendiente de provisionar: `BEDROCK_BROKER_ENABLED`,
`BEDROCK_BROKER_ENVIRONMENT`, `BEDROCK_BROKER_ORIGIN`, `BEDROCK_BROKER_AUDIENCE`,
`BEDROCK_BROKER_CONNECTION_REF`, `BEDROCK_BROKER_KEY_ID`,
`BEDROCK_BROKER_KEY_FILE` y `BEDROCK_BROKER_CA_FILE`. Los ficheros de identidad
deben ser privados, sin symlinks. Preparar una release con su propio lock y
node_modules: el runtime incorpora SDK Bedrock3.1131.0 y no debe modificar las
dependencias compartidas por servicios AWS anteriores. La aplicación mantiene
su SDK existente. Inventariar workers/colas del gateway y fresh-inbound antes
del corte; no deducir su inactividad únicamente de `JOBS_WORKER=false`.

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
