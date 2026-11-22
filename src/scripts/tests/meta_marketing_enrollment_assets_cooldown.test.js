'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {EventEmitter}=require('node:events'),{generateKeyPairSync,randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
global.fetch=()=>{throw Error('OFFLINE_PROVIDER_FORBIDDEN');};
const OPERATION='meta.marketing.enrollment.assets.v1',CANARY='FICTITIOUS_PRIVATE_DETAIL';
const {privateKey}=generateKeyPairSync('ed25519');
const privateKeyPem=privateKey.export({type:'pkcs8',format:'pem'});
function fixture({value={error:{code:'rate_limited',retryAfterMs:5001}},status=429,headers={}}={}){
 const calls=[];
 const source=path.resolve(__dirname,'../../lib/integrationsBrokerClient.js'),loaded=new Module(source,module);
 loaded.filename=source;loaded.paths=Module._nodeModulePaths(path.dirname(source));const actual=loaded.require.bind(loaded);
 loaded.require=name=>name==='node:https'?{request:(url,options,receive)=>{
  assert.equal(url.href,'https://broker.example.invalid/v1/execute');assert.equal(options.rejectUnauthorized,true);
  const req=new EventEmitter();req.destroy=()=>{};
  req.end=body=>{calls.push(JSON.parse(body));queueMicrotask(()=>{
   const res=new EventEmitter();res.statusCode=status;res.headers=headers;
   receive(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');
  });};return req;
 }}:actual(name);
 loaded._compile(fs.readFileSync(source,'utf8'),source);
 const client=loaded.exports.createIntegrationsBrokerClient({origin:'https://broker.example.invalid',keyId:'fictitious-key',privateKey:privateKeyPem,
  audience:'fictitious-owner',ca:'FICTITIOUS_CA',transportProfile:'meta-marketing'});
 const execute=(operation=OPERATION)=>client.execute({requestId:randomUUID(),operation,tenantRef:'clinic:66',connectionRef:'fictitious-connection',assetRef:'meta-enroll:group:29',payload:{}});
 return {execute,calls};
}
async function rejected(f,operation){try{await f.execute(operation);assert.fail('Expected broker denial');}catch(error){assert.equal(f.calls.length,1,'No automatic retry');return error;}}
test('exact assets RPC preserves validated Owner cooldown and marks known429',async()=>{
 const f=fixture({headers:{'retry-after':'6'}}),error=await rejected(f);
 assert.equal(error.code,'rate_limited');assert.equal(error.httpStatus,429);assert.equal(error.retryAfterMs,5001);
 assert.deepEqual(Object.keys(error).sort(),['code','httpStatus','retryAfterMs']);
});
test('exact assets RPC accepts bounded delay and simple quota denial without inventing a delay',async t=>{
 for(const delay of [1,86400000,undefined])await t.test(String(delay),async()=>{
  const f=fixture({value:{error:{code:'rate_limited',...(delay===undefined?{}:{retryAfterMs:delay})}}}),error=await rejected(f);
  assert.equal(error.code,'rate_limited');assert.equal(error.httpStatus,429);assert.equal(error.retryAfterMs,delay);
 });
});
test('malformed cooldown metadata and response extras fail closed without reflecting private content',async t=>{
 const cases=[...[0,-1,86400001,1.5,'5001',null].map(retryAfterMs=>({value:{error:{code:'rate_limited',retryAfterMs}}})),
  {value:{error:{code:'rate_limited',retryAfterMs:5001,detail:CANARY}}},
  {value:{error:{code:'rate_limited',detail:CANARY}}},
  {value:{error:{code:'rate_limited',retryAfterMs:5001},detail:CANARY}},
  {headers:{'retry-after':'5'}},{headers:{'retry-after':'6\r\n'+CANARY}}];
 for(const [index,options]of cases.entries())await t.test(String(index),async()=>{
  const error=await rejected(fixture(options));assert.equal(error.code,'broker_response_invalid');
  assert.equal(error.httpStatus,undefined);assert.equal(error.retryAfterMs,undefined);assert(!JSON.stringify(error).includes(CANARY));
 });
});
test('another status or operation retains its previous scalar error contract',async t=>{
 for(const options of [{status:503},{operation:'meta.marketing.enrollment.assets.v2'},
  {operation:'meta.marketing.enrollment.assets.v1.extra'},{operation:'meta.marketing.oauth.assets.v1'},
  {operation:'meta.marketing.credential.maintenance.status.v1'},{operation:'meta.marketing.leads.form.read.v1'}])await t.test(JSON.stringify(options),async()=>{
  const error=await rejected(fixture(options),options.operation);
  assert.equal(error.code,'rate_limited');assert.equal(error.httpStatus,undefined);
  assert.equal(error.retryAfterMs,options.operation?.startsWith('meta.marketing.leads.')||options.operation?.startsWith('meta.marketing.credential.maintenance.')?5001:undefined);
 });
});
test('unrelated provider errors are unchanged',async()=>{
 const error=await rejected(fixture({status:502,value:{error:{code:'provider_failed',detail:CANARY}}}));
 assert.equal(error.code,'provider_failed');assert.equal(error.httpStatus,undefined);assert.equal(error.retryAfterMs,undefined);assert(!JSON.stringify(error).includes(CANARY));
});

// Real Express router dispatch, with closed session/service doubles and no socket.
async function route(error,{method='POST',assets=true,authenticated=true,body={}}={}){
 let calls=0,verifications=0;
 const sessions={verify:async()=>{verifications++;return {sessionVersion:1,jti:'11111111-1111-4111-8111-111111111111',userId:1,exp:2000000000};}};
 const service={assets:async(input,id)=>{calls++;assert.equal(input.scopeKey,'group:29');assert.equal(id,'22222222-2222-4222-8222-222222222222');throw error;},
  overview:async()=>{calls++;throw error;}};
 const router=require('../../routes/metaMarketingEnrollment.routes').createRouter({sessions,service});
 const result=await new Promise((resolve,reject)=>{
  const headers={},res={set:(key,value)=>{headers[key.toLowerCase()]=value;return res;},status:value=>{res.statusCode=value;return res;},
   json:value=>{resolve({status:res.statusCode||200,headers,body:value});return res;}};
  const req={method,url:assets?'/enrollment/22222222-2222-4222-8222-222222222222/assets':'/enrollment',
   headers:authenticated?{authorization:'Bearer FICTITIOUS_JWT'}:{},query:{assignment_scope:'group',group_id:'29'},body};
  router.handle(req,res,error=>reject(error||Error('Unexpected fallthrough')));
 });return {...result,calls,verifications};
}
const rate=(retryAfterMs,httpStatus=429)=>Object.assign(Error(CANARY),{code:'rate_limited',httpStatus,...(retryAfterMs===undefined?{}:{retryAfterMs})});
test('actual client denial passes through the actual router with one dispatch and the same safe body',async()=>{
 const f=fixture({headers:{'retry-after':'6'}}),out=await route(await rejected(f));
 assert.equal(out.status,429);assert.equal(out.headers['retry-after'],'6');assert.equal(out.calls,1);
 assert.deepEqual(out.body,{success:false,error:'rate_limited'});assert.equal(f.calls.length,1);
});
test('real router returns bounded Retry-After and unchanged safe body for known assets429',async t=>{
 for(const [ms,seconds]of [[1,'1'],[5001,'6'],[86400000,'86400']])await t.test(String(ms),async()=>{
  const out=await route(rate(ms));assert.equal(out.status,429);assert.equal(out.headers['retry-after'],seconds);
  assert.deepEqual(out.body,{success:false,error:'rate_limited'});assert.match(out.headers['cache-control'],/no-store/);assert.equal(out.calls,1);
  assert(!JSON.stringify(out).includes(CANARY));
 });
});
test('simple quota denial remains429 without a fabricated Retry-After',async()=>{
 const out=await route(rate());assert.equal(out.status,429);assert.equal(out.headers['retry-after'],undefined);
 assert.deepEqual(out.body,{success:false,error:'rate_limited'});
});
test('route cannot reflect malformed delay or alter ordinary503/other-method headers',async t=>{
 for(const [index,{error,options}]of [
  ...[0,-1,86400001,1.5,'5001',CANARY].map(delay=>({error:rate(delay)})),
  {error:Object.assign(Error(CANARY),{code:'rate_limited',retryAfterMs:5001})},
  {error:rate(5001),options:{assets:false,method:'GET'}},
  {error:Object.assign(Error(CANARY),{code:'provider_failed',httpStatus:503,retryAfterMs:5001})},
 ].entries())await t.test(String(index),async()=>{
  const out=await route(error,options);assert.equal(out.headers['retry-after'],undefined);
  assert.equal(out.status,error.httpStatus||503);assert(!JSON.stringify(out).includes(CANARY));
 });
});
test('authentication, payload validation and genuine401/403/409 remain closed before or after service dispatch',async t=>{
 for(const httpStatus of [401,403,409])await t.test(String(httpStatus),async()=>{
  const out=await route(Object.assign(Error(CANARY),{code:'meta_oauth_scope_forbidden',httpStatus}));
  assert.equal(out.status,httpStatus);assert.equal(out.headers['retry-after'],undefined);
 });
 const missing=await route(rate(5001),{authenticated:false});assert.equal(missing.status,401);assert.equal(missing.calls,0);assert.equal(missing.verifications,0);
 const malformed=await route(rate(5001),{body:{unrequested:CANARY}});assert.equal(malformed.status,400);assert.equal(malformed.calls,0);
 assert.equal(require.cache[require.resolve('../../../models')],undefined,'No application model bootstrap');
});
