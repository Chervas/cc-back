'use strict';
// Local failure-only observation. No provider text, unknown keys, credentials,
// URLs, headers or row values may enter the journal through this helper.
const fs=require('node:fs'),A=require('./meta-marketing-ads-contract'),L=require('./meta-marketing-leads-contract');
const EVENT='meta_marketing_read_failed',MAX_BYTES=2048;
const PHASES=new Set(['unknown','before_credential_http','before_credential_validation','data_http','data_projection','pagination',
 'reflection','after_credential_http','after_credential_validation','response_validation','page_token_http','page_token_validation',
 'page_token_debug_http','page_token_debug_validation','page_identity_http','page_identity_validation','page_access_http',
 'page_access_projection','page_subscriptions_http','page_subscriptions_projection','authorization']);
const STAGES=new Set(['none','pacing','request','headers','body','json','http','complete','timeout','aborted','transport']);
const ERRORS=new Set(['invalid_request','scope_denied','operation_denied','connection_blocked','asset_revoked','rate_limited',
 'provider_failed','provider_timeout','provider_unauthorized','credential_revoked','secret_version_changed','oauth_identity_mismatch',
 'oauth_credentials_incomplete','invalid_signature','audit_unavailable','internal_error']);
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,29}$/.test(v);
const text=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const numeric=(v,integer=false)=>['number','string'].includes(typeof v)&&/^\d+(?:\.\d+)?$/.test(String(v))&&Number.isFinite(Number(v))
 &&Number(v)<=Number.MAX_SAFE_INTEGER&&(!integer||Number.isSafeInteger(Number(v)));
function type(v,test){
 if(v===undefined)return'missing';if(v===null)return'null';
 const kind=Array.isArray(v)?'array':typeof v;
 if(!['string','number','boolean','object','array'].includes(kind))return'other';
 return test?kind+(test(v)?'_ok':'_bad'):kind;
}
function adsFields(name,row){
 const r=row&&typeof row==='object'?row:{};const f={};
 if(!['insights','actions'].includes(name)){
  f.id=type(r.id,id);f.name=type(r.name,v=>text(v));
  for(const k of ['status','effective_status','objective','buying_type'])f[k]=type(r[k],v=>text(v,100));
  for(const k of ['created_time','updated_time'])f[k]=type(r[k],v=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v)));
  if(name!=='campaigns')f.campaign_id=type(r.campaign_id,id);if(name==='ads'){
   f.adset_id=type(r.adset_id,id);f.creative=type(r.creative);const c=r.creative||{};
   f.creative_id=type(c.id,id);f.effective_instagram_media_id=type(c.effective_instagram_media_id,id);
   f.effective_object_story_id=type(c.effective_object_story_id,v=>typeof v==='string'&&/^\d{1,30}_\d{1,30}$/.test(v));
   f.instagram_permalink_url=type(c.instagram_permalink_url,v=>{try{const u=new URL(v);return text(v,4096)&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['instagram.com','www.instagram.com'].includes(u.hostname);}catch{return false;}});
  }
 }else{
  f.ad_id=type(r.ad_id,id);f.date_start=type(r.date_start,date);f.date_stop=type(r.date_stop,date);
  f.publisher_platform=type(r.publisher_platform,v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(v));
  f.platform_position=type(r.platform_position,v=>text(v,100)&&/^[a-zA-Z0-9_-]+$/.test(v));
  if(name==='actions')f.actions=type(r.actions,v=>Array.isArray(v)&&v.length<=200);
  else{for(const k of ['impressions','reach','clicks','inline_link_clicks'])f[k]=type(r[k],v=>numeric(v,true));for(const k of ['spend','cpc','cpm','ctr','frequency'])f[k]=type(r[k],v=>numeric(v));}
 }
 return f;
}
function create({operation,assetRef}){
 const family=Object.keys(A.OPERATIONS).find(k=>A.OPERATIONS[k]===operation),page=operation===L.OPERATIONS.pageStatus;
 const enabled=Boolean((family&&/^meta-ad_account:[1-9][0-9]{0,29}$/.test(assetRef))||(page&&/^meta-facebook_page:[1-9][0-9]{0,29}$/.test(assetRef)));
 let emitted=false,phase='unknown',stage='none',httpStatus=null,metaCode=null,metaSubcode=null,shape=null,debugScopes=null;
 const guarded=work=>{try{if(enabled)work();}catch{/* Observation must never replace the normal failure. */}};
 const bounded=v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647?v:null;
 return{
  phase:value=>guarded(()=>{phase=PHASES.has(value)?value:'unknown';stage='none';}),
  stage:value=>guarded(()=>{stage=STAGES.has(value)?value:'none';}),
  begin:()=>guarded(()=>{stage='pacing';httpStatus=metaCode=metaSubcode=null;}),
  status:value=>guarded(()=>{stage='headers';httpStatus=Number.isInteger(value)&&value>=100&&value<=599?value:null;}),
  meta:value=>guarded(()=>{metaCode=bounded(value?.code);metaSubcode=bounded(value?.error_subcode);}),
  scopes:value=>guarded(()=>{debugScopes=null;if(Array.isArray(value)&&value.length<=64&&value.every(v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(v)))debugScopes={hasAdsReadScope:value.includes('ads_read'),hasAdsManagementScope:value.includes('ads_management')};}),
  adsProjection:(name,raw,payload)=>guarded(()=>{
   if(!family||name!==family||!Array.isArray(raw?.data))return;
   // Re-run only the same pure row validator, on failure, to identify the first
   // rejected row. Page-level failures have no row shape rather than a guess.
   for(let i=0;i<Math.min(raw.data.length,50);i++)try{A.projectRow(name,raw.data[i],payload);}catch{
    shape={kind:'ads_row',rowIndex:i,fields:adsFields(name,raw.data[i])};break;
   }
  }),
  pageAccess:raw=>guarded(()=>{
   if(!page)return;const v=raw?.has_lead_access,known=['app_has_leads_permission','can_access_lead','enabled_lead_access_manager','is_page_admin','user_has_leads_permission','page_id','user_id','failure_reason','failure_resolution'];
   const fields={id:type(raw?.id,id),has_lead_access:type(v)};
   for(const k of known)fields[k]=type(v?.[k],['page_id','user_id'].includes(k)?id:['failure_reason','failure_resolution'].includes(k)?x=>typeof x==='string'&&x.length<=2048:x=>typeof x==='boolean');
   shape={kind:'page_access',unknownKeysPresent:Boolean(v&&typeof v==='object'&&Object.keys(v).some(k=>!known.includes(k))),fields};
  }),
  fail:error=>guarded(()=>{
   if(emitted)return;emitted=true;
   const value={event:EVENT,version:1,operation,assetRef,phase,stage,httpStatus,metaCode,metaSubcode,
    error:ERRORS.has(error?.code)?error.code:'provider_failed',shape,debugScopes};
   // A synchronous fd2 write cannot schedule an unhandled stream error event.
   // One bounded write only; closed/full/partial sinks never trigger a retry.
   const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)<=MAX_BYTES)fs.writeSync(2,line);
  }),
 };
}
module.exports={create,EVENT,MAX_BYTES};
