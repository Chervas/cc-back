'use strict';

// Same canonical agenda events/ACL bus as ordinary appointment mutations.
// Only committed, scoped IDs from the server's receipt reach this publisher.
async function publishProgramBookings({ db, result, clinicId, io = require('./socket.service').getIO() }) {
  if (!io || result.replayed || !result.sessions?.length) return;
  if (result.sessions.length > 30) throw Error('program_realtime_batch_invalid');
  const actions = new Map(result.sessions.map(row => [Number(row.appointment_id), row.action]));
  const rows = await db.CitaPaciente.findAll({ where: { id_cita: { [db.Sequelize.Op.in]: [...actions.keys()] }, clinica_id: clinicId } });
  for (const row of rows) io.to(`clinic:${Number(row.clinica_id)}`).emit(actions.get(Number(row.id_cita)) === 'rescheduled' ? 'appointment:updated' : 'appointment:created', {
    appointment_id: Number(row.id_cita), clinic_id: Number(row.clinica_id), patient_id: Number(row.paciente_id) || null,
    lead_intake_id: Number(row.lead_intake_id) || null, doctor_id: Number(row.doctor_id) || null,
    instalacion_id: Number(row.instalacion_id) || null, tratamiento_id: Number(row.tratamiento_id) || null,
    estado: row.estado, inicio: row.inicio, fin: row.fin, updated_at: row.updated_at, created_at: row.created_at,
  });
}
module.exports = { publishProgramBookings };
