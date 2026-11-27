'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {appointmentIntent} = require('../../lib/inbound-commercial-language');
const {classifyInterest, asksForCommercialInformation, assistantCommercialText, explicitOptOut} =
  require('../../services/socialLeadInterestClassification.service');
const {classifyDeterministically} = require('../../services/reviewResponseClassification.service');

test('copied campaign instructions do not opt out, capture interest or dispatch inference', async () => {
  for (const text of ['Responde BAJA', 'Responda con la palabra «BAJA».', 'Oferta. Responde INFO para el precio. Responde BAJA.',
    'Para dejar de recibir notificaciones, responde *BAJA*.', '> Responde BAJA']) {
    assert.equal(explicitOptOut(text),false);
    assert.equal(classifyDeterministically(text).intent,'ambiguous');
    assert.equal(asksForCommercialInformation(text),false);
    assert.equal(assistantCommercialText(text),null);
    assert.deepEqual(await classifyInterest({type:'dm',text},{beforeDispatch:()=>{throw Error('unexpected');},reportFailure:true}),
      {kind:'review',privateRequested:false});
  }
  for (const text of ['Solicito la baja médica','No quiero darme de baja', 'La publicidad decía «No me escribas más».']) {
    assert.equal(explicitOptOut(text),false,text);
    assert.equal(classifyDeterministically(text).intent,'ambiguous',text);
  }
  for (const text of ['BAJA', 'Por favor, BAJA', 'báixa', 'No me escribáis más',
    'Responde BAJA.\nBAJA','No quiero recibir más mensajes.\nResponde BAJA.']) {
    assert.equal(explicitOptOut(text),true,text);
    assert.equal(classifyDeterministically(text).intent,'marketing_opt_out',text);
  }
});

test('a visit change remains with the team; plural prices and first assessments are commercial', () => {
  for (const text of ['Quiero cambiar mi cita del jueves','Quiero información para cambiar mi cita del jueves',
    '¿Podéis posponer mi visita?','¿A qué hora tengo mi cita?']) {
    assert.equal(appointmentIntent(text),'appointment_management',text);
    assert.equal(asksForCommercialInformation(text),false,text);
    assert.equal(assistantCommercialText(text),null,text);
  }
  const mixed = 'Quiero mover mi cita y conocer el precio de la oferta';
  assert.equal(appointmentIntent(mixed),'mixed_appointment_interest');
  assert.equal(asksForCommercialInformation(mixed),false);
  for (const text of ['¿Cuánto cuestan tres sesiones faciales?', '¿Cuánto valen?','¿Hay hueco para una primera valoración?']) {
    assert.equal(asksForCommercialInformation(text),true,text);
  }
});

test('a short question can refer to its own promotion without authorizing contact', async () => {
  const entry={type:'comment',text:'¿Y para dos sesiones?',senderId:'PRIVATE',post:{
    caption:'Promoción facial. Precios en @clinicademo o https://example.invalid',imageUrl:'https://private.invalid'}};
  const calls=[];
  const analyze = async request => {calls.push(JSON.parse(request.inputText)); return {kind:'interest'};};
  const options = {beforeDispatch:async()=>true,analyze,reportFailure:true};
  assert.deepEqual(await classifyInterest(entry,options),{kind:'interest',privateRequested:false});
  assert.equal(calls.length,1);
  assert.equal(calls[0].text,entry.text);
  assert.match(calls[0].caption,/promoci[oó]n/i);
  assert.doesNotMatch(JSON.stringify(calls),/PRIVATE|example|private|clinicademo/i);
  for (const variation of [{type:'dm'}, {post:{}},{post:{caption:'Una foto de la ciudad.'}}]) {
    assert.deepEqual(await classifyInterest({...entry,...variation},options),{kind:'review',privateRequested:false});
  }
  assert.equal(calls.length,1);
});

test('invalid classifier results and service failures are retryable for capture; actual ambiguity is a verdict', async () => {
  const entry={type:'dm',text:'¿Qué precio tiene?'};
  const options={beforeDispatch:()=>true,reportFailure:true};
  await assert.rejects(classifyInterest(entry,{...options,analyze:async()=>({other:'interest'})}),{code:'inbound_capture_classifier_invalid'});
  await assert.rejects(classifyInterest(entry,{...options,analyze:async()=>{throw Error('provider-private-detail');}}),
    {code:'inbound_capture_classifier_unavailable',message:'inbound_capture_classifier_unavailable'});
  assert.deepEqual(await classifyInterest(entry,{...options,analyze:async()=>({kind:'review'})}),{kind:'review',privateRequested:false});
  assert.deepEqual(await classifyInterest(entry,{...options,beforeDispatch:()=>false,analyze:async()=>{throw Error('must not run');}}),
    {kind:'review',privateRequested:false});
});

test('a first-person post-treatment concern stays with the team; a prospective efficacy question remains eligible', async () => {
  const { postTreatmentFollowUp } = require('../../lib/inbound-commercial-language');
  for (const text of ['El tratamiento no me ha hecho efecto apenas, ¿puedo pasar?', 'No he notado ningún cambio después de mi sesión.']) {
    assert.equal(postTreatmentFollowUp(text), true);
    assert.equal(asksForCommercialInformation(text), false);
    assert.equal(assistantCommercialText(text), null);
    const result = await classifyInterest({ text, type:'dm' }, { beforeDispatch: () => { throw Error('unexpected inference'); } });
    assert.equal(result.kind, 'ignore');
    assert.equal(result.privateRequested, false);
  }
  assert.equal(postTreatmentFollowUp('¿Cuánto cuesta y en cuánto tiempo hace efecto?'), false);
});
