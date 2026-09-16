'use strict';
const db = require('../../models');
const {isGlobalAdmin} = require('../lib/role-helpers');
const RATE_FIELDS=['input_usd_million','cached_input_usd_million','output_usd_million','audio_usd_hour','search_usd_thousand','long_context_threshold','long_input_multiplier','long_output_multiplier'];
const BEDROCK_SOURCE='https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/eu-south-2/index.json';
const seeds=[
  ['bedrock','eu.amazon.nova-micro-v1:0',.039,null,.156,BEDROCK_SOURCE],
  ['bedrock','eu.amazon.nova-lite-v1:0',.066,null,.264,BEDROCK_SOURCE],
  ['bedrock','eu.amazon.nova-pro-v1:0',.88,null,3.52,BEDROCK_SOURCE],
  ['openai','gpt-5.4-nano',.20,.02,1.25,'https://developers.openai.com/api/docs/models/gpt-5.4-nano'],
  ['openai','gpt-5.6',4,.4,20,'https://developers.openai.com/api/docs/models/gpt-5.6-sol'],
  ['openai','gpt-5.6-sol',4,.4,20,'https://developers.openai.com/api/docs/models/gpt-5.6-sol'],
  ['gemini','gemini-3.5-flash',.75,.075,4.50,'https://ai.google.dev/gemini-api/docs/pricing'],
  ['groq','whisper-large-v3-turbo',null,null,null,'https://console.groq.com/docs/speech-to-text'],
];
const defaults=seeds.map(([provider,model,input,cached,output,source])=>({provider,model,input_usd_million:input,cached_input_usd_million:cached,output_usd_million:output,source_url:source,
  ...(provider==='openai'?{search_usd_thousand:10}:{}),
  ...(provider==='gemini'?{search_usd_thousand:14}:{}),
  ...(provider==='groq'?{audio_usd_hour:.04}:{}),
  ...(model.startsWith('gpt-5.6')?{long_context_threshold:272000,long_input_multiplier:2,long_output_multiplier:1.5}:{})}));
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const modelName=v=>String(v||'').trim().replace(/-\d{4}-\d{2}-\d{2}$/,'');
function estimate(price,{inputTokens=0,outputTokens=0,cachedInputTokens=0,audioSeconds=0,searchRequests=0,usageKnown=true}={}) {
  const input=Math.max(0,Number(inputTokens)||0),output=Math.max(0,Number(outputTokens)||0);
  const cached=Math.min(input,Math.max(0,Number(cachedInputTokens)||0));
  const long=price?.long_context_threshold && input>Number(price.long_context_threshold);
  const quantities=[[input-cached,'input_usd_million',1e6,long?Number(price.long_input_multiplier||1):1],
    [cached,'cached_input_usd_million',1e6,long?Number(price.long_input_multiplier||1):1],
    [output,'output_usd_million',1e6,long?Number(price.long_output_multiplier||1):1],
    [Number(audioSeconds)>0&&price?.provider==='groq'?Math.max(10,Number(audioSeconds)):audioSeconds,'audio_usd_hour',3600,1],[searchRequests,'search_usd_thousand',1000,1]];
  let amount=0,complete=!!price&&usageKnown;
  for(const [quantity,key,unit,multiplier] of quantities) if(Number(quantity)>0){
    if(price?.[key]==null)complete=false;
    else amount+=Number(quantity)*Number(price[key])*multiplier/unit;
  }
  return {cost:Number(amount.toFixed(8)),complete,snapshot:price?Object.fromEntries(['provider','model',...RATE_FIELDS,'updated_at'].filter(k=>price[k]!=null).map(k=>[k,price[k]])):null};
}
async function effective(provider,model){
  const name=modelName(model);
  const row=await db.AiModelPrice.findOne({where:{provider,model:name},raw:true});
  return row||defaults.find(p=>p.provider===provider&&p.model===name)||null;
}
async function list(){
  const rows=await db.AiModelPrice.findAll({raw:true,order:[['provider','ASC'],['model','ASC']]});
  const known=new Set(rows.map(r=>r.provider+':'+r.model));
  const [used]=await db.sequelize.query('SELECT DISTINCT provider,model FROM AiUsageDaily ORDER BY provider,model');
  return [...rows,...defaults.filter(r=>!known.has(r.provider+':'+r.model)).map(r=>({...r,source:'default'})),
    ...used.filter(r=>!known.has(r.provider+':'+modelName(r.model))&&!defaults.some(d=>d.provider===r.provider&&d.model===modelName(r.model))).map(r=>({...r,model:modelName(r.model),source:'missing'}))];
}
async function update(input,userId){
  if(!isGlobalAdmin(userId))fail('technical_admin_required',403);
  if(!input||Object.keys(input).some(k=>!['provider','model','source_url',...RATE_FIELDS].includes(k)))fail('ai_price_invalid');
  const provider=String(input.provider||'').trim(),model=modelName(input.model);
  if(!['bedrock','openai','gemini','groq'].includes(provider)||!model||model.length>160||!/^[a-zA-Z0-9_.:/-]+$/.test(model))fail('ai_price_invalid');
  const values={provider,model,updated_by:Number(userId)};
  for(const key of RATE_FIELDS){const value=input[key];if(value==null||value===''){values[key]=null;continue;}const n=Number(value);
    if(!Number.isFinite(n)||n<0||n>(key==='long_context_threshold'?10000000:100000)||key==='long_context_threshold'&&!Number.isInteger(n))fail('ai_price_invalid');values[key]=n;}
  if(values.long_context_threshold&&(!values.long_input_multiplier||!values.long_output_multiplier))fail('ai_price_invalid');
  const source=String(input.source_url||'').trim();if(source){try{const url=new URL(source);if(url.protocol!=='https:'||url.username||url.password||source.length>1000)throw Error();}catch{fail('ai_price_invalid');}}
  values.source_url=source||null;
  return db.sequelize.transaction(async transaction=>{
    const before=await db.AiModelPrice.findOne({where:{provider,model},transaction,lock:transaction.LOCK.UPDATE});
    const row=before?await before.update(values,{transaction}):await db.AiModelPrice.create(values,{transaction});
    await db.SecurityMonitoringChange.create({entity_type:'ai_price',entity_id:provider+':'+model,action:'update',actor_id:Number(userId),detail:{...values}},{transaction});
    return row.toJSON();
  });
}
module.exports={estimate,effective,list,update,defaults,RATE_FIELDS,modelName};
