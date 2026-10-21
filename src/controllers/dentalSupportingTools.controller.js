'use strict';
const service=require('../services/dentalSupportingTools.service');
function createController({getService=()=>service.current()}={}){
  const input=req=>{
    for(const key of ['clinic_id','patient_id'])if(req.query[key]!==undefined&&req.body?.[key]!==undefined&&String(req.query[key])!==String(req.body[key]))require('../lib/dental-supporting-tools-contract').fail('scope_mismatch','Selecciona el mismo paciente y clínica en esta acción.');
    return{planId:req.params.planId,clinicId:req.query.clinic_id??req.body?.clinic_id,patientIdentifier:req.query.patient_id??req.body?.patient_id,actorId:req.userData?.userId,
    version:req.query.version,payload:req.body,assetId:req.params.assetId,page:req.query.page,cursor:req.query.cursor,limit:req.query.limit,status:req.query.status};};
  const handler=action=>async(req,res)=>{res.set('Cache-Control','private, no-store');try{await action(req,res);}catch(error){const pending=['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(error.original?.code||error.parent?.code);const status=pending?503:([400,401,403,404,409,413,428,503].includes(error.statusCode)?error.statusCode:500);return res.status(status).json({error:{code:pending?'dental_tools_schema_pending':status===500?'dental_tools_unavailable':error.code,message:status===500?'No se pudo acceder a las herramientas dentales.':pending?'Las herramientas dentales están pendientes de habilitación técnica.':error.message}});}};
  return{
    read:handler(async(req,res)=>res.json(await getService().read(input(req)))),
    command:handler(async(req,res)=>res.json(await getService().command(input(req)))),
    upload:handler(async(req,res)=>res.status(201).json(await getService().upload(input(req)))),
    revisions:handler(async(req,res)=>res.json(await getService().revisions(input(req)))),
    laboratory:handler(async(req,res)=>res.json(await getService().laboratory(input(req)))),
    patientAssets:handler(async(req,res)=>res.json(await getService().patientAssets(input(req)))),
    preview:handler(async(req,res)=>{const file=await getService().preview(input(req));res.set('Content-Type',file.contentType);res.set('X-Content-Type-Options','nosniff');res.set('X-Preview-Page-Count',String(file.pageCount));res.send(file.buffer);}),
    asset:handler(async(req,res)=>{const file=await getService().asset(input(req));res.set('X-Content-Type-Options','nosniff');res.set('Content-Type',file.contentType);
      const safe=String(file.filename||'archivo').replace(/[\r\n"\\]/g,'_').replace(/[^\x20-\x7e]/g,'_');res.set('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.filename||'archivo')}`);res.send(file.buffer);}),
  };
}
module.exports={...createController(),createController};
