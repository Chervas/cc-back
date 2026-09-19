'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs'),C=require('../src/meta-marketing-oauth-contract');
const row=(f,flow)=>f.current.store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(flow.flowId);
test('new unknown Meta identity is inspected and stored only in an immutable candidate; no active grant or credential in SQLite',async t=>{
  const f=fixture(t),flow=await f.begin();const u=new URL(flow.result.data.authUrl);
  assert.equal(u.origin,'https://www.facebook.com');assert.equal(u.pathname,'/v24.0/dialog/oauth');assert.equal(u.searchParams.get('state'),flow.payload.state);
  assert.equal(f.state.codes,0);const result=await f.finish(flow);
  assert.equal(result.data.status,'staged');assert.equal(result.data.accessBlocked,true);assert.equal(result.data.candidate.subjectId,'201');
  assert.equal(result.data.candidate.versionId,flow.flowId);assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
  assert.deepEqual(f.state.httpCalls.map(x=>x.kind),['code','extend','inspect']);
  const versions=f.records.get(f.binding.secretArn);assert.deepEqual(versions.get(flow.flowId).stages,['AWSPENDING']);
  assert.deepEqual(versions.get(f.binding.metaMarketingOAuth.slotVersionId).stages,['AWSCURRENT']);
  assert.equal(JSON.parse(versions.get(flow.flowId).body).accessToken,TOKEN);
  const snapshot=f.snapshot();for(const secret of [TOKEN,APP,flow.code,flow.payload.state,'FICTITIOUS_META_SHORT_TOKEN'])assert(!snapshot.includes(secret));
  const n=f.state.awsCalls.length;assert.equal((await f.finish(flow)).data.status,'staged');assert.equal(f.state.awsCalls.length,n);
  assert.equal(f.state.codes,1);assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,0);
  const events=f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(x=>JSON.parse(x.event));
  assert.deepEqual(events.map(x=>x.reason),['oauth_authorization_requested','oauth_credentials_staged']);
  assert(events.every(x=>x.correlationId===flow.flowId));
});
test('lost AWS response and failed completion audit recover by the original version after restart without exchanging again',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.losePut=true;await assert.rejects(f.finish(flow),{code:'secret_unavailable'});
  assert.equal(row(f,flow).state,'staging');const digest=row(f,flow).secret_digest;f.restart();
  const append=f.current.store.appendAudit;f.current.store.appendAudit=()=>{throw Error('FICTITIOUS_AUDIT_FAILURE');};
  await assert.rejects(f.status(flow));assert.equal(row(f,flow).state,'staging');f.current.store.appendAudit=append;
  const result=await f.status(flow);assert.equal(result.data.status,'staged');assert.equal(result.data.candidate.digest,digest);
  assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);assert.equal(f.state.httpCalls.length,3);
});
test('candidate never written remains uncertain and does not replay the consumed code',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.failPut=true;await assert.rejects(f.finish(flow));f.restart();
  await assert.rejects(f.status(flow));await assert.rejects(f.finish(flow));assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
  assert.equal((await f.abort(flow)).data.status,'aborted');assert.equal((await f.begin()).result.data.authUrl.startsWith('https://www.facebook.com/'),true);
});
test('unknown code exchange cannot be replayed, even after broker restart',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.afterGraph=kind=>{if(kind==='code')throw Error(TOKEN+APP);};
  await assert.rejects(f.finish(flow));assert.equal(row(f,flow).state,'interrupted');f.restart();
  await assert.rejects(f.finish(flow),{code:'oauth_flow_interrupted'});assert.equal(f.state.codes,1);assert.equal(f.state.puts,0);
});
test('abort before delayed begin, full-scope identity and changed state are durable exclusions',async t=>{
  const f=fixture(t),id=randomUUID();const flow={flowId:id};await f.abort(flow,f.current,true);
  await assert.rejects(f.execute(C.OPERATIONS.begin,{state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000,scopeDigest:C.hash('qa'),clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth)},{requestId:id}),{code:'oauth_flow_interrupted'});
  const live=await f.begin();const before=f.state.awsCalls.length;
  for(const changes of [{state:randomBytes(32).toString('base64url')},{code:'FICTITIOUS_OTHER_CODE',url:'https://example.invalid'},{accessToken:TOKEN}])await assert.rejects(f.finish(live,changes));
  await assert.rejects(f.execute(C.OPERATIONS.status,{flowId:live.flowId},{tenantRef:'clinic:72'}),{code:'scope_denied'});
  await assert.rejects(f.execute(C.OPERATIONS.finish,{flowId:live.flowId,state:live.payload.state,code:live.code},{},true),{code:'scope_denied'});
  assert.equal(f.state.awsCalls.length,before);assert.equal(f.state.codes,0);
});
test('control abort interrupts a held exchange and is preserved if its response arrives late',async t=>{
  const f=fixture(t),flow=await f.begin();let enter,release;const ready=new Promise(r=>enter=r),held=new Promise(r=>release=r);
  f.state.beforeCode=async()=>{enter();await held;};const work=f.finish(flow);await ready;
  assert.equal((await f.abort(flow,f.current,true)).data.status,'aborted');release();await assert.rejects(work);
  assert.equal(row(f,flow).state,'aborted');assert.equal(f.state.codes,1);assert.equal(f.state.puts,0);
});
test('revocation during staging rejects confirmation and restart never removes the broker block',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.afterAws=(command,response)=>{
    if(command.constructor.name==='PutSecretValueCommand')f.current.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1 WHERE ref=?").run(f.binding.connectionRef);
    return response;
  };
  await assert.rejects(f.finish(flow),{code:'connection_blocked'});assert.equal(row(f,flow).state,'staging');f.restart();
  await assert.rejects(f.status(flow),{code:'connection_blocked'});assert.equal((await f.abort(flow,f.current,true)).data.status,'aborted');
  assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
});
for(const [name,modify] of [
  ['wrong app',d=>d.app_id='999'],['wrong token type',d=>d.type='SYSTEM_USER'],['invalid token',d=>d.is_valid=false],
  ['WhatsApp scope',d=>d.scopes.push('whatsapp_business_messaging')],['missing scope',d=>d.scopes.pop()],
  ['duplicate scope',d=>d.scopes.push(d.scopes[0])],['expired',d=>d.expires_at=1],['missing expiry',d=>delete d.data_access_expires_at],
  ['unbound granular scope',d=>d.granular_scopes.push({scope:'leads_retrieval',target_ids:['1']})],
  ['repeated granular target',d=>d.granular_scopes[0].target_ids.push('301')],['non-numeric subject',d=>d.user_id='unknown'],
])test('OAuth rejects '+name+' before vault write',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.afterGraph=(kind,response)=>{if(kind==='inspect')modify(response.data);return response;};
  await assert.rejects(f.finish(flow),e=>!e.stack.includes(TOKEN)&&!e.stack.includes(APP));assert.equal(f.state.puts,0);
});
for(const [name,modify] of [
  ['foreign KMS',(f,c,r)=>{if(c.constructor.name==='DescribeSecretCommand')r.KmsKeyId='foreign';}],
  ['foreign ARN',(f,c,r)=>{if(c.constructor.name==='DescribeSecretCommand')r.ARN='foreign';}],
  ['deleted slot',(f,c,r)=>{if(c.constructor.name==='DescribeSecretCommand')r.DeletedDate=new Date();}],
  ['changed app',(f,c,r)=>{if(c.constructor.name==='DescribeSecretCommand'&&c.input.SecretId===f.binding.clientSecretArn)r.VersionIdsToStages={changed:['AWSCURRENT']};}],
  ['legacy token slot',(f,c,r)=>{if(c.constructor.name==='GetSecretValueCommand'&&c.input.SecretId===f.binding.secretArn)r.SecretString=JSON.stringify({accessToken:TOKEN});}],
  ['group membership changed',(f,c,r)=>{if(c.constructor.name==='GetSecretValueCommand'&&c.input.SecretId===f.binding.secretArn){const v=JSON.parse(r.SecretString);v.clinicSetDigest=C.hash('foreign');r.SecretString=JSON.stringify(v);}}],
  ['version limit',(f,c,r)=>{if(c.constructor.name==='ListSecretVersionIdsCommand')r.NextToken='another-page';}],
])test('vault preflight rejects '+name+' before Meta exchange',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.afterAws=(c,r)=>{modify(f,c,r);return r;};await assert.rejects(f.finish(flow));assert.equal(f.state.codes,0);assert.equal(f.state.puts,0);
});
test('candidate integrity and slot/app pins are checked again after lost receipt',async t=>{
  const f=fixture(t),flow=await f.begin();f.state.losePut=true;await assert.rejects(f.finish(flow));
  const candidate=f.records.get(f.binding.secretArn).get(flow.flowId),original=candidate.body;
  candidate.body=original.replace('"subjectId":"201"','"subjectId":"999"');await assert.rejects(f.status(flow),{code:'secret_unavailable'});
  candidate.body=original;candidate.stages=['AWSCURRENT'];await assert.rejects(f.status(flow),{code:'secret_version_changed'});
  candidate.stages=[];assert.equal((await f.status(flow)).data.status,'staged');assert.equal(f.state.codes,1);
});
test('complete scope, expiry and changed configuration cannot be rebound to an existing flow',async t=>{
  const f=fixture(t);await assert.rejects(f.begin({clinicSetDigest:C.hash('partial-group')}),{code:'scope_denied'});
  await assert.rejects(f.begin({expiresAt:f.now()+600001}),{code:'scope_denied'});const flow=await f.begin();
  f.policy.connections[0].metaMarketingOAuth.clinicIds=[71,72,73];f.restart();
  await assert.rejects(f.finish(flow),{code:'scope_denied'});assert.equal(f.state.codes,0);
});
