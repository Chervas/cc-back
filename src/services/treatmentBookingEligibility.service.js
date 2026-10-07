'use strict';

const { bookingVisibility, initiatedTreatmentWhere } = require('../lib/treatment-booking-visibility');
const { bookingError } = require('./treatmentBookingProfile.service');
const { hash } = require('../lib/cliniccloud-import/adapter');
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const json = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };
const denied = () => { throw bookingError('booking_continuation_required',
  'Este tratamiento sólo admite continuar una atención iniciada o una compra vigente del mismo paciente y clínica.', { can_force: false }); };
const same = (left, right) => positiveId(left) != null && positiveId(left) === positiveId(right);

async function voucherProof({ db, values, treatmentId, transaction, programSessionId, now }) {
  if (!positiveId(values.voucher_id)) return false;
  const { Op } = db.Sequelize;
  const voucher = await db.PatientVoucher.findOne({ where: { id: values.voucher_id,
    clinic_id: values.clinica_id, patient_id: values.paciente_id }, transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  // Recheck ownership, not merely the presence of a submitted voucher ID.
  if (!voucher || !same(voucher.id, values.voucher_id) || !same(voucher.clinic_id, values.clinica_id) || !same(voucher.patient_id, values.paciente_id)
    || voucher.status !== 'active' || !Number.isFinite(Number(voucher.available_units)) || Number(voucher.available_units) < 1) return false;
  if (voucher.expires_at) {
    const expiry = new Date(voucher.expires_at).getTime(), end = new Date(values.fin).getTime();
    if (!Number.isFinite(expiry) || expiry <= now.getTime() || !Number.isFinite(end) || end > expiry) return false;
  }
  const reserved = await db.CitaPaciente.findAll({ where: { voucher_id: voucher.id,
    clinica_id: voucher.clinic_id, paciente_id: voucher.patient_id,
    estado: voucher.source_system === 'treatment_program' ? { [Op.notIn]: ['cancelada', 'no_asistio', 'completada'] } : { [Op.ne]: 'cancelada' } },
    attributes: ['id_cita'], transaction });
  const movements = reserved.length ? await db.PatientVoucherMovement.findAll({ where: { voucher_id: voucher.id,
    movement_type: 'consumption', appointment_id: { [Op.in]: reserved.map(row => row.id_cita) } },
    attributes: ['appointment_id'], transaction }) : [];
  const used = new Set(movements.map(row => String(row.appointment_id)));
  if (reserved.filter(row => !used.has(String(row.id_cita))).length >= Math.floor(Number(voucher.available_units))) return false;
  if (voucher.source_system !== 'treatment_program') return same(voucher.treatment_id, treatmentId) ? { voucher } : false;

  // A programme flag/snapshot in request JSON is never proof of a purchase.
  // Read the actual session ledger, accepted budget line, and frozen purchase.
  if (!positiveId(programSessionId)) return false;
  const session = await db.PatientProgramSession.findOne({ where: { id: programSessionId, voucher_id: voucher.id },
    transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!session || !same(session.id, programSessionId) || !same(session.voucher_id, voucher.id) || session.consumption_movement_id) return false;
  if (session.appointment_id) {
    const previous = await db.CitaPaciente.findByPk(session.appointment_id, { transaction });
    if (!previous || !same(previous.voucher_id, voucher.id) || !same(previous.clinica_id, voucher.clinic_id)
      || !same(previous.paciente_id, voucher.patient_id) || !['cancelada', 'no_asistio'].includes(previous.estado)) return false;
  }
  const budget = await db.EconomicBudget.findOne({ where: { id: voucher.budget_id,
    clinic_id: voucher.clinic_id, patient_id: voucher.patient_id }, transaction });
  if (!budget || !same(budget.id, voucher.budget_id) || !same(budget.clinic_id, voucher.clinic_id) || !same(budget.patient_id, voucher.patient_id)) return false;
  let accepted = budget.status === 'accepted';
  if (budget.status === 'partially_accepted') {
    const event = await db.EconomicBudgetEvent.findOne({ where: { budget_id: budget.id,
      version_number: budget.current_version, event_type: 'partially_accepted' }, order: [['id', 'DESC']], transaction });
    const keys = json(event?.metadata || {})?.accepted_line_keys;
    accepted = Array.isArray(keys) && keys.includes(voucher.budget_line_key);
  }
  if (!accepted) return false;
  const version = await db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction });
  const lines = json(version?.lines || []);
  if (!Array.isArray(lines)) return false;
  const line = lines.find(row => row.key === voucher.budget_line_key);
  const purchase = require('../lib/economicProgramSnapshot').operationalSnapshot(line?.program_snapshot);
  if (session.snapshot_sha256 !== purchase.sha256 || Number(voucher.total_units) !== purchase.appointments.length) return false;
  const definition = purchase.appointments.find(row => row.key === session.session_key);
  if (!definition || Number(session.position) !== purchase.appointments.indexOf(definition)
    || !definition.treatment_ids?.some(id => same(id, treatmentId))
    || !same(definition.treatment_ids[0], values.tratamiento_id)) return false;
  const frozen = json(session.snapshot);
  if (!frozen || !Array.isArray(frozen.treatment_ids) || !Array.isArray(frozen.treatments)
    || !frozen.booking_profile || !Object.hasOwn(frozen, 'program_cadence')) return false;
  const materialized = require('../lib/program-booking').materializeSession(definition, frozen?.duration_selection || {});
  const valid = frozen?.key === definition.key && hash(frozen.treatment_ids) === hash(definition.treatment_ids)
    && hash(frozen.treatments) === hash(definition.treatments)
    && hash(frozen.booking_profile) === hash(materialized.booking_profile)
    && frozen.duration_minutes === materialized.duration_minutes
    && hash(frozen.program_cadence) === hash(purchase.cadence);
  return valid ? { voucher, programSession: session } : false;
}

async function assertTreatmentBookingVisibility({ db, treatment, appointmentValues = {}, existingAppointmentId = null,
  programSessionId = null, transaction = null, ignoreAppointmentId = null, now = new Date() }) {
  if (bookingVisibility(treatment) !== 'continuation_only') return;
  const values = appointmentValues, treatmentId = positiveId(treatment?.id_tratamiento);
  if (!treatmentId || !positiveId(values.clinica_id) || !positiveId(values.paciente_id)) denied();
  if (positiveId(existingAppointmentId)) {
    const existing = await db.CitaPaciente.findByPk(existingAppointmentId, { transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (existing && same(existing.clinica_id, values.clinica_id) && same(existing.paciente_id, values.paciente_id)
      && same(existing.tratamiento_id, treatmentId)
      && String(existing.voucher_id ?? '') === String(values.voucher_id ?? '')) return;
  }
  // A submitted purchase must stand on its own. Started care cannot waive the
  // purchase's owner, session identity, activation, expiry or remaining units.
  if (values.voucher_id != null && values.voucher_id !== '') {
    const proof = await voucherProof({ db, values, treatmentId, transaction, programSessionId, now });
    if (proof) return proof;
    denied();
  }
  // Submitted tipo_cita, care_started_at, source_system, import_metadata and
  // allowObsolete never participate in this decision.
  const started = await db.CitaPaciente.findAll({ where: initiatedTreatmentWhere(db.Sequelize.Op, {
    clinicId: values.clinica_id, patientId: values.paciente_id, treatmentId,
    ignoreAppointmentId: ignoreAppointmentId || existingAppointmentId, now,
  }), attributes: ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'estado', 'care_started_at', 'fin'], transaction });
  if (started.some(row => same(row.clinica_id, values.clinica_id) && same(row.paciente_id, values.paciente_id)
    && same(row.tratamiento_id, treatmentId) && !['cancelada', 'no_asistio'].includes(row.estado)
    && (!ignoreAppointmentId || !same(row.id_cita, ignoreAppointmentId))
    && (!existingAppointmentId || !same(row.id_cita, existingAppointmentId))
    && (row.estado === 'completada' && Number.isFinite(new Date(row.fin).getTime()) && new Date(row.fin) <= now
      || row.care_started_at && Number.isFinite(new Date(row.care_started_at).getTime())
      && new Date(row.care_started_at) <= now))) return;
  denied();
}

module.exports = { assertTreatmentBookingVisibility };
