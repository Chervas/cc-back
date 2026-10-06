'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const operations = require('../../lib/whatsappImportedAppointmentOperations');
const now = Date.parse('2026-10-06T12:00:00.000Z');
const policy = operations.validate({ version: 1, purpose: 'appointment_operations', approvedBy: 1,
  approvalRef: 'user_approval_20261006', approvedAt: '2026-10-06T11:00:00.000Z',
  clinicIds: [66, 72], automaticBacklogReplay: false, sameDayAllowed: false }, { now });
function fixture() {
  class FixedDate extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/whatsappAppointmentEligibility'), 'utf8'), {
    module, Date: FixedDate, Intl, require(name) {
      if (name === './whatsappImportedReminderRelease') return { permits: () => false };
      if (name === './whatsappImportedAppointmentOperations') return {
        permits: (a, options) => operations.permits(a, { ...options, policy, now }),
        allowsSuppressionOverride: (a, options) => operations.allowsSuppressionOverride(a, { ...options, policy, now }),
      };
      if (name === './whatsappInboxHealth') return {};
      throw Error('unexpected_dependency');
    },
  });
  const appointment = { id_cita: 10, clinica_id: 66, paciente_id: 20, source_system: 'cliniccloud',
    source_reference: 'synthetic-source', estado: 'reprogramada', inicio: '2026-10-08T14:05:00.000Z',
    import_metadata: { cliniccloud_reconciliation: { automation_policy: 'hold' },
      notification_suppression: { appointment_details: true, day_before: true, same_day: true } } };
  const execution = { id: 50, clinic_id: 66, trigger_type: 'appointment_rescheduled',
    trigger_entity_type: 'appointment', trigger_entity_id: 10, created_at: '2026-10-06T11:30:00.000Z',
    context: { appointment: { id_cita: 10, clinica_id: 66, paciente_id: 20, inicio: appointment.inicio } } };
  const input = { appointment, execution, clinicId: 66, patientId: 20,
    templateName: 'clinicaclick_confirmacion_datos_cita_reprogramada_48_v7', now };
  const transport = { message: { metadata: { execution_id: 50 } }, conversation: { clinic_id: 66, patient_id: 20 },
    patientHeld: async () => true, loadExecution: async () => execution, loadAppointment: async () => appointment,
    payload: { type: 'template', template: { name: input.templateName } } };
  return { eligibility: module.exports, appointment, execution, input, transport };
}
test('fresh reschedule transport bypasses only the technical imported appointment and patient holds', async () => {
  const f = fixture(), before = JSON.stringify(f.appointment);
  assert.equal(f.eligibility.assertAppointmentEligibility(f.input), true);
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
  assert.equal(JSON.stringify(f.appointment), before);
});
test('stale executions, changed reservations and other-clinic substitutions cannot be sent', async () => {
  for (const change of [{ created_at: '2026-10-06T10:59:00Z' }, { clinic_id: 72 },
    { trigger_entity_id: 11 }, { context: { appointment: { inicio: '2026-10-08T14:00:00Z' } } }]) {
    const f = fixture(); Object.assign(f.execution, change);
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport));
  }
});
test('explicit manual suppression of details or day-before is still enforced at final transport', () => {
  for (const reason of [{ reason: 'manual_selection' }, { locked: true }, { manual_confirmation_required: true }]) {
    const f = fixture(); Object.assign(f.appointment.import_metadata.notification_suppression, reason);
    assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
    f.execution.trigger_type = 'appointment_reminder_window'; f.input.templateName = 'clinicaclick_recordatorio_dia_antes_v7';
    f.input.now = Date.parse('2026-10-07T09:00:00Z');
    assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
  }
});
test('same-day is blocked even for a custom template name or absent suppression defaults', () => {
  for (const templateName of ['clinicaclick_recordatorio_mismo_dia_v7', 'custom-reminder']) {
    const f = fixture(); f.execution.trigger_type = 'appointment_reminder_window';
    f.execution.context.trigger = { schedule_moment: 'same_day' }; f.input.templateName = templateName;
    f.appointment.import_metadata = { cliniccloud_reconciliation: { automation_policy: 'hold' } };
    assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
  }
});
test('the appointment exception does not release marketing, unknown entities or a patient globally', async () => {
  const f = fixture(); f.execution.trigger_entity_type = 'entity';
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport), { code: 'whatsapp_patient_import_held' });
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility({ message: { metadata: {} }, conversation: {} }), true);
});
test('cancelled appointments cannot receive reschedule details and reception health still guards timeouts', async () => {
  const f = fixture(); f.appointment.estado = 'cancelada';
  assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_ineligible' });
  f.appointment.estado = 'reprogramada'; f.transport.message.metadata.appointment_timeout = true;
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
    getReceptionState: async () => ({ readyForTimeout: false }) }), { code: 'whatsapp_inbox_reception_delayed' });
});
