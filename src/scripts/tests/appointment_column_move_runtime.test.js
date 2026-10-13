'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../lib/appointment-visit-communication');
const r = require('../../lib/appointment-visit-runtime-contract');
const { createAppointmentVisitRuntimeService } = require('../../services/appointmentVisitRuntime.service');
const { fixture, combinedAppointment, NOW } = require('./helpers/appointment-visit-fixture');
const { enrolledVisit, template } = require('./helpers/appointment-visit-runtime-fixture');
const reminders = require('../../lib/appointment-visit-reminder-policy');

async function movement({ timeChanged = false, treatmentChanged = false, enabled = true } = {}) {
  const row = combinedAppointment(), f = fixture({ rows: [row] });
  const nodes = event => [{ id: 'T', type: 'trigger/' + event, outputs: { on_success: 'S' } },
    { id: 'S', type: 'action/send_whatsapp', config: {}, outputs: { on_success: 'E' } },
    { id: 'E', type: 'control/end', outputs: {} }];
  const move = template({ trigger_type: 'appointment_rescheduled', nodes: nodes('appointment_rescheduled') });
  const reminder = template({ id: 43, public_id: 'fixture_day_before', template_key: 'fixture_day_before',
    trigger_type: 'appointment_reminder_window', trigger_config: { schedule_moment: 'day_before' }, nodes: nodes('appointment_reminder_window') });
  const compiled = r.compiledContract(r.compileEnrollmentContract({ clinicId: 66, timeZone: 'Europe/Madrid', manifests: [
    { template: move, stages: [{ key: 'details', node_ids: ['S'] }] },
    { template: reminder, stages: [{ key: 'attendance_day_before', node_ids: ['S'] }] },
  ], reminderBindings: [reminders.binding({ templateVersionId: 43, stageKey: 'attendance_day_before', fireGraceMs: 3600000,
    schedulePolicy: { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00',
      exclude_if_booked_day_before: false, exclude_if_booked_same_day: false, exclude_if_not_confirmed: false, only_if_not_confirmed: false } })] }));
  const visit = { ...enrolledVisit({ row }), status: 'active' };
  visit.runtime_enrollment = { ...visit.runtime_enrollment, ...compiled, reminder_booked_at: NOW };
  visit.runtime_enrollment_sha256 = v.hash(visit.runtime_enrollment);
  f.seed('AppointmentVisit', visit);
  f.seed('AppointmentVisitMember', { appointment_id: row.id_cita, visit_id: visit.id, clinic_id: 66, patient_id: 8, role: 'primary', evidence: {} });
  f.db.AppointmentVisitBirthRequest = {};
  f.db.AutomationFlowTemplateV2 = { findByPk: async id => [move, reminder].find(item => item.id === id) };
  const create = f.db.PatientOperationalEvent.create;
  f.db.PatientOperationalEvent.create = (values, options) => create({ id: '101', ...values }, { ...options, hooks: false });
  f.db.PatientOperationalEvent.findAll = async options => [...options.transaction.data.PatientOperationalEvent.values()]
    .filter(event => event.metadata.mutation.visit_id === options.where.metadata.mutation.visit_id
      && event.metadata.mutation.communication_revision === options.where.metadata.mutation.communication_revision);
  const claims = [];
  const foundation = { ...f.service, claimCommunication: async options => {
    claims.push(options); return { communication: { id: String(claims.length), communication_revision: options.expectedRevision } };
  } };
  const runtime = createAppointmentVisitRuntimeService({ db: f.db, foundation, now: () => new Date(NOW) });
  const result = await f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const proof = await runtime.prepareCanonicalMutation({ appointmentId: row.id_cita, clinicId: 66, actorId: 7, transaction });
    const stored = transaction.data.CitaPaciente.get(String(row.id_cita));
    stored.doctor_id = 52; stored.instalacion_id = 77;
    stored.import_metadata.booking.phases[1].installation_id = 77;
    stored.import_metadata.booking.phases[1].doctor_ids = [52];
    stored.reschedule_reason = 'clinic_schedule';
    if (timeChanged) {
      const shift = value => new Date(Date.parse(value) + 300000).toISOString();
      stored.inicio = shift(stored.inicio); stored.fin = shift(stored.fin);
      for (const phase of stored.import_metadata.booking.phases) {
        phase.start_at = shift(phase.start_at); phase.end_at = shift(phase.end_at);
        for (const interval of phase.staff_intervals) {
          interval.start_at = shift(interval.start_at); interval.end_at = shift(interval.end_at);
        }
      }
    }
    if (treatmentChanged) stored.tratamiento_id = 689;
    return runtime.persistCanonicalMutation(proof, { appointment: stored, transaction, communicationEnabled: enabled });
  });
  return { result, claims };
}

test('managed same-time column movement suppresses only the immediate notice and retains future reminder planning', async () => {
  const { result, claims } = await movement();
  assert.equal(result.changed, true); assert.equal(result.visit.communication_revision, 2);
  assert.equal(result.event.metadata.mutation.suppressed, true);
  assert.equal(result.communication_held, 'appointment_notification_suppressed');
  assert.equal(result.reminders.planned, 1); assert.equal(claims.length, 1);
  assert.equal(claims[0].purpose, 'reminder_day_before'); assert.equal(claims[0].expectedRevision, 2);
});
test('actual time/treatment changes retain their ordinary immediate notice', async () => {
  for (const options of [{ timeChanged: true }, { treatmentChanged: true }]) {
    const { result, claims } = await movement(options);
    assert.equal(result.event.metadata.mutation.suppressed, false);
    assert.equal(claims.length, 2); assert.equal(claims[1].purpose, 'appointment_details');
  }
});
test('closed managed rollout never gains send rights from a column movement', async () => {
  const { result, claims } = await movement({ enabled: false });
  assert.equal(result.communication_held, 'visit_rollout_closed'); assert.equal(claims.length, 0);
});
