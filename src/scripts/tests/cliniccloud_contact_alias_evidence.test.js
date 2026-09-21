'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {prepareNativeCorroboration,prepareHistoryCorroboration}=require('../../lib/cliniccloud-import/contact-alias-evidence');
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
function historyFixture(){
 const f=fixture();f.link={native_history_visit:{reason:'Primera visita histórica revisada; no cambiar su estado',appointment_id:71,created_by:44,clinic_id:72,source_appointment_id:'8765'}};
 f.histories={version:1,captured_at:'2026-09-21T03:30:00Z',origin:'https://app.clinic-cloud.com',
  source_endpoint:'/apps/contacto/pestanas-contacto-ficha/php/citas/citas.api.php/get-citas',policy:'read_only_no_clinical_or_economic_mutations',
  patients:[{contact_id:'456',rows:[{idCita:8765,idContacto:456,agenda:{idEmpresa:5880},fechaIni:'2026-07-28',fechaFin:'2026-07-28',horaIni:'18:30:00',horaFin:'19:00:00',estado:3}]}]};
 return f;
}
test('observed source history corroborates an earlier visit without importing its clinical or financial state',()=>{
 const f=historyFixture(),before=JSON.stringify(f),e=prepareHistoryCorroboration(f);
 assert.equal(e.start_utc,'2026-07-28T16:30:00.000Z');assert.equal(e.source_state,3);assert.equal(e.identity_only,true);
 assert.equal(e.source_contact_id,'456');assert.equal(e.kind,'unique_phone_given_name_and_observed_history');
 assert.match(e.source_appointment_sha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(f),before);
});
test('history rejects stale, foreign, duplicate, mixed-patient or unidentified data',()=>{
 for(const mutate of [
  f=>f.histories.captured_at='2026-09-20T00:00:00Z',
  f=>f.histories.origin='https://example.com',
  f=>f.histories.source_endpoint='/other',
  f=>f.histories.patients.push({...f.histories.patients[0]}),
  f=>f.histories.patients[0].rows[0].idContacto=789,
  f=>f.histories.patients[0].rows[0].agenda.idEmpresa=123,
  f=>f.histories.patients[0].rows[0].idCita=999,
  f=>f.histories.patients[0].rows[0].estado=99,
  f=>f.histories.patients[0].rows[0].horaFin='18:00:00',
  f=>f.histories.patients[0].rows.push({...f.histories.patients[0].rows[0]}),
  f=>f.contacts.push({...f.source,source_contact_id:'789'}),
 ]){const f=historyFixture();mutate(f);assert.throws(()=>prepareHistoryCorroboration(f));}
});
test('operator must choose one explicit corroboration method, not silently override one with another',()=>{
 const f=historyFixture();f.link.native_first_visit=fixture().link.native_first_visit;
 assert.throws(()=>prepareHistoryCorroboration(f),/NATIVE_REVIEW_REQUIRED/);
 assert.throws(()=>prepareNativeCorroboration(f),/NATIVE_REVIEW_REQUIRED/);
});
