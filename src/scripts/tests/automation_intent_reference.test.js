'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CONFIRM_APPOINTMENT_PRESET_CONFIG,
  CLASSIFY_INTENT_PRESET_CONFIG,
  CLASSIFY_INTENT_REFERENCE_INSTRUCTION,
  buildClassifyIntentInstruction,
  projectClassifyIntentReferenceOutput,
  cloneClassifyIntentPresetConfig,
} = require('../../lib/automation-intent-contract');

test('contextual acceptance is explicit in the canonical prompt, without overriding AI uncertainty', () => {
  assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /Ok! Gracias/);
  assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /Hola\. De acuerdo/);
  assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /Gracias, lo miro y te digo/);
  assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /Ok, pero no puedo/);
});

test('tool enum quoting is representation only; unknown decisions and weak evidence remain held', () => {
  const { canonicalAiChoice } = require('../../lib/automation-ai-choice');
  for (const value of ['asistencia', '"asistencia"', '&quot;asistencia&quot;']) {
    assert.equal(canonicalAiChoice(value, ['asistencia']), 'asistencia');
  }
  for (const value of ['attendance', '<b>asistencia</b>', '&quot;asistencia', '"incierta"', true, null]) {
    assert.equal(canonicalAiChoice(value, ['asistencia']), null);
  }
  const { deriveConfirmAppointmentOutput } = require('../../services/flowEngineV2.service');
  const signal = { evidencia_confirmacion:'Ok!', asunto_confirmacion:'&quot;asistencia&quot;', confianza_asunto_confirmacion:.95,
    lectura_confirmacion:'"afirmacion_incondicional"', confianza_lectura_confirmacion:.95,
    confirmacion_condicionada_o_incierta:false, confianza_confirmacion_condicionada_o_incierta:.95,
    respuesta_afirmativa_a_la_clinica:true, confianza_respuesta_afirmativa_a_la_clinica:.95,
    negacion_explicita_de_la_confirmacion:false, confianza_negacion_explicita_de_la_confirmacion:.95,
    requiere_respuesta:false, confianza_requiere_respuesta:.95 };
  assert.equal(deriveConfirmAppointmentOutput(signal,{patientText:'Ok! Gracias'}).confirma_asistencia,true);
  for (const change of [{lectura_confirmacion:'"incierta"'}, {confianza_lectura_confirmacion:.4},
    {asunto_confirmacion:'"indicaciones"'}, {evidencia_confirmacion:'text not present'},
    {confirmacion_condicionada_o_incierta:true}, {negacion_explicita_de_la_confirmacion:true}]) {
    assert.equal(deriveConfirmAppointmentOutput({...signal,...change},{patientText:'Ok! Gracias'}).confirma_asistencia,false);
  }
});

test('the current preset includes reference grounding without duplicating it at runtime', () => {
  const instruction = CLASSIFY_INTENT_PRESET_CONFIG.instruction;
  assert(instruction.includes(CLASSIFY_INTENT_REFERENCE_INSTRUCTION));
  assert.equal(buildClassifyIntentInstruction(instruction), instruction);
  assert.equal(buildClassifyIntentInstruction(buildClassifyIntentInstruction(instruction)), instruction);
});

test('clinical actions require a compatible AI reading and evidence, not just high intent confidence', () => {
  for (const [intent, reading] of [
    ['confirmar_cita', 'compromiso_asistencia'],
    ['cancelar_cita', 'rechazo_asistencia'],
    ['solicitar_cambio_cita', 'solicitud_nueva_cambio'],
  ]) {
    const explicit = {intencion_principal:intent, lectura_respuesta:reading,
      decision_pospuesta:false, confianza_decision_pospuesta:0.99,
      asunto_preguntado:'asistencia',
      evidencia_decision_actual:'Patient decision', confianza_lectura_respuesta:0.99,
      rechazo_asistencia_explicito:intent === 'cancelar_cita', confianza_rechazo_asistencia_explicito:0.99,
      requiere_verificar_gestion_o_condicion:false, confianza_requiere_verificar_gestion_o_condicion:0.99,
      hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99,
      necesita_respuesta:false, confianza_intencion_principal:0.99, accion_inequivoca:true};
    for (const invalid of [
      {lectura_respuesta:'ambigua'}, {lectura_respuesta:undefined},
      {confianza_lectura_respuesta:undefined}, {confianza_lectura_respuesta:0.4},
      {decision_pospuesta:true}, {decision_pospuesta:undefined}, {confianza_decision_pospuesta:0.4},
      {evidencia_decision_actual:''}, {evidencia_decision_actual:'Invented text'},
      {requiere_verificar_gestion_o_condicion:true}, {confianza_requiere_verificar_gestion_o_condicion:undefined},
      ...(intent === 'confirmar_cita' ? [] : [{hay_asunto_por_resolver:true}]),
      {confianza_hay_asunto_por_resolver:0.2},
      {asunto_preguntado:'indicaciones'}, {asunto_preguntado:undefined},
    ]) {
      const result = projectClassifyIntentReferenceOutput({...explicit,...invalid}, {patientText:'Patient decision'});
      assert.equal(result.intencion_principal, 'otra');
      assert.equal(result.confianza_intencion_principal, 0);
      assert.equal(result.accion_inequivoca, false);
      assert.equal(result.necesita_respuesta, true);
      assert.equal(result._ai_reference_inconsistent, true);
    }
    assert.deepEqual(projectClassifyIntentReferenceOutput(explicit, {patientText:'Patient decision'}), explicit);
  }
});

test('affirming directions cannot confirm attendance even if the model selects confirmation', () => {
  const result = projectClassifyIntentReferenceOutput({
    intencion_principal:'confirmar_cita', lectura_respuesta:'solo_indicaciones', confianza_lectura_respuesta:0.99,
    evidencia_decision_actual:'Conozco el camino', confianza_intencion_principal:0.99,
    hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99,
  }, {patientText:'Conozco el camino'});
  assert.equal(result.intencion_principal, 'otra');
  assert.equal(result.confianza_intencion_principal, 0);
  assert.equal(result.necesita_respuesta, true);
});

test('implicit confirmation needs a verified question and current evidence', () => {
  const base = {intencion_principal:'confirmar_cita', confianza_intencion_principal:0.99,
    decision_pospuesta:false, confianza_decision_pospuesta:0.99,
    evidencia_decision_actual:'Yes', lectura_respuesta:'acuse_confirmacion_solicitada', confianza_lectura_respuesta:0.99,
    requiere_verificar_gestion_o_condicion:false, confianza_requiere_verificar_gestion_o_condicion:0.99,
    hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99};
  for (const patientText of ['Yes','']) {
    const value = {...base,asunto_preguntado:'indicaciones'};
    assert.equal(projectClassifyIntentReferenceOutput(value,{patientText}).intencion_principal, 'otra');
    assert.equal(projectClassifyIntentReferenceOutput({...value,asunto_preguntado:'asistencia'},{patientText}).intencion_principal,
      patientText ? 'confirmar_cita' : 'otra');
  }
  const explicit = {...base,lectura_respuesta:'compromiso_asistencia',asunto_preguntado:'asistencia'};
  assert.equal(projectClassifyIntentReferenceOutput(explicit).intencion_principal, 'otra');
  assert.equal(projectClassifyIntentReferenceOutput(explicit,{patientText:'Yes'}).intencion_principal, 'confirmar_cita');
});

test('the model may confirm a current contextual reaction without written text', () => {
  const output={intencion_principal:'confirmar_cita',confianza_intencion_principal:0.99,
    decision_pospuesta:false,confianza_decision_pospuesta:0.99,
    evidencia_decision_actual:'',lectura_respuesta:'acuse_confirmacion_solicitada',confianza_lectura_respuesta:0.99,
    asunto_preguntado:'asistencia',requiere_verificar_gestion_o_condicion:false,
    confianza_requiere_verificar_gestion_o_condicion:0.99,
    hay_asunto_por_resolver:false,confianza_hay_asunto_por_resolver:0.99,
    id_confirmacion_por_reaccion:47,confianza_id_confirmacion_por_reaccion:0.99};
  const responseItems=[{message_id:47,content_type:'reaction',emoji:'contextually interpreted by AI',
    target_message_preview:'Please confirm attendance'}];
  assert.equal(projectClassifyIntentReferenceOutput(output,{responseItems}).intencion_principal,'confirmar_cita');
  for(const change of [
    {id_confirmacion_por_reaccion:48},{confianza_id_confirmacion_por_reaccion:0.5},
    {asunto_preguntado:'indicaciones'},{lectura_respuesta:'sin_decision'},
  ]) assert.equal(projectClassifyIntentReferenceOutput({...output,...change},{responseItems}).intencion_principal,'otra');
  for(const items of [[],[{...responseItems[0],target_message_preview:''}],
    [{...responseItems[0],emoji:''}]]) {
    const held=projectClassifyIntentReferenceOutput(output,{responseItems:items});
    assert.equal(held.intencion_principal,'otra');
    assert.equal(held.necesita_respuesta,true);
  }
});

test('inconsistent appointment signals never leave a high-confidence clinical intent for a comparator', () => {
  const valid = { intencion_principal:'cancelar_cita', intencion_secundaria:'', confianza_intencion_principal:0.99,
    decision_pospuesta:false, confianza_decision_pospuesta:0.99,
    asunto_preguntado:'asistencia',
    evidencia_decision_actual:'Cancel my appointment',
    lectura_respuesta:'rechazo_asistencia', confianza_lectura_respuesta:0.99,
    rechazo_asistencia_explicito:true, confianza_rechazo_asistencia_explicito:0.99,
    requiere_verificar_gestion_o_condicion:false, confianza_requiere_verificar_gestion_o_condicion:0.99,
    hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99 };
  for (const conflict of [
    {lectura_respuesta:'solicitud_nueva_cambio'}, {lectura_respuesta:'consulta_gestion_previa'},
    {intencion_secundaria:'solicitar_cambio_cita'}, {posible_urgencia:true},
    {confianza_lectura_respuesta:0.7}, {confianza_lectura_respuesta:undefined},
    {rechazo_asistencia_explicito:false}, {confianza_rechazo_asistencia_explicito:undefined},
    {evidencia_decision_actual:'Invented text'},
  ]) {
    const output = projectClassifyIntentReferenceOutput({ ...valid, ...conflict }, {patientText:'Cancel my appointment'});
    assert.equal(output.intencion_principal, 'otra');
    assert.equal(output.confianza_intencion_principal, 0);
    assert.equal(output.necesita_respuesta, true);
  }
  assert.equal(projectClassifyIntentReferenceOutput(valid,{patientText:'Cancel my appointment'}).intencion_principal, 'cancelar_cita');
});

test('an independently identified unresolved matter preserves the native pending-response signal', () => {
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'otra', necesita_respuesta:false, hay_asunto_por_resolver:true, confianza_hay_asunto_por_resolver:0.99,
  }).necesita_respuesta, true);
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'otra', necesita_respuesta:true, hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99,
  }).necesita_respuesta, true);
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'otra', necesita_respuesta:false, hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.1,
  }).necesita_respuesta, true);
});

test('an AI-identified postponement cannot be overridden by a high-confidence acknowledgement', () => {
  const output=projectClassifyIntentReferenceOutput({
    intencion_principal:'confirmar_cita', confianza_intencion_principal:0.99,
    lectura_respuesta:'acuse_confirmacion_solicitada', confianza_lectura_respuesta:0.99,
    asunto_preguntado:'asistencia', evidencia_decision_actual:'Thank you',
    decision_pospuesta:true, confianza_decision_pospuesta:0.99,
    requiere_verificar_gestion_o_condicion:false, confianza_requiere_verificar_gestion_o_condicion:0.99,
    hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99,
    necesita_respuesta:false,
  }, {patientText:'I will answer when I finish. Thank you'});
  assert.equal(output.intencion_principal,'otra');
  assert.equal(output.necesita_respuesta,true);
  assert.equal(output.confianza_intencion_principal,0);
});

test('an independent confirmation and a pending request keep both native branches available', () => {
  const value = {
    decision_pospuesta:false, confianza_decision_pospuesta:0.99,
    intencion_principal:'confirmar_cita', intencion_secundaria:'pregunta', confianza_intencion_principal:0.99,
    asunto_preguntado:'asistencia', lectura_respuesta:'compromiso_asistencia', confianza_lectura_respuesta:0.99,
    evidencia_decision_actual:'I will attend', accion_inequivoca:true,
    requiere_verificar_gestion_o_condicion:false, confianza_requiere_verificar_gestion_o_condicion:0.99,
    hay_asunto_por_resolver:true, confianza_hay_asunto_por_resolver:0.99, necesita_respuesta:true,
  };
  const output = projectClassifyIntentReferenceOutput(value, { patientText:'I will attend. Please correct my name.' });
  assert.equal(output.intencion_principal,'confirmar_cita');
  assert.equal(output.necesita_respuesta,true);
  for (const uncertainty of [
    {requiere_verificar_gestion_o_condicion:true},
    {confianza_requiere_verificar_gestion_o_condicion:0.5},
    {lectura_respuesta:'ambigua'},
    {confianza_hay_asunto_por_resolver:0.4},
  ]) {
    const review = projectClassifyIntentReferenceOutput({...value,...uncertainty}, { patientText:'I will attend' });
    assert.equal(review.intencion_principal,'otra');
    assert.equal(review.necesita_respuesta,true);
  }
});

test('confirmation signal projection fails closed on conditional, missing or low-certainty readings', () => {
  const {deriveConfirmAppointmentOutput}=require('../../services/flowEngineV2.service');
  const patientText='I will attend';
  const signal={evidencia_confirmacion:patientText,lectura_confirmacion:'afirmacion_incondicional',confianza_lectura_confirmacion:0.99,
    asunto_confirmacion:'asistencia',confianza_asunto_confirmacion:0.99,
    confirmacion_condicionada_o_incierta:false,confianza_confirmacion_condicionada_o_incierta:0.99,
    respuesta_afirmativa_a_la_clinica:true,confianza_respuesta_afirmativa_a_la_clinica:0.99,
    negacion_explicita_de_la_confirmacion:false,confianza_negacion_explicita_de_la_confirmacion:0.99,
    requiere_respuesta:false,confianza_requiere_respuesta:0.99};
  assert.equal(deriveConfirmAppointmentOutput(signal,{patientText}).confirma_asistencia,true);
  for(const uncertain of [
    {lectura_confirmacion:'decision_condicionada'}, {lectura_confirmacion:'incierta'},
    {lectura_confirmacion:undefined}, {confianza_lectura_confirmacion:0.4},
    {asunto_confirmacion:'indicaciones'}, {asunto_confirmacion:undefined}, {confianza_asunto_confirmacion:0.4},
    {confirmacion_condicionada_o_incierta:true}, {confianza_confirmacion_condicionada_o_incierta:0.2},
    {evidencia_confirmacion:''}, {evidencia_confirmacion:'Words not in the patient batch'},
    {evidencia_asunto_pendiente:'Words from the clinic'},
  ]) {
    const output=deriveConfirmAppointmentOutput({...signal,...uncertain},{patientText});
    assert.equal(output.confirma_asistencia,false);
    assert.equal(output.requiere_respuesta,true);
  }
  assert.equal(deriveConfirmAppointmentOutput({...signal,confianza_requiere_respuesta:0.2},{patientText}).requiere_respuesta,true);
});

test('an AI reading of reciprocal courtesy cannot become confirmation through an affirmative flag', () => {
  const {deriveConfirmAppointmentOutput}=require('../../services/flowEngineV2.service');
  const patientText='You too';
  const signal={evidencia_confirmacion:patientText,asunto_confirmacion:'recepcion_datos',confianza_asunto_confirmacion:0.99,
    lectura_confirmacion:'sin_confirmacion',confianza_lectura_confirmacion:0.99,
    confirmacion_condicionada_o_incierta:false,confianza_confirmacion_condicionada_o_incierta:0.99,
    respuesta_afirmativa_a_la_clinica:true,confianza_respuesta_afirmativa_a_la_clinica:0.99,
    negacion_explicita_de_la_confirmacion:false,confianza_negacion_explicita_de_la_confirmacion:0.99,
    requiere_respuesta:false,confianza_requiere_respuesta:0.99};
  const output=deriveConfirmAppointmentOutput(signal,{patientText});
  assert.equal(output.confirma_asistencia,false);
  assert.equal(output.requiere_respuesta,true);
  const classified=projectClassifyIntentReferenceOutput({
    intencion_principal:'confirmar_cita',confianza_intencion_principal:0.99,
    decision_pospuesta:false,confianza_decision_pospuesta:0.99,
    asunto_preguntado:'asistencia',lectura_respuesta:'sin_decision',confianza_lectura_respuesta:0.99,
    evidencia_decision_actual:patientText,requiere_verificar_gestion_o_condicion:false,
    confianza_requiere_verificar_gestion_o_condicion:0.99,
    hay_asunto_por_resolver:false,confianza_hay_asunto_por_resolver:0.99,
  },{patientText});
  assert.equal(classified.intencion_principal,'otra');
  assert.equal(classified.necesita_respuesta,true);
});

test('an AI-identified pending fragment cannot be erased by another false flag', () => {
  const {deriveConfirmAppointmentOutput}=require('../../services/flowEngineV2.service');
  const patientText='Yes, this is my phone. Please correct the registered name';
  const output=deriveConfirmAppointmentOutput({
    evidencia_confirmacion:'Yes, this is my phone.',
    asunto_confirmacion:'datos_contacto',confianza_asunto_confirmacion:0.99,
    lectura_confirmacion:'acuse_recepcion',confianza_lectura_confirmacion:0.99,
    confirmacion_condicionada_o_incierta:false,confianza_confirmacion_condicionada_o_incierta:0.99,
    respuesta_afirmativa_a_la_clinica:true,confianza_respuesta_afirmativa_a_la_clinica:0.99,
    negacion_explicita_de_la_confirmacion:false,confianza_negacion_explicita_de_la_confirmacion:0.99,
    requiere_respuesta:false,confianza_requiere_respuesta:0.99,
    evidencia_asunto_pendiente:patientText,confianza_evidencia_asunto_pendiente:0.99,
  },{patientText});
  assert.equal(output.confirma_asistencia,true);
  assert.equal(output.requiere_respuesta,true);
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'agradecimiento',necesita_respuesta:false,
    hay_asunto_por_resolver:false,confianza_hay_asunto_por_resolver:0.99,
    evidencia_asunto_pendiente:patientText,confianza_evidencia_asunto_pendiente:0.99,
  },{patientText}).necesita_respuesta,true);
});

test('knowing the way cannot confirm attendance, but an explicit spontaneous commitment can', () => {
  const {deriveConfirmAppointmentOutput}=require('../../services/flowEngineV2.service');
  const patientText='I will attend';
  const signal={evidencia_confirmacion:patientText,asunto_confirmacion:'indicaciones',confianza_asunto_confirmacion:0.99,
    lectura_confirmacion:'afirmacion_incondicional',confianza_lectura_confirmacion:0.99,
    confirmacion_condicionada_o_incierta:false,confianza_confirmacion_condicionada_o_incierta:0.99,
    respuesta_afirmativa_a_la_clinica:true,confianza_respuesta_afirmativa_a_la_clinica:0.99,
    negacion_explicita_de_la_confirmacion:false,confianza_negacion_explicita_de_la_confirmacion:0.99,
    requiere_respuesta:false,confianza_requiere_respuesta:0.99};
  assert.equal(deriveConfirmAppointmentOutput(signal,{patientText}).confirma_asistencia,false);
  assert.equal(deriveConfirmAppointmentOutput(signal,{patientText}).requiere_respuesta,true);
  const commitment=deriveConfirmAppointmentOutput({...signal,lectura_confirmacion:'compromiso_asistencia'},{patientText});
  assert.equal(commitment.confirma_asistencia,true);
  assert.equal(commitment.requiere_respuesta,false);
});

test('confirmation reactions require a real current event, not a reaction invented by the model', () => {
  const {deriveConfirmAppointmentOutput}=require('../../services/flowEngineV2.service');
  const signal={evidencia_confirmacion:'',id_confirmacion_por_reaccion:47,
    asunto_confirmacion:'recepcion_datos',
    confianza_asunto_confirmacion:0.99,lectura_confirmacion:'acuse_recepcion',confianza_lectura_confirmacion:0.99,
    confirmacion_condicionada_o_incierta:false,confianza_confirmacion_condicionada_o_incierta:0.99,
    respuesta_afirmativa_a_la_clinica:true,confianza_respuesta_afirmativa_a_la_clinica:0.99,
    negacion_explicita_de_la_confirmacion:false,confianza_negacion_explicita_de_la_confirmacion:0.99,
    requiere_respuesta:false,confianza_requiere_respuesta:0.99};
  const responseItems=[{message_id:47,content_type:'reaction',emoji:'interpreted by AI',target_message_preview:'Confirm receipt'}];
  assert.equal(deriveConfirmAppointmentOutput(signal,{responseItems}).confirma_asistencia,true);
  assert.equal(deriveConfirmAppointmentOutput({...signal,confianza_lectura_confirmacion:0.4},
    {responseItems}).confirma_asistencia,false);
  for(const items of [[],[{...responseItems[0],message_id:48}],[{...responseItems[0],target_message_preview:''}]]) {
    const held=deriveConfirmAppointmentOutput(signal,{responseItems:items});
    assert.equal(held.confirma_asistencia,false);assert.equal(held.requiere_respuesta,true);
  }
});

test('a scoped reaction never borrows earlier text and the written batch can be flattened without losing requests', () => {
  const {buildScopedConfirmAppointmentBatch}=require('../../services/flowEngineV2.service');
  const current={last_response:'OLDER_TEXT',last_response_context:{response_message_id:47,
    response_items:[{message_id:47,content_type:'reaction',emoji:'interpreted by AI',target_message_preview:'Confirm receipt'}]}};
  assert.equal(buildScopedConfirmAppointmentBatch(current).response_text,null);
  const batch=buildScopedConfirmAppointmentBatch({last_response_context:{response_items:[
    {content_type:'text',text:'Yes, thank you'}, {content_type:'text',text:'Could we make it earlier, please?'},
  ]}}, {flattenMessages:true});
  assert.equal(batch.response_text,'Yes, thank you\nCould we make it earlier, please?');
  assert.equal(batch.response_messages,undefined);
});

test('even a historical reaction uses one AI call rather than a deterministic confirmation', async () => {
  const engine=require('../../services/flowEngineV2.service');
  const ai=require('../../services/aiOrchestrator.service');
  const original=ai.analyzeStructured;
  let calls=0;
  ai.analyzeStructured=async()=>{calls++;return {decision:'dudas',confianza:0.99,motivo:'Review the referenced reaction.',_ai_provider:'bedrock_test'};};
  try {
    const result=await engine._processNode({id:'AI',type:'condition/ai_analysis',config:{
      preset_key:'confirm_appointment',instruction:'Historical response contract',
      context_sources:[{key:'patient_message_batch',path:'{{last_response_context}}'}],
      output_fields:[{name:'decision',type:'string'},{name:'confianza',type:'number'},{name:'motivo',type:'string'}],
    },outputs:{on_success:'COMPARE',on_fail:'REVIEW'}},{
      last_response_context:{response_message_type:'reaction',reaction_emoji:'\u{1f44d}',listened_message_preview:'Do you know the way?'},
    },{simulation:false});
    assert.equal(calls,1);
    assert.equal(result.output.decision,'dudas');
    assert.equal(result.output._ai_provider,'bedrock_test');
  }finally{ai.analyzeStructured=original;}
});

test('old and customized preset instructions retain their text and receive the same grounding', () => {
  for (const instruction of ['Clasifica la intencion del paciente.', 'Analiza la respuesta con los parametros de esta clinica.']) {
    const result = buildClassifyIntentInstruction(instruction);
    assert(result.startsWith(instruction + ' '));
    assert(result.endsWith(CLASSIFY_INTENT_REFERENCE_INSTRUCTION));
    assert.equal(buildClassifyIntentInstruction(result), result);
  }
});

test('the real classification node adds grounding once and preserves legacy output columns', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  const fields = [
    { name: 'intencion_principal', type: 'string' },
    { name: 'confianza', type: 'number' },
    { name: 'accion_inequivoca', type: 'boolean' },
    { name: 'necesita_respuesta', type: 'boolean' },
    { name: 'motivo', type: 'string' },
  ];
  const calls = [];
  ai.analyzeStructured = async request => {
    calls.push(request);
    return { intencion_principal: 'otra', confianza: 0.93, accion_inequivoca: false,
      necesita_respuesta: true, motivo: 'La negativa responde a la ayuda para llegar.',
      asunto_preguntado: 'Indicaciones', significado_de_respuesta: 'Necesita aclaracion sobre como llegar.',
      _ai_provider: 'bedrock_test' };
  };
  try {
    for (const config of [
      { preset_key: 'classify_intent', instruction: 'Clasifica la intencion del paciente.',
        context_sources: [{ key: 'patient_message_batch', path: '{{last_response_context}}' }], output_fields: fields },
      cloneClassifyIntentPresetConfig(),
    ]) {
      const result = await engine._processNode({ id: 'AI', type: 'condition/ai_analysis', config,
        outputs: { on_success: 'COMPARE', on_fail: 'REVIEW' } }, {
        last_response_context: { response_text: 'No', listened_message_preview: 'Sabes llegar? Necesitas alguna indicacion?' },
        appointment: { estado: 'recordatorio_confirmado', inicio: '2026-10-02T08:00:00Z',
          qa_internal_data: 'APPOINTMENT_CONTEXT_MUST_NOT_ENTER_THE_MODEL' },
        trigger: { data: { qa_internal_data: 'TRIGGER_CONTEXT_MUST_NOT_ENTER_THE_MODEL' } },
      }, { simulation: false });
      assert.equal(result.kind, 'success');
      assert.equal(result.next_node_id, 'COMPARE');
      assert.equal(result.output.intencion_principal, 'otra');
      assert.equal(result.output._ai_provider, 'bedrock_test');
      assert(!Object.hasOwn(result.output, 'asunto_preguntado'));
      assert(!Object.hasOwn(result.output, 'significado_de_respuesta'));
    }
    assert.equal(calls.length, 2);
    assert(calls[0].prompt.startsWith('Clasifica la intencion del paciente.'));
    for (const request of calls) {
      assert.equal(request.prompt.split(CLASSIFY_INTENT_REFERENCE_INSTRUCTION).length - 1, 1);
      assert.match(request.inputText, /Sabes llegar\? Necesitas alguna indicacion\?/);
      assert.match(request.inputText, /"response_text":"No"/);
      assert.equal(request.inputText.split('patient_message_batch:').length - 1, 1);
      assert.deepEqual(Object.keys(request.outputFormat).slice(0, 5), ['decision_pospuesta', 'evidencia_asunto_pendiente', 'asunto_preguntado', 'significado_de_respuesta', 'lectura_respuesta']);
    }
    assert.equal(calls[0].outputFormat.accion_inequivoca, 'boolean');
    assert.equal(calls[0].outputFormat.confianza, 'number');
    assert.doesNotMatch(calls[0].inputText, /APPOINTMENT_CONTEXT_MUST_NOT_ENTER_THE_MODEL/);
    assert.match(calls[1].inputText, /APPOINTMENT_CONTEXT_MUST_NOT_ENTER_THE_MODEL|TRIGGER_CONTEXT_MUST_NOT_ENTER_THE_MODEL/);
  } finally { ai.analyzeStructured = original; }
});

test('classification preserves configured operational sources and prior context without replaying later messages', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async (value) => { request = value; return { intencion_principal: 'pregunta', necesita_respuesta: true }; };
  try {
    const config = cloneClassifyIntentPresetConfig();
    config.context_sources.push({ key: 'clinic_policy', path: '{{clinic_policy}}' });
    await engine._processNode({ id: 'CONTEXT', type: 'condition/ai_analysis', config, outputs: { on_success: null } }, {
      clinic_policy: 'Reception closes at 18:00',
      appointment: { estado: 'recordatorio_confirmado', inicio: '2026-10-02T08:00Z' },
      last_response_context: { response_message_id: 102, responded_at: '2026-10-02T06:01Z',
        response_text: 'Entonces a esa hora no puedo. La cambiamos?', listened_message_preview: 'Te esperamos manana.' },
      conversation_context_messages: [
        { id: 100, direction: 'outbound', sent_at: '2026-10-02T06:00Z', text: 'La cita es a las 10:00.' },
        { id: 101, direction: 'outbound', sent_at: '2026-10-02T06:00:10Z', text: 'Te esperamos manana.' },
        { id: 102, direction: 'inbound', sent_at: '2026-10-02T06:01Z', text: 'CURRENT_BATCH_DUPLICATE' },
        { id: 103, direction: 'inbound', sent_at: '2026-10-02T06:05Z', text: 'FUTURE_MESSAGE_MUST_NOT_ENTER' },
      ],
    }, { simulation: false });
    assert.match(request.inputText, /La cita es a las 10:00/);
    assert.match(request.inputText, /Reception closes at 18:00/);
    assert.match(request.inputText, /recordatorio_confirmado/);
    assert.doesNotMatch(request.inputText, /CURRENT_BATCH_DUPLICATE|FUTURE_MESSAGE_MUST_NOT_ENTER/);
    assert.equal(request.inputText.split('Te esperamos manana.').length - 1, 1);
    assert(request.inputText.indexOf('appointment:') < request.inputText.indexOf('clinic_message_replied_to:'));
    assert(request.inputText.indexOf('clinic_message_replied_to:') < request.inputText.indexOf('patient_message_batch:'));
  } finally { ai.analyzeStructured = original; }
});

test('custom recipes do not receive appointment intent instructions', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async value => { request = value; return { resultado: 'correcto' }; };
  try {
    await engine._processNode({ id: 'CUSTOM', type: 'condition/ai_analysis', config: {
      preset_key: 'custom', instruction: 'Valora esta respuesta.',
      context_sources: [{ key: 'respuesta', path: '{{last_response}}' }],
      output_fields: [{ name: 'resultado', type: 'string' }],
    }, outputs: { on_success: null, on_fail: null } }, { last_response: 'Un texto de prueba.' }, { simulation: false });
    assert.equal(request.prompt, 'Valora esta respuesta.');
    assert(!request.prompt.includes(CLASSIFY_INTENT_REFERENCE_INSTRUCTION));
  } finally { ai.analyzeStructured = original; }
});

test('intent aliases and mixed case cannot bypass the clinical evidence gate', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  try {
    for (const intent of ['confirmado', 'Confirmar_cita', 'CANCELACION', 'reprogramar']) {
      ai.analyzeStructured = async () => ({intencion_principal:intent,confianza_intencion_principal:0.99,
        necesita_respuesta:false,hay_asunto_por_resolver:false,confianza_hay_asunto_por_resolver:0.99});
      const result = await engine._processNode({id:'ALIASES',type:'condition/ai_analysis',
        config:cloneClassifyIntentPresetConfig(),outputs:{on_success:'COMPARE'}}, {
        last_response_context:{response_text:'No',listened_message_preview:'Sabes llegar?'},
      }, {simulation:false});
      assert.equal(result.output.intencion_principal,'otra');
      assert.equal(result.output.confianza,0);
      assert.equal(result.output.necesita_respuesta,true);
    }
  } finally {ai.analyzeStructured = original;}
});

test('confirmation keeps the clinic reference outside the new patient batch', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async (value) => {
    request = value;
    return { respuesta_afirmativa_a_la_clinica:false, negacion_explicita_de_la_confirmacion:false,
      requiere_respuesta:true, confianza_respuesta_afirmativa_a_la_clinica:0.99,
      confianza_negacion_explicita_de_la_confirmacion:0.99, confianza_requiere_respuesta:0.99 };
  };
  try {
    const { cloneConfirmAppointmentPresetConfig } = require('../../lib/automation-intent-contract');
    const result = await engine._processNode({ id:'CONFIRM', type:'condition/ai_analysis',
      config:cloneConfirmAppointmentPresetConfig(), outputs:{on_success:'CHECK'} }, {
      last_response_context:{response_text:'Ubicacion', listened_message_preview:'Confirmas tu telefono?'},
    }, {simulation:false});
    const batch = JSON.parse(request.inputText.split('patient_message_batch:')[1].trim());
    assert.equal(batch.response_text, 'Ubicacion');
    assert(!Object.hasOwn(batch, 'listened_message_preview'));
    assert.equal(request.inputText.split('Confirmas tu telefono?').length - 1, 1);
    assert.equal(result.output.confirma_asistencia, false);
    assert.equal(result.output.requiere_respuesta, true);
  } finally { ai.analyzeStructured = original; }
});

test('classification keeps the ordered batch and reaction reference without historical echoes', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async value => {
    request = value;
    return { intencion_principal: 'otra', necesita_respuesta: true };
  };
  try {
    await engine._processNode({ id: 'BATCH', type: 'condition/ai_analysis',
      config: cloneClassifyIntentPresetConfig(), outputs: { on_success: null } }, {
      last_prompt: 'OLDER_REFERENCE',
      conversation_today: '[02/10/2026, 08:10] Paciente: HISTORICAL_ECHO_MUST_NOT_ENTER_THE_MODEL',
      last_response_context: {
        response_message_id: 99001,
        response_text: 'No es necesario\nYa he ido varias veces',
        response_lines: ['No es necesario', 'Ya he ido varias veces'],
        response_items: [
          { content_type: 'text', text: 'No es necesario' },
          { content_type: 'text', text: 'Ya he ido varias veces' },
          { content_type: 'attachment', content_available: false, media_kind: 'sticker' },
        ],
        listened_message_preview: 'Necesitas indicaciones?',
        reaction_emoji: '\u{1f44d}',
        reaction_target_message_preview: 'Confirmas tu asistencia?',
      },
    }, { simulation: false });
    const batch = JSON.parse(request.inputText.split('patient_message_batch:')[1].trim().split('\n')[0]);
    assert.equal(batch.response_text, 'No es necesario\nYa he ido varias veces');
    assert(!Object.hasOwn(batch, 'response_messages'));
    assert.equal(batch.response_items.length, 1);
    assert.equal(batch.response_items[0].content_available, false);
    assert.equal(batch.reaction_emoji, '\u{1f44d}');
    assert(!Object.hasOwn(batch, 'reaction_target_message_preview'));
    assert(!Object.hasOwn(batch, 'listened_message_preview'));
    assert.equal(request.inputText.split('Confirmas tu asistencia?').length - 1, 1);
    assert.match(request.inputText, /\nclinic_message_replied_to:/);
    assert.doesNotMatch(request.inputText, /HISTORICAL_ECHO|OLDER_REFERENCE/);
    assert.equal(request.inputText.split('No es necesario').length - 1, 1);
  } finally { ai.analyzeStructured = original; }
});

test('classification preserves a single text item even when response_text is absent', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async value => { request = value; return { intencion_principal: 'otra' }; };
  try {
    await engine._processNode({ id: 'SINGLE', type: 'condition/ai_analysis',
      config: cloneClassifyIntentPresetConfig(), outputs: { on_success: null } }, {
      last_response_context: {
        response_message_id: 99001,
        listened_message_preview: 'Necesitas indicaciones?',
        response_items: [{ content_type: 'text', text: 'No las necesito, gracias.' }],
      },
    }, { simulation: false });
    assert.match(request.inputText, /No las necesito, gracias/);
    assert.equal(request.inputText.split('No las necesito, gracias').length - 1, 1);
  } finally { ai.analyzeStructured = original; }
});
