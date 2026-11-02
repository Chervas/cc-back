'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const copy = require('../../lib/appointment-message-copy');
const publication = require('../../lib/appointment-copy-publication');
const engine = require('../../services/flowEngineV2.service');

test('late replies use the same neutral acknowledgement in the real simulation path in all appointment triggers and languages', async () => {
  const sourceConfig = { message_mode: 'manual', recipient_mode: 'context_patient',
    suppress_if_human_replied: true, suppress_if_response_needed: true };
  for (const trigger of ['appointment_created', 'appointment_rescheduled', 'appointment_reminder_window']) {
    for (const [locale, texts] of Object.entries(copy.ACKNOWLEDGEMENT_ALIASES)) {
      for (const text of texts) for (const replyAt of ['2030-03-31T08:00:00Z', '2030-10-27T08:00:00Z']) {
        const node = { id: 'ack', type: 'action/send_whatsapp', config: { ...sourceConfig, manual_message_text: text }, outputs: { on_success: 'end' } };
        const before = structuredClone(node);
        const context = { trigger: { type: trigger }, paciente: { nombre: 'Paciente QA' }, cita: { hora: '17:30' },
          last_response_context: { response_text: 'Sí', response_received_at: replyAt },
          last_prompt_at: new Date(Date.parse(replyAt) - 24 * 3600000).toISOString() };
        const result = await engine._processNode(node, context, { simulation: true, execution: { trigger_type: trigger } });
        assert.equal(result.output.message_preview, copy.NEUTRAL_ACKNOWLEDGEMENTS[locale].replace('{{paciente.nombre}}', 'Paciente QA'));
        assert.equal(result.next_node_id, 'end');
        assert.deepEqual(node, before);
      }
    }
  }
});

test('publication changes text only, including translations on already-updated Spanish, and is idempotent', () => {
  const source = { id: 1, public_id: 'TESTONLY', template_key: 'TESTONLY', published_at: '2030-01-01',
    name: 'TESTONLY', trigger_type: 'appointment_reminder_window', clinic_id: 1, group_id: null,
    is_active: false, is_system: false, entry_node_id: 'ack', trigger_config: { custom_time: '09:00' },
    nodes: [{ id: 'ack', type: 'action/send_whatsapp', config: { message_mode: 'manual',
      manual_message_text: copy.NEUTRAL_ACKNOWLEDGEMENTS.es, suppress_if_human_replied: true,
      language_routing: { variants: { ca: { manual_message_text: 'Perfecte, {{paciente.nombre}}. Fins demà.' },
        en: { manual_message_text: 'TESTONLY custom translation' } } } }, outputs: { on_success: 'end' } },
    { id: 'end', type: 'control/end', outputs: {} }] };
  const before = structuredClone(source), plan = publication.planEntry(source);
  assert(plan);
  assert.deepEqual(source, before);
  assert.deepEqual(plan.body.trigger_config, source.trigger_config);
  assert.deepEqual(plan.body.nodes.map(n => [n.id, n.type, n.outputs]), source.nodes.map(n => [n.id, n.type, n.outputs]));
  assert.equal(plan.body.nodes[0].config.language_routing.variants.ca.manual_message_text, copy.NEUTRAL_ACKNOWLEDGEMENTS.ca);
  assert.equal(plan.body.nodes[0].config.language_routing.variants.en.manual_message_text, 'TESTONLY custom translation');
  assert.equal(plan.body.nodes[0].config.suppress_if_human_replied, true);
  assert.equal(publication.planEntry({ ...source, nodes: plan.body.nodes }), null);
  assert.deepEqual(publication.preservedNodes(source, plan.body), plan.body.nodes);
});

test('initial reminders, questions, unrelated protocols and personalized messages stay intact', () => {
  for (const text of ['Te recuerdo tu cita de mañana a las {{cita.hora}}. ¿Nos confirmas?',
    'Perfecto, revisaremos mañana tu solicitud.', 'TESTONLY custom acknowledgement', undefined]) {
    assert.equal(copy.acknowledgementForExecution(text, 'appointment_reminder_window'), text);
  }
  const old = 'Perfecto, {{paciente.nombre}}. Hasta mañana.';
  for (const trigger of ['patient.mobile_verification_requested', 'patient.program_appointments_booked', 'lead_created', null])
    assert.equal(copy.acknowledgementForExecution(old, trigger), old);
  for (const text of Object.values(copy.NEUTRAL_ACKNOWLEDGEMENTS)) assert.equal(copy.neutralAcknowledgementText(text), text);
});

test('language rollout translates the neutral message and legacy acknowledgements without restoring relative dates', () => {
  const rollout = require('../../services/whatsappLanguageRollout.service')._test;
  for (const text of [...copy.ACKNOWLEDGEMENT_ALIASES.es, copy.NEUTRAL_ACKNOWLEDGEMENTS.es])
    for (const locale of ['ca', 'en']) assert.equal(rollout.translateManualMessage(text, locale), copy.NEUTRAL_ACKNOWLEDGEMENTS[locale]);
});

test('program copies retain their branch, activation cut and source while rebinding only the normal copy digest', () => {
  const program = require('../../lib/patient-program-appointment-flow');
  const single = require('../../lib/appointment-single-notice-flow');
  const C = require('../../lib/patient-program-booking-confirmation');
  for (const [trigger, family] of [['appointment_created', 'env_o_de_datos_de_la_cita_tras_agendar'],
    ['appointment_rescheduled', 'envio_de_datos_de_la_cita_tras_agendar_copy']]) {
    const normal = { id: 10, public_id: 'TESTONLY_program_copy', name: 'TESTONLY', version: 1,
      template_key: family + '__clinic_1', trigger_type: trigger, clinic_id: 1, group_id: null,
      is_active: false, is_system: false, published_at: '2030-01-01', entry_node_id: 'N1', trigger_config: {}, nodes: [
        { id: 'N1', type: 'trigger/' + trigger, config: {}, outputs: { on_success: 'N2' } },
        { id: 'N2', type: 'action/send_whatsapp', config: { template_name: 'INITIAL_TESTONLY' }, outputs: { on_success: 'N3' } },
        { id: 'N3', type: 'delay/wait_response', config: { timeout_duration: 2, timeout_unit: 'hours', listens_to_node_id: 'N2' }, outputs: { on_response: 'N6', on_timeout: 'N4' } },
        { id: 'N4', type: 'action/send_whatsapp', config: { template_name: 'clinicaclick_confirmacion_datos_cita_48_sin_respuesta' }, outputs: { on_success: 'N5' } },
        { id: 'N5', type: 'delay/wait_response', config: { timeout_duration: 12, timeout_unit: 'hours', listens_to_node_id: 'N4' }, outputs: { on_response: 'N6', on_timeout: null } },
        { id: 'N6', type: 'action/send_whatsapp', config: { message_mode: 'manual', manual_message_text: 'Perfecto, {{paciente.nombre}}. Hasta mañana.' }, outputs: {} },
      ] };
    const source = program.adapt({ ...normal, ...single.buildSingleNoticeFlow(normal) });
    assert(program.graphValid(source));
    for (const stale of [false, true]) {
      const s = structuredClone(source);
      if (stale) {
        s.trigger_config.program_booking_v1.normal_sha256 = '0'.repeat(64);
        s.nodes.find(n => n.id === s.entry_node_id).config.program_booking_v1.normal_sha256 = '0'.repeat(64);
      }
      const next = copy.updateAppointmentMessages(s), plan = publication.planEntry(s);
      assert(program.graphValid(next));
      assert.equal(next.nodes.find(n => n.id === 'N6').config.manual_message_text, copy.NEUTRAL_ACKNOWLEDGEMENTS.es);
      assert.deepEqual(plan.body.trigger_config, next.trigger_config);
      const beforePolicy = { ...s.trigger_config.program_booking_v1 }, afterPolicy = { ...next.trigger_config.program_booking_v1 };
      delete beforePolicy.normal_sha256; delete afterPolicy.normal_sha256;
      assert.deepEqual(afterPolicy, beforePolicy);
      assert.equal(next.is_active, s.is_active);
      assert.deepEqual(next.nodes.filter(n => !s.trigger_config.program_booking_v1.normal_ids.includes(n.id)),
        s.nodes.filter(n => !s.trigger_config.program_booking_v1.normal_ids.includes(n.id)));
      assert.deepEqual(copy.updateAppointmentMessages(next), next);
      const projection = program.normalProjection(next), prior = program.normalProjection(s);
      assert.equal(C.hash(copy.normalizeAcknowledgementGraph(projection)), C.hash(copy.normalizeAcknowledgementGraph(prior)));
      projection.nodes.find(n => n.id === 'N2').outputs.on_success = 'N6';
      assert.notEqual(C.hash(copy.normalizeAcknowledgementGraph(projection)), C.hash(copy.normalizeAcknowledgementGraph(prior)));
    }
    const broken = structuredClone(source);
    broken.nodes.find(n => n.id === program.programNode(broken, 6)).outputs.on_success = 'N6';
    assert.throws(() => copy.updateAppointmentMessages(broken), /program_source_invalid/);
  }
});
