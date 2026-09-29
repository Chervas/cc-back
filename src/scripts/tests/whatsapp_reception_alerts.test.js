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
