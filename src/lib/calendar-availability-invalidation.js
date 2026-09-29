'use strict';

const { relatedClinics } = require('./availability-realtime');

// Only clinic IDs cross the socket boundary. Never block a committed calendar
// write on best-effort UI delivery, nor broadcast a doctor's absence/reason.
async function notifyCalendarAvailability({ db, doctorId, installationId, clinicId }, {
  publish = (id) => require('../services/socket.service').getIO().to(`clinic:${id}`).emit('availability:changed', { clinic_id: id }),
  related = ids => relatedClinics({ db, clinicIds: ids }),
} = {}) {
  const ids = new Set(clinicId ? [Number(clinicId)] : []);
  if (doctorId) {
    const rows = await db.DoctorClinica.findAll({ where: { doctor_id: Number(doctorId) }, attributes: ['clinica_id'], raw: true, limit: 101 });
    if (rows.length > 100) throw Error('calendar_availability_scope_limit');
    rows.forEach(row => ids.add(Number(row.clinica_id)));
  }
  if (installationId) {
    const room = await db.Instalacion.findByPk(installationId, { attributes: ['clinica_id'], raw: true });
    if (room) ids.add(Number(room.clinica_id));
  }
  if (!ids.size) return;
  if ([...ids].some(id => !Number.isSafeInteger(id) || id <= 0) || ids.size > 100) throw Error('calendar_availability_scope_invalid');
  const targets = [...new Set([...ids, ...await related([...ids])])];
  if (targets.length > 1100 || targets.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('calendar_availability_scope_invalid');
  for (const id of targets) publish(id);
}

module.exports = { notifyCalendarAvailability };
