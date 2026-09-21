'use strict';

// Existing imported delta appointment, linked by an earlier authenticated
// calendar observation and the same ID in a new full source history. No SQL.
const { hash,norm,localToUtc,localDateTime }=require('./adapter');
const { normalizedRow }=require('./appointments-apply');
const { sourceReference }=require('./week-appointments');
const VERSION='cliniccloud-existing-delta-reconciliation/1',ACCOUNT='cliniccloud-5880';
const keys=['source_contact_id','start_local','end_local','agenda_key','service_key','status'];
const clinical=r=>({patient:r.paciente_id,clinic:r.clinica_id,doctor:r.doctor_id,room:r.instalacion_id,treatment:r.tratamiento_id,note:r.nota,type:r.tipo_cita});
const fail=()=>{throw Error('DELTA_SOURCE_RECONCILIATION_INVALID')};
const mins=(start,end)=>(Date.parse(localToUtc(end))-Date.parse(localToUtc(start)))/60000;
function prepareDeltaReconciliation({before:raw,source,originalLive,history,reviewedBy,reason,reviewedMinutes,now=Date.now()}){
 const before=normalizedRow(raw),m=before.import_metadata,baseline=m.cliniccloud_delta?.source;
 if(before.source_system!=='cliniccloud'||![66,72].includes(before.clinica_id)||before.estado!=='pendiente'
  ||before.updated_by||before.voucher_id||before.lead_intake_id||before.es_provisional||before.hold_expires_at
  ||m.booking||m.program_session||m.additional_staff||m.cliniccloud_source_revision||m.cliniccloud_parallel_sources
  ||m.cliniccloud_delta_source_reconciliation||m.source_appointment_id||m.source_account!==ACCOUNT
  ||!source||source.kind!=='appointment'||source.validation_errors?.length||!baseline
  ||before.source_reference!==sourceReference(source)||keys.some(k=>baseline[k]!==source[k])
  ||hash(m.cliniccloud_delta.provenance)!==hash(source.provenance)||String(m.source_contact_id)!==source.source_contact_id
  ||before.inicio!==source.start_utc||before.fin!==source.end_utc||before.nota!==source.details
  ||before.estado!==source.status||m.cliniccloud_reconciliation?.automation_policy!=='hold'
  ||!['appointment_details','day_before','same_day'].every(k=>m.notification_suppression?.[k]===true)
  ||source.start_local<'2026-09-21'||source.start_local>='2026-09-28'||Date.parse(before.inicio)<now
  ||!String(reviewedBy||'').trim()||!String(reason||'').trim())fail();
 if(history?.source_account!==ACCOUNT||originalLive?.source_account!==ACCOUNT||!Array.isArray(originalLive.rows)
  ||!Number.isFinite(Date.parse(history.captured_at))||!Number.isFinite(Date.parse(originalLive.captured_at))
  ||Date.parse(originalLive.captured_at)>=Date.parse(history.captured_at)||now<Date.parse(history.captured_at)
  ||now-Date.parse(history.captured_at)>3600000)fail();
 const old=originalLive.rows.filter(r=>String(r.contact_id)===source.source_contact_id&&r.state===0
  &&String(r.start).replace(' ','T')===source.start_local&&String(r.end).replace(' ','T')===source.end_local
  &&norm(r.agenda)===source.agenda_key&&norm(r.service)===source.service_key&&norm(r.details)===norm(source.details));
 if(old.length!==1||!/^[1-9]\d*$/.test(String(old[0].appointment_id)))fail();
 const id=String(old[0].appointment_id),patients=history.patients?.filter(p=>String(p.contact_id)===source.source_contact_id)||[];
 if(patients.length!==1||!Array.isArray(patients[0].rows))fail();
 const found=patients[0].rows.filter(r=>String(r.idCita)===id);if(found.length!==1)fail();const r=found[0];
 if(Number(r.idEmpresa)!==5880||String(r.idContacto)!==source.source_contact_id||Number(r.estado)!==0
  ||r.conceptos?.length!==1||norm(r.conceptos[0].asunto)!==source.service_key||norm(r.detalles)!==norm(source.details)
  ||norm(r.agenda?.nombre)!==source.agenda_key)fail();
 const current={...baseline,start_local:localDateTime(r.fechaIni,r.horaIni),end_local:localDateTime(r.fechaFin,r.horaFin),details:source.details};
 if(!localToUtc(current.start_local)||!localToUtc(current.end_local)||current.start_local<'2026-09-01'||current.end_local>='2027-01-01'
  ||current.end_local<=current.start_local||Date.parse(localToUtc(current.start_local))<now
  ||current.start_local===source.start_local||mins(current.start_local,current.end_local)>1440
  ||reviewedMinutes?.previous!==mins(source.start_local,source.end_local)||reviewedMinutes?.current!==mins(current.start_local,current.end_local))fail();
 const body={version:VERSION,source_account:ACCOUNT,appointment_id:before.id_cita,patient_id:before.paciente_id,clinic_id:before.clinica_id,
  source_reference:before.source_reference,source_contact_id:source.source_contact_id,source_appointment_id:id,
  before_sha256:hash(before),original_delta_sha256:hash(m.cliniccloud_delta),clinical_sha256:hash(clinical(before)),
  original_observation_sha256:hash(originalLive),source_history_row_sha256:hash(r),live_evidence_sha256:hash(history),
  original_observed_at:originalLive.captured_at,live_captured_at:history.captured_at,reviewed_at:new Date(now).toISOString(),reviewed_by:reviewedBy,reason,
  reviewed_minutes:reviewedMinutes,previous:{start_utc:before.inicio,end_utc:before.fin,status:before.estado},current,
  entries:[{source_reference:before.source_reference,source_appointment_id:id,source:{...baseline,details:source.details},provenance:source.provenance}],automation_policy:'hold'};
 return {...body,receipt_sha256:hash(body)};
}
function storedDeltaReconciliation(row,m){
 const r=m.cliniccloud_delta_source_reconciliation;if(!r)return null;const {receipt_sha256,...body}=r,entry=r.entries?.[0];
 if(r.version!==VERSION||r.source_account!==ACCOUNT||hash(body)!==receipt_sha256||row.source_system!=='cliniccloud'
  ||r.source_reference!==row.source_reference||Number(row.id_cita)!==r.appointment_id||Number(row.paciente_id)!==r.patient_id||Number(row.clinica_id)!==r.clinic_id
  ||m.source_appointment_id!==r.source_appointment_id||m.source_contact_id!==r.source_contact_id||m.source_account!==ACCOUNT
  ||hash(m.cliniccloud_delta)!==r.original_delta_sha256||r.entries.length!==1||!entry
  ||sourceReference(entry.source)!==r.source_reference||entry.source_appointment_id!==r.source_appointment_id
  ||r.automation_policy!=='hold'||keys.filter(k=>!['start_local','end_local'].includes(k)).some(k=>r.current[k]!==entry.source[k])
  ||r.current.status!=='pendiente'||r.current.details!==entry.source.details||!localToUtc(r.current.start_local)||!localToUtc(r.current.end_local)
  ||r.reviewed_minutes.previous!==mins(entry.source.start_local,entry.source.end_local)||r.reviewed_minutes.current!==mins(r.current.start_local,r.current.end_local))fail();
 return r;
}
function patchDeltaReconciliation(before,receipt,now=Date.now()){
 if(hash(before)!==receipt.before_sha256||now<Date.parse(receipt.live_captured_at)||now-Date.parse(receipt.live_captured_at)>3600000)fail();
 const after={...before,inicio:localToUtc(receipt.current.start_local),fin:localToUtc(receipt.current.end_local),updated_at:new Date(Math.floor(now/1000)*1000).toISOString(),
  import_metadata:{...before.import_metadata,source_appointment_id:receipt.source_appointment_id,cliniccloud_delta_source_reconciliation:receipt}};
 storedDeltaReconciliation(after,after.import_metadata);return after;
}
module.exports={prepareDeltaReconciliation,storedDeltaReconciliation,patchDeltaReconciliation};
