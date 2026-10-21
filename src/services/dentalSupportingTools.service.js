'use strict';
const crypto=require('node:crypto');
const {Op}=require('sequelize');
const C=require('../lib/dental-supporting-tools-contract');
const plain=value=>value?.toJSON?value.toJSON():value;
const parse=value=>typeof value==='string'?JSON.parse(value):value;
function createDentalSupportingToolsService({db,canAccess,resolveRole,storeAsset,readAsset,discardAsset,inspectUpload,now=()=>new Date(),newId=()=>crypto.randomUUID()}={}){
  const Row=db.DentalSupportingTools,Revision=db.DentalSupportingToolsRevision;
  const can=canAccess||((input)=>require('../lib/access-policy').canUserAccessFeature(input));
  const role=resolveRole|| (async({actorId,clinicId,transaction})=>{
    if(require('../lib/role-helpers').isGlobalAdmin(actorId))return'global_admin';
    const membership=await db.UsuarioClinica.findOne({where:{id_usuario:actorId,id_clinica:clinicId,[Op.or]:[{estado_invitacion:'aceptada'},{estado_invitacion:null}]},transaction});
    return require('../lib/access-policy').roleCodeFromMembership(membership);
  });
  const storage=storeAsset|| (input=>require('./clinicalPrivateStorage.service').storeClinicalPrivateAsset(input));
  const reader=readAsset|| (input=>require('./clinicalPrivateStorage.service').readClinicalPrivateAsset(input));
  function scopeInteger(value){const result=Number(value);if(!Number.isSafeInteger(result)||result<1)C.fail('scope_invalid','Selecciona paciente y clínica válidos.');return result;}
  async function context(input,transaction=null,writing=false){
    if(!input.actorId)C.fail('unauthenticated','Inicia sesión para continuar.',401);
    const actorId=scopeInteger(input.actorId),clinicId=scopeInteger(input.clinicId),planId=C.id(input.planId);
    const featureKeys=['patients.view','patients.sensitive.view','clinical.reports.view','clinical.reports.manage','appointments.manage'];
    const values=await Promise.all(featureKeys.map(featureKey=>can({actorId,clinicId,featureKey}))),permissions=Object.fromEntries(featureKeys.map((key,i)=>[key,!!values[i]]));
    if(!permissions['patients.view']||!permissions['patients.sensitive.view']||!permissions['clinical.reports.view']&&!permissions['appointments.manage'])C.fail('forbidden','No tienes permiso para estas herramientas.',403);
    const clinic=await db.Clinica.findByPk(clinicId,{attributes:['id_clinica','configuracion'],transaction});
    const configured=require('../lib/dental-area-scope').configuredDentalArea(clinic);
    if(writing)require('../lib/dental-area-scope').assertDentalAreaConfigured(clinic);
    let plan=await db.DentalPlan.findOne({where:{public_id:planId,clinic_id:clinicId},transaction});
    if(!plan)C.fail('plan_not_found','Plan dental no encontrado en esta clínica.',404);
    const patientId=Number(plan.patient_id),patient=await db.Paciente.findByPk(patientId,{transaction,...(writing?{lock:transaction.LOCK.UPDATE}:{})});
    if(!patient||!(Number(patient.clinica_id)===clinicId||db.PacienteClinica&&await db.PacienteClinica.findOne({where:{paciente_id:patientId,clinica_id:clinicId},transaction})))C.fail('patient_scope','El paciente no pertenece a esta clínica.',404);
    if(input.patientIdentifier!==undefined&&![String(patientId),patient.public_id].includes(String(input.patientIdentifier)))C.fail('patient_scope','El plan no pertenece a este paciente.',404);
    // Same lock order as core plan/episode commands: patient, then plan.
    // This also keeps private-asset FK writes from reversing those locks.
    if(writing){plan=await db.DentalPlan.findOne({where:{public_id:planId,clinic_id:clinicId,patient_id:patientId},transaction,lock:transaction.LOCK.UPDATE});if(!plan)C.fail('plan_not_found','Plan dental no encontrado.',404);}
    const roleCode=await role({actorId,clinicId,transaction});
    const clinical=configured&&['global_admin','propietario','doctor'].includes(roleCode)&&permissions['clinical.reports.manage']&&permissions['clinical.reports.view'];
    const logistics=configured&&permissions['appointments.manage'];
    if(writing&&!clinical&&!logistics)C.fail('forbidden','No tienes permiso para modificar estas herramientas.',403);
    const user=db.Usuario?await db.Usuario.findByPk(actorId,{attributes:['nombre','apellidos'],transaction}):null;
    const actorName=user?[user.nombre,user.apellidos].filter(Boolean).join(' ').trim():'Profesional';
    return{actorId,clinicId,patientId,plan,clinical,readClinical:permissions['clinical.reports.view'],actorName,at:now().toISOString(),newId,capabilities:{area_configured:configured,clinical_edit:clinical,clinical_view:permissions['clinical.reports.view'],logistics_edit:logistics,message:clinical||logistics,upload:clinical||logistics}};
  }
  function dto(row,ctx){return{id:row?.public_id||null,plan_id:ctx.plan.public_id,patient_id:ctx.patientId,clinic_id:ctx.clinicId,version:Number(row?.version_number||0),...C.clone(parse(row?.state)||C.emptyState())};}
  function visible(item,ctx){if(ctx.readClinical)return item;const result=C.clone(item);result.odontogram=null;result.periodontal_records=[];result.messages=result.messages.filter(m=>m.context.kind==='lab_order');result.evidences=result.evidences.map(({notes,annotations,review_notes,...e})=>({...e,notes:'',annotations:[]}));return result;}
  async function current(ctx,transaction=null,lock=false){return Row.findOne({where:{plan_id:ctx.plan.id},transaction,...(lock?{lock:transaction.LOCK.UPDATE}:{})});}
  async function validateRelations(state,ctx,transaction,pendingAssetId=null){
    const planState=parse(ctx.plan.state)||{},actIds=new Set((planState.acts||[]).map(a=>a.id)),sessionIds=new Set((planState.sessions||[]).map(s=>s.id));
    const reservationIds=new Set((planState.reservations||[]).map(r=>Number(r.appointment_id)));
    const check=(item)=>{
      if((item.act_ids||[]).some(v=>!actIds.has(v))||(item.session_ids||[]).some(v=>!sessionIds.has(v)))C.fail('relation_scope','La actuación o sesión no pertenece a este plan.',404);
      if((item.appointment_ids||[]).some(v=>!reservationIds.has(Number(v))))C.fail('appointment_scope','La reserva no pertenece a este plan.',404);
    };
    const appointments=new Set();
    for(const item of [...state.evidences,...state.lab_orders]){
      check(item);for(const appointment of item.appointment_ids||[])appointments.add(appointment);
      for(const key of ['request_session_id','needed_session_id'])if(item[key]&&!sessionIds.has(item[key]))C.fail('relation_scope','La sesión del pedido no pertenece a este plan.',404);
      if(item.appointment_id){if(!reservationIds.has(item.appointment_id))C.fail('appointment_scope','La reserva del pedido no pertenece a este plan.',404);appointments.add(item.appointment_id);}
      if(item.request_before&&item.needed_on&&item.request_before>item.needed_on)C.fail('lab_date','La fecha de solicitud debe ser anterior a la necesidad clínica.');
      if(item.evidence_ids?.some(v=>!state.evidences.some(e=>e.id===v&&e.status==='active')))C.fail('evidence_scope','Una prueba no está disponible en este plan.',404);
    }
    for(const appointmentId of appointments){const appointment=await db.CitaPaciente.findOne({where:{id_cita:appointmentId,clinica_id:ctx.clinicId,paciente_id:ctx.patientId},transaction});if(!appointment)C.fail('appointment_scope','La reserva no corresponde al paciente y clínica.',404);}
    for(const evidence of state.evidences.filter(e=>e.asset_id&&e.status==='active'&&e.asset_id!==pendingAssetId)){
      const asset=await db.ClinicalPrivateAsset.findOne({where:{public_id:evidence.asset_id,clinic_id:ctx.clinicId,patient_id:ctx.patientId,purpose:'clinical_attachment',scope_type:'clinic',status:'active'},transaction});
      if(!asset)C.fail('asset_scope','El archivo no pertenece a este paciente y clínica.',404);
      const metadata=parse(asset.metadata)||{},mime=asset.content_type;
      if(evidence.kind==='stl'?!(mime==='application/octet-stream'&&metadata.dental_stl_validated===true):evidence.kind==='pdf'?mime!=='application/pdf':!['application/pdf','image/jpeg','image/jpg','image/png','image/webp'].includes(mime))C.fail('asset_kind','El tipo del archivo no corresponde a la prueba.');
      if(evidence.kind==='photo'&&!mime.startsWith('image/'))C.fail('asset_kind','La fotografía necesita una imagen.');
    }
    for(const message of state.messages){const {kind,id}=message.context;if(kind==='session'&&!sessionIds.has(id)||kind==='evidence'&&!state.evidences.some(e=>e.id===id)||kind==='lab_order'&&!state.lab_orders.some(o=>o.id===id))C.fail('message_context','El contexto del mensaje no pertenece a este plan.',404);}
  }
  async function read(input){const ctx=await context(input),row=await current(ctx);if(input.version!==undefined&&input.version!==null&&input.version!==''){
    // An execution may pin the state before any tools were recorded. Never
    // replace that historical absence with the plan's later observations.
    if(input.version===0||input.version==='0')return{item:visible(dto(null,ctx),ctx),capabilities:{...ctx.capabilities,clinical_edit:false,logistics_edit:false,message:false,upload:false},historical:true};
    const version=scopeInteger(input.version);if(!row)C.fail('version_not_found','No existe esa versión de herramientas.',404);
    const revision=await Revision.findOne({where:{tool_id:row.id,version_number:version}});if(!revision)C.fail('version_not_found','No existe esa versión de herramientas.',404);
    return{item:visible(revision.snapshot,ctx),capabilities:ctx.capabilities,historical:version!==Number(row.version_number)};
  }return{item:visible(dto(row,ctx),ctx),capabilities:ctx.capabilities,historical:false};}
  function mutationInput(payload){if(!C.object(payload)||!Number.isSafeInteger(payload.expected_version)||payload.expected_version<0)C.fail('version_required','Actualiza las herramientas antes de guardar.',428);if(typeof payload.idempotency_key!=='string'||!/^[a-zA-Z0-9_.:-]{8,120}$/.test(payload.idempotency_key))C.fail('idempotency_required','Reintenta la acción con su identificador original.',428);return payload;}
  async function mutate(input,upload=false){const payload=mutationInput(input.payload);let file=null;
    if(upload){
      const preflight=await context(input);if(!preflight.capabilities.upload)C.fail('forbidden','No tienes permiso para aportar pruebas a este plan.',403);
      file=C.validateFile(payload);
      if(inspectUpload)await inspectUpload(file);
      else if(file.contentType==='application/pdf')await require('./clinicalAttachmentPreview.service').getPdfPageCount(file.buffer);
      else if(file.contentType.startsWith('image/')){try{const image=await require('sharp')(file.buffer,{limitInputPixels:40*1000*1000,failOn:'error'}).metadata();if(!['jpeg','png','webp'].includes(image.format)||(image.pages||1)>1||!image.width||!image.height)throw Error('unsupported_image');}catch{C.fail('image_invalid','La imagen no permite una lectura clínica válida.');}}
    }
    const mutationHash=C.hash(upload?{upload:{sha256:file.sha256,filename:file.filename,content_type:payload.content_type,evidence:payload.evidence}}:{command:payload.command});
    let pendingAsset=null;
    try{return await db.sequelize.transaction({isolationLevel:'READ COMMITTED'},async transaction=>{
      const ctx=await context(input,transaction,true);if(['archived','cancelled'].includes(ctx.plan.status))C.fail('plan_readonly','El plan sólo se puede consultar.',409);
      let row=await current(ctx,transaction,true);
      if(row){const replay=await Revision.findOne({where:{tool_id:row.id,command_key:payload.idempotency_key},transaction});if(replay){if(replay.command_hash!==mutationHash)C.fail('idempotency_conflict','Esta solicitud ya se utilizó para otra acción.',409);return{item:visible(replay.snapshot,ctx),capabilities:ctx.capabilities,replayed:true};}}
      if(Number(row?.version_number||0)!==payload.expected_version)C.fail('version_conflict','Las herramientas han cambiado. Tu borrador se conserva; vuelve a cargar antes de guardar.',409);
      const previous=parse(row?.state)||C.emptyState();let command=payload.command;
      if(upload){
        if(!C.object(payload.evidence)||payload.evidence.kind==='physical')C.fail('evidence_invalid','Indica el tipo de prueba clínica.');
        // Validate the whole non-file command before storing bytes. The asset
        // row participates in this transaction; no upload can publish a ghost
        // evidence reference when its relation/CAS validation fails.
        const provisional=C.applyCommand(previous,{type:'evidence.add',evidence:{...payload.evidence,asset_id:'pending_upload'}},ctx);
        await validateRelations(provisional,ctx,transaction,'pending_upload');
        const isStl=['model/stl','application/sla','application/octet-stream'].includes(payload.content_type);
        if(isStl!==(payload.evidence.kind==='stl'))C.fail('asset_kind','El tipo de prueba no corresponde al archivo.');
        const asset=await storage({purpose:'clinical_attachment',clinicId:ctx.clinicId,patientId:ctx.patientId,ownerType:'dental_plan',ownerId:ctx.plan.public_id,
          originalFilename:file.filename,contentType:file.contentType,buffer:file.buffer,createdBy:ctx.actorId,transaction,
          metadata:{category:'pruebas',uploaded_from:'dental_tools',dental_plan_id:ctx.plan.public_id,dental_stl_validated:isStl,file_sha256:file.sha256}});
        pendingAsset=asset;
        command={type:'evidence.add',evidence:{...payload.evidence,asset_id:asset.public_id}};
      }
      if(!ctx.readClinical&&command?.type==='message.add'&&command.context?.kind!=='lab_order')C.fail('clinical_forbidden','La comunicación clínica del plan requiere permiso de lectura clínica.',403);
      const state=C.applyCommand(previous,command,ctx);await validateRelations(state,ctx,transaction);
      const nextVersion=payload.expected_version+1;
      if(row)await row.update({state,version_number:nextVersion,updated_by:ctx.actorId},{transaction});
      else row=await Row.create({public_id:newId(),plan_id:ctx.plan.id,clinic_id:ctx.clinicId,patient_id:ctx.patientId,version_number:nextVersion,state,created_by:ctx.actorId,updated_by:ctx.actorId},{transaction});
      const item=dto(row,ctx);
      await Revision.create({tool_id:row.id,version_number:nextVersion,snapshot:item,command_key:payload.idempotency_key,command_hash:mutationHash,command_type:upload?'evidence.upload':command.type,actor_id:ctx.actorId},{transaction});
      return{item:visible(item,ctx),capabilities:ctx.capabilities,replayed:false};
    });}catch(error){if(pendingAsset){try{if(discardAsset)await discardAsset(pendingAsset);else if(!storeAsset)await require('./clinicalPrivateStorage.service').discardUncommittedClinicalObject(pendingAsset);}catch{/* Keep the original transaction error; a private object is safer than deleting a possibly committed asset. */}}throw error;}
  }
  async function revisions(input){const ctx=await context(input),row=await current(ctx);if(!row)return{items:[]};const rows=await Revision.findAll({where:{tool_id:row.id},order:[['version_number','DESC']],limit:100});return{items:rows.map(r=>({version:Number(r.version_number),command_type:r.command_type,actor_id:r.actor_id,created_at:r.created_at}))};}
  async function asset(input){const ctx=await context(input),row=await current(ctx);const state=parse(row?.state)||C.emptyState();const evidence=state.evidences.find(e=>e.asset_id===input.assetId);if(!evidence)C.fail('asset_not_found','El archivo no está vinculado a este plan.',404);
    const source=await db.ClinicalPrivateAsset.findOne({where:{public_id:input.assetId,clinic_id:ctx.clinicId,patient_id:ctx.patientId,purpose:'clinical_attachment',scope_type:'clinic',status:'active'}});if(!source)C.fail('asset_not_found','Archivo no disponible.',404);return reader(source);}
  async function getPlanToolState({planPublicId,clinicId,patientId,transaction}){
    const plan=await db.DentalPlan.findOne({where:{public_id:planPublicId,clinic_id:scopeInteger(clinicId),patient_id:scopeInteger(patientId)},transaction});if(!plan)C.fail('plan_not_found','Plan dental no encontrado.',404);
    const row=await Row.findOne({where:{plan_id:plan.id},transaction});return{...(C.clone(parse(row?.state)||C.emptyState())),version:Number(row?.version_number||0),id:row?.public_id||null};
  }
  async function preview(input){const source=await asset(input);return require('./clinicalAttachmentPreview.service').createClinicalAttachmentPreview({buffer:source.buffer,contentType:source.contentType,page:input.page});}
  async function laboratory(input){
    if(!input.actorId)C.fail('unauthenticated','Inicia sesión para continuar.',401);
    const actorId=scopeInteger(input.actorId),clinicId=scopeInteger(input.clinicId);
    for(const featureKey of ['patients.view','patients.sensitive.view'])if(!await can({actorId,clinicId,featureKey}))C.fail('forbidden','No tienes permiso para la bandeja de laboratorio.',403);
    if(!await can({actorId,clinicId,featureKey:'clinical.reports.view'})&&!await can({actorId,clinicId,featureKey:'appointments.manage'}))C.fail('forbidden','No tienes permiso para la bandeja de laboratorio.',403);
    const limit=input.limit===undefined?50:scopeInteger(input.limit);if(limit>100)C.fail('limit','Solicita como máximo 100 pedidos.');
    const status=input.status||'pending';if(!['all','pending','draft','requested','received','approved','rejected'].includes(status))C.fail('option_invalid','Selecciona un estado de laboratorio válido.');
    let cursor={row:0,offset:0};if(input.cursor){try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(cursor.clinic!==clinicId||cursor.status!==status||!Number.isSafeInteger(cursor.row)||cursor.row<1||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>1000)throw Error('cursor');}catch{C.fail('cursor_invalid','La página de laboratorio no es válida.');}}
    const rows=await Row.findAll({where:{clinic_id:clinicId,...(cursor.row?{id:{[Op.gte]:cursor.row}}:{})},order:[['id','ASC']],limit:21});
    const items=[];let next=null;
    for(const row of rows){const plan=await db.DentalPlan.findOne({where:{id:row.plan_id,clinic_id:clinicId,patient_id:row.patient_id}});if(!plan)continue;const patient=await db.Paciente.findByPk(row.patient_id,{attributes:['id_paciente','public_id','clinica_id','nombre','apellidos']});if(!patient)continue;
      const member=Number(patient.clinica_id)===clinicId||db.PacienteClinica&&await db.PacienteClinica.findOne({where:{paciente_id:row.patient_id,clinica_id:clinicId}});if(!member)continue;
      const orders=(parse(row.state)||C.emptyState()).lab_orders;for(let i=Number(row.id)===cursor.row?cursor.offset:0;i<orders.length;i++){
        const order=orders[i];if(status==='pending'?order.status==='approved':status!=='all'&&order.status!==status)continue;
        if(items.length===limit){next={clinic:clinicId,status,row:Number(row.id),offset:i};break;}
        items.push({...C.clone(order),plan_id:plan.public_id,plan_title:parse(plan.state)?.title||null,patient_id:Number(row.patient_id),patient_public_id:patient.public_id,patient_name:[patient.nombre,patient.apellidos].filter(Boolean).join(' ').trim(),tools_version:Number(row.version_number)});
      }if(next)break;
    }
    if(!next&&rows.length===21)next={clinic:clinicId,status,row:Number(rows[rows.length-1].id)+1,offset:0};
    return{items,next_cursor:next?Buffer.from(JSON.stringify(next)).toString('base64url'):null};
  }
  return{read,command:input=>mutate(input),upload:input=>mutate(input,true),revisions,asset,preview,laboratory,getPlanToolState};
}
let live;
const current=()=>live||(live=createDentalSupportingToolsService({db:require('../../models')}));
module.exports={createDentalSupportingToolsService,current,getPlanToolState:input=>current().getPlanToolState(input)};
