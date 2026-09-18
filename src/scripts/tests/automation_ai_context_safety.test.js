'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildConversationContext } = require('../../lib/automation-conversation-context');

function contextFixture(conversation = { id: 99001, clinic_id: 99002, patient_id: 99003 }, messages = []) {
  let reads = 0;
  return {
    input: { Conversation: { findByPk: async () => conversation, findOne: async () => conversation },
      Message: { findAll: async () => { reads++; return messages; } },
      conversationId: 99001, clinicId: 99002, patientId: 99003, now: new Date('2026-09-18T12:00:00Z') },
    reads: () => reads,
  };
}

test('un ID de conversación de otra clínica se rechaza antes de leer mensajes', async () => {
  const f = contextFixture({ id: 99001, clinic_id: 99004, patient_id: 99003 });
  await assert.rejects(buildConversationContext(f.input), { code: 'automation_conversation_scope_mismatch' });
  assert.equal(f.reads(), 0);
});

test('un ID de conversación asociado a otro paciente se rechaza antes del historial', async () => {
  const f = contextFixture({ id: 99001, clinic_id: 99002, patient_id: 99005 });
  await assert.rejects(buildConversationContext(f.input), { code: 'automation_conversation_scope_mismatch' });
  assert.equal(f.reads(), 0);
});

test('un lead conocido distinto se rechaza; una conversación aún sin paciente admite su contexto de lead', async () => {
  const mismatch = contextFixture({id:99001,clinic_id:99002,lead_id:99006});
  mismatch.input.leadId = 99007;
  await assert.rejects(buildConversationContext(mismatch.input), {code:'automation_conversation_scope_mismatch'});
  assert.equal(mismatch.reads(), 0);
  const valid = contextFixture({id:99001,clinic_id:99002,patient_id:null,lead_id:99007});
  valid.input.leadId = 99007;
  assert.equal((await buildConversationContext(valid.input)).conversation.lead_id, 99007);
});

test('el historial válido conserva mensajes recientes, Unicode y transcripciones; excluye revocados', async () => {
  const messages = Array.from({ length: 280 }, (_, i) => ({ id: i + 1, direction: i % 2 ? 'inbound' : 'outbound',
    content: `Texto ficticio ${i} con ñ, 日本語 y 👍.`, message_type: 'text', sent_at: new Date(Date.UTC(2026,8,18,8,0,i)) }));
  messages.push({ id: 281, direction: 'inbound', message_type: 'audio', content: 'Último audio ficticio transcrito: no puedo ir.',
    metadata: { audio_transcribed: true, media: { kind: 'audio' } }, sent_at: '2026-09-18T10:00:00Z' });
  messages.push({ id: 282, direction: 'inbound', message_type: 'text', content: 'MENSAJE_REVOCADO_NO_ENVIAR',
    metadata: { revoked_at: '2026-09-18T11:00:00Z' }, sent_at: '2026-09-18T10:01:00Z' });
  const f = contextFixture(undefined, messages);
  const result = await buildConversationContext(f.input);
  assert.equal(result.conversation.id, 99001);
  assert.equal(result.conversation.message_count, 281);
  for (const key of ['conversation_today','conversation_this_year','conversation_all_time']) {
    assert.match(result[key], /Último audio ficticio transcrito: no puedo ir/);
    assert.match(result[key], /日本語 y 👍/);
    assert.doesNotMatch(result[key], /MENSAJE_REVOCADO_NO_ENVIAR/);
    assert.match(result[key], /Histórico truncado/);
  }
});

test('la simulación de reseñas respeta el resultado ficticio sin invocar el clasificador real', async () => {
  const flow = require('../../services/flowEngineV2.service');
  const classifier = require('../../services/reviewResponseClassification.service');
  const original = classifier.classifyReviewResponse;
  let calls = 0;
  classifier.classifyReviewResponse = async () => { calls++; throw Error('LIVE_CLASSIFIER_FORBIDDEN'); };
  try {
    const result = await flow._processNode({ id: 'QA', type: 'condition/ai_analysis', config: {
      preset_key: 'review_response_classifier', instruction: 'Clasifica esta respuesta ficticia.',
      context_sources: [{ key: 'respuesta', path: '{{last_response_context.response_text}}' }],
      output_fields: [{name:'response_intent',type:'string'},{name:'response_rating',type:'number'}],
    }, outputs: { on_success: 'DONE' } }, {
      last_response_context: { response_text: 'Más tarde os digo qué me parece.' },
      __simulation_ai_outputs: { QA: {response_intent:'ambiguous',response_rating:0} },
    }, { simulation: true });
    assert.equal(calls, 0);
    assert.equal(result.output._ai_simulated, true);
    assert.equal(result.output.response_intent, 'ambiguous');
    assert.equal(result.next_node_id, 'DONE');
  } finally { classifier.classifyReviewResponse = original; }
});

test('el nodo lee la transcripción del lote actual y rechaza un lote incompleto antes de IA', async () => {
  const db = require('../../../models');
  const flow = require('../../services/flowEngineV2.service');
  const orchestrator = require('../../services/aiOrchestrator.service');
  const before = { conversation:db.Conversation.findByPk, messages:db.Message.findAll, analyze:orchestrator.analyzeStructured };
  let incomplete = false; const inputs = [];
  const audio = { id:99008, direction:'inbound', message_type:'audio', content:'Audio ficticio: no puedo ir mañana.',
    metadata:{audio_transcribed:true,media:{kind:'audio',id:'FICTITIOUS_MEDIA'}},sent_at:new Date() };
  db.Conversation.findByPk = async () => ({id:99001,clinic_id:99002,patient_id:null,channel:'whatsapp'});
  db.Message.findAll = async ({where}) => where.id && incomplete ? [] : [audio];
  orchestrator.analyzeStructured = async input => { inputs.push(input); return {decision:'revisar'}; };
  const node = {id:'AUDIO_QA',type:'condition/ai_analysis',config:{preset_key:'custom',instruction:'Analiza el lote ficticio.',
    context_sources:[{key:'patient_message_batch',path:'{{last_response_context}}'}],
    output_fields:[{name:'decision',type:'string'}]},outputs:{on_success:null,on_fail:null}};
  const context = {conversation:{id:99001,clinic_id:99002},trigger:{type:'message_received',data:{conversation_id:99001,inbound_message_ids:[99008]}}};
  try {
    await flow._processNode(node,context,{simulation:false});
    assert.equal(inputs.length,1);
    assert.match(inputs[0].inputText,/Audio ficticio: no puedo ir mañana/);
    assert.doesNotMatch(inputs[0].inputText,/file_ref|file_url|base64|https:\/\//);
    incomplete = true;
    await assert.rejects(flow._processNode(node,context,{simulation:false}),/message_received_batch_scope_mismatch/);
    assert.equal(inputs.length,1);
  } finally {
    db.Conversation.findByPk=before.conversation;db.Message.findAll=before.messages;orchestrator.analyzeStructured=before.analyze;
  }
});
