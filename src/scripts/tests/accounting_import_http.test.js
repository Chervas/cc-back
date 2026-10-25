'use strict';
// Production controller/router on a disposable loopback server. Identity is a
// test-only fixture; no application session or credential is issued or reused.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const {createRequire} = require('node:module');
const express = require('express');
function load(file, overrides) {
  const local=createRequire(file),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)},{filename:file});
  return module.exports;
}
test('native import HTTP routes enforce authentication, JSON shape, clinic and separate financial/payroll privileges',async t=>{
  const calls=[],allowed=new Set(['accounting.ocr.manage','accounting.expenses.manage','accounting.payroll.manage']);
  const accounting={domainError:(statusCode,code,message)=>Object.assign(Error(message),{statusCode,code})};
  const ingestion={kind:async({publicId})=>publicId==='payroll-job'?'payroll':'expense',
    enqueue:async input=>{calls.push(['enqueue',input]);return{id:'job',status:'queued'};},
    process:async input=>{calls.push(['process',input]);return{id:'job',status:'review'};},
    accept:async input=>{calls.push(['accept',input]);return{job:{id:'job',status:'accepted'}};},
    employees:async clinicId=>{calls.push(['employees',clinicId]);return[{id:5,name:'Persona ficticia QA'}];}};
  const controller=load(require.resolve('../../controllers/accounting.controller'),{
    '../services/accounting.service':accounting,'../services/accountingIngestion.service':ingestion,
    '../services/accountingFirms.service':{isPortalUser:async({actorId})=>actorId===90},
    '../services/accountingSepa.service':{},'../services/accountingExport.service':{},
    '../lib/access-policy':{canUserAccessFeature:async({actorId,clinicId,featureKey})=>actorId===5&&clinicId===72&&allowed.has(featureKey)},
  });
  const router=load(require.resolve('../../routes/accounting.routes'),{'../controllers/accounting.controller':controller,
    './auth.middleware':(req,res,next)=>{if(req.headers['x-test-actor'])req.userData={userId:Number(req.headers['x-test-actor'])};else return res.status(401).json({error:'fixture_unauthenticated'});next();}});
  const app=express();app.use(express.json());app.use(router);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(route,body,headers={})=>fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:body===undefined?'GET':'POST',headers:{'x-test-actor':'5','content-type':'application/json',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  assert.equal((await request('/ingestion',{clinic_id:72},{'x-test-actor':''})).status,401);
  assert.equal((await request('/ingestion',{clinic_id:73})).status,403);
  assert.equal((await request('/ingestion?clinic_id=72','--not-a-file',{'content-type':'multipart/form-data; boundary=test'})).status,415);
  assert.equal((await request('/ingestion','{"bad":')).status,400);
  assert.equal(calls.length,0);
  allowed.delete('accounting.expenses.manage');
  assert.equal((await request('/ingestion/expense-job/accept',{clinic_id:72})).status,403);
  allowed.delete('accounting.payroll.manage');
  assert.equal((await request('/ingestion',{clinic_id:72,document_kind:'payroll'})).status,403);
  assert.equal((await request('/ingestion',{clinic_id:72,document_kind:' PAYROLL '})).status,403);
  assert.equal((await request('/ingestion/payroll-job/process',{clinic_id:72,document_kind:'expense',mode:'local'})).status,403);
  assert.equal((await request('/payroll-employees?clinic_id=72')).status,403);
  assert.equal(calls.length,0);
  allowed.add('accounting.payroll.manage');allowed.add('accounting.expenses.manage');
  const process=await request('/ingestion/payroll-job/process',{clinic_id:72,mode:'local'});
  assert.equal(process.status,200);assert.equal(calls[0][1].mode,'local');assert.equal(calls[0][1].clinicId,72);
  assert.equal((await request('/ingestion/expense-job/accept',{clinic_id:72})).status,200);
  const people=await request('/payroll-employees?clinic_id=72');assert.equal(people.status,200);assert.deepEqual((await people.json()).items,[{id:5,name:'Persona ficticia QA'}]);
  assert.equal((await request('/ingestion',{clinic_id:72},{'x-test-actor':'90'})).status,403);
  assert.equal(process.headers.get('cache-control'),'private, no-store');
});
