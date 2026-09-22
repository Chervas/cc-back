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
