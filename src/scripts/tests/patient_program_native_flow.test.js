'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('../../lib/patient-program-appointment-flow');
const C = require('../../lib/patient-program-booking-confirmation');
const { fixture } = require('./patient_program_booking_confirmation.test');
const { buildSingleNoticeFlow } = require('../../lib/appointment-single-notice-flow');
function source() {
  const nodes = [{ id: 'T', type: 'trigger/appointment_created', config: {}, outputs: { on_success: 'timing' } },
    { id: 'timing', type: 'condition/field_check', config: { mode: 'appointment_booking_timing', switch_rules: [
      { id: 'today', match_window: 'same_day' }, { id: 'tomorrow', match_window: 'day_before' }, { id: 'later', match_window: 'more_than_day_before' } ] },
    outputs: { today: 'send', tomorrow: 'send', later: 'send' } },
    { id: 'send', type: 'action/send_whatsapp', config: { template_name: 'INITIAL_TESTONLY' }, outputs: { on_success: 'wait' } },
    { id: 'wait', type: 'delay/wait_response', config: { timeout_unit: 'hours', timeout_duration: 2, listens_to_node_id: 'send' }, outputs: { on_timeout: 'follow' } },
    { id: 'follow', type: 'action/send_whatsapp', config: { template_name: 'clinicaclick_confirmacion_datos_cita_48_sin_respuesta' }, outputs: { on_success: 'last' } },
    { id: 'last', type: 'delay/wait_response', config: { timeout_unit: 'hours', timeout_duration: 12, listens_to_node_id: 'follow' }, outputs: {} }];
  const original = { template_key: 'env_o_de_datos_de_la_cita_tras_agendar__clinic_72', trigger_type: 'appointment_created',
    entry_node_id: 'T', nodes, trigger_config: {}, clinic_id: 72 };
  return { ...original, ...buildSingleNoticeFlow(original) };
}
test('native program branch preserves every ordinary node, trigger and switch, is modular and starts unconfigured', () => {
  const original = source(), adapted = A.adapt(original);
  assert.equal(A.graphValid(adapted), true);
  assert.deepEqual(A.normalProjection(adapted), { nodes: original.nodes, trigger_config: original.trigger_config,
    entry_node_id: original.entry_node_id, trigger_type: original.trigger_type });
  assert.equal(adapted.trigger_config[A.POLICY].configured, false);
  assert.equal(A.configured(adapted, new Date()), false);
  assert.deepEqual(A.adapt(adapted), adapted);
  adapted.nodes.find(n => n.id === A.programNode(adapted, 11)).config.title = 'Recepción: revisar el programa';
  assert(A.graphValid(adapted), 'Compatible notification customization remains modular');
  const doubled = structuredClone(adapted);
  doubled.nodes.push({ ...structuredClone(doubled.nodes.find(n => n.id === A.programNode(doubled, 1))), id: 'N999' });
  assert.equal(A.graphValid(doubled), false, 'No second WhatsApp can be added to the grouped summary');
  adapted.nodes.find(n => n.id === A.programNode(adapted, 6)).outputs.on_success = 'send';
  assert.equal(A.graphValid(adapted), false, 'The program branch cannot escape into ordinary sends');
});
test('one operation owns one existing trigger; a mixed operation belongs only to reprogramming', () => {
  const initial = fixture().receipt;
  assert.equal(A.operation(initial).event, 'appointment_created');
  initial.result.sessions.push({ action: 'rescheduled', appointment_id: 200, start_at: '2027-01-04T10:00:00Z',
    end_at: '2027-01-04T10:30:00Z', previous_appointment: { start_at: '2027-01-04T09:00:00Z', end_at: '2027-01-04T09:30:00Z' } });
  assert.equal(A.operation(initial).event, 'appointment_rescheduled'); assert.equal(A.operation(initial).ownerId, 200);
  initial.result.notice_decision = { send: false }; assert(A.operation(initial).declined);
  const unchanged = { result: { sessions: [initial.result.sessions.at(-1)] } };
  unchanged.result.sessions[0].previous_appointment.start_at = unchanged.result.sessions[0].start_at;
  unchanged.result.sessions[0].previous_appointment.end_at = unchanged.result.sessions[0].end_at;
  assert(A.operation(unchanged).unchanged, 'A column-only change cannot send another date summary');
});
test('wait duration comes from the current single-notice leg, never another follow-up send', () => {
  const adapted = A.adapt(source());
  assert.equal(A.timeout(adapted, { startAt: '2026-10-22T09:00:00Z', now: '2026-10-21T09:00:00Z', timeZone: 'Europe/Madrid' }), 840);
  const bad = structuredClone(adapted); bad.nodes.find(n => n.id === 'send').config.template_name = 'changed';
  assert.equal(A.graphValid(bad), false);
});
test('compact complete dates and original numbering fit 30 ordinary visits; overlong output remains complete and review-only', () => {
  const input = fixture(30); input.native = true;
  const summary = C.projection(input);
  assert.match(summary.parameters[2], /^1\) 04-01-2027 10:00;/);
  assert.match(summary.parameters[2], /30\)/); assert(summary.body.length <= 1024);
  for (const language of ['es', 'ca', 'en']) {
    const localized = C.projection({ ...input, communicationLanguage: language });
    assert.equal(localized.language, language); assert.match(localized.parameters[2], /04-01-2027/);
  }
  const long = C.projection({ ...input, snapshot: { ...input.snapshot, name: 'TESTONLY '.repeat(50) } });
  assert.equal(long.representation_error, 'program_details_body_too_long');
  assert.equal(long.appointment_count, 30); assert.match(long.parameters[2], /30\)/);
  const large = C.projection({ ...fixture(120), native: true });
  assert.equal(large.appointment_count, 120); assert.equal(large.representation_error, 'program_details_body_too_long');
  const unsupported = C.projection({ ...input, communicationLanguage: 'fr' });
  assert.equal(unsupported.language, 'fr'); assert.equal(unsupported.body, null);
  assert.equal(unsupported.representation_error, 'program_notice_language_unsupported');
});
test('native protocol identification cannot activate the old parallel family or a normal execution', () => {
  assert.equal(A.nativeFlow({ trigger_type: C.REQUEST }), false);
  assert.equal(A.nativeFlow({ trigger_type: 'appointment_created', trigger_entity_type: 'appointment', context: {} }), false);
  assert.equal(A.nativeFlow({ trigger_type: 'appointment_created', trigger_entity_type: 'appointment',
    context: { program_confirmation: { protocol: A.PROTOCOL, request_event_id: 10 } } }), true);
});
