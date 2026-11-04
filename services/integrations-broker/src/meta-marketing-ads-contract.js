'use strict';
const { schema } = require('./contracts'), { fail } = require('./errors');
const M = require('./meta-marketing-contract');
const COHORT = 'meta-marketing-ads-read-v1';
const OPERATIONS = Object.freeze(Object.fromEntries(['campaigns','adsets','ads','insights','actions'].map(k=>[k,`meta.marketing.ads.${k}.read.v1`])));
const FIELDS = Object.freeze({
  campaigns:'id,name,status,effective_status,objective,buying_type,created_time,updated_time',
  adsets:'id,name,campaign_id,status,effective_status,created_time,updated_time',
  ads:'id,name,adset_id,campaign_id,status,effective_status,created_time,updated_time,creative{id,effective_instagram_media_id,effective_object_story_id,instagram_permalink_url}',
  insights:'ad_id,impressions,reach,clicks,inline_link_clicks,spend,cpc,cpm,ctr,frequency', actions:'ad_id,actions',
});
const entity = schema({pageToken:{type:['string','null'],minLength:40,maxLength:4096}});
const metrics = schema({pageToken:{type:['string','null'],minLength:40,maxLength:4096},startDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},endDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}});
function family(operation){const name=Object.keys(OPERATIONS).find(k=>OPERATIONS[k]===operation);if(!name)fail('operation_denied');return name;}
const date = value => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
function validate(operation,payload){const name=family(operation);(['insights','actions'].includes(name)?metrics:entity)(payload);
  if(['insights','actions'].includes(name)&&(!date(payload.startDate)||!date(payload.endDate)||payload.endDate<payload.startDate||Date.parse(payload.endDate)-Date.parse(payload.startDate)>2*86400000))fail('invalid_request');return name;}
function config(value){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='assetRefs,cohort,enabled'||value.enabled!==true||value.cohort!==COHORT
    ||!Array.isArray(value.assetRefs)||!value.assetRefs.length||value.assetRefs.length>100||new Set(value.assetRefs).size!==value.assetRefs.length
    ||value.assetRefs.some(v=>typeof v!=='string'||!/^meta-ad_account:[1-9][0-9]{0,29}$/.test(v)))fail('invalid_request');return value;
}
const text=(value,max=256)=>{if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail('provider_failed');return value;};
const id=value=>{if(!M.graphId(value))fail('provider_failed');return value;};
const number=(value,{integer=false}={})=>{
  if(!['number','string'].includes(typeof value)||!/^\d+(?:\.\d+)?$/.test(String(value))||!Number.isFinite(Number(value))||Number(value)>Number.MAX_SAFE_INTEGER||integer&&!Number.isSafeInteger(Number(value)))fail('provider_failed');
  return value;
};
function projectRow(name,row,payload){
  if(!row||typeof row!=='object'||Array.isArray(row))fail('provider_failed');
  const out={};
  if(!['insights','actions'].includes(name)){
    out.id=id(row.id);out.name=text(row.name);
    for(const k of ['status','effective_status','objective','buying_type'])if(row[k]!=null)out[k]=text(row[k],100);
    for(const k of ['created_time','updated_time'])if(row[k]!=null){if(typeof row[k]!=='string'||row[k].length>40||!Number.isFinite(Date.parse(row[k])))fail('provider_failed');out[k]=row[k];}
    for(const k of name==='adsets'?['campaign_id']:name==='ads'?['campaign_id','adset_id']:[])out[k]=id(row[k]);
    if(name==='ads'&&row.creative!=null){
      const c=row.creative;if(!c||typeof c!=='object'||Array.isArray(c))fail('provider_failed');out.creative={id:id(c.id)};
      if(c.effective_instagram_media_id!=null)out.creative.effective_instagram_media_id=id(c.effective_instagram_media_id);
      if(c.effective_object_story_id!=null){if(typeof c.effective_object_story_id!=='string'||!/^\d{1,30}_\d{1,30}$/.test(c.effective_object_story_id))fail('provider_failed');out.creative.effective_object_story_id=c.effective_object_story_id;}
      if(c.instagram_permalink_url!=null){let url;try{url=new URL(text(c.instagram_permalink_url,4096));}catch{fail('provider_failed');}
        if(url.protocol!=='https:'||url.username||url.password||url.port||!['instagram.com','www.instagram.com'].includes(url.hostname))fail('provider_failed');
        // The permalink identifies the public post. Query/fragment tracking is
        // unnecessary, and can reflect provider credentials; never return it.
        out.creative.instagram_permalink_url=text(url.origin+url.pathname,2048);
      }
    }
    return out;
  }
  out.ad_id=id(row.ad_id);
  for(const k of ['date_start','date_stop']){if(!date(row[k])||row[k]<payload.startDate||row[k]>payload.endDate)fail('provider_failed');out[k]=row[k];}
  if(out.date_start!==out.date_stop)fail('provider_failed');
  // Meta's generated SDK models publisher_platforms as list<string> and
  // advertises the publisher_platform breakdown without a closed value enum.
  // Preserve bounded platform identifiers (including Threads/new placements)
  // without silently attributing them to Facebook or accepting arbitrary text.
  if(typeof row.publisher_platform!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(row.publisher_platform))fail('provider_failed');out.publisher_platform=row.publisher_platform;
  out.platform_position=text(row.platform_position,100);
  if(!/^[a-zA-Z0-9_-]+$/.test(out.platform_position))fail('provider_failed');
  if(name==='actions'){
    if(row.actions!==undefined&&!Array.isArray(row.actions)||row.actions?.length>200)fail('provider_failed');const seen=new Set();
    out.actions=(row.actions||[]).map(a=>{if(!a||typeof a!=='object'||!/^[-a-zA-Z0-9_.]{1,160}$/.test(a.action_type||'')||seen.has(a.action_type))fail('provider_failed');seen.add(a.action_type);return {action_type:a.action_type,value:number(a.value)};});
  }else{
    for(const k of ['impressions','reach','clicks','inline_link_clicks'])out[k]=number(row[k]??'0',{integer:true});
    for(const k of ['spend','cpc','cpm','ctr','frequency'])out[k]=number(row[k]??'0');
  }
  return out;
}
function projectPage(name,raw,payload){
  if(!raw||raw.error||!Array.isArray(raw.data)||raw.data.length>50)fail('provider_failed');
  const results=raw.data.map(row=>projectRow(name,row,payload)),seen=new Set();
  for(const row of results){const key=row.id||JSON.stringify([row.ad_id,row.date_start,row.publisher_platform,row.platform_position]);if(seen.has(key))fail('provider_failed');seen.add(key);}
  if(Buffer.byteLength(JSON.stringify(results))>110000)fail('provider_failed');return results;
}
function validatePage(operation,response,payload){
  const name=validate(operation,payload),exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys;
  if(!exact(response,'nextPageToken,results,usage')||!exact(response.usage,'nextAllowedAt,pauseUntil,usagePct')
    ||!Number.isFinite(response.usage.usagePct)||response.usage.usagePct<0||response.usage.usagePct>100
    ||['nextAllowedAt','pauseUntil'].some(k=>!Number.isSafeInteger(response.usage[k])||response.usage[k]<0)
    ||response.nextPageToken!==null&&(typeof response.nextPageToken!=='string'||!/^[A-Za-z0-9_-]{40,4096}$/.test(response.nextPageToken)))fail('provider_failed');
  const projected=projectPage(name,{data:response.results},payload);
  if(JSON.stringify(projected)!==JSON.stringify(response.results))fail('provider_failed');return structuredClone(response);
}
module.exports={COHORT,OPERATIONS,FIELDS,family,validate,config,date,projectRow,projectPage,validatePage};
