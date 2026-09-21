'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash,localToUtc}=require('../../lib/cliniccloud-import/adapter');
const {sourceReference}=require('../../lib/cliniccloud-import/week-appointments');
const {prepareDeltaReconciliation,storedDeltaReconciliation,patchDeltaReconciliation}=require('../../lib/cliniccloud-import/delta-source-reconciliation');
const {reconciliationChanged}=require('../../lib/cliniccloud-import/legacy-source-reconciliation');
const {buildPlan}=require('../../lib/cliniccloud-import/planner');
function fixture(){
 const source={kind:'appointment',source_contact_id:'77',start_local:'2026-09-22T16:45:00',end_local:'2026-09-22T17:05:00',agenda_key:'DOCTOR',service_key:'SERVICE',status:'pendiente',details:'Synthetic note',validation_errors:[],provenance:{file_sha256:'a'.repeat(64),row_sha256:'b'.repeat(64),source_row:2,row_key:'synthetic:2'}};
 source.start_utc=localToUtc(source.start_local);source.end_utc=localToUtc(source.end_local);
 const sourceBase=Object.fromEntries(['source_contact_id','start_local','end_local','agenda_key','service_key','status'].map(k=>[k,source[k]]));
 const before={id_cita:9,paciente_id:7,clinica_id:66,doctor_id:null,instalacion_id:null,tratamiento_id:8,estado:'pendiente',nota:source.details,tipo_cita:'continuacion',source_system:'cliniccloud',source_reference:sourceReference(source),inicio:source.start_utc,fin:source.end_utc,created_at:'2026-09-20T20:00:00.000Z',updated_at:'2026-09-20T20:00:00.000Z',
  import_metadata:{source_account:'cliniccloud-5880',source_contact_id:'77',cliniccloud_delta:{version:1,source:sourceBase,provenance:source.provenance,source_reference_kind:'import_fingerprint_not_source_appointment_id'},notification_suppression:{appointment_details:true,day_before:true,same_day:true},cliniccloud_reconciliation:{automation_policy:'hold'}}};
 return {before,source,originalLive:{source_account:'cliniccloud-5880',captured_at:'2026-09-21T16:00:00Z',rows:[{appointment_id:900,contact_id:77,state:0,start:'2026-09-22 16:45:00',end:'2026-09-22 17:05:00',agenda:'Doctor',service:'Service',details:'Synthetic note'}]},
  history:{source_account:'cliniccloud-5880',captured_at:'2026-09-21T21:00:00Z',patients:[{contact_id:'77',rows:[{idCita:900,idContacto:77,idEmpresa:5880,estado:0,fechaIni:'2026-10-05',horaIni:'19:00:00',fechaFin:'2026-10-05',horaFin:'19:35:00',agenda:{nombre:'Doctor'},conceptos:[{idServicio:8,asunto:'Service'}],detalles:'Synthetic note'}]}]},
  reviewedBy:'Synthetic reviewer',reason:'Exact source ID changed both slot and duration',reviewedMinutes:{previous:20,current:35},now:Date.parse('2026-09-21T21:10:00Z')};
}
test('same observed source ID changes date/duration in place and preserves original delta, references and HOLD',()=>{
 const f=fixture(),receipt=prepareDeltaReconciliation(f),after=patchDeltaReconciliation(f.before,receipt,f.now);
 assert.equal(after.inicio,'2026-10-05T17:00:00.000Z');assert.equal(after.fin,'2026-10-05T17:35:00.000Z');
 for(const k of ['id_cita','paciente_id','clinica_id','doctor_id','instalacion_id','tratamiento_id','estado','nota','source_reference','created_at'])assert.deepEqual(after[k],f.before[k]);
 assert.deepEqual(after.import_metadata.cliniccloud_delta,f.before.import_metadata.cliniccloud_delta);
 assert.deepEqual(after.import_metadata.notification_suppression,f.before.import_metadata.notification_suppression);
 assert.equal(after.import_metadata.source_appointment_id,'900');assert.deepEqual(storedDeltaReconciliation(after,after.import_metadata),receipt);assert.equal(reconciliationChanged(after,receipt),false);
});
test('SQL NULL represents an imported empty note without changing it during reconciliation',()=>{
 const f=fixture();f.source.details='';f.before.nota=null;
 f.originalLive.rows[0].details='';f.history.patients[0].rows[0].detalles='';
 const receipt=prepareDeltaReconciliation(f),after=patchDeltaReconciliation(f.before,receipt,f.now);
 assert.equal(after.nota,null);assert.equal(receipt.current.details,'');
 assert.equal(reconciliationChanged(after,receipt),false);
});
test('empty source notes do not permit a local note or whitespace edit',()=>{
 for(const note of ['Added locally',' ']){
  const f=fixture();f.source.details='';f.before.nota=note;
  f.originalLive.rows[0].details='';f.history.patients[0].rows[0].detalles='';
  assert.throws(()=>prepareDeltaReconciliation(f),/INVALID/);
 }
});
function virtualCabinFixture(){
 const f=fixture();f.source.agenda_key='CABINA 4 (PRESOTERAPIA)';
 f.before.import_metadata.cliniccloud_delta.source.agenda_key=f.source.agenda_key;
 f.before.source_reference=sourceReference(f.source);f.originalLive.rows[0].agenda=f.source.agenda_key;
 f.history.patients[0].rows[0].agenda.nombre='Cabina 3 (Carboxiterapia)';
 f.before.instalacion_id=84;f.before.import_metadata.cliniccloud_cabin_assignment={version:1,installation_id:84,
  package_sha256:'c'.repeat(64),operation_sha256:'d'.repeat(64),automation_policy:'hold'};
 f.reviewedAgenda={previous:f.source.agenda_key,current:'CABINA 3 (CARBOXITERAPIA)',installation_id:84,reason:'Source virtual lanes differ; written physical room unchanged'};
 return f;
}
test('reviewed virtual cabin change preserves the documented physical room and original CSV identity',()=>{
 const f=virtualCabinFixture(),receipt=prepareDeltaReconciliation(f),after=patchDeltaReconciliation(f.before,receipt,f.now);
 assert.equal(after.instalacion_id,84);assert.equal(after.doctor_id,f.before.doctor_id);
 assert.equal(receipt.current.agenda_key,f.reviewedAgenda.current);assert.equal(receipt.entries[0].source.agenda_key,f.source.agenda_key);
 assert.deepEqual(receipt.source_agenda_change.physical_assignment,f.before.import_metadata.cliniccloud_cabin_assignment);
 assert.equal(reconciliationChanged(after,receipt),false);assert.equal(storedDeltaReconciliation(after,after.import_metadata),receipt);
});
for(const[name,mutate]of[
 ['unreviewed virtual lane',f=>delete f.reviewedAgenda],
 ['different previous lane',f=>f.reviewedAgenda.previous='CABINA 8'],
 ['different current lane',f=>f.reviewedAgenda.current='CABINA 8'],
 ['undocumented physical room',f=>delete f.before.import_metadata.cliniccloud_cabin_assignment],
 ['different physical room',f=>f.before.instalacion_id=85],
 ['missing documentary assignment receipt',f=>delete f.before.import_metadata.cliniccloud_cabin_assignment.operation_sha256],
 ['doctor agenda is not a virtual cabin',f=>{f.history.patients[0].rows[0].agenda.nombre='Doctor';f.reviewedAgenda.current='DOCTOR'}],
 ['unexplained source lane change',f=>f.reviewedAgenda.reason=''],
])test('rejects '+name,()=>{const f=virtualCabinFixture();mutate(f);assert.throws(()=>prepareDeltaReconciliation(f),/INVALID/)});
test('virtual lane receipt cannot silently lose or alter its documented physical evidence',()=>{
 const f=virtualCabinFixture(),receipt=prepareDeltaReconciliation(f),after=patchDeltaReconciliation(f.before,receipt,f.now);
 for(const mutate of [r=>delete r.source_agenda_change,r=>r.source_agenda_change.physical_assignment_sha256='e'.repeat(64),r=>r.source_agenda_change.installation_id=85]){
  const m=structuredClone(after.import_metadata);mutate(m.cliniccloud_delta_source_reconciliation);
  const {receipt_sha256,...body}=m.cliniccloud_delta_source_reconciliation;m.cliniccloud_delta_source_reconciliation.receipt_sha256=hash(body);
  assert.throws(()=>storedDeltaReconciliation(after,m),/INVALID/);
 }
 const edited={...after,instalacion_id:85};assert.equal(reconciliationChanged(edited,receipt),true);
});
test('CSV replay with the old virtual cabin preserves the reconciled date and physical room',()=>{
 const f=virtualCabinFixture(),receipt=prepareDeltaReconciliation(f),after=patchDeltaReconciliation(f.before,receipt,f.now);
 const local={id:9,patient_id:7,clinic_id:66,source_system:'cliniccloud',...receipt.current,source_reconciliation:receipt,reconciliation_local_changed:reconciliationChanged(after,receipt)};
 const plan=buildPlan({sourceAccount:'cliniccloud-5880',coverage:{start:'2026-09-01',end:'2026-12-31'},contacts:[{source_contact_id:'77',fields:{}}],appointments:[f.source],snapshot:{source_account:'cliniccloud-5880',complete_for:{clinic_ids:[66,72]},patients:[{id:7,source_contact_ids:['77'],fields:{}}],appointments:[local]}});
 const decision=plan.actions.find(a=>a.source?.kind==='appointment');
 assert.equal(decision.action,'preserve_reconciled_legacy_source');assert.equal(decision.local_id,9);
 assert.equal(after.instalacion_id,84);assert.deepEqual(after.import_metadata.cliniccloud_delta,f.before.import_metadata.cliniccloud_delta);
});
for(const [name,mutate]of [
 ['wrong old source ID',f=>f.originalLive.rows[0].appointment_id=901],['absent older observation',f=>f.originalLive.rows=[]],
 ['ambiguous old source',f=>f.originalLive.rows.push(structuredClone(f.originalLive.rows[0]))],['old observation newer than current',f=>f.originalLive.captured_at='2026-09-21T21:01:00Z'],
 ['stale current history',f=>f.now+=3600000],['changed patient',f=>f.history.patients[0].rows[0].idContacto=78],
 ['changed service',f=>f.history.patients[0].rows[0].conceptos[0].asunto='Different'],['compound act',f=>f.history.patients[0].rows[0].conceptos.push({idServicio:9,asunto:'Other'})],
 ['changed note',f=>f.history.patients[0].rows[0].detalles='Other'],['changed doctor agenda',f=>f.history.patients[0].rows[0].agenda.nombre='Other'],
 ['performed state',f=>f.history.patients[0].rows[0].estado=3],['duration not explicitly reviewed',f=>delete f.reviewedMinutes],
 ['unexpected duration',f=>f.reviewedMinutes.current=20],['human local edit',f=>f.before.updated_by=1],
 ['local reschedule',f=>f.before.inicio='2026-09-22T15:00:00.000Z'],['native appointment',f=>f.before.source_system=null],
 ['advanced booking',f=>f.before.import_metadata.booking={}],['missing HOLD',f=>f.before.import_metadata.notification_suppression.day_before=false],
])test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>prepareDeltaReconciliation(f),/INVALID/)});
test('old CSV replay preserves the verified October slot, while later edits require review',()=>{
 const f=fixture(),r=prepareDeltaReconciliation(f),after=patchDeltaReconciliation(f.before,r,f.now);
 const local={id:9,patient_id:7,clinic_id:66,source_system:'cliniccloud',...r.current,source_reconciliation:r,reconciliation_local_changed:reconciliationChanged(after,r)};
 const plan=()=>buildPlan({sourceAccount:'cliniccloud-5880',coverage:{start:'2026-09-01',end:'2026-12-31'},contacts:[{source_contact_id:'77',fields:{}}],appointments:[f.source],snapshot:{source_account:'cliniccloud-5880',complete_for:{clinic_ids:[66,72]},patients:[{id:7,source_contact_ids:['77'],fields:{}}],appointments:[local]}}).actions.find(a=>a.source?.kind==='appointment');
 assert.equal(plan().action,'preserve_reconciled_legacy_source');assert.equal(plan().local_id,9);
 local.reconciliation_local_changed=true;assert(plan().reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW'));
 const changed=structuredClone(after.import_metadata);changed.cliniccloud_delta.source.end_local='2026-09-22T17:20:00';
 assert.throws(()=>storedDeltaReconciliation(after,changed),/INVALID/);
 assert.throws(()=>patchDeltaReconciliation(f.before,r,f.now+3600000),/INVALID/);
});
