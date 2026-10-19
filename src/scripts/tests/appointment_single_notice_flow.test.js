'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { POLICY, buildSingleNoticeFlow, runtimeSingleNoticeFlow, waitingCutoverPatch, isRetiredDelivery } = require('../../lib/appointment-single-notice-flow');

function fixture(trigger = 'appointment_created') {
  const reminder = trigger === 'appointment_reminder_window';
  return { template_key: reminder ? 'recordatorio_y_confirmacion_bed4b6__clinic_1'
    : trigger === 'appointment_rescheduled' ? 'envio_de_datos_de_la_cita_tras_agendar_copy__clinic_1' : 'env_o_de_datos_de_la_cita_tras_agendar__clinic_1',
  entry_node_id: 'start', trigger_type: trigger, trigger_config: { untouched: true }, nodes: [
    { id: 'start', type: 'trigger/' + trigger, outputs: { on_success: 'first' } },
    { id: 'first', type: 'action/send_whatsapp', config: { template_name: 'original', language_routing: { enabled: true } }, outputs: { on_success: 'early' } },
    { id: 'early', type: 'delay/wait_response', config: { timeout_duration: 2, timeout_unit: 'hours', listens_to_node_id: 'first', response_buffer_enabled: true }, outputs: { on_timeout: 'second', on_response: 'ai1' } },
    { id: 'second', type: 'action/send_whatsapp', config: { template_name: reminder ? 'clinicaclick_recordatorio_dia_antes_sin_respuesta_v4' : 'clinicaclick_confirmacion_datos_cita_48_sin_respuesta' }, outputs: { on_success: 'late', on_fail: null } },
    { id: 'late', type: 'delay/wait_response', config: { timeout_duration: 12, timeout_unit: 'hours', listens_to_node_id: 'second', response_buffer_enabled: true }, outputs: { on_response: 'ai2', on_timeout: null } },
    { id: 'ai1', type: 'condition/ai_analysis', config: { instruction: 'Existing prompt', preset_key: 'confirm_appointment' }, outputs: { on_success: 'decision' } },
    { id: 'ai2', type: 'condition/ai_analysis', config: { instruction: 'Other existing prompt', preset_key: 'confirm_appointment' }, outputs: { on_success: 'decision' } },
    { id: 'decision', type: 'condition/field_check', config: { mode: 'multi_branch' }, outputs: { on_else: 'review' } },
    { id: 'review', type: 'action/send_system_notification', config: { title: 'Review' }, outputs: { on_success: null } },
  ] };
}
for (const trigger of ['appointment_created', 'appointment_rescheduled', 'appointment_reminder_window']) {
  test(`${trigger}: one send, original early/late AI branches and no clinical action on silence`, () => {
    const source = fixture(trigger), original = structuredClone(source), result = buildSingleNoticeFlow(source);
    assert.deepEqual(source, original);
    assert.equal(result.nodes.filter(node => node.type === 'action/send_whatsapp').length, 1);
    const nodes = new Map(result.nodes.map(node => [node.id, node]));
    assert.equal(nodes.get('early').outputs.on_timeout, 'late');
    assert.equal(nodes.get('early').outputs.on_response, 'ai1');
    assert.equal(nodes.get('late').outputs.on_response, 'ai2');
    assert.equal(nodes.get('late').config.timeout_duration, 840);
    assert.equal(nodes.get('late').config.listens_to_node_id, 'first');
    assert.equal(nodes.get('late').outputs.on_timeout, null);
    for (const id of ['ai1', 'ai2', 'decision', 'review', 'first']) assert.deepEqual(nodes.get(id), original.nodes.find(node => node.id === id));
    assert.equal(isRetiredDelivery({ ...source, ...result }, 'second'), true);
    assert.equal(isRetiredDelivery({ ...source, ...result }, 'first'), false);
    assert.deepEqual(buildSingleNoticeFlow({ ...source, ...result }), result);
  });
}
test('same-day 08:00, other families and incompatible customizations cannot be rewritten', () => {
  assert.throws(() => buildSingleNoticeFlow({ ...fixture(), template_key: 'recordatorio_mismo_dia_a_las_8_sabes_llegar' }), /out_of_scope/);
  const source = fixture(); source.nodes.find(n => n.id === 'late').outputs.on_timeout = 'review';
  assert.throws(() => buildSingleNoticeFlow(source), /incompatible/);
  const hardcoded=fixture();hardcoded.nodes.find(n=>n.id==='ai2').config.context_sources=[{path:'{{outputs.second.message_preview}}'}];
  assert.throws(()=>buildSingleNoticeFlow(hardcoded),/reference_requires_review/);
});
test('cutover redirects only the retired delivery; already accepted follow-up keeps real correlation', () => {
  const source = fixture(), latest = { ...source, ...buildSingleNoticeFlow(source) };
  const pending = runtimeSingleNoticeFlow(source, latest);
  assert.equal(pending.redirected.second.wait_node_id, 'late');
  assert.equal(pending.nodes.find(n => n.id === 'late').config.listens_to_node_id, 'first');
  const sent = runtimeSingleNoticeFlow(source, latest, { outputs: { second: { message_id: 1, status: 'sent' } } });
  assert.equal(sent.nodes.find(n => n.id === 'late').config.listens_to_node_id, 'second');
  const unsent = runtimeSingleNoticeFlow(source, latest, { outputs: { second: { message_id: 1, status: 'queued' } } });
  assert.equal(unsent.nodes.find(n => n.id === 'late').config.listens_to_node_id, 'first');
  assert.equal(runtimeSingleNoticeFlow(source, source).nodes, source.nodes);
  assert.equal(latest.trigger_config[POLICY].revision, 1);
});
test('cutover preserves pending response buffers and expiry from the first send, never from restart time', () => {
  const source=fixture(),latest={...source,...buildSingleNoticeFlow(source)};
  const execution={current_node_id:'late',status:'waiting',context:{outputs:{first:{effective_send_at:'2030-01-01T08:00:00Z'}}},
    waiting_meta:{type:'delay/wait_response',listens_to_node_id:'second',pending_response_message_ids:[123],pending_response_text:'TESTONLY yes'}};
  const patch=waitingCutoverPatch(execution,runtimeSingleNoticeFlow(source,latest,execution.context));
  assert.equal(patch.waiting_meta.listens_to_node_id,'first');
  assert.deepEqual(patch.waiting_meta.pending_response_message_ids,[123]);
  assert.equal(patch.wait_until.toISOString(),'2030-01-01T22:00:00.000Z');
  assert.equal(patch.waiting_meta.pending_response_text,'TESTONLY yes');
  for(const evidence of [{status:'sent'},{outcome_unknown:true},{delivery_unknown:true}]) {
    execution.context.outputs.second={message_id:42,...evidence};
    assert.equal(waitingCutoverPatch(execution,runtimeSingleNoticeFlow(source,latest,execution.context)),null);
  }
  delete execution.context.outputs.second;delete execution.context.outputs.first;
  assert.throws(()=>waitingCutoverPatch(execution,runtimeSingleNoticeFlow(source,latest,execution.context)),/anchor_requires_review/);
});
