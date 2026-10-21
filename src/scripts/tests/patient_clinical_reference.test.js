'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPatientClinicalReferenceService:create}=require('../../services/patientClinicalReference.service');
const input={patientIdentifier:'pac_owned',clinicId:72,actorId:7,payload:{expected_medication:null,medicacion:'Referencia ficticia'}};
function fixture({owner=72,member=true,allow=()=>true,current=null}={}){
 const calls=[],patient={id_paciente:9,public_id:'pac_owned',clinica_id:owner,medicacion:current,nombre:'Ficticio',
  async update(patch,options){calls.push({type:'update',patch,options});Object.assign(this,patch);}};
 const tx={LOCK:{UPDATE:'UPDATE'}},db={sequelize:{transaction:fn=>fn(tx)},Paciente:{findOne:async options=>{calls.push({type:'read',options});return patient;}},PacienteClinica:{findOne:async()=>member?{id:1}:null}};
 const service=create({db,canAccess:async ctx=>{calls.push({type:'permission',...ctx});return allow(ctx);}});
 return {service,patient,calls};
}
test('only the intended patient field changes and the loaded value is compared under row lock',async()=>{
 const {service,patient,calls}=fixture();const r=await service.update(input);
 assert.equal(r.item.medicacion,'Referencia ficticia');assert.equal(patient.nombre,'Ficticio');
 assert.deepEqual(calls.find(c=>c.type==='update').patch,{medicacion:'Referencia ficticia'});
 assert.deepEqual(calls.find(c=>c.type==='update').options.fields,['medicacion']);
 assert.equal(calls.find(c=>c.type==='read').options.lock,'UPDATE');
});
test('missing/stale compare values and unknown fields never overwrite medication',async()=>{
 const {service,calls,patient}=fixture({current:'Nueva referencia'});
 await assert.rejects(service.update({...input,payload:{medicacion:'Otra'}}),{statusCode:428});
 await assert.rejects(service.update(input),{code:'clinical_reference_conflict'});
 await assert.rejects(service.update({...input,payload:{...input.payload,clinica_id:73}}),{statusCode:400});
 assert.equal(patient.medicacion,'Nueva referencia');assert(!calls.some(c=>c.type==='update'));
});
test('active and owning clinic permission overrides plus membership fail closed',async()=>{
 for(const config of [{allow:ctx=>ctx.featureKey!=='patients.sensitive.view'},{owner:73,allow:ctx=>ctx.clinicId!==73},{owner:73,member:false}]){
  const {service,calls}=fixture(config);await assert.rejects(service.update(input),error=>[403,404].includes(error.statusCode));assert(!calls.some(c=>c.type==='update'));
 }
});
test('equal value is a no-op and clearing medication is explicit',async()=>{
 const {service,calls}=fixture({current:'Referencia ficticia'});
 const same=await service.update({...input,payload:{expected_medication:'Referencia ficticia',medicacion:'Referencia ficticia'}});assert.equal(same.updated,false);assert(!calls.some(c=>c.type==='update'));
 const clear=await service.update({...input,payload:{expected_medication:'Referencia ficticia',medicacion:null}});assert.equal(clear.item.medicacion,null);
});
test('HTTP errors remain private safe JSON without SQL, paths or other patient content',async()=>{
 const {createPatientClinicalReferenceController}=require('../../controllers/patientClinicalReference.controller');
 const controller=createPatientClinicalReferenceController({service:{update:async()=>{throw Object.assign(Error('SQL private path'),{original:{code:'ER_FAIL'}});}}});
 const response={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
 await controller.update({params:{id:'pac_owned'},query:{clinic_id:72},body:input.payload,userData:{userId:7}},response);
 assert.equal(response.statusCode,500);assert.match(response.headers['Cache-Control'],/no-store/);assert(!JSON.stringify(response.body).includes('SQL'));
});
