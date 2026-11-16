'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertCurrentImportedCare}=require('../../lib/review-care-current-import');
const snapshots=require('../../lib/review-care-snapshot');
function item(clinic=70,identity='22',record='31') {
 const r={list_id:9,paciente_id:11,clinica_id:clinic,custom_fields:{}};
 r.custom_fields[snapshots.KEY]=snapshots.sealCareSnapshot({item:r,listId:9,actorId:1,
  care:{patientId:11,clinicId:clinic,latestCare:{date:'2026-09-30',kind:'performed_service_import',provenance:[{
   kind:'performed_service_import',sourceRecordId:record,identityId:identity,sourceInstance:`fixture:clinic-${clinic}`,
   sourceSystem:'arriaga_excel',sourceKey:'key',rowSha256:'row',databaseSha256:'db',bundleSha256:'bundle'}]}}});
 return r;
}
const source=(clinic=70,identity='22')=>({id:'31',patient_id:11,clinic_id:clinic,identity_id:identity,
 identity_patient_id:11,identity_clinic_id:clinic,source_instance:`fixture:clinic-${clinic}`,source_system:'arriaga_excel',
 source_key:'key',row_sha256:'row',database_sha256:'db',bundle_sha256:'bundle'});
test('a corrected import blocks the old venue but retains its immutable receipt and accepts a newly selected venue',async()=>{
 const original=item(),before=JSON.stringify(original);let row=source();
 const query=async()=>[row];await assertCurrentImportedCare({items:[original],query});
 row=source(1,'21');await assert.rejects(assertCurrentImportedCare({items:[original],query}),{code:'review_care_source_attribution_changed',status:409});
 assert.equal(JSON.stringify(original),before);snapshots.validateCareSnapshot(original,{id:9});
 await assertCurrentImportedCare({items:[item(1,'21')],query});
});
test('missing source, wrong patient, identity, original hashes or source key cannot authorize a new communication',async()=>{
 for(const row of [null,{...source(),patient_id:12},{...source(),identity_clinic_id:1},{...source(),identity_id:'33'},
  {...source(),row_sha256:'changed'},{...source(),source_key:'different'}])
  await assert.rejects(assertCurrentImportedCare({items:[item()],query:async()=>row?[row]:[]}),{code:'review_care_source_attribution_changed'});
});
test('source read failure stops delivery without exposing private database diagnostics',async()=>{
 await assert.rejects(assertCurrentImportedCare({items:[item()],query:async()=>{throw Error('PRIVATE_DIAGNOSTIC');}}),
  e=>e.status===503&&e.code==='review_care_source_attribution_unavailable'&&!e.message.includes('PRIVATE'));
});
test('native or declared care without an imported reference does not query the archive',async()=>{
 let calls=0;const r=item();r.custom_fields[snapshots.KEY].provenance=[];
 await assertCurrentImportedCare({items:[r,{custom_fields:{}}],query:async()=>{calls++;return[];}});assert.equal(calls,0);
});
test('large source IDs remain strings and reads are bounded and deduplicated',async()=>{
 const rows=Array.from({length:401},(_,i)=>item(70,'22',String(90071992547409931n+BigInt(i))));let calls=0;
 await assertCurrentImportedCare({items:[...rows,...rows],query:async(sql,args)=>{
  calls++;assert(args.sourceRecordIds.length<=200);assert(!/\b(?:UPDATE|DELETE|INSERT)\b/i.test(sql));
  return args.sourceRecordIds.map(id=>({...source(),id}));
 }});assert.equal(calls,3);
});
