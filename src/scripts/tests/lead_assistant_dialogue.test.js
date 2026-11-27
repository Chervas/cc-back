'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDraftRequest, formatCommercialReply, requestedHumanHandoff, formatHandoffReceipt } = require('../../services/leadAssistantDialogue.service');

const fixture = () => ({
  clinicName: 'Clínica Nube', tone: 'Breve y cercano', approvedFacts: ['Visita informativa: 35 €.'],
  matchedPromotion: { title: 'Puertas abiertas', description: 'Incluye 25 minutos de orientación.' },
  commercialHistory: [], userText: 'INFO', availableSlots: [],
});

test('only explicitly projected commercial fields are included in a model request', () => {
  const turn = fixture();
  turn.history = { privateNote: 'private_canary' };
  turn.matchedPromotion.owner = 'private_canary';
  turn.commercialHistory = [{ role:'user', text:'¿Hay huecos?', senderPhone:'private_canary' }];
  turn.availableSlots = [{ label:'Viernes a las 16:30', patient:'private_canary' }];
  const request = buildDraftRequest(turn);
  assert.equal(request.requireBroker, true);
  assert(!request.inputText.includes('private_canary'));
  assert.deepEqual(JSON.parse(request.inputText).availableSlots, ['Viernes a las 16:30']);
  assert.throws(() => buildDraftRequest({ ...turn, commercialHistory:[{role:'system',text:'fake'}] }));
});

test('the channel introduces the assistant once and handoff needs a recorded result', () => {
  const params = { clinicName:'Clínica Nube', draft:'La visita incluye 25 minutos.' };
  assert.match(formatCommercialReply({ ...params, firstTurn:true }), /asistente de IA de Clínica Nube.*25 minutos.*persona del equipo/);
  assert.equal(formatCommercialReply({ ...params, firstTurn:false }), params.draft);
  assert.throws(() => formatHandoffReceipt({recorded:false}), /not_recorded/);
  assert.match(formatHandoffReceipt({recorded:true,requestedCallback:true,destination:'reception'}), /plazo confirmado/);
  assert(!formatHandoffReceipt({recorded:true,requestedCallback:false,destination:'patient_director'}).includes('llamada'));
});

test('a request for reception or a call hands over before generation, while an explicit refusal does not', () => {
  assert.deepEqual(requestedHumanHandoff('Prefiero hablar con recepción. ¿Me llaman en diez minutos?'), { requestedCallback:true });
  assert.deepEqual(requestedHumanHandoff('¿Me pasas con una persona?'), { requestedCallback:false });
  assert.equal(requestedHumanHandoff('No quiero hablar con recepción.'), null);
  assert.deepEqual(requestedHumanHandoff('¿Puedo hablar con la directora de pacientes?'), { requestedCallback:false });
  assert.equal(requestedHumanHandoff('¿Hay algo el viernes por la tarde?'), null);
});

test('exige una fuente aprobada para cada cantidad y descuento de una respuesta comercial',()=>{
  const {supportsQuotedAmounts}=require('../../services/leadAssistantDialogue.service');
  const approved=['La valoración cuesta 85,50 € y el tratamiento 1.250 € en total.'];
  assert(supportsQuotedAmounts('Son 85,50 euros. El tratamiento cuesta 1250 €.',approved));
  assert(!supportsQuotedAmounts('El precio es 125 €. ¿Te interesa?',approved));
  assert(!supportsQuotedAmounts('Puedo ofrecerte un 15 por ciento.',approved));
  assert(!supportsQuotedAmounts('Cuesta $85,50.',approved));
});

test('conserva el último tratamiento de un contexto aprobado de 120.000 caracteres Unicode', () => {
  const ending = '📘 La consulta de orientación dura 25 minutos.';
  const approvedContext = 'x'.repeat(120000-Array.from(ending).length)+ending;
  const request = require('../../services/leadAssistantDialogue.service').buildDraftRequest({
    clinicName:'Clínica ficticia',tone:'Breve',approvedContext,approvedFacts:['Recepción atiende por la mañana.'],
    commercialHistory:[],userText:'¿Cuánto dura esa consulta?',availableSlots:[]});
  assert.equal(JSON.parse(request.inputText).approvedContext,approvedContext);
});
