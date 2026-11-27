'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {create} = require('../../services/leadAssistantSimulator.service');
function fixture() {
  const fields = {tone:'Identifícate como «Cleo».',context:'Primera visita.',guardrails:'Usa solo las tarifas aprobadas.',
    booking:'Consulta de prueba.',promotions:'C01-01 – Programa de ejemplo\nDos sesiones por 35 €.'};
  const draft = {fields,version:4};
  const db = {LeadAssistantDraft:{findByPk:async()=>draft},LeadAssistantPublication:{findOne:async()=>({version:3})},
    Clinica:{findByPk:async()=>({nombre_clinica:'Clínica ficticia',grupoClinicaId:5})}};
  const calls = [];
  const simulator=create({db,booking:async()=>null,recipients:async()=>({destination:'reception'}),analyze:async args=>{
    calls.push(args);return {reply:'Dos sesiones por 35 €.'};
  }});
  return {simulator,draft,calls};
}
test('saved unapproved version, real commercial request contract, retained context, retry and actor scope',async()=>{
  const {simulator,draft,calls}=fixture();
  const s=await simulator.start(41,3);
  assert(!s.approved);assert.equal(s.version,4);assert.equal(s.promotions[0].key,'C01-01');
  const command={id:randomUUID(),message:'INFO',promotion:s.promotions[0].key};
  await assert.rejects(simulator.turn(42,3,s.id,command),{code:'assistant_simulator_expired'});
  await assert.rejects(simulator.turn(41,4,s.id,command),{code:'assistant_simulator_expired'});
  const answer=await simulator.turn(41,3,s.id,command);
  assert.match(answer.reply,/asistente de IA/);assert.equal(answer.event,'reply');assert.equal(calls.length,1);
  const body=JSON.parse(calls[0].inputText);
  assert.equal(calls[0].useCase,'lead_assistant_reply');assert(calls[0].requireBroker);assert.equal(calls[0].clinicId,41);
  assert.match(body.promotion.description,/35 €/);
  assert.deepEqual(await simulator.turn(41,3,s.id,command),answer);assert.equal(calls.length,1);
  const next=await simulator.turn(41,3,s.id,{...command,id:randomUUID(),message:'¿Y cuántas sesiones son?'});
  assert(!next.reply.includes('asistente de IA'));assert.equal(JSON.parse(calls[1].inputText).commercialHistory.length,2);
  draft.version++;await assert.rejects(simulator.turn(41,3,s.id,{...command,id:randomUUID()}),{code:'assistant_simulator_changed'});
});
test('handoff, clinical follow-up and opt-out finish the test locally',async()=>{
  const {simulator,calls}=fixture();
  for (const [message,event] of [['Quiero hablar con una persona','handoff'],['No he notado ningún cambio después de mi sesión','handoff'],['BAJA','opt_out']]) {
    const {id}=await simulator.start(41,3);
    assert.equal((await simulator.turn(41,3,id,{id:randomUUID(),message,promotion:''})).event,event);
    await assert.rejects(simulator.turn(41,3,id,{id:randomUUID(),message:'INFO',promotion:''}),{code:'assistant_simulator_limit'});
  }
  assert.equal(calls.length,0);
});
