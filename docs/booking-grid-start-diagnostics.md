# Motivos de disponibilidad de inicio · 2026-10-05

## Colocación guiada de una visita combinada · 07/10/2026

`GET /disponibilidad/treatment-slots` admite `guided_start_local` (inicio
local de la visita, en la cuadrícula de cinco minutos) y `guided_selection`
(JSON por clave de fase con un prefijo temporal contiguo). Se mantienen los
permisos de clínica, paciente sensible, visibilidad de catálogo, capacidades,
duraciones, ocupación, maquinaria y personal de apoyo del endpoint normal.

La respuesta añade `phase_key`: siguiente fase por colocar, o `null` si el
prefijo está completo. Cada elemento de `slots` es un plan **completo** viable
con su recibo SHA, no una reserva de esa fase. Pueden compartir inicio y
representar salas/profesionales distintos del siguiente paso. Cada elección
fija los pasos anteriores y vuelve a resolver los restantes desde un único
snapshot de recursos. No hay consultas por movimiento del cursor ni escrituras.

Se rechazan claves desconocidas, pasos omitidos, recursos incompatibles,
subequipos ALL, selecciones ambiguas y más de 500 alternativas. Una hora no
viable no se sustituye por otra. El prefijo completo se revalida antes de enviar
un único `createCita`, con el recibo y la misma clave idempotente. No introduce
mensajes por fase ni activa consentimientos. No requiere migración SQL ni flags
nuevos.

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

## Excepciones manuales explicadas · 09/10/2026

La selección explícita de un profesional o sala existentes y activos de la
clínica puede advertir restricciones de asignación, horarios, ausencias,
bloqueos y ocupación (profesional, sala, máquina y propio paciente). El catálogo
no se modifica. La interfaz reúne **todos** los motivos del mismo snapshot,
incluyendo profesional/sala asignados, tratamiento ocupado, horario real y
minutos que excede la cita. No se atribuye atención continua a una reserva
histórica salvo que su snapshot de intervención lo acredite.

`/check` y los motivos JSON de matriz exponen `booking_restrictions` y
`can_confirm_restrictions`. En una combinada aún incompleta,
`can_place_with_restrictions` permite continuar colocando sus pasos; no
autoriza guardar ni elegir por el usuario. Las propuestas completas de
`treatment-slots` añaden `requires_restriction_acknowledgement` cuando procede,
conservando offsets, duración, equipo ALL completo y maquinaria requerida.
El hover no consulta SQL ni HTTP: reutiliza el mismo JSON de disponibilidad.

POST de cita, reagendado y PATCH de apoyo usan un contrato distinto de `force`:
un 409 `booking_restriction_confirmation_required` devuelve la explicación,
`booking_restriction_acknowledgement` y el `booking_plan_sha256` efectivo.
Sólo tras confirmar se repite el mismo payload con ambos recibos. Se recalcula
bajo locks de recursos y paciente: si cambian reserva, profesional, sala,
horarios, estado, actor o evidencias, exige otra confirmación. Las citas
independientes vinculadas se mueven con un recibo del conjunto (incluye también
miembros sin advertencias); si falla una, ninguna se guarda.

El recibo y el perfil original se conservan en `import_metadata`, junto al
snapshot efectivo que proyecta las tarjetas. No hay migración SQL, permiso
nuevo, envíos extra, cambio de estados comunicacionales ni activación de
consentimientos. `force: true` por sí solo no acepta esta excepción.

No admite recursos ajenos/inactivos, acceso sin permiso, maquinaria inexistente
o en mantenimiento, cambios de firmas/consumo, duración u obligaciones ALL, ni
una combinación internamente imposible. Sesiones de programas comprados siguen
su contrato protegido; esta entrega no modifica su contabilidad o selección.

Pruebas offline: `booking_restriction_confirmation`, `booking_guided_placement`,
`appointment_booking_core` (alta, stale receipt, apoyo y fases),
`appointment_booking_http_contract` y suites existentes de disponibilidad.
