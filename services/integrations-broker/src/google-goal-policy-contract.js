'use strict';
const { schema } = require('./contracts');
const { fail } = require('./errors');
const SECTIONS=Object.freeze(['tracking','actions','custom_goals','campaign_configs','campaign_goals','customer_goals']);
const MAX_CAMPAIGNS=200, MAX_ROWS=5000;
const check=schema({pageToken:{type:['string','null'],maxLength:4096},section:{enum:SECTIONS},
 campaignIds:{type:'array',minItems:1,maxItems:MAX_CAMPAIGNS,uniqueItems:true,items:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}});
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x);
const customer=x=>typeof x==='string'&&/^[0-9]{10}$/.test(x)&&x!=='0000000000';
const text=x=>{if(typeof x!=='string'||Buffer.byteLength(x)>1024||/[\x00-\x1f\x7f]/.test(x))fail('provider_failed');return x;};
const enumeration=x=>{if(typeof x!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/.test(x))fail('provider_failed');return x;};
function resource(value,type,owner,identity){
 const m=typeof value==='string'&&value.match(new RegExp('^customers/([0-9]{10})/'+type+'/([1-9][0-9]{0,19})$'));
 if(!m||!customer(m[1])||owner&&m[1]!==owner||identity&&m[2]!==identity)fail('provider_failed');return value;
}
const customerResource=x=>{if(typeof x!=='string'||!customer(x.slice(10))||x!=='customers/'+x.slice(10))fail('provider_failed');return x;};
function validate(payload){check(payload);return payload;}
const limit=payload=>payload.section==='tracking'?1:MAX_ROWS;
function query(payload){
 validate(payload);const ids=payload.campaignIds.join(', '),fields={
 tracking:['customer.id','customer.conversion_tracking_setting.google_ads_conversion_customer','customer.conversion_tracking_setting.conversion_tracking_status'],
 actions:['customer.id','conversion_action.id','conversion_action.resource_name','conversion_action.owner_customer','conversion_action.name','conversion_action.type','conversion_action.status','conversion_action.counting_type','conversion_action.primary_for_goal','conversion_action.category','conversion_action.origin'],
 custom_goals:['customer.id','custom_conversion_goal.id','custom_conversion_goal.resource_name','custom_conversion_goal.name','custom_conversion_goal.status','custom_conversion_goal.conversion_actions'],
 campaign_configs:['customer.id','conversion_goal_campaign_config.resource_name','conversion_goal_campaign_config.campaign','conversion_goal_campaign_config.custom_conversion_goal','conversion_goal_campaign_config.goal_config_level','campaign.id','campaign.name','campaign.status','campaign.advertising_channel_type','campaign.advertising_channel_sub_type','custom_conversion_goal.resource_name','custom_conversion_goal.name','custom_conversion_goal.status'],
 campaign_goals:['customer.id','campaign_conversion_goal.resource_name','campaign_conversion_goal.campaign','campaign_conversion_goal.category','campaign_conversion_goal.origin','campaign_conversion_goal.biddable','campaign.id','campaign.name'],
 customer_goals:['customer.id','customer_conversion_goal.resource_name','customer_conversion_goal.category','customer_conversion_goal.origin','customer_conversion_goal.biddable']};
 const from={tracking:'customer',actions:'conversion_action',custom_goals:'custom_conversion_goal',campaign_configs:'conversion_goal_campaign_config',campaign_goals:'campaign_conversion_goal',customer_goals:'customer_conversion_goal'};
 // Full account campaign config inventory is necessary to detect another cohort
 // using the same goal. Caller campaignIds must never narrow this section.
 const where=payload.section==='campaign_configs'?" WHERE campaign.status != 'REMOVED'":payload.section==='campaign_goals'?` WHERE campaign.id IN (${ids})`:'';
 return `SELECT ${fields[payload.section].join(', ')} FROM ${from[payload.section]}${where} LIMIT ${limit(payload)+1}`;
}
function project(row,payload,account){
 validate(payload);if(!plain(row)||!plain(row.customer)||row.customer.id!==account.customerId)fail('provider_failed');
 const result={customer:{id:account.customerId}},section=payload.section;
 if(section==='tracking'){
  const s=row.customer.conversionTrackingSetting;if(!plain(s))fail('provider_failed');
  // Preserve the actual conversion owner; never manufacture a local owner.
  const owner=s.googleAdsConversionCustomer==null?null:customerResource(s.googleAdsConversionCustomer);
  result.customer.conversionTrackingSetting={googleAdsConversionCustomer:owner,conversionTrackingStatus:enumeration(s.conversionTrackingStatus)};return result;
 }
 if(section==='actions'){
  const a=row.conversionAction;if(!plain(a)||!id(a.id))fail('provider_failed');
  const name=resource(a.resourceName,'conversionActions',null,a.id),owner=customerResource(a.ownerCustomer);
  if(owner!==name.split('/').slice(0,2).join('/')||a.primaryForGoal!=null&&typeof a.primaryForGoal!=='boolean')fail('provider_failed');
  result.conversionAction={id:a.id,resourceName:name,ownerCustomer:owner,name:text(a.name),type:enumeration(a.type),status:enumeration(a.status),countingType:enumeration(a.countingType),primaryForGoal:a.primaryForGoal??null,category:enumeration(a.category),origin:enumeration(a.origin)};return result;
 }
 if(section==='custom_goals'){
  const g=row.customConversionGoal;if(!plain(g)||!id(g.id)||!Array.isArray(g.conversionActions)||g.conversionActions.length>2000||new Set(g.conversionActions).size!==g.conversionActions.length)fail('provider_failed');
  result.customConversionGoal={id:g.id,resourceName:resource(g.resourceName,'customConversionGoals',null,g.id),name:text(g.name),status:enumeration(g.status),conversionActions:g.conversionActions.map(x=>resource(x,'conversionActions'))};return result;
 }
 if(section==='campaign_configs'||section==='campaign_goals'){
  const c=row.campaign;if(!plain(c)||!id(c.id))fail('provider_failed');result.campaign={id:c.id,name:text(c.name)};
  if(section==='campaign_configs'){
   if(!['ENABLED','PAUSED','UNKNOWN','UNSPECIFIED'].includes(c.status))fail('provider_failed');
   Object.assign(result.campaign,{status:c.status,advertisingChannelType:enumeration(c.advertisingChannelType)});
   if(c.advertisingChannelSubType!==undefined)result.campaign.advertisingChannelSubType=enumeration(c.advertisingChannelSubType);
   const g=row.conversionGoalCampaignConfig;if(!plain(g)||g.resourceName!==`customers/${account.customerId}/conversionGoalCampaignConfigs/${c.id}`||g.campaign!==`customers/${account.customerId}/campaigns/${c.id}`)fail('provider_failed');
   result.conversionGoalCampaignConfig={resourceName:g.resourceName,campaign:g.campaign,goalConfigLevel:enumeration(g.goalConfigLevel)};
   if(g.customConversionGoal){
    const name=resource(g.customConversionGoal,'customConversionGoals'),j=row.customConversionGoal;
    if(!plain(j)||j.resourceName!==name)fail('provider_failed');result.conversionGoalCampaignConfig.customConversionGoal=name;
    result.customConversionGoal={resourceName:name,name:text(j.name),status:enumeration(j.status)};
   }else if(g.customConversionGoal!=null&&g.customConversionGoal!==''||row.customConversionGoal!==undefined&&(!plain(row.customConversionGoal)||Object.keys(row.customConversionGoal).length))fail('provider_failed');
   return result;
  }
  const g=row.campaignConversionGoal;if(!plain(g)||!payload.campaignIds.includes(c.id)||g.campaign!==`customers/${account.customerId}/campaigns/${c.id}`||g.biddable!==undefined&&typeof g.biddable!=='boolean')fail('provider_failed');
  const category=enumeration(g.category),origin=enumeration(g.origin);
  if(g.resourceName!==`customers/${account.customerId}/campaignConversionGoals/${c.id}~${category}~${origin}`)fail('provider_failed');
  result.campaignConversionGoal={resourceName:g.resourceName,campaign:g.campaign,category,origin,biddable:g.biddable===true};return result;
 }
 const g=row.customerConversionGoal;if(!plain(g)||g.biddable!==undefined&&typeof g.biddable!=='boolean')fail('provider_failed');
 const category=enumeration(g.category),origin=enumeration(g.origin);
 if(g.resourceName!==`customers/${account.customerId}/customerConversionGoals/${category}~${origin}`)fail('provider_failed');
 result.customerConversionGoal={resourceName:g.resourceName,category,origin,biddable:g.biddable===true};return result;
}
module.exports={SECTIONS,MAX_CAMPAIGNS,MAX_ROWS,validate,limit,query,project};
