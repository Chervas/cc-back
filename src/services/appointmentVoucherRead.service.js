'use strict';
const { Op } = require('sequelize');
const plain = row => row?.toJSON ? row.toJSON() : row;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const set = (row, value) => row?.setDataValue ? row.setDataValue('voucher_public_id', value) : (row.voucher_public_id = value);

// Purchase identity only. The appointment's numeric FK is never compared with
// a display name, treatment or financial amount. No booking/consumption writes.
async function attachAppointmentVoucherIdentities(db, appointments) {
  const rows = (Array.isArray(appointments) ? appointments : [appointments]).filter(Boolean);
  rows.forEach(row => set(row, null));
  if (!db.PatientVoucher) return appointments;
  const eligible = rows.filter(row => {
    const value = plain(row);
    return positive(value.voucher_id) && positive(value.clinica_id) && positive(value.paciente_id);
  });
  for (let offset = 0; offset < eligible.length; offset += 200) {
    const batch = eligible.slice(offset, offset + 200), scopes = new Map();
    for (const row of batch) {
      const value = plain(row), scope = { id: Number(value.voucher_id), clinic_id: Number(value.clinica_id), patient_id: Number(value.paciente_id) };
      scopes.set(`${scope.id}:${scope.clinic_id}:${scope.patient_id}`, scope);
    }
    const vouchers = await db.PatientVoucher.findAll({ where: { [Op.or]: [...scopes.values()] },
      attributes: ['id', 'public_id', 'clinic_id', 'patient_id'], raw: true });
    const byScope = new Map(vouchers.map(plain).map(voucher => [`${Number(voucher.id)}:${Number(voucher.clinic_id)}:${Number(voucher.patient_id)}`, voucher]));
    for (const row of batch) {
      const value = plain(row), voucher = byScope.get(`${Number(value.voucher_id)}:${Number(value.clinica_id)}:${Number(value.paciente_id)}`);
      if (typeof voucher?.public_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(voucher.public_id)) set(row, voucher.public_id);
    }
  }
  return appointments;
}
module.exports = { attachAppointmentVoucherIdentities };
