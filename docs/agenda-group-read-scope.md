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
