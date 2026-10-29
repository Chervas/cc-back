'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const F=require('../../lib/clinical-form-contract'),C=require('../../lib/clinical-episode-contract');
const {createClinicalEpisodeFormsService}=require('../../services/clinicalEpisodeForms.service');
const definition=()=>F.schema({version:2,key:'facial_repeat',title:'Anamnesis facial',sections:[
 {id:'history',title:'Antecedentes',fields:[{id:'history',label:'Antecedentes',type:'textarea'}]},
 {id:'treatments',title:'Tratamientos',repeatable:{item_label:'Tratamiento',add_label:'Añadir tratamiento'},fields:[
  {id:'date',label:'Fecha',type:'date',required:true},{id:'quantity',label:'Cantidad',type:'number',min:0,max:100},
  {id:'product',label:'Producto',type:'select',options:[{value:'a',label:'A'},{value:'b',label:'B'}]},
  {id:'zones',label:'Zonas',type:'multiselect',options:[{value:'none',label:'Ninguna',exclusive:true},{value:'other',label:'Otra'}]},
  {id:'notes',label:'Observaciones',type:'textarea',max_length:100,reference_target:'notas_medicas'},
 ]},
]});
const item=(answers={})=>({id:crypto.randomUUID(),answers});
const valid=()=>({treatments:[item({date:'2026-10-29',quantity:0,product:'a',zones:['other'],notes:'Primera valoración'}),item({date:'2026-11-12',quantity:2,product:'b',notes:'Revisión'})]});
test('schema v2 defines a group once; v1 remains unchanged and cannot silently accept a repeatable section',()=>{
 const d=definition();assert.equal(d.version,2);assert.equal(d.sections[1].fields.length,5);assert.equal(F.schema(d).sections[1].repeatable.add_label,'Añadir tratamiento');
 const old={version:1,key:'old',title:'Antigua',sections:[{id:'main',title:'Consulta',fields:[{id:'notes',label:'Notas',type:'textarea'}]}]};assert.equal(F.schema(old).version,1);assert.deepEqual(F.answers(F.schema(old),{notes:'Se conserva'}),{notes:'Se conserva'});assert.equal(F.repeatedAnswers(F.schema(old),undefined),undefined);
 assert.throws(()=>F.schema({...d,version:1}),{code:'clinical_form_invalid'});
});
test('repeated answers keep independent dates, options and zero values with stable identities when order changes',()=>{
 const d=definition(),input=valid(),normalized=F.repeatedAnswers(d,input,{final:true});assert.equal(normalized.treatments[0].answers.quantity,0);assert.equal(normalized.treatments[1].answers.product,'b');assert.equal(input.treatments[0].id,normalized.treatments[0].id);
 const reverse=F.repeatedAnswers(d,{treatments:[...normalized.treatments].reverse()},{final:true});assert.equal(reverse.treatments[0].id,input.treatments[1].id);assert.equal(reverse.treatments[0].answers.date,'2026-11-12');
 assert.throws(()=>F.answers(d,{date:'2026-10-29'}),{code:'clinical_form_invalid'});
});
test('required questions validate every added record only at close and expose its group and identity',()=>{
 const d=definition(),row=item({});assert.doesNotThrow(()=>F.repeatedAnswers(d,{treatments:[row]}));
 assert.throws(()=>F.repeatedAnswers(d,{treatments:[row]},{final:true}),error=>error.code==='clinical_form_required'&&error.details.field==='date'&&error.details.section==='treatments'&&error.details.repetition_id===row.id);
});
test('malformed dates, unsupported options, contradictory multiselect, text bounds and numeric types are rejected in every row',()=>{
 for(const values of [{date:'2026-02-30'},{quantity:'2'},{quantity:-1},{product:'invented'},{zones:['none','other']},{notes:'x'.repeat(101)}])assert.throws(()=>F.repeatedAnswers(definition(),{treatments:[item(values)]}),error=>error.statusCode===400);
});
test('missing groups, injected metadata, duplicate row identities and bounded expansion cannot be silently saved',()=>{
 const d=definition(),row=item({});assert.throws(()=>F.repeatedAnswers(d,undefined),{code:'clinical_form_repetitions_required'});
 for(const values of [{},{treatments:[]},{treatments:[row,row]},{treatments:[{...row,patient_id:99}]},{treatments:[item({foreign:'value'})]},{treatments:Array.from({length:101},()=>item())},{treatments:[row],other:[]}])assert.throws(()=>F.repeatedAnswers(d,values),{code:'clinical_form_invalid'});
 const nested=structuredClone(d);nested.sections[1].fields[0].type='group';assert.throws(()=>F.schema(nested),{code:'clinical_form_invalid'});
});
test('episode normalizer saves pinned v2 groups, reopens the exact snapshot and refuses an old client omitting repetitions',async()=>{
 const d=definition(),id=crypto.randomUUID(),repetitions=valid();const previous={version:1,instances:[{id,template_ref:{id:'original',version:1},definition_snapshot:d,definition_sha256:C.hash(d),context_snapshot:{'patient.full_name':'Paciente ficticio'},answers:{history:'Antecedente'},repetitions}],reference_applications:[]};
 const service=createClinicalEpisodeFormsService({db:{}}),row={patient_id:1,clinic_id:72,version_number:4};
 const payload={version:1,instances:[{id,template_ref:{id:'original',version:1},answers:{history:'Actualizado'},repetitions}]};
 const result=await service.normalize({input:payload,previous,row,final:true});assert.deepEqual(result.instances[0].repetitions,F.repeatedAnswers(d,repetitions,{final:true}));assert.deepEqual(result.instances[0].definition_snapshot,d);assert.equal(result.instances[0].context_snapshot['patient.full_name'],'Paciente ficticio');assert.equal(previous.instances[0].answers.history,'Antecedente');
 assert.deepEqual(await service.normalize({input:undefined,previous:result,row,final:true}),result);
 delete payload.instances[0].repetitions;await assert.rejects(service.normalize({input:payload,previous,row}),{code:'clinical_form_repetitions_required'});assert.equal(previous.instances[0].repetitions.treatments.length,2);
});
test('closing an existing draft without new payload still checks each historical v2 row',async()=>{
 const d=definition(),row=item({}),previous={version:1,instances:[{id:crypto.randomUUID(),definition_snapshot:d,answers:{},repetitions:{treatments:[row]}}]};
 await assert.rejects(createClinicalEpisodeFormsService({db:{}}).normalize({previous,row:{},final:true}),{code:'clinical_form_required'});
});
test('content and reference candidates include only genuinely answered group questions, and audit hashes cover repetitions',async()=>{
 const d=definition(),id=crypto.randomUUID(),source={id,template_ref:{id:'original',version:1},definition_snapshot:d,definition_sha256:C.hash(d),context_snapshot:{},answers:{},repetitions:{treatments:[item({date:'2026-10-29',notes:'Nota elegida'})]}};
 assert(F.hasContent({instances:[source]}));assert.equal(F.answeredFields(source).filter(x=>x.field.reference_target==='notas_medicas')[0].value,'Nota elegida');assert(!F.hasContent({instances:[{...source,repetitions:{treatments:[item({})]}}]}));
 const {Module}=require('node:module'),old=Module._load;Module._load=function(name,parent,...rest){if(name==='./patientClinicalReference.service')return{createPatientClinicalReferenceService:()=>({applyInTransaction:async()=>({previous:{notas_medicas:null},item:{notas_medicas:'Nota elegida'},updated:true})})};return old.call(this,name,parent,...rest);};
 try{const service=createClinicalEpisodeFormsService({db:{}});const result=await service.applyReference({input:{changes:{notas_medicas:'Nota elegida'},expected_values:{notas_medicas:null},source_form_ids:[id]},data:{version:1,instances:[source]},row:{patient_id:1,clinic_id:72,version_number:3},actorId:1,transaction:{},idempotencyKey:'repeated-reference-test'});assert.equal(result.reference_applications[0].sources[0].answers_sha256,C.hash({answers:source.answers,repetitions:source.repetitions}));}finally{Module._load=old;}
});
test('visual alopecia selections retain canonical grades and reject any relabelled, reordered or mismatched catalog',()=>{
 for(const key of Object.keys(F.CHOICE_CATALOGS)){
  const field={id:'grade',label:'Grado',type:'select',choice_catalog:key,options:structuredClone(F.CHOICE_CATALOGS[key])};
  const make=value=>({version:1,key:'scale',title:'Escala',sections:[{id:'main',title:'Valoración',fields:[value]}]});
  assert.equal(F.schema(make(field)).sections[0].fields[0].choice_catalog,key);assert.equal(F.answers(F.schema(make(field)),{grade:field.options[0].value}).grade,field.options[0].value);
  for(const changed of [{...field,type:'text'},{...field,options:[...field.options].reverse()},{...field,options:field.options.map((o,i)=>i?o:{...o,label:'Otro grado'})},{...field,choice_catalog:'constructor'}])assert.throws(()=>F.schema(make(changed)),{code:'clinical_form_invalid'});
 }
});

test('manual and default episode creation seed repeated UUIDs once; reads and identical retries preserve the same saved instance',async()=>{
 const {createClinicalEpisodeService}=require('../../services/clinicalEpisodes.service'),T=require('../../lib/clinical-template-contract'),{Module}=require('node:module');
 for(const useDefault of [false,true]){
  const form=definition(),snapshot={...T.builtin('estetica'),id:'source-template',clinic_id:72,builtin:false,form_schema:form};let stored=null;const revisions=[];
  const patient={id_paciente:1,clinica_id:72,nombre:'Paciente',apellidos:'Ficticio'},professional={id_usuario:7,nombre:'Profesional',apellidos:'Ficticio'};
  const db={
   sequelize:{transaction:async work=>work({LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}})},
   Paciente:{findOne:async()=>patient},Clinica:{findByPk:async()=>({id_clinica:72,configuracion:{}})},
   Usuario:{findByPk:async()=>professional,findAll:async()=>[professional]},
   AppointmentClinicalReport:{rawAttributes:{},findOne:async()=>stored,create:async values=>{stored={...values,id:1,toJSON(){return Object.fromEntries(Object.entries(this).filter(([,value])=>typeof value!=='function'));},async update(values){Object.assign(this,values);return this;}};return stored;}},
   AppointmentClinicalReportRevision:{create:async value=>{revisions.push(structuredClone(value));return value;}},
   ClinicalEpisodeTemplate:{findOne:async()=>({id:1,public_id:'source-template',clinic_id:72,current_version:1})},
   ClinicalEpisodeTemplateVersion:{findOne:async()=>({template_id:1,version_number:1,snapshot,sha256:C.hash(snapshot)})},
  };
  const original=Module._load;Module._load=function(name,parent,...rest){if(name==='../../models')return {};if(name==='./clinicalTemplateDefaults.service')return{createService:()=>({resolveInitial:async()=>({item:{template:snapshot,template_ref:{id:snapshot.id,version:1},preference_id:'preference',preference_version:1,treatment_id:2,scope:'treatment'}})})};return original.call(this,name,parent,...rest);};
  try{
   const service=createClinicalEpisodeService({db,now:()=>new Date('2026-10-29T10:00:00Z')}),payload={expected_version:0,idempotency_key:useDefault?'default-v2-first':'manual-v2-first',title:'Consulta ficticia',occurred_at:'2026-10-29T09:00:00Z',template_ref:{id:snapshot.id,version:1},...(useDefault?{use_template_default:true}:{})};
   const result=await service.create({patientIdentifier:'1',clinicId:72,actorId:7,payload}),saved=result.item.form_data.instances[0],firstId=saved.repetitions.treatments[0].id;
   assert.equal(saved.repetitions.treatments.length,1);assert.deepEqual(saved.repetitions.treatments[0].answers,{date:null,quantity:null,product:null,zones:null,notes:null});assert.equal(revisions[0].snapshot.form_data.instances[0].repetitions.treatments[0].id,firstId);
   assert.equal((await service.get({id:result.item.id,clinicId:72})).item.form_data.instances[0].repetitions.treatments[0].id,firstId);
   const replay=await service.create({patientIdentifier:'1',clinicId:72,actorId:7,payload});assert.equal(replay.replayed,true);assert.equal(replay.item.form_data.instances[0].id,saved.id);assert.equal(replay.item.form_data.instances[0].repetitions.treatments[0].id,firstId);assert.equal(revisions.length,1);
  }finally{Module._load=original;}
 }
});
