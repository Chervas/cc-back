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

Pruebas: `availability_five_minute_slots`, `availability_request_snapshot`,
`booking_equipment_http_availability`, `booking_attention` y
`appointment_additional_staff_availability`. También QA de agenda día/semana,
ambas orientaciones, todos los filtros y zoom, sin crear citas reales.
