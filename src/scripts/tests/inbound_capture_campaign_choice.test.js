'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const decisions = require('../../services/inboundLeadCaptureDecision.service');
const campaignText = 'Programa de abdomen por 299 €.\n¿Quieres ver las promos de rostro, cuerpo y escote y cirugía?\nResponde INFO. Para dejar de recibir mensajes, responde BAJA.';
const check = (message, extra = {}) => decisions.simulate({ campaignText, message, history:[], optedOut:false, ...extra }, {});

test('accepts a short selection only from the offered categories', async () => {
  for (const message of ['Hola\nDe rostro', '¡Hola! La de cuerpo, gracias', 'Cirugía', 'La de escote por favor'])
    assert.deepEqual(await check(message), { kind:'interest', reason:'campaign_choice' });
  assert.equal((await check('De rostro', {history:['Buenos días','Hola!']})).reason, 'campaign_choice');
  assert.equal((await check('De rostro', {campaignText:''})).kind, 'review');
  assert.equal((await check('De abdomen')).kind, 'review');
  assert.equal((await check('De rostro', {history:['Tengo mi cita el jueves']})).kind, 'review');
  assert.equal((await check('De rostro', {campaignText:'Tratamiento de rostro. ¿Puedes confirmar tu cita?'})).kind, 'review');
  assert.equal((await check('Prefiero depilación', {campaignText:'¿Qué tratamiento te interesa: láser o depilación?'})).reason, 'campaign_choice');
});

test('respects opt-outs, medical follow-up, quotes, negation and appointments', async () => {
  for (const [message, kind] of [['BAJA','opt_out'], ['De rostro no','review'], ['No me interesa','review'],
    ['Responde INFO','ignore'], ['Sobre mi sesión de rostro, no he notado ningún cambio','ignore'],
    ['Quiero cambiar mi cita de rostro','ignore'], ['Quiero cambiar mi cita y saber el precio','review']])
    assert.equal((await check(message)).kind, kind, message);
  assert.equal((await check('De rostro',{optedOut:true})).kind, 'opt_out');
  assert.equal((await check('INFO',{campaignText:''})).kind, 'interest');
});
