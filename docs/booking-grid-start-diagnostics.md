# Motivos de disponibilidad de inicio · 2026-10-05

La matriz de tratamiento de una sola fase mantiene los mismos huecos del solver
canónico. Añade `unavailable_intervals` / `unavailable_by_doctor` /
`unavailable_by_instalacion` cuando el cliente pide motivos. Estos intervalos
representan **horas en las que no puede empezar la cita completa**, no reservas
físicas del recurso durante todo el tramo pintado.

- `interval_kind: appointment_start`.
- `details.availability_semantics: appointment_start`, `reason_key`, duración y
  mensaje legible dentro de `resource_conflicts`.
- Incompatibilidad de sala/profesional, horario que no admite la duración,
  ocupación/bloqueo, máquina no disponible/ocupada, intervención parcial del
  profesional, apoyo y hora pasada. Si hay alternativas no se atribuye a una
  única persona el fallo de todas las combinaciones.
- Sin pacientes, notas, IDs de otras citas/clínicas ni lectura SQL por celda.
  Se consume el mismo contexto acotado de la petición; motivos adyacentes
  iguales se comprimen. El resumen del calendario conserva el OR temprano sin
  diagnósticos. No cambia reservas, estados, solapamientos autorizados o gates.

El frontend conserva los inicios válidos, separa los motivos en memoria y
explica que comprueba la duración completa. El hover de un inicio válido muestra
todo el intervalo (p. ej. 12:45–13:30), aunque las posiciones 12:50 en adelante
no sean otros inicios válidos para ese tratamiento.

## Clic y hover de matriz — 2026-10-07

- `GET /disponibilidad/treatment-slots` acepta `starting_doctor_id` y
  `starting_instalacion_id` opcionales para conservar el recurso de un inicio
  elegido en la matriz. Anclan únicamente el primer paso temporal; el solver
  comprueba y asigna el resto del plan completo. Un equipo ALL sigue siendo
  obligatorio entero, aunque su columna corresponda a uno de sus miembros.
- IDs positivos y pertenecientes al primer paso; no se mezclan con los filtros
  planos `doctor_id`/`instalacion_id`. Permisos, contexto de paciente, capacidades,
  receipt y revalidación al reservar no cambian. No equivale a reservar ese hueco.
- Los rechazos de preparación sobre una reserva existente sin segmentación
  verificada explican el tratamiento y horario propios y el tiempo de preparación
  solicitado. Mantienen exactamente el mismo rechazo y `can_force: false`.
  Para otra clínica sólo se muestra su franja, nunca pacientes ni tratamiento.
- El hover reutiliza los mismos intervalos/motivos JSON del icono del ojo,
  también con éste apagado, acotados a día y subcolumna. No consulta `/check`,
  añade SQL ni recalcula posiciones al mover el cursor. La restricción de
  INDIBA ONA se conserva por confirmación del cliente; no se migra su atención.

Pruebas: `availability_five_minute_slots`, `availability_request_snapshot`,
`booking_equipment_http_availability`, `booking_attention` y
`appointment_additional_staff_availability`. También QA de agenda día/semana,
ambas orientaciones, todos los filtros y zoom, sin crear citas reales.
