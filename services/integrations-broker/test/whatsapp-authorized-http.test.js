'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {createWhatsappAuthorizedHttp}=require('../src/whatsapp-authorized-http');const {createWhatsappHttp}=require('../src/whatsapp-http');
const {TOKEN}=require('./whatsapp-onboarding-fixture.cjs');
const message=()=>({messaging_product:'whatsapp',to:'34000000123',type:'interactive',interactive:{type:'cta_url',body:{text:'QA'},action:{name:'cta_url',parameters:{display_text:'Abrir',url:'https://clinic.example.invalid/qa'}}}});
function fixture({status=200,headers={},response={messages:[{id:'wamid.FICTITIOUS_QA'}]}}={}){
  const calls=[];const request=(options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{calls.push({options,body});queueMicrotask(()=>{const res=new PassThrough();res.statusCode=status;res.headers={'content-type':'application/json',...headers};callback(res);res.end(JSON.stringify(response));});};return req;};
  return {calls,request};
}
const input=()=>({action:'send',id:'401',token:Buffer.from(TOKEN),proof:'a'.repeat(64),json:message()});
test('Dedicated authorized transport supports CTA on fixed HTTPS phone/messages; legacy contract stays closed',async()=>{
  const f=fixture();const http=createWhatsappAuthorizedHttp({request:f.request});await http(input());
  const call=f.calls[0];const url=new URL('https://graph.facebook.com'+call.options.path);
  assert.equal(call.options.hostname,'graph.facebook.com');assert.equal(call.options.method,'POST');assert.equal(url.pathname,'/v24.0/401/messages');
  assert.equal(call.options.rejectUnauthorized,true);assert.equal(call.options.agent,false);assert(!url.href.includes(TOKEN));assert.deepEqual(JSON.parse(call.body),message());
  await assert.rejects(createWhatsappHttp({request:f.request})(input()),{code:'invalid_request'});assert.equal(f.calls.length,1);
});
test('Authorized transport refuses arbitrary Graph payloads, endpoints and token overrides before network',async()=>{
  const f=fixture();const http=createWhatsappAuthorizedHttp({request:f.request});
  for(const change of [{url:'https://other.invalid'},{id:'../401'},{action:'create_template'},{json:{...message(),access_token:TOKEN}},
    {json:{...message(),interactive:{...message().interactive,type:'flow'}}}])await assert.rejects(http({...input(),...change}),{code:'invalid_request'});
  assert.equal(f.calls.length,0);
});
for(const setup of [{status:302,headers:{location:'https://other.invalid'}},{headers:{'content-encoding':'gzip'}},{response:{error:{code:190,message:TOKEN}}}])
test('Authorized transport rejects redirect/compression/provider revocation without retry or secret disclosure',async()=>{
  const f=fixture(setup);await assert.rejects(createWhatsappAuthorizedHttp({request:f.request})(input()),e=>!e.stack.includes(TOKEN)&&['provider_failed','credential_revoked'].includes(e.code));assert.equal(f.calls.length,1);
});
