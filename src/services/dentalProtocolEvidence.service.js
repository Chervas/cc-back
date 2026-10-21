'use strict';
const D=require('../lib/dental-plan-contract');
async function assertProtocolConsents({db,row,state,actIds,transaction,appointmentId=null,startAt=null,now=new Date()}){
 const requirements=(state.protocol_requirements||[]).filter(r=>r.action!=='warn'&&r.source_type==='document'&&r.act_ids.some(id=>actIds.includes(id)));
 for(const rule of requirements)for(const id of rule.act_ids.filter(id=>actIds.includes(id))){
  const act=state.acts.find(a=>a.id===id);
  const result=await require('./appointmentConsentEligibility.service').assessAppointmentClinicalConsent({db,transaction,now,appointment:{id_cita:appointmentId,clinica_id:row.clinic_id,paciente_id:row.patient_id,tratamiento_id:act.treatment_id,inicio:startAt||now,import_metadata:null}});
  if(!result.required_clinical_count||!result.allowed)D.fail('consent_required','Revisa la configuración y las firmas clínicas exigidas por el protocolo antes de continuar.',409,{rule:rule.code});
 }
}
module.exports={assertProtocolConsents};
