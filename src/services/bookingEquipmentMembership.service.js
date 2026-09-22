'use strict';
const { clinicUsesEquipment, equipmentError } = require('../lib/booking-equipment');

// Called with the clinic row locked, like inventory writes. Never read inventory
// for an ordinary clinic. Membership changes cannot invalidate shared bookings.
async function assertClinicEquipmentMembershipChangeSafe({ db, clinic, transaction }) {
  if (!clinicUsesEquipment(clinic)) return;
  const assigned = await db.BookingEquipmentClinic.findOne({
    where: { clinic_id: Number(clinic.id_clinica) }, transaction,
  });
  if (assigned) throw equipmentError('in_use',
    'Revisa los equipos compartidos antes de cambiar el grupo o desactivar esta clínica.', 409);
}
module.exports = { assertClinicEquipmentMembershipChangeSafe };
