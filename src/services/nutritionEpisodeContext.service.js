'use strict';
/** A measurement may reference an existing draft episode, never infer one by day. */
function createNutritionEpisodeResolver({db,assertUserCanAccessFeature}) {
 return async function resolve({patient,context,payload,actorUserId,transaction}) {
  const value=payload.episode_id;
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw Object.assign(new Error('nutrition_episode_invalid'),{status:400,code:'nutrition_episode_invalid'});
  for(const featureKey of ['clinical.reports.view','clinical.reports.manage'])await assertUserCanAccessFeature({actorId:Number(actorUserId),clinicId:context.clinic_id,featureKey});
  const episode=await db.AppointmentClinicalReport.findOne({where:{public_id:value,patient_id:Number(patient.id_paciente),clinic_id:context.clinic_id},transaction,lock:transaction.LOCK.UPDATE});
  if(!episode)throw Object.assign(new Error('nutrition_episode_not_found'),{status:404,code:'nutrition_episode_not_found'});
  if(episode.status!=='draft')throw Object.assign(new Error('El episodio está finalizado. Registra una medición independiente o reábrelo explícitamente.'),{status:409,code:'nutrition_episode_final'});
  if(context.appointment_id&&Number(episode.appointment_id)!==context.appointment_id){
   const member=await db.ClinicalEpisodeAppointment.findOne({where:{report_id:episode.id,appointment_id:context.appointment_id},transaction});
   if(!member)throw Object.assign(new Error('La cita seleccionada no pertenece al episodio.'),{status:400,code:'nutrition_episode_appointment_mismatch'});
  }
  return episode.public_id;
 };
}
module.exports={createNutritionEpisodeResolver};
