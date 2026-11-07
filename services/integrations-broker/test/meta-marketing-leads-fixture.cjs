'use strict';
const assert=require('node:assert/strict'),{createHmac,randomUUID,randomBytes}=require('node:crypto'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const L=require('../src/meta-marketing-leads-contract'),E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract'),{Broker}=require('../src/broker');
const {createMetaMarketingEnrollment}=require('../src/meta-marketing-enrollment'),{createMetaMarketingOAuthOperations}=require('../src/meta-marketing-oauth'),{createMetaMarketingLeadsHttp}=require('../src/meta-marketing-leads-http'),{createPacing,sqliteState}=require('../src/meta-marketing-ads-pacing'),{cursorCodec}=require('../src/provider-cursor');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const PAGE='meta-facebook_page:401',ACCOUNT='meta-ad_account:301',PAGE_TOKEN='FICTITIOUS_OWNER_PAGE_TOKEN',VERIFY='FICTITIOUS_INDEPENDENT_VERIFY_TOKEN_1234567890';
const event=(ad='603')=>({lead_id:'701',page_id:'401',form_id:'702',ad_id:ad});
const rawEvent=(ad='603')=>Buffer.from(JSON.stringify({object:'page',entry:[{id:'401',changes:[{field:'leadgen',value:{leadgen_id:'701',page_id:'401',form_id:'702',...(ad===null?{}:{ad_id:ad}),field_data:[{name:'email',values:['IGNORED_PII@example.invalid']} ]}}]}]}));
const acceptPayload=(raw=rawEvent())=>({adAccountAssetRef:ACCOUNT,rawBase64:raw.toString('base64'),signature:'sha256='+createHmac('sha256',APP).update(raw).digest('hex')});
async function ready(t,{optin=true,recipientClinicId=71}={}){
  const f=fixture(t,{enrollment:true});for(const s of L.REQUIRED_SCOPES)if(!f.binding.metaMarketingOAuth.scopes.includes(s))f.binding.metaMarketingOAuth.scopes.push(s);f.restart();
  const verifyTokenRef={secretArn:f.binding.secretArn.replace('qa-candidate','qa-lead-verify'),versionId:'v'.repeat(32)};
  f.records.set(verifyTokenRef.secretArn,new Map([[verifyTokenRef.versionId,{body:JSON.stringify({version:1,kind:'meta-marketing-leads-webhook-verify',appId:'101',verifyToken:VERIFY}),stages:['AWSCURRENT']}]]));
  const config={enabled:true,cohort:L.COHORT,verifyTokenRef,pairs:[{pageAssetRef:PAGE,adAccountAssetRef:ACCOUNT,recipientClinicId}]};
  const flow=await f.begin(),candidate=(await f.finish(flow)).data.candidate,id=randomUUID();
  const p=(await f.execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:candidate.digest,assetRefs:[PAGE,ACCOUNT]})).data;
  await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:flow.payload.scopeDigest,selectionDigest:p.selectionDigest});
  const state={calls:[],fields:['feed'],before:null,status:200,headers:{},adAccount:'301',formPage:'401',adId:'603',organic:false,raw:null};
  const request=(options,cb)=>{
    const url=new URL('https://graph.facebook.com'+options.path);
    state.calls.push({path:url.pathname,fields:url.searchParams.get('fields'),at:f.now(),method:options.method});
    if(url.pathname.endsWith('/debug_token')&&url.searchParams.get('input_token')===TOKEN)return f.request(options,cb);
    const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};req.end=body=>queueMicrotask(async()=>{
      try{await state.before?.(url,options);if(destroyed)return;assert.equal(options.hostname,'graph.facebook.com');assert.equal(options.rejectUnauthorized,true);
        let raw;
        if(url.pathname.endsWith('/debug_token'))raw={data:{app_id:'101',type:'PAGE',profile_id:'401',is_valid:true,expires_at:0,data_access_expires_at:0,scopes:L.REQUIRED_SCOPES}};
        else if(url.pathname==='/v24.0/401'&&url.searchParams.get('fields')==='id,access_token'){assert.equal(options.headers.authorization,'Bearer '+TOKEN);raw={id:'401',access_token:PAGE_TOKEN};}
        else if(url.pathname==='/v24.0/me'){assert.equal(options.headers.authorization,'Bearer '+PAGE_TOKEN);raw={id:'401'};}
        else if(url.pathname==='/v24.0/401')raw={id:'401',has_lead_access:true};
        else if(url.pathname==='/v24.0/401/subscribed_apps'){
          assert.equal(options.headers.authorization,'Bearer '+PAGE_TOKEN);
          if(options.method==='POST'){const b=new URLSearchParams(body);assert.equal(b.get('appsecret_proof'),createHmac('sha256',APP).update(PAGE_TOKEN).digest('hex'));state.fields=b.get('subscribed_fields').split(',');raw={success:true};}
          else raw={data:[{id:'101',subscribed_fields:[...state.fields]},{id:'999',subscribed_fields:['messages']}]};
        }else if(url.pathname==='/v24.0/702')raw={id:'702',name:'Formulario ficticio',page_id:state.formPage,status:'ACTIVE'};
        else if(url.pathname==='/v24.0/603')raw={id:'603',account_id:state.adAccount,campaign_id:'601',adset_id:'602'};
        else if(url.pathname==='/v24.0/701')raw={id:'701',form_id:'702',ad_id:state.adId,campaign_id:state.organic?null:'601',created_time:'2026-11-07T12:00:00+0000',is_organic:state.organic,...(url.searchParams.get('fields').includes('field_data')?{field_data:[{name:'full_name',values:['FICTITIOUS_PERSON']},{name:'email',values:['qa@example.invalid']},{name:'phone_number',values:['+34600000000']},{name:'medical_condition',values:['NEVER_RETURN']}]}:{})};
        else if(url.pathname==='/v24.0/act_301/ads')raw={data:[{id:'603',account_id:'301',campaign_id:'601',adset_id:'602',effective_status:'ACTIVE',creative:{id:'604',object_story_spec:{page_id:'401',link_data:{call_to_action:{value:{lead_gen_form_id:'702'}}}}}}]};
        else assert.fail('Unexpected fixed graph path '+url.pathname);
        const res=new PassThrough();res.statusCode=state.status;res.headers={'content-type':'application/json',...state.headers};cb(res);res.end(JSON.stringify(state.raw??raw));
      }catch(e){req.emit('error',e);}
    });return req;
  };
  const pacingState=sqliteState(f.current.store.db),pacer=createPacing({state:pacingState,now:f.now,wait:async ms=>{f.state.clock+=ms;}}),leadsHttp=createMetaMarketingLeadsHttp({request,pacer,cursor:cursorCodec(randomBytes(32),f.now),now:f.now});
  const enrollment=createMetaMarketingEnrollment({store:f.current.store,secrets:f.secrets,http:f.http,environment:'staging',now:f.now,...(optin?{leadAds:config,leadsHttp}:{})});t.after(()=>enrollment.close());
  const broker=new Broker({store:f.current.store,policy:f.policy,secrets:f.secrets,policyResolver:enrollment,operations:{...createMetaMarketingOAuthOperations(f.current.engine,{assetDiscovery:true}),...enrollment.operations},transportProfile:'meta-marketing',now:f.now});
  const current={broker,store:f.current.store},execute=(name,payload,overrides={})=>f.execute(L.OPERATIONS[name],payload,{assetRef:PAGE,...overrides},'reader',current);
  return {f,state,execute,current,enrollment,flow,id,config,pacer,pacingState,leadsHttp,request};
}
module.exports={ready,rawEvent,acceptPayload,PAGE,ACCOUNT,PAGE_TOKEN,VERIFY,event};
