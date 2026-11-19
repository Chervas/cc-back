'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {admissionFixture}=require('./meta-marketing-admission-fixture.cjs');
const leadFixture=require('./meta-marketing-leads-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),E=require('../src/meta-marketing-enrollment-contract');
const L=require('../src/meta-marketing-leads-contract'),X=require('../src/meta-marketing-enrolled-asset-access-contract');
const PAGE=leadFixture.PAGE,ACCOUNT=leadFixture.ACCOUNT,SCOPE='clinic:123';

// Both OAuth/Owner stores, signed transports, claims and Lead HTTP adapter are
// production code. Only AWS/Graph are closed fixtures; no real contact is used.
async function ready(t,{optin=true,activate=true,refs=[PAGE,ACCOUNT],scope=SCOPE,clinicIds=[123]}={}){
  const graph=await leadFixture.ready(t);
  if(!graph.f.binding.metaMarketingOAuth.scopes.includes('ads_management'))graph.f.binding.metaMarketingOAuth.scopes.push('ads_management');
  const leadAds={...graph.config,pairs:[{pageAssetRef:'meta-facebook_page:999',adAccountAssetRef:'meta-ad_account:998',recipientClinicId:71}]};
  const access={enabled:true,cohort:X.COHORT,scopeKeys:[SCOPE]};
  const p=admissionFixture(t,{enrollment:true,enrollmentScopeKeys:[scope],adsReadScopeKeys:[scope],leads:true,leadIngress:true,
    leadAds,leadsHttp:graph.leadsHttp,adsHttp:{read:()=>assert.fail('UNEXPECTED_ADS_READ')},...(optin?{enrolledAssetAccess:access}:{})});
  if(refs.includes('meta-ad_account:302'))p.f.state.afterGraph=(kind,value)=>{
    if(kind==='inspect')value.data.granular_scopes.find(row=>row.scope==='ads_read').target_ids.push('302');
    if(kind==='adaccounts')value.data.push({...value.data[0],id:'act_302',account_id:'302'});
    return value;
  };
  p.f.records.set(leadAds.verifyTokenRef.secretArn,graph.f.records.get(leadAds.verifyTokenRef.secretArn));
  const cmd=p.command(scope,clinicIds);await p.prepare(cmd);const flow=p.beginCommand(cmd);await p.execute(flow);
  const candidate=(await p.execute({...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,
    payload:{flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_ADMISSION_LEADS_CODE'}})).data.candidate;
  const id=randomUUID(),prepared=(await p.execute({...cmd,requestId:randomUUID(),operation:E.OPERATIONS.prepare,
    payload:{enrollmentId:id,flowId:flow.requestId,scopeDigest:flow.payload.scopeDigest,candidateDigest:candidate.digest,assetRefs:refs}})).data;
  if(activate)await p.execute({...cmd,requestId:randomUUID(),operation:E.OPERATIONS.activate,
    payload:{enrollmentId:id,scopeDigest:flow.payload.scopeDigest,selectionDigest:prepared.selectionDigest}});
  const read=(name,payload={},role='reader',overrides={})=>p.execute({...cmd,requestId:randomUUID(),operation:L.OPERATIONS[name],
    assetRef:PAGE,payload:{adAccountAssetRef:ACCOUNT,...payload},...overrides},p.current,role);
  return {p,graph,cmd,flow,id,prepared,leadAds,access,read};
}

test('confirmed direct-clinic admission separately enables Page reception and deduplicates signed receipts',async t=>{
  const r=await ready(t),{p,graph}=r;
  assert.deepEqual(graph.state.fields,['feed']);
  const checked=await r.read('pageStatus');assert.equal(checked.data.subscription.fields.includes('leadgen'),false);
  const before=graph.state.calls.length;
  await assert.rejects(r.read('pageEnable',{expectedSubscriptionRevision:'0'.repeat(64)}));
  assert.equal(graph.state.fields.includes('leadgen'),false);
  const enabled=await r.read('pageEnable',{expectedSubscriptionRevision:checked.data.subscription.revision});
  assert(enabled.data.subscription.fields.includes('leadgen'));assert(enabled.data.subscription.fields.includes('feed'));
  assert(graph.state.calls.length>before);
  const accepted=await r.read('receiptAccept',leadFixture.acceptPayload(),'leadIngress');
  const duplicate=await r.read('receiptAccept',leadFixture.acceptPayload(),'leadIngress');
  assert.deepEqual(duplicate.data,accepted.data);assert.equal(accepted.data.receipts.length,1);
  assert.equal(p.current.store.db.prepare('SELECT count(*) n FROM meta_marketing_lead_receipts').get().n,1);
  const lead=await r.read('receiptRead',{receiptRef:accepted.data.receipts[0].receiptRef,responseVersion:2});
  assert.equal(lead.data.event.page_id,'401');assert.equal(lead.data.identity.account_id,'301');assert.equal(lead.data.recipientClinicId,null);
  assert(!JSON.stringify(lead.data.lead.field_data).includes('NEVER_RETURN'));
  const audit=p.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event));
  const completed=audit.filter(event=>event.operation===L.OPERATIONS.receiptRead&&event.action==='integration.completed');
  assert.equal(completed.length,1);assert.equal(completed[0].connectionRef,r.cmd.connectionRef);assert.equal(completed[0].tenantRef,'clinic:123');
});

test('Ads-only admission, pending selection and Page/account mismatch cannot receive Leads',async t=>{
  for(const options of [{optin:false},{activate:false},{refs:[ACCOUNT]},{refs:[PAGE,ACCOUNT,'meta-ad_account:302']}])await t.test(JSON.stringify(options),async t=>{
    const r=await ready(t,options),before=r.graph.state.calls.length;
    await assert.rejects(r.read('pageStatus'));
    await assert.rejects(r.read('receiptAccept',leadFixture.acceptPayload(),'leadIngress'));
    assert.equal(r.graph.state.calls.length,before);
  });
  const r=await ready(t),before=r.graph.state.calls.length;
  await assert.rejects(r.read('pageStatus',{adAccountAssetRef:'meta-ad_account:302'}));
  await assert.rejects(r.read('pageStatus',{},'leadIngress'));
  await assert.rejects(r.read('receiptAccept',leadFixture.acceptPayload(),'reader'));
  await assert.rejects(r.read('recoveryList',{formId:'702',startDate:'2026-11-01',endDate:'2026-11-02',cursor:null}));
  assert.equal(r.graph.state.calls.length,before);
});

test('withdrawal of another selected asset revalidates the whole enrollment during Lead HTTP',async t=>{
  const r=await ready(t,{refs:[PAGE,ACCOUNT,'meta-instagram_business:501']});
  const accepted=await r.read('receiptAccept',leadFixture.acceptPayload(),'leadIngress');let removed=false;
  r.graph.state.before=url=>{if(url.pathname==='/v24.0/701'&&!removed){removed=true;
    r.p.current.store.db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run('meta-instagram_business:501');}};
  await assert.rejects(r.read('receiptRead',{receiptRef:accepted.data.receipts[0].receiptRef}));assert(removed);
});

for(const change of ['scope membership','revoked enrollment','revoked Page claim','disabled reader'])test('withdrawal during Lead HTTP closes '+change+' before contact data returns',async t=>{
  const r=await ready(t),accepted=await r.read('receiptAccept',leadFixture.acceptPayload(),'leadIngress');let changed=false;
  r.graph.state.before=(url)=>{
    if(changed||url.pathname!=='/v24.0/701')return;changed=true;
    if(change==='scope membership')r.p.current.store.db.prepare('UPDATE meta_marketing_admission_slots SET clinic_ids=? WHERE scope=?').run('[124]',SCOPE);
    if(change==='revoked enrollment')r.p.current.store.db.prepare("UPDATE meta_marketing_enrollments SET state='revoked' WHERE id=?").run(r.id);
    if(change==='revoked Page claim')r.p.current.store.db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run(PAGE);
    if(change==='disabled reader')r.p.current.broker.policy.principals.find(row=>row.id==='staging:meta-marketing').enabled=false;
  };
  await assert.rejects(r.read('receiptRead',{receiptRef:accepted.data.receipts[0].receiptRef}));
  assert(changed);
  const audit=r.p.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event));
  assert(!audit.some(event=>event.operation===L.OPERATIONS.receiptRead&&event.action==='integration.completed'));
});

test('admitted Leads policy requires explicit clinic access, separate ingress, full scopes and the selected Ads capability',async t=>{
  const r=await ready(t),runtime=require('../src/meta-marketing-oauth-main');
  const config={...r.p.f.config,admission:r.p.settings,enrolledAssetAccess:r.access};runtime.validateConfig(config);
  for(const mutate of [c=>{delete c.leadAds;},c=>{c.admission.adsReadScopeKeys=[];},c=>{c.admission.enrollmentScopeKeys=[];},
    c=>{c.admission.scopes=c.admission.scopes.filter(scope=>scope!=='leads_retrieval');},c=>{c.enrolledAssetAccess.scopeKeys=['group:12'];},
    c=>{c.policy.principals=c.policy.principals.filter(row=>row.id!==L.ingressPrincipal('staging'));}]){
    const bad=structuredClone(config);mutate(bad);assert.throws(()=>runtime.validateConfig(bad),{code:'invalid_request'});
  }
});

test('invalid signature, oversized receipt and a foreign Page do not create receipts or retrieve provider contacts',async t=>{
  const r=await ready(t),before=r.graph.state.calls.length;
  await assert.rejects(r.read('receiptAccept',{...leadFixture.acceptPayload(),signature:'sha256='+'0'.repeat(64)},'leadIngress'),{code:'invalid_signature'});
  await assert.rejects(r.read('receiptAccept',{rawBase64:Buffer.alloc(65537).toString('base64'),signature:'sha256='+'0'.repeat(64)},'leadIngress'),{code:'invalid_request'});
  await assert.rejects(r.read('receiptAccept',leadFixture.acceptPayload(),'leadIngress',{assetRef:'meta-facebook_page:402'}));
  assert.equal(r.graph.state.calls.length,before);
  assert.equal(r.p.current.store.db.prepare('SELECT count(*) n FROM meta_marketing_lead_receipts').get().n,0);
});

test('published Owner TLS wiring receives only the opted-in confirmed Page after restart',async t=>{
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process');
  const runtime=require('../src/meta-marketing-oauth-main'),{allowPort,removePort}=require('./offline-guard.cjs');
  const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient');
  const r=await ready(t),{p}=r,config={...p.f.config,admission:p.settings,enrolledAssetAccess:r.access,stateFile:path.join(p.f.dir,'admission.sqlite')};
  p.current.close();
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,
    '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));config.port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));allowPort(config.port);
  const filename=path.join(p.f.dir,'leads-runtime.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  const awsFactory=async()=>({secrets:p.aws,sink:{write:async row=>({versionId:'FICTITIOUS_AUDIT',digest:row.digest})},close(){}});
  const options={awsFactory,http:p.f.http,leadsRequest:r.graph.request,adsNow:p.f.now,adsWait:async ms=>{p.f.state.clock+=ms;r.graph.f.state.clock+=ms;}};
  let app=await runtime.main(filename,options);
  t.after(async()=>{await app.close();removePort(config.port);});
  await app.close();app=await runtime.main(filename,options);
  const client=role=>createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+config.port,audience:config.policy.audience,
    keyId:role==='reader'?'qa-reader':L.ingressPrincipal('staging'),privateKey:(role==='reader'?p.f.reader:p.f.leadIngressKeys).privateKey.export({type:'pkcs8',format:'pem'}),
    ca:fs.readFileSync(config.tlsCertFile),transportProfile:'meta-marketing'});
  const reader=client('reader'),ingress=client('leadIngress');
  const command=(operation,payload)=>({...r.cmd,requestId:randomUUID(),operation,assetRef:PAGE,payload:{adAccountAssetRef:ACCOUNT,...payload}});
  const status=await reader.execute(command(L.OPERATIONS.pageStatus,{}));assert.equal(status.data.page.id,'401');
  await assert.rejects(ingress.execute(command(L.OPERATIONS.pageStatus,{})),{code:'scope_denied'});
  const first=await ingress.execute(command(L.OPERATIONS.receiptAccept,leadFixture.acceptPayload()));
  const duplicate=await ingress.execute(command(L.OPERATIONS.receiptAccept,leadFixture.acceptPayload()));assert.deepEqual(duplicate.data,first.data);
  const received=await reader.execute(command(L.OPERATIONS.receiptRead,{receiptRef:first.data.receipts[0].receiptRef}));
  assert.equal(received.data.identity.account_id,'301');assert.equal(received.data.recipientClinicId,null);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM meta_marketing_lead_receipts').get().n,1);
});
