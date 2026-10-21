'use strict';
const C=require('../lib/clinical-episode-contract'),service=require('../services/dentalPlans.service');
function createDentalPlansController({plans=service,preparations=require('../services/dentalPlanPreparation.service')}={}){
 const handler=action=>(req,res)=>Promise.resolve().then(async()=>{
  res.set('Cache-Control','private, no-store');if(!req.userData?.userId)throw C.error(401,'unauthenticated','Usuario no autenticado.');
  const actorId=C.integer(req.userData.userId),clinicId=C.integer(req.query.clinic_id??req.body?.clinic_id);
  if(req.query.clinic_id!==undefined&&req.body?.clinic_id!==undefined&&C.integer(req.body.clinic_id)!==clinicId)throw C.error(400,'dental_clinic_mismatch','Selecciona la misma clínica en esta acción.');
  const requestedPatient=req.query.patient_id??req.body?.patient_id;
  const patientIdentifier=requestedPatient===undefined?undefined:C.integer(requestedPatient);
  if(req.query.patient_id!==undefined&&req.body?.patient_id!==undefined&&C.integer(req.body.patient_id)!==patientIdentifier)throw C.error(400,'dental_patient_mismatch','Selecciona el mismo paciente en esta acción.');
  return action(req,res,{actorId,clinicId,id:req.params.id,patientIdentifier,query:req.query,payload:req.body});
 }).catch(error=>{
  res.set('Cache-Control','private, no-store');if(['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(error.original?.code||error.parent?.code))return res.status(503).json({error:{code:'dental_schema_pending',message:'La historia dental está pendiente de habilitación técnica.'}});
  const status=error.statusCode||error.status;if([400,401,403,404,409,413,422,428,503].includes(status)&&typeof error.code==='string')return res.status(status).json({error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}});
  return res.status(500).json({error:{code:'dental_unavailable',message:'No se pudo completar la acción dental. Conserva tus cambios y vuelve a intentarlo.'}});
 });
 const out=name=>handler(async(req,res,options)=>res.json(await plans[name]({...options,...(['workspace','list'].includes(name)?{patientIdentifier:req.params.id,requestedPatientIdentifier:options.patientIdentifier}:{})})));
 return{workspace:out('workspace'),list:out('list'),get:out('get'),command:out('command'),availability:out('availability'),book:out('book'),execution:out('execution'),revisions:out('revisions'),
  preparation:handler(async(req,res,options)=>res.json(await preparations.read(options))),
  create:handler(async(req,res,options)=>{const result=await plans.create({...options,patientIdentifier:req.params.id,requestedPatientIdentifier:options.patientIdentifier});return res.status(result.created?201:200).json(result);})};
}
module.exports={...createDentalPlansController(),createDentalPlansController};
