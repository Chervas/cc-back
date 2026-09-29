'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const phone=require('../../lib/phone');
function fixture(rows){
 const changes=[],deletions=[];for(const r of rows)r.update=async p=>{changes.push(p);Object.assign(r,p)};
 const Op={or:Symbol('or'),in:Symbol('in')};
 const db={Sequelize:{Op},Conversation:{findAll:async()=>rows,destroy:async x=>deletions.push(x)}};
 const s={module:{exports:{}},require:n=>n==='../../models'?db:n==='./phone'?phone:{},process:{env:{}},Date,Number,Map,Set};
 vm.createContext(s);vm.runInContext(fs.readFileSync(require.resolve('../../lib/canonical-conversation'),'utf8'),s);
 return {run:args=>s.module.exports.findCanonicalWhatsappConversation({clinicId:2,...args}),changes,deletions};
}
test('international identity never collapses countries with the same nine-digit suffix',()=>{
 const a=phone.getPhoneIdentityCandidates('+213665519703'),b=phone.getPhoneIdentityCandidates('+34665519703');
 assert.equal(a.some(x=>b.includes(x)),false);assert(b.includes('665519703'));
});
test('opening a patient with an old phone keeps the current chat address and history',async()=>{
 const row={id:3,clinic_id:2,patient_id:4,contact_id:'+213555902016'};const f=fixture([row]);
 assert.equal((await f.run({patientId:4,contactId:'665519703'})).id,3);
 assert.equal(row.contact_id,'+213555902016');assert.equal(f.changes.length,0);assert.equal(f.deletions.length,0);
});
test('the same patient can have two numbers without merging their histories',async()=>{
 const f=fixture([{id:3,patient_id:4,contact_id:'+213665519703'},{id:8,patient_id:4,contact_id:'+34665519703'}]);
 assert.equal((await f.run({patientId:4,contactId:'+213665519703'})).id,3);assert.equal(f.deletions.length,0);
});
test('a phone owned by another patient cannot be silently reassigned',async()=>{
 const f=fixture([{id:3,patient_id:99,contact_id:'+34665519703'}]);
 await assert.rejects(f.run({patientId:4,contactId:'+34665519703'}),e=>e.code==='whatsapp_contact_identity_conflict'&&e.status===409);
 assert.equal(f.changes.length,0);assert.equal(f.deletions.length,0);
});
test('even without a requested patient, conflicting owners are never merged',async()=>{
 const f=fixture([{id:3,patient_id:4,contact_id:'+34665519703'},{id:8,patient_id:99,contact_id:'+34665519703'}]);
 await assert.rejects(f.run({contactId:'+34665519703'}),e=>e.code==='whatsapp_contact_identity_conflict');
 assert.equal(f.changes.length,0);assert.equal(f.deletions.length,0);
});

test('an automated sender cannot use a different phone history as its target chat',async()=>{
 const f=fixture([{id:3,patient_id:4,contact_id:'+213555902016'}]);
 await assert.rejects(f.run({patientId:4,contactId:'+34665519703',requireExactContact:true}),e=>e.code==='whatsapp_contact_identity_conflict');
 assert.equal(f.changes.length,0);assert.equal(f.deletions.length,0);
});
