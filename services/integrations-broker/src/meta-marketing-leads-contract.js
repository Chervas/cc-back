'use strict';
const {schema}=require('./contracts'),{fail}=require('./errors'),M=require('./meta-marketing-contract'),{createHash}=require('node:crypto');
const COHORT='meta-marketing-lead-ads-v1';
const OPERATIONS=Object.freeze({destinations:'meta.marketing.leads.destinations.read.v1',form:'meta.marketing.leads.form.read.v1',pageStatus:'meta.marketing.leads.page.status.v1',pageEnable:'meta.marketing.leads.page.enable.v1',receiptAccept:'meta.marketing.leads.receipt.accept.v1',receiptRead:'meta.marketing.leads.receipt.read.v1',challenge:'meta.marketing.leads.challenge.verify.v1'});
const RECEPTION_OPERATIONS=Object.freeze([OPERATIONS.receiptAccept,OPERATIONS.challenge]);
function ingressPrincipal(environment){if(!['dev','staging'].includes(environment))fail('invalid_request');return `gateway:${environment}:meta-marketing-leads`;}
// No campaign-management permission: this capability reads Ads, receives leads,
// and adds leadgen to this application's existing Page subscription only.
const REQUIRED_SCOPES=Object.freeze(['ads_read','leads_retrieval','pages_show_list','pages_read_engagement','pages_manage_ads','pages_manage_metadata']);
const id={type:'string',pattern:'^[1-9][0-9]{0,29}$'},account={type:'string',pattern:'^meta-ad_account:[1-9][0-9]{0,29}$'},uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'};
const validators={
  destinations:schema({adAccountAssetRef:account,campaignId:id,cursor:{type:['string','null'],pattern:'^[A-Za-z0-9_-]{40,4096}$'}}),
  form:schema({adAccountAssetRef:account,formId:id}),pageStatus:schema({adAccountAssetRef:account}),
  pageEnable:schema({adAccountAssetRef:account,expectedSubscriptionRevision:{type:'string',pattern:'^[a-f0-9]{64}$'}}),
  receiptAccept:schema({adAccountAssetRef:account,rawBase64:{type:'string',minLength:4,maxLength:87384,pattern:'^[A-Za-z0-9+/]+={0,2}$'},signature:{type:'string',pattern:'^sha256=[a-f0-9]{64}$'}}),
  receiptRead:schema({adAccountAssetRef:account,receiptRef:uuid}),
  challenge:schema({adAccountAssetRef:account,mode:{const:'subscribe'},token:{type:'string',minLength:32,maxLength:256},challenge:{type:'string',minLength:1,maxLength:512,pattern:'^[\\x21-\\x7e]+$'}}),
};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const family=op=>{const key=Object.keys(OPERATIONS).find(k=>OPERATIONS[k]===op);if(!key)fail('operation_denied');return key;};
function validate(op,payload){const key=family(op);validators[key](payload);if(key==='receiptAccept'){const body=Buffer.from(payload.rawBase64,'base64');try{if(body.length>65536||body.toString('base64')!==payload.rawBase64)fail('invalid_request');}finally{body.fill(0);}}return key;}
function config(value){
  if(!exact(value,'enabled,cohort,pairs,verifyTokenRef')||value.enabled!==true||value.cohort!==COHORT||!Array.isArray(value.pairs)||!value.pairs.length||value.pairs.length>100
    ||!exact(value.verifyTokenRef,'secretArn,versionId')||typeof value.verifyTokenRef.secretArn!=='string'||!/^arn:aws:secretsmanager:eu-west-3:\d{12}:secret:\/clinicaclick\/integrations\/prod\/meta-marketing\/(dev|staging)\/[A-Za-z0-9/_+=.@-]+$/.test(value.verifyTokenRef.secretArn)||!/^[A-Za-z0-9-]{32,64}$/.test(value.verifyTokenRef.versionId))fail('invalid_request');
  const seen=new Set();for(const pair of value.pairs){if(!(exact(pair,'pageAssetRef,adAccountAssetRef')||exact(pair,'pageAssetRef,adAccountAssetRef,recipientClinicId'))||!/^meta-facebook_page:[1-9][0-9]{0,29}$/.test(pair.pageAssetRef)||!/^meta-ad_account:[1-9][0-9]{0,29}$/.test(pair.adAccountAssetRef)||seen.has(pair.pageAssetRef)||pair.recipientClinicId!=null&&(!Number.isInteger(pair.recipientClinicId)||pair.recipientClinicId<1||pair.recipientClinicId>2147483647))fail('invalid_request');seen.add(pair.pageAssetRef);}return value;
}
const text=(v,max=256)=>{if(typeof v!=='string'||!v.length||v.length>max||/[\x00-\x1f\x7f]/.test(v))fail('provider_failed');return v;};
const graphId=v=>{if(!M.graphId(v))fail('provider_failed');return v;};
function event(value){if(!exact(value,'lead_id,page_id,form_id,ad_id')||!M.graphId(value.lead_id)||!M.graphId(value.page_id)||!M.graphId(value.form_id)||value.ad_id!==null&&!M.graphId(value.ad_id))fail('provider_failed');return {...value};}
function subscription(appId,pageId,accountId,fields){return createHash('sha256').update(JSON.stringify([appId,pageId,accountId,fields])).digest('hex');}
function projectAd(row){
  if(!row||typeof row!=='object'||Array.isArray(row))fail('provider_failed');
  const c=row.creative;if(!c||typeof c!=='object'||Array.isArray(c))fail('provider_failed');
  const story=c.object_story_spec||{},values=[c.call_to_action?.value];let count=0;
  const scan=(block,depth=0)=>{if(block==null)return;if(!block||typeof block!=='object'||Array.isArray(block)||depth>3||++count>100)fail('provider_failed');if(block.call_to_action?.value)values.push(block.call_to_action.value);if(block.child_attachments!=null){if(!Array.isArray(block.child_attachments)||block.child_attachments.length>50)fail('provider_failed');for(const child of block.child_attachments)scan(child,depth+1);}};
  for(const key of ['link_data','video_data','template_data','photo_data'])scan(story[key]);
  const forms=[...new Set(values.filter(Boolean).map(v=>v.lead_gen_form_id).filter(v=>v!=null))];if(forms.length>1)fail('provider_failed');
  return {id:graphId(row.id),account_id:graphId(row.account_id),campaign_id:graphId(row.campaign_id),adset_id:graphId(row.adset_id),effective_status:text(row.effective_status,100),
    creative:{id:graphId(c.id),page_id:story.page_id==null?null:graphId(story.page_id),lead_gen_form_id:forms.length?graphId(forms[0]):null}};
}
function validateResponse(op,data,payload){
  const key=validate(op,payload),bad=()=>fail('provider_failed');
  if(!data||Object.getPrototypeOf(data)!==Object.prototype)bad();
  if(key==='receiptAccept'){if(!exact(data,'receipts,persisted')||data.persisted!==true||!Array.isArray(data.receipts)||data.receipts.length>1000)bad();const seen=new Set();for(const r of data.receipts){if(!exact(r,'receiptRef,event')||!new RegExp(uuid.pattern).test(r.receiptRef)||seen.has(r.receiptRef))bad();seen.add(r.receiptRef);event(r.event);}return structuredClone(data);}
  if(key==='challenge'){if(!exact(data,'challenge')||data.challenge!==payload.challenge)bad();return {...data};}
  const u=data.usage;if(!exact(u,'usagePct,nextAllowedAt,pauseUntil')||!Number.isFinite(u.usagePct)||u.usagePct<0||u.usagePct>100||['nextAllowedAt','pauseUntil'].some(k=>!Number.isSafeInteger(u[k])||u[k]<0))bad();
  if(key==='destinations'){
    if(!exact(data,'results,nextCursor,usage')||!Array.isArray(data.results)||data.results.length>50||data.nextCursor!==null&&(typeof data.nextCursor!=='string'||!/^[A-Za-z0-9_-]{40,4096}$/.test(data.nextCursor)))bad();
    const seen=new Set();for(const r of data.results){if(!exact(r,'id,account_id,campaign_id,adset_id,effective_status,creative')||!exact(r.creative,'id,page_id,lead_gen_form_id')||r.account_id!==payload.adAccountAssetRef.split(':')[1]||r.campaign_id!==payload.campaignId||seen.has(r.id))bad();seen.add(r.id);for(const k of ['id','account_id','campaign_id','adset_id'])graphId(r[k]);text(r.effective_status,100);graphId(r.creative.id);for(const k of ['page_id','lead_gen_form_id'])if(r.creative[k]!==null)graphId(r.creative[k]);}
  }else if(key==='form'){
    if(!exact(data,'form,usage')||!exact(data.form,'id,name,page_id,status')||data.form.id!==payload.formId)bad();graphId(data.form.id);graphId(data.form.page_id);text(data.form.name);text(data.form.status,100);
  }else if(['pageStatus','pageEnable'].includes(key)){
    if(!exact(data,'page,subscription,usage')||!exact(data.page,'id,has_lead_access')||typeof data.page.has_lead_access!=='boolean'||!exact(data.subscription,'subscribed,fields,revision')||typeof data.subscription.subscribed!=='boolean'||!Array.isArray(data.subscription.fields)||data.subscription.fields.length>100||data.subscription.fields.some((v,i,a)=>typeof v!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v)||i>0&&v<=a[i-1])||!/^[a-f0-9]{64}$/.test(data.subscription.revision))bad();graphId(data.page.id);
  }else if(key==='receiptRead'){
    if(!exact(data,'event,lead,identity,usage,recipientClinicId')||data.recipientClinicId!==null&&(!Number.isInteger(data.recipientClinicId)||data.recipientClinicId<1||data.recipientClinicId>2147483647))bad();const e=event(data.event),l=data.lead;if(!exact(l,'id,form_id,ad_id,campaign_id,created_time,is_organic,field_data')||l.id!==e.lead_id||l.form_id!==e.form_id||e.ad_id!==null&&l.ad_id!==e.ad_id||l.ad_id!==null&&!M.graphId(l.ad_id)||typeof l.is_organic!=='boolean'||typeof l.created_time!=='string'||l.created_time.length>40||!Number.isFinite(Date.parse(l.created_time))||!Array.isArray(l.field_data)||l.field_data.length>3)bad();
    const seen=new Set();for(const f of l.field_data){if(!exact(f,'name,values')||!['full_name','email','phone_number'].includes(f.name)||seen.has(f.name)||!Array.isArray(f.values)||f.values.length!==1)bad();seen.add(f.name);text(f.values[0],512);}
    if(l.campaign_id!==null)graphId(l.campaign_id);if(data.identity===null){if(!l.is_organic||e.ad_id!==null||l.ad_id!==null||l.campaign_id!==null)bad();}else{const i=data.identity;if(!exact(i,'account_id,campaign_id,ad_id,adset_id')||i.account_id!==payload.adAccountAssetRef.split(':')[1]||i.ad_id!==l.ad_id||i.campaign_id!==l.campaign_id||l.is_organic)bad();for(const v of Object.values(i))graphId(v);}
  }else bad();
  if(Buffer.byteLength(JSON.stringify(data))>110000)bad();return structuredClone(data);
}
module.exports={COHORT,OPERATIONS,REQUIRED_SCOPES,RECEPTION_OPERATIONS,ingressPrincipal,validate,validateRequest:validate,validateResponse,config,family,event,projectAd,subscription};
