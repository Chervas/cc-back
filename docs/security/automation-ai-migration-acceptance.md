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
