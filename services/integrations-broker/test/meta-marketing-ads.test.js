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
        const res=new PassThrough();res.statusCode=typeof state.status==='function'?state.status(url):state.status;res.headers={'content-type':'application/json',...state.headers};cb(res);
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

const IMAGE='https://scontent.fbcdn.net/original.jpg',VIDEO='https://video.cdninstagram.com/original.mp4';
const creativePayload={pageToken:null,creativeVersion:1};
test('the authoritative creative image is not a variant of its alternate story picture resolution',()=>{
  const C=require('../src/meta-marketing-ads-creative');
  const rendition='https://scontent.fbcdn.net/story-1200x630.jpg';
  const input={body:'Actual copy',image_url:IMAGE,object_story_spec:{link_data:{message:'Actual copy',picture:rendition}}};
  const value=C.project(input);assert.equal(value.has_variants,false);assert.equal(value.source_issue,null);assert.equal(value.image_url,IMAGE);
  const fallback=C.project({object_story_spec:{link_data:{picture:rendition}}});assert.equal(fallback.image_url,rendition);assert.equal(fallback.has_variants,false);
  const video=C.project({video_id:'901',image_url:IMAGE,object_story_spec:{video_data:{video_id:'901',image_url:rendition}}});
  assert.equal(video.has_variants,false);assert.equal(video.source_issue,'video_source_unavailable');
  const variants=C.project({...input,asset_feed_spec:{images:[{url:IMAGE},{url:rendition}]}});
  assert.equal(variants.has_variants,true);assert.equal(variants.source_issue,'creative_variants_require_selection');
});
test('the normal inventory opt-in returns real copy/image and batches only video IDs observed in its exact account',async t=>{
  const r=await ready(t),first={...row('ads','701'),account_id:'301',creative:{id:'801',body:'Actual copy',title:'Actual title',image_url:IMAGE}},
    second={...row('ads','702'),account_id:'301',creative:{id:'802',body:'Video copy',video_id:'901',thumbnail_url:IMAGE}},
    third={...row('ads','703'),account_id:'301',creative:{id:'803',video_id:'901',thumbnail_url:IMAGE}};
  r.state.raw=url=>url.searchParams.has('ids')?{'901':{id:'901',source:VIDEO}}:{data:[first,second,third]};
  const result=(await r.execute('ads',creativePayload)).data;
  assert.equal(result.results[0].creative.sharing.body,'Actual copy');assert.equal(result.results[0].creative.sharing.image_url,IMAGE);
  assert.equal(result.results[1].creative.sharing.original_media_url,VIDEO);assert.equal(result.results[1].creative.sharing.thumbnail_url,IMAGE);
  assert.equal(result.results[1].creative.sharing.source_issue,null);assert.equal(result.results[2].creative.sharing.original_media_url,VIDEO);
  const data=r.state.calls.filter(c=>!c.path.endsWith('/debug_token'));
  assert.equal(data.length,2);assert.equal(data[0].path,'/v24.0/act_301/ads');assert.equal(data[0].query.limit,'10');assert.equal(data[0].query.fields,A.CREATIVE_FIELDS);
  assert.equal(data[1].path,'/v24.0/');assert.equal(data[1].query.ids,'901');assert.equal(data[1].query.fields,'id,source');
  assert(!Object.hasOwn(data[1].query,'access_token'));A.validatePage(A.OPERATIONS.ads,result,creativePayload);
  const stored=JSON.stringify(r.current.store.db.prepare('SELECT * FROM commands').all());assert(!stored.includes('Actual copy'));assert(!stored.includes(VIDEO));
});
test('creative inventory rejects caller media references, foreign accounts and mismatched source identities',async t=>{
  const r=await ready(t),before=r.state.calls.length;
  for(const extra of [{creativeVersion:3},{video_id:'901'},{source:VIDEO},{fields:'source'}])await assert.rejects(r.execute('ads',{...creativePayload,...extra}),{code:'invalid_request'});
  assert.equal(r.state.calls.length,before);
  r.state.raw={data:[{...row('ads'),account_id:'999',creative:{id:'801',video_id:'901'}}]};
  await assert.rejects(r.execute('ads',creativePayload),{code:'provider_failed'});assert(!r.state.calls.some(c=>c.query.ids));
  r.state.raw=url=>url.searchParams.has('ids')?{'901':{id:'999',source:VIDEO}}:{data:[{...row('ads'),account_id:'301',creative:{id:'801',video_id:'901'}}]};
  await assert.rejects(r.execute('ads',creativePayload),{code:'provider_failed'});
});
test('carousel/dynamic alternatives remain unavailable and never request a video source or substitute a thumbnail',async t=>{
  const r=await ready(t);
  r.state.raw={data:[{...row('ads'),account_id:'301',creative:{id:'801',video_id:'901',thumbnail_url:IMAGE,
    object_story_spec:{link_data:{child_attachments:[{video_id:'901'},{video_id:'902'}]}}}}]};
  const result=(await r.execute('ads',creativePayload)).data.results[0].creative.sharing;
  assert.equal(result.has_variants,true);assert.equal(result.source_issue,'carousel_not_supported');assert.equal(result.original_media_url,null);
  assert(!r.state.calls.some(c=>c.query.ids));
  const C=require('../src/meta-marketing-ads-creative');
  for(const input of [{body:'A',asset_feed_spec:{bodies:[{text:'A'},{text:'B'}]},image_url:IMAGE},
    {image_url:IMAGE,platform_customizations:{instagram:{image_url:IMAGE}}}]){
    const value=C.project(input);assert.equal(value.has_variants,true);assert.equal(value.source_issue,'creative_variants_require_selection');assert.equal(value.image_url,null);
  }
});
test('a denied or absent original remains unavailable; credential revocation and quota errors still stop the read',async t=>{
  for(const [source,issue]of [[{},'video_source_unavailable'],[{'901':{error:{code:200}}},'video_source_permission_denied'],
    [{error:{code:200}},'video_source_permission_denied'],[{'901':{id:'901',source:'https://example.invalid/page'}},'video_source_unavailable']]){
    const r=await ready(t);r.state.raw=url=>url.searchParams.has('ids')?source:{data:[{...row('ads'),account_id:'301',creative:{id:'801',video_id:'901',thumbnail_url:IMAGE}}]};
    const sharing=(await r.execute('ads',creativePayload)).data.results[0].creative.sharing;
    assert.equal(sharing.source_issue,issue);assert.equal(sharing.original_media_url,null);
  }
  const denied=await ready(t);denied.state.status=url=>url.searchParams.has('ids')?403:200;
  denied.state.raw=url=>url.searchParams.has('ids')?{}:{data:[{...row('ads'),account_id:'301',creative:{id:'801',video_id:'901'}}]};
  assert.equal((await denied.execute('ads',creativePayload)).data.results[0].creative.sharing.source_issue,'video_source_permission_denied');
  for(const [code,expected]of [[190,'credential_revoked'],[80004,'rate_limited']]){
    const r=await ready(t);r.state.raw=url=>url.searchParams.has('ids')?{'901':{error:{code}}}:{data:[{...row('ads'),account_id:'301',creative:{id:'801',video_id:'901'}}]};
    await assert.rejects(r.execute('ads',creativePayload),{code:expected});
    if(code===80004){
      assert(r.pacingState.load('meta-ads-app:101').pause_until>=r.f.now()+7200000);
      const calls=r.state.calls.length;await assert.rejects(r.execute('ads',creativePayload),{code:'rate_limited'});assert.equal(r.state.calls.length,calls);
    }
  }
});
test('creative-version cursors cannot cross back to the legacy projection or enable arbitrary field reads',async t=>{
  const r=await ready(t);r.state.raw=url=>({data:[{...row('ads'),account_id:'301',creative:{id:'801',body:'Real',image_url:IMAGE}}],
    ...(url.searchParams.has('after')?{}:{paging:{cursors:{after:'SYNTHETIC_CREATIVE_CURSOR'},next:`https://graph.facebook.com${url.pathname}?after=SYNTHETIC_CREATIVE_CURSOR`}})});
  const first=(await r.execute('ads',creativePayload)).data;assert(first.nextPageToken);
  const before=r.state.calls.length;await assert.rejects(r.execute('ads',{pageToken:first.nextPageToken}),{code:'invalid_request'});assert.equal(r.state.calls.length,before);
  const next=(await r.execute('ads',{...creativePayload,pageToken:first.nextPageToken})).data;assert.equal(next.nextPageToken,null);
});
test('revocation during a video source batch prevents disclosure and any remaining provider read',async t=>{
  const r=await ready(t);r.state.raw=url=>url.searchParams.has('ids')?{'901':{id:'901',source:VIDEO}}:{data:[{...row('ads'),account_id:'301',creative:{id:'801',video_id:'901'}}]};
  let revoked=false;r.state.before=async()=>{if(!revoked&&r.state.calls.at(-1).query.ids){revoked=true;await r.f.execute(M.REVOKE,{}, {assetRef:REF},'assetControl',r.current);}};
  await assert.rejects(r.execute('ads',creativePayload),{code:'provider_timeout'});assert.equal(revoked,true);
  const count=r.state.calls.length;await assert.rejects(r.execute('ads',creativePayload),{code:'asset_revoked'});assert.equal(r.state.calls.length,count);
});
test('bounded creative projection respects110k per page and rejects unvalidated nested additions',()=>{
  const C=require('../src/meta-marketing-ads-creative'),rows=Array.from({length:10},(_,i)=>({...row('ads',String(700+i)),creative:{id:'801',body:'b'.repeat(4000),title:'t'.repeat(1024),image_url:IMAGE,thumbnail_url:IMAGE}}));
  const results=A.projectPage('ads',{data:rows},creativePayload),value={results,nextPageToken:null,usage:{usagePct:0,nextAllowedAt:0,pauseUntil:0}};
  assert(Buffer.byteLength(JSON.stringify(value))<110000);A.validatePage(A.OPERATIONS.ads,value,creativePayload);
  const invalid=structuredClone(value);invalid.results[0].creative.sharing.url='https://untrusted.invalid';assert.throws(()=>A.validatePage(A.OPERATIONS.ads,invalid,creativePayload),{code:'provider_failed'});
  assert.throws(()=>A.projectPage('ads',{data:[...rows,rows[0]]},creativePayload),{code:'provider_failed'});
  assert.equal(C.project({body:'😀'.repeat(1100),image_url:IMAGE}).source_issue,'creative_copy_invalid');
});

test('v2 reads all100 admissible video choices in10-reference batches within the same authorized inventory operation',async t=>{
  const r=await ready(t),input={pageToken:null,creativeVersion:2};
  r.state.raw=url=>url.searchParams.has('ids')
    ?Object.fromEntries(url.searchParams.get('ids').split(',').map(id=>[id,{id,source:`https://video.cdninstagram.com/${id}.mp4`}]))
    :{data:Array.from({length:10},(_,i)=>({...row('ads',String(701+i)),account_id:'301',creative:{id:String(801+i),body:'Same source copy',
      asset_feed_spec:{videos:Array.from({length:10},(_,j)=>({video_id:String(901+i*10+j),thumbnail_url:IMAGE}))}}}))};
  const result=(await r.execute('ads',input)).data;A.validatePage(A.OPERATIONS.ads,result,input);
  const calls=r.state.calls.filter(call=>call.query.ids);assert.equal(calls.length,10);
  assert(calls.every(call=>call.query.ids.split(',').length===10&&call.query.fields==='id,source'));
  assert.equal(new Set(calls.flatMap(call=>call.query.ids.split(','))).size,100);
  assert(result.results.every(ad=>ad.creative.sharing.alternatives.length===10&&ad.creative.sharing.alternatives.every(a=>a.original_media_url&&a.source_issue===null)));
  assert(result.results.every(ad=>ad.creative.sharing.has_variants&&ad.creative.sharing.source_issue==='creative_variants_require_selection'));
});

test('v2 resolves only observed image hashes on the bound account edge without caller URLs, fields or hash injection',async t=>{
  const r=await ready(t),input={pageToken:null,creativeVersion:2},hashes=Array.from({length:12},(_,i)=>(i+1).toString(16).padStart(32,'0'));
  r.state.raw=url=>url.pathname.endsWith('/adimages')
    ?{data:JSON.parse(url.searchParams.get('hashes')).map(hash=>({hash,url:`https://scontent.fbcdn.net/${hash}.jpg`}))}
    :{data:[0,1].map(i=>({...row('ads',String(701+i)),account_id:'301',creative:{id:String(801+i),body:'Common copy',
      image_url:IMAGE,asset_feed_spec:{images:hashes.slice(i*6,i*6+6).map(hash=>({hash}))}}}))};
  const result=(await r.execute('ads',input)).data;A.validatePage(A.OPERATIONS.ads,result,input);
  const calls=r.state.calls.filter(call=>call.path.endsWith('/adimages'));assert.equal(calls.length,2);
  assert(calls.every(call=>call.path==='/v24.0/act_301/adimages'&&call.query.fields==='hash,url'&&call.query.limit==='10'));
  assert.deepEqual(calls.flatMap(call=>JSON.parse(call.query.hashes)),hashes);
  assert(result.results.every(ad=>ad.creative.sharing.alternatives.every(a=>a.image_url!==IMAGE&&a.source_issue===null)));
  const before=r.state.calls.length;
  for(const extra of [{hashes},{video_ids:['901']},{variant_id:'a'.repeat(64)},{url:IMAGE}]){
    await assert.rejects(r.execute('ads',{...input,...extra}),{code:'invalid_request'});
  }
  assert.equal(r.state.calls.length,before);
  r.state.raw=url=>url.pathname.endsWith('/adimages')?{data:[{hash:hashes[0],url:IMAGE}]}
    :{data:[{...row('ads'),account_id:'301',creative:{id:'801',body:'Direct original',image_hash:hashes[0]}}]};
  const direct=(await r.execute('ads',input)).data.results[0].creative.sharing;
  assert.equal(direct.alternatives[0].image_hash,hashes[0]);assert.equal(direct.alternatives[0].image_url,IMAGE);
  assert(r.state.calls.some(call=>call.path.endsWith('/ads')&&call.query.fields.includes('image_hash')));
});

test('v2 rejects foreign hashes and reflections, preserves denied image material explicitly and stops on quota',async t=>{
  const input={pageToken:null,creativeVersion:2},hash='a'.repeat(32);
  for(const mode of ['foreign','denied','reflection','quota']){
    const r=await ready(t);r.state.raw=url=>url.pathname.endsWith('/adimages')
      ?mode==='foreign'?{data:[{hash:'b'.repeat(32),url:IMAGE}]}:mode==='denied'?{error:{code:200}}
        :mode==='quota'?{error:{code:80004}}:{data:[{hash,url:`https://scontent.fbcdn.net/${encodeURIComponent(TOKEN)}.jpg`}]}
      :{data:[{...row('ads'),account_id:'301',creative:{id:'801',body:'Common copy',asset_feed_spec:{images:[{hash}]}}}]};
    if(mode==='denied'){
      const result=(await r.execute('ads',input)).data.results[0].creative.sharing;
      assert.equal(result.alternatives[0].source_issue,'image_source_permission_denied');assert.equal(result.alternatives[0].image_url,null);
    }else await assert.rejects(r.execute('ads',input),{code:mode==='quota'?'rate_limited':'provider_failed'});
  }
});

test('v1 and v2 creative cursors are isolated and a normalized v1 result cannot satisfy a v2 request',async t=>{
  const r=await ready(t);r.state.raw=url=>({data:[{...row('ads'),account_id:'301',creative:{id:'801',body:'Copy',image_url:IMAGE}}],
    paging:{cursors:{after:'CREATIVE_VERSION_CURSOR'},next:`https://graph.facebook.com${url.pathname}?after=CREATIVE_VERSION_CURSOR`}});
  for(const version of [1,2]){
    const response=(await r.execute('ads',{pageToken:null,creativeVersion:version})).data;
    const before=r.state.calls.length;
    await assert.rejects(r.execute('ads',{pageToken:response.nextPageToken,creativeVersion:version===1?2:1}),{code:'invalid_request'});
    assert.equal(r.state.calls.length,before);
    if(version===1)assert.throws(()=>A.validatePage(A.OPERATIONS.ads,response,{pageToken:null,creativeVersion:2}),{code:'provider_failed'});
  }
});
