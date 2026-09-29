'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collect}=require('../../lib/whatsappReceptionAlerts');
const now=Date.now(),bindings=[{clinicId:2,sendEnabled:true}];
const snapshot={version:1,observedAt:now,clinics:[{clinicId:2,blockingReview:4,unscopedBlockingReview:0,blockingContactKeys:['a'.repeat(64)],oldestPendingAt:null}]};
test('scoped identity warnings reach the email event even without a critical clinic-wide outage',async()=>{
 const alerts=await collect({snapshot,bindings,now,query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]]});
 assert.equal(alerts.length,1);assert.equal(alerts[0].eventKey,'whatsapp.reception_attention');
 assert.equal(alerts[0].payload.severity,'warning');assert.match(alerts[0].payload.detail,/Ficticia/);
 assert.doesNotMatch(JSON.stringify(alerts),/a{64}/);
});
test('a native wait with a durable reply is reported independently of broker health',async()=>{
 const alerts=await collect({snapshot:{...snapshot,clinics:[{clinicId:2,blockingReview:0,oldestPendingAt:null}]},bindings,now,
 query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[{id:12,clinic_id:2}]]});
 assert.equal(alerts.length,1);assert.deepEqual(alerts[0].metadata.waiting_execution_ids,[12]);
});
test('unconfigured environments do not inspect or notify clinical reception',async()=>{
 assert.deepEqual(await collect({snapshot:null,bindings:[],query:async()=>{throw Error('unexpected query')}}),[]);
});

// Exercise the same replacement parser as Sequelize.query. A mysql2-only
// diagnostic used a different formatter and failed to reveal the '<:until' bug.
test('production Sequelize parser replaces every parameter in reception SQL',async()=>{
 const {Sequelize}=require('sequelize');
 const {injectReplacements}=require('sequelize/lib/utils/sql');
 const sqlEngine=new Sequelize('synthetic','synthetic','synthetic',{dialect:'mysql',logging:false});
 let queries=0;
 const alerts=await collect({snapshot,bindings,now,query:async(sql,options)=>{
  const rendered=injectReplacements(sql,sqlEngine.dialect,options.replacements);
  assert.doesNotMatch(rendered,/:[a-zA-Z][a-zA-Z0-9_]*/);
  if(sql.includes('FlowExecutionsV2'))assert.match(rendered,/wait_until\s*<\s*'\d{4}-\d{2}-\d{2}/);
  queries++;
  return [sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]];
 }});
 assert.equal(queries,2);assert.equal(alerts[0].payload.severity,'warning');
});
test('query failure retains a safe diagnostic code without SQL or error details',()=>{
 const {unavailable}=require('../../lib/whatsappReceptionAlerts');
 const alert=unavailable({original:{code:'ER_PARSE_ERROR'},sql:'private SQL',message:'private details'});
 assert.equal(alert.metadata.check_error_code,'ER_PARSE_ERROR');
 assert.equal(alert.payload.severity,'critical');
 assert.doesNotMatch(JSON.stringify(alert),/private/);
 assert.equal(unavailable({code:'private secret'}).metadata.check_error_code,'CHECK_FAILED');
});
