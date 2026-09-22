'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('./whatsapp-authorized-fixture.cjs');
const M=require('../src/whatsapp-template-management');
const payload={authorizationId:'11111111-1111-4111-8111-111111111111',phoneId:'401',wabaId:'301'};
const media=require('../src/whatsapp-template-media');
test('media rejects loopback, metadata, private, mapped and multicast destinations',async()=>{
  for(const address of ['127.0.0.1','169.254.169.254','10.0.0.1','172.16.1.1','192.168.1.2','100.64.1.1','::1','::ffff:127.0.0.1','fd00::1','fe80::1','ff02::1'])assert.equal(media.publicAddress(address),false,address);
  assert.equal(media.publicAddress('8.8.8.8'),true);
  for(const url of ['http://example.com/a','https://user:pass@example.com/a','https://example.com:8443/a','https://example.com/a#b'])assert.throws(()=>media.sourceUrl(url),{code:'invalid_request'});
  const upload=media.createTemplateMedia({lookup:async()=>[{address:'169.254.169.254',family:4}],request:()=>{throw Error('Network must not be reached');}});
  await assert.rejects(upload({source:'https://example.invalid/image.png',assertActive:()=>{}}),{code:'invalid_request'});
});
test('list/create/delete preserve normal Meta status with no catalog allowlist and enforce WABA scope',async t=>{
  const a=await fixture(t);const seen=[];
  const ops=M.operations({secrets:a.secrets,registry:a.registry,http:async request=>{
    seen.push({action:request.action,id:request.id});
    if(request.action==='templates_list')return {data:[{id:'901',name:'new_custom_template',language:'es',status:'PENDING'}]};
    if(request.action==='templates_create')return {id:'901',status:'PENDING'};
    return {success:true};
  }});
  const base={authorizationId:a.definition.authorizationId,phoneId:'401',wabaId:'301'};
  for(const [operation,extra] of [[M.LIST,{}],[M.CREATE,{template:{name:'new_custom_template',language:'es',category:'UTILITY',components:[{type:'BODY',text:'Synthetic QA'}]}}],[M.REMOVE,{name:'new_custom_template',templateId:'901'}]]) {
    const p={...base,...extra};M.validate(operation,p);
    const result=await a.secrets.withSecret(a.binding,secret=>ops[operation].execute({payload:p,binding:a.binding,secret,assertActive:()=>{}}));
    assert(ops[operation].project(result));
  }
  assert.deepEqual(seen.map(c=>c.action),['templates_list','templates_create','templates_delete']);
  assert(seen.every(c=>c.id==='301'));
});
test('template operations reject credential injection, foreign HTTP routes and malformed pagination',()=>{
  for(const p of [{...payload,access_token:'no'},{...payload,url:'https://other.invalid'},{...payload,after:'https://other.invalid'}])assert.throws(()=>M.validate(M.LIST,p),{code:'invalid_request'});
  assert.throws(()=>M.validate(M.REMOVE,{...payload,name:'good',templateId:'../../me'}),{code:'invalid_request'});
});
test('template results never expose provider paging URLs or fields outside the catalog',()=>{
  const result=M.project(M.LIST,{data:[{id:'111',name:'hello',language:'es',status:'APPROVED',access_token:'SECRET'}],paging:{next:'https://graph.facebook.com/?access_token=SECRET',cursors:{after:'cursor_2'}}});
  assert(!JSON.stringify(result).includes('SECRET'));assert.equal(result.after,'cursor_2');
  assert.deepEqual(M.project(M.CREATE,{id:'111',status:'PENDING',access_token:'SECRET'}),{id:'111',status:'PENDING'});
});
test('management cannot act on another WABA even with a selected phone',async t=>{
  const a=await fixture(t);let calls=0;
  const ops=M.operations({http:async()=>{calls++;},secrets:a.secrets,registry:a.registry});
  // Exercise the operation independently of policy: the selected WABA is an
  // additional boundary beyond the clinic/phone grant.
  await assert.rejects(ops[M.LIST].execute({payload:{...payload,wabaId:'999'},binding:a.binding,assertActive:()=>{}}),{code:'scope_denied'});
  assert.equal(calls,0);
});

test('header upload pins public DNS and never passes Graph credentials to the image host',async()=>{
  const {EventEmitter}=require('node:events');const calls=[];
  const request=(url,options,callback)=>{
    calls.push({url:new URL(url),options});const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};callback(res);
      const data=calls.length===1?Buffer.from([137,80,78,71,13,10,26,10,1,2,3]):Buffer.from(JSON.stringify(calls.length===2?{id:'upload:synthetic?sig=qa'}:{h:'synthetic-handle'}));
      res.emit('data',data);res.emit('end');});return req;
  };
  const upload=media.createTemplateMedia({request,lookup:async()=>[{address:'8.8.8.8',family:4}]});
  const result=await upload({source:'https://media.example.invalid/image.png',appId:'123',token:Buffer.from('SYNTHETIC_TOKEN'),proof:'a'.repeat(64),assertActive:()=>{}});
  assert.equal(result.handle,'synthetic-handle');assert.equal(calls.length,3);
  assert.deepEqual(calls[0].options.headers,{'user-agent':'Clinicaclick-Template-Media/1.0'});assert.equal(typeof calls[0].options.lookup,'function');
  assert(calls.slice(1).every(c=>c.url.hostname==='graph.facebook.com'&&c.options.headers.authorization==='OAuth SYNTHETIC_TOKEN'));
  assert(calls.slice(1).every(c=>c.url.searchParams.get('appsecret_proof')==='a'.repeat(64)));
});

test('signed template mutation requires an explicit clinic grant and deduplicates retries',async t=>{
  const a=await fixture(t);const {Broker}=require('../src/broker');const {BrokerStore}=require('../src/store');const {signRequest}=require('../src/auth');
  const store=new BrokerStore(require('node:path').join(a.f.dir,'template-operations.sqlite'));t.after(()=>store.close());
  const policy=structuredClone(a.policy);for(const g of policy.grants)if(g.principalId==='staging:whatsapp')g.operations.push(...M.OPERATIONS);
  let calls=0;const broker=new Broker({store,policy,secrets:a.secrets,operations:M.operations({registry:a.registry,secrets:a.secrets,http:async()=>{calls++;return{id:'901',status:'PENDING'};}}),now:a.f.now});
  const value=a.request(undefined,{operation:M.CREATE,payload:{authorizationId:a.definition.authorizationId,phoneId:'401',wabaId:'301',template:{name:'fresh',language:'es',category:'UTILITY',components:[{type:'BODY',text:'Fictitious'}]}}});
  const execute=async v=>{const signed=signRequest(v,{keyId:'qa-staging',privateKey:a.f.gateway.privateKey,audience:policy.audience,now:a.f.now()});return broker.execute(signed.raw,signed.headers);};
  assert.equal((await execute(value)).data.status,'PENDING');assert.equal((await execute(value)).replayed,true);assert.equal(calls,1);
  await assert.rejects(execute({...value,requestId:require('node:crypto').randomUUID(),tenantRef:'clinic:999'}),{code:'scope_denied'});
  assert.equal(calls,1);
});
