'use strict';

const assert = require('node:assert/strict');
const C = require('../../lib/patient-mobile-verification');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

module.exports = async function modularScenarios({ t, db, engine, byType, resultNode, start, run, accept, reply, resolve, execution, tasks, check }) {
  const advanceBuffer = () => { t.clock = new Date(+t.clock + 91000); };
  const ai = byType('condition/ai_analysis'), wait = byType('delay/wait_response');
  const cases = [
    ['This is my correct number', { intent: 'correct', confidence: 0.98, unequivocal: true, evidence: 'my correct number' }, 'confirmed', null],
    ['This is not my number', { intent: 'incorrect', confidence: 0.97, unequivocal: true, evidence: 'not my number' }, 'review_required', 'patient_rejected'],
    ['Maybe this number is right', { intent: 'correct', confidence: 0.89, unequivocal: true, evidence: 'number is right' }, 'review_required', 'response_unclear'],
    ['Please check this number', { intent: 'correct', confidence: 1, unequivocal: false, evidence: 'this number' }, 'review_required', 'response_unclear'],
    ['Please call reception', { intent: 'correct', confidence: 1, unequivocal: true, evidence: 'invented affirmative quote' }, 'review_required', 'response_unclear'],
    ['Please call reception', { intent: { unexpected: true }, confidence: 1, unequivocal: true, evidence: 7 }, 'review_required', 'response_unclear'],
    ['Please check this', new Error('TESTONLY_AI_UNAVAILABLE'), 'review_required', 'response_unclear'],
  ];
  for (const [text, output, state, reason] of cases) {
    const item = await start(); await accept(item.message); t.aiOutput = output;
    const before = t.aiCalls.length; await reply(item, null, text); await run(item.exec);
    assert.equal(t.aiCalls.length, before); assert.equal((await t.runtime.state(item.request)).state, 'pending');
    const premature = await resolve(item, resultNode('confirmed'));
    assert.equal(premature.output.applied, false); assert.equal(premature.next_node_id, wait.id);
    t.restart(); advanceBuffer(); await run(item.exec);
    const snapshot = await t.runtime.state(item.request);
    assert.equal(snapshot.state, state, text); assert.equal(snapshot.reason, reason, text);
    assert.equal(t.aiCalls.length, before + 1);
    assert(t.aiCalls.at(-1).inputText.includes(text)); assert.equal(t.aiCalls.at(-1).useCase, C.AI_PRESET);
    assert.equal((await tasks(item.request)).length, state === 'confirmed' ? 0 : 2);
  }
  check('standard AI runs once after native buffer/restart; conservative comparator/result reject low confidence, equivocal, invented/malformed evidence and AI failure');

  const transactional = await start(); await accept(transactional.message); await reply(transactional, 'no', 'No');
  assert.equal((await resolve(transactional, resultNode('review_required', 'patient_rejected'))).output.applied, true);
  assert.equal((await tasks(transactional.request)).length, 0, 'the atomic result creates no notifications');
  const beforeEmission = t.emitted.length;
  db.Notification.addHook('beforeCreate', 'TESTONLY_ROLLBACK', row => { if (row.userId === 16) throw Error('TESTONLY_NOTIFICATION_FAILURE'); });
  const notificationNode = byType('action/send_system_notification');
  let notificationExec = await execution(transactional.request);
  await assert.rejects(engine._processNode(notificationNode, notificationExec.context, { execution: notificationExec }), /TESTONLY_NOTIFICATION_FAILURE/);
  assert.equal((await tasks(transactional.request)).length, 0); assert.equal(t.emitted.length, beforeEmission);
  db.Notification.removeHook('beforeCreate', 'TESTONLY_ROLLBACK');
  await engine._processNode(notificationNode, notificationExec.context, { execution: notificationExec });
  assert.equal((await tasks(transactional.request)).length, 2); assert.equal(t.emitted.length, beforeEmission + 2);
  check('generic notifications roll back all recipients together and emit only after commit; result action itself creates no alerts');

  const contradictory = await start(); await accept(contradictory.message);
  await Promise.all([reply(contradictory, null, 'yes'), reply(contradictory, null, 'but this is not my phone')]);
  const batch = (await execution(contradictory.request)).context.mobile_verification;
  assert.equal(batch.response_message_ids.length, 2); assert(batch.response_text.includes('yes')); assert(batch.response_text.includes('not my phone'));
  t.aiOutput = { intent: 'unclear', confidence: 0.99, unequivocal: false, evidence: 'not my phone' };
  advanceBuffer(); await run(contradictory.exec);
  assert.equal((await t.runtime.state(contradictory.request)).reason, 'response_unclear');
  assert(t.aiCalls.at(-1).inputText.includes(batch.response_text));
  const mixed = await start(); await accept(mixed.message);
  await reply(mixed, null, 'wait, review my number'); await reply(mixed, 'yes', 'Yes');
  assert.equal((await execution(mixed.request)).context.mobile_verification.reply_answer, null);
  advanceBuffer(); await run(mixed.exec); assert.equal((await t.runtime.state(mixed.request)).reason, 'response_unclear');
  check('concurrent contradictory free text and text followed by button retain all correlated IDs/text and use full-batch AI, never latest-button adjudication');

  const changed = await start(); await accept(changed.message);
  await reply(changed, null, 'this is my correct number'); advanceBuffer();
  t.aiOutput = { intent: 'correct', confidence: 1, unequivocal: true, evidence: 'my correct number' };
  t.aiDuringCall = async () => { t.aiDuringCall = null; await reply(changed, null, 'but I gave you the wrong number'); };
  await run(changed.exec);
  assert.equal((await t.runtime.state(changed.request)).state, 'pending');
  assert.equal((await execution(changed.request)).current_node_id, wait.id);
  t.aiOutput = { intent: 'unclear', confidence: 0.99, unequivocal: false, evidence: 'wrong number' };
  advanceBuffer(); await run(changed.exec); assert.equal((await t.runtime.state(changed.request)).reason, 'response_unclear');
  check('reply arriving during inference invalidates prior batch attestation and re-enters native wait without losing evidence');

  const originalNodes = structuredClone(t.template.nodes);
  for (const contextSources of [
    [{ key: 'patient_reply', path: '{{trigger.data.unrelated}}' }],
    [...ai.config.context_sources, { key: 'unrelated', path: '{{trigger.data.unrelated}}' }],
    [{ key: 'verification_question', path: '{{last_prompt}}' }, { key: 'patient_reply', path: '{{trigger.data.unrelated}}' }],
  ]) {
    const nodes = structuredClone(originalNodes); nodes.find(n => n.id === ai.id).config.context_sources = contextSources;
    await t.template.update({ nodes });
    const item = await start(); await accept(item.message);
    const exec = await execution(item.request);
    await exec.update({ context: { ...exec.context, trigger: { ...exec.context.trigger, data: { ...exec.context.trigger.data, unrelated: 'yes' } } } });
    await reply(item, null, 'yes but I am asking about the appointment'); advanceBuffer();
    t.aiOutput = { intent: 'correct', confidence: 1, unequivocal: true, evidence: 'yes' };
    await run(item.exec); assert.equal((await t.runtime.state(item.request)).reason, 'response_unclear');
  }
  await t.template.update({ nodes: originalNodes });
  check('edited AI sources cannot attest unrelated, missing or extra context even when evidence overlaps actual response');

  const rename = new Map(originalNodes.map((n, i) => [n.id, 'MOD_' + i]));
  const remap = value => Array.isArray(value) ? value.map(remap) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, remap(v)])) : rename.get(value) || value;
  const renamed = remap(originalNodes);
  renamed.forEach(n => { if (n.config) delete n.config.mobile_verification_protocol; });
  await t.template.update({ nodes: renamed, entry_node_id: rename.get(originalNodes[0].id) });
  const arbitrary = await start(); await accept(arbitrary.message); await reply(arbitrary, 'yes'); await run(arbitrary.exec);
  assert.equal((await t.runtime.state(arbitrary.request)).state, 'confirmed');
  await t.template.update({ nodes: originalNodes, entry_node_id: originalNodes[0].id });
  check('arbitrary node IDs and removed editable protocol flags retain scoped hooks; runtime never depends on prescribed node IDs');

  const isolated = await start(); await accept(isolated.message);
  const appointmentTemplate = await db.AutomationFlowTemplateV2.create({ ...C.definition(72), public_id: 'TESTONLY_APPOINTMENT',
    template_key: 'TESTONLY_APPOINTMENT', trigger_type: 'appointment_created', nodes: [
      { id: 'A_SEND', type: 'action/send_whatsapp', config: {}, outputs: {} },
      { id: 'A_WAIT', type: 'delay/wait_response', config: { listens_to_node_id: 'A_SEND', response_buffer_enabled: true }, outputs: {} }],
    is_active: true, published_at: t.clock });
  const appointment = await db.FlowExecutionV2.create({ idempotency_key: 'TESTONLY_APPOINTMENT', template_version_id: appointmentTemplate.id,
    status: 'waiting', current_node_id: 'A_WAIT', created_by: 15, clinic_id: 72, trigger_type: 'appointment_created',
    trigger_entity_type: 'appointment', trigger_entity_id: 991, waiting_meta: { type: 'delay/wait_response', runtime_namespace: 'TESTONLY' },
    context: { trigger: { data: { patient_id: isolated.request.patient_id } }, outputs: { A_SEND: { conversation_id: isolated.message.conversation_id, message_id: isolated.message.id } } } });
  const inbound = await db.Message.create({ conversation_id: isolated.message.conversation_id, direction: 'inbound', content: 'TESTONLY appointment message', message_type: 'text', sent_at: t.clock });
  const resume = loadSource('automationsV2Resume.service', { '../../models': db, './jobRequests.service': t.requests,
    './jobScheduler.service': { triggerImmediate: async () => {} }, './conversationPendingReply.service': { emitAutomationResponseProcessing() {} },
    './conversationAutomationState.service': { setState: async () => {} } }, { JOB_RUNTIME_NAMESPACE: 'TESTONLY' });
  const resumed = await resume.enqueueInboundResponseResume({ clinicId: 72, conversationId: isolated.message.conversation_id,
    patientId: isolated.request.patient_id, inboundMessageId: inbound.id, messageText: inbound.content });
  assert.equal(resumed.errors.length, 0, JSON.stringify(resumed.errors));
  assert.deepEqual(Array.from(resumed.execution_ids, Number), [appointment.id]);
  assert.equal((await execution(isolated.request)).status, 'waiting'); await appointment.reload(); assert.equal(appointment.status, 'waiting');
  check('generic inbound matcher excludes verification waits before ownership/supersession; coexisting appointment wait remains available');
};
