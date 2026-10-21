'use strict';
const D=require('./dental-plan-contract'),C=require('./clinical-episode-contract'),P=require('./program-booking-preferences');
function normalize(value){
 if(value==null)return null;if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['exclude_weekdays','prefer_after_minutes','prefer_before_minutes','keep_professional','doctor_id','installation_id','max_duration_minutes','notes'].includes(k)))D.fail('preferences_invalid','Revisa las preferencias de planificación.');
 const {doctor_id,installation_id,max_duration_minutes,notes,...common}=value,result=P.normalizePreferences(common)||{};
 if(doctor_id!=null)result.doctor_id=C.integer(doctor_id);if(installation_id!=null)result.installation_id=C.integer(installation_id);
 if(max_duration_minutes!=null){if(!Number.isInteger(max_duration_minutes)||max_duration_minutes<1||max_duration_minutes>720)D.fail('preferences_invalid','Indica la duración máxima entre 1 y 720 minutos.');result.max_duration_minutes=max_duration_minutes;}
 if(notes)result.notes=D.text(notes);return Object.keys(result).length?result:null;
}
function selections(preferences,profile,state){
 const first=profile.phases[0],result={};let doctor=preferences?.doctor_id;
 if(!doctor&&preferences?.keep_professional){const reservation=state.reservations.find(r=>r.active!==false&&r.phases?.[0]?.doctor_ids?.length===1),candidate=reservation?.phases[0].doctor_ids[0];if(first.professionals.ids.includes(candidate))doctor=candidate;}
 if(doctor){if(!first.professionals.ids.includes(doctor))D.fail('preference_profile_mismatch','El profesional preferido no está habilitado para iniciar este tratamiento.',409);if(first.professionals.mode==='any')result.doctor_id=doctor;}
 if(preferences?.installation_id){if(!first.installation_ids.includes(preferences.installation_id))D.fail('preference_profile_mismatch','El gabinete preferido no corresponde al primer paso del tratamiento.',409);result.installation_id=preferences.installation_id;}
 if(preferences?.max_duration_minutes&&require('./booking-profile').bookingProfileDurationMinutes(profile)>preferences.max_duration_minutes)D.fail('preference_duration_exceeded','Esta reserva supera la duración máxima elegida. Divide el trabajo o revisa la preferencia.',409);
 return Object.keys(result).length?{[first.key]:result}:{};
}
module.exports={normalize,selections};
