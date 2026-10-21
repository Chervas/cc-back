'use strict';
const C=require('../lib/clinical-episode-contract'),D=require('../lib/dental-plan-contract'),Dep=require('../lib/dental-dependencies');
function assertIndependentExecutionDate(report,results,now){const date=new Date(report.occurred_at);if(results.some(r=>r.status==='performed'||r.status==='partial')&&(!Number.isFinite(+date)||date>now))D.fail('execution_date_invalid','Revisa la fecha del episodio: no puedes registrar trabajo realizado en una consulta futura.',409);}
function createDentalPlanExecutionService({db,core,now=()=>new Date(),validateMaterials,episodes}={}){
 const episodeService=()=>episodes||require('./clinicalEpisodes.service').createClinicalEpisodeService({db,...(validateMaterials?{validateMaterialRefs:validateMaterials}:{})});
 async function execute(options){
  const result=await core.mutation(options,'execution',async({row,state,transaction})=>{
   const p=options.payload,episodeId=D.id(p.episode_id),episodeVersion=p.episode_expected_version;
   if(!Number.isSafeInteger(episodeVersion)||episodeVersion<1)D.fail('episode_version_required','Guarda el episodio y revisa su versión antes de registrar el trabajo.',428);
   const report=await db.AppointmentClinicalReport.findOne({where:{public_id:episodeId,patient_id:row.patient_id,clinic_id:row.clinic_id},transaction,lock:transaction.LOCK.UPDATE});
   if(!report)D.fail('episode_not_found','El episodio no corresponde a este paciente y clínica.',404);if(report.status!=='draft')D.fail('episode_final','Reabre el episodio antes de registrar trabajo dental.',409);
   if(Number(report.version_number)!==episodeVersion)D.fail('episode_version_conflict','El episodio ha cambiado. Revisa su versión antes de registrar el trabajo.',409,{current_version:Number(report.version_number)});
   if(report.template_key!=='dental')D.fail('episode_area_invalid','Abre un episodio dental para registrar este trabajo.',409);
   const clinic=await db.Clinica.findByPk(row.clinic_id,{transaction}),timeZone=require('../lib/availability-calendar').resolveClinicTimezone(clinic);
   const results=D.executionResults(state,p),actIds=[...new Set(results.map(r=>r.act_id))],session=state.sessions.find(s=>s.id===D.id(p.session_id)&&s.status!=='absorbed');
   if(!session||actIds.some(id=>!session.act_ids.includes(id))||!['reviewed','booked','done'].includes(session.status))D.fail('execution_scope_invalid','Elige trabajo de una sesión revisada.',409);
   if(!C.has(p,'appointment_id'))D.fail('reservation_selection_required','Elige una reserva o confirma que es una consulta sin cita.');
   let appointmentId=null;
   if(p.appointment_id!=null){
    appointmentId=C.integer(p.appointment_id);const reservation=state.reservations.find(r=>r.appointment_id===appointmentId&&r.session_id===session.id);
    if(!reservation||actIds.some(id=>!reservation.act_ids.includes(id)))D.fail('execution_scope_invalid','La reserva no incluye el trabajo seleccionado.',409);
    const appointment=await db.CitaPaciente.findOne({where:{id_cita:appointmentId,clinica_id:row.clinic_id,paciente_id:row.patient_id},transaction,lock:transaction.LOCK.SHARE});
    if(!appointment||['cancelada','no_asistio'].includes(appointment.estado))D.fail('appointment_not_found','Selecciona una reserva vigente de esta consulta.',404);
    const care=require('../lib/appointment-care').careState(appointment,now(),{timeZone});
    if(care.legacy_attendance||!care.started_at)D.fail('care_start_required','Inicia la atención de esta reserva antes de registrar trabajo realizado.',409);
    const link=Number(report.appointment_id)===appointmentId||await db.ClinicalEpisodeAppointment.findOne({where:{report_id:report.id,appointment_id:appointmentId,clinic_id:row.clinic_id,patient_id:row.patient_id},transaction});
    if(!link)D.fail('episode_reservation_required','Vincula explícitamente esta reserva al episodio antes de registrar su trabajo.',409);
   }else{
    assertIndependentExecutionDate(report,results,now());
    const linked=report.appointment_id||await db.ClinicalEpisodeAppointment.findOne({where:{report_id:report.id},transaction});
    if(linked||session.appointment_ids.length||state.reservations.some(r=>r.act_ids.some(id=>actIds.includes(id))))D.fail('reservation_required','Selecciona la reserva concreta del trabajo. Sólo una consulta y sesión sin citas admiten trabajo independiente.',409);
   }
   const tools=await core.readTools(row,transaction);
   Dep.assertToolsReady(tools,session.id,actIds,state.protocol_requirements);
   await require('./dentalProtocolEvidence.service').assertProtocolConsents({db,row,state,actIds,transaction,appointmentId,now:now()});
   const issues=Dep.dependencyIssues(state,{actIds,startAt:now(),timeZone,execution:true});Dep.assertDependencies(issues,p.reason);
   const latest=Dep.latestResults(state);if(results.some(r=>latest.get(r.act_id+':'+r.target_id)?.status==='performed')&&!D.text(p.reason))D.fail('execution_correction_reason','Explica la corrección del trabajo ya realizado.',409);
   const version=Number(row.version_number)+1,recordedAt=now().toISOString();
   state.execution.push(...results.map(r=>({...r,id:D.uuid(),plan_version:version,episode_id:episodeId,appointment_id:appointmentId,session_id:session.id,actor_id:options.actorId,recorded_at:recordedAt,reason:D.text(p.reason),tools_version:tools?.version??0,dependency_override:issues.filter(i=>i.action!=='warn')})));
   const current=Dep.latestResults(state);for(const act of state.acts){if(act.status==='cancelled')continue;const rows=act.targets.map(t=>current.get(act.id+':'+t.id));act.status=rows.every(r=>r?.status==='performed')?'performed':rows.some(r=>r?.status==='performed'||r?.status==='partial')?'partial':'pending';}
   session.status=session.act_ids.every(id=>state.acts.find(a=>a.id===id)?.status==='performed')?'done':session.appointment_ids.length?'booked':'reviewed';state.phase='execution';D.syncReviewLinks(state);
   return{afterPersist:async()=>{
    const refs=[...(report.material_refs||[]),{kind:'dental_execution',id:row.public_id,version}];
    const saved=await episodeService().saveInTransaction({id:episodeId,clinicId:Number(row.clinic_id),actorId:options.actorId,transaction,payload:{expected_version:episodeVersion,idempotency_key:'dental:'+C.hash(D.key(p)),material_refs:refs}});
    return{episode:saved.item};
   }};
  });
  if(result.replayed&&!result.episode)result.episode=(await episodeService().get({id:options.payload.episode_id,clinicId:options.clinicId})).item;
  return result;
 }
 return{execute};
}
module.exports={createDentalPlanExecutionService,assertIndependentExecutionDate};
