'use strict';

const crypto = require('node:crypto');
const { domainError } = require('../lib/treatmentPrograms.contract');
const { programBookingEnabled } = require('../lib/program-booking');
const { enrollmentRequest, freezeProgramEnrollment, readProgramEnrollment, enrollmentDto } = require('../lib/patient-program-enrollment');
function createPatientProgramEnrollmentService({ db, programs = require('./treatmentPrograms.service'), enabled = programBookingEnabled,
  capabilities = require('./treatmentBookingProfile.service').bookingCapabilities,
  now = () => new Date(), newId = () => crypto.randomUUID() }) {
  async function assign({ patientIdentifier, clinicId, actorId, payload }) {
    if (!enabled()) throw domainError(503, 'program_booking_disabled', 'La asignación de programas no está habilitada en este entorno.');
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const clinic = await db.Clinica.findByPk(clinicId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!clinic) throw domainError(404, 'clinic_not_found', 'Clínica no encontrada.');
      const numeric = /^[1-9]\d*$/.test(String(patientIdentifier));
      const patient = await db.Paciente.findOne({ where: numeric ? { id_paciente: Number(patientIdentifier) } : { public_id: String(patientIdentifier) },
        transaction, lock: transaction.LOCK.UPDATE });
      if (!patient || Number(patient.clinica_id) !== Number(clinicId)
        && !await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, transaction })) {
        throw domainError(404, 'patient_not_in_clinic', 'El paciente no pertenece a esta clínica.');
      }
      const request = enrollmentRequest(payload, { clinicId, patientId: patient.id_paciente, actorId });
      const previous = await db.PatientVoucher.findOne({ where: { clinic_id: clinicId, source_system: 'treatment_program', source_reference: request.source_reference }, transaction });
      if (previous) {
        const sealed = readProgramEnrollment(previous, { required: true });
        if (Number(previous.patient_id) !== Number(patient.id_paciente) || sealed.enrollment.request_sha256 !== request.request_sha256) {
          throw domainError(409, 'program_enrollment_request_conflict', 'Esta solicitud ya asignó un programa con otros datos.');
        }
        return enrollmentDto(previous, sealed, true);
      }
      // The patient lock serializes double-clicks and new UUIDs for the same
      // active program. A 409 offers the actual plan, not a second enrollment.
      const active = await db.PatientVoucher.findAll({ where: { clinic_id: clinicId, patient_id: patient.id_paciente,
        source_system: 'treatment_program', budget_id: null, status: 'active' }, transaction });
      for (const row of active) {
        if (row.expires_at && new Date(row.expires_at) <= now()) continue;
        const sealed = readProgramEnrollment(row, { required: true });
        if (sealed.program_id === request.program_id) throw domainError(409, 'program_enrollment_already_active',
          'Este paciente ya tiene este programa asignado. Continúa con su planificación.', {
            voucher_id: row.public_id, program_id: sealed.program_id, program_version: sealed.program_version,
            commercial_status: 'not_contracted', catalog_reference_amount: sealed.catalog_total_price,
          });
      }
      const program = await programs.resolveForBudget({ id: request.program_id, clinicId, version: request.program_version, transaction });
      if (Number(program.clinic_id) !== Number(clinicId) || program.id !== request.program_id || program.version !== request.program_version) {
        throw domainError(409, 'program_enrollment_catalog_changed', 'El catálogo ha cambiado. Vuelve a seleccionar el programa de esta clínica.');
      }
      const sealed = freezeProgramEnrollment(program, request, now());
      for (const session of require('../lib/economicProgramSnapshot').operationalSnapshot(sealed).appointments) {
        require('./treatmentBookingProfile.service').assertOperationalBookingProfile(session.booking_profile, { capabilities: capabilities() });
      }
      const voucher = await db.PatientVoucher.create({ public_id: newId(), clinic_id: clinicId, patient_id: patient.id_paciente,
        budget_id: null, budget_line_key: null, program_snapshot: sealed, treatment_id: null, name: sealed.name.slice(0, 180),
        unit_label: 'citas', total_units: sealed.appointments.length, available_units: sealed.appointments.length - (request.start_from_position || 1) + 1,
        sold_amount: 0, activation_rule: 'manual', status: 'active', expires_at: null,
        source_system: 'treatment_program', source_reference: request.source_reference, created_by: actorId }, { transaction });
      await db.PatientOperationalEvent.create({ patient_id: patient.id_paciente, clinic_id: clinicId, actor_user_id: actorId,
        event_type: 'program.enrolled', source: 'agenda', channel: null, occurred_at: now(),
        metadata: { origin: 'program_enrollment', voucher_id: voucher.public_id, program_id: sealed.program_id,
          program_version: sealed.program_version, snapshot_sha256: sealed.sha256, initial_units: Number(voucher.available_units),
          ...(request.start_from_position > 1 ? { start_from_position: request.start_from_position, unrecorded_units: request.start_from_position - 1,
            managed_units: Number(voucher.available_units), prior_sessions: 'unrecorded' } : {}),
          request_key: request.request_key, request_sha256: request.request_sha256, budget_created: false, payment_created: false } }, { transaction });
      // No budget, economic acceptance, money/unit movement, signature package
      // or sender hook is called. Care completion owns future unit consumption.
      return enrollmentDto(voucher, sealed, false);
    });
  }
  return { assign };
}
let instance;
module.exports = { createPatientProgramEnrollmentService,
  assign: options => (instance ||= createPatientProgramEnrollmentService({ db: require('../../models') })).assign(options) };
