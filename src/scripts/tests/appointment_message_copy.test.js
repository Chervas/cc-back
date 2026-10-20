'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RESPONSES, REMINDER_APOLOGIES, updateAppointmentMessages, updateAppointmentCatalog } = require('../../lib/appointment-message-copy');
const publication = require('../../lib/appointment-copy-publication');
const contract = require('../../lib/whatsapp-template-contract');

function source() {
  return { id: 1, public_id: 'TESTONLY', template_key: 'TESTONLY_copy', clinic_id: 1, group_id: null,
    version: 1, name: 'TESTONLY', description: null, published_at: '2030-01-01', is_active: false,
    trigger_type: 'appointment_created', entry_node_id: 'send', trigger_config: { existing: true },
    nodes: [{ id: 'send', type: 'action/send_whatsapp', config: { message_mode: 'manual',
      manual_message_text: RESPONSES[2].es[0], language_routing: { variants: {
        ca: { manual_message_text: RESPONSES[2].ca[0] }, en: { manual_message_text: RESPONSES[2].en[0] } } } }, outputs: { on_success: 'alert' } },
    { id: 'alert', type: 'action/send_system_notification', config: { title: 'Cambio de cita solicitado',
      message: 'Revisa la nueva fecha', display_mode: 'persistent_alert', assignee_id: ['admin'] }, outputs: {} },
    { id: 'ai', type: 'condition/ai_analysis', config: { prompt: 'TESTONLY unchanged' }, outputs: { on_success: 'if' } },
    { id: 'if', type: 'condition/field_check', config: { mode: 'multi_branch' }, outputs: {} }] };
}

test('copy-only update keeps topology, AI, comparators, switches, trigger and source immutable', () => {
  const s = source(), before = structuredClone(s), next = updateAppointmentMessages(s);
  assert.deepEqual(s, before);
  assert.deepEqual(next.nodes.map(n => [n.id, n.outputs]), s.nodes.map(n => [n.id, n.outputs]));
  assert.deepEqual(next.nodes.slice(2), s.nodes.slice(2));
  assert.equal(next.nodes[0].config.manual_message_text, RESPONSES[2].es[1]);
  assert.equal(next.nodes[1].config.human_response_followup_minutes, 30);
  assert.deepEqual(next.nodes[1].config.assignee_id, ['admin']);
  assert.equal(next.is_active, false);
  assert.deepEqual(next.trigger_config, s.trigger_config);
  assert.deepEqual(updateAppointmentMessages(next), next);
  next.nodes[0].config.language_routing.variants.ca.manual_message_text = 'TESTONLY customized';
  next.nodes[0].config.manual_message_text = RESPONSES[2].es[0];
  assert.equal(updateAppointmentMessages(next).nodes[0].config.language_routing.variants.ca.manual_message_text, 'TESTONLY customized');
});

test('publication accepts only exact copy update and rejects a graph, scope, prompt or title change', () => {
  const s = source(), plan = publication.planEntry(s);
  assert.deepEqual(publication.preservedNodes(s, plan.body), plan.body.nodes);
  for (const change of [b => b.nodes[2].config.prompt = 'unsafe', b => b.nodes[0].outputs.on_success = 'ai',
    b => b.clinic_id = 2, b => b.name = 'unsafe', b => b.nodes[1].config.assignee_id = ['unsafe']]) {
    const body = structuredClone(plan.body); change(body);
    assert.throws(() => publication.preservedNodes(s, body), { statusCode: 409 });
  }
  assert.equal(publication.planEntry({ ...s, trigger_type: 'patient.mobile_verification_requested' }), null);
});

test('minimal translated reminder keeps its question and all five parameter meanings', () => {
  const names = ['nombre_paciente', 'hora_cita', 'nombre_clinica', 'direccion_clinica', 'telefono_clinica'];
  for (const locale of ['es', 'ca', 'en']) {
    const catalog = { family_key: 'clinicaclick_recordatorio_dia_antes', locale,
      variables: names.map((name, index) => ({ name, position: index + 1, example: `TESTONLY${index}` })),
      components: [{ type: 'BODY', text: 'old' }], body_text: 'TESTONLY {{1}}.' + REMINDER_APOLOGIES[locale] + '\n{{2}} {{3}} {{4}} {{5}} TESTONLY confirm?' };
    const updated = updateAppointmentCatalog(catalog);
    assert.equal(updated.body_text, catalog.body_text.replace(REMINDER_APOLOGIES[locale], ''));
    assert.deepEqual(updated.variables, catalog.variables);
    assert.equal(updated.components[0].example.body_text[0].length, 5);
    for (const [body, expected] of [['{{1}} {{2}} {{3}} {{4}} {{5}}', names], [updated.body_text, updated.variables.map(v => v.name)]]) {
      const template = { name: 'clinicaclick_recordatorio_dia_antes_v99', components: [{ type: 'BODY', text: body }], catalog: updated };
      assert.deepEqual(contract.buildWhatsappTemplateVariableContract(template).map(v => v.name), expected);
      const resolved = contract.buildEffectiveNamedBindings({}, { 1: '{{paciente.nombre}}', 2: '{{cita.hora}}' },
        contract.buildWhatsappTemplateVariableContract(template));
      assert.equal(resolved.hora_cita, '{{cita.hora}}');
      if (expected.length === 7) assert.equal(resolved.fecha_cita, '{{cita.fecha}}');
    }
    assert.deepEqual(updateAppointmentCatalog(updated), updated);
  }
});

test('reprogramming removes only apologies and retains explicit confirmation, dates and times', () => {
  for (const [locale, phrase] of Object.entries({ es: 'Disculpa las molestias que este cambio te haya podido causar. ',
    ca: 'Disculpa les molèsties que aquest canvi t’hagi pogut causar. ', en: 'We apologize for any inconvenience this change may have caused. ' })) {
    const c = { family_key: 'clinicaclick_confirmacion_datos_cita_reprogramada_hoy', locale,
      body_text: 'TESTONLY {{1}} {{2}} {{3}} ' + phrase + 'TESTONLY confirm?', variables: [], components: [] };
    assert.equal(updateAppointmentCatalog(c).body_text, c.body_text.replace(phrase, ''));
  }
});
