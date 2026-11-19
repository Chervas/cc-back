'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {admissionFixture}=require('./meta-marketing-admission-fixture.cjs');
const {TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),D=require('../src/meta-marketing-discovery-contract');
const P=require('../src/meta-marketing-admission-contract'),E=require('../src/meta-marketing-enrollment-contract');
const runtime=require('../src/meta-marketing-oauth-main');
const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient');
const {allowPort,removePort}=require('./offline-guard.cjs');

async function ready(t,{discoveryScopeKeys=['clinic:123'],scope='clinic:123',clinicIds=[123]}={}){
  const p=admissionFixture(t,{discovery:true,discoveryScopeKeys}),cmd=p.command(scope,clinicIds);await p.prepare(cmd);
  const flow=p.beginCommand(cmd);await p.execute(flow);
  await p.execute({...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,
    payload:{flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_DYNAMIC_DISCOVERY_CODE'}});
  return {p,cmd,flow};
}
const command=({cmd,flow},payload={})=>({...cmd,requestId:randomUUID(),operation:D.OPERATION,
  payload:{flowId:flow.requestId,scopeDigest:flow.payload.scopeDigest,...payload}});
const events=p=>p.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event));

test('an explicitly admitted scope discovers typed metadata with fresh dynamic authorization and no activation',async t=>{
  const context=await ready(t),{p,flow}=context;
  let checks=0;const resolve=p.current.admission.resolve;
  p.current.admission.resolve=(...args)=>{checks++;return resolve(...args);};
  const awsBefore=p.state.calls.length,graphBefore=p.f.state.httpCalls.length,puts=p.f.state.puts;
  const result=await p.execute(command(context));assert.equal(result.data.flowId,flow.requestId);assert.equal(result.data.accessBlocked,true);
  assert.deepEqual(result.data.availableKinds,['ad_account','facebook_page','instagram_business']);assert.equal(result.data.assets.length,3);
  assert.equal(result.data.assets.find(asset=>asset.kind==='instagram_business').parentPageId,'401');
  assert(checks>4,'Resolver must run again throughout vault/Graph and final result guards');
  assert.deepEqual(p.f.state.httpCalls.slice(graphBefore).map(call=>call.kind),['inspect','adaccounts','accounts','inspect']);
  assert.equal(p.f.state.puts,puts);assert(!p.state.calls.slice(awsBefore).some(call=>/Put|Create/.test(call.constructor.name)));
  const inventoryEvents=events(p).filter(event=>event.operation===D.OPERATION);
  assert.deepEqual(inventoryEvents.map(event=>event.action),['integration.requested','integration.completed']);
  for(const secret of [TOKEN,APP,flow.payload.state,'FICTITIOUS_DYNAMIC_DISCOVERY_CODE'])assert(!JSON.stringify([result,inventoryEvents]).includes(secret));
  assert.equal(p.current.store.db.prepare('SELECT state FROM meta_marketing_oauth_flows WHERE id=?').get(flow.requestId).state,'staged');
  assert.equal(p.current.store.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name='meta_marketing_enrollments'").get().n,0);
  assert.equal(JSON.stringify(p.f.policy),p.originalPolicy);
});

test('dynamic begin/finish audit retains exact signed scope while legacy audit and public replies remain unchanged',async t=>{
  const {p,cmd,flow}=await ready(t),oauth=events(p).filter(event=>[C.OPERATIONS.begin,C.OPERATIONS.finish].includes(event.operation));
  assert.deepEqual(oauth.map(event=>[event.action,event.operation]),[
    ['integration.requested',C.OPERATIONS.begin],['integration.completed',C.OPERATIONS.finish]]);
  for(const event of oauth){
    assert.equal(event.connectionRef,cmd.connectionRef);assert.equal(event.tenantRef,cmd.tenantRef);assert.equal(event.resourceRef,cmd.assetRef);
    assert.equal(event.actorId,'gateway:staging:meta-marketing-oauth');assert.equal(event.policyVersion,p.f.policy.version);
  }
  const hidden=[TOKEN,APP,flow.payload.state,'FICTITIOUS_DYNAMIC_DISCOVERY_CODE',p.slots()[0].arn];
  for(const secret of hidden)assert(!JSON.stringify(oauth).includes(secret));
  const legacy=await p.f.begin(),completed=await p.f.finish(legacy);
  assert.deepEqual(Object.keys(legacy.result.data).sort(),['flowId','authUrl','expiresAt'].sort());
  assert.equal(legacy.result.data.flowId,legacy.flowId);assert.equal(completed.data.status,'staged');assert.equal(completed.data.accessBlocked,true);
  const previous=p.f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event))
    .filter(event=>[C.OPERATIONS.begin,C.OPERATIONS.finish].includes(event.operation));
  assert.deepEqual(previous.map(event=>[event.action,event.operation,event.tenantRef,event.connectionRef,event.resourceRef]),[
    ['integration.requested',C.OPERATIONS.begin,'clinic:71',p.f.binding.connectionRef,'meta-enroll:group:9'],
    ['integration.completed',C.OPERATIONS.finish,'clinic:71',p.f.binding.connectionRef,'meta-enroll:group:9']]);
  assert.equal(JSON.stringify(p.f.policy),p.originalPolicy);
});

test('scope opt-in is required even when discovery exists in the runtime; control stays closed',async t=>{
  for(const discoveryScopeKeys of [undefined,[],['clinic:124']])await t.test(JSON.stringify(discoveryScopeKeys),async t=>{
    // Passing undefined explicitly must exercise a missing optional capability.
    const p=admissionFixture(t,{discovery:true,discoveryScopeKeys}),cmd=p.command();await p.prepare(cmd);
    const flow=p.beginCommand(cmd);await p.execute(flow);
    await p.execute({...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,payload:{flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_NOT_OPTED_IN'}});
    const before=[p.state.calls.length,p.f.state.httpCalls.length];
    await assert.rejects(p.execute(command({cmd,flow})),{code:'scope_denied'});
    assert.deepEqual([p.state.calls.length,p.f.state.httpCalls.length],before);
  });
  const context=await ready(t),{p}=context,before=[p.state.calls.length,p.f.state.httpCalls.length];
  await assert.rejects(p.execute(command(context),p.current,true),{code:'scope_denied'});
  await assert.rejects(p.execute({...context.cmd,requestId:randomUUID(),operation:E.OPERATIONS.prepare,payload:{}}),{code:'scope_denied'});
  assert.deepEqual([p.state.calls.length,p.f.state.httpCalls.length],before);
});

test('discovery capability changes preserve binding identity and static discovery retains its original behavior',async t=>{
  const {p,cmd}=await ready(t),original=p.current.admission.resolveBinding(cmd.connectionRef);
  const without=p.make(undefined,{...p.settings,discoveryScopeKeys:[]});
  assert.deepEqual(without.admission.resolveBinding(cmd.connectionRef),original);
  assert.equal(P.settingsDigest(p.settings),P.settingsDigest({...p.settings,discoveryScopeKeys:[]}));
  const legacy=await p.f.begin();await p.f.finish(legacy);
  const result=await p.f.execute(D.OPERATION,{flowId:legacy.flowId,scopeDigest:legacy.payload.scopeDigest});
  assert.equal(result.data.assets.length,3);assert.equal(result.data.accessBlocked,true);
  assert.equal(JSON.stringify(p.f.policy),p.originalPolicy);
});

test('a changed group clinic set during discovery cannot return an inventory for the previous fingerprint',async t=>{
  const context=await ready(t,{scope:'group:12',clinicIds:[123,124],discoveryScopeKeys:['group:12']}),{p}=context;
  p.f.state.afterGraph=(kind,value)=>{
    if(kind==='adaccounts')p.current.store.db.prepare('UPDATE meta_marketing_admission_slots SET clinic_ids=? WHERE scope=?').run('[123,124,125]','group:12');
    return value;
  };
  await assert.rejects(p.execute(command(context)),{code:'scope_denied'});
  assert(!events(p).some(event=>event.operation===D.OPERATION&&event.action==='integration.completed'));
});

for(const change of ['revocation','connection block','principal disabled','principal key changed','slot fingerprint','flow scope digest','new dynamic overlap']){
  test('late '+change+' closes dynamic discovery before returning provider data',async t=>{
    const context=await ready(t),{p,cmd,flow}=context;
    let changed=false;
    p.f.state.afterGraph=(kind,value)=>{
      if(kind!=='adaccounts'||changed)return value;changed=true;
      if(change==='revocation')p.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run(cmd.tenantRef,cmd.connectionRef,cmd.assetRef,randomUUID(),p.f.now());
      if(change==='connection block')p.current.store.db.prepare("UPDATE connections SET state='blocked' WHERE ref=?").run(cmd.connectionRef);
      if(change==='principal disabled')p.current.broker.policy.principals[0].enabled=false;
      if(change==='principal key changed')p.current.broker.policy.principals[0].publicKey=p.current.broker.policy.principals[1].publicKey;
      if(change==='slot fingerprint')p.current.store.db.prepare('UPDATE meta_marketing_admission_slots SET expires_at=expires_at+1 WHERE scope=?').run(cmd.payload.scopeKey);
      if(change==='flow scope digest')p.current.store.db.prepare('UPDATE meta_marketing_oauth_flows SET scope_digest=? WHERE id=?').run('f'.repeat(64),flow.requestId);
      if(change==='new dynamic overlap')p.current.store.db.prepare("INSERT INTO meta_marketing_admission_slots VALUES (?,?,?,?,?,?,NULL,'preparing',?,?)")
        .run('group:12',P.connectionRef('group:12'),'[123,124]',P.settingsDigest(p.settings),randomUUID(),P.prefix('staging')+'group-12/candidate',p.f.now(),p.f.now()+86400000);
      return value;
    };
    await assert.rejects(p.execute(command(context)),error=>{
      assert(['scope_denied','connection_blocked','asset_revoked'].includes(error.code));
      for(const secret of [TOKEN,APP,flow.payload.state])assert(!String(error.stack).includes(secret));return true;
    });
    assert.equal(changed,true);assert(!events(p).some(event=>event.operation===D.OPERATION&&event.action==='integration.completed'));
  });
}

test('revocation of a member clinic during group discovery remains authoritative',async t=>{
  const context=await ready(t,{scope:'group:12',clinicIds:[123,124],discoveryScopeKeys:['group:12']}),{p,cmd}=context;
  p.f.state.afterGraph=(kind,value)=>{
    if(kind==='adaccounts')p.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)')
      .run('clinic:124',cmd.connectionRef,'meta-enroll:clinic:124',randomUUID(),p.f.now());
    return value;
  };
  await assert.rejects(p.execute(command(context)),{code:'asset_revoked'});
  assert(!events(p).some(event=>event.operation===D.OPERATION&&event.action==='integration.completed'));
});

test('revocation during the candidate vault read denies discovery before a Graph request',async t=>{
  const context=await ready(t),{p,cmd,flow}=context,graphBefore=p.f.state.httpCalls.length;
  p.state.after=(aws,result)=>{
    if(aws.constructor.name==='GetSecretValueCommand'&&aws.input.VersionId===flow.requestId)
      p.current.store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)').run(cmd.tenantRef,cmd.connectionRef,cmd.assetRef,randomUUID(),p.f.now());
    return result;
  };
  await assert.rejects(p.execute(command(context)),{code:'asset_revoked'});
  assert.equal(p.f.state.httpCalls.length,graphBefore);
  assert(!events(p).some(event=>event.operation===D.OPERATION&&event.action==='integration.completed'));
});

test('a block in the last provider response denies the final inventory and completed audit',async t=>{
  const context=await ready(t),{p,cmd}=context;let inspections=0;
  p.f.state.afterGraph=(kind,value)=>{
    if(kind==='inspect'&&++inspections===2)p.current.store.db.prepare("UPDATE connections SET state='blocked' WHERE ref=?").run(cmd.connectionRef);
    return value;
  };
  await assert.rejects(p.execute(command(context)),{code:'connection_blocked'});
  assert.equal(inspections,2);assert(!events(p).some(event=>event.operation===D.OPERATION&&event.action==='integration.completed'));
});

test('capability schema is optional, bounded, unique, scoped and identity-neutral',async t=>{
  const p=admissionFixture(t,{discovery:true}),base=P.settingsDigest(p.settings);
  for(const discoveryScopeKeys of [[],['clinic:123']])assert.equal(P.settingsDigest({...p.settings,discoveryScopeKeys}),base);
  for(const discoveryScopeKeys of [null,'clinic:123',['clinic:999'],['clinic:123','clinic:123'],['clinic:124','clinic:123']]){
    assert.throws(()=>P.validateSettings({...p.settings,discoveryScopeKeys}),{code:'invalid_request'});
  }
  const config=structuredClone(p.f.config);config.admission={...p.settings,discoveryScopeKeys:['clinic:123']};
  delete config.assetDiscovery;assert.throws(()=>runtime.validateConfig(config),{code:'invalid_request'});
});

test('real TLS runtime resolves admitted discovery after restart and keeps enrollment/control closed',async t=>{
  const p=admissionFixture(t,{discovery:true,discoveryScopeKeys:['clinic:123']}),config=structuredClone(p.f.config);config.admission=p.settings;
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,
    '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));config.port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));allowPort(config.port);
  const filename=path.join(p.f.dir,'admission-discovery-runtime.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  const awsFactory=async()=>({secrets:p.aws,sink:{write:async row=>({versionId:'FICTITIOUS_AUDIT_VERSION',digest:row.digest})},close(){}});
  let app=await runtime.main(filename,{awsFactory,http:p.f.http});
  t.after(async()=>{if(app)await app.close();removePort(config.port);});
  const client=control=>createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+config.port,audience:config.policy.audience,
    keyId:control?'qa-control':'qa-gateway',privateKey:(control?p.f.control:p.f.gateway).privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(config.tlsCertFile)});
  const gateway=client(false),control=client(true),cmd=p.command();await gateway.execute(cmd);
  const flow=p.beginCommand(cmd);await gateway.execute(flow);
  await gateway.execute({...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,payload:{flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_TLS_DISCOVERY_CODE'}});
  await app.close();app=await runtime.main(filename,{awsFactory,http:p.f.http});
  const result=await gateway.execute(command({cmd,flow}));assert.equal(result.data.assets.length,3);assert.equal(result.data.accessBlocked,true);
  await assert.rejects(control.execute(command({cmd,flow})),{code:'scope_denied'});
  await assert.rejects(gateway.execute({...cmd,requestId:randomUUID(),operation:E.OPERATIONS.prepare,payload:{}}),{code:'scope_denied'});
  assert.equal(JSON.stringify(config.policy),p.originalPolicy);
});
