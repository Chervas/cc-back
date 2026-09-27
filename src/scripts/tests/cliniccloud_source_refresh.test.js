'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash,localToUtc}=require('../../lib/cliniccloud-import/adapter');
const {normalizedRow}=require('../../lib/cliniccloud-import/appointments-apply');
const {prepareSourceRefresh,patchSourceRefresh,storedSourceRefresh,sourceRefreshChanged}=require('../../lib/cliniccloud-import/source-refresh');
const {buildPlan}=require('../../lib/cliniccloud-import/planner');
const {sourceReference}=require('../../lib/cliniccloud-import/week-appointments');
const {prepareDeltaReconciliation,patchDeltaReconciliation}=require('../../lib/cliniccloud-import/delta-source-reconciliation');
function fixture() {
  const now=Date.parse('2026-09-27T09:00:00Z');
  const before={id_cita:1,paciente_id:2,clinica_id:72,source_system:'cliniccloud',source_reference:'appointment:1001',
    inicio:'2026-09-28T08:00:00.000Z',fin:'2026-09-28T08:30:00.000Z',estado:'pendiente',
    doctor_id:3,instalacion_id:4,tratamiento_id:5,nota:'Original imported note, preserved verbatim',tipo_cita:'continuacion',
    updated_by:null,voucher_id:null,lead_intake_id:null,es_provisional:0,hold_expires_at:null,
    import_metadata:{source_contact_id:'101',source_appointment_id:'1001',source_service_id:'201',
      raw:{idCita:'1001',idContacto:'101',idAgenda:'301',fechaIni:'2026-09-28',horaIni:'10:00:00',fechaFin:'2026-09-28',horaFin:'10:30:00',estado:'0',detalles:''}}};
  const source={kind:'appointment',source_contact_id:'101',start_local:'2026-09-29T10:00:00',end_local:'2026-09-29T10:30:00',
    start_utc:'2026-09-29T08:00:00.000Z',end_utc:'2026-09-29T08:30:00.000Z',agenda_key:'SYNTHETIC ROOM',service_key:'SYNTHETIC SERVICE',
    status:'pendiente',details:'',validation_errors:[],provenance:{source_row:2,file_sha256:hash('file'),row_sha256:hash('row'),row_key:'row-2'}};
  const detail={idEmpresa:5880,idCita:1001,idContacto:101,idAgenda:301,fechaIni:'2026-09-29',horaIni:'10:00:00',fechaFin:'2026-09-29',horaFin:'10:30:00',
    estado:0,agenda:{nombre:'Synthetic room'},cita_conceptos:[{idServicio:201,asunto:'Synthetic service'}],detalles:''};
  return {before,source,detail,liveCapturedAt:new Date(now-1000).toISOString(),sourcePlanSha256:hash('plan'),
    coverage:{start:'2026-09-28',end:'2026-10-04'},resources:{doctor_id:3,installation_id:6,equipment_ids:[7],evidence_sha256:hash('documentary resource review')},
    reviewedBy:'Synthetic operator',reason:'Same source appointment ID observed in the new export and authenticated detail',now};
}
test('refresh preserves local ID, original evidence, notes, treatment and all non-reviewed fields',()=>{
  const f=fixture(),receipt=prepareSourceRefresh(f),after=patchSourceRefresh(f.before,receipt,f.now);
  assert.equal(after.id_cita,1);assert.equal(after.source_reference,f.before.source_reference);
  assert.deepEqual(after.import_metadata.raw,f.before.import_metadata.raw);
  for(const key of Object.keys(f.before).filter(k=>!['inicio','fin','instalacion_id','import_metadata'].includes(k)))assert.deepEqual(after[key],f.before[key]);
  assert.equal(after.inicio,f.source.start_utc);assert.equal(after.fin,f.source.end_utc);assert.equal(after.instalacion_id,6);
  assert.deepEqual(after.import_metadata.notification_suppression,{appointment_details:true,day_before:true,same_day:true});
  const stored=storedSourceRefresh(after,after.import_metadata);assert.equal(stored.entries.length,2);
  assert.equal(sourceRefreshChanged(after,stored),false);
  assert(sourceRefreshChanged({...after,nota:'Later human edit'},stored));
  assert(sourceRefreshChanged({...after,inicio:'2026-10-01T08:00:00Z'},stored));
});
test('a second reviewed export appends provenance instead of erasing the previous reconciliation',()=>{
  const f=fixture(),first=prepareSourceRefresh(f),after=patchSourceRefresh(f.before,first,f.now);
  const next={...f,before:after,now:f.now+10000,liveCapturedAt:new Date(f.now+9000).toISOString(),
    source:{...f.source,start_local:'2026-09-30T10:00:00',end_local:'2026-09-30T10:30:00',start_utc:'2026-09-30T08:00:00.000Z',end_utc:'2026-09-30T08:30:00.000Z'},
    detail:{...f.detail,fechaIni:'2026-09-30',fechaFin:'2026-09-30'}};
  const second=prepareSourceRefresh(next),saved=patchSourceRefresh(next.before,second,next.now);
  assert.deepEqual(saved.import_metadata.cliniccloud_source_refreshes.receipts[0],first);
  assert.equal(storedSourceRefresh(saved,saved.import_metadata).entries.length,3);
  assert.equal(second.previous_receipt_sha256,first.receipt_sha256);
});
test('SQL TINYINT and Sequelize BOOLEAN preserve the same full-row guard',()=>{
  const f=fixture(),receipt=prepareSourceRefresh(f);
  const model={...f.before,es_provisional:false};
  assert.deepEqual(prepareSourceRefresh({...f,before:model}),receipt);
  assert.deepEqual(patchSourceRefresh(model,receipt,f.now),patchSourceRefresh(f.before,receipt,f.now));
});
test('all previous source intervals replay to the latest reservation, never restoring an old date',()=>{
  const f=fixture(),receipt=prepareSourceRefresh(f),saved=patchSourceRefresh(f.before,receipt,f.now);
  const reconciliation=storedSourceRefresh(saved,saved.import_metadata);
  const rows=reconciliation.entries.map((e,i)=>({...e.source,kind:'appointment',validation_errors:[],provenance:{source_row:i+2,row_key:'source-'+i,row_sha256:hash(e)}}));
  const local={id:1,patient_id:2,clinic_id:72,source_system:'cliniccloud',source_external_id:'1001',
    ...receipt.current,kind:'appointment',source_reconciliation:reconciliation};
  for(const appointments of [rows,rows.slice().reverse(),[rows[0]],[rows[1]]]){
    const result=buildPlan({sourceAccount:'cliniccloud-5880',coverage:f.coverage,contacts:[{source_contact_id:'101',fields:{}}],appointments,
      snapshot:{source_account:'cliniccloud-5880',patients:[{id:2,source_contact_ids:['101'],fields:{}}],appointments:[local]}});
    const actions=result.actions.filter(a=>a.entity==='appointment');
    assert.equal(actions.length,appointments.length);
    assert(actions.every(a=>a.action==='preserve_reconciled_legacy_source'&&!a.requires_review));
  }
});
const invalid=[
  ['changed source identity',f=>{f.detail.idCita=9;}],['changed patient',f=>{f.detail.idContacto=9;}],
  ['foreign account',f=>{f.detail.idEmpresa=9;}],['another local clinic',f=>{f.before.clinica_id=9;}],
  ['foreign metadata account',f=>{f.before.import_metadata.source_account='another';}],
  ['missing source link',f=>{delete f.before.import_metadata.source_appointment_id;}],
  ['changed legacy original identity',f=>{f.before.import_metadata.raw.idCita='9';}],
  ['unreviewed legacy virtual agenda change',f=>{f.detail.idAgenda=9;}],
  ['different service ID',f=>{f.detail.cita_conceptos[0].idServicio=9;}],
  ['different source service',f=>{f.source.service_key='OTHER';}],
  ['new source note requires separate review',f=>{f.source.details='New note';f.detail.detalles='New note';}],
  ['human editor',f=>{f.before.updated_by=4;}],['local reschedule',f=>{f.before.inicio='2026-09-28T09:00:00.000Z';}],
  ['completed locally',f=>{f.before.estado='completada';}],['source cancellation',f=>{f.source.status='cancelada';f.detail.estado=-2;}],
  ['purchased program',f=>{f.before.voucher_id=4;}],['native lead intake',f=>{f.before.lead_intake_id=4;}],
  ['provisional hold',f=>{f.before.es_provisional=1;}],['existing booking profile',f=>{f.before.import_metadata.booking={};}],
  ['clinical resource acceptance',f=>{f.before.import_metadata.import_resource_resolution={};}],
  ['parallel source decisions',f=>{f.before.import_metadata.cliniccloud_parallel_sources={};}],
  ['confirmed duplicate selection',f=>{f.before.import_metadata.cliniccloud_confirmed_source_selection={};}],
  ['source outside declared interval',f=>{f.coverage.end='2026-09-28';}],
  ['invalid coverage',f=>{f.coverage.start='2026-02-30';}],['stale evidence',f=>{f.now+=3600001;}],
  ['future evidence',f=>{f.liveCapturedAt=new Date(f.now+1).toISOString();}],
  ['unknown equipment',f=>{f.resources.equipment_ids=[0];}],['duplicate equipment',f=>{f.resources.equipment_ids=[7,7];}],
  ['missing documentary proof',f=>{delete f.resources.evidence_sha256;}],['missing source proof',f=>{delete f.source.provenance;}],
  ['tampered source UTC',f=>{f.source.start_utc='2026-09-29T07:00:00.000Z';}],
  ['unknown properties in assignment',f=>{f.resources.force=true;}],
];
for(const[label,change]of invalid)test('rejects '+label,()=>{const f=fixture();change(f);assert.throws(()=>prepareSourceRefresh(f),/SOURCE_REFRESH_REVIEW_REQUIRED/);});
test('tampered receipts, identity, original metadata, drift and expiry cannot be persisted or silently adopted',()=>{
  const f=fixture(),receipt=prepareSourceRefresh(f),after=patchSourceRefresh(f.before,receipt,f.now);
  for(const change of [r=>{r.paciente_id=9;},r=>{r.source_reference='appointment:9';},
    r=>{r.import_metadata.raw.detalles='Changed';},r=>{r.import_metadata.cliniccloud_source_refreshes.receipts[0].resources.doctor_id=9;}]){
    const row=structuredClone(after);change(row);assert.throws(()=>storedSourceRefresh(row,row.import_metadata));
  }
  assert.throws(()=>patchSourceRefresh({...f.before,nota:'Edited'},receipt,f.now));
  assert.throws(()=>patchSourceRefresh(f.before,receipt,f.now+3600001));
  assert.deepEqual(normalizedRow(f.before).import_metadata.raw,f.before.import_metadata.raw);
});
test('a previously reconciled delta uses its current interval while retaining the older receipt intact',()=>{
  const f=fixture(),earlier=Date.parse('2026-09-20T10:00:00Z');
  const old={...f.source,start_local:'2026-09-21T10:00:00',end_local:'2026-09-21T10:30:00',
    start_utc:'2026-09-21T08:00:00.000Z',end_utc:'2026-09-21T08:30:00.000Z'};
  const initial={...f.before,nota:'',inicio:old.start_utc,fin:old.end_utc,source_reference:sourceReference(old),
    import_metadata:{source_account:'cliniccloud-5880',source_contact_id:'101',
      cliniccloud_delta:{source:old,provenance:old.provenance},cliniccloud_reconciliation:{automation_policy:'hold'},
      notification_suppression:{appointment_details:true,day_before:true,same_day:true}}};
  const originalLive={source_account:'cliniccloud-5880',captured_at:new Date(earlier-2000).toISOString(),rows:[{
    appointment_id:'1001',contact_id:'101',state:0,start:old.start_local,end:old.end_local,
    agenda:old.agenda_key,service:old.service_key,details:''}]};
  const history={source_account:'cliniccloud-5880',captured_at:new Date(earlier-1000).toISOString(),patients:[{
    contact_id:'101',rows:[{...f.detail,fechaIni:'2026-09-28',fechaFin:'2026-09-28',conceptos:f.detail.cita_conceptos}]}]};
  const previous=prepareDeltaReconciliation({before:initial,source:old,originalLive,history,
    reviewedBy:f.reviewedBy,reason:f.reason,reviewedMinutes:{previous:30,current:30},now:earlier});
  f.before=patchDeltaReconciliation(normalizedRow(initial),previous,earlier);
  const result=patchSourceRefresh(f.before,prepareSourceRefresh(f),f.now);
  assert.deepEqual(result.import_metadata.cliniccloud_delta,f.before.import_metadata.cliniccloud_delta);
  assert.deepEqual(result.import_metadata.cliniccloud_delta_source_reconciliation,f.before.import_metadata.cliniccloud_delta_source_reconciliation);
  assert.equal(storedSourceRefresh(result,result.import_metadata).baseline.start_local,previous.current.start_local);
  const tampered=structuredClone(f);tampered.before.import_metadata.cliniccloud_delta_source_reconciliation.current.status='cancelada';
  assert.throws(()=>prepareSourceRefresh(tampered));
});

function unboundDeltaFixture() {
  const f=fixture();
  const baseline={source_contact_id:'101',start_local:'2026-09-21T10:00:00',end_local:'2026-09-21T10:30:00',
    agenda_key:f.source.agenda_key,service_key:f.source.service_key,status:'pendiente'};
  f.before={...f.before,nota:'',inicio:localToUtc(baseline.start_local),fin:localToUtc(baseline.end_local),
    source_reference:sourceReference(baseline),import_metadata:{source_account:'cliniccloud-5880',source_contact_id:'101',
      cliniccloud_delta:{version:1,source:baseline,provenance:{file_sha256:hash('old-file'),row_sha256:hash('old-row'),source_row:4},
        source_reference_kind:'import_fingerprint_not_source_appointment_id'},cliniccloud_reconciliation:{automation_policy:'hold'},
      notification_suppression:{appointment_details:true,day_before:true,same_day:true}}};
  f.originalLive={source_account:'cliniccloud-5880',captured_at:'2026-09-20T10:00:00Z',rows:[{
    appointment_id:'1001',contact_id:'101',state:0,start:baseline.start_local,end:baseline.end_local,
    agenda:baseline.agenda_key,service:baseline.service_key,details:''}]};
  return f;
}
test('old pending delta is bound by its archived source ID and moved forward without replacing its evidence',()=>{
  const f=unboundDeltaFixture(),original=structuredClone(f),receipt=prepareSourceRefresh(f);
  assert.equal(receipt.source_identity_binding.source_appointment_id,'1001');
  const after=patchSourceRefresh(f.before,receipt,f.now);
  assert.equal(after.id_cita,f.before.id_cita);assert.equal(after.source_reference,f.before.source_reference);
  assert.equal(after.import_metadata.source_appointment_id,'1001');
  assert.deepEqual(after.import_metadata.cliniccloud_delta,f.before.import_metadata.cliniccloud_delta);
  assert.equal(after.inicio,f.source.start_utc);assert.equal(after.estado,'pendiente');
  assert.equal(storedSourceRefresh(after,after.import_metadata).entries.length,2);
  assert.deepEqual(f,original);
  const next={...f,before:after,originalLive:undefined,now:f.now+10000,liveCapturedAt:new Date(f.now+9000).toISOString(),
    source:{...f.source,start_local:'2026-09-30T10:00:00',end_local:'2026-09-30T10:30:00',start_utc:'2026-09-30T08:00:00.000Z',end_utc:'2026-09-30T08:30:00.000Z'},
    detail:{...f.detail,fechaIni:'2026-09-30',fechaFin:'2026-09-30'}};
  const saved=patchSourceRefresh(after,prepareSourceRefresh(next),next.now);
  assert.equal(storedSourceRefresh(saved,saved.import_metadata).entries.length,3);
  assert.deepEqual(saved.import_metadata.cliniccloud_source_refreshes.receipts[0],receipt);
});
for(const[label,change]of [
  ['missing archived observation',f=>{delete f.originalLive;}],
  ['different source ID now',f=>{f.detail.idCita=999;}],
  ['duplicate archived slot',f=>{f.originalLive.rows.push({...f.originalLive.rows[0],appointment_id:'1002'});}],
  ['different archived patient',f=>{f.originalLive.rows[0].contact_id='999';}],
  ['different archived account',f=>{f.originalLive.source_account='cliniccloud-999';}],
  ['edited local note',f=>{f.before.nota='Local edit';}],
  ['edited local interval',f=>{f.before.fin='2026-09-21T09:00:00.000Z';}],
  ['unproven source-reference fingerprint',f=>{f.before.source_reference='arbitrary';}],
  ['observation after latest evidence',f=>{f.originalLive.captured_at=new Date(f.now).toISOString();}],
  ['archived cancellation',f=>{f.originalLive.rows[0].state=-2;}],
  ['unbound delta without HOLD',f=>{f.before.import_metadata.notification_suppression.day_before=false;}],
  ['unbound delta without provenance',f=>{delete f.before.import_metadata.cliniccloud_delta.provenance;}],
])test('identity binding rejects '+label,()=>{const f=unboundDeltaFixture();change(f);assert.throws(()=>prepareSourceRefresh(f),/SOURCE_REFRESH_REVIEW_REQUIRED/);});
test('stored identity binding detects tampering even with a recomputed receipt digest',()=>{
  const f=unboundDeltaFixture(),after=patchSourceRefresh(f.before,prepareSourceRefresh(f),f.now);
  const r=after.import_metadata.cliniccloud_source_refreshes.receipts[0];r.source_identity_binding.source_contact_id='999';
  const {receipt_sha256,...body}=r;r.receipt_sha256=hash(body);
  assert.throws(()=>storedSourceRefresh(after,after.import_metadata),/SOURCE_REFRESH_REVIEW_REQUIRED/);
});
