'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const A=require('../src/meta-marketing-ads-contract'),M=require('../src/meta-marketing-contract'),E=require('../src/meta-marketing-enrollment-contract');
const {createMetaMarketingAdsHttp}=require('../src/meta-marketing-ads-http'),{createPacing,sqliteState}=require('../src/meta-marketing-ads-pacing');
const {cursorCodec}=require('../src/provider-cursor'),{Broker}=require('../src/broker');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const {createMetaMarketingEnrollment}=require('../src/meta-marketing-enrollment'),{createMetaMarketingOAuthOperations}=require('../src/meta-marketing-oauth');
const REF='meta-ad_account:301',config={enabled:true,cohort:A.COHORT,assetRefs:[REF]};
const payload=name=>['insights','actions'].includes(name)?{pageToken:null,startDate:'2026-10-01',endDate:'2026-10-03'}:{pageToken:null};
function row(name,id='601'){
  if(name==='campaigns')return {id,name:'Campaña ficticia',status:'ACTIVE',effective_status:'ACTIVE',objective:'OUTCOME_LEADS',buying_type:'AUCTION',created_time:'2026-10-01T12:00:00+0000',updated_time:'2026-10-01T12:00:00+0000'};
  if(name==='adsets')return {id,name:'Conjunto ficticio',campaign_id:'601',status:'ACTIVE'};
  if(name==='ads')return {id,name:'Anuncio ficticio',campaign_id:'601',adset_id:'602',creative:{id:'604',effective_instagram_media_id:'605',effective_object_story_id:'401_606',instagram_permalink_url:'https://www.instagram.com/p/Fictitious/'}};
  const base={ad_id:id,date_start:'2026-10-01',date_stop:'2026-10-01',publisher_platform:'instagram',platform_position:'feed'};
  return name==='actions'?{...base,actions:[{action_type:'lead',value:'2'}]}:{...base,impressions:'120',reach:'100',clicks:'7',inline_link_clicks:'6',spend:'10.25',cpc:'1.464',cpm:'85.41',ctr:'5.83',frequency:'1.2'};
}
async function ready(t,{optin=true}={}){
  const f=fixture(t,{enrollment:true}),flow=await f.begin(),candidate=(await f.finish(flow)).data.candidate,id=randomUUID();
  const p=(await f.execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:candidate.digest,assetRefs:[REF]})).data;
  await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:flow.payload.scopeDigest,selectionDigest:p.selectionDigest});
  const state={calls:[],before:null,raw:null,status:200,headers:{},mode:'campaigns',inspectError:null};
  const request=(options,cb)=>{
    const url=new URL('https://graph.facebook.com'+options.path);state.calls.push({at:f.now(),path:url.pathname,query:Object.fromEntries(url.searchParams),method:options.method});
    if(url.pathname.endsWith('/debug_token')&&!state.inspectError)return f.request(options,cb);
    const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};req.end=()=>queueMicrotask(async()=>{
      try{await state.before?.();if(destroyed)return;
        assert.equal(options.hostname,'graph.facebook.com');assert.equal(options.method,'GET');assert.equal(options.rejectUnauthorized,true);
        const res=new PassThrough();res.statusCode=state.status;res.headers={'content-type':'application/json',...state.headers};cb(res);
        const raw=url.pathname.endsWith('/debug_token')?state.inspectError:(typeof state.raw==='function'?state.raw(url):state.raw)||{data:[row(state.mode)]};res.end(JSON.stringify(raw));
      }catch(e){req.emit('error',e);}
    });return req;
  };
  const pacingState=sqliteState(f.current.store.db),pacer=createPacing({state:pacingState,now:f.now,wait:async ms=>{f.state.clock+=ms;}});
  const adsHttp=createMetaMarketingAdsHttp({request,pacer,cursor:cursorCodec(randomBytes(32),f.now),now:f.now});
  const enrollment=createMetaMarketingEnrollment({store:f.current.store,secrets:f.secrets,http:f.http,environment:'staging',now:f.now,...(optin?{adsRead:config,adsHttp}:{})});
  t.after(()=>enrollment.close());
  const broker=new Broker({store:f.current.store,policy:f.policy,secrets:f.secrets,policyResolver:enrollment,operations:{...createMetaMarketingOAuthOperations(f.current.engine,{assetDiscovery:true}),...enrollment.operations},now:f.now});
  const current={broker,store:f.current.store};
  const execute=(name,input=payload(name),overrides={},role='reader')=>{state.mode=name;return f.execute(A.OPERATIONS[name],input,{assetRef:REF,...overrides},role,current);};
  return {f,state,execute,current,enrollment,pacer,pacingState,flow,request};
}
test('Ads remains denied by default after enrollment; metadata operations and original scopes are unchanged',async t=>{
  const r=await ready(t,{optin:false}),before=r.f.state.awsCalls.length;
  await assert.rejects(r.execute('campaigns'),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);assert.equal(r.state.calls.length,0);
  assert.equal(M.OPERATIONS.length,2);assert.equal(M.SCOPES.includes('ads_management'),false);
  const response=await r.f.execute(M.ASSET,{}, {assetRef:REF},'reader',r.current);assert.equal(response.data.id,'act_301');
});
test('five typed Ads families use fixed fields and preserve daily dimensions; no credentials, provider URL or unknown fields escape',async t=>{
  const r=await ready(t);
  for(const name of Object.keys(A.OPERATIONS)){
    r.state.raw={data:[{...row(name),access_token:TOKEN,unknown:APP}]};const response=(await r.execute(name)).data;
    assert.deepEqual(response.results,[A.projectRow(name,row(name),payload(name))]);assert.equal(response.nextPageToken,null);A.validatePage(A.OPERATIONS[name],response,payload(name));
    assert(!JSON.stringify(response).includes(TOKEN));assert(!JSON.stringify(response).includes(APP));
    const call=r.state.calls.at(-2);assert.equal(call.path,`/v24.0/act_301/${['actions','insights'].includes(name)?'insights':name}`);assert.equal(call.query.fields,A.FIELDS[name]);assert.equal(call.query.limit,'50');
    if(['actions','insights'].includes(name)){assert.equal(call.query.level,'ad');assert.equal(call.query.time_increment,'1');assert.equal(call.query.breakdowns,'publisher_platform,platform_position');}
  }
  for(let i=1;i<r.state.calls.length;i++)assert(r.state.calls[i].at-r.state.calls[i-1].at>=1000);
  assert.equal(r.f.state.codes,1);assert.equal(r.f.state.puts,1);
  const stored=JSON.stringify(r.current.store.db.prepare('SELECT * FROM commands').all())+JSON.stringify(r.current.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert(!stored.includes('Campaña ficticia'));assert(!stored.includes(TOKEN));assert(!stored.includes(APP));
});
test('exact payload schemas reject arbitrary URLs, fields, tokens and windows over three days before Secrets or Graph',async t=>{
  const r=await ready(t),before=r.f.state.awsCalls.length;
  for(const input of [{},{pageToken:null,url:'https://graph.facebook.com/me'},{pageToken:null,fields:'access_token'},{pageToken:null,accessToken:TOKEN}])await assert.rejects(r.execute('campaigns',input),{code:'invalid_request'});
  for(const input of [{...payload('insights'),endDate:'2026-10-04'},{...payload('insights'),startDate:'2026-02-30'},{...payload('insights'),endDate:'2026-09-30'}])await assert.rejects(r.execute('insights',input),{code:'invalid_request'});
  assert.equal(r.f.state.awsCalls.length,before);assert.equal(r.state.calls.length,0);
});
test('opaque cursors bind account, operation, dates and TTL; never return a provider URL or access_token',async t=>{
  const r=await ready(t);r.state.raw=url=>({data:[row(r.state.mode)],...(url.searchParams.has('after')?{}:{paging:{cursors:{after:'FICTITIOUS_AFTER'},next:`https://graph.facebook.com${url.pathname}?after=FICTITIOUS_AFTER&access_token=${TOKEN}`}})});
  const first=(await r.execute('insights')).data;assert(first.nextPageToken);assert(!first.nextPageToken.includes(TOKEN));
  const second=(await r.execute('insights',{...payload('insights'),pageToken:first.nextPageToken})).data;assert.equal(second.nextPageToken,null);
  const before=r.state.calls.length;
  await assert.rejects(r.execute('actions',{...payload('actions'),pageToken:first.nextPageToken}),{code:'invalid_request'});
  await assert.rejects(r.execute('insights',{...payload('insights'),startDate:'2026-10-02',pageToken:first.nextPageToken}),{code:'invalid_request'});
  await assert.rejects(r.execute('insights',{...payload('insights'),pageToken:first.nextPageToken},{assetRef:'meta-ad_account:999'}),{code:'scope_denied'});
  r.f.state.clock+=600001;await assert.rejects(r.execute('insights',{...payload('insights'),pageToken:first.nextPageToken}),{code:'invalid_request'});assert.equal(r.state.calls.length,before);
});
test('the observed v24 to v25 paging alias uses only an opaque cursor and keeps the fixed request account, edge and fields',async t=>{
 for(const family of Object.keys(A.OPERATIONS)){
  const r=await ready(t);r.state.raw=url=>({data:[row(family,url.searchParams.has('after')?'608':'607')],
   ...(url.searchParams.has('after')?{}:{paging:{cursors:{after:'FICTITIOUS_UPGRADE_AFTER'},
    next:`https://graph.facebook.com/v25.0/act_301/${['actions','insights'].includes(family)?'insights':family}?after=FICTITIOUS_UPGRADE_AFTER&access_token=${TOKEN}&fields=untrusted`}})});
  const first=(await r.execute(family)).data;assert(first.nextPageToken);assert(!JSON.stringify(first).includes('FICTITIOUS_UPGRADE_AFTER'));assert(!JSON.stringify(first).includes(TOKEN));
  const second=(await r.execute(family,{...payload(family),pageToken:first.nextPageToken})).data;assert.equal(second.nextPageToken,null);assert.equal(second.results.length,1);
  const dataCalls=r.state.calls.filter(v=>!v.path.endsWith('/debug_token'));
  assert.equal(dataCalls.length,2);
  for(const call of dataCalls){assert.equal(call.path,`/v24.0/act_301/${['actions','insights'].includes(family)?'insights':family}`);assert.equal(call.query.fields,A.FIELDS[family]);assert.equal(call.query.limit,'50');}
  assert.equal(dataCalls[1].query.after,'FICTITIOUS_UPGRADE_AFTER');assert(!Object.hasOwn(dataCalls[1].query,'access_token'));
 }
});
test('revocation during Graph I/O aborts disclosure and excludes subsequent reads without another provider call',async t=>{
  const r=await ready(t);let revoked=false;r.state.before=async()=>{if(revoked)return;revoked=true;await r.f.execute(M.REVOKE,{}, {assetRef:REF},'assetControl',r.current);};
  await assert.rejects(r.execute('campaigns'),{code:'provider_timeout'});const before=r.state.calls.length;await assert.rejects(r.execute('campaigns'),{code:'asset_revoked'});assert.equal(r.state.calls.length,before);
});
test('provider rate limit causes one call, durable two-hour cooldown, and no immediate retry, including debug_token',async t=>{
  for(const inspect of [false,true]){const r=await ready(t);if(inspect)r.state.inspectError={error:{code:613}};else r.state.raw={error:{code:17}};
    await assert.rejects(r.execute('campaigns'),{code:'rate_limited'});const count=r.state.calls.length;assert.equal(count,inspect?1:2);
    const cooldown=r.pacingState.load('meta-ads-app:101');assert(cooldown.pause_until>=r.f.now()+7200000);
    const reopened=createPacing({state:sqliteState(r.current.store.db),now:r.f.now,wait:async()=>assert.fail('must not sleep through a cooldown')});
    await assert.rejects(reopened.run('meta-ads-app:101',{signal:new AbortController().signal,deadline:r.f.now()+25000},async()=>assert.fail('must not call provider')),e=>e.code==='rate_limited'&&e.retryAfterMs>=7200000);
    await assert.rejects(r.execute('campaigns'),{code:'rate_limited'});assert.equal(r.state.calls.length,count);
  }
});
test('usage threshold stops subsequent Graph work, response secrets and malformed rows are rejected',async t=>{
  const high=await ready(t);high.state.headers={'x-app-usage':JSON.stringify({call_count:90,total_time:1})};await assert.rejects(high.execute('campaigns'),{code:'rate_limited'});assert(high.pacingState.load('meta-ads-app:101').pause_until>high.f.now());
  for(const mutation of [r=>r.name=TOKEN,r=>r.id='act_999',r=>r.name='bad\ntext']){const r=await ready(t);const value=row('campaigns');mutation(value);r.state.raw={data:[value]};await assert.rejects(r.execute('campaigns'),{code:'provider_failed'});}
});
test('runtime requires an explicit reviewed opt-in; old configurations validate without creating a pacing table',t=>{
  const runtime=require('../src/meta-marketing-oauth-main'),f=fixture(t,{enrollment:true});runtime.validateConfig(f.config);assert.equal(f.current.store.db.prepare("SELECT name FROM sqlite_schema WHERE name='meta_marketing_ads_pacing'").get(),undefined);
  const next={...f.config,adsRead:structuredClone(config)};runtime.validateConfig(next);
  for(const change of [c=>c.assetEnrollment=false,c=>c.standby=true,c=>c.adsRead.assetRefs.push('meta-facebook_page:401'),c=>c.adsRead.enabled=false,c=>c.adsRead.extra=true,c=>c.adsRead.assetRefs.push(REF)]){const c=structuredClone(next);change(c);assert.throws(()=>runtime.validateConfig(c),{code:'invalid_request'});}
});
test('closed CRM projection validation rejects extra nested/top fields and invalid usage metadata',()=>{
  const p=payload('ads'),base={results:[row('ads')],nextPageToken:null,usage:{usagePct:0,nextAllowedAt:0,pauseUntil:0}};
  A.validatePage(A.OPERATIONS.ads,base,p);
  for(const change of [r=>r.token=TOKEN,r=>r.results[0].creative.access_token=TOKEN,r=>r.usage.raw='secret',r=>r.usage.usagePct=101,r=>r.nextPageToken='http://bad']){const r=structuredClone(base);change(r);assert.throws(()=>A.validatePage(A.OPERATIONS.ads,r,p),{code:'provider_failed'});}
});
test('pacer serializes all metrics Graph work, refuses budget exhaustion and exposes only a typed retry delay',async()=>{
  let clock=1000;const records=new Map(),state={load:k=>records.get(k)||{next_allowed_at:0,pause_until:0},save:(k,v)=>records.set(k,v)};
  const pacer=createPacing({state,now:()=>clock,wait:async ms=>{clock+=ms;}}),signal=new AbortController().signal;
  const starts=[];let release;const held=new Promise(r=>{release=r;});
  const first=pacer.run('app:1',{signal,deadline:25000},async()=>{starts.push(['first',clock]);await held;});
  await Promise.resolve();const second=pacer.run('app:1',{signal,deadline:25000},async()=>starts.push(['second',clock]));await Promise.resolve();assert.equal(starts.length,1);
  release();await Promise.all([first,second]);assert.deepEqual(starts,[['first',1000],['second',2000]]);
  state.save('app:1',{next_allowed_at:clock+30000,pause_until:0});
  await assert.rejects(pacer.run('app:1',{signal,deadline:clock+25000},async()=>assert.fail('out of budget')),e=>e.code==='rate_limited'&&e.retryAfterMs===30000);
});
test('withdrawn Ads scope or wrong role prevents Secrets access; cursors cannot reflect secrets even as ciphertext',async t=>{
  const r=await ready(t),before=r.f.state.awsCalls.length;
  await assert.rejects(r.execute('campaigns',payload('campaigns'),{},false),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);
  r.state.raw=url=>({data:[row('campaigns')],paging:{cursors:{after:TOKEN},next:`https://graph.facebook.com${url.pathname}?after=${TOKEN}`}});
  await assert.rejects(r.execute('campaigns'),{code:'provider_failed'});
  r.current.broker.policy.connections[0].metaMarketingOAuth.scopes=r.current.broker.policy.connections[0].metaMarketingOAuth.scopes.filter(v=>v!=='ads_read');
  const after=r.f.state.awsCalls.length;await assert.rejects(r.execute('campaigns'),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,after);
});
test('actual TLS opt-in runtime serves Ads through the existing reader principal; restart explicitly invalidates cursors',async t=>{
  const r=await ready(t),f=r.f,fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFileSync}=require('node:child_process');
  const {allowPort,removePort}=require('./offline-guard.cjs'),runtime=require('../src/meta-marketing-oauth-main');
  const cfg={...f.config,stateFile:f.filename,adsRead:structuredClone(config)};
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',cfg.tlsKeyFile,'-out',cfg.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(cfg.tlsKeyFile,0o600);fs.chmodSync(cfg.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));cfg.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(cfg.port);
  const file=path.join(f.dir,'ads-optin-config.json');fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  const awsFactory=async()=>({secrets:f.aws,sink:{async write(){return {versionId:'FICTITIOUS_ADS_AUDIT_VERSION',digest:'fictitious'};}},close(){}});
  const options={awsFactory,http:f.http,adsRequest:r.request,adsNow:f.now,adsWait:async ms=>{f.state.clock+=ms;}};
  let app=await runtime.main(file,options);t.after(async()=>{if(app)await app.close();removePort(cfg.port);});
  const client=require('../../../src/lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:`https://127.0.0.1:${cfg.port}`,audience:cfg.policy.audience,keyId:'qa-reader',privateKey:f.reader.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cfg.tlsCertFile)});
  r.state.raw=url=>({data:[row('campaigns')],paging:{cursors:{after:'FICTITIOUS_TLS_AFTER'},next:`https://graph.facebook.com${url.pathname}?after=FICTITIOUS_TLS_AFTER`}});
  const command=input=>f.command(A.OPERATIONS.campaigns,input,{assetRef:REF});
  const first=(await client.execute(command(payload('campaigns')))).data;assert(first.nextPageToken);assert.equal(first.results[0].id,'601');
  await app.close();app=null;app=await runtime.main(file,options);const before=r.state.calls.length;
  await assert.rejects(client.execute(command({pageToken:first.nextPageToken})),{code:'invalid_request'});assert.equal(r.state.calls.length,before);
  await app.close();app=null;
});
test('bounded publisher platforms preserve Threads and future placements without accepting arbitrary text',()=>{
  for(const platform of ['threads','whatsapp','new_platform']){const value={...row('insights'),publisher_platform:platform};assert.equal(A.projectRow('insights',value,payload('insights')).publisher_platform,platform);}
  for(const platform of ['https://graph.facebook.com',TOKEN,'bad\nplatform','a'.repeat(65),'platform with spaces'])assert.throws(()=>A.projectRow('insights',{...row('insights'),publisher_platform:platform},payload('insights')),{code:'provider_failed'});
});
test('Instagram permalink projection strips provider query and fragment, rejects credentials/ports and keeps the CRM response canonical',async t=>{
  const r=await ready(t),value=row('ads');value.creative.instagram_permalink_url=`https://www.instagram.com/p/Fictitious/?access_token=${TOKEN}&tracking=1#${APP}`;r.state.raw={data:[value]};
  const response=(await r.execute('ads')).data;assert.equal(response.results[0].creative.instagram_permalink_url,'https://www.instagram.com/p/Fictitious/');assert(!JSON.stringify(response).includes(TOKEN));assert(!JSON.stringify(response).includes(APP));
  A.validatePage(A.OPERATIONS.ads,response,payload('ads'));
  for(const url of ['https://user:secret@instagram.com/p/Fictitious/','https://instagram.com:8443/p/Fictitious/','https://instagram.com.evil.invalid/p/Fictitious/','http://instagram.com/p/Fictitious/']){const v=row('ads');v.creative.instagram_permalink_url=url;assert.throws(()=>A.projectRow('ads',v,payload('ads')),{code:'provider_failed'});}
  const noncanonical=structuredClone(response);noncanonical.results[0].creative.instagram_permalink_url+='?access_token='+TOKEN;
  assert.throws(()=>A.validatePage(A.OPERATIONS.ads,noncanonical,payload('ads')),{code:'provider_failed'});
  const reflected=row('ads');reflected.creative.instagram_permalink_url='https://instagram.com/p/%46ICTITIOUS_META_OAUTH_TOKEN/';r.state.raw={data:[reflected]};
  await assert.rejects(r.execute('ads'),{code:'provider_failed'});
});
