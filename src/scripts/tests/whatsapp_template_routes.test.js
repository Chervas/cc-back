'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const express=require('express');
test('template routes reach existing ACL handlers; legacy writes remain quarantined',async t=>{
 const calls=[];const controller=new Proxy({}, {get:(_,name)=>(req,res)=>{calls.push(name);res.json({handler:name});}});
 const modules={express,'./auth.middleware':(req,res,next)=>req.headers['x-synthetic-user']==='admin'?next():res.sendStatus(401),
 '../controllers/whatsapp.controller':controller,'../lib/metaQuarantineHttp':{middleware:(_req,res)=>res.sendStatus(503)}};
 const context={module:{exports:{}},require:n=>{assert(Object.hasOwn(modules,n),n);return modules[n];}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../routes/whatsapp.routes.js'),'utf8'),context);
 const app=express();app.use(context.module.exports);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+server.address().port;
 for(const [method,url] of [['POST','/templates/custom'],['POST','/templates/sync'],['POST','/templates/create-from-catalog'],['DELETE','/templates/123'],['POST','/template-catalog'],['PUT','/template-catalog/123'],['POST','/template-catalog/123/propagate']]){
  assert.equal((await fetch(origin+url,{method})).status,401);
  assert.equal((await fetch(origin+url,{method,headers:{'x-synthetic-user':'admin'}})).status,200,url);
 }
 for(const url of ['/messages','/phones/123/register','/preverified/start','/template-catalog/language-rollout'])assert.equal((await fetch(origin+url,{method:'POST',headers:{'x-synthetic-user':'admin'}})).status,503,url);
 assert.equal(calls.length,7);
});
