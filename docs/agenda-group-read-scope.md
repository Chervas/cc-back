# Agenda: grupos y referencias de otra clínica

Corte 07/10/2026. Sólo lectura; no migraciones ni cambios de citas.

- `clinica_id=66,72` representa ambas clínicas completas. Doctores e
  instalaciones no deben usar `parseInt` sobre esa lista. Los IDs desconocidos,
  mal formados o no autorizados no se sustituyen por una consulta global.
- `/citas/calendar?include_group_conflicts=1` puede completar una clínica con
  las otras del mismo grupo, exclusivamente con permiso `appointments.view`.
  No cambia el ámbito de las escrituras ni abre el acceso clínico restringido:
  el resultado conserva `protectAppointmentsForRequest`.
- `agenda_clinic` identifica el propietario de cada tarjeta. Las referencias
  de otra clínica son de sólo lectura; para editarlas se cambia explícitamente
  de clínica. El contexto de grupo tampoco elige por defecto su primera clínica.
- `agenda_installation_aliases` utiliza `InstallationPhysicalAliases`, no los
  nombres de salas. Sólo contiene recursos activos de clínicas autorizadas.
  Es una proyección visual: el ID real de cada cita/segmento permanece intacto.
- Las miniaturas/resúmenes mensuales conservan el ámbito explícito sin sumar
  referencias externas; día/semana incorporan esas referencias. La confirmación,
  reprogramación y notificación usan las citas canónicas existentes.

Regresión: `src/scripts/tests/agenda_read_scope.test.js` (listas estrictas,
grupo, permisos parciales y alias) y `installation_access_scope_contract.test.js`.
No DDL, activaciones de catálogo, envíos ni cambios en gateway. Rollback: revertir
este corte de lectura junto al frontend correspondiente, sin revertir los fixes
de WhatsApp ni sus esperas recuperadas.

## Vista conjunta de sólo lectura y selectores estables — 07/10/2026

El grupo sigue siendo exclusivamente lectura. Para crear, bloquear o editar se
elige una clínica; una sala compartida no selecciona su primer centro por defecto.

- El lector autorizado de instalaciones añade `agenda_physical_alias_ids`,
  con una consulta por lote a los alias explícitos, limitada a salas activas de
  la respuesta. Permite una representación física estable incluso en días vacíos.
  No modifica IDs, bloqueos, reservas, permisos ni el modelo de datos.
  `agenda_physical_room_key` es un ancla opaca de navegación que mantiene la
  misma sala al cambiar entre centros, sin devolver IDs de salas ajenas en el
  lector de una sola clínica. La misma consulta por lote cubre ambos extremos
  del alias; no requiere otra API ni una consulta por tarjeta.
- El selector `agenda_context` publica `agenda_flexible` desde la pertenencia
  activa que recibe citas en esa clínica. Su `agendable` considera esa excepción
  existente cuando hay apertura de clínica; no es una autorización para reservar.
  La matriz y la validación canónica conservan bloqueos, atención, máquinas,
  conflictos y confirmación. El agregado de varias clínicas es sólo presentación.
- Frontend solicita la lista explícita de clínicas al lector de instalaciones,
  en vez de consultar todos los centros autorizados y filtrar localmente.

Regresión adicional: `agenda_selector_readiness.test.js` ejecuta ambos
controladores con dependencias simuladas, sin DB ni proveedores, comprobando
ámbito, excepción por pertenencia y una sola consulta de alias sin recursos ajenos.
No alterar las recuperaciones de WhatsApp ni reactivar consentimientos.
