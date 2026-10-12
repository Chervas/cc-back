# Confirmación y corrección administrativa — 12/10/2026

## Contrato corregido

`administrative_error` conserva `recordatorio_confirmado` si ése es el estado
persistido de la cita. Para los demás estados abiertos mantiene el comportamiento
previo: `info_confirmada`. El estado pedido por el cliente no acredita una nueva
confirmación de asistencia.

La decisión se vuelve a tomar con la fila bloqueada: tanto en el escritor de
reservas como en el escritor compatible anterior. Se aplica también al nodo de
automatización administrativo que todavía solicita `info_confirmada`; no se
modifican gráficos publicados. Una corrección silenciosa no envía WhatsApp ni
correo y no silencia los recordatorios futuros. Las acciones posteriores de
estado no se interceptan por conservar un `reschedule_reason` antiguo.

Se mantienen los límites de llegada, atención iniciada/finalizada, consentimiento,
ocupación, rollback, revisión importada y pertenencia a la clínica.

## Tres conceptos distintos

- Los `booking_segments` de una reserva combinada son proyecciones de una misma
  `id_cita`: comparten estado y no necesitan confirmar otras citas.
- `AppointmentPatientLink` une reservas individuales mediante una decisión
  explícita. La confirmación del propietario se propaga a los miembros abiertos;
  las reservas seguidoras no generan sus propios avisos. Las comprobaciones de
  ejecución y envío conservan esa protección incluso para un trabajo anterior.
- `AppointmentVisit` es la autoridad de comunicaciones de una visita validada.
  No equivale a una unión clínica ni se crea por coincidencia de paciente/hora.

## Diagnóstico de los ejemplos proporcionados

Lectura acotada y `READ ONLY` de CRM: clínicas 66/72, los tres números de historia
indicados por el usuario y las fechas civiles 12–13/10/2026 (Europe/Madrid).
No se leyeron cuerpos de mensajes, nombres ni credenciales.

Las nueve reservas del alcance no tienen filas de `AppointmentPatientLink`,
aunque sus dos tablas sí están instaladas. Una de las nueve reservas tiene dos
fases. El registro de recordatorios muestra envíos para reservas independientes,
no un envío duplicado por cada fase. `AppointmentVisits` y
`AppointmentVisitMembers` no están instaladas en ese runtime; no se ha aplicado
ninguna migración de ese subsistema.

Los nueve estados ya estaban en `recordatorio_confirmado` al terminar la lectura.
Se observaron correcciones posteriores a los envíos en el historial operativo;
este diagnóstico no las realizó. No se agruparon reservas por cercanía temporal,
no se cambiaron citas históricas ni se reenviaron/cancelaron trabajos o mensajes.

## Validación

- Regresión enfocada: ocho archivos, todos pasan.
- Reserva canónica: 101 casos, incluida confirmación persistida y propuesta
  obsoleta que no puede fabricar confirmación.
- Corrección administrativa: 14 casos; nodo de estado/política: nueve casos.
- MySQL propio aislado: nacimiento de unión, confirmación del propietario,
  supresión de aviso del seguidor, movimiento conjunto confirmado, rollback,
  exclusión de combinadas, cuidado iniciado, cancelación y desvinculación.

Las pruebas usan datos ficticios y transporte/colas declarados como límites
aislados; no son envíos ni cambios en las reservas reales del diagnóstico.
