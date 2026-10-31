'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
const {searchConsoleFixture}=require('./fixtures/search_console_broker.fixture');
const range={startDate:'2026-09-01',endDate:'2026-09-02'},limited=()=>Object.assign(Error('rate_limited'),{code:'rate_limited'});
const queries=(start,n,token=null)=>({rows:Array.from({length:n},(_,i)=>({keys:[range.startDate,'q'+(start+i),'https://example.invalid/'],clicks:1,impressions:2,position:1})),nextPageToken:token,rowLimitReached:false});
test('one SC fetch retains all 24501 rows once, retries only the rejected unchanged request, and preserves pacing',async()=>{
 const f=searchConsoleFixture(),at=[],tokens=[];let rejected=false;
 f.state.response=({payload})=>{at.push(f.state.at);tokens.push(payload.pageToken);if(!rejected){rejected=true;throw limited();}return queries(0,24501);};
 const ctx=await f.service.prepare(f.mapping),result=await f.service.read(f.mapping,ctx,'queries',range,{beforeExecute:()=>({timeoutMs:30000})});
 assert.equal(result.data.rows.length,24501);assert.equal(new Set(result.data.rows.map(x=>x.keys.join('|'))).size,24501);assert.deepEqual(tokens,[null,null]);assert.equal(f.state.calls.length,2);assert(f.state.at<450000+1000);assert(at[1]-at[0]>=1000);
});
test('one SC connector serializes concurrent families and shares a 60/minute pace without a per-read burst reset',async()=>{
 const f=searchConsoleFixture(),times=[];let inFlight=0,max=0;
 f.state.response=async()=>{times.push(f.state.at);max=Math.max(max,++inFlight);await Promise.resolve();inFlight--;return{rows:[{keys:[range.startDate],clicks:1}]};};
 const ctx=await f.service.prepare(f.mapping);await Promise.all(Array.from({length:61},()=>f.service.read(f.mapping,ctx,'timeseries',range)));assert.equal(max,1);assert.equal(times.length,61);assert(times[60]-times[0]>=60000);for(let i=1;i<times.length;i++)assert(times[i]-times[i-1]>=1000);
});
test('only rate_limited and typed provider_timeout READ errors are retried, at most twice; deadline and changed scope during wait stop before another dispatch',async()=>{
 for(const code of ['provider_failed','broker_timeout','broker_unavailable','outcome_unknown','scope_denied','broker_response_invalid','provider_unauthorized','credential_revoked']){const f=searchConsoleFixture(),ctx=await f.service.prepare(f.mapping);f.state.response=()=>{throw Object.assign(Error(code),{code});};await assert.rejects(f.service.read(f.mapping,ctx,'queries',range),{code});assert.equal(f.state.calls.length,1);}
 const f=searchConsoleFixture(),ctx=await f.service.prepare(f.mapping);f.state.response=()=>{throw limited();};await assert.rejects(f.service.read(f.mapping,ctx,'queries',range),{code:'rate_limited'});assert.equal(f.state.calls.length,3);
 const g=searchConsoleFixture();let rounds=0;const svc=g.create({pause:async ms=>{g.state.at+=ms;if(++rounds===2)g.state.record.state='blocked';}}),c=await svc.prepare(g.mapping);g.state.response=()=>{throw limited();};await assert.rejects(svc.read(g.mapping,c,'queries',range),{code:'broker_binding_invalid'});assert.equal(g.state.calls.length,1);
 const h=searchConsoleFixture(),hc=await h.service.prepare(h.mapping),until=h.state.at+1500;h.state.response=()=>{throw limited();};await assert.rejects(h.service.read(h.mapping,hc,'queries',range,{beforeExecute:()=>{if(h.state.at>=until)throw Object.assign(Error('search_console_interval_budget_exceeded'),{code:'search_console_interval_budget_exceeded'});return{timeoutMs:Math.min(30000,until-h.state.at)};}}),{code:'search_console_interval_budget_exceeded'});assert.equal(h.state.calls.length,1);assert(h.state.at<=until);
 const k=searchConsoleFixture(),kc=await k.service.prepare(k.mapping);k.state.response=()=>null;await assert.rejects(k.service.read(k.mapping,kc,'queries',range),{code:'broker_response_invalid'});assert.equal(k.state.calls.length,1);
});
test('genuine existing signer creates a fresh valid signature/nonce/requestId for the unchanged retried SC READ, without network or provider secrets',async()=>{
 const f=searchConsoleFixture(),requests=[],{privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
 const https={request:(_url,options,respond)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{const packet=JSON.parse(body);requests.push({body:Buffer.from(body),packet,headers:options.headers});queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=requests.length===1?429:requests.length===2?504:200;respond(res);res.emit('data',Buffer.from(JSON.stringify(requests.length<=2?{error:{code:requests.length===1?'rate_limited':'provider_timeout'}}:{requestId:packet.requestId,replayed:false,data:queries(0,1)})));res.emit('end');});};return req;}};
 const filename=path.resolve(__dirname,'../../lib/integrationsBrokerClient.js'),mod={exports:{}},nativeRequire=require('node:module').createRequire(filename),req=name=>name==='node:https'?https:name==='./googleCutoverAdmission'?{application:{run:(_kind,work)=>work()}}:nativeRequire(name);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:req,module:mod,Buffer,URL,setTimeout,clearTimeout,console});
 const signed=mod.exports.createIntegrationsBrokerClient({origin:'https://fixture.invalid',audience:'google-search-console:staging',keyId:'fixture-key',privateKey:privateKey.export({format:'pem',type:'pkcs8'}),ca:'FICTIONAL_CA',timeoutMs:30000}),svc=f.create({client:signed}),ctx=await svc.prepare(f.mapping);
 const result=await svc.read(f.mapping,ctx,'queries',range);assert.equal(result.data.rows.length,1);assert.equal(requests.length,3);assert.deepEqual(requests[0].packet.payload,requests[1].packet.payload);assert.notEqual(requests[0].packet.nonce,requests[1].packet.nonce);assert.notEqual(requests[0].packet.requestId,requests[1].packet.requestId);assert.equal(new Set(requests.map(r=>r.packet.nonce)).size,3);assert.equal(new Set(requests.map(r=>r.packet.requestId)).size,3);assert.deepEqual(requests[1].packet.payload,requests[2].packet.payload);
 for(const r of requests){const message=Buffer.from('clinicaclick-broker-v1\nPOST\n/v1/execute\n'+crypto.createHash('sha256').update(r.body).digest('hex'));assert(crypto.verify(null,message,publicKey,Buffer.from(r.headers['x-broker-signature'],'base64url')));}
});
