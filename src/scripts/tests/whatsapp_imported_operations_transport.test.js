'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const operations = require('../../lib/whatsappImportedAppointmentOperations');
const now = Date.parse('2026-10-06T12:00:00.000Z');
const policy = operations.validate({ version: 1, purpose: 'appointment_operations', approvedBy: 1,
  approvalRef: 'user_approval_20261006', approvedAt: '2026-10-06T11:00:00.000Z',
  clinicIds: [66, 72], automaticBacklogReplay: false, sameDayAllowed: false }, { now });
function fixture({ sameDayAllowed = false } = {}) {
  const operationalPolicy = operations.validate({ ...policy, sameDayAllowed }, { now });
  class FixedDate extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/whatsappAppointmentEligibility'), 'utf8'), {
    module, Date: FixedDate, Intl, require(name) {
      if (name === './appointment-synthetic-guard') return require('../../lib/appointment-synthetic-guard');
      if (name === './appointment-care') return require('../../lib/appointment-care');
      if (name === './whatsapp-failure-diagnostic') return require('../../lib/whatsapp-failure-diagnostic');
      if (name === './whatsappSameDayRecovery') return { permits: () => false };
      if (name === './whatsappImportedReminderRelease') return { permits: () => false };
      if (name === './whatsappImportedAppointmentOperations') return {
        permits: (a, options) => operations.permits(a, { ...options, policy: operationalPolicy, now }),
        permitsSameDay: (a, options) => operations.permitsSameDay(a, { ...options, policy: operationalPolicy, now }),
        permitsPatientHoldOverride: (a, options) => operations.permitsPatientHoldOverride(a, { ...options, policy: operationalPolicy, now }),
        allowsSuppressionOverride: (a, options) => operations.allowsSuppressionOverride(a, { ...options, policy: operationalPolicy, now }),
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

function nativeFixture(options) {
  const f = fixture(options); Object.assign(f.appointment, { source_system: null, source_reference: null,
    import_metadata: {}, estado: 'info_enviada' });
  f.execution.trigger_type = 'appointment_created';
  f.input.templateName = 'clinicaclick_confirmacion_datos_cita_48_v7';
  f.transport.payload.template.name = f.input.templateName;
  return f;
}

test('new native booking for an imported patient can send current details without removing its patient hold', async () => {
  const f = nativeFixture(), before = JSON.stringify(f.appointment);
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
    conversation: { clinic_id: 66 } }), true);
  assert.equal(JSON.stringify(f.appointment), before);
});

test('native booking override is not global: old execution, marketing, changed date or scope stays blocked', async () => {
  for (const change of [{ created_at: '2026-10-06T10:59:00Z' }, { clinic_id: 72 },
    { trigger_entity_type: 'entity' }, { trigger_type: 'lead_created' }, { trigger_entity_id: 11 },
    { context: { appointment: { ...nativeFixture().execution.context.appointment, paciente_id: 21 } } },
    { context: { appointment: { inicio: '2026-10-08T14:00:00Z' } } }]) {
    const f = nativeFixture(); Object.assign(f.execution, change);
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport));
  }
  const f = nativeFixture();
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
    message: { metadata: { communication_scope: 'marketing' } } }), { code: 'whatsapp_patient_import_held' });
});

test('an appointment execution never exempts a held patient from marketing suppression', async () => {
  for (const build of [fixture, nativeFixture]) {
    const f = build();
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
      message: { metadata: { execution_id: 50, communication_scope: 'marketing' } } }),
    { code: 'whatsapp_patient_import_held' });
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
      conversation: { clinic_id: 66 },
      message: { metadata: { execution_id: 50, communication_scope: ' MARKETING ' } } }),
    { code: 'whatsapp_patient_import_held' });
    assert.equal(await f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
      patientHeld: async () => false,
      message: { metadata: { execution_id: 50, communication_scope: 'marketing' } } }), true);
  }
});

test('native booking override preserves manual suppression and keeps same-day closed without explicit authorization', async () => {
  const f = nativeFixture(); f.appointment.import_metadata.notification_suppression = { appointment_details: true };
  assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
  for (const templateName of ['clinicaclick_recordatorio_mismo_dia_v7']) {
    const g = nativeFixture(); g.execution.trigger_type = 'appointment_reminder_window';
    g.execution.context.trigger = { schedule_moment: 'same_day' }; g.transport.payload.template.name = templateName;
    await assert.rejects(g.eligibility.assertAutomatedMessageEligibility(g.transport), { code: 'whatsapp_appointment_suppressed' });
  }
});

function sameDayFixture({ native = false, sameDayAllowed = true, templateName = 'clinicaclick_recordatorio_mismo_dia_v7' } = {}) {
  const f = (native ? nativeFixture : fixture)({ sameDayAllowed });
  f.appointment.inicio = '2026-10-06T14:05:00.000Z';
  f.execution.context.appointment.inicio = f.appointment.inicio;
  f.execution.trigger_type = 'appointment_reminder_window';
  f.execution.context.trigger = { schedule_moment: 'same_day' };
  f.input.templateName = templateName;
  f.transport.payload.template.name = templateName;
  return f;
}

test('explicit operational authorization permits same-day imported and native-patient-HOLD reminders without altering provenance', async () => {
  for (const native of [false, true]) for (const templateName of ['clinicaclick_recordatorio_mismo_dia_v7']) {
    const f = sameDayFixture({ native, templateName }), before = JSON.stringify(f.appointment);
    assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
    assert.equal(JSON.stringify(f.appointment), before);
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
      message: { metadata: { execution_id: 50, communication_scope: 'marketing' } } }),
    { code: 'whatsapp_patient_import_held' });
  }
});

test('same-day release preserves manual, locked, aliased and native appointment suppressions at final transport', async () => {
  for (const extra of [{ reason: 'manual_selection' }, { locked: true }, { locked: false },
    { manual_confirmation_required: true }, { sameDay: true }]) {
    const f = sameDayFixture(); Object.assign(f.appointment.import_metadata.notification_suppression, extra);
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport), { code: 'whatsapp_appointment_suppressed' });
  }
  const native = sameDayFixture({ native: true });
  native.appointment.import_metadata.notification_suppression = { same_day: true };
  await assert.rejects(native.eligibility.assertAutomatedMessageEligibility(native.transport), { code: 'whatsapp_appointment_suppressed' });
  native.appointment.import_metadata = { automation_policy: 'hold' };
  await assert.rejects(native.eligibility.assertAutomatedMessageEligibility(native.transport), { code: 'whatsapp_patient_import_held' });
});

test('authorized same-day sends still reject stale execution, changed scope/date/status and wrong-day or expired appointments', async () => {
  for (const change of [{ created_at: '2026-10-06T10:59:00Z' }, { clinic_id: 72 }, { trigger_entity_id: 11 },
    { context: { appointment: { inicio: '2026-10-06T14:00:00Z' }, trigger: { schedule_moment: 'same_day' } } }]) {
    const f = sameDayFixture(); Object.assign(f.execution, change);
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport));
  }
  for (const change of [{ clinica_id: 99 }, { paciente_id: 21 }, { estado: 'cancelada' }, { estado: 'completada' },
    { es_provisional: true }, { inicio: '2026-10-06T11:59:00.000Z' }, { inicio: '2026-10-06T14:06:00.000Z' },
    { import_metadata: { historical_registration: true } }, { import_metadata: { synthetic_data_only: true } }]) {
    const f = sameDayFixture(); Object.assign(f.appointment, change);
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport));
  }
  for (const templateName of ['clinicaclick_recordatorio_mismo_dia_v7']) {
    const f = sameDayFixture({ templateName });
    f.appointment.inicio = '2026-10-07T14:05:00.000Z'; f.execution.context.appointment.inicio = f.appointment.inicio;
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport), { code: 'whatsapp_appointment_wrong_day' });
  }
  const f = sameDayFixture(); f.execution.context = JSON.stringify(f.execution.context);
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
});

test('an unheld native patient retains the existing same-day reminder behavior', async () => {
  const f = nativeFixture(); f.appointment.inicio = '2026-10-06T14:05:00.000Z';
  f.execution.context.appointment.inicio = f.appointment.inicio;
  f.execution.trigger_type = 'appointment_reminder_window';
  f.execution.context.trigger = { schedule_moment: 'same_day' };
  f.input.templateName = 'clinicaclick_recordatorio_mismo_dia_v7';
  f.transport.payload.template.name = f.input.templateName;
  assert.equal(f.eligibility.assertAppointmentEligibility(f.input), true);
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility({ ...f.transport, patientHeld: async () => false }), true);
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport), { code: 'whatsapp_appointment_suppressed' });
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
test('an actual same-day reminder or no-response follow-up remains blocked without authorization even without suppression defaults', () => {
  for (const templateName of ['clinicaclick_recordatorio_mismo_dia_v7', 'no-response-followup']) {
    const f = fixture(); f.execution.trigger_type = 'appointment_reminder_window';
    f.execution.context.trigger = { schedule_moment: 'same_day' }; f.input.templateName = templateName;
    f.input.confirmationTimeout = templateName === 'no-response-followup';
    f.appointment.import_metadata = { cliniccloud_reconciliation: { automation_policy: 'hold' } };
    assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
  }
});

test('confirmation/cancellation acknowledgements inside a same-day reminder flow are not classified as another reminder', async () => {
  for (const sameDayAllowed of [false, true]) for (const estado of ['recordatorio_confirmado', 'cancelada']) {
    const f = sameDayFixture({ sameDayAllowed });
    f.appointment.estado = estado;
    f.transport.payload = { type: 'text', text: { body: 'Respuesta operativa de prueba' } };
    assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
    f.transport.payload = { type: 'template', template: { name: 'clinicaclick_recordatorio_mismo_dia_v7' } };
    if (estado === 'cancelada' || !sameDayAllowed) await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport));
  }
});

test('native patient-HOLD cancellation acknowledgement needs its narrowly verified reply callback; real reminders never use it', async () => {
  const f = sameDayFixture({ native: true });
  f.appointment.estado = 'cancelada'; f.execution.status = 'running';
  f.execution.context.last_response_context = { response_message_id: 200 };
  f.transport.conversation.id = 60;
  Object.assign(f.transport.message, { id: 300, conversation_id: 60, direction: 'outbound', message_type: 'text' });
  f.transport.payload = { type: 'text', text: { body: 'Cancelación confirmada' } };
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility(f.transport), { code: 'whatsapp_patient_import_held' });
  let calls = 0;
  const db = { sequelize: { query: async sql => /FROM Messages WHERE id=/.test(sql)
    ? [[{ id: 200, conversation_id: 60, direction: 'inbound', sent_at: '2026-10-06T11:55:00.000Z', receipt: {} }]]
    : [[{ ...f.execution, outbound_id: 100, outbound_conversation_id: 60, outbound_direction: 'outbound',
      outbound_message_type: 'template', outbound_status: 'delivered', outbound_created_at: '2026-10-06T11:35:00.000Z',
      outbound_sent_at: '2026-10-06T11:40:00.000Z', outbound_receipt: {} }]] } };
  const callback = async context => {
    calls++; assert.equal(context.appointment, f.appointment); assert.equal(context.execution, f.execution);
    return operations.permitsNativeReplyAcknowledgement(context.appointment, { ...context, db, policy, now });
  };
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility({ ...f.transport, loadNativeReplyAcknowledgement: callback }), true);
  assert.equal(calls, 1);
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
    loadNativeReplyAcknowledgement: async () => false }), { code: 'whatsapp_patient_import_held' });
  for (const payload of [{ type: 'template', template: { name: 'clinicaclick_recordatorio_mismo_dia_v7' } },
    { type: 'template', template: { name: 'clinicaclick_consent_required' } },
    { type: 'template', template: { name: 'clinicaclick_review' } }]) {
    await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport, payload,
      loadNativeReplyAcknowledgement: callback }), { code: 'whatsapp_patient_import_held' });
  }
  assert.equal(calls, 1);
});

test('real no-response follow-ups retain the manual suppression of the original reminder or details stage', () => {
  for (const source of ['imported', 'native']) for (const trigger_type of ['appointment_reminder_window', 'appointment_created']) {
    const f = (source === 'native' ? nativeFixture : fixture)({ sameDayAllowed: true });
    f.execution.trigger_type = trigger_type;
    f.execution.context.trigger = { schedule_moment: 'day_before' };
    f.input.templateName = 'operational-followup'; f.input.confirmationTimeout = true;
    f.appointment.import_metadata.notification_suppression = {
      day_before: true, appointment_details: true, reason: 'manual_selection', locked: true,
    };
    assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
  }
  const f = fixture({ sameDayAllowed: true });
  f.execution.trigger_type = 'appointment_reminder_window'; f.execution.context.trigger = { schedule_moment: 'day_before' };
  f.input.templateName = 'operational-followup'; f.input.confirmationTimeout = true;
  assert.equal(f.eligibility.assertAppointmentEligibility(f.input), true, 'technical importer defaults stay operationally authorized');
});

test('an explicit false timeout snapshot preserves initial reminder and ACK classification after the execution advances', async () => {
  const f = sameDayFixture(); f.appointment.estado = 'recordatorio_confirmado';
  f.execution.context.whatsapp_no_response_timeout = true;
  f.transport.message.metadata.appointment_timeout = false;
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
  f.appointment.estado = 'cancelada'; f.transport.payload = { type: 'text', text: { body: 'Cancelación confirmada' } };
  assert.equal(await f.eligibility.assertAutomatedMessageEligibility(f.transport), true);
  delete f.transport.message.metadata.appointment_timeout;
  await assert.rejects(f.eligibility.assertAutomatedMessageEligibility({ ...f.transport,
    getReceptionState: async () => ({ readyForTimeout: true }) }));
});

test('weekly manual suppression is never promoted to an importer technical default by the same-day authorization', () => {
  for (const key of ['week_before', 'weekBefore']) {
    const f = fixture({ sameDayAllowed: true });
    f.appointment.inicio = '2026-10-13T09:00:00.000Z'; f.execution.context.appointment.inicio = f.appointment.inicio;
    f.execution.trigger_type = 'appointment_reminder_window';
    f.execution.context.trigger = { schedule_moment: 'week_before' };
    f.input.templateName = 'clinicaclick_recordatorio_semana_antes_v7';
    f.appointment.import_metadata.notification_suppression[key] = true;
    assert.throws(() => f.eligibility.assertAppointmentEligibility(f.input), { code: 'whatsapp_appointment_suppressed' });
    assert.equal(operations.allowsSuppressionOverride(f.appointment, { policy: { ...policy, sameDayAllowed: true }, now }), false);
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
