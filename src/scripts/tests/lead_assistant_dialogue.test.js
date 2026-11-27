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
  assert.match(formatCommercialReply({ ...params, firstTurn:true }), /asistente de IA de Clínica Nube.*25 minutos.*recepción/);
  assert.equal(formatCommercialReply({ ...params, firstTurn:false }), params.draft);
  assert.throws(() => formatHandoffReceipt({recorded:false}), /not_recorded/);
  assert.match(formatHandoffReceipt({recorded:true,requestedCallback:true}), /plazo confirmado/);
  assert(!formatHandoffReceipt({recorded:true,requestedCallback:false}).includes('llamada'));
});

test('a request for reception or a call hands over before generation, while an explicit refusal does not', () => {
  assert.deepEqual(requestedHumanHandoff('Prefiero hablar con recepción. ¿Me llaman en diez minutos?'), { requestedCallback:true });
  assert.deepEqual(requestedHumanHandoff('¿Me pasas con una persona?'), { requestedCallback:false });
  assert.equal(requestedHumanHandoff('No quiero hablar con recepción.'), null);
  assert.equal(requestedHumanHandoff('¿Hay algo el viernes por la tarde?'), null);
});
