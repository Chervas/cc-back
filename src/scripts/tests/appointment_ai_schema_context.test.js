'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname,'../../..');
process.env.JOBS_AUTO_START='false';
process.env.RUNTIME_ROLE='gateway';
require('./fixtures/campaign_offline_runtime.cjs');
const db = require(root+'/models');
const engine = require('../../services/flowEngineV2.service');
const ai = require('../../services/aiOrchestrator.service');
const contract = require('../../lib/automation-intent-contract');

test.after(async()=>{await db.sequelize.close();});

test('scoped appointment analysis sends enum definitions and certainty for false without altering output columns',async t=>{
  const original=ai.analyzeStructured;
  let request;
  ai.analyzeStructured=async r=>{request=r;return {intencion_principal:'otra',necesita_respuesta:true};};
  t.after(()=>{ai.analyzeStructured=original;});
  const config=contract.cloneClassifyIntentPresetConfig();
  const result=await engine._processNode({id:'AI',type:'condition/ai_analysis',config,outputs:{on_success:'COMPARE'}},
    {last_response_context:{response_text:'FICTITIOUS_ONLY',listened_message_preview:'FICTITIOUS_QUESTION'}},{simulation:false});
  assert.deepEqual(request.outputFormat.lectura_respuesta.enum,
    contract.CLASSIFY_INTENT_REFERENCE_FIELDS.find(f=>f.name==='lectura_respuesta').allowed_values);
  assert.equal(request.outputFormat.confianza_decision_pospuesta.minimum,0);
  assert.equal(request.outputFormat.confianza_decision_pospuesta.maximum,1);
  assert.match(request.outputFormat.confianza_decision_pospuesta.description,/seguro de false/);
  assert(request.systemPrompt.includes('Si el lote solo relata una gestion administrativa o una visita pasadas, no confirma una cita futura:'));
  assert.equal(request.prompt,contract.buildClassifyIntentInstruction(config.instruction));
  assert.equal(result.next_node_id,'COMPARE');
  assert(!Object.hasOwn(result.output,'lectura_respuesta'));
  assert.equal(result.output.intencion_principal,'otra');
});

test('a resumed send retains the exact full question without queueing another message',async t=>{
  const previous=db.Conversation.findByPk;
  let mutations=0;
  db.Conversation.findByPk=async()=>({id:92,async update(){mutations++;}});
  t.after(()=>{db.Conversation.findByPk=previous;});
  const message={id:91,conversation_id:92,status:'read',content:'Hello\n\nPlease confirm attendance tomorrow.',
    metadata:{preview_text:'STALE_PREVIEW',message_mode:'template'}};
  const result=await engine.reuseExistingAutomationWhatsappMessage({existingMessage:message,
    node:{outputs:{on_success:'WAIT'}}});
  assert.equal(result.output.message_id,91);
  assert.equal(result.output.message_preview,message.content);
  assert.equal(result.next_node_id,'WAIT');
  assert.equal(result.output.replay_reused,true);
  assert.equal(result.output.transport_job_id,null);
  assert.equal(mutations,1);
});

test('legacy resumed context recovers the listened message, not a later human reply or the greeting line',async t=>{
  const original=ai.analyzeStructured;
  let request;
  ai.analyzeStructured=async r=>{request=r;return {intencion_principal:'otra',necesita_respuesta:true};};
  t.after(()=>{ai.analyzeStructured=original;});
  const question='Hello\n\nPlease confirm attendance tomorrow.';
  await engine._processNode({id:'AI',type:'condition/ai_analysis',config:contract.cloneClassifyIntentPresetConfig(),outputs:{}},{
    outputs:{SEND:{message_id:100}},
    conversation_today:'[12/10/2026, 15:25] Clínica: Hello\n\nPlease confirm attendance tomorrow.\n[12/10/2026, 15:39] Paciente: FICTITIOUS_ACK',
    last_response_context:{response_message_id:101,response_text:'FICTITIOUS_ACK',listens_to_node_id:'SEND',
      responded_at:'2026-10-12T13:39:00Z',response_items:[{message_id:101,content_type:'text',text:'FICTITIOUS_ACK'}]},
    conversation_context_messages:[
      {id:100,direction:'outbound',sent_at:'2026-10-12T13:25:00Z',text:question},
      {id:101,direction:'inbound',sent_at:'2026-10-12T13:39:00Z',text:'FICTITIOUS_ACK'},
      {id:102,direction:'outbound',sent_at:'2026-10-12T15:25:00Z',text:'FUTURE_HUMAN_REPLY'},
    ],
  },{simulation:false});
  assert.match(request.inputText,/clinic_message_replied_to: Hello\n\nPlease confirm attendance tomorrow\./);
  assert(!request.inputText.includes('FUTURE_HUMAN_REPLY'));
});

test('review diagnostics identify incompatible output without changing the evidence gates',()=>{
  const invalid={intencion_principal:'confirmar_cita',confianza_intencion_principal:.99,
    lectura_respuesta:'confirmar_cita',confianza_lectura_respuesta:.99,
    evidencia_decision_actual:'FICTITIOUS_ACK',asunto_preguntado:'asistencia',
    decision_pospuesta:false,confianza_decision_pospuesta:.1,
    requiere_verificar_gestion_o_condicion:false,confianza_requiere_verificar_gestion_o_condicion:.1,
    hay_asunto_por_resolver:false,confianza_hay_asunto_por_resolver:.1,necesita_respuesta:false};
  const result=contract.projectClassifyIntentReferenceOutput(invalid,{patientText:'FICTITIOUS_ACK'});
  assert.equal(result.intencion_principal,'otra');
  assert.equal(result.necesita_respuesta,true);
  assert(result._ai_reference_failure_reasons.includes('incompatible_response_reading'));
  assert(result._ai_reference_failure_reasons.includes('independent_decision_not_established'));
  assert(!JSON.stringify(result._ai_reference_failure_reasons).includes('FICTITIOUS_ACK'));
});
