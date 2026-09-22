'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {createActivationHttp}=require('../src/whatsapp-activation-http');
test('registration uses fixed Graph phone endpoint and redacts provider errors and PIN buffers',async()=>{
  let settings,body,held;let status=200,response={success:true},content='application/json';
  const http=createActivationHttp({request:(options,callback)=>{settings=options;const req=new EventEmitter();req.destroy=()=>{};
    req.end=value=>{held=value;body=value&&value.toString();queueMicrotask(()=>{const res=new PassThrough();res.statusCode=status;res.headers={'content-type':content};callback(res);res.end(JSON.stringify(response));})};return req;}});
  const input={action:'register_phone',id:'401',token:Buffer.from('FICTITIOUS_TOKEN'),proof:'a'.repeat(64),signal:AbortSignal.timeout(3000),pin:'123456'};
  assert.deepEqual(await http(input),{success:true});assert.equal(settings.hostname,'graph.facebook.com');assert.equal(settings.method,'POST');assert(settings.path.startsWith('/v24.0/401/register?'));
  assert.deepEqual(JSON.parse(body),{messaging_product:'whatsapp',pin:'123456'});assert(held.every(n=>n===0));
  status=400;response={error:{code:133005,message:'FICTITIOUS_SECRET_123456'}};
  await assert.rejects(http(input),e=>e.code==='provider_failed'&&!JSON.stringify(e).includes('123456'));
  status=500;await assert.rejects(http(input),e=>e.code==='provider_failed'&&e.providerRejected===false);
  status=302;await assert.rejects(http(input),/provider_failed/);
  await assert.rejects(http({...input,id:'401/other'}),/invalid_request/);
  await assert.rejects(http({...input,url:'https://else.invalid'}),/invalid_request/);
});

test('slow registration survives the former eight-second deadline while ordinary reads remain bounded',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let reply,closed=false,held;
  const http=createActivationHttp({request:(_options,callback)=>{reply=callback;const req=new EventEmitter();req.destroy=()=>{closed=true;};req.end=v=>{held=v;};return req;}});
  const input={action:'register_phone',id:'401',token:Buffer.from('FICTITIOUS_TOKEN'),proof:'a'.repeat(64),signal:new AbortController().signal,pin:'123456'};
  let settled=false;const pending=http(input).finally(()=>{settled=true;});
  t.mock.timers.tick(45000);await Promise.resolve();assert.equal(settled,false);assert.equal(closed,false);
  const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};reply(res);res.end('{"success":true}');
  assert.deepEqual(await pending,{success:true});assert(held.every(v=>v===0));
  const read=http({action:'profile',id:input.id,token:input.token,proof:input.proof,signal:input.signal});
  const rejected=assert.rejects(read,{code:'provider_timeout'});t.mock.timers.tick(8000);await rejected;assert.equal(closed,true);
});
test('registration still expires at sixty seconds and caller cancellation stops it earlier',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let destroyed=0;const http=createActivationHttp({request:()=>{const req=new EventEmitter();req.destroy=()=>{destroyed++;};req.end=()=>{};return req;}});
  const controller=new AbortController();const input={action:'register_phone',id:'401',token:Buffer.from('FICTITIOUS_TOKEN'),proof:'a'.repeat(64),signal:controller.signal,pin:'123456'};
  const first=assert.rejects(http(input),{code:'provider_timeout'});t.mock.timers.tick(60000);await first;
  const next=assert.rejects(http(input),{code:'provider_timeout'});controller.abort();await next;assert.equal(destroyed,2);
  for(const registrationTimeoutMs of [0,-1,60001,Infinity,'60000'])assert.throws(()=>createActivationHttp({registrationTimeoutMs}),/invalid_request/);
});
