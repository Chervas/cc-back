# Citas individuales vinculadas — 7 de octubre de 2026

La relación es explícita y nace al guardar una cita nueva. No se infiere por
teléfono, nombre, coincidencia horaria ni importación. No convierte un conjunto
de reservas históricas ni activa el rollout experimental AppointmentVisits.

## Contrato

- Crear una segunda cita del mismo paciente, clínica y día sin elección devuelve
  `409 appointment_same_day_choice_required`, con candidatos, sus versiones y
  elegibilidad. Todavía no se ha guardado ninguna cita ni lanzado automatizaciones.
- `same_day_choice: { mode: 'separate' }` conserva los avisos independientes y
  respeta todas las supresiones manuales que tuviera el formulario.
- `same_day_choice: { mode: 'link', appointment_id, updated_at }` vincula la nueva
  reserva a una anterior del mismo día bajo la transacción de reserva canónica.
  La primera sigue siendo propietaria del aviso. No se reasignan ejecuciones,
  respuestas, mensajes aceptados ni historial previo.
- Sólo citas individuales abiertas: no fases de combinadas, programas, bonos,
  componentes clínicos de PRP ni citas iniciadas/cerradas. Hasta diez miembros.
  El tratamiento combinado continúa siendo **una sola Cita** con segmentos;
  no puede desvincularse. Sus fases conservan sus duraciones y recursos originales.
- `appointment_link` es un DTO del servidor con identidad, versión, propietario,
  índice/count y recorrido. Ningún campo del payload permite fabricar esta relación.
- La confirmación de la primera se propaga transaccionalmente a los miembros
  abiertos. Si ya estaba confirmada al vincular, la nueva hereda esa confirmación.
  No se propagan llegada, inicio, firma, cobro ni finalización clínica.
- Reprogramar cualquier miembro desplaza **todos** con el mismo delta, conserva
  duraciones y distancias y valida cada reserva con el escritor canónico y los
  recursos/ocupación del paciente. El fallo de cualquier paso revierte el conjunto.
  Los campos de sala/profesional del PATCH afectan únicamente al miembro elegido.
  Se cancela el flujo anterior de cada miembro y se publica sólo el de la primera.
  El motivo `administrative_error` sigue siendo silencioso.
- `POST /citas/:id/desvincular` requiere `appointments.manage` para esa clínica.
  Disuelve la unión, conserva reservas/historial y reevalúa sólo ventanas futuras.
  No dispara `appointment_created` ni recupera recordatorios de ventanas pasadas.
  Una reserva vinculada no se elimina físicamente de forma individual.

## Comunicación y seguridad

La propiedad se consulta en los puntos de publicación, planificación, ejecución
del recordatorio y justo antes de enviar WhatsApp. Un seguidor no crea flujos,
recordatorios ni envíos propios, aunque una política de recuperación de importados
permita avisos en otras citas. El propietario mantiene la idempotencia y las
supresiones existentes. Las confirmaciones entrantes se procesan en el worker de
staging; gateway permanece sin worker y no se promociona el código entero a él.

`AppointmentPatientLinks` y `AppointmentPatientLinkMembers` son dos tablas
aditivas con FKs, miembro único por reserva e índice por grupo. No tienen backfill.
El script `src/scripts/appointment-patient-links-schema.js check|apply dev|staging
/ruta/privada/recibo.json` verifica el entorno de ejecución, usa una única conexión,
reserva un recibo privado antes del DDL y no carga app, modelos ni proveedores.
Una instalación parcial falla cerrada. El rollback de estructura rechaza datos.

## Evidencia exigida

SQL aislado real: reserva y unión atómicas, confirmación heredada/propagada,
restricción de alcance, movimiento desde el seguidor, liberación de intervalos,
rollback, exclusión de combinadas, desvinculación sin borrar reservas y bloqueo
del seguidor en las funciones reales de publicación/planificación sin proveedores.
La revisión visual debe cubrir ambas orientaciones, colocación guiada, recorrido
en hover/QuickChat y «Ver citas» del buscador superior.

La agrupación definitiva de parejas históricas y las 60 fichas en borrador siguen
pendientes en el roadmap; esta funcionalidad no los da por migrados.
