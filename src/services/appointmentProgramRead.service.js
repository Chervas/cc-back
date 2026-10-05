'use strict';
const { Op, literal } = require('sequelize');

const plain = row => row?.toJSON ? row.toJSON() : row;
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const setContext = (row, value) => row?.setDataValue ? row.setDataValue('program_context', value) : (row.program_context = value);
function metadata(value) {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
  return value;
}

// Read model only. A program's appointment is included in the purchased package,
// never repriced from today's first treatment. No economic totals are exposed.
// At most two bounded queries per batch; ordinary appointments cost no query.
async function attachAppointmentProgramContexts(db, appointments) {
  const rows = (Array.isArray(appointments) ? appointments : [appointments]).filter(Boolean);
  const hasReference = require('../lib/program-appointment-context').hasProgramAppointmentReference;
  for (const row of rows) setContext(row, hasReference(row)
    ? { kind: 'program', status: 'unavailable' } : null);
  const programRows = rows.filter(row => hasReference(row) && positiveId(plain(row).id_cita));
  if (!db.PatientProgramSession || !db.PatientVoucher) return appointments;
  for (let offset = 0; offset < programRows.length; offset += 200) {
    const batch = programRows.slice(offset, offset + 200);
    const sessions = (await db.PatientProgramSession.findAll({
      where: { appointment_id: { [Op.in]: [...new Set(batch.map(row => Number(plain(row).id_cita)))] } },
      attributes: ['id', 'appointment_id', 'voucher_id', 'session_key', 'position',
        [literal("JSON_EXTRACT(`snapshot`, '$.treatment_ids')"), 'consent_treatment_ids']], raw: true,
    })).map(plain);
    const voucherIds = [...new Set(sessions.map(row => positiveId(row.voucher_id)).filter(Boolean))];
    if (!voucherIds.length) continue;
    const vouchers = (await db.PatientVoucher.findAll({
      where: { id: { [Op.in]: voucherIds } },
      attributes: ['id', 'clinic_id', 'patient_id', 'name', 'total_units', 'source_system'], raw: true,
    })).map(plain);
    const byVoucher = new Map(vouchers.map(row => [Number(row.id), row]));
    const byAppointment = new Map();
    for (const session of sessions) {
      const id = Number(session.appointment_id);
      // A corrupt/ambiguous relation is not an excuse to show another purchase.
      byAppointment.set(id, byAppointment.has(id) ? null : session);
    }
    for (const row of batch) {
      const appointment = plain(row), session = byAppointment.get(Number(appointment.id_cita));
      const voucher = session && byVoucher.get(Number(session.voucher_id));
      const reference = metadata(appointment.import_metadata)?.program_session;
      const position = Number(session?.position), count = Number(voucher?.total_units);
      if (!session || !voucher || !positiveId(appointment.voucher_id)
        || Number(appointment.voucher_id) !== Number(voucher.id)
        || !positiveId(appointment.clinica_id) || Number(voucher.clinic_id) !== Number(appointment.clinica_id)
        || !positiveId(appointment.paciente_id) || Number(voucher.patient_id) !== Number(appointment.paciente_id)
        || !positiveId(reference?.session_id) || Number(reference.session_id) !== Number(session.id)
        || reference.key !== session.session_key
        || !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(count) || count < 1 || position >= count
        || typeof voucher.name !== 'string' || !voucher.name.trim()) continue;
      // Only the verified purchased session supplies these IDs. Reading this
      // small JSON field avoids loading a large snapshot for every agenda card.
      const rawIds = metadata(session.consent_treatment_ids);
      const treatmentIds = voucher.source_system === 'treatment_program'
        && Array.isArray(rawIds) && rawIds.length > 0 && rawIds.length <= 250
        && rawIds.every(id => positiveId(id)) ? [...new Set(rawIds.map(Number))] : null;
      setContext(row, { kind: 'program', status: 'linked', name: voucher.name.trim().slice(0, 180),
        session_number: position + 1, session_count: count,
        ...(treatmentIds ? { treatment_ids: treatmentIds } : {}) });
    }
  }
  return appointments;
}

module.exports = { attachAppointmentProgramContexts };
