'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {refersToOtherPatient,assertSourcePatientUnambiguous,REASON}=require('../../lib/cliniccloud-import/source-patient-notes');
const {buildPlan}=require('../../lib/cliniccloud-import/planner');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {prepareWeekAppointments,appointmentPayload}=require('../../lib/cliniccloud-import/week-appointments');
const {bookReviewedAppointment}=require('../../lib/cliniccloud-import/book-reviewed-appointment');
for(const note of ['ES PARA SU HERMANO: consulta pendiente.','La cita es para su hija.','Esta visita es para mi madre','Cita para su padre','Primera valoración. ES PARA SU MARIDO','\n es  para su pareja','Es para su amiga','Es para su hijo, no para el titular']) {
 test('explicit other beneficiary requires review: '+note,()=>assert.equal(refersToOtherPatient(note),true));
}
for(const note of [null,'','Viene con su hermano','Su hija pide la cita','Llama su madre','No es para su hermano','La cita no es para su madre','Receta para su hermano, entregarla en recepción','Preparación para su cita','Antecedentes: su padre tuvo cirugía','ES PARA SU HERMANAMIENTO','Es para mi tratamiento']) {
 test('does not infer patient from companion, caller or other context: '+note,()=>assert.equal(refersToOtherPatient(note),false));
}
function fixture(note='ES PARA SU HERMANO: valoración') {
 const snapshot={database_target:'crm',database_group_id:29,source_account:'cliniccloud-5880',complete_for:{clinic_ids:[66,72],start:'2026-09-01',end:'2026-10-31'},patients:[{id:7,source_contact_ids:['90001']}],appointments:[]};
 const source={kind:'appointment',source_contact_id:'90001',source_external_id:null,start_local:'2026-09-28T10:00:00',end_local:'2026-09-28T10:30:00',start_utc:'2026-09-28T08:00:00.000Z',end_utc:'2026-09-28T08:30:00.000Z',agenda_key:'QA',service_key:'VALORACION',status:'pendiente',details:note,validation_errors:[],provenance:{file_sha256:'a'.repeat(64),source_row:1,row_sha256:'b'.repeat(64),row_key:'qa:1'}};
 const context={sourceAccount:snapshot.source_account,coverage:{start:'2026-09-01',end:'2026-10-31'},contacts:[{source_contact_id:'90001',fields:{},provenance:{row_key:'c1'}}],appointments:[source],snapshot};
 return {snapshot,source,context};
}
test('a linked external identity does not make the other-beneficiary visit a safe creation',()=>{
 const f=fixture(),before=hash(f),p=buildPlan(f.context),a=p.actions.find(a=>a.entity==='appointment'&&a.source);
 assert.equal(a.action,'review');assert.equal(a.patient_id,7);assert(a.reasons.includes(REASON));assert.equal(a.requires_review,true);assert.equal(a.automation_policy,'hold');assert.equal(hash(f),before);
});
test('exact native and imported matches remain preserved for identity review, never an absence deletion',()=>{
 for(const imported of [true,false]){
  const f=fixture();f.snapshot.appointments=[{...f.source,id:10,clinic_id:72,patient_id:7,source_system:imported?'cliniccloud':null,source_external_id:imported?'777':null,last_imported:{...f.source}}];
  if(imported)f.source.source_external_id='777';
  const p=buildPlan(f.context),a=p.actions.find(a=>a.entity==='appointment'&&a.source);assert.equal(a.action,'review');assert(a.reasons.includes(REASON));assert.deepEqual(a.candidate_local_ids,[10]);
  const absent=p.actions.find(a=>a.local_id===10&&!a.source);assert.equal(absent.action,'preserve_local');assert.equal(absent.physical_delete,false);
 }
});
test('an ordinary appointment and administrative block do not acquire this review',()=>{
 const f=fixture('Viene acompañado por su hermano');assert.equal(buildPlan(f.context).actions.find(a=>a.source).action,'create_appointment_candidate');
 const block=fixture();block.source.kind='block';assert(!buildPlan(block.context).actions.find(a=>a.source).reasons.includes(REASON));
});
test('identical source bytes alias the reviewed row, without generating a second creation',()=>{
 const f=fixture();f.context.appointments.push({...f.source,provenance:{...f.source.provenance,row_key:'qa:2'}});const p=buildPlan(f.context);const rows=p.actions.filter(a=>a.source);assert.deepEqual(rows.map(a=>a.action),['review','alias_identical_source_row']);assert.equal(rows[1].alias_of,'qa:1');
});
test('an older planner package cannot bypass creation validation; explicit defer is still allowed',()=>{
 const f=fixture();const a={action_key:'a',entity:'appointment',action:'create_appointment_candidate',patient_id:7,source:f.source,reasons:['RESOURCE_AND_SERVICE_MAP_REQUIRED'],candidate_local_ids:[],provenance:f.source.provenance};
 const plan={manifest:{source_system:'cliniccloud',source_account:f.snapshot.source_account,snapshot_sha256:hash(f.snapshot),timezone:'Europe/Madrid',automation_policy:'hold',coverage:{...f.context.coverage,authority:'source_snapshot_plus_protected_native'}},actions:[a]};plan.plan_sha256=hash(plan);
 const review={plan_sha256:plan.plan_sha256,reviewed_by:'QA',reviewed_at:'2026-09-27T10:00:00Z',week:{start:'2026-09-28',end:'2026-10-04'},decisions:[{action_key:'a',disposition:'create',reason:'QA old review'}]};
 assert.throws(()=>prepareWeekAppointments({plan,snapshot:f.snapshot,review,target:'crm'}),new RegExp(REASON));
 review.decisions[0].disposition='defer';assert.throws(()=>prepareWeekAppointments({plan,snapshot:f.snapshot,review,target:'crm'}),/WEEK_BATCH_SIZE_INVALID/);
 assert.throws(()=>appointmentPayload({note:f.source.details},{},{},Date.now()),new RegExp(REASON));
});
test('direct documented creation rejects the note before touching DB, locks, hooks or events',async()=>{
 const p={clinica_id:72,paciente_id:7,doctor_id:53,instalacion_id:80,tratamiento_id:null,titulo:'QA',nota:'ES PARA SU HERMANO',motivo:'QA',tipo_cita:'continuacion',estado:'pendiente',inicio:'2026-09-28T08:00:00Z',fin:'2026-09-28T08:30:00Z',source_system:'cliniccloud',source_reference:'delta:qa',es_provisional:0,created_at:'2026-09-27T00:00:00Z',updated_at:'2026-09-27T00:00:00Z',import_metadata:{}};
 const db=new Proxy({},{get(){throw Error('DB must not be accessed');}});
 await assert.rejects(bookReviewedAppointment({db,payload:p,transaction:{options:{isolationLevel:'READ COMMITTED'}},beforeInsert:()=>{throw Error('Must not call');}}),new RegExp(REASON));
 assert.throws(()=>assertSourcePatientUnambiguous(p.nota),new RegExp(REASON));
});
