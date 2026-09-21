'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {prepareNativeCorroboration}=require('../../lib/cliniccloud-import/contact-alias-evidence');
const now=Date.parse('2026-09-21T04:00:00Z');
function fixture(){
 const source={source_contact_id:'456',fields:{name:'Persona',surname:'Origen',phone:'600000001'}};
 const appointment={kind:'appointment',source_contact_id:'456',start_utc:'2026-09-22T15:45:00.000Z',status:'pendiente',validation_errors:[],
  provenance:{source_row:9,file_sha256:'f'.repeat(64),row_sha256:'e'.repeat(64)}};
 const plan={manifest:{source_system:'cliniccloud',source_account:'cliniccloud-5880',automation_policy:'hold'},
  actions:[{entity:'appointment',source:appointment,action_key:'a'.repeat(64)},
   {entity:'appointment',action:'preserve_native',local_id:81,action_key:'b'.repeat(64)}]};
 plan.plan_sha256=hash({manifest:plan.manifest,actions:plan.actions});
 const comparison={captured_at:'2026-09-21T03:30:00Z',plan_sha256:plan.plan_sha256,
  rows:[{source_row:9,action_key:'a'.repeat(64),state:'pendiente',live_ids:['8765'],status:'unique_live_identity_corroborated'}]};
 comparison.comparison_sha256=hash(comparison);
 return {link:{native_first_visit:{reason:'Revisión expresa de contacto y cita de primera visita',source_row:9,appointment_id:71,created_by:44,clinic_id:72}},
  source,contacts:[source],appointments:[appointment],plan,comparison,now};
}
function rehashComparison(f){const {comparison_sha256,...body}=f.comparison;f.comparison.comparison_sha256=hash(body);}
test('corroboration ties normalized CSV row, source identity and unique observed live ID to reviewed native visit',()=>{
 const f=fixture(),before=JSON.stringify(f),e=prepareNativeCorroboration(f);
 assert.equal(e.live_appointment_id,'8765');assert.equal(e.source_contact_id,'456');assert.equal(e.native_appointment_id,71);
 assert.equal(e.source_provenance.file_sha256,'f'.repeat(64));assert.equal(JSON.stringify(f),before);
});
test('missing explicit reason, out-of-scope clinic and invalid native IDs are rejected',()=>{
 for(const patch of [{reason:''},{clinic_id:1},{appointment_id:0},{created_by:0},{source_row:'9'}]){
  const f=fixture();Object.assign(f.link.native_first_visit,patch);assert.throws(()=>prepareNativeCorroboration(f),/NATIVE_REVIEW_REQUIRED/);
 }
});
test('changed CSV bytes, another source contact, cancelled or invalid row cannot borrow a live comparison',()=>{
 for(const patch of [{source_contact_id:'789'},{status:'cancelada'},{validation_errors:['INVALID_TIME']},{start_utc:'2026-09-22T16:00:00.000Z'}]){
  const f=fixture();f.appointments=[{...f.appointments[0],...patch}];assert.throws(()=>prepareNativeCorroboration(f),/SOURCE_APPOINTMENT/);
 }
 const f=fixture();f.appointments.push(f.appointments[0]);assert.throws(()=>prepareNativeCorroboration(f),/SOURCE_APPOINTMENT/);
});
test('plan tampering or wrong source/account/hold is rejected',()=>{
 const f=fixture();f.plan.actions[0].action_key='changed';assert.throws(()=>prepareNativeCorroboration(f),/SOURCE_PLAN_INVALID/);
 for(const patch of [{source_system:'other'},{source_account:'other'},{automation_policy:'normal'}]){
  const f=fixture();Object.assign(f.plan.manifest,patch);f.plan.plan_sha256=hash({manifest:f.plan.manifest,actions:f.plan.actions});
  assert.throws(()=>prepareNativeCorroboration(f),/SOURCE_PLAN_INVALID/);
 }
});
test('stale, future, tampered or unrelated live evidence is rejected',()=>{
 for(const captured of ['2026-09-20T01:00:00Z','2026-09-22T04:00:00Z','invalid']){
  const f=fixture();f.comparison.captured_at=captured;rehashComparison(f);assert.throws(()=>prepareNativeCorroboration(f),/LIVE_EVIDENCE/);
 }
 const f=fixture();f.comparison.rows[0].live_ids=['forged'];assert.throws(()=>prepareNativeCorroboration(f),/LIVE_EVIDENCE/);
 const g=fixture();g.comparison.plan_sha256='wrong';rehashComparison(g);assert.throws(()=>prepareNativeCorroboration(g),/LIVE_EVIDENCE/);
});
test('multiple live IDs, missing/duplicate row and non-pending source cannot confirm an identity',()=>{
 for(const change of [
  f=>f.comparison.rows[0].live_ids.push('8766'),
  f=>f.comparison.rows=[],
  f=>f.comparison.rows.push({...f.comparison.rows[0]}),
  f=>f.comparison.rows[0].state='cancelada',
  f=>f.comparison.rows[0].status='unmatched',
 ]){const f=fixture();change(f);rehashComparison(f);assert.throws(()=>prepareNativeCorroboration(f),/LIVE_APPOINTMENT_NOT_UNIQUE/);}
});
test('source phone must belong to just this external contact, not another record or relative',()=>{
 const f=fixture();f.contacts.push({...f.source,source_contact_id:'789'});
 assert.throws(()=>prepareNativeCorroboration(f),/SOURCE_PHONE_NOT_UNIQUE/);
});
