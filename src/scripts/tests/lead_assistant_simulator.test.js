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
    const result=await simulator.turn(41,3,id,{id:randomUUID(),message,promotion:''});
    assert.equal(result.event,event);
    if (event === 'opt_out') assert.equal(result.reply,'');
    await assert.rejects(simulator.turn(41,3,id,{id:randomUUID(),message:'INFO',promotion:''}),{code:'assistant_simulator_limit'});
  }
  assert.equal(calls.length,0);
});

function bookingSimulator({services = [{id_tratamiento:1,nombre:'Valoración',codigo:'VAL'}],allowed = true}={}) {
  const fields = {tone:'Breve',context:'Valoraciones',guardrails:'Solo información comercial',
    booking:'Servicio de agenda: VAL\nPide el correo electrónico para el recordatorio.',promotions:''};
  const db = {
    Sequelize:require('sequelize').Sequelize, Tratamiento:{findAll:async()=>services},
    LeadAssistantDraft:{findByPk:async()=>({version:1,fields})}, LeadAssistantPublication:{findOne:async()=>null},
    Clinica:{findByPk:async()=>({id_clinica:1,nombre_clinica:'Prueba'})},
  };
  return create({db,analyze:()=>assert.fail('booking is local'),recipients:async()=>({destination:'unassigned'}),
    booking:args=>require('../../services/leadAssistantBooking.service').processTurn({...args,mayBook:async()=>allowed})});
}

test('the sample calendar completes a booking with the authorised catalogue and no patient, appointment or transport models', async()=>{
  const sim = bookingSimulator();
  const s=await sim.start(1,42);
  const ask=message=>sim.turn(1,42,s.id,{id:randomUUID(),message,promotion:'',calendar:'demo'});
  const offered=await ask('¿Qué horarios hay para una valoración el 2030-01-07 por la tarde?');
  assert.deepEqual(offered.slots.map(slot=>slot.message),['La primera','La segunda']);
  assert.match(offered.slots[0].label,/16:00/);assert.match(offered.slots[1].label,/17:30/);
  await assert.rejects(sim.turn(1,42,s.id,{id:randomUUID(),message:'La primera',promotion:'',calendar:'clinic'}),{code:'assistant_simulator_invalid'});
  assert.match((await ask(offered.slots[1].message)).reply,/recordatorio/);
  assert.match((await ask('Ana Prueba, +34600000001, ana@example.invalid')).reply,/17:30/);
  assert.equal((await ask('Confirmo')).event,'booked');
});

test('the simulated WhatsApp sender already supplies the phone number and cannot change channel mid-thread', async () => {
  const sim = bookingSimulator();
  for (const channel of ['whatsapp','instagram','messenger']) {
    const {id}=await sim.start(1,42);
    const ask=(text,via=channel)=>sim.turn(1,42,id,{id:randomUUID(),message:text,promotion:'',calendar:'demo',channel:via});
    await ask('¿Qué horarios hay para el 2030-01-07?');
    await assert.rejects(ask('La primera',channel==='whatsapp'?'instagram':'whatsapp'),{code:'assistant_simulator_invalid'});
    const prompt=(await ask('La primera')).reply;
    if (channel==='whatsapp') assert.match(prompt,/ya tengo el móvil/);
    else assert.match(prompt,/tu número de móvil/);
  }
});

test('fictitious slots still require a configured service and the same scheduling permission as live slots',async()=>{
  for (const config of [{services:[]},{allowed:false}]) {
    const sim=bookingSimulator(config);
    for (const calendar of ['demo','clinic']) {
      const {id}=await sim.start(1,42);
      const result=await sim.turn(1,42,id,{id:randomUUID(),message:'Quiero una cita',calendar,promotion:''});
      assert.equal(result.event,'handoff');assert.equal(result.slots,undefined);
    }
  }
});
