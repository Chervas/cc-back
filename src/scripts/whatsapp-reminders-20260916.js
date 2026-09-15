#!/usr/bin/env node
'use strict';
// Explicit one-date exception: same-day reminder to both attendance states.
// Native template, window and Message idempotency are retained.
const DUE=Date.parse('2026-09-16T06:00:00Z'),END=Date.parse('2026-09-16T22:00:00Z');
const CLINICS=[19,56,58,59,72,77];
const TEMPLATES={19:'recordatorio_mismo_d_a_sabes_llegar__clinic_19',56:'recordatorio_mismo_d_a_sabes_llegar__clinic_56',58:'recordatorio_mismo_d_a_sabes_llegar__clinic_58',59:'recordatorio_mismo_d_a_sabes_llegar__clinic_59',72:'recordatorio_mismo_d_a_sabes_llegar__clinic_72',77:'recordatorio_mismo_d_a_sabes_llegar__clinic_77'};
const {assertAppointmentEligibility,patientImportHeld}=require('../lib/whatsappAppointmentEligibility');
const log=v=>process.stdout.write(JSON.stringify(v)+'\n');
console.log=console.warn=console.error=()=>{};
async function main(){
  const mode=process.argv[2];if(!['--inspect','--send'].includes(mode))throw Error('invalid_reminder_mode');
  require('../lib/whatsappBrokerClient').assertStaging(process.env);
  const now=Date.now();if(mode==='--send'&&(now<DUE||now>=DUE+900000))throw Error('reminder_window_closed');
  const db=require('../../models'),runtime=require('../services/appointmentAutomationV2Runtime.service'),broker=require('../lib/whatsappAuthorizedBrokerClient');
  const [rows]=await db.sequelize.query('SELECT id_cita FROM CitasPacientes WHERE clinica_id IN (:clinics) AND inicio > :start AND inicio < :end ORDER BY clinica_id,inicio,id_cita',{replacements:{clinics:CLINICS,start:new Date(DUE),end:new Date(END)}});
  const summary={at:new Date().toISOString(),mode,due:'2026-09-16T08:00:00+02:00',eligible:[],held:[],dispatched:[]};
  for(const row of rows){
    try{
      const a=await db.CitaPaciente.findByPk(row.id_cita,{raw:true});
      const clinicId=Number(a.clinica_id),bindings=broker.bindingsForClinic(clinicId).filter(b=>b.sendEnabled);
      if(!CLINICS.includes(clinicId)||!bindings.length)throw Error('sender_not_active');
      const b=await broker.binding(clinicId,bindings[0].assetId);if(!b?.sendEnabled)throw Error('sender_not_active');
      assertAppointmentEligibility({appointment:a,execution:{trigger_entity_id:a.id_cita,context:{appointment:{inicio:a.inicio}}},clinicId,patientId:a.paciente_id,
        templateName:'clinicaclick_recordatorio_mismo_dia_v1',now:mode==='--send'?Date.now():DUE});
      if(await patientImportHeld(Number(a.paciente_id),db))throw Error('patient_import_held');
      const template=await db.AutomationFlowTemplateV2.findOne({where:{template_key:TEMPLATES[clinicId],is_active:true,published_at:{[db.Sequelize.Op.ne]:null}},order:[['version','DESC']]});
      if(!template||template.trigger_type!=='appointment_reminder_window'||template.trigger_config?.schedule_moment!=='same_day'||template.trigger_config.custom_time!=='08:00'||template.trigger_config.schedule_time_mode!=='custom')throw Error('reminder_template_changed');
      const window=runtime.buildScheduledWindowIdentifier({triggerType:template.trigger_type,triggerConfig:template.trigger_config,scheduledFor:new Date(DUE)});
      summary.eligible.push({appointmentId:a.id_cita,clinicId,state:a.estado});
      if(mode==='--send'){
        const result=await runtime.enqueueExecutionForTemplate(a,template,{event_name:template.trigger_type,window_identifier:window,user_name:'authorized_recovery_20260916',user_role:'system'});
        summary.dispatched.push({appointmentId:a.id_cita,clinicId,executionId:result.execution?.id||null,jobId:result.queue_job_id||null,deduplicated:!!result.deduplicated,skipped:!!result.skipped});
        if(result.queue_job_id)await require('../services/jobScheduler.service').triggerImmediate(result.queue_job_id);
      }
    }catch(e){summary.held.push({appointmentId:row.id_cita,code:/^[a-z_]+$/.test(e.message||'')?e.message:'reminder_unavailable'});}
  }
  log(summary);
  // Keep callbacks alive while any specifically requested jobs are finishing.
  if(mode==='--send'){
    const ids=summary.dispatched.map(r=>r.jobId).filter(Boolean),until=Date.now()+60000;
    while(ids.length&&Date.now()<until){const n=await db.JobRequest.count({where:{id:ids,status:['pending','queued','running']}});if(!n)break;await new Promise(r=>setTimeout(r,1000));}
  }
  await db.sequelize.close();
}
main().then(()=>process.exit(0)).catch(e=>{log({event:'reminder_batch_failed',code:/^[a-z_]+$/.test(e.message||'')?e.message:'reminder_unavailable'});process.exit(1);});
