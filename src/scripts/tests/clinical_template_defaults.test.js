'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createController}=require('../../controllers/clinicalTemplateDefaults.controller');
const {createService}=require('../../services/clinicalTemplateDefaults.service');
const response=()=>({code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(value){this.body=value;return this;}});
const request=patch=>({userData:{userId:7},params:{id:'2',patientId:'synthetic'},query:{clinic_id:'72'},body:{},...patch});
test('default configuration and patient resolution enforce canonical permissions before querying',async()=>{
 for(const [method,feature] of [['list','clinical.reports.view'],['treatments','clinical.reports.view'],['save','clinic.settings.edit'],['resolve','patients.sensitive.view']]){
  const calls=[],service=createService({db:{},canAccess:async input=>{calls.push(input);return input.featureKey!==feature;}});
  await assert.rejects(service[method]({actorId:7,clinicId:72,treatmentId:2,payload:{}}),{code:'access_policy_forbidden'});
  assert(calls.every(row=>row.clinicId===72&&row.actorId===7));assert(!calls.some(row=>row.featureKey.startsWith('appointments.')));
 }
});
test('configuration requires explicit boolean/CAS/key and rejects untrusted readonly fields before a transaction',async()=>{
 const service=createService({db:{},canAccess:async()=>true});
 const good={enabled:true,expected_version:0,idempotency_key:'owned-preference-key',template_ref:{id:'builtin:general',version:1}};
 for(const patch of [{enabled:'true'},{expected_version:undefined},{expected_version:-1},{idempotency_key:'bad'},{template_ref:{id:'other',version:1,title:'client'}},{updated_by:9}])
  await assert.rejects(service.save({actorId:7,clinicId:72,treatmentId:2,payload:{...good,...patch}}),error=>[400,428].includes(error.statusCode));
});
test('default routes propagate exact patient/treatment scope, no-store and authentication without exposing internal errors',async()=>{
 const calls=[],controller=createController({service:Object.fromEntries(['list','treatments','save','resolve'].map(method=>[method,async input=>{calls.push({method,input});return{item:null};}]))});
 for(const name of ['list','treatments','save','resolve']){const res=response();await controller[name](request(),res);assert.equal(res.code,200);assert.equal(res.headers['Cache-Control'],'private, no-store');}
 assert(calls.every(row=>row.input.clinicId===72&&row.input.actorId===7&&row.input.treatmentId==='2'&&row.input.patientIdentifier==='synthetic'));
 const unauthenticated=response();await controller.save(request({userData:null}),unauthenticated);assert.equal(unauthenticated.code,401);assert.equal(calls.length,4);
 const broken=createController({service:{list(){throw Error('PRIVATE_SQL /private/path');}}}),res=response();await broken.list(request(),res);assert.equal(res.code,500);assert(!JSON.stringify(res.body).includes('PRIVATE'));
});
