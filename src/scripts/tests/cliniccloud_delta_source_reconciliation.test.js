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
