'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{generateKeyPairSync,randomUUID,randomBytes}=require('node:crypto');
const {ready,rawEvent,acceptPayload,PAGE,ACCOUNT,VERIFY}=require('./meta-marketing-leads-fixture.cjs');
const L=require('../src/meta-marketing-leads-contract'),E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract'),C=require('../src/meta-marketing-oauth-contract'),A=require('../src/meta-marketing-ads-contract');
const {Broker}=require('../src/broker'),{signRequest}=require('../src/auth'),{createMetaMarketingOAuthOperations}=require('../src/meta-marketing-oauth'),runtime=require('../src/meta-marketing-oauth-main');
async function ingressFixture(t,{optin=true}={}){
  const r=await ready(t,{optin}),key=generateKeyPairSync('ed25519'),id=L.ingressPrincipal('staging');
  r.f.policy.principals.push({id,keyId:id,enabled:true,maxPerMinute:20,publicKey:key.publicKey.export({type:'spki',format:'pem'})});
  const broker=new Broker({store:r.current.store,policy:r.f.policy,secrets:r.f.secrets,policyResolver:r.enrollment,
    operations:{...createMetaMarketingOAuthOperations(r.f.current.engine,{assetDiscovery:true}),...r.enrollment.operations},transportProfile:'meta-marketing',now:r.f.now});
  const send=(operation,payload,overrides={},privateKey=key.privateKey)=>{const value=r.f.command(operation,payload,{assetRef:PAGE,...overrides}),signed=signRequest(value,{keyId:id,privateKey,audience:r.f.policy.audience,now:r.f.now()});return broker.execute(signed.raw,signed.headers);};
  return {...r,enrollmentId:r.id,key,id,broker,send};
}
test('optional ingress principal preserves four-role configs and requires Lead cohort, unique key, exact environment and quota',async t=>{
  const r=await ingressFixture(t),cfg={...r.f.config,leadAds:structuredClone(r.config)};
  assert.equal(Object.keys(E.roles('staging')).length,4);assert.equal(L.ingressPrincipal('dev'),'gateway:dev:meta-marketing-leads');assert.throws(()=>L.ingressPrincipal('prod'),{code:'invalid_request'});
  runtime.validateConfig(cfg);const old=structuredClone(cfg);old.policy.principals=old.policy.principals.filter(p=>p.id!==r.id);runtime.validateConfig(old);
  const dev=structuredClone(cfg);dev.environment='dev';for(const p of dev.policy.principals){p.id=p.id.replaceAll('staging','dev');p.keyId=p.keyId.replaceAll('staging','dev');}for(const g of dev.policy.grants)g.principalId=g.principalId.replaceAll('staging','dev');for(const b of dev.policy.connections){b.secretArn=b.secretArn.replace('/staging/','/dev/');b.clientSecretArn=b.clientSecretArn.replace('/staging/','/dev/');}dev.leadAds.verifyTokenRef.secretArn=dev.leadAds.verifyTokenRef.secretArn.replace('/staging/','/dev/');runtime.validateConfig(dev);
  for(const mutate of [c=>delete c.leadAds,c=>c.policy.principals.at(-1).id=L.ingressPrincipal('dev'),c=>c.policy.principals.at(-1).publicKey=c.policy.principals[0].publicKey,
    c=>c.policy.principals.at(-1).maxPerMinute=21,c=>c.policy.principals.push({...c.policy.principals.at(-1),id:'gateway:staging:other',keyId:'other'}),
    c=>c.policy.grants.push({principalId:r.id,connectionRef:r.f.binding.connectionRef,tenantRef:'clinic:71',assetRef:PAGE,operations:L.RECEPTION_OPERATIONS})]){
    const bad=structuredClone(cfg);mutate(bad);assert.throws(()=>runtime.validateConfig(bad),{code:'invalid_request'});
  }
});
test('dedicated signed principal can verify challenge and persist HMAC IDs without Graph/contact disclosure',async t=>{
  const r=await ingressFixture(t),challenge={adAccountAssetRef:ACCOUNT,mode:'subscribe',token:VERIFY,challenge:'12345678'};
  assert.deepEqual((await r.send(L.OPERATIONS.challenge,challenge)).data,{challenge:'12345678'});
  const accepted=(await r.send(L.OPERATIONS.receiptAccept,acceptPayload())).data;assert.equal(accepted.receipts.length,1);assert.equal(accepted.persisted,true);assert.equal(r.state.calls.length,0);
  const before=r.f.state.awsCalls.length;await assert.rejects(r.send(L.OPERATIONS.receiptRead,{adAccountAssetRef:ACCOUNT,receiptRef:accepted.receipts[0].receiptRef}),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);
  const journal=JSON.stringify(r.current.store.db.prepare('SELECT * FROM commands').all())+JSON.stringify(r.current.store.db.prepare('SELECT * FROM audit_outbox').all());assert(!journal.includes('IGNORED_PII'));assert(!journal.includes(VERIFY));
  const events=r.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event));
  for(const operation of L.RECEPTION_OPERATIONS)assert(events.some(e=>e.actorId===r.id&&e.connectionRef===r.f.binding.connectionRef&&e.operation===operation&&e.result==='success'));
});
test('dedicated ingress cannot read Ads/metadata/contacts, enable pages, authorize/enroll or use controls',async t=>{
  const r=await ingressFixture(t),scope={assetRef:'meta-enroll:group:9'},uuid=randomUUID(),digest='0'.repeat(64),state=randomBytes(32).toString('base64url');
  const commands=[
    [L.OPERATIONS.receiptRead,{adAccountAssetRef:ACCOUNT,receiptRef:uuid}],
    [L.OPERATIONS.destinations,{adAccountAssetRef:ACCOUNT,campaignId:'601',cursor:null}],
    [L.OPERATIONS.form,{adAccountAssetRef:ACCOUNT,formId:'702'}],
    [L.OPERATIONS.pageStatus,{adAccountAssetRef:ACCOUNT}],
    [L.OPERATIONS.pageEnable,{adAccountAssetRef:ACCOUNT,expectedSubscriptionRevision:digest}],
    [A.OPERATIONS.campaigns,{pageToken:null},{assetRef:ACCOUNT}],
    [M.STATUS,{}],[M.ASSET,{}],[M.REVOKE,{}],
    [C.OPERATIONS.begin,{state,scopeDigest:digest,clinicSetDigest:digest,expiresAt:r.f.now()+60000},scope],
    [C.OPERATIONS.finish,{flowId:uuid,state,code:'FICTITIOUS_CODE'},scope],
    [C.OPERATIONS.status,{flowId:uuid},scope],[C.OPERATIONS.abort,{flowId:uuid},scope],
    [E.OPERATIONS.prepare,{enrollmentId:uuid,flowId:uuid,scopeDigest:digest,candidateDigest:digest,assetRefs:[PAGE,ACCOUNT]},scope],
    [E.OPERATIONS.activate,{enrollmentId:uuid,scopeDigest:digest,selectionDigest:digest},scope],
    [E.OPERATIONS.status,{enrollmentId:uuid},scope],[E.OPERATIONS.revoke,{enrollmentId:uuid},scope],
  ];
  const before=r.f.state.awsCalls.length;
  for(const [operation,payload,overrides]of commands)await assert.rejects(r.send(operation,payload,overrides),{code:'scope_denied'});
  assert.equal(r.f.state.awsCalls.length,before);assert.equal(r.state.calls.length,0);assert.equal(r.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);
});
test('ingress still requires active exact Page/account authority, correct signature and current enabled key',async t=>{
  const r=await ingressFixture(t),p=acceptPayload(),before=r.f.state.awsCalls.length;
  for(const [payload,overrides]of [[{...p,adAccountAssetRef:'meta-ad_account:999'},{}],[p,{tenantRef:'clinic:72'}],[p,{assetRef:ACCOUNT}]])await assert.rejects(r.send(L.OPERATIONS.receiptAccept,payload,overrides),{code:'scope_denied'});
  await assert.rejects(r.send(L.OPERATIONS.receiptAccept,p,{},r.f.reader.privateKey),{code:'invalid_signature'});assert.equal(r.f.state.awsCalls.length,before);
  await assert.rejects(r.send(L.OPERATIONS.receiptAccept,{...p,signature:'sha256='+'0'.repeat(64)}),{code:'invalid_signature'});
  r.broker.policy.principals.find(v=>v.id===r.id).enabled=false;await assert.rejects(r.send(L.OPERATIONS.receiptAccept,p),{code:'invalid_signature'});
  const other=await ingressFixture(t);other.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:71',other.f.binding.connectionRef,ACCOUNT,randomUUID(),other.f.now());const calls=other.f.state.awsCalls.length;
  await assert.rejects(other.send(L.OPERATIONS.receiptAccept,acceptPayload()),{code:'asset_revoked'});assert.equal(other.f.state.awsCalls.length,calls);
});
test('an unenrolled or closed Lead cohort does not create ingress authority',async t=>{
  const r=await ingressFixture(t,{optin:false}),before=r.f.state.awsCalls.length;
  await assert.rejects(r.send(L.OPERATIONS.receiptAccept,acceptPayload()),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);
  const active=await ingressFixture(t);active.current.store.db.prepare("UPDATE meta_marketing_enrollments SET state='prepared' WHERE id=?").run(active.enrollmentId);const calls=active.f.state.awsCalls.length;
  await assert.rejects(active.send(L.OPERATIONS.receiptAccept,acceptPayload()),{code:'scope_denied'});assert.equal(active.f.state.awsCalls.length,calls);
});
test('actual TLS runtime accepts the optional ingress identity while keeping contact reads inaccessible',async t=>{
  const r=await ingressFixture(t),f=r.f,fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process');
  const {allowPort,removePort}=require('./offline-guard.cjs'),cfg={...f.config,stateFile:f.filename,leadAds:structuredClone(r.config)};
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',cfg.tlsKeyFile,'-out',cfg.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});fs.chmodSync(cfg.tlsKeyFile,0o600);fs.chmodSync(cfg.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));cfg.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(cfg.port);
  const file=path.join(f.dir,'dedicated-ingress-config.json');fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  let app=await runtime.main(file,{awsFactory:async()=>({secrets:f.aws,sink:{async write(){return {versionId:'FICTITIOUS_INGRESS_AUDIT',digest:'fictitious'};}},close(){}}),http:f.http,leadsRequest:r.request,adsNow:f.now,adsWait:async ms=>{f.state.clock+=ms;}});t.after(async()=>{if(app)await app.close();removePort(cfg.port);});
  const client=require('../../../src/lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:`https://127.0.0.1:${cfg.port}`,audience:cfg.policy.audience,keyId:r.id,privateKey:r.key.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cfg.tlsCertFile),transportProfile:'meta-marketing'});
  const send=(operation,payload)=>client.execute(f.command(operation,payload,{assetRef:PAGE}));
  assert.deepEqual((await send(L.OPERATIONS.challenge,{adAccountAssetRef:ACCOUNT,mode:'subscribe',token:VERIFY,challenge:'87654321'})).data,{challenge:'87654321'});
  const receipt=(await send(L.OPERATIONS.receiptAccept,acceptPayload(rawEvent()))).data.receipts[0];assert.equal(receipt.event.lead_id,'701');assert.equal(r.state.calls.length,0);
  await assert.rejects(send(L.OPERATIONS.receiptRead,{adAccountAssetRef:ACCOUNT,receiptRef:receipt.receiptRef}),{code:'scope_denied'});assert.equal(r.state.calls.length,0);
  await app.close();app=null;
});
