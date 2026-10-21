'use strict';
function error(){return Object.assign(new Error('La reserva dental no coincide con la versión del plan. Revisa su planificación.'),{statusCode:409,code:'dental_appointment_scope_changed'});}
const object=value=>typeof value==='string'?JSON.parse(value):value;
async function dentalAppointmentContext(db,appointment,transaction){
 const metadata=object(appointment.import_metadata||{}),reference=metadata.dental_plan;if(!reference)return null;
 const plan=await db.DentalPlan.findOne({where:{public_id:reference.id,clinic_id:Number(appointment.clinica_id),patient_id:Number(appointment.paciente_id)},transaction});
 const state=plan&&object(plan.state),reservation=state?.reservations.find(r=>Number(r.appointment_id)===Number(appointment.id_cita)&&r.session_id===reference.session_id);
 if(!reservation||!Array.isArray(reference.act_ids)||JSON.stringify(reservation.act_ids.slice().sort())!==JSON.stringify(reference.act_ids.slice().sort()))throw error();
 const acts=reservation.act_ids.map(id=>state.acts.find(a=>a.id===id));if(acts.some(a=>!a))throw error();
 return{plan_id:plan.public_id,session_id:reservation.session_id,act_ids:reservation.act_ids,treatment_ids:[...new Set(acts.map(a=>a.treatment_id).filter(Boolean))],profile:reservation.profile_snapshot};
}
function assertCoordinatedDentalScheduleChange(previous,next,coordinated){
 const metadata=object(previous?.import_metadata||{});if(!metadata.dental_plan||coordinated)return;
 if(['inicio','fin'].some(k=>new Date(previous[k]).getTime()!==new Date(next[k]).getTime())||['paciente_id','clinica_id','tratamiento_id'].some(k=>Number(previous[k]||0)!==Number(next[k]||0)))throw Object.assign(new Error('Replanifica esta reserva desde su plan dental para conservar el trabajo, las esperas y los recursos.'),{statusCode:409,code:'dental_coordinated_schedule_required'});
}
module.exports={dentalAppointmentContext,assertCoordinatedDentalScheduleChange};
