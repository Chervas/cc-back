'use strict';
// All provider/AWS responses below are offline fixtures. Broker signatures,
// contracts, SQLite, credential staging/renewal and HTTP readers are real code.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHmac}=require('node:crypto');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs'),{Broker}=require('../src/broker');
const C=require('../src/meta-marketing-oauth-contract'),E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract');
const A=require('../src/meta-marketing-ads-contract'),L=require('../src/meta-marketing-leads-contract'),R=require('../src/meta-marketing-credential-renewal-contract'),X=require('../src/meta-marketing-enrolled-asset-access-contract');
const runtime=require('../src/meta-marketing-oauth-main'),{createMetaMarketingEnrollment}=require('../src/meta-marketing-enrollment');
const PAGE='meta-facebook_page:401',PAGE2='meta-facebook_page:402',ACCOUNT='meta-ad_account:301',ACCOUNT2='meta-ad_account:302';
const VERIFY='FICTITIOUS_ENROLLED_ACCESS_VERIFY_123456789';
async function ready(t,{dynamic=true,scopeKey='clinic:95',clinicIds=[95],refs=[PAGE,ACCOUNT],active=true,missingScope}={}){
  const f=fixture(t,{renewal:true,leads:true,adsManagement:true}),b=f.binding.metaMarketingOAuth;
  b.scopeKey=scopeKey;b.clinicIds=clinicIds;b.scopes=[...X.REQUIRED_SCOPES].filter(scope=>scope!==missingScope);
  const scope={connectionRef:f.binding.connectionRef,tenantRef:'clinic:'+clinicIds[0],assetRef:'meta-enroll:'+scopeKey};
  for(const grant of f.policy.grants)Object.assign(grant,scope);
  f.records.get(f.binding.secretArn).get(b.slotVersionId).body=JSON.stringify({version:1,provider:'meta-marketing-oauth-slot',connectionRef:f.binding.connectionRef,scopeKey,clinicSetDigest:C.clinicDigest(b),appId:b.appId});
  const adsRead={enabled:true,cohort:A.COHORT,assetRefs:['meta-ad_account:901']};
  const leadAds={...f.config.leadAds,pairs:[{pageAssetRef:'meta-facebook_page:801',adAccountAssetRef:'meta-ad_account:901',recipientClinicId:71}]};
  f.records.set(leadAds.verifyTokenRef.secretArn,new Map([[leadAds.verifyTokenRef.versionId,{body:JSON.stringify({version:1,kind:'meta-marketing-leads-webhook-verify',appId:b.appId,verifyToken:VERIFY}),stages:['AWSCURRENT']}]]));
  const enrolledAssetAccess={enabled:true,cohort:X.COHORT,scopeKeys:['clinic:95']};
  Object.assign(f.config,{adsRead,leadAds,...(dynamic?{enrolledAssetAccess}:{})});
  const state={calls:[],before:null,afterGraph:null,granular:null};
  f.state.afterGraph=async(kind,value)=>{
    if(kind==='inspect')value.data.granular_scopes=state.granular??[{scope:'ads_read',target_ids:['301','302']}];
    if(kind==='adaccounts'&&refs.includes(ACCOUNT2))value.data.push({...value.data[0],id:'act_302',account_id:'302'});
    if(kind==='accounts'){delete value.data[0].instagram_business_account;if(refs.includes(PAGE2))value.data.push({id:'402',name:'Offline second Page'});}
    return state.afterGraph?await state.afterGraph(kind,value):value;
  };
  f.restart();
  const request=(options,callback)=>{
    const url=new URL('https://graph.facebook.com'+options.path),input=url.searchParams.get('input_token');
    state.calls.push({path:url.pathname,fields:url.searchParams.get('fields'),method:options.method});
    if(url.pathname.endsWith('/debug_token')&&input===TOKEN)return f.request(options,callback);
    const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};req.end=()=>queueMicrotask(async()=>{try{
      await state.before?.(url,options);if(destroyed)return;assert.equal(options.hostname,'graph.facebook.com');assert.equal(options.rejectUnauthorized,true);assert.equal(options.method,'GET');
      const bearer=options.headers.authorization.replace(/^Bearer /,''),page=bearer.match(/^FICTITIOUS_PAGE_TOKEN_(401|402)$/)?.[1];let raw;
      if(url.pathname.endsWith('/debug_token'))raw={data:{app_id:b.appId,type:'PAGE',profile_id:input.slice(-3),is_valid:true,expires_at:0,data_access_expires_at:0,scopes:L.REQUIRED_SCOPES}};
      else if(/^\/v24\.0\/40[12]$/.test(url.pathname)){const id=url.pathname.split('/').pop();assert.equal(bearer,TOKEN);raw={id,access_token:'FICTITIOUS_PAGE_TOKEN_'+id};}
      else if(url.pathname==='/v24.0/me')raw={id:page};
      else if(url.pathname.endsWith('/leadgen_forms'))raw={data:[{id:page==='401'?'702':'703',page_id:page}]};
      else if(url.pathname.endsWith('/leads'))raw={data:[{id:'701'}]};
      else if(url.pathname.endsWith('/subscribed_apps'))raw={data:[{id:b.appId,subscribed_fields:['leadgen']}]};
      else if(/^\/v24\.0\/70[23]$/.test(url.pathname))raw={id:url.pathname.split('/').pop(),name:'Offline form',page_id:page,status:'ACTIVE',...(url.searchParams.get('fields').includes('questions')?{questions:[{key:'full_name',type:'FULL_NAME'},{key:'email',type:'EMAIL'}]}:{})};
      else if(url.pathname==='/v24.0/603')raw={id:'603',account_id:'301',campaign_id:'601',adset_id:'602'};
      else if(url.pathname==='/v24.0/701')raw={id:'701',form_id:'702',ad_id:'603',campaign_id:'601',is_organic:false,created_time:'2026-11-07T12:00:00+0000',...(url.searchParams.get('fields').includes('field_data')?{field_data:[{name:'full_name',values:['OFFLINE_PERSON']},{name:'email',values:['offline@example.invalid']}]}:{})};
      else if(/^\/v24\.0\/act_30[12]\/campaigns$/.test(url.pathname))raw={data:[{id:'601',name:'Offline campaign'}]};
      else assert.fail('Unexpected offline Graph target '+url.pathname);
      const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};callback(res);res.end(JSON.stringify(raw));
    }catch(error){req.emit('error',error);}});return req;
  };
  const pacer=require('../src/meta-marketing-ads-pacing').createPacing({state:require('../src/meta-marketing-ads-pacing').sqliteState(f.current.store.db),now:f.now,wait:async ms=>{f.state.clock+=ms;}});
  const cursor=require('../src/provider-cursor').cursorCodec(randomBytes(32),f.now);
  const enrollment=createMetaMarketingEnrollment({store:f.current.store,secrets:f.secrets,http:f.http,environment:'staging',now:f.now,credentialEpochs:f.current.epochs,
    adsRead,leadAds,...(dynamic?{enrolledAssetAccess}:{}),adsHttp:require('../src/meta-marketing-ads-http').createMetaMarketingAdsHttp({request,pacer,cursor,now:f.now}),leadsHttp:require('../src/meta-marketing-leads-http').createMetaMarketingLeadsHttp({request,pacer,cursor,now:f.now})});
  const renewal=require('../src/meta-marketing-credential-renewal').createMetaMarketingCredentialRenewal({store:f.current.store,epochs:f.current.epochs,enrollment,oauth:f.current.engine,secrets:f.secrets,http:f.http,environment:'staging',now:f.now});
  t.after(()=>{renewal.close();enrollment.close();});
  const current={store:f.current.store};
  // Broker has a closed operation map; compose the actual OAuth owner explicitly.
  current.broker=new Broker({store:f.current.store,policy:f.policy,secrets:f.secrets,policyResolver:enrollment,now:f.now,transportProfile:'meta-marketing',operations:{...require('../src/meta-marketing-oauth').createMetaMarketingOAuthOperations(f.current.engine,{assetDiscovery:true}),...enrollment.operations,...renewal.operations}});
  const execute=(operation,payload,overrides={},role=false)=>f.execute(operation,payload,{...scope,...overrides},role,current);
  const flowId=randomUUID(),flowPayload={state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000,scopeDigest:C.hash('OFFLINE_DIRECT_CLINIC_SNAPSHOT'),clinicSetDigest:C.clinicDigest(b)};
  await execute(C.OPERATIONS.begin,flowPayload,{requestId:flowId});const candidate=(await execute(C.OPERATIONS.finish,{flowId,state:flowPayload.state,code:'OFFLINE_CODE_'+flowId})).data.candidate;
  const id=randomUUID(),prepared=(await execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId,scopeDigest:flowPayload.scopeDigest,candidateDigest:candidate.digest,assetRefs:refs})).data;
  if(active)await execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:flowPayload.scopeDigest,selectionDigest:prepared.selectionDigest});
  const ads=(ref=ACCOUNT,overrides={},role='reader')=>execute(A.OPERATIONS.campaigns,{pageToken:null},{assetRef:ref,...overrides},role);
  const lead=(operation='pageStatus',payload={adAccountAssetRef:ACCOUNT},overrides={},role='reader')=>execute(L.OPERATIONS[operation],payload,{assetRef:PAGE,...overrides},role);
  const accept=(page='401',account=ACCOUNT)=>{const raw=Buffer.from(JSON.stringify({object:'page',entry:[{id:page,changes:[{field:'leadgen',value:{leadgen_id:'701',page_id:page,form_id:page==='401'?'702':'703',ad_id:'603'}}]}]}));return lead('receiptAccept',{adAccountAssetRef:account,rawBase64:raw.toString('base64'),signature:'sha256='+createHmac('sha256',APP).update(raw).digest('hex')},{assetRef:'meta-facebook_page:'+page});};
  function next(){const renewalId=randomUUID(),effective=f.current.epochs.current(current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(id),f.binding);
    const payload={renewalId,flowId:renewalId,enrollmentId:id,expectedEpoch:effective.epoch,expectedVersionId:effective.versionId,expectedCandidateDigest:effective.digest,assetSetDigest:R.assetSetDigest(prepared.assets),scopeDigest:flowPayload.scopeDigest,clinicSetDigest:C.clinicDigest(b),state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
    return {id:renewalId,begin:()=>execute(R.OPERATIONS.begin,payload),finish:()=>execute(R.OPERATIONS.finish,{renewalId,flowId:renewalId,state:payload.state,code:'OFFLINE_RENEWAL_'+renewalId}),status:()=>execute(R.OPERATIONS.status,{renewalId},{},true),abort:()=>execute(R.OPERATIONS.abort,{renewalId},{},true),activate:candidate=>execute(R.OPERATIONS.activate,{renewalId,enrollmentId:id,expectedEpoch:effective.epoch,expectedVersionId:effective.versionId,expectedCandidateDigest:effective.digest,candidateVersionId:renewalId,candidateDigest:candidate.digest})};}
  const immutable=()=>JSON.stringify(['meta_marketing_enrollments','meta_marketing_enrollment_assets','meta_marketing_enrollment_claims','asset_revocations'].map(table=>current.store.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()));
  return {f,state,scope,execute,current,enrollment,id,flowId,ads,lead,accept,next,immutable,adsRead,leadAds,enrolledAssetAccess};
}

test('unknown selected assets work through signed USER broker without physical allowlists; receipts retain null direct recipient and no contacts',async t=>{
  const r=await ready(t),before=r.immutable(),policy=JSON.stringify(r.f.policy),puts=r.f.state.puts;
  runtime.validateConfig(r.f.config);assert(!r.f.binding.metaMarketingOAuth.scopes.includes('instagram_basic'));
  assert.equal((await r.ads()).data.results[0].id,'601');assert.equal((await r.lead()).data.page.id,'401');
  const accepted=(await r.accept()).data,receiptRef=accepted.receipts[0].receiptRef;
  assert.deepEqual((await r.accept()).data,accepted);const lead=(await r.lead('receiptRead',{adAccountAssetRef:ACCOUNT,receiptRef})).data;
  assert.equal(lead.recipientClinicId,null);assert.equal(lead.identity.account_id,'301');assert.equal(lead.lead.field_data[0].values[0],'OFFLINE_PERSON');
  const receipt=r.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE id=?').get(receiptRef);assert.equal(receipt.recipient_clinic,null);assert.equal(receipt.tenant,'clinic:95');
  const journal=JSON.stringify(['commands','audit_outbox','meta_marketing_lead_receipts'].map(table=>r.current.store.db.prepare('SELECT * FROM '+table).all()));
  for(const secret of [TOKEN,APP,'OFFLINE_PERSON','offline@example.invalid'])assert(!journal.includes(secret));
  assert.equal(r.immutable(),before);assert.equal(JSON.stringify(r.f.policy),policy);assert.equal(r.f.state.puts,puts);
});

test('absent opt-in, another direct scope, groups, missing eighth scope and prepared enrollment deny before Secrets/Graph',async t=>{
  for(const options of [{dynamic:false},{scopeKey:'clinic:96',clinicIds:[96]},{scopeKey:'group:9',clinicIds:[71,72]},{missingScope:'ads_management'},{active:false}]){
    const r=await ready(t,options),before=r.f.state.awsCalls.length;r.state.calls=[];
    await assert.rejects(r.ads(),{code:'scope_denied'});await assert.rejects(r.lead(),{code:'scope_denied'});await assert.rejects(r.accept(),{code:'scope_denied'});
    assert.equal(r.f.state.awsCalls.length,before);assert.equal(r.state.calls.length,0);assert.equal(r.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_lead_receipts').get().n,0);
  }
});

test('strict Root scope list and config prerequisites reject wildcard, group, duplicates, unknown fields, missing bindings and business overlap',async t=>{
  const r=await ready(t);runtime.validateConfig(r.f.config);
  for(const mutate of [c=>delete c.adsRead,c=>delete c.leadAds,c=>c.assetEnrollment=false,c=>c.assetDiscovery=false,c=>c.standby=true,c=>c.enrolledAssetAccess.enabled=false,c=>c.enrolledAssetAccess.scopeKeys=[],c=>c.enrolledAssetAccess.scopeKeys=['*'],c=>c.enrolledAssetAccess.scopeKeys=['group:95'],c=>c.enrolledAssetAccess.scopeKeys=['clinic:95','clinic:95'],c=>c.enrolledAssetAccess.scopeKeys=['clinic:96'],c=>c.enrolledAssetAccess.scopeKeys=['clinic:2147483648'],c=>c.enrolledAssetAccess.scopeKeys=Array.from({length:65},(_,i)=>'clinic:'+(i+1)),c=>c.enrolledAssetAccess.recipientClinicId=95,c=>c.policy.connections[0].metaMarketingOAuth.scopes=c.policy.connections[0].metaMarketingOAuth.scopes.filter(s=>s!=='ads_management')]){
    const config=structuredClone(r.f.config);mutate(config);assert.throws(()=>runtime.validateConfig(config),{code:'invalid_request'});
  }
  const old=structuredClone(r.f.config);delete old.enrolledAssetAccess;runtime.validateConfig(old);
  for(const type of ['SYSTEM_USER','BUSINESS','AGENCY_SYSTEM_USER']){
    const metadata=JSON.parse(r.current.store.db.prepare('SELECT credential_metadata FROM meta_marketing_oauth_flows WHERE id=?').get(r.flowId).credential_metadata);metadata.tokenType=type;
    assert.throws(()=>X.authorize(r.enrolledAssetAccess,r.f.binding,metadata),{code:'scope_denied'});
  }
});

test('static Page route retains recipient and wrong-account denial even for an otherwise eligible dynamic enrollment',async t=>{
  const r=await ready(t,{refs:[PAGE,ACCOUNT,ACCOUNT2]});r.leadAds.pairs=[{pageAssetRef:PAGE,adAccountAssetRef:ACCOUNT,recipientClinicId:95}];
  assert.equal((await r.lead()).data.page.id,'401');const receiptRef=(await r.accept()).data.receipts[0].receiptRef;
  assert.equal(r.current.store.db.prepare('SELECT recipient_clinic FROM meta_marketing_lead_receipts WHERE id=?').get(receiptRef).recipient_clinic,95);
  const before=r.f.state.awsCalls.length;await assert.rejects(r.lead('pageStatus',{adAccountAssetRef:ACCOUNT2}),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);
  r.leadAds.pairs[0].recipientClinicId=96;await assert.rejects(r.lead(),{code:'scope_denied'});
});

test('multiple Pages share only the one selected account; multiple accounts deny dynamic Leads but allow selected Ads',async t=>{
  const pages=await ready(t,{refs:[PAGE,PAGE2,ACCOUNT]});assert.equal((await pages.lead('pageStatus',{adAccountAssetRef:ACCOUNT},{assetRef:PAGE2})).data.page.id,'402');
  await pages.accept();await pages.accept('402');const receipts=pages.current.store.db.prepare('SELECT page,generation,recipient_clinic FROM meta_marketing_lead_receipts ORDER BY page').all();assert.equal(receipts.length,2);assert.notEqual(receipts[0].generation,receipts[1].generation);assert(receipts.every(r=>r.recipient_clinic===null));
  const accounts=await ready(t,{refs:[PAGE,ACCOUNT,ACCOUNT2]});assert.equal((await accounts.ads(ACCOUNT2)).data.results[0].id,'601');const before=accounts.f.state.awsCalls.length;
  for(const account of [ACCOUNT,ACCOUNT2])await assert.rejects(accounts.lead('pageStatus',{adAccountAssetRef:account}),{code:'scope_denied'});assert.equal(accounts.f.state.awsCalls.length,before);
});

test('wrong tenant/connection, unselected assets, missing or foreign physical claims, digest changes and revocations fail before borrowing',async t=>{
  const r=await ready(t),db=r.current.store.db;
  for(const invoke of [()=>r.ads(ACCOUNT,{tenantRef:'clinic:96'}),()=>r.ads(ACCOUNT,{connectionRef:'connection:other'}),()=>r.ads(ACCOUNT2),()=>r.lead('pageStatus',{adAccountAssetRef:ACCOUNT2}),()=>r.ads(ACCOUNT,{},false),()=>r.lead('pageStatus',{adAccountAssetRef:ACCOUNT},{},true)]){
    const before=r.f.state.awsCalls.length;await assert.rejects(invoke());assert.equal(r.f.state.awsCalls.length,before);
  }
  for(const mutation of [()=>db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run(PAGE),()=>db.prepare('UPDATE meta_marketing_enrollment_claims SET enrollment=? WHERE asset=?').run(randomUUID(),PAGE),()=>db.prepare('UPDATE meta_marketing_enrollments SET selection_digest=? WHERE id=?').run('0'.repeat(64),r.id),()=>db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:95',r.scope.connectionRef,PAGE,randomUUID(),r.f.now())]){
    db.exec('SAVEPOINT offline_case');mutation();const before=r.f.state.awsCalls.length;await assert.rejects(r.ads());assert.equal(r.f.state.awsCalls.length,before);db.exec('ROLLBACK TO offline_case; RELEASE offline_case');
  }
});

test('dynamic scope removal and physical revocation during real provider HTTP reads suppress output',async t=>{
  for(const kind of ['config','claim','revoke']){
    const r=await ready(t);let changed=false;r.state.before=url=>{if(changed||!url.pathname.endsWith('/campaigns'))return;changed=true;
      if(kind==='config')r.enrolledAssetAccess.scopeKeys=['clinic:96'];
      if(kind==='claim')r.current.store.db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run(ACCOUNT);
      if(kind==='revoke')r.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:95',r.scope.connectionRef,ACCOUNT,randomUUID(),r.f.now());};
    await assert.rejects(r.ads(),{code:kind==='revoke'?'asset_revoked':'scope_denied'});assert(changed);
  }
  const lead=await ready(t),receiptRef=(await lead.accept()).data.receipts[0].receiptRef;lead.state.before=url=>{if(url.pathname==='/v24.0/702')lead.current.store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:95',lead.scope.connectionRef,PAGE,randomUUID(),lead.f.now());};
  await assert.rejects(lead.lead('receiptRead',{adAccountAssetRef:ACCOUNT,receiptRef}),{code:'asset_revoked'});assert(!lead.state.calls.some(call=>call.fields?.includes('field_data')));
});

for(const kind of ['granular','paid_granular','revoked','missing_ads_management'])test('dynamic renewal rejects '+kind+' and preserves old effective credential before valid same-asset renewal',async t=>{
  const r=await ready(t),before=r.immutable(),n=r.next();await n.begin();
  r.state.afterGraph=(type,value)=>{if(type==='inspect'){
    if(kind==='granular')value.data.granular_scopes.push({scope:'pages_manage_metadata',target_ids:[]});
    if(kind==='paid_granular')value.data.granular_scopes.push({scope:'ads_management',target_ids:[]});
    if(kind==='revoked')value.data.is_valid=false;
    if(kind==='missing_ads_management')value.data.scopes=value.data.scopes.filter(s=>s!=='ads_management');
  }return value;};
  await assert.rejects(n.finish(),{code:{granular:'scope_denied',paid_granular:'scope_denied',revoked:'credential_revoked',missing_ads_management:'oauth_credentials_incomplete'}[kind]});
  r.state.afterGraph=null;assert.equal((await n.status()).data.effectiveCredential.epoch,0);assert.equal(r.immutable(),before);assert.equal((await r.ads()).data.results[0].id,'601');
  const valid=r.next();await valid.begin();const candidate=(await valid.finish()).data.candidate;assert.equal((await valid.activate(candidate)).data.effectiveCredential.epoch,1);assert.equal((await r.lead()).data.page.id,'401');assert.equal(r.immutable(),before);
});

test('cancelling dynamic renewal retains the existing credential and selected assets',async t=>{
  const r=await ready(t),before=r.immutable(),n=r.next();await n.begin();await n.abort();
  assert.equal((await n.status()).data.effectiveCredential.epoch,0);assert.equal((await r.ads()).data.results[0].id,'601');assert.equal(r.immutable(),before);
});

test('dynamic expired credential is denied for reads but can renew the same assets without extending the old grant',async t=>{
  const r=await ready(t),before=r.immutable();r.f.state.clock+=3601000;
  await assert.rejects(r.ads(),{code:'credential_revoked'});await assert.rejects(r.lead(),{code:'credential_revoked'});
  const n=r.next();await n.begin();const candidate=(await n.finish()).data.candidate;assert.equal((await n.activate(candidate)).data.effectiveCredential.epoch,1);
  assert.equal((await r.lead()).data.page.id,'401');assert.equal(r.immutable(),before);
});

test('actual TLS runtime accepts the optional cohort and serves unknown selected assets with no new physical allowlist',async t=>{
  const r=await ready(t),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process');
  const {allowPort,removePort}=require('./offline-guard.cjs'),config={...r.f.config,stateFile:r.f.filename};
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));config.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(config.port);
  const filename=path.join(r.f.dir,'enrolled-access-runtime.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  // The real TLS runtime builds its own readers. Borrow only the offline
  // transports from this fixture, never a replacement enrollment resolver.
  const transport=options=>{throw Error('UNEXPECTED_REAL_NETWORK_'+options.hostname);};
  const request=(options,callback)=>{
    const url=new URL('https://graph.facebook.com'+options.path);if(url.pathname.endsWith('/debug_token'))return r.f.request(options,callback);
    assert.equal(url.pathname,'/v24.0/act_301/campaigns');const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};callback(res);res.end(JSON.stringify({data:[{id:'601',name:'Offline TLS campaign'}]}));});return req;
  };
  let app=await runtime.main(filename,{awsFactory:async()=>({secrets:r.f.aws,sink:{async write(){return {versionId:'OFFLINE_TLS_AUDIT',digest:'offline'};}},close(){}}),http:r.f.http,adsRequest:request,leadsRequest:transport,adsNow:r.f.now,adsWait:async ms=>{r.f.state.clock+=ms;}});
  t.after(async()=>{if(app)await app.close();removePort(config.port);});
  const client=require('../../../src/lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+config.port,audience:config.policy.audience,keyId:'qa-reader',privateKey:r.f.reader.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(config.tlsCertFile),transportProfile:'meta-marketing',timeoutMs:30000});
  const result=await client.execute(r.f.command(A.OPERATIONS.campaigns,{pageToken:null},{...r.scope,assetRef:ACCOUNT}));assert.equal(result.data.results[0].name,'Offline TLS campaign');
  const challenge=await client.execute(r.f.command(L.OPERATIONS.challenge,{adAccountAssetRef:ACCOUNT,mode:'subscribe',token:VERIFY,challenge:'13579'},{...r.scope,assetRef:PAGE}));assert.deepEqual(challenge.data,{challenge:'13579'});
  await app.close();app=null;
});
