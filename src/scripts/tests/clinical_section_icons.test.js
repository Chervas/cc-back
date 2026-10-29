'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../../lib/clinical-episode-contract'),T=require('../../lib/clinical-template-contract'),F=require('../../lib/clinical-form-contract'),K=require('../../lib/clinical-template-catalog-contract');
const {SECTION_ICON_KEYS}=require('../../lib/clinical-section-icons');
const {createClinicalEpisodeTemplateService}=require('../../services/clinicalEpisodeTemplates.service');
const {createClinicalEpisodeFormsService}=require('../../services/clinicalEpisodeForms.service');
const form=()=>({version:1,key:'clinical_questions',title:'Preguntas de consulta',kind:'standard',sections:[{id:'medical_history',title:'Antecedentes',fields:[{id:'notes',label:'Antecedentes',type:'textarea'}]}]});
const definition=()=>({...T.builtin('estetica'),title:'Plantilla sintética para iconos',form_schema:form()});

test('only bundled icon keys are accepted on narrative and question sections; markup, namespaces and arbitrary values cannot enter snapshots',()=>{
 for(const icon of SECTION_ICON_KEYS){
  const value=definition();value.fields[0].icon=icon;value.form_schema.sections[0].icon=icon;
  const normalized=T.definition(value);
  assert.equal(normalized.fields[0].icon,icon);assert.equal(normalized.form_schema.sections[0].icon,icon);
  assert.equal(F.schema(normalized.form_schema).sections[0].icon,icon);
 }
 for(const icon of ['','<svg onload=alert(1)>','heroicons_outline:heart','Heart','heart ','https://example.test/icon.svg','unknown-icon','constructor',42,{},[]]){
  const value=definition();value.fields[0].icon=icon;
  assert.throws(()=>T.definition(value),{code:'clinical_template_invalid_fields'});
  const questions=form();questions.sections[0].icon=icon;
  assert.throws(()=>F.schema(questions),{code:'clinical_form_invalid'});
 }
});

test('optional icon metadata preserves old definitions byte-for-byte and null or omitted values choose the default',()=>{
 const old=definition(),oldHash=C.hash(old),normalized=T.definition(old);
 assert(!normalized.fields.some(field=>Object.hasOwn(field,'icon')));
 assert(!normalized.form_schema.sections.some(section=>Object.hasOwn(section,'icon')));
 const unset=structuredClone(old);unset.fields[0].icon=null;unset.form_schema.sections[0].icon=null;
 assert.deepEqual(T.definition(unset),normalized);assert.equal(C.hash(old),oldHash);
 assert.deepEqual(F.schema({...form(),version:2}),{...F.schema(form()),version:2});
 const catalog=K.definition({definition:{...old,fields:old.fields.map((field,index)=>({...field,...(!index?{icon:'heart'}:{})})),form_schema:{...form(),sections:form().sections.map(section=>({...section,icon:'beaker'}))}},kind:'standard',all_medical_areas:true,medical_area_codes:[]});
 assert.equal(catalog.definition.fields[0].icon,'heart');assert.equal(catalog.definition.form_schema.sections[0].icon,'beaker');
});

function store(){
 let row;const versions=new Map();const transaction={LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}};
 const db={sequelize:{transaction:async work=>work(transaction)},Clinica:{findByPk:async()=>({id_clinica:72})},
  ClinicalEpisodeTemplate:{findOne:async({where})=>where.creation_key?null:row,create:async values=>{row={id:1,...values,async update(values){Object.assign(this,values);}};return row;}},
  ClinicalEpisodeTemplateVersion:{create:async values=>{const revision=structuredClone(values);versions.set(values.version_number,revision);return revision;},findOne:async({where})=>versions.get(where.version_number)},
 };
 return{service:createClinicalEpisodeTemplateService({db}),versions};
}

test('creating and editing a template persists icon changes as immutable versions while old references retain their original icons',async()=>{
 const {service,versions}=store(),payload=definition();payload.fields[0].icon='heart';payload.form_schema.sections[0].icon='beaker';
 const created=await service.create({clinicId:72,actorId:7,payload:{...payload,expected_version:0,idempotency_key:'section-icons-create-v1'}});
 const oldSnapshot=structuredClone(versions.get(1)),next=structuredClone(payload);next.fields[0].icon='camera';next.form_schema.sections[0].icon='shield-check';
 const saved=await service.save({id:created.item.id,clinicId:72,actorId:7,payload:{...next,expected_version:1}});
 assert.equal(saved.item.version,2);assert.equal(saved.item.fields[0].icon,'camera');assert.equal(saved.item.form_schema.sections[0].icon,'shield-check');
 const historical=(await service.get({id:created.item.id,clinicId:72,version:1})).item;
 assert.equal(historical.fields[0].icon,'heart');assert.equal(historical.form_schema.sections[0].icon,'beaker');
 assert.deepEqual(versions.get(1),oldSnapshot);assert.equal(versions.get(1).sha256,C.hash(versions.get(1).snapshot));
 assert.equal((await service.resolveReference({id:created.item.id,version:1},72)).fields[0].icon,'heart');
 const cleared=structuredClone(next);delete cleared.fields[0].icon;cleared.form_schema.sections[0].icon=null;
 const clearedResult=await service.save({id:created.item.id,clinicId:72,actorId:7,payload:{...cleared,expected_version:2}});
 assert.equal(clearedResult.item.version,3);assert(!Object.hasOwn(clearedResult.item.fields[0],'icon'));assert(!Object.hasOwn(clearedResult.item.form_schema.sections[0],'icon'));
 assert.equal((await service.get({id:created.item.id,clinicId:72,version:2})).item.fields[0].icon,'camera');
});

test('episode form normalization keeps the exact pinned icon snapshot and never mutates the existing definition or its hash',async()=>{
 const schema=form();schema.sections[0].icon='heart';const id='c38f54ef-052b-44fd-8c47-e8a3bf3d4453',previous={version:1,instances:[{id,template_ref:{id:'original-template',version:1},definition_snapshot:schema,definition_sha256:C.hash(schema),context_snapshot:{},answers:{notes:'Dato anterior'}}]};
 const before=structuredClone(previous),result=await createClinicalEpisodeFormsService({db:{}}).normalize({input:{version:1,instances:[{id,template_ref:{id:'original-template',version:1},answers:{notes:'Revisión'}}]},previous,row:{patient_id:1,clinic_id:72,version_number:2}});
 assert.equal(result.instances[0].definition_snapshot.sections[0].icon,'heart');assert.equal(result.instances[0].definition_sha256,before.instances[0].definition_sha256);assert.deepEqual(previous,before);
 const legacy=structuredClone(previous);delete legacy.instances[0].definition_snapshot.sections[0].icon;legacy.instances[0].definition_sha256=C.hash(legacy.instances[0].definition_snapshot);
 const normalized=await createClinicalEpisodeFormsService({db:{}}).normalize({input:undefined,previous:legacy,row:{},final:false});assert.deepEqual(normalized,legacy);
});
