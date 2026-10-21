'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDentalPlansController}=require('../../controllers/dentalPlans.controller');
const response=()=>({code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.code=v;return this;},json(v){this.body=v;return this;}});
const request=patch=>({userData:{userId:7},params:{id:'owned-plan'},query:{clinic_id:'72',patient_id:'100'},body:{},...patch});
test('plan commands preserve the explicitly selected patient while patient workspace uses its URL identity',async()=>{
 const seen=[],plans={get:async input=>{seen.push(input);return{item:{id:input.id}};},workspace:async input=>{seen.push(input);return{plans:[]};}},controller=createDentalPlansController({plans});
 let res=response();await controller.get(request(),res);assert.equal(res.code,200);assert.equal(seen[0].id,'owned-plan');assert.equal(seen[0].patientIdentifier,100);assert.equal(seen[0].clinicId,72);
 res=response();await controller.workspace(request({params:{id:'public-patient-id'}}),res);assert.equal(seen[1].patientIdentifier,'public-patient-id');assert.equal(seen[1].requestedPatientIdentifier,100);
});
test('auth or conflicting patient/clinic selection fails before data access',async()=>{
 let calls=0;const controller=createDentalPlansController({plans:{execution:async()=>{calls++;return{};}}});
 for(const [patch,status]of [[{userData:null},401],[{body:{clinic_id:73}},400],[{body:{patient_id:101}},400],[{query:{clinic_id:'wrong'}},400]]){const res=response();await controller.execution(request(patch),res);assert.equal(res.code,status);assert.equal(calls,0);assert.equal(res.headers['Cache-Control'],'private, no-store');}
});
test('CAS and source failures stay JSON; missing schema and unexpected errors do not expose SQL, paths or clinical values',async()=>{
 for(const [error,code,status]of [[Object.assign(Error('Conflicto'),{code:'dental_version_conflict',statusCode:409,details:{current_version:3}}),'dental_version_conflict',409],[Object.assign(Error('SELECT private secret'),{original:{code:'ER_NO_SUCH_TABLE'}}),'dental_schema_pending',503],[Error('/private/clinical-secret'),'dental_unavailable',500]]){
  const controller=createDentalPlansController({plans:{get:async()=>{throw error;}}}),res=response();await controller.get(request(),res);assert.equal(res.code,status);assert.equal(res.body.error.code,code);assert(!JSON.stringify(res.body).includes('secret'));
 }
});
