'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function service(name,db={}) {
  const ctx={module:{exports:{}},require:key=>{
    if(key==='../../models')return db;
    if(key==='../lib/role-helpers')return {isGlobalAdmin:id=>id===1};
    throw Error('Unexpected dependency '+key);
  },URL,Date,console,Set,Number,Buffer};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../services',name+'.service.js'),'utf8'),ctx);
  return ctx.module.exports;
}
test('cached input is a subset, never an extra charge; long-context pricing applies to both input classes',()=>{
  const s=service('aiPricing'),price=s.defaults.find(p=>p.model==='gpt-5.6');
  const result=s.estimate(price,{inputTokens:1000000,cachedInputTokens:500000,outputTokens:100000});
  assert.equal(result.cost,7.4);assert.equal(result.complete,true);
});
test('unknown model or missing output rate is partial, not a free completed request',()=>{
  const s=service('aiPricing');assert.equal(s.estimate(null,{inputTokens:10}).complete,false);
  const v=s.estimate({input_usd_million:4},{inputTokens:1000000,outputTokens:100});
  assert.equal(v.cost,4);assert.equal(v.complete,false);
  assert.equal(s.estimate({input_usd_million:0,output_usd_million:0},{inputTokens:10,outputTokens:10}).complete,true);
  assert.equal(s.estimate(s.defaults[0],{usageKnown:false}).complete,false);
});
test('audio respects ten-second minimum and search is priced separately',()=>{
  const s=service('aiPricing');const audio=s.defaults.find(p=>p.provider==='groq');
  assert.equal(s.estimate(audio,{audioSeconds:2}).cost,Number((.04*10/3600).toFixed(8)));
  const openai=s.defaults.find(p=>p.model==='gpt-5.4-nano');
  assert.equal(s.estimate(openai,{inputTokens:1000000,outputTokens:1000000,searchRequests:10}).cost,1.55);
});
test('tariff changes reject non-admin, unknown keys, negative prices and unsafe source URLs before writes',async()=>{
  const s=service('aiPricing');
  await assert.rejects(s.update({},77),{code:'technical_admin_required'});
  for(const body of [{provider:'openai',model:'test',input_usd_million:-1},{provider:'openai',model:'test',secret:'no'},{provider:'openai',model:'test',source_url:'javascript:alert(1)'}])await assert.rejects(s.update(body,1),{code:'ai_price_invalid'});
});
test('manual pause blocks only the selected function and leaves all other functions usable',async()=>{
  const s=service('securityMonitoring',{SecurityMonitoringMeasure:{findOne:async({where})=>where.entity_id==='review_classification'?{id:1}:null}});
  await assert.rejects(s.assertAiAllowed('review_classification'),{code:'ai_function_manually_paused',retryable:false});
  await s.assertAiAllowed('confirm_appointment');
});
test('template pause lookup is constrained by WABA, name and language',async()=>{
  let input;const s=service('securityMonitoring',{sequelize:{query:async(sql,opts)=>{input=opts.replacements;return [input.waba==='100'&&input.name==='paused'&&input.language==='es'?[{id:1}]:[]];}}});
  await assert.rejects(s.assertTemplateAllowed('100','paused','es'),{code:'whatsapp_template_manually_paused'});
  await s.assertTemplateAllowed('200','paused','es');await s.assertTemplateAllowed('100','paused','en');
  assert.equal(input.language,'en');
});
test('measures require explicit administration and a nonempty reason',async()=>{
  const s=service('securityMonitoring');
  await assert.rejects(s.setPaused({paused:true,reason:'test'},77),{code:'technical_admin_required'});
  await assert.rejects(s.setPaused({paused:true,reason:' '},1),{code:'security_measure_reason_required'});
});
