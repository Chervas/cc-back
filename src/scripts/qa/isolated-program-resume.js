#!/usr/bin/env node
'use strict';
// A separate, named synthetic purchase for browser acceptance. Never alters an
// existing demo purchase or real client, never sends messages or invoices.
const assert=require('node:assert/strict');
const {prepare,MARKER}=require('./prepare-isolated-clinical-fixture');
const marker='bs-resume-isolated-20260926';
async function main(){
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES,MARKER);
  require('dotenv').config({path:require('node:path').resolve(__dirname,'../../../.env'),quiet:true});
  assert.equal(process.env.DB_NAME,'clinicaclick_dev_isolated');assert.equal(process.env.DB_USERNAME,'cc_dev_api');
  for(const key of ['TREATMENT_PROGRAM_BOOKING_ENABLED','TREATMENT_PROGRAM_ECONOMICS_ENABLED','BOOKING_PROFILES_ENABLED','BOOKING_MULTI_RESOURCE_ENABLED'])process.env[key]='true';
  const db=require('../../../models');
  try{
    const f=await prepare(db);
    const existing=await db.EconomicBudget.findOne({where:{clinic_id:f.clinicId,source_reference:marker}});
    if(existing){
      const voucher=await db.PatientVoucher.findOne({where:{budget_id:existing.id,source_system:'treatment_program'}});assert(voucher,'Incomplete fixture: review, do not duplicate');
      console.log(JSON.stringify({existing:true,marker,patient:f.patientPublicId,voucher:voucher.public_id,budget:existing.public_id}));return;
    }
    const treatments=[];
    for(const [index,id] of f.installationIds.entries()){
      const [t]=await db.Tratamiento.findOrCreate({where:{codigo:`QA-RESUME-20260926-${index}`,clinica_id:f.clinicId},defaults:{nombre:`QA · Reanudar · Cabina ${index+1}`,disciplina:'estetica',origen:'clinica',activo:true,duracion_min:30,precio_base:50,clinical_config:{qa_demo:marker,catalog_status:'active',booking_profile:{version:1,phases:[{key:'care',duration_minutes:30,installation_ids:[id],professionals:{mode:'any',ids:[f.doctorIds[0]],preferred_id:f.doctorIds[0]}}]}}}});
      assert.equal(t.clinical_config.qa_demo,marker);treatments.push(t.id_tratamiento);
    }
    const programs=require('../../services/treatmentPrograms.service'),economics=require('../../services/patientEconomics.service');
    const program=await programs.create({clinicId:f.clinicId,actorId:f.actorId,payload:{idempotency_key:marker,name:'QA · Retomar programa · ficticio',kind:'program',status:'active',total_price:300,
      notes:'Prueba ficticia de reanudación. No facturar, enviar ni aplicar a pacientes reales.',cadence:{mode:'weekly',sessions_per_week:2,min_days_between:2},
      appointments:[0,1,2].map(i=>({key:'s'+i,label:'Sesión '+(i+1),offset_days:null,treatment_ids:treatments}))}});
    const budget=await economics.createBudget({patientIdentifier:f.patientPublicId,clinicId:f.clinicId,actorId:f.actorId,payload:{status:'draft',source_system:'clinicaclick_demo',source_reference:marker,
      lines:[{key:'program',program_id:program.item.id,program_version:program.item.version,quantity:1,unit_price:300}],notes:'QA ficticia, no emitir ni enviar.',payment_proposal:{mode:'single',included_modes:['single']}}});
    await economics.transitionBudget({publicId:budget.id,actorId:f.actorId,action:'present',payload:{presentation_channel:'printed'}});
    await economics.transitionBudget({publicId:budget.id,actorId:f.actorId,action:'accept',payload:{selected_payment_mode:'single',signature_channel:'not_required',send_channel:'none',collection_method:'pending'}});
    const row=await db.EconomicBudget.findOne({where:{public_id:budget.id}}),voucher=await db.PatientVoucher.findOne({where:{budget_id:row.id,source_system:'treatment_program'}});
    const service=require('../../services/patientProgramBooking.service').createPatientProgramBookingService({db,now:()=>new Date('2026-09-01T00:00:00Z')});
    const options={publicId:voucher.public_id,clinicId:f.clinicId,actorId:f.actorId};const plan=await service.read(options);
    const result=await service.book({...options,payload:{request_key:marker+'-initial',snapshot_sha256:plan.snapshot_sha256,sessions:['2026-09-14','2026-09-16','2026-09-28'].map((day,i)=>({key:'s'+i,start_at:day+'T14:00:00Z'}))}});
    for(const [i,estado] of [[0,'completada'],[1,'no_asistio']])await require('../../services/appointmentBookingCommand.service').mutateAppointmentBooking({db,existingAppointmentId:result.sessions[i].appointment_id,
      appointmentValues:{estado,updated_by:f.actorId},stateOnly:true,persist:({existing,values,transaction})=>existing.update(values,{transaction})});
    console.log(JSON.stringify({marker,patient:f.patientPublicId,voucher:voucher.public_id,budget:budget.id,appointmentIds:result.sessions.map(s=>s.appointment_id),synthetic_only:true,reminders:false}));
  }finally{await db.sequelize.close();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({code:e.code||e.name,message:e.message}));process.exitCode=1;});
