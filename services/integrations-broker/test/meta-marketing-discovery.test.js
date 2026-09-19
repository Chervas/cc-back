'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),D=require('../src/meta-marketing-discovery-contract');
const discover=(f,flow,patch={},control=false)=>f.execute(D.OPERATION,{flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,...patch},{},control);
async function ready(t){const f=fixture(t,{discovery:true}),flow=await f.begin();await f.finish(flow);return {f,flow};}
test('new candidate inventory returns only authorized typed metadata, pins, expiry and separate audit; no token or activation',async t=>{
  const {f,flow}=await ready(t),a=f.state.awsCalls.length,h=f.state.httpCalls.length,puts=f.state.puts;
  const result=await discover(f,flow);assert.equal(result.data.flowId,flow.flowId);assert.equal(result.data.accessBlocked,true);
  assert.deepEqual(result.data.availableKinds,['ad_account','facebook_page','instagram_business']);
  assert.equal(result.data.assets.length,3);assert.equal(result.data.assets.find(v=>v.kind==='instagram_business').parentPageId,'401');
  assert.equal(result.data.expiresAt,f.now()+300000);assert.equal(result.data.candidateVersionId,flow.flowId);assert.equal(f.state.puts,puts);
  assert.deepEqual(f.state.httpCalls.slice(h).map(v=>v.kind),['inspect','adaccounts','accounts','inspect']);
  assert(!f.state.awsCalls.slice(a).some(c=>/Put|List/.test(c.constructor.name)));
  const rows=f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(r=>JSON.parse(r.event)).filter(v=>v.operation===D.OPERATION);
  assert.deepEqual(rows.map(v=>v.action),['integration.requested','integration.completed']);assert(rows.every(v=>v.correlationId===result.requestId));
  for(const hidden of [TOKEN,APP,'FICTITIOUS_META_CODE',flow.payload.state])assert(!JSON.stringify([result,rows,f.snapshot()]).includes(hidden));
  assert.equal(f.current.store.db.prepare('SELECT state FROM meta_marketing_oauth_flows WHERE id=?').get(flow.flowId).state,'staged');
  console.log(JSON.stringify({discoverySample:{secretCalls:f.state.awsCalls.length-a,graphCalls:4,assets:3,auditEvents:rows.length}}));
});
test('gate and runtime configuration keep discovery closed unless explicitly granted to gateway',async t=>{
  const f=fixture(t),flow=await f.begin();await f.finish(flow);await assert.rejects(discover(f,flow),{code:'scope_denied'});
  const runtime=require('../src/meta-marketing-oauth-main'),g=fixture(t,{discovery:true});runtime.validateConfig(g.config);
  const noFlag=structuredClone(g.config);delete noFlag.assetDiscovery;assert.throws(()=>runtime.validateConfig(noFlag),{code:'invalid_request'});
  const noGrant=structuredClone(g.config);noGrant.policy.grants[0].operations=noGrant.policy.grants[0].operations.filter(v=>v!==D.OPERATION);assert.throws(()=>runtime.validateConfig(noGrant),{code:'invalid_request'});
  for(const flag of ['true',1,null]){const bad=structuredClone(g.config);bad.assetDiscovery=flag;assert.throws(()=>runtime.validateConfig(bad),{code:'invalid_request'});}
  const fg=await g.begin();await g.finish(fg);const a=g.state.awsCalls.length;await assert.rejects(discover(g,fg,{},true),{code:'scope_denied'});assert.equal(g.state.awsCalls.length,a);
});
test('wrong scope, not yet staged, abort, current block and expired credential reject before any Secrets or Graph read',async t=>{
  const f=fixture(t,{discovery:true}),flow=await f.begin();let a=f.state.awsCalls.length,h=f.state.httpCalls.length;
  await assert.rejects(discover(f,flow),{code:'scope_denied'});assert.equal(f.state.awsCalls.length,a);assert.equal(f.state.httpCalls.length,h);
  await f.finish(flow);a=f.state.awsCalls.length;h=f.state.httpCalls.length;
  for(const patch of [{scopeDigest:'a'.repeat(64)},{token:TOKEN},{host:'foreign.example.invalid'},{cursor:'PRIVATE_CURSOR'}])await assert.rejects(discover(f,flow,patch));
  assert.equal(f.state.awsCalls.length,a);assert.equal(f.state.httpCalls.length,h);
  await f.abort(flow);await assert.rejects(discover(f,flow),{code:'scope_denied'});assert.equal(f.state.awsCalls.length,a);
  const {f:g,flow:fg}=await ready(t);g.state.clock+=3600001;a=g.state.awsCalls.length;await assert.rejects(discover(g,fg),{code:'credential_revoked'});assert.equal(g.state.awsCalls.length,a);
});
test('pagination uses only opaque cursor against a fixed Graph edge, does not follow next URL, and never stores cursors',async t=>{
  const {f,flow}=await ready(t);let n=0;
  f.state.afterGraph=async(kind,value)=>{
    if(kind==='accounts'){
      if(n++===0)return {data:value.data,paging:{cursors:{after:'OPAQUE_QA_1'},next:'https://foreign.example.invalid/?access_token='+TOKEN}};
      assert.equal(f.state.lastAfter,'OPAQUE_QA_1');return {data:[{id:'402',name:'Otra página ficticia'}]};
    }return value;
  };
  const r=await discover(f,flow);assert.equal(r.data.assets.length,4);assert.equal(n,2);assert(!JSON.stringify([r,f.snapshot()]).includes('OPAQUE_QA_1'));
});
for(const [name,change]of [
  ['duplicate assets',(_f,v)=>({data:[v.data[0],v.data[0]]})],
  ['missing cursor',(_f,v)=>({...v,paging:{next:'https://graph.facebook.com/anything'}})],
  ['unexpected page token',(_f,v)=>({data:[{...v.data[0],access_token:TOKEN}]})],
  ['provider token echoed as name',(_f,v)=>({data:[{...v.data[0],name:TOKEN}]})],
  ['oversized page',(_f,v)=>({data:Array.from({length:101},()=>v.data[0])})],
  ['rate limit',()=>({error:{code:4,message:'FICTITIOUS_PRIVATE_PROVIDER_ERROR'}})],
  ['oversized body',(_f,v)=>({data:[{...v.data[0],name:'A'.repeat(140000)}]})],
])test('incomplete or unsafe inventory is never a partial success: '+name,async t=>{
  const {f,flow}=await ready(t);f.state.afterGraph=async(kind,value)=>kind==='accounts'?change(f,value):value;
  await assert.rejects(discover(f,flow),e=>['provider_failed','secret_unavailable','rate_limited'].includes(e.code)&&!e.message.includes('FICTITIOUS_PRIVATE_PROVIDER_ERROR'));
  const rows=f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(r=>JSON.parse(r.event)).filter(v=>v.operation===D.OPERATION);
  assert(!rows.some(v=>v.action==='integration.completed'));assert.equal(f.current.store.db.prepare('SELECT state FROM meta_marketing_oauth_flows WHERE id=?').get(flow.flowId).state,'staged');
});
test('repeated cursor and inventory/page ceilings close the complete result',async t=>{
  for(const mode of ['loop','pages','assets']){
    const {f,flow}=await ready(t);let n=0;
    f.state.afterGraph=async(kind,value)=>{
      if(kind!=='accounts')return value;const offset=++n*1000;
      return {data:mode==='pages'?[]:Array.from({length:mode==='assets'?100:1},(_,i)=>({id:String(offset+i+1),name:'Página ficticia'})),paging:{cursors:{after:mode==='loop'?'SAME_CURSOR':'PAGE_'+n},next:'https://ignored.invalid/'}};
    };
    await assert.rejects(discover(f,flow),{code:'provider_failed'});assert(n<=D.MAX_PAGES);assert(n<=6||mode==='pages');
  }
});
test('permissions are checked from fresh token before and after inventory, including granular access',async t=>{
  for(const mode of ['subject','scope','expiry','granular','last-inspection']){
    const {f,flow}=await ready(t);let inspections=0;
    f.state.afterGraph=async(kind,value)=>{
      if(kind==='inspect'){
        if(mode==='subject')value.data.user_id='999';
        if(mode==='scope')value.data.scopes=value.data.scopes.filter(v=>v!=='ads_read');
        if(mode==='expiry')value.data.expires_at=1;
        if(mode==='granular')value.data.granular_scopes[0].target_ids=['999'];
        if(mode==='last-inspection'&&++inspections===2)value.data.is_valid=false;
      }return value;
    };
    await assert.rejects(discover(f,flow),e=>['oauth_identity_mismatch','oauth_credentials_incomplete','credential_revoked'].includes(e.code));
  }
});
test('abort during Graph prevents additional pages and result; borrowed token and application buffers are wiped',async t=>{
  const {f,flow}=await ready(t),held=[];const original=f.http.discover;
  f.http.discover=async input=>{held.push(input.token,input.appSecret);return original(input);};
  f.state.afterGraph=async(kind,value)=>{if(kind==='adaccounts')await f.abort(flow,f.current,true);return value;};
  const h=f.state.httpCalls.length;await assert.rejects(discover(f,flow),e=>['provider_timeout','scope_denied'].includes(e.code));
  assert.deepEqual(f.state.httpCalls.slice(h).map(v=>v.kind),['inspect','adaccounts']);assert(held.every(v=>v.every(b=>b===0)));
});
test('grant withdrawal between Graph pages stops the next page and preserves the original candidate',async t=>{
  const {f,flow}=await ready(t);f.state.afterGraph=async(kind,value)=>{if(kind==='adaccounts')f.policy.grants[0].operations=f.policy.grants[0].operations.filter(v=>v!==D.OPERATION);return value;};
  const h=f.state.httpCalls.length;await assert.rejects(discover(f,flow),{code:'scope_denied'});assert.deepEqual(f.state.httpCalls.slice(h).map(v=>v.kind),['inspect','adaccounts']);
});
test('slot/app changes and final audit failure release no inventory; immutable candidate survives restart',async t=>{
  for(const mode of ['slot','app','audit']){
    const {f,flow}=await ready(t);const append=f.current.store.appendAudit.bind(f.current.store);
    if(mode==='audit')f.current.store.appendAudit=event=>{if(event.operation===D.OPERATION&&event.action==='integration.completed')throw Error('FICTITIOUS_AUDIT_FAILURE');return append(event);};
    else f.state.afterGraph=async(kind,value)=>{if(kind==='accounts')f.records.get(mode==='app'?f.binding.clientSecretArn:f.binding.secretArn).get(mode==='app'?f.binding.metaMarketingOAuth.appVersionId:f.binding.metaMarketingOAuth.slotVersionId).stages=[];return value;};
    await assert.rejects(discover(f,flow),e=>['secret_version_changed','internal_error'].includes(e.code));
  }
  const {f,flow}=await ready(t),codes=f.state.codes,puts=f.state.puts;f.restart();const r=await discover(f,flow);assert.equal(r.data.assets.length,3);assert.equal(f.state.codes,codes);assert.equal(f.state.puts,puts);
});
