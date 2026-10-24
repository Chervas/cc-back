'use strict';
const C = require('../lib/clinical-episode-contract');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
function createClinicalAttendanceCorrectionService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input),
  now = () => new Date(), loadPatientLinks = (...args) => require('./appointmentPatientLinks.service').load(...args),
  hasClinicalHistory = (...args) => require('../lib/appointment-clinical-history').hasAppointmentClinicalHistory(...args),
  managedVisits, recordStatus = input => require('./appointmentActivity.service').recordAppointmentStatusChange(input) }) {
  async function correct({ appointmentId, clinicId, actorId, payload }) {
    if (!actorId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    appointmentId = C.integer(appointmentId); clinicId = C.integer(clinicId); actorId = C.integer(actorId);
    if (!C.object(payload) || Object.keys(payload).some(key => !['confirmed', 'reason', 'expected_status', 'expected_start', 'expected_end', 'idempotency_key'].includes(key)) || payload.confirmed !== true) throw C.error(428, 'clinical_attendance_confirmation_required', 'Confirma que el paciente sí acudió y que deseas corregir su asistencia antes de documentar.');
    if (!['no_asistio', 'reprogramada'].includes(payload.expected_status)) throw C.error(400, 'clinical_attendance_status_invalid', 'Esta corrección solo corresponde a una cita marcada No acude o Reprogramada.');
    const start = C.timestamp(payload.expected_start, 'expected_start'), end = C.timestamp(payload.expected_end, 'expected_end');
    const reason = C.text(payload.reason, 'attendance_correction_reason', 1000), key = C.idempotencyKey(payload.idempotency_key, true);
    if (!reason || reason.length < 5) throw C.error(400, 'clinical_attendance_reason_required', 'Indica el motivo de la corrección.');
    const hash = C.hash({ status: payload.expected_status, start, end, reason });
    const flags = await Promise.all(['patients.view', 'patients.sensitive.view', 'clinical.reports.manage', 'appointments.manage'].map(featureKey => canAccess({ actorId, clinicId, featureKey })));
    if (flags.some(flag => !flag)) throw C.error(403, 'access_policy_forbidden', 'No tienes permiso para corregir la asistencia clínica.');
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const initial = await db.CitaPaciente.findOne({ where: { id_cita: appointmentId, clinica_id: clinicId }, transaction });
      if (!initial?.paciente_id) throw C.error(404, 'appointment_not_found', 'Cita no encontrada en esta clínica.');
      const patient = await db.Paciente.findOne({ where: { id_paciente: initial.paciente_id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!patient || Number(patient.clinica_id) !== clinicId && !await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, transaction })) throw C.error(404, 'appointment_not_found', 'El paciente no pertenece a esta clínica.');
      await loadPatientLinks(db, appointmentId, transaction, true);
      const appointment = await db.CitaPaciente.findOne({ where: { id_cita: appointmentId, clinica_id: clinicId, paciente_id: patient.id_paciente }, transaction, lock: transaction.LOCK.UPDATE });
      if (!appointment) throw C.error(409, 'clinical_attendance_scope_changed', 'La cita ha cambiado de paciente o clínica. Vuelve a abrirla.');
      const previous = await db.AppointmentAttendanceCorrection.findOne({ where: { appointment_id: appointmentId, command_key: key }, transaction });
      if (previous) {
        if (previous.command_hash !== hash || Number(previous.actor_id) !== actorId || Number(previous.clinic_id) !== clinicId) throw C.error(409, 'clinical_attendance_request_conflict', 'Esta solicitud ya corresponde a otra corrección.');
        return { item: parse(previous.snapshot), replayed: true };
      }
      if (appointment.estado !== payload.expected_status || new Date(appointment.inicio).toISOString() !== start || new Date(appointment.fin).toISOString() !== end) throw C.error(409, 'clinical_attendance_schedule_changed', 'La cita ha cambiado de estado o de horario. Vuelve a revisarla antes de corregir la asistencia.');
      const at = now();
      if (new Date(appointment.inicio) > at) throw C.error(409, 'clinical_attendance_rescheduled_future', 'Esta reserva está programada para una fecha futura. No se puede marcar como asistida una cita trasladada; registra la consulta en su fecha real sin modificar esta reserva.');
      if (appointment.es_provisional || appointment.care_legacy_attendance || appointment.arrived_at || appointment.care_started_at || appointment.care_completed_at || await hasClinicalHistory(db, appointmentId, transaction)) throw C.error(409, 'clinical_attendance_history_preserved', 'La cita ya conserva asistencia o historia clínica. Consulta su registro antes de realizar una corrección.');
      const metadata = parse(appointment.import_metadata);
      if (metadata.clinical_component_parent || metadata.clinical_component_children) throw C.error(409, 'clinical_attendance_component_review', 'Esta cita forma parte de un trabajo clínico vinculado. Revisa sus componentes antes de corregir la asistencia.');
      const managed = managedVisits || (db.AppointmentVisitMember && db.AppointmentVisit ? require('./appointmentVisitManaged.service').current() : null);
      const proof = managed ? await managed.prepareMutation({ appointmentId, clinicId, actorId, transaction }) : null;
      const previousStatus = appointment.estado;
      // Record the correction now, for the unchanged reservation. Never invent a
      // past arrival, start, completion or restore a superseded reservation date.
      await appointment.update({ estado: 'ha_acudido', arrived_at: at, arrived_by: actorId, care_schedule_start: appointment.inicio,
        care_started_at: null, care_started_by: null, care_completed_at: null, care_completed_by: null, updated_by: actorId }, { transaction });
      if (proof) await managed.persistMutation(proof, { appointment, transaction, suppressCommunications: true });
      const event = await db.AppointmentCareEvent.create({ appointment_id: appointmentId, clinic_id: clinicId, actor_id: actorId, action: 'attendance_corrected', schedule_start: appointment.inicio, created_at: at }, { transaction });
      await recordStatus({ appointment, previousStatus, newStatus: 'ha_acudido', actorUserId: actorId, source: 'historia', administrativeRestore: true,
        metadata: { care_action: 'attendance_corrected', reason, care_event_id: event.id, recorded_at: at.toISOString() }, occurredAt: at, transaction, eventModel: db.PatientOperationalEvent });
      const clinic = await db.Clinica.findByPk(clinicId, { transaction });
      const timeZone = require('./clinicOpeningHours.service').resolveClinicTimeZone(clinic);
      const item = { appointment_id: appointmentId, patient_id: Number(patient.id_paciente), clinic_id: clinicId, estado: 'ha_acudido', inicio: start, fin: end,
        recorded_at: at.toISOString(), care: require('../lib/appointment-care').careState(appointment, at, { timeZone }) };
      await db.AppointmentAttendanceCorrection.create({ appointment_id: appointmentId, clinic_id: clinicId, actor_id: actorId, command_key: key, command_hash: hash, reason, snapshot: item }, { transaction });
      return { item, replayed: false };
    });
  }
  return { correct };
}
let singleton;
module.exports = { createClinicalAttendanceCorrectionService, correct: input => { singleton ||= createClinicalAttendanceCorrectionService({ db: require('../../models') }); return singleton.correct(input); } };
