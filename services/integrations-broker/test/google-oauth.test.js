'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomBytes, randomUUID, generateKeyPairSync, createHash } = require('node:crypto');
const { fixture } = require('./helpers'); const { oauthSecretsFixture } = require('./google-oauth-fixture.cjs');
const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store'); const { signRequest } = require('../src/auth');
const { createGoogleOAuth } = require('../src/google-oauth'); const { OPERATIONS } = require('../src/google-oauth-contract');
const { createGoogleBusinessProfileOperations } = require('../src/google-business-profile'); const { createGoogleSecretStore } = require('../src/google-secrets');
const { REVOKE_OPERATION } = require('../src/google-business-profile-contract'); const runtime = require('../src/google-main');
function setup(t) {
  const f=fixture(t); const sm=oauthSecretsFixture(); const oauthKey=generateKeyPairSync('ed25519'); const revokeKey=generateKeyPairSync('ed25519');
  const policy=structuredClone(f.policy); policy.connections[0]={...sm.binding,initialState:'active'};
  for (const [id,keyId,key] of [['oauth:qa','qa-oauth',oauthKey],['revoke:qa','qa-revoke',revokeKey]]) policy.principals.push({ ...policy.principals[0],id,keyId,publicKey:key.publicKey.export({type:'spki',format:'pem'}) });
  const grant={tenantRef:'clinic:123',connectionRef:'connection:test',assetRef:'gbp:123:456'};
  policy.grants=[{...grant,principalId:'api:test',operations:['google.business_profile.details.read.v1']},
    {...grant,principalId:'oauth:qa',operations:Object.values(OPERATIONS)}, {...grant,tenantRef:'clinic:124',principalId:'oauth:qa',operations:Object.values(OPERATIONS)},
    {...grant,principalId:'revoke:qa',operations:[REVOKE_OPERATION]}];
  const state=Object.assign(sm.state,{codes:0,refreshes:0,userinfos:0,reads:0,activated:0,clock:Date.now()});
  const http=async request => {
    if(request.hostname==='oauth2.googleapis.com'){
      const form=new URLSearchParams(request.form); assert.equal(form.get('client_secret'),sm.app.clientSecret);
      if(form.get('grant_type')==='authorization_code'){state.codes++;state.lastCode=form.get('code');state.lastVerifier=form.get('code_verifier');await state.beforeToken?.();}
      else {state.refreshes++;assert.equal(form.get('refresh_token'),sm.value.refreshToken);}
      return {access_token:'FICTITIOUS_ACCESS',refresh_token:state.omitRefresh?undefined:sm.value.refreshToken,token_type:'Bearer',expires_in:3600,
        scope:state.missingScope?'openid':sm.binding.oauth.scopes.map(s=>s==='email'?'https://www.googleapis.com/auth/userinfo.email':s==='profile'?'https://www.googleapis.com/auth/userinfo.profile':s).join(' ')};
    }
    if(request.hostname==='www.googleapis.com'){state.userinfos++;state.userinfoToken=request.token;await state.beforeIdentity?.();return{id:state.foreignIdentity?'other':sm.binding.oauth.subject,email:'FICTITIOUS_EMAIL',name:'FICTITIOUS_NAME'};}
    state.reads++;return{name:'locations/456',title:'FICTITIOUS_TITLE'};
  };
  const secrets=createGoogleSecretStore({client:sm.client,http,...sm.config,now:()=>state.clock});
  let engine;let broker;
  const reopen=(store=f.store)=>{
    engine?.close();engine=createGoogleOAuth({store,secrets:sm.secrets,http,policy,now:()=>state.clock,onActivated:ref=>{state.activated++;secrets.invalidate(ref);}});
    broker=new Broker({store,policy,secrets,now:()=>state.clock,operations:createGoogleBusinessProfileOperations({http,cursor:{},oauth:engine})});
  };reopen();t.after(()=>{engine.close();secrets.close();});
  const execute=(operation,payload={},changes={},role='oauth')=>{
    const command=f.command({operation,assetRef:grant.assetRef,payload,...changes});
    const signed=signRequest(command,{keyId:role==='oauth'?'qa-oauth':role==='revoke'?'qa-revoke':'qa-key',privateKey:role==='oauth'?oauthKey.privateKey:role==='revoke'?revokeKey.privateKey:f.keys.privateKey,audience:policy.audience,now:state.clock});
    return broker.execute(signed.raw,signed.headers);
  };
  const begin=async()=>{const stateToken=randomBytes(32).toString('base64url');const result=await execute(OPERATIONS.begin,{state:stateToken});return{flowId:result.data.flowId,stateToken,url:new URL(result.data.authUrl)};};
  const finish=flow=>execute(OPERATIONS.finish,{flowId:flow.flowId,state:flow.stateToken,code:'FICTITIOUS_CODE'});
  const status=flow=>execute(OPERATIONS.status,{flowId:flow.flowId});
  const activate=flow=>execute(OPERATIONS.activate,{flowId:flow.flowId});
  const snapshot=()=>JSON.stringify(f.store.db.prepare('SELECT * FROM google_oauth_flows').all())+JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all())+JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());
  return{...f,...sm,policy,state,execute,begin,finish,status,activate,snapshot,reopen,secrets,oauthKey,http};
}
test('signed OAuth flow uses PKCE and pinned identity, stages before activation and leaves only metadata in SQLite',async t=>{
  const f=setup(t);const flow=await f.begin();assert.equal(flow.url.origin,'https://accounts.google.com');assert.equal(flow.url.searchParams.get('state'),flow.stateToken);assert.equal(flow.url.searchParams.get('prompt'),'consent');
  const result=await f.finish(flow);assert.equal(result.data.status,'staged');assert.equal(f.state.codes,1);assert.equal(f.state.userinfos,1);
  assert.equal(flow.url.searchParams.get('code_challenge'),createHash('sha256').update(f.state.lastVerifier).digest('base64url'));assert(f.state.userinfoToken.every(v=>v===0));
  assert(f.state.records.get(f.binding.secretArn).get('baseline').stages.has('AWSCURRENT'));
  for(const sentinel of [flow.stateToken,'FICTITIOUS_CODE',f.state.lastVerifier,'FICTITIOUS_ACCESS','FICTITIOUS_NEW_REFRESH','FICTITIOUS_OLD_REFRESH','FICTITIOUS_CLIENT_SECRET','FICTITIOUS_EMAIL','FICTITIOUS_NAME'])assert(!f.snapshot().includes(sentinel),sentinel);
  assert.equal((await f.activate(flow)).data.status,'active');assert.equal(f.state.activated,1);
  assert.equal((await f.execute('google.business_profile.details.read.v1',{}, {},'read')).data.title,'FICTITIOUS_TITLE');assert.equal(f.state.refreshes,1);
  assert.equal((await f.finish(flow)).replayed,true);assert.equal((await f.activate(flow)).replayed,true);assert.equal(f.state.codes,1);
  const audit=f.store.db.prepare('SELECT event FROM audit_outbox').all().map(r=>JSON.parse(r.event));assert(audit.filter(e=>e.operation.startsWith('google.business_profile.oauth.')).every(e=>e.correlationId===flow.flowId));
});
test('known v3 refresh credentials avoid forced consent and remain usable when reauthorization omits refresh_token',async t=>{
  const f=setup(t);const first=await f.begin();await f.finish(first);await f.activate(first);f.state.omitRefresh=true;
  const second=await f.begin();assert.equal(second.url.searchParams.has('prompt'),false);await f.finish(second);await f.activate(second);
  assert.equal(f.state.codes,2);assert.equal(f.state.records.get(f.binding.secretArn).get(second.flowId).stages.has('AWSCURRENT'),true);
});
test('a known revoked refresh is never reused and new credentials preserve revoked or expired access', async t => {
  const f = setup(t); const first = await f.begin(); await f.finish(first); await f.activate(first);
  f.store.db.prepare("UPDATE connections SET state='revoked' WHERE ref=?").run('connection:test'); f.state.omitRefresh = true;
  const rejected = await f.begin(); assert.equal(rejected.url.searchParams.get('prompt'), 'consent');
  await assert.rejects(f.finish(rejected), { code: 'oauth_credentials_incomplete' });
  await f.execute(OPERATIONS.abort, { flowId: rejected.flowId }); f.state.omitRefresh = false;
  const replacement = await f.begin(); await f.finish(replacement); assert.equal((await f.activate(replacement)).data.accessBlocked, true);
  assert.throws(() => f.store.connection('connection:test'), { code: 'connection_blocked' });
  const expired = setup(t); expired.store.db.prepare('UPDATE connections SET expires_at=? WHERE ref=?').run(expired.state.clock - 1, 'connection:test');
  const flow = await expired.begin(); assert.equal((await expired.status(flow)).data.accessBlocked, true);
});
test('foreign keys/scopes/state/identity and incomplete permissions cannot stage or activate credentials',async t=>{
  const f=setup(t);await assert.rejects(f.execute(OPERATIONS.begin,{state:randomBytes(32).toString('base64url')},{},'read'),{code:'scope_denied'});assert.equal(f.state.calls.length,0);
  for(const failure of ['foreignIdentity','missingScope','omitRefresh']){
    const flow=await f.begin();await assert.rejects(f.execute(OPERATIONS.finish,{flowId:flow.flowId,state:randomBytes(32).toString('base64url'),code:'FICTITIOUS_CODE'}),{code:'oauth_state_invalid'});
    await assert.rejects(f.execute(OPERATIONS.status,{flowId:flow.flowId},{tenantRef:'clinic:124'}),{code:'scope_denied'});
    f.state[failure]=true;await assert.rejects(f.finish(flow),{code:failure==='foreignIdentity'?'oauth_identity_mismatch':'oauth_credentials_incomplete'});f.state[failure]=false;
    assert.equal((await f.status(flow)).data.status,'interrupted');await f.execute(OPERATIONS.abort,{flowId:flow.flowId});
  }
  assert.equal(f.state.records.get(f.binding.secretArn).size,1);
});
test('lost stage and activation ACKs survive restart; activating state fences reads until exact-version reconciliation',async t=>{
  const f=setup(t);const flow=await f.begin();f.state.lostStage=true;await assert.rejects(f.finish(flow),{code:'secret_unavailable'});
  const secondStore=new BrokerStore(f.filename);t.after(()=>secondStore.close());f.reopen(secondStore);
  assert.equal((await f.status(flow)).data.status,'staged');assert.equal(f.state.codes,1);
  f.state.lostActivate=true;await assert.rejects(f.activate(flow),{code:'secret_unavailable'});
  assert.throws(()=>f.store.connection('connection:test'),{code:'connection_blocked'});
  f.reopen(secondStore);assert.equal((await f.status(flow)).data.status,'active');assert.equal(f.store.connection('connection:test').state,'active');assert.equal(f.state.activated,1);
  assert.equal(f.state.calls.filter(c=>c.kind==='PutSecretValueCommand').length,1);assert.equal(f.state.calls.filter(c=>c.kind==='UpdateSecretVersionStageCommand').length,1);
});
test('failed final audit keeps durable staging/activation states recoverable and never reuses the OAuth code',async t=>{
  const f=setup(t);const flow=await f.begin();const append=f.store.appendAudit.bind(f.store);let failReason='oauth_credentials_staged';
  f.store.appendAudit=e=>{if(e.reason===failReason)throw Error('FICTITIOUS_SQL_FAILURE');return append(e);};
  await assert.rejects(f.finish(flow));assert.equal(f.state.codes,1);failReason='';assert.equal((await f.status(flow)).data.status,'staged');
  failReason='oauth_credentials_activated';await assert.rejects(f.activate(flow));assert.throws(()=>f.store.connection('connection:test'),{code:'connection_blocked'});
  failReason='';assert.equal((await f.status(flow)).data.status,'active');assert.equal(f.state.codes,1);f.store.appendAudit=append;
});
test('concurrent callbacks cannot double exchange; revoked asset or missing PKCE after restart never falls back',async t=>{
  const f=setup(t);const flow=await f.begin();let release;const held=new Promise(resolve=>{release=resolve;});f.state.beforeToken=()=>held;
  const inFlight=f.finish(flow);await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.finish(flow),{code:'oauth_flow_busy'});release();await inFlight;assert.equal(f.state.codes,1);
  await f.execute(REVOKE_OPERATION,{}, {},'revoke');await assert.rejects(f.activate(flow),{code:'asset_revoked'});assert.equal((await f.status(flow)).data.accessBlocked,true);
  const other=setup(t);const pending=await other.begin();other.reopen();await assert.rejects(other.finish(pending),{code:'oauth_flow_interrupted'});assert.equal(other.state.codes,0);
});
test('Google runtime requires a third distinct principal/key and reviewed OAuth bindings',t=>{
  const f=setup(t);const config={cohort:'google-business-profile-read-v1',enabled:true,policy:f.policy,listenAddress:'127.0.0.1',port:10443,
    stateFile:f.filename,tlsCertFile:f.dir+'/tls.crt',tlsKeyFile:f.dir+'/tls.key',cursorKeyFile:f.dir+'/cursor.key'};
  runtime.validateConfig(config);
  for(const mutate of [c=>{c.policy.principals[1].publicKey=c.policy.principals[0].publicKey;},c=>{delete c.policy.connections[0].oauth;},
    c=>{c.policy.connections[0].oauth.redirectUri='https://auth.example.invalid/other';},c=>{c.policy.connections[0].oauth.scopes=['openid'];}]){
    const bad=structuredClone(config);mutate(bad);assert.throws(()=>runtime.validateConfig(bad),{code:'invalid_request'});
  }
});
test('aborting a lost begin creates a durable tombstone that rejects its late arrival', async t => {
  const f = setup(t); const flowId = randomUUID();
  assert.equal((await f.execute(OPERATIONS.abort, { flowId })).data.status, 'aborted');
  f.reopen();
  assert.equal((await f.execute(OPERATIONS.status, { flowId })).data.status, 'aborted');
  await assert.rejects(f.execute(OPERATIONS.begin, { state: randomBytes(32).toString('base64url') }, { requestId: flowId }));
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.codes, 0);
});
test('actual TLS OAuth runtime and API transport complete a pinned flow across a broker restart', async t => {
  const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
  const { execFileSync } = require('node:child_process'); const { allowPort, removePort } = require('./offline-guard.cjs');
  const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
  const f = setup(t); const cert = path.join(f.dir, 'oauth.crt'); const key = path.join(f.dir, 'oauth.key'); const cursor = path.join(f.dir, 'cursor.key');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], { stdio:'ignore' });
  fs.chmodSync(key,0o600); fs.chmodSync(cert,0o600); fs.writeFileSync(cursor,randomBytes(32),{mode:0o600});
  const probe = net.createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve)); allowPort(port);
  const config={cohort:'google-business-profile-read-v1',enabled:true,policy:f.policy,listenAddress:'127.0.0.1',port,
    stateFile:path.join(f.dir,'oauth-runtime.sqlite'),tlsCertFile:cert,tlsKeyFile:key,cursorKeyFile:cursor};
  const filename=path.join(f.dir,'oauth-runtime.json'); fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  const options={awsFactory:async()=>({secrets:f.client,sink:{write:async row=>({digest:row.digest,versionId:'fictitious-audit'})},close(){}}),http:f.http};
  let app=await runtime.main(filename,options); t.after(async()=>{if(app)await app.close();removePort(port);});
  const client=createIntegrationsBrokerClient({origin:`https://127.0.0.1:${port}`,audience:f.policy.audience,keyId:'qa-oauth',
    privateKey:f.oauthKey.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cert)});
  const execute=(name,payload,requestId=randomUUID())=>client.execute({requestId,operation:OPERATIONS[name],tenantRef:'clinic:123',connectionRef:'connection:test',assetRef:'gbp:123:456',payload});
  const state=randomBytes(32).toString('base64url'); const started=await execute('begin',{state}); const flowId=started.data.flowId;
  assert.equal((await execute('finish',{flowId,state,code:'FICTITIOUS_CODE'})).data.status,'staged');
  await app.close();app=null;app=await runtime.main(filename,options);
  assert.equal((await execute('activate',{flowId})).data.status,'active'); assert.equal((await execute('status',{flowId})).data.status,'active');
  assert.equal(f.state.codes,1); assert.equal(f.state.calls.filter(c=>c.kind==='PutSecretValueCommand').length,1);
  await assert.rejects(execute('finish',{flowId,state:randomBytes(32).toString('base64url'),code:'FICTITIOUS_CODE'}),{code:'oauth_state_invalid'});
});
