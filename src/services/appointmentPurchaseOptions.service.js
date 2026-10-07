'use strict';

// A read-only appointment projection, not the patient's full billing workspace.
// Balances, reservations and programme scheduling decisions belong to the server.
function createAppointmentPurchaseOptions({ db = require('../../models'), economics = require('./patientEconomics.service'), programs = require('./patientProgramBooking.service'), now = () => new Date() } = {}) {
  const { Op } = db.Sequelize;
  const { activeAppointmentWhere } = require('./voucherScheduleAvailability.service');
  const { requireOperationalProfile, loadScopedTreatment } = require('./treatmentBookingProfile.service');
  async function read({ clinicId, patientIdentifier, actorId }) {
    const { patient, clinic } = await economics.loadContext(patientIdentifier, clinicId);
    const vouchers = await db.PatientVoucher.findAll({ where: { clinic_id: clinicId, patient_id: patient.id_paciente, status: 'active' }, order: [['name', 'ASC']] });
    const ids = vouchers.map(row => row.id);
    const [appointments, consumptions, started] = await Promise.all([
      ids.length ? db.CitaPaciente.findAll({ where: { voucher_id: { [Op.in]: ids }, clinica_id: clinicId, paciente_id: patient.id_paciente, ...activeAppointmentWhere(Op) }, attributes: ['id_cita', 'voucher_id'] }) : [],
      ids.length ? db.PatientVoucherMovement.findAll({ where: { voucher_id: { [Op.in]: ids }, movement_type: 'consumption' }, attributes: ['voucher_id', 'appointment_id'] }) : [],
      db.CitaPaciente.findAll({ where: require('../lib/treatment-booking-visibility').initiatedTreatmentWhere(Op, {
        clinicId, patientId: patient.id_paciente, now: now() }), attributes: ['tratamiento_id'], group: ['tratamiento_id'], raw: true }),
    ]);
    const items = [];
    for (const voucher of vouchers) {
      if (voucher.expires_at && new Date(voucher.expires_at) <= now()) continue;
      if (voucher.source_system === 'treatment_program') {
        try {
          const plan = await programs.read({ publicId: voucher.public_id, clinicId, actorId });
          items.push({ id: voucher.public_id, name: plan.name, kind: plan.kind === 'voucher' ? 'voucher' : 'program', scheduler: 'program', pending_count: plan.pending_count,
            available_units: Number(voucher.available_units), unit_label: voucher.unit_label,
            can_schedule: plan.can_schedule || plan.can_resume, next_session: plan.sessions.find(row => ['pending', 'missed'].includes(row.scheduling_status))?.label || null,
            reason: plan.can_schedule || plan.can_resume ? null : plan.resume?.blocked_reason || 'No hay sesiones disponibles para citar.' });
        } catch (error) {
          if (![409, 503].includes(error.statusCode)) throw error;
          items.push({ id: voucher.public_id, name: voucher.name, kind: 'program', scheduler: 'program', can_schedule: false, reason: error.message, pending_count: null });
        }
        continue;
      }
      let treatment;
      try {
        treatment = await loadScopedTreatment({ db, treatmentId: voucher.treatment_id, clinic });
        if (!treatment) continue;
        require('../lib/treatment-commercial-policy').assertStandalone(treatment);
        requireOperationalProfile(treatment);
      } catch (error) {
        if (![404, 409, 422].includes(error.statusCode || error.status)) throw error;
        continue;
      }
      const reserved = appointments.filter(row => String(row.voucher_id) === String(voucher.id) && !consumptions.some(movement => String(movement.voucher_id) === String(voucher.id) && Number(movement.appointment_id) === Number(row.id_cita))).length;
      const pending = Math.max(0, Math.floor(Number(voucher.available_units)) - reserved);
      items.push({ id: voucher.public_id, name: voucher.name, kind: 'voucher', scheduler: 'voucher', treatment_name: treatment.nombre, badge: treatment.clinical_config?.catalog_badge || null,
        available_units: Number(voucher.available_units), pending_count: pending, unit_label: voucher.unit_label, can_schedule: pending > 0,
        reason: pending > 0 ? null : 'Las sesiones disponibles ya tienen cita.' });
    }
    return { items, started_treatment_ids: started.map(row => String(row.tratamiento_id)) };
  }
  return { read };
}
module.exports = { createAppointmentPurchaseOptions, read: options => createAppointmentPurchaseOptions().read(options) };
