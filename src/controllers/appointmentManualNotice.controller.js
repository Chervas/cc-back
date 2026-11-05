'use strict';
const service = () => require('../services/appointmentManualNotice.service').current();
function input(req) {
  const appointmentId=Number(req.params.id),clinicId=Number(req.body?.clinic_id || req.query?.clinic_id),userId=Number(req.userData?.userId);
  if (![appointmentId,clinicId,userId].every(n=>Number.isSafeInteger(n)&&n>0)) throw Object.assign(new Error('Selecciona una cita y una clínica.'),{code:'manual_appointment_scope_invalid',statusCode:400});
  return {appointmentId,clinicId,userId};
}
function failure(error,res) {
  const status=Number(error.statusCode || error.status) || 500;
  return res.status(status).json({code:error.code || 'manual_appointment_notice_failed',message:status<500?error.message:'No se pudo preparar el reenvío de la cita.'});
}
exports.preview=async(req,res)=>{try{return res.json(await service().preview(input(req)));}catch(error){return failure(error,res);}};
exports.send=async(req,res)=>{try{
  if (!req.body || Object.keys(req.body).some(k=>!['clinic_id','revision','request_id'].includes(k))) throw Object.assign(new Error('Solicitud de reenvío inválida.'),{code:'manual_appointment_request_invalid',statusCode:400});
  const result=await service().send({...input(req),revision:req.body.revision,requestId:req.body.request_id});
  return res.status(result.reused?200:202).json(result);
}catch(error){return failure(error,res);}};
