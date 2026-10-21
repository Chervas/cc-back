'use strict';
require('./fixtures/campaign_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../../lib/clinical-form-contract'),T=require('../../lib/clinical-template-contract');
const field=(id,type,extra={})=>({id,label:id,type,...extra});
const schema=fields=>F.schema({version:1,key:'test',title:'Prueba',sections:[{id:'main',title:'Campos',fields}]});
test('four manual Word forms retain their distinct field inventory and informational consent/screening metadata',()=>{
 const expected={'initial-general':['general','initial',49],facial:['estetica','standard',45],corporal:['estetica','standard',54],hair:['capilar','standard',48]};
 for(const [key,[area,kind,count]]of Object.entries(expected)){
  const value=T.builtin(key);assert.equal(value.area_key,area);assert.equal(value.form_schema.kind,kind);const fields=value.form_schema.sections.flatMap(s=>s.fields);assert.equal(fields.length,count);
  assert.equal(value.fields.length,8);assert(fields.some(f=>f.id==='photo_consent_status'&&f.help.includes('Consentimientos')));assert(value.form_schema.sections.find(s=>s.id==='screening').description.includes('Revisa el cribado'));
  assert.deepEqual(F.answers(value.form_schema,{}),Object.fromEntries(fields.filter(f=>f.type!=='readonly').map(f=>[f.id,null])));
 }
 assert(T.builtin('initial-general').form_schema.sections.flatMap(s=>s.fields).some(f=>f.options?.some(o=>o.value==='none'&&o.exclusive)));
});
test('corporal retains the source skin-lesion screening question without changing general or facial infection wording',()=>{
 const question=key=>T.builtin(key).form_schema.sections.find(s=>s.id==='screening').fields.find(f=>f.id==='infection');
 assert.equal(question('corporal').label,'¿Infección, herida o lesión en la piel de la zona?');
 for(const key of ['initial-general','facial'])assert.equal(question(key).label,'¿Tiene hoy infección, herida o herpes activo en la zona?');
 assert.equal(question('corporal').type,'yesno');assert.equal(question('corporal').required,false);
});
test('unknown, no and unanswered remain distinct, with no medical defaults; required fields permit draft but reject final',()=>{
 const definition=schema([field('question','yesno',{required:true})]);
 assert.equal(F.answers(definition,{}).question,null);assert.equal(F.answers(definition,{question:'no'}).question,'no');assert.equal(F.answers(definition,{question:'unknown'},{final:true}).question,'unknown');
 assert.throws(()=>F.answers(definition,{}, {final:true}),{code:'clinical_form_required'});
 for(const value of [false,0,'false','0'])assert.throws(()=>F.answers(definition,{question:value}),{code:'clinical_form_invalid'});
});
test('multiselect exclusivity, option identity and order reject contradictory or invented answers',()=>{
 const definition=schema([field('conditions','multiselect',{options:[{value:'none',label:'Ninguna',exclusive:true},{value:'one',label:'Primera'},{value:'two',label:'Segunda'}]})]);
 assert.deepEqual(F.answers(definition,{conditions:['two','one']}).conditions,['one','two']);
 for(const value of [['none','one'],['one','one'],['other'],[{}]])assert.throws(()=>F.answers(definition,{conditions:value}),{code:'clinical_form_invalid'});
});
test('numbers are numeric with units/bounds, dates cannot roll over and context identities cannot be answered',()=>{
 const definition=schema([field('weight','number',{min:0,max:500,unit:'kg'}),field('date','date'),field('name','readonly',{context_key:'patient.full_name'}),field('notes','text',{max_length:3})]);
 assert.equal(F.answers(definition,{weight:0,date:'2024-02-29',notes:'Sí'}).weight,0);
 for(const answers of [{weight:'82'},{weight:-1},{weight:NaN},{date:'2026-02-29'},{date:'2026-04-31'},{name:'Caller identity'},{notes:'1234'},{unknown:'Data'}])assert.throws(()=>F.answers(definition,answers));
});
test('field keys, versions, context, types and mappings have a bounded safe vocabulary',()=>{
 for(const entry of [field('constructor','text'),field('duplicate','text',{context_key:'patient.full_name'}),field('x','readonly',{context_key:'patient.arbitrary'}),field('x','html'),field('x','text',{reference_target:'diagnosis'}),field('x','number',{min:10,max:1})])assert.throws(()=>schema([entry]));
 assert.throws(()=>schema([field('same','text'),field('same','text')]));assert.throws(()=>F.schema({version:2,key:'x',title:'No',sections:[]}));
});
test('template edits retain old schema compatibility, eight canonical narratives and safe rich document',()=>{
 const old=T.builtin('general');assert.equal(Object.hasOwn(old,'form_schema'),false);
 const form=T.definition(T.builtin('facial'));assert.equal(form.form_schema.key,'facial');assert.equal(form.fields.length,8);
 assert.deepEqual(T.definition({...old,form_schema:null}).form_schema,null);
 const invalid=structuredClone(form);invalid.form_schema.sections[0].fields[0].context_key='invented';assert.throws(()=>T.definition(invalid));
});
test('atomic reference receipt exposes only acknowledged canonical fields, preserving previous values, review text, update boolean and pinned sources',async()=>{
 const C=require('../../lib/clinical-episode-contract');
 const definition=schema([field('allergies','textarea',{reference_target:'alergias'})]);
 const source={id:'00000000-0000-4000-8000-000000000001',template_ref:{id:'retained-template',version:1},definition_snapshot:definition,definition_sha256:C.hash(definition),context_snapshot:{},answers:{allergies:'Dato revisado'}};
 const patient={id_paciente:11,clinica_id:72,alergias:null,medicacion:'Otro campo conservado',antecedentes:null,notas_medicas:null,
  async update(values){Object.assign(this,values);this.alergias=values.alergias+' (canónico)';}};
 const service=require('../../services/clinicalEpisodeForms.service').createClinicalEpisodeFormsService({db:{Paciente:{findOne:async()=>patient}},canAccess:async()=>true,now:()=>new Date('2026-10-21T12:00:00Z')});
 const data=await service.applyReference({input:{changes:{alergias:'Dato revisado'},expected_values:{alergias:null},source_form_ids:[source.id]},data:{version:1,instances:[source],reference_applications:[]},row:{patient_id:11,clinic_id:72,version_number:2},actorId:7,transaction:{LOCK:{UPDATE:'UPDATE'}},idempotencyKey:'receipt-after-test'});
 const receipt=data.reference_applications[0];
 assert.deepEqual(receipt.after,{alergias:'Dato revisado (canónico)'});assert.deepEqual(receipt.previous,{alergias:null});assert.deepEqual(receipt.changes,{alergias:'Dato revisado'});assert.equal(receipt.updated,true);assert.equal(receipt.episode_version,3);
 assert.equal(Object.hasOwn(receipt.after,'medicacion'),false);assert.equal(patient.medicacion,'Otro campo conservado');assert.equal(receipt.sources[0].definition_sha256,source.definition_sha256);assert.equal(receipt.sources[0].answers_sha256,C.hash(source.answers));
});
