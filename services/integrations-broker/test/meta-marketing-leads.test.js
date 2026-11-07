'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHmac,randomUUID,randomBytes}=require('node:crypto'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const L=require('../src/meta-marketing-leads-contract'),E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract'),{Broker}=require('../src/broker');
const {createMetaMarketingEnrollment}=require('../src/meta-marketing-enrollment'),{createMetaMarketingOAuthOperations}=require('../src/meta-marketing-oauth'),{createMetaMarketingLeadsHttp}=require('../src/meta-marketing-leads-http'),{createPacing,sqliteState}=require('../src/meta-marketing-ads-pacing'),{cursorCodec}=require('../src/provider-cursor');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const PAGE='meta-facebook_page:401',ACCOUNT='meta-ad_account:301',PAGE_TOKEN='FICTITIOUS_OWNER_PAGE_TOKEN',VERIFY='FICTITIOUS_INDEPENDENT_VERIFY_TOKEN_1234567890';
const event=(ad='603')=>({lead_id:'701',page_id:'401',form_id:'702',ad_id:ad});
const rawEvent=(ad='603')=>Buffer.from(JSON.stringify({object:'page',entry:[{id:'401',changes:[{field:'leadgen',value:{leadgen_id:'701',page_id:'401',form_id:'702',...(ad===null?{}:{ad_id:ad}),field_data:[{name:'email',values:['IGNORED_PII@example.invalid']} ]}}]}]}));
const acceptPayload=(raw=rawEvent())=>({adAccountAssetRef:ACCOUNT,rawBase64:raw.toString('base64'),signature:'sha256='+createHmac('sha256',APP).update(raw).digest('hex')});
const {ready}=require('./meta-marketing-leads-fixture.cjs');
test('Lead capability is off by default; closed inputs reject secrets/URLs/arbitrary lead IDs',async t=>{
  const r=await ready(t,{optin:false}),before=r.f.state.awsCalls.length;
  await assert.rejects(r.execute('receiptAccept',acceptPayload()),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);assert.equal(r.state.calls.length,0);
  for(const value of [{adAccountAssetRef:ACCOUNT,leadId:'701'},{adAccountAssetRef:ACCOUNT,receiptRef:randomUUID(),url:'https://evil.invalid'}])assert.throws(()=>L.validate(L.OPERATIONS.receiptRead,value),{code:'invalid_request'});
  assert.equal(M.SCOPES.includes('ads_management'),false);
});
test('HMAC is verified before parsing; owner receipts are durable/idempotent and contain IDs only',async t=>{
  const r=await ready(t),raw=rawEvent(),p=acceptPayload(raw);
  await assert.rejects(r.execute('receiptAccept',{...p,signature:'sha256='+'0'.repeat(64)}),{code:'invalid_signature'});assert.equal(r.state.calls.length,0);
  const a=(await r.execute('receiptAccept',p)).data,b=(await r.execute('receiptAccept',p)).data;assert.deepEqual(a,b);assert.deepEqual(a.receipts[0].event,event());assert.equal(r.state.calls.length,0);
  const snapshot=JSON.stringify(r.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts').all());assert(!snapshot.includes('IGNORED_PII'));assert(!snapshot.includes(APP));assert(!snapshot.includes(TOKEN));assert(!snapshot.includes(PAGE_TOKEN));
  const unknown=rawEvent();const v=JSON.parse(unknown);v.entry[0].changes.push({field:'messages',value:{}});await assert.rejects(r.execute('receiptAccept',acceptPayload(Buffer.from(JSON.stringify(v)))),{code:'scope_denied'});
});
test('independent pinned verify token handles challenge without Graph and rejects wrong token/version',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,mode:'subscribe',token:VERIFY,challenge:'12345678'};
  assert.deepEqual((await r.execute('challenge',p)).data,{challenge:'12345678'});assert.equal(r.state.calls.length,0);
  await assert.rejects(r.execute('challenge',{...p,token:'X'.repeat(43)}),{code:'invalid_signature'});
  r.f.records.get(r.config.verifyTokenRef.secretArn).get(r.config.verifyTokenRef.versionId).stages=[];await assert.rejects(r.execute('challenge',p),{code:'secret_version_changed'});
});
test('receiptRead validates Page/form/Ad/account before contact read, strips extra PII and never journals contacts',async t=>{
  const r=await ready(t),accepted=(await r.execute('receiptAccept',acceptPayload())).data,p={adAccountAssetRef:ACCOUNT,receiptRef:accepted.receipts[0].receiptRef};
  const data=(await r.execute('receiptRead',p)).data;assert.equal(data.recipientClinicId,71);assert.deepEqual(data.identity,{account_id:'301',campaign_id:'601',ad_id:'603',adset_id:'602'});assert.equal(data.lead.field_data.length,3);assert(!JSON.stringify(data).includes('NEVER_RETURN'));
  const ad=r.state.calls.findIndex(c=>c.path==='/v24.0/603'),contact=r.state.calls.findIndex(c=>c.path==='/v24.0/701'&&c.fields.includes('field_data'));assert(ad>=0&&ad<contact);
  for(let i=1;i<r.state.calls.length;i++)assert(r.state.calls[i].at-r.state.calls[i-1].at>=1000);
  const journal=JSON.stringify(r.current.store.db.prepare('SELECT * FROM commands').all())+JSON.stringify(r.current.store.db.prepare('SELECT * FROM audit_outbox').all());for(const privateText of ['FICTITIOUS_PERSON','qa@example.invalid','+34600000000',PAGE_TOKEN,TOKEN,APP])assert(!journal.includes(privateText));
  await assert.rejects(r.execute('receiptRead',{...p,receiptRef:randomUUID()}),{code:'scope_denied'});
});
test('wrong account or form Page never reaches contact query; foreign pair is denied before Secrets',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,receiptRef:(await r.execute('receiptAccept',acceptPayload())).data.receipts[0].receiptRef};
  r.state.adAccount='999';await assert.rejects(r.execute('receiptRead',p),{code:'scope_denied'});assert(!r.state.calls.some(c=>c.fields?.includes('field_data')));
  r.state.calls=[];r.state.adAccount='301';r.state.formPage='999';await assert.rejects(r.execute('receiptRead',p),{code:'scope_denied'});assert(!r.state.calls.some(c=>c.path==='/v24.0/701'));
  const before=r.f.state.awsCalls.length;await assert.rejects(r.execute('receiptRead',{...p,adAccountAssetRef:'meta-ad_account:999'}),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);
});
test('missing ad in signed notification is preserved while paid identity is verified; explicit Page route supports organic',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,receiptRef:(await r.execute('receiptAccept',acceptPayload(rawEvent(null)))).data.receipts[0].receiptRef};
  const paid=(await r.execute('receiptRead',p)).data;assert.equal(paid.event.ad_id,null);assert.equal(paid.lead.ad_id,'603');assert.equal(paid.identity.ad_id,'603');
  r.state.adId=null;r.state.organic=true;const organic=(await r.execute('receiptRead',p)).data;assert.equal(organic.identity,null);assert.equal(organic.recipientClinicId,71);assert.equal(organic.lead.is_organic,true);
});
test('Page enable preserves unrelated fields, uses Page proof, rejects stale revision and sends no retry',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT},status=(await r.execute('pageStatus',p)).data;
  await assert.rejects(r.execute('pageEnable',{...p,expectedSubscriptionRevision:'0'.repeat(64)}),{code:'idempotency_conflict'});assert(!r.state.calls.some(c=>c.method==='POST'));
  const enabled=(await r.execute('pageEnable',{...p,expectedSubscriptionRevision:status.subscription.revision})).data;assert.deepEqual(enabled.subscription.fields,['feed','leadgen']);assert.equal(r.state.calls.filter(c=>c.method==='POST').length,1);
  await r.execute('pageEnable',{...p,expectedSubscriptionRevision:enabled.subscription.revision});assert.equal(r.state.calls.filter(c=>c.method==='POST').length,1);
});
test('destination reads project only identifiers/status and seal pagination to campaign/account',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,campaignId:'601',cursor:null},data=(await r.execute('destinations',p)).data;
  assert.deepEqual(data.results[0].creative,{id:'604',page_id:'401',lead_gen_form_id:'702'});assert.equal(data.nextCursor,null);L.validateResponse(L.OPERATIONS.destinations,data,p);
  assert.throws(()=>L.validateResponse(L.OPERATIONS.destinations,{...data,accessToken:'x'},p),{code:'provider_failed'});
});
test('destination opaque pagination rejects cross-campaign cursors, foreign URLs and encoded secret reflections',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,campaignId:'601',cursor:null},row={id:'603',account_id:'301',campaign_id:'601',adset_id:'602',effective_status:'ACTIVE',creative:{id:'604',call_to_action:{value:{lead_gen_form_id:'702'}}}};
  const page=after=>({data:[row],paging:{cursors:{after},next:'https://graph.facebook.com/v24.0/act_301/ads?'+new URLSearchParams({after})}});r.state.raw=page('AFTER_FICTITIOUS_1');const first=(await r.execute('destinations',p)).data;assert(first.nextCursor);assert(!first.nextCursor.includes('AFTER_FICTITIOUS_1'));
  const before=r.state.calls.length;await assert.rejects(r.execute('destinations',{...p,campaignId:'999',cursor:first.nextCursor}),{code:'invalid_request'});assert.equal(r.state.calls.length,before);
  r.state.raw={...page('AFTER_FICTITIOUS_2'),paging:{cursors:{after:'AFTER_FICTITIOUS_2'},next:'https://evil.invalid/v24.0/act_301/ads?after=AFTER_FICTITIOUS_2'}};await assert.rejects(r.execute('destinations',p),{code:'provider_failed'});
  r.state.raw=page('%46ICTITIOUS_META_OAUTH_TOKEN');await assert.rejects(r.execute('destinations',p),{code:'provider_failed'});
});
test('high application usage stops the next Graph call for two hours without returning a partial contact',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,receiptRef:(await r.execute('receiptAccept',acceptPayload())).data.receipts[0].receiptRef};r.state.headers={'x-app-usage':JSON.stringify({call_count:95})};
  await assert.rejects(r.execute('receiptRead',p),e=>e.code==='rate_limited'&&e.retryAfterMs===7200000);assert(!r.state.calls.some(c=>c.fields?.includes('field_data')));assert.equal(r.pacingState.load('meta-ads-app:101').pause_until,r.f.now()+7200000);
});
test('revocation during I/O fences output; provider 429 shares durable app cooldown and safe retry hint',async t=>{
  const r=await ready(t),p={adAccountAssetRef:ACCOUNT,receiptRef:(await r.execute('receiptAccept',acceptPayload())).data.receipts[0].receiptRef};
  let changed=false;r.state.before=url=>{if(!changed&&url.pathname==='/v24.0/702'){changed=true;r.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:71',r.f.binding.connectionRef,PAGE,randomUUID(),r.f.now());}};
  await assert.rejects(r.execute('receiptRead',p),{code:'asset_revoked'});assert(!r.state.calls.some(c=>c.fields?.includes('field_data')));
  const other=await ready(t);other.state.status=429;let error;try{await other.execute('pageStatus',{adAccountAssetRef:ACCOUNT});}catch(e){error=e;}assert.equal(error.code,'rate_limited');assert.equal(error.retryAfterMs,7200000);assert.equal(other.pacingState.load('meta-ads-app:101').pause_until,other.f.now()+7200000);
  const before=other.state.calls.length;await assert.rejects(other.execute('pageStatus',{adAccountAssetRef:ACCOUNT}),e=>e.code==='rate_limited'&&e.retryAfterMs>=7199000);assert.equal(other.state.calls.length,before);
});
test('receipt expiry/new generation requires visible manual review and never reassigns immutable identity',async t=>{
  const r=await ready(t),a=(await r.execute('receiptAccept',acceptPayload())).data,p={adAccountAssetRef:ACCOUNT,receiptRef:a.receipts[0].receiptRef};
  r.current.store.db.prepare('UPDATE meta_marketing_lead_receipts SET expires_at=? WHERE id=?').run(r.f.now(),p.receiptRef);
  await assert.rejects(r.execute('receiptRead',p),{code:'meta_lead_receipt_review_required'});assert.equal(r.state.calls.length,0);
  await assert.rejects(r.execute('receiptAccept',acceptPayload()),{code:'meta_lead_receipt_review_required'});assert.equal(r.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_lead_receipts').get().n,1);
});
test('changing the configured Page recipient cannot reroute an old receipt within the same enrollment',async t=>{
  const r=await ready(t),a=(await r.execute('receiptAccept',acceptPayload())).data,p={adAccountAssetRef:ACCOUNT,receiptRef:a.receipts[0].receiptRef};
  const before=r.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE id=?').get(p.receiptRef);assert.equal(before.recipient_clinic,71);r.config.pairs[0].recipientClinicId=72;
  await assert.rejects(r.execute('receiptRead',p),{code:'meta_lead_receipt_review_required'});assert.equal(r.state.calls.length,0);
  await assert.rejects(r.execute('receiptAccept',acceptPayload()),{code:'meta_lead_receipt_review_required'});
  assert.deepEqual(r.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE id=?').get(p.receiptRef),before);
});
test('native carousel/template CTA metadata is bounded and ambiguous forms fail closed',()=>{
  const base={id:'603',account_id:'301',campaign_id:'601',adset_id:'602',effective_status:'ACTIVE',creative:{id:'604',object_story_spec:{page_id:'401',template_data:{child_attachments:[{call_to_action:{value:{lead_gen_form_id:'702'}}}]}}}};
  assert.equal(L.projectAd(base).creative.lead_gen_form_id,'702');base.creative.object_story_spec.template_data.child_attachments.push({call_to_action:{value:{lead_gen_form_id:'703'}}});assert.throws(()=>L.projectAd(base),{code:'provider_failed'});
});
test('transport opt-in admits 64KiB signed raw payload while default and Meta upper bounds stay enforced',async t=>{
  const {handler}=require('../src/server'),http=require('node:http'),{allowPort,removePort}=require('./offline-guard.cjs');
  async function server(profile){let calls=0;const app=http.createServer(handler({execute:async raw=>{calls++;return {bytes:raw.length};}},{transportProfile:profile}));await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const port=app.address().port;allowPort(port);t.after(async()=>{await new Promise(resolve=>app.close(resolve));removePort(port);});
    return {send:body=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:app.address().port,method:'POST',path:'/v1/execute',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(body);}),calls:()=>calls};}
  const legacy=await server('default'),meta=await server('meta-marketing'),body=JSON.stringify({rawBase64:Buffer.alloc(65536,65).toString('base64')});
  assert.equal((await legacy.send(body)).status,400);assert.equal(legacy.calls(),0);assert.equal((await meta.send(body)).status,200);assert.equal(meta.calls(),1);assert.equal((await meta.send('A'.repeat(131073))).status,400);assert.equal(meta.calls(),1);
});
test('rate-limited public hint is the only permitted extra and remains bounded',()=>{
  const {BrokerError,publicError}=require('../src/errors'),e=new BrokerError('rate_limited');e.retryAfterMs=7200000;e.token='NEVER';assert.deepEqual(publicError(e),{status:429,body:{error:{code:'rate_limited',retryAfterMs:7200000}}});e.retryAfterMs=Infinity;assert.deepEqual(publicError(e).body,{error:{code:'rate_limited'}});
});
test('actual TLS owner composes Lead config, pinned verification and signed large webhook without Graph at ingestion',async t=>{
  const r=await ready(t),f=r.f,fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process'),runtime=require('../src/meta-marketing-oauth-main');
  const {allowPort,removePort}=require('./offline-guard.cjs'),cfg={...f.config,stateFile:f.filename,leadAds:structuredClone(r.config)};
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',cfg.tlsKeyFile,'-out',cfg.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});fs.chmodSync(cfg.tlsKeyFile,0o600);fs.chmodSync(cfg.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));cfg.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(cfg.port);
  const file=path.join(f.dir,'lead-optin-config.json');fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  const awsFactory=async()=>({secrets:f.aws,sink:{async write(){return {versionId:'FICTITIOUS_LEAD_AUDIT_VERSION',digest:'fictitious'};}},close(){}});
  let app=await runtime.main(file,{awsFactory,http:f.http,leadsRequest:r.request,adsNow:f.now,adsWait:async ms=>{f.state.clock+=ms;}});t.after(async()=>{if(app)await app.close();removePort(cfg.port);});
  const client=require('../../../src/lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:`https://127.0.0.1:${cfg.port}`,audience:cfg.policy.audience,keyId:'qa-reader',privateKey:f.reader.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cfg.tlsCertFile),transportProfile:'meta-marketing',timeoutMs:30000});
  const send=(name,payload)=>client.execute(f.command(L.OPERATIONS[name],payload,{assetRef:PAGE}));
  assert.deepEqual((await send('challenge',{adAccountAssetRef:ACCOUNT,mode:'subscribe',token:VERIFY,challenge:'2468'})).data,{challenge:'2468'});
  const v=JSON.parse(rawEvent());v.padding='A'.repeat(45000);const raw=Buffer.from(JSON.stringify(v)),receipt=(await send('receiptAccept',acceptPayload(raw))).data;assert.equal(receipt.receipts.length,1);assert.equal(r.state.calls.length,0);
  const read=(await send('receiptRead',{adAccountAssetRef:ACCOUNT,receiptRef:receipt.receipts[0].receiptRef})).data;assert.equal(read.lead.id,'701');assert.equal(read.recipientClinicId,71);
  await app.close();app=null;
});
test('main shares one durable app clock across OAuth exchange, debug, discovery, asset, Ads and Lead calls',async t=>{
  const r=await ready(t),f=r.f,fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process'),runtime=require('../src/meta-marketing-oauth-main'),C=require('../src/meta-marketing-oauth-contract'),A=require('../src/meta-marketing-ads-contract'),D=require('../src/meta-marketing-discovery-contract');
  const {allowPort,removePort}=require('./offline-guard.cjs'),cfg={...structuredClone(f.config),stateFile:f.filename,leadAds:structuredClone(r.config),adsRead:{enabled:true,cohort:A.COHORT,assetRefs:[ACCOUNT]}};
  const other=structuredClone(cfg.policy.connections[0]);other.connectionRef='connection:meta-second-qa';other.secretArn=other.secretArn.replace('qa-candidate','qa-second-candidate');other.metaMarketingOAuth.scopeKey='group:10';other.metaMarketingOAuth.clinicIds=[81,82];cfg.policy.connections.push(other);
  for(const grant of cfg.policy.grants.slice())cfg.policy.grants.push({...grant,connectionRef:other.connectionRef,tenantRef:'clinic:81',assetRef:'meta-enroll:group:10'});
  f.records.set(other.secretArn,new Map([[other.metaMarketingOAuth.slotVersionId,{body:JSON.stringify({version:1,provider:'meta-marketing-oauth-slot',connectionRef:other.connectionRef,scopeKey:'group:10',clinicSetDigest:C.clinicDigest(other.metaMarketingOAuth),appId:'101'}),stages:['AWSCURRENT']}]]));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',cfg.tlsKeyFile,'-out',cfg.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});fs.chmodSync(cfg.tlsKeyFile,0o600);fs.chmodSync(cfg.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));cfg.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(cfg.port);const file=path.join(f.dir,'all-graph-pacing.json');fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  const calls=[],track=transport=>(options,callback)=>{calls.push({path:new URL('https://graph.facebook.com'+options.path).pathname,at:f.now()});return transport(options,callback);};
  const adsRequest=(options,cb)=>{if(!new URL('https://graph.facebook.com'+options.path).pathname.endsWith('/campaigns'))return f.request(options,cb);const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};cb(res);res.end(JSON.stringify({data:[{id:'601',name:'Fictitious campaign'}]}));});return req;};
  let app=await runtime.main(file,{awsFactory:async()=>({secrets:f.aws,sink:{async write(){return {versionId:'FICTITIOUS_PACING_AUDIT',digest:'fictitious'};}},close(){}}),oauthRequest:track(f.request),adsRequest:track(adsRequest),leadsRequest:track(r.request),adsNow:f.now,adsWait:async ms=>{f.state.clock+=ms;}});t.after(async()=>{if(app)await app.close();removePort(cfg.port);});
  const mk=(keyId,key)=>require('../../../src/lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:`https://127.0.0.1:${cfg.port}`,audience:cfg.policy.audience,keyId,privateKey:key.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cfg.tlsCertFile),transportProfile:'meta-marketing',timeoutMs:30000});
  const reader=mk('qa-reader',f.reader),gateway=mk('qa-gateway',f.gateway);
  await reader.execute(f.command(A.OPERATIONS.campaigns,{pageToken:null},{assetRef:ACCOUNT}));
  await reader.execute(f.command(L.OPERATIONS.pageStatus,{adAccountAssetRef:ACCOUNT},{assetRef:PAGE}));
  const flowId=randomUUID(),state=randomBytes(32).toString('base64url'),scope={connectionRef:other.connectionRef,tenantRef:'clinic:81',assetRef:'meta-enroll:group:10'};
  await gateway.execute(f.command(C.OPERATIONS.begin,{state,scopeDigest:C.hash('FICTITIOUS_SECOND_SCOPE'),clinicSetDigest:C.clinicDigest(other.metaMarketingOAuth),expiresAt:Date.now()+590000},{...scope,requestId:flowId}));
  await gateway.execute(f.command(C.OPERATIONS.finish,{flowId,state,code:'FICTITIOUS_META_CODE_'+flowId},scope));
  await gateway.execute(f.command(D.OPERATION,{flowId,scopeDigest:C.hash('FICTITIOUS_SECOND_SCOPE')},scope));
  await reader.execute(f.command(M.ASSET,{}, {assetRef:ACCOUNT}));
  assert(calls.some(c=>c.path.endsWith('/oauth/access_token')));assert(calls.some(c=>c.path.endsWith('/accounts')));assert(calls.some(c=>c.path.endsWith('/campaigns')));assert(calls.some(c=>c.path.endsWith('/subscribed_apps')));assert(calls.some(c=>c.path.endsWith('/act_301')));
  for(let i=1;i<calls.length;i++)assert(calls[i].at-calls[i-1].at>=1000,`shared pacing gap between ${calls[i-1].path} and ${calls[i].path}`);
  assert(f.current.store.db.prepare('SELECT next_allowed_at FROM meta_marketing_ads_pacing WHERE scope=?').get('meta-ads-app:101').next_allowed_at>0);
  await app.close();app=null;
});
test('real TLS receiptRead tolerates over ten seconds of paced Graph latency inside the owner budget',async t=>{
  const r=await ready(t),f=r.f,fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process'),runtime=require('../src/meta-marketing-oauth-main');
  const {allowPort,removePort}=require('./offline-guard.cjs'),cfg={...f.config,stateFile:f.filename,leadAds:structuredClone(r.config)};
  const receiptRef=(await r.execute('receiptAccept',acceptPayload())).data.receipts[0].receiptRef;
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',cfg.tlsKeyFile,'-out',cfg.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});fs.chmodSync(cfg.tlsKeyFile,0o600);fs.chmodSync(cfg.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));cfg.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(cfg.port);
  const file=path.join(f.dir,'lead-real-latency-config.json');fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  const calls=[];r.state.before=async()=>new Promise(resolve=>setTimeout(resolve,1500));
  const request=(options,cb)=>{calls.push(Date.now());return r.request(options,cb);};
  let app=await runtime.main(file,{awsFactory:async()=>({secrets:f.aws,sink:{async write(){return {versionId:'FICTITIOUS_LATENCY_AUDIT',digest:'fictitious'};}},close(){}}),http:f.http,leadsRequest:request});t.after(async()=>{if(app)await app.close();removePort(cfg.port);});
  const client=require('../../../src/lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:`https://127.0.0.1:${cfg.port}`,audience:cfg.policy.audience,keyId:'qa-reader',privateKey:f.reader.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cfg.tlsCertFile),transportProfile:'meta-marketing',timeoutMs:30000});
  const started=Date.now(),response=await client.execute(f.command(L.OPERATIONS.receiptRead,{adAccountAssetRef:ACCOUNT,receiptRef},{assetRef:PAGE})),elapsed=Date.now()-started;
  assert(elapsed>10000,`provider latency reproduction ran only ${elapsed}ms`);assert(elapsed<25000);assert.equal(response.data.lead.id,'701');assert.equal(response.data.recipientClinicId,71);assert.equal(calls.length,9);
  for(let i=1;i<calls.length;i++)assert(calls[i]-calls[i-1]>=990);
  // These are meta_marketing_oauth control operations: Broker dispatches them
  // directly. The owner's 25s AbortController remains their actual deadline;
  // the generic 10s Broker budget is not applied to this control dispatch.
  await app.close();app=null;
});
