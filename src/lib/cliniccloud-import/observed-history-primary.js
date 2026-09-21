'use strict';
const {hash,norm,dateOnly}=require('./adapter');
const {serviceClinic}=require('./primary-clinics');
const {choosePrimaryClinic}=require('./planner');

// A separate source adapter, not a reinterpretation of the old ZIP's numeric
// statuses. State labels must have been observed in the current source UI.
function observedHistoryPrimary(sources,sourceId,now=Date.now()) {
  const history=sources.live_histories?.data;
  if(!history?.patients?.some(p=>p.contact_id===sourceId)) return null;
  const labels=sources.live_state_labels?.data,captured=Date.parse(history.captured_at),labelTime=Date.parse(labels?.captured_at);
  if(history.version!==1||history.origin!=='https://app.clinic-cloud.com'
    ||history.source_endpoint!=='/apps/contacto/pestanas-contacto-ficha/php/citas/citas.api.php/get-citas'
    ||history.policy!=='read_only_no_clinical_or_economic_mutations'
    ||![captured,labelTime].every(t=>Number.isFinite(t)&&t<=now&&now-t<=2*3600000)
    ||labels.source!=='patient_appointments_table_display_renderer') throw Error('OBSERVED_HISTORY_EVIDENCE_INVALID_OR_EXPIRED');
  for(const [code,expected] of [[0,'PENDIENTE'],[1,'REALIZADA'],[3,'PAGADA'],[-1,'NO ACUDE'],[-2,'ANULADA']]){
    const observed=labels.observations.filter(o=>o.code===code);
    const allowed=[expected,...([1,3].includes(code)?[`${expected} FACTURAR PRODUCIDO`]:[])];
    if(observed.length!==1||!allowed.includes(norm(observed[0].label))) throw Error('OBSERVED_HISTORY_STATE_LABELS_REQUIRED');
  }
  const patients=history.patients.filter(p=>p.contact_id===sourceId),patient=patients[0];
  if(patients.length!==1||!Array.isArray(patient.rows)||!patient.rows.length||patient.rows.length>5000
    ||new Set(patient.rows.map(r=>String(r.idCita))).size!==patient.rows.length
    ||patient.rows.some(r=>String(r.idContacto)!==sourceId||Number(r.agenda?.idEmpresa)!==5880)) throw Error('OBSERVED_HISTORY_SCOPE_INVALID');
  const services=new Map(sources.historic_services.rows.map(r=>[String(r.values.idServicio),r.values]));
  const evidence=[],reasons=[];
  for(const appointment of patient.rows){
    const state=Number(appointment.estado),day=dateOnly(appointment.fechaIni);
    if(![0,1,3,-1,-2].includes(state)||!day||!Array.isArray(appointment.conceptos)) throw Error('OBSERVED_HISTORY_ROW_INVALID');
    if([-1,-2].includes(state)) continue;
    if(!appointment.conceptos.length) reasons.push('OBSERVED_HISTORY_CONCEPTS_MISSING');
    for(const concept of appointment.conceptos){
      if(String(concept.idContacto)!==sourceId||String(concept.idCita)!==String(appointment.idCita)) throw Error('OBSERVED_HISTORY_CONCEPT_SCOPE_INVALID');
      const classification=serviceClinic(services.get(String(concept.idServicio)));
      if(classification.blocked) continue;
      const conceptPaid=Number(concept.pagado??0),appointmentPaid=Number(appointment.pagado??0);
      if(![conceptPaid,appointmentPaid].every(Number.isFinite)) throw Error('OBSERVED_HISTORY_PAYMENT_FORMAT_INVALID');
      evidence.push({source:'observed_live_contact_history',source_contact_id:sourceId,source_appointment_id:String(appointment.idCita),
        source_concept_id:String(concept.idCitaConcepto),treatment_id:String(concept.idServicio),treatment_date:day,
        clinic_id:classification.clinic_id,classification:classification.reason,
        paid_evidence:state===3||conceptPaid>0||appointmentPaid>0,payment_reversed:conceptPaid<0||appointmentPaid<0,
        payment_evidence_kind:state===3?'observed_source_state_pagada_not_money':conceptPaid>0||appointmentPaid>0?'observed_source_paid_amount_not_ledger':null,
        provenance:{file_sha256:sources.live_histories.file.sha256,source_appointment_sha256:hash(appointment),
          source_concept_sha256:hash(concept),state_labels_sha256:sources.live_state_labels.file.sha256,
          services_sha256:sources.historic_services.file.sha256}});
    }
  }
  const choice=choosePrimaryClinic(evidence),first=choice.evidence?.[0]?.treatment_date;
  if(choice.reason) reasons.push(choice.reason);
  if(evidence.some(r=>!r.clinic_id&&!r.payment_reversed&&(choice.rule==='oldest_paid_treatment'
    ?r.paid_evidence&&(!first||r.treatment_date<=first):r.paid_evidence||!first||r.treatment_date<=first))) reasons.push('EARLIER_OR_PAID_TREATMENT_HAS_AMBIGUOUS_CLINIC');
  return {proposed_primary_clinic_id:reasons.length?null:choice.clinic_id,
    membership_clinic_ids:[...new Set(evidence.map(r=>r.clinic_id).filter(id=>[66,72].includes(id)))].sort((a,b)=>a-b),
    primary_rule:choice.rule,primary_evidence:choice.evidence||[],reasons:[...new Set(reasons)],
    first_evidence_date:evidence.map(r=>r.treatment_date).sort()[0]||null,
    coverage_basis:{kind:'observed_patient_history_unfiltered_read_endpoint',contact_id:sourceId,appointment_count:patient.rows.length,
      file_sha256:sources.live_histories.file.sha256,captured_at:history.captured_at}};
}
module.exports={observedHistoryPrimary};
