'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {admissionFixture}=require('./meta-marketing-admission-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),E=require('../src/meta-marketing-enrollment-contract');
const A=require('../src/meta-marketing-ads-contract'),M=require('../src/meta-marketing-contract'),L=require('../src/meta-marketing-leads-contract');
const P=require('../src/meta-marketing-admission-contract');
const REF='meta-ad_account:301',SCOPES=['clinic:123'];
async function ready(t,{optin=true,activate=true,selected=[REF],epochs=false}={}){
  const state={calls:0,before:null};
  const adsHttp={async read(input){state.calls++;assert.equal(input.asset.assetRef,REF);assert.equal(input.operation,A.OPERATIONS.campaigns);
    input.authorize();await state.before?.(input);input.authorize();
    return {results:[{id:'601',name:'Fictitious Ads-only campaign',status:'ACTIVE'}],nextPageToken:null,
      usage:{usagePct:0,nextAllowedAt:0,pauseUntil:0}};}};
  const fixture=admissionFixture(t,{discovery:true,discoveryScopeKeys:SCOPES,enrollment:true,enrollmentScopeKeys:SCOPES,
    ...(optin?{adsReadScopeKeys:SCOPES}:{}),adsHttp,credentialEpochs:epochs});
  const prepared=fixture.command();await fixture.prepare(prepared);
  const begin=fixture.beginCommand(prepared);await fixture.execute(begin);
  const send=(operation,payload,role=false,handle=fixture.current,changes={})=>fixture.execute({...prepared,
    requestId:randomUUID(),operation,payload,...changes},handle,role);
  const staged=await send(C.OPERATIONS.finish,{flowId:begin.requestId,state:begin.payload.state,code:'FICTITIOUS_ADS_ONLY_CODE'});
  const selection={enrollmentId:randomUUID(),flowId:begin.requestId,scopeDigest:begin.payload.scopeDigest,
    candidateDigest:staged.data.candidate.digest,assetRefs:selected};
  const pending=(await send(E.OPERATIONS.prepare,selection)).data;
  if(activate)await send(E.OPERATIONS.activate,{enrollmentId:selection.enrollmentId,scopeDigest:selection.scopeDigest,selectionDigest:pending.selectionDigest});
  const read=(changes={},role='reader',handle=fixture.current)=>send(A.OPERATIONS.campaigns,{pageToken:null},role,handle,{assetRef:REF,...changes});
  return {fixture,state,send,read,selection,begin,prepared};
}

test('Ads-only admitted reader uses one confirmed account with no leadAds/static Ads configuration or new grants',async t=>{
  const r=await ready(t),before=JSON.stringify(r.fixture.current.broker.policy);
  const response=await r.read();assert.equal(response.data.results[0].id,'601');assert.equal(r.state.calls,1);
  const secretsAfter=r.fixture.f.state.awsCalls.length;
  await assert.rejects(r.read({assetRef:'meta-ad_account:999'}),{code:'scope_denied'});
  assert.equal(r.state.calls,1);assert.equal(r.fixture.f.state.awsCalls.length,secretsAfter);
  assert.equal(JSON.stringify(r.fixture.current.broker.policy),before);
  assert.equal(r.fixture.f.config.leadAds,undefined);assert.equal(r.fixture.f.config.adsRead,undefined);
  const request={...r.prepared,operation:A.OPERATIONS.campaigns,assetRef:REF,payload:{pageToken:null}};
  const principal=r.fixture.current.broker.policy.principals.find(p=>p.id===E.roles('staging').reader);
  const resolved=r.fixture.current.admission.resolve(request,principal,r.fixture.current.broker.policy);
  assert.equal(resolved.connections.length,r.fixture.current.broker.policy.connections.length+1);
  assert.deepEqual(resolved.grants,r.fixture.current.broker.policy.grants,'admission supplies no reader grant');
  assert.equal(r.fixture.current.store.db.prepare("SELECT name FROM sqlite_schema WHERE name='meta_marketing_lead_receipts'").get(),undefined);
  const persisted=JSON.stringify(r.fixture.current.store.db.prepare('SELECT * FROM commands').all());
  assert(!persisted.includes('Fictitious Ads-only campaign'),'read results are not persisted');
  const events=r.fixture.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event))
    .filter(event=>event.correlationId===response.requestId);
  assert.equal(events.length,2);
  for(const event of events){assert.equal(event.connectionRef,r.prepared.connectionRef);assert.equal(event.operation,A.OPERATIONS.campaigns);
    assert.equal(event.tenantRef,r.prepared.tenantRef);assert.equal(event.resourceRef,REF);}
});

test('missing opt-in or an empty list is OFF even after a confirmed enrollment',async t=>{
  const r=await ready(t,{optin:false}),before=r.fixture.f.state.awsCalls.length;
  assert.equal(r.fixture.current.broker.operations[A.OPERATIONS.campaigns],undefined);
  await assert.rejects(r.read(),{code:'scope_denied'});assert.equal(r.state.calls,0);assert.equal(r.fixture.f.state.awsCalls.length,before);
  const off=r.fixture.make(undefined,{...r.fixture.settings,adsReadScopeKeys:[]});
  assert.equal(off.broker.operations[A.OPERATIONS.campaigns],undefined);
  await assert.rejects(r.read({},'reader',off),{code:'scope_denied'});assert.equal(r.state.calls,0);
});

test('a prepared selection, foreign account/tenant and gateway/control roles never authorize Ads work',async t=>{
  const r=await ready(t,{activate:false});
  const before=r.fixture.f.state.awsCalls.length;
  await assert.rejects(r.read(),{code:'scope_denied'});
  await assert.rejects(r.read({assetRef:'meta-ad_account:999'}),{code:'scope_denied'});
  await assert.rejects(r.read({tenantRef:'clinic:124'}),{code:'scope_denied'});
  for(const role of [false,true,'assetControl'])await assert.rejects(r.read({},role),{code:'scope_denied'});
  assert.equal(r.fixture.f.state.awsCalls.length,before);assert.equal(r.state.calls,0);
});

test('Ads-only does not grant selected Page metadata, forms, lead receipts, ingress or WhatsApp',async t=>{
  const r=await ready(t,{selected:[REF,'meta-facebook_page:401']}),before=r.fixture.f.state.awsCalls.length;
  await r.read();const after=r.fixture.f.state.awsCalls.length;
  for(const [operation,assetRef,payload]of [[M.ASSET,'meta-facebook_page:401',{}],[M.STATUS,REF,{}],
    [L.OPERATIONS.form,'meta-facebook_page:401',{adAccountAssetRef:REF,formId:'701'}],
    [L.OPERATIONS.receiptRead,'meta-facebook_page:401',{adAccountAssetRef:REF,receiptRef:randomUUID()}],
    [L.OPERATIONS.receiptAccept,'meta-facebook_page:401',{adAccountAssetRef:REF,rawBase64:'e30=',signature:'sha256='+'a'.repeat(64)}],
    [L.OPERATIONS.pageEnable,'meta-facebook_page:401',{adAccountAssetRef:REF,expectedSubscriptionRevision:'a'.repeat(64)}],
    ['meta.whatsapp.authorized.send.v1','wa-phone:123',{}]]){
    await assert.rejects(r.send(operation,payload,'reader',undefined,{assetRef}),error=>['scope_denied','operation_denied','invalid_request'].includes(error.code));
  }
  assert(after>before);assert.equal(r.fixture.f.state.awsCalls.length,after);assert.equal(r.state.calls,1);
});

test('revoked enrollments and physical tombstones deny without borrowing another credential',async t=>{
  for(const tombstone of [false,true]){
    const r=await ready(t);
    if(tombstone)r.fixture.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)')
      .run(r.prepared.tenantRef,r.prepared.connectionRef,REF,randomUUID(),r.fixture.f.now());
    else await r.send(E.OPERATIONS.revoke,{enrollmentId:r.selection.enrollmentId},true);
    const before=r.fixture.f.state.awsCalls.length;
    await assert.rejects(r.read(),{code:'asset_revoked'});assert.equal(r.state.calls,0);assert.equal(r.fixture.f.state.awsCalls.length,before);
  }
});

test('admission binding, reader key and connection blocks are re-resolved during Ads I/O',async t=>{
  for(const change of [
    r=>r.fixture.current.store.db.prepare('UPDATE meta_marketing_admission_slots SET expires_at=expires_at+1000 WHERE scope=?').run('clinic:123'),
    r=>{r.fixture.current.broker.policy.principals.find(p=>p.id===E.roles('staging').reader).enabled=false;},
    r=>r.fixture.current.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1 WHERE ref=?").run(r.prepared.connectionRef),
    r=>r.fixture.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run(r.prepared.tenantRef,r.prepared.connectionRef,REF,randomUUID(),r.fixture.f.now()),
  ]){
    const r=await ready(t);r.state.before=()=>change(r);
    await assert.rejects(r.read(),error=>['scope_denied','connection_blocked','asset_revoked'].includes(error.code));
    assert.equal(r.state.calls,1);
    const completed=r.fixture.current.store.db.prepare("SELECT count(*) n FROM commands WHERE principal=? AND state='completed'").get(E.roles('staging').reader).n;
    assert.equal(completed,0,'no completed read result after authority drift');
  }
});

test('credential expiry and epoch changes during I/O still prevent disclosure',async t=>{
  const expired=await ready(t);expired.state.before=()=>{expired.fixture.f.state.clock+=3600001;};
  await assert.rejects(expired.read(),{code:'credential_revoked'});assert.equal(expired.state.calls,1);
  const r=await ready(t,{epochs:true});
  r.state.before=()=>{
    // Owned fault injection: a valid epoch pointer to the original held
    // version appears during the read. No production database is loaded.
    const db=r.fixture.current.store.db,row=db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(r.selection.enrollmentId);
    const flow=db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(row.flow);
    const label=require('../src/meta-marketing-credential-renewal-contract').retentionStage(row.id,flow.id);
    db.prepare("INSERT INTO meta_marketing_credential_protections VALUES (?,?,?,?,'held',?,?)").run(row.id,flow.id,label,flow.secret_digest,r.fixture.f.now(),r.fixture.f.now());
    db.prepare('INSERT INTO meta_marketing_effective_credentials VALUES (?,1,?,?,?,?,?)').run(row.id,flow.id,flow.secret_digest,flow.credential_metadata,flow.id,r.fixture.f.now());
  };
  await assert.rejects(r.read(),{code:'secret_version_changed'});assert.equal(r.state.calls,1);
});

test('Ads opt-in is a closed sorted subset of enrollment; new settings do not alter historical binding fingerprints',t=>{
  const f=admissionFixture(t,{enrollment:true,enrollmentScopeKeys:SCOPES}),runtime=require('../src/meta-marketing-oauth-main');
  const old=P.settingsDigest(f.settings),config={...f.f.config,admission:{...f.settings,adsReadScopeKeys:SCOPES}};
  runtime.validateConfig(config);assert.equal(P.settingsDigest(config.admission),old);
  runtime.validateConfig({...config,admission:{...config.admission,adsReadScopeKeys:[]}});
  for(const mutate of [
    x=>{x.admission.adsReadScopeKeys=['clinic:124'];},x=>{x.admission.adsReadScopeKeys=['clinic:123','clinic:123'];},
    x=>{x.admission.adsReadScopeKeys=['clinic:124','clinic:123'];},x=>{delete x.admission.enrollmentScopeKeys;},
    x=>{x.admission.scopes=x.admission.scopes.filter(v=>v!=='ads_read');},x=>{x.assetEnrollment=false;},
    x=>{x.admission.adsReadScopeKeys=true;},x=>{x.admission.extraRead=true;},
    x=>{const binding=x.policy.connections[0];binding.metaMarketingOAuth.scopeKey='clinic:123';binding.metaMarketingOAuth.clinicIds=[123];
      for(const grant of x.policy.grants.filter(g=>g.connectionRef===binding.connectionRef)){grant.tenantRef='clinic:123';grant.assetRef='meta-enroll:clinic:123';}},
    x=>{const binding=x.policy.connections[0],old=binding.connectionRef;binding.connectionRef=P.connectionRef('clinic:123');
      for(const grant of x.policy.grants.filter(g=>g.connectionRef===old))grant.connectionRef=binding.connectionRef;},
  ]){const bad=structuredClone(config);mutate(bad);assert.throws(()=>runtime.validateConfig(bad),{code:'invalid_request'});}
});

test('an admitted scope option cannot bypass the original static account cohort',async t=>{
  const f=require('./meta-marketing-oauth-fixture.cjs').fixture(t,{enrollment:true});
  const flow=await f.begin(),candidate=(await f.finish(flow)).data.candidate,id=randomUUID();
  const pending=(await f.execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,
    candidateDigest:candidate.digest,assetRefs:[REF]})).data;
  await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:flow.payload.scopeDigest,selectionDigest:pending.selectionDigest});
  const enrollment=require('../src/meta-marketing-enrollment').createMetaMarketingEnrollment({store:f.current.store,secrets:f.secrets,
    http:f.http,environment:'staging',now:f.now,admissionAdsReadScopeKeys:['group:9'],resolvePolicy:(_r,_p,policy)=>policy,
    adsHttp:{read:()=>assert.fail('static connection must not obtain new reader authority')}});
  t.after(()=>enrollment.close());
  const broker=new(require('../src/broker').Broker)({store:f.current.store,secrets:f.secrets,policy:f.policy,
    policyResolver:enrollment,operations:enrollment.operations,now:f.now});
  const before=f.state.awsCalls.length;
  await assert.rejects(f.execute(A.OPERATIONS.campaigns,{pageToken:null},{assetRef:REF},'reader',{broker}),{code:'scope_denied'});
  assert.equal(f.state.awsCalls.length,before);
});

test('actual opt-in runtime wires typed Ads HTTP without static assets or lead capabilities',async t=>{
  const r=await ready(t),f=r.fixture.f,fs=require('node:fs'),net=require('node:net');
  const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
  const config={...f.config,admission:r.fixture.settings,stateFile:f.dir+'/admission.sqlite'};
  require('node:child_process').execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,
    '-out',config.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));config.port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const filename=f.dir+'/admission-ads-runtime.json';fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  let calls=0;
  const adsRequest=(options,callback)=>{
    const url=new URL('https://graph.facebook.com'+options.path);
    if(url.pathname.endsWith('/debug_token'))return f.request(options,callback);
    const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
      calls++;assert.equal(options.method,'GET');assert.equal(url.pathname,'/v24.0/act_301/campaigns');
      assert.equal(url.searchParams.get('fields'),A.FIELDS.campaigns);
      const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};
      callback(response);response.end(JSON.stringify({data:[{id:'601',name:'Fictitious runtime Ads',status:'ACTIVE'}]}));
    });return req;
  };
  const runtime=await require('../src/meta-marketing-oauth-main').main(filename,{
    awsFactory:async()=>({secrets:r.fixture.aws,sink:{write:async row=>({versionId:'FICTITIOUS_AUDIT_VERSION',digest:row.digest})},close(){}}),
    http:f.http,adsRequest,adsNow:f.now,adsWait:async ms=>{f.state.clock+=ms;},
  });
  try{
    assert.equal(config.adsRead,undefined);assert.equal(config.leadAds,undefined);
    assert(runtime.broker.operations[A.OPERATIONS.campaigns]);assert.equal(runtime.broker.operations[L.OPERATIONS.form],undefined);
    const signed=f.signed({...r.prepared,requestId:randomUUID(),operation:A.OPERATIONS.campaigns,assetRef:REF,payload:{pageToken:null}},'reader');
    const response=await runtime.broker.execute(signed.raw,signed.headers);
    assert.equal(response.data.results[0].id,'601');assert.equal(calls,1);
  }finally{await runtime.close();}
});
