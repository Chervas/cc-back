'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {admissionFixture}=require('./meta-marketing-admission-fixture.cjs');
const {createMetaMarketingAdmission}=require('../src/meta-marketing-admission');
const P=require('../src/meta-marketing-admission-contract'),C=require('../src/meta-marketing-oauth-contract');
const D=require('../src/meta-marketing-discovery-contract'),E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract');
const {TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');

test('absent or explicitly disabled admission performs no storage or AWS access',()=>{
  const closed=new Proxy({},{get(){assert.fail('DISABLED_ADMISSION_EFFECT');}});
  for(const settings of [undefined,{enabled:false}])assert.equal(createMetaMarketingAdmission({store:closed,policy:closed,settings,client:closed}),null);
});

test('preparation journals one empty slot and a real OAuth flow stages after restart without static admission',async t=>{
  const p=admissionFixture(t),cmd=p.command(),prepared=await p.prepare(cmd);
  assert.equal(prepared.replayed,false);assert.equal(prepared.data.status,'prepared');assert.equal(prepared.data.connected,false);
  assert.deepEqual(Object.keys(prepared.data.binding).sort(),['appId','assetRef','clinicIds','connectionRef','expiresAt','redirectUri','scopeKey','scopes'].sort());
  assert.equal(p.state.creates,1);assert.equal(p.f.state.codes,0);
  const [row]=p.slots();assert.equal(row.state,'ready');assert.equal(row.connection,cmd.connectionRef);
  assert(C.uuid(row.version_id));assert.equal(row.expires_at,p.f.now()+p.settings.slotTtlMs);
  assert.equal((await p.prepare(cmd)).replayed,true);assert.equal(p.state.creates,1);
  assert.equal(p.current.store.db.prepare('SELECT count(*) n FROM audit_outbox').get().n,2);
  p.current.close();const restarted=p.make(),flow=p.beginCommand(cmd);
  const awaiting=await p.execute(flow,restarted);assert.equal(awaiting.data.flowId,flow.requestId);
  assert.equal(restarted.store.db.prepare('SELECT state FROM meta_marketing_oauth_flows WHERE id=?').get(flow.requestId).state,'awaiting');
  const finish={...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,
    payload:{flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_AUTOMATIC_META_CODE'}};
  const staged=await p.execute(finish,restarted);assert.equal(staged.data.status,'staged');assert.equal(staged.data.accessBlocked,true);
  assert.equal(p.f.state.codes,1);assert.equal(p.f.state.puts,1);
  const status={...cmd,requestId:randomUUID(),operation:C.OPERATIONS.status,payload:{flowId:flow.requestId}};
  assert.equal((await p.execute(status,restarted,true)).data.status,'staged');
  assert.equal((await p.execute({...status,requestId:randomUUID(),operation:C.OPERATIONS.abort},restarted,true)).data.status,'aborted');
  const events=restarted.store.db.prepare('SELECT event FROM audit_outbox').all();
  for(const secret of [TOKEN,APP,row.arn,finish.payload.code,flow.payload.state]){
    assert(!JSON.stringify(prepared).includes(secret));assert(!JSON.stringify(events).includes(secret));
  }
  assert.equal(JSON.stringify(p.f.policy),p.originalPolicy);
});

test('three existing static bundles retain exact policy bytes and their existing OAuth grant',async t=>{
  const p=admissionFixture(t),cmd=p.command();await p.prepare(cmd);
  assert.equal(p.f.policy.connections.length,3);assert.equal(p.f.policy.grants.length,6);
  const principal=p.f.policy.principals[0];
  for(const binding of p.f.policy.connections){
    const request={...cmd,connectionRef:binding.connectionRef,assetRef:'meta-enroll:'+binding.metaMarketingOAuth.scopeKey,
      tenantRef:'clinic:'+binding.metaMarketingOAuth.clinicIds[0],operation:C.OPERATIONS.begin};
    assert.equal(p.current.admission.resolve(request,principal,p.f.policy),p.f.policy);
  }
  const existing=await p.f.begin();assert.equal(existing.result.data.flowId,existing.flowId);
  assert.equal(JSON.stringify(p.f.policy),p.originalPolicy);
});

test('dynamic policy derives only gateway OAuth and control receipt/cancellation authority',async t=>{
  const p=admissionFixture(t),cmd=p.command();await p.prepare(cmd);
  const resolved=p.current.admission.resolve({...cmd,operation:C.OPERATIONS.status,payload:{flowId:randomUUID()}},p.f.policy.principals[0],p.f.policy);
  const grants=resolved.grants.filter(grant=>grant.connectionRef===cmd.connectionRef);
  assert.equal(grants.length,2);
  assert.deepEqual([...grants.find(grant=>grant.principalId.startsWith('gateway:')).operations].sort(),Object.values(C.OPERATIONS).sort());
  assert.deepEqual([...grants.find(grant=>grant.principalId.startsWith('control:')).operations].sort(),[C.OPERATIONS.status,C.OPERATIONS.abort].sort());
  for(const operation of [D.OPERATION,E.OPERATIONS.prepare,M.ASSET,'meta.whatsapp.text.send.v1']){
    await assert.rejects(p.execute({...cmd,requestId:randomUUID(),operation,payload:{}}));
  }
  await assert.rejects(p.execute(p.beginCommand(cmd),p.current,true),{code:'scope_denied'});
  assert.equal(p.f.state.codes,0);assert.equal(p.f.state.puts,0);
  assert.equal(JSON.stringify(p.f.policy),p.originalPolicy);
});

test('principal, exact request, allowlist, clinic set and expiry are enforced before AWS',async t=>{
  const p=admissionFixture(t);await assert.rejects(p.prepare(p.command(),p.current,true),{code:'scope_denied'});
  for(const mutate of [cmd=>{cmd.tenantRef='clinic:999';},cmd=>{cmd.connectionRef='untrusted';},
    cmd=>{cmd.payload.secretArn='UNTRUSTED';},cmd=>{cmd.payload.expiresAt=p.f.now();},cmd=>{cmd.payload.expiresAt=p.f.now()+1800001;},
    cmd=>{cmd.payload.clinicIds=[124];},cmd=>{cmd.payload.clinicSetDigest='0'.repeat(64);},cmd=>{cmd.payload.scopeDigest='x';}]){
    const cmd=p.command();mutate(cmd);await assert.rejects(p.prepare(cmd));
  }
  await assert.rejects(p.prepare(p.command('clinic:999',[999])));
  await assert.rejects(p.prepare(p.command('group:12',[124,123])));
  await assert.rejects(p.prepare(p.command('group:9',[71,72])));
  await assert.rejects(p.prepare(p.command('group:12',[71,123])));
  assert.equal(p.state.creates,0);assert.equal(p.slots().length,0);
});

test('lost CreateSecret acknowledgement and concurrent owners converge on one durable version',async t=>{
  const p=admissionFixture(t),cmd=p.command();p.state.loseCreate=true;
  const other=p.make(),responses=await Promise.all([p.prepare(cmd),p.prepare(cmd,other)]);
  assert(responses.every(value=>value.data.status==='prepared'));assert.equal(p.metadata.size,1);assert.equal(p.slots().length,1);
  const [row]=p.slots();assert.equal(p.f.records.get(row.arn).size,1);
  assert.equal(responses.filter(value=>!value.replayed).length,1);
  assert.equal(p.current.store.db.prepare('SELECT count(*) n FROM audit_outbox').get().n,2);
});

test('failed AWS leaves a recoverable preparing journal without active connection or leaked error',async t=>{
  const p=admissionFixture(t),cmd=p.command();p.state.denied=true;
  await assert.rejects(p.prepare(cmd),{code:'secret_unavailable',message:'secret_unavailable'});
  assert.equal(p.slots()[0].state,'preparing');
  assert.equal(p.current.store.db.prepare('SELECT count(*) n FROM connections WHERE ref=?').get(cmd.connectionRef).n,0);
  const version=p.slots()[0].version_id;p.current.close();p.state.denied=false;
  const restarted=p.make();assert.equal((await p.prepare(cmd,restarted)).data.status,'prepared');
  assert.equal(p.slots(restarted)[0].version_id,version);assert.equal(p.state.creates,1);assert.equal(p.f.state.codes,0);
});

test('idempotency, dynamic clinic footprints and capacity remain fenced across preparations',async t=>{
  const p=admissionFixture(t),onlyOne=p.make(undefined,{...p.settings,maxConnections:1});
  const cmd=p.command();await p.prepare(cmd,onlyOne);
  await assert.rejects(p.prepare(p.command('clinic:124',[124],{requestId:cmd.requestId}),onlyOne),{code:'idempotency_conflict'});
  await assert.rejects(p.prepare(p.command('clinic:124',[124]),onlyOne),{code:'rate_limited'});
  await assert.rejects(p.prepare(p.command('group:12',[123,124]),onlyOne));
  const increased=p.make(undefined,{...p.settings,maxConnections:2});
  assert(increased.admission.resolveBinding(cmd.connectionRef));
  await p.prepare(p.command('clinic:124',[124]),increased);assert.equal(p.metadata.size,2);
});

test('admission policy changes preserve the immutable prepared binding and expired slots never renew silently',async t=>{
  const p=admissionFixture(t),cmd=p.command();await p.prepare(cmd);
  const original=p.current.admission.resolveBinding(cmd.connectionRef),expiry=original.expiresAt;
  p.f.state.clock+=1000;
  const changed=p.make(undefined,{...p.settings,slotTtlMs:60000,maxConnections:20,scopeKeys:['clinic:125']});
  assert.deepEqual(changed.admission.resolveBinding(cmd.connectionRef),original);
  assert.equal(P.settingsDigest(p.settings),P.settingsDigest({...p.settings,slotTtlMs:60000,maxConnections:20,scopeKeys:['clinic:125']}));
  p.f.state.clock=expiry;
  assert.deepEqual(changed.admission.resolveBinding(cmd.connectionRef),original);
  await assert.rejects(p.execute(p.beginCommand(cmd),changed),{code:'connection_blocked'});
  await assert.rejects(p.prepare(p.command(),p.current));assert.equal(p.state.creates,1);
});

test('recorded revocation or blocked connection cannot be repaired by preparing again',async t=>{
  for(const kind of ['revoked','blocked'])await t.test(kind,async t=>{
    const p=admissionFixture(t),cmd=p.command();await p.prepare(cmd);
    const original=p.current.admission.resolveBinding(cmd.connectionRef);
    if(kind==='revoked')p.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)')
      .run(cmd.tenantRef,cmd.connectionRef,cmd.assetRef,randomUUID(),p.f.now());
    else p.current.store.db.prepare("UPDATE connections SET state='blocked' WHERE ref=?").run(cmd.connectionRef);
    await assert.rejects(p.prepare(p.command()));assert.equal(p.state.creates,1);
    assert.deepEqual(p.current.admission.resolveBinding(cmd.connectionRef),original);
    await assert.rejects(p.execute(p.beginCommand(cmd)),{code:kind==='revoked'?'asset_revoked':'connection_blocked'});
  });
});

test('revocation before or during AWS prevents activation and remains closed after restart',async t=>{
  for(const phase of ['before','during'])await t.test(phase,async t=>{
    const p=admissionFixture(t),cmd=p.command('group:12',[123,124]);
    const revoke=()=>p.current.store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)')
      .run(cmd.tenantRef,cmd.connectionRef,cmd.assetRef,randomUUID(),p.f.now());
    if(phase==='before')revoke();
    else p.state.after=(command,result)=>{if(command.constructor.name==='CreateSecretCommand')revoke();return result;};
    await assert.rejects(p.prepare(cmd),{code:'asset_revoked'});
    assert.equal(p.state.creates,phase==='before'?0:1);
    assert.equal(p.current.store.db.prepare('SELECT count(*) n FROM connections WHERE ref=?').get(cmd.connectionRef).n,0);
    p.state.after=null;p.current.close();const restarted=p.make();
    await assert.rejects(p.prepare(cmd,restarted),{code:'asset_revoked'});
    assert.equal(p.state.creates,phase==='before'?0:1);
  });
});

test('preparing slots consume capacity even when AWS is unavailable',async t=>{
  const p=admissionFixture(t),limited=p.make(undefined,{...p.settings,maxConnections:1});p.state.denied=true;
  await assert.rejects(p.prepare(p.command(),limited),{code:'secret_unavailable'});
  assert.equal(p.slots(limited)[0].state,'preparing');p.state.denied=false;
  await assert.rejects(p.prepare(p.command('clinic:124',[124]),limited),{code:'rate_limited'});
  assert.equal(p.state.creates,0);
});

test('placeholder ownership, KMS, body, stage and deletion changes are never overwritten',async t=>{
  for(const mutation of ['tags','kms','body','version','deleted','missing'])await t.test(mutation,async t=>{
    const p=admissionFixture(t),cmd=p.command();await p.prepare(cmd);
    const [row]=p.slots(),meta=p.metadata.get(row.name);
    if(mutation==='tags')meta.Tags=[];
    if(mutation==='kms')meta.KmsKeyId='FOREIGN_KMS';
    if(mutation==='deleted')meta.DeletedDate=new Date();
    if(mutation==='body')p.f.records.get(row.arn).get(row.version_id).body=JSON.stringify({provider:'FOREIGN_VALUE'});
    if(mutation==='version')p.f.records.get(row.arn).get(row.version_id).stages=['AWSPREVIOUS'];
    if(mutation==='missing')p.f.records.delete(row.arn);
    await assert.rejects(p.prepare(cmd),{code:'secret_unavailable'});assert.equal(p.state.creates,1);
  });
});

test('expired context after AWS cannot mark ready; a fresh context resumes the exact placeholder',async t=>{
  const p=admissionFixture(t),cmd=p.command();
  p.state.after=(command,result)=>{if(command.constructor.name==='CreateSecretCommand')p.f.state.clock+=600001;return result;};
  await assert.rejects(p.prepare(cmd));assert.equal(p.slots()[0].state,'preparing');
  const [before]=p.slots();p.state.after=null;await p.prepare(p.command());
  assert.equal(p.slots()[0].version_id,before.version_id);assert.equal(p.slots()[0].expires_at,before.expires_at);assert.equal(p.state.creates,1);
});
