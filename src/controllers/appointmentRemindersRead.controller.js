'use strict';
const asyncHandler=require('express-async-handler');
const service=require('../services/appointmentRemindersRead.service');
const {domainError}=require('../lib/patientFollowUps.contract');
function createAppointmentRemindersReadController({reader=service}={}) {
  return {list:asyncHandler(async(req,res)=>{
    if (!req.userData?.userId) throw domainError(401,'unauthenticated','Usuario no autenticado.');
    const result=await reader.list({actorId:req.userData.userId,clinicId:req.query.clinic_id,query:req.query});
    res.set('Cache-Control','no-store');res.json(result);
  })};
}
module.exports={...createAppointmentRemindersReadController(),createAppointmentRemindersReadController};
