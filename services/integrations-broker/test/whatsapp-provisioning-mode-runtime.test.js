'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const net=require('node:net');const {execFileSync}=require('node:child_process');
const {randomUUID,randomBytes}=require('node:crypto');
const {provisioningFixture}=require('./whatsapp-provisioning-fixture.cjs');
const {allowPort,removePort}=require('./offline-guard.cjs');
const {configuredClient}=require('../../../src/lib/whatsappOnboardingBrokerClient');
const runtime=require('../src/whatsapp-onboarding-main');const C=require('../src/whatsapp-onboarding-contract');
const P=require('../src/whatsapp-provisioning-contract');const A=require('../src/whatsapp-activation-contract');
const W=require('../src/whatsapp-authorized-contract');const {ACCOUNT,SECRET_KEY}=require('../src/google-main');
const {createWhatsappActivation}=require('../src/whatsapp-activation');
const {createActivationReader}=require('../src/whatsapp-activation-reader');
const {createWhatsappAuthorizedRegistry}=require('../src/whatsapp-authorized-registry');
const {createWhatsappAuthorizedSecrets}=require('../src/whatsapp-authorized-secrets');
const {enrollmentLoader}=require('../src/whatsapp-enrollment-loader');
const {WA_SCOPES,broaden}=require('./whatsapp-companion-fixture.cjs');
const {TOKEN}=require('./whatsapp-onboarding-fixture.cjs');
async function setup(t,{ownerCapability=true,gatewayCapability=true}={}){
  const p=provisioningFixture(t),f=p.f,file=name=>f.dir+'/'+name;
  const cert=file('mode-tls.crt'),key=file('mode-tls.key');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
    '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  for(const name of [cert,key])fs.chmodSync(name,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(port);
  const settings={...p.settings,scopes:[...WA_SCOPES],...(ownerCapability?{coexistenceGrantPolicy:C.PROVIDER_GRANT_POLICY}:{})};
  const cfg={enabled:true,cohort:C.COHORT,listenAddress:'127.0.0.1',port,stateFile:file('mode-runtime.sqlite'),
    tlsCertFile:cert,tlsKeyFile:key,policy:f.policy,provisioning:settings};
  fs.writeFileSync(file('mode-owner.json'),JSON.stringify(cfg),{mode:0o600});
  const app=await runtime.main(file('mode-owner.json'),{awsFactory:async()=>({secrets:p.aws,
    sink:{write:async row=>({digest:row.digest,versionId:'FICTITIOUS_AUDIT'})},close(){}}),http:f.http,exchangeFactory:f.exchangeFactory});
  t.after(async()=>{await app.close();removePort(port);});
  const signing=file('mode-signing.pem');fs.writeFileSync(signing,f.gateway.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(file('mode-state.key'),Buffer.alloc(32,7),{mode:0o600});
  const b=f.binding.whatsappOnboarding;
  const legacy={connectionRef:f.binding.connectionRef,...Object.fromEntries(['scopeKey','clinicIds','appId','configId','redirectUri','scopes','customer'].map(k=>[k,b[k]]))};
  const template=P.publicTemplate(settings);delete template.coexistenceGrantPolicy;
  if(gatewayCapability)template.coexistenceGrantPolicy=C.PROVIDER_GRANT_POLICY;
  const gateway={version:1,origin:`https://127.0.0.1:${port}`,audience:f.policy.audience,keyId:'qa-gateway',
    privateKeyFile:signing,caFile:cert,bindings:[legacy],automatic:template};
  const writeGateway=()=>fs.writeFileSync(file('mode-gateway.json'),JSON.stringify(gateway),{mode:0o600});writeGateway();
  const env={WHATSAPP_ONBOARDING_ENABLED:'true',RUNTIME_ROLE:'gateway',JOB_RUNTIME_NAMESPACE:'gateway',QUEUE_PREFIX:'gateway',
    JOBS_WORKER_ENABLED:'false',CRON_ENABLED:'false',AUTH_SESSION_MODE:'enforce',AUTH_EMAIL_MFA_MODE:'enforce',
    PLATFORM_AUDIT_AUTH_ENABLED:'true',PLATFORM_AUDIT_AUTH_POLICY:'auth-durable-v1',PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED:'true',
    PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY:'whatsapp-onboarding-v1',WHATSAPP_ONBOARDING_STATE_KEY_FILE:file('mode-state.key'),
    WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE:file('mode-gateway.json')};
  const client=configuredClient({environment:()=>env});
  const row=(id=123,mode)=>({requestId:randomUUID(),status:'awaiting',scope:{type:'clinic',id},clinicIds:[id],
    scopeDigest:C.hash('FICTITIOUS_SCOPE_'+id),clinicSetDigest:C.hash(JSON.stringify([id])),state:randomBytes(32).toString('base64url'),
    expiresAt:new Date(Date.now()+599000).toISOString(),...(mode===undefined?{}:{mode})});
  return {p,f,file,cfg,app,gateway,writeGateway,client,row};
}
test('Mode-pinned signed TLS preparation reaches coexistence activation and the ordinary registry secret guard without modifying a legacy sender',async t=>{
  const s=await setup(t),{p,f,app,client,cfg}=s;
  // First preserve an actual v1 candidate on an explicit legacy binding.
  f.state.selectedWabaId='302';f.state.selectedPhoneId='402';
  const legacy={...s.row(),scope:{type:'group',id:9},clinicIds:[71,72],clinicSetDigest:C.hash('[71,72]')};
  await client.begin(legacy);
  await client.finish(legacy,{state:legacy.state,code:'FICTITIOUS_LEGACY_MODE_CODE',wabaId:'302',phoneId:'402'});
  const old=app.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(legacy.requestId);
  const oldSecret=f.records.get(f.binding.secretArn).get(legacy.requestId).body;
  const fingerprint=C.fingerprint(f.binding);
  f.state.selectedWabaId='301';f.state.selectedPhoneId='401';
  f.state.afterGraph=(request,response)=>{
    if(request.action!=='inspect')return response;
    response.data.scopes=[...WA_SCOPES];response.data.granular_scopes=WA_SCOPES.filter(scope=>scope!=='public_profile')
      .map(scope=>({scope,target_ids:['301']}));return broaden(response);
  };
  const row=s.row(123,'coexistence');
  const prepared=await client.begin(row);assert.equal(prepared.status,'awaiting');
  const slot=app.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots WHERE scope=?').get('clinic:123');
  assert.equal(slot.provider_grant_policy,C.PROVIDER_GRANT_POLICY);
  const completed=await client.finish(row,{state:row.state,code:'FICTITIOUS_NEW_COEX_CODE',wabaId:'301',phoneId:'401'});
  assert.equal(completed.status,'staged');assert(completed.candidate.providerGrant);
  const loader=enrollmentLoader({enrollmentConfigFile:s.file('mode-owner.json'),enrollmentStateFile:cfg.stateFile});
  const enrollmentBinding=loader(P.connectionRef('clinic:123'));
  const calls=[];let subscribed=false;
  const activation=createWhatsappActivation({store:app.store,filename:cfg.stateFile,policy:cfg.policy,resolveBinding:loader,
    client:p.aws,accountId:ACCOUNT,kmsKeyArn:SECRET_KEY,now:f.now,
    pinFactory:()=>async()=>assert.fail('Coexistence cannot register or reset a phone'),
    http:async request=>{
      calls.push(request.action);
      if(request.action==='profile')return {id:'401',status:'CONNECTED',platform_type:'CLOUD_API',is_on_biz_app:true,
        code_verification_status:'VERIFIED',quality_rating:'GREEN',display_phone_number:'+34000000401',verified_name:'Synthetic QA'};
      if(request.action==='subscriptions')return {data:subscribed?[{whatsapp_business_api_data:{id:'101'}}]:[]};
      if(request.action==='subscribe'){subscribed=true;return {success:true};}
      return f.http(request);
    }});
  const execute=operation=>activation.operations[operation].execute({request:{requestId:randomUUID(),operation,
    tenantRef:'clinic:123',assetRef:'wa-enroll:clinic:123',connectionRef:enrollmentBinding.connectionRef,payload:{flowId:row.requestId,
      scopeDigest:row.scopeDigest,clinicSetDigest:row.clinicSetDigest,...(operation===A.ACTIVATE?{assetId:991}:{})}},
    principal:cfg.policy.principals[0],binding:enrollmentBinding,policy:cfg.policy});
  await execute(A.PROFILE);assert.equal((await execute(A.ACTIVATE)).data.state,'active');
  const reader=createActivationReader(cfg.stateFile);t.after(()=>reader.close());
  const legacyDefinition={connectionRef:'wa-legacy-sender',authorizationId:legacy.requestId,enrollmentBinding:f.binding,
    phoneId:'402',wabaId:'302',candidateDigest:old.secret_digest,expiresAt:null,enabled:true};
  const registry=createWhatsappAuthorizedRegistry({filename:cfg.stateFile,authorizations:[legacyDefinition],
    loadAuthorizations:reader.definitions,loadEnrollmentBinding:loader,now:f.now});t.after(()=>registry.close());
  const active=reader.definitions()[0],operational={connectionRef:active.connectionRef,provider:W.PROVIDER};
  assert.equal(registry.assert(operational).metadata.phoneId,'401');
  const secrets=createWhatsappAuthorizedSecrets({client:p.aws,accountId:ACCOUNT,prefix:'/clinicaclick/integrations/prod/',
    kmsKeyArn:SECRET_KEY,registry,http:f.http,now:f.now});t.after(()=>secrets.close());
  assert.deepEqual(await secrets.withSecret(operational,token=>({valid:token.toString('utf8')===TOKEN})),{valid:true});
  assert.equal(registry.assert({connectionRef:legacyDefinition.connectionRef,provider:W.PROVIDER}).metadata.phoneId,'402');
  assert.deepEqual(app.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(legacy.requestId),old);
  assert.equal(C.fingerprint(loader(f.binding.connectionRef)),fingerprint);
  assert.equal(f.records.get(f.binding.secretArn).get(legacy.requestId).body,oldSecret);
  assert.equal(calls.includes('register_phone'),false);assert.equal(calls.includes('send'),false);
  assert.equal((await client.statusReadOnly(row)).status,'staged');
});
test('An Owner/Gateway capability mismatch is rejected before begin or SDK and can be retried after configuration agrees',async t=>{
  const s=await setup(t,{gatewayCapability:false}),row=s.row(123,'coexistence');
  await assert.rejects(s.client.begin(row),{code:'whatsapp_onboarding_preparation_unavailable'});
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM whatsapp_onboarding_flows').get().n,0);
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM whatsapp_provisioned_slots').get().n,0);
  assert.equal(s.f.state.codes,0);assert.equal(s.f.state.puts,0);
  s.gateway.automatic.coexistenceGrantPolicy=C.PROVIDER_GRANT_POLICY;s.writeGateway();
  assert.equal((await s.client.begin(row)).status,'awaiting');assert.equal(s.p.state.creates,1);
});
test('A capable Gateway cannot prepare coexistence against an incompatible Owner or alter an existing profile',async t=>{
  const s=await setup(t,{ownerCapability:false}),row=s.row(123,'coexistence');
  await assert.rejects(s.client.begin(row),{code:'whatsapp_onboarding_preparation_unavailable'});
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM whatsapp_onboarding_flows').get().n,0);
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM whatsapp_provisioned_slots').get().n,0);
  assert.equal(s.f.state.codes,0);assert.equal(s.f.state.puts,0);assert.equal(s.p.state.creates,0);
  const cloud=s.row(123,'cloud_api');await s.client.begin(cloud);
  const before=s.app.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots').get();
  await assert.rejects(s.client.begin(row),{code:'whatsapp_onboarding_preparation_unavailable'});
  assert.deepEqual(s.app.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots').get(),before);
});
test('Explicit Cloud mode remains strict and can finish with a Cloud-only profile under a coexistence-capable configuration',async t=>{
  const s=await setup(t),row=s.row(124,'cloud_api');
  s.f.state.afterGraph=(request,response)=>{
    if(request.action==='inspect'){
      response.data.scopes=[...WA_SCOPES];response.data.granular_scopes=WA_SCOPES.filter(scope=>scope!=='public_profile')
        .map(scope=>({scope,target_ids:['301']}));
    }
    if(request.action==='phone_state')response.is_on_biz_app=false;
    return response;
  };
  await s.client.begin(row);
  const result=await s.client.finish(row,{state:row.state,code:'FICTITIOUS_NEW_CLOUD_CODE',wabaId:'301',phoneId:'401'});
  assert.equal(result.status,'staged');assert.equal(result.phoneState.isOnBizApp,false);
  assert.equal(Object.hasOwn(result.candidate,'providerGrant'),false);
  assert.equal(s.app.store.db.prepare('SELECT provider_grant_policy FROM whatsapp_provisioned_slots').get().provider_grant_policy,P.STRICT_GRANT_POLICY);
});
