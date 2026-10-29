'use strict';
const crypto=require('node:crypto');
const C=require('../lib/clinical-episode-contract'),F=require('../lib/clinical-form-contract');
const clone=value=>JSON.parse(JSON.stringify(value));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function createClinicalEpisodeFormsService({db,canAccess=input=>require('../lib/access-policy').canUserAccessFeature(input),now=()=>new Date()}={}){
 const templates=require('./clinicalEpisodeTemplates.service').createClinicalEpisodeTemplateService({db});
 const reference=require('./patientClinicalReference.service').createPatientClinicalReferenceService({db,canAccess});
 async function contextSnapshot(row,transaction){
  const {resolveClinicTimeZone}=require('./clinicOpeningHours.service');
  const [patient,professional,clinic]=await Promise.all([
   db.Paciente.findOne({where:{id_paciente:row.patient_id},transaction}),
   row.professional_id&&db.Usuario?db.Usuario.findByPk(row.professional_id,{attributes:['id_usuario','nombre','apellidos'],transaction}):null,
   db.Clinica?.findByPk(row.clinic_id,{transaction}),
  ]);
  const date=row.occurred_at?new Date(row.occurred_at):now(),zone=resolveClinicTimeZone(clinic?.toJSON?clinic.toJSON():clinic);
  const local=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
  const birth=patient?.fecha_nacimiento?String(patient.fecha_nacimiento instanceof Date?patient.fecha_nacimiento.toISOString():patient.fecha_nacimiento).slice(0,10):null;
  let age=null;if(birth&&/^\d{4}-\d\d-\d\d$/.test(birth)){const n=Number(local.slice(0,4))-Number(birth.slice(0,4))-(local.slice(5)<birth.slice(5)?1:0);if(n>=0&&n<=130)age=String(n);}
  const nullable=value=>typeof value==='string'&&value.trim()?value:typeof value==='number'?String(value):null;
  return{'patient.full_name':[patient?.nombre,patient?.apellidos].filter(Boolean).join(' ')||null,'patient.document':nullable(patient?.dni),'patient.code':nullable(patient?.codigo_paciente||patient?.numero_historia),'patient.history_number':nullable(patient?.numero_historia),
   'patient.birth_date':birth,'patient.age':age,'patient.sex':nullable(patient?.sexo),'patient.phone':nullable(patient?.telefono_movil),
   'patient.email':nullable(patient?.email),'patient.profession':nullable(patient?.profesion),'patient.how_known':nullable(patient?.como_nos_conocio),
   'professional.name':professional?[professional.nombre,professional.apellidos].filter(Boolean).join(' ')||null:null,'episode.date':local};
 }
 async function normalize({input,previous,row,transaction,final=false}){
  const retained=previous?.version===1?clone(previous):{version:1,instances:[],reference_applications:[]};
  if(input===undefined){if(final)for(const instance of retained.instances){F.answers(instance.definition_snapshot,instance.answers,{final:true});F.repeatedAnswers(instance.definition_snapshot,instance.repetitions,{final:true});}return previous==null?null:retained;}
  if(!F.object(input)||input.version!==1||!Array.isArray(input.instances)||input.instances.length>12||Object.keys(input).some(key=>!['version','instances'].includes(key)))throw F.invalid();
  const ids=new Set(),instances=[];let context;
  for(const value of input.instances){
   if(!F.object(value)||typeof value.id!=='string'||!UUID.test(value.id)||ids.has(value.id)||Object.keys(value).some(key=>!['id','template_ref','answers','repetitions'].includes(key)))throw F.invalid();ids.add(value.id);
   if(!F.object(value.template_ref)||typeof value.template_ref.id!=='string'||Object.keys(value.template_ref).some(key=>!['id','version'].includes(key)))throw F.invalid();
   const ref={id:value.template_ref.id,version:C.integer(value.template_ref.version,'version')},old=retained.instances.find(instance=>instance.id===value.id);
   if(old&&(old.template_ref.id!==ref.id||old.template_ref.version!==ref.version))throw C.error(409,'clinical_form_definition_changed','Conserva el formulario existente y añade el nuevo como otro bloque.');
   const definition=old?.definition_snapshot||F.schema((await templates.resolveReference(ref,Number(row.clinic_id),transaction)).form_schema);
   if(!definition)throw F.invalid('Esta plantilla no contiene un formulario estructurado.');
   const normalizedAnswers=F.answers(definition,value.answers,{final});
   const repetitions=F.repeatedAnswers(definition,value.repetitions,{final});
   context??=old?.context_snapshot?undefined:await contextSnapshot(row,transaction);
   instances.push({id:value.id,template_ref:ref,definition_snapshot:clone(definition),definition_sha256:C.hash(definition),context_snapshot:clone(old?.context_snapshot||context||{}),answers:normalizedAnswers,...(repetitions?{repetitions}:{})});
  }
  const output={version:1,instances,reference_applications:retained.reference_applications||[]};
  if(Buffer.byteLength(JSON.stringify(output))>1000000)throw C.error(413,'clinical_form_too_large','El conjunto de formularios es demasiado extenso.');
  return output;
 }
 async function applyReference({input,data,row,actorId,transaction,idempotencyKey,nextVersion}){
  if(input===undefined)return data;
  C.idempotencyKey(idempotencyKey,true);
  if(!F.object(input)||Object.keys(input).some(key=>!['changes','expected_values','source_form_ids'].includes(key))||!Array.isArray(input.source_form_ids)||!input.source_form_ids.length||new Set(input.source_form_ids).size!==input.source_form_ids.length)throw F.invalid('Selecciona los formularios de origen de la actualización.');
  const sources=input.source_form_ids.map(id=>data?.instances?.find(instance=>instance.id===id));
  if(sources.some(source=>!source||!F.hasContent({instances:[source]})))throw F.invalid('El formulario de origen no contiene respuestas guardadas.');
  if(!F.object(input.changes)||Object.keys(input.changes).some(target=>!sources.some(source=>F.answeredFields(source).some(({field})=>field.reference_target===target))))throw F.invalid('Selecciona respuestas de origen para los datos que quieres actualizar.');
  const result=await reference.applyInTransaction({patientIdentifier:row.patient_id,clinicId:Number(row.clinic_id),actorId,payload:{changes:input.changes,expected_values:input.expected_values},transaction});
  const receipt={id:crypto.randomUUID(),applied_at:now().toISOString(),actor_id:Number(actorId),episode_version:nextVersion||Number(row.version_number||0)+1,
   sources:sources.map(source=>({id:source.id,template_ref:source.template_ref,definition_sha256:source.definition_sha256,answers_sha256:C.hash(source.definition_snapshot.version===2?{answers:source.answers,repetitions:source.repetitions}:source.answers)})),
   previous:result.previous,changes:clone(input.changes),after:Object.fromEntries(Object.keys(input.changes).map(field=>[field,result.item[field]])),updated:result.updated};
  return{...data,reference_applications:[...(data.reference_applications||[]),receipt]};
 }
 return{normalize,applyReference};
}
module.exports={createClinicalEpisodeFormsService};
