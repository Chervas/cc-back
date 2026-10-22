'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createService } = require('../../services/whatsappPaymentRecoveryTest.service');
const now = new Date('2030-01-02T10:00:00Z');
const input = { clinicId:56,userId:1,phoneNumberId:'123456',requestId:'11111111-1111-4111-8111-111111111111',to:'+34 600 000 001' };
function fixture() {
  const lists=[], items=[], messages=[], calls=[], locks=new Set(); let allowed=true, behavior=null;
  const asset={id:404,assetType:'whatsapp_phone_number',isActive:true,assignmentScope:'clinic',clinicaId:56,
    phoneNumberId:'123456',wabaId:'TEST-WABA',metaAssetName:'+34 600 000 002',waVerifiedName:'TESTONLY clinic',additionalData:{
      payment:{status:'missing_payment_method',last_error_code:131042,last_detected_at:'2030-01-02T09:00:00Z'}}};
  const template={id:5334,status:'APPROVED',category:'MARKETING',name:'TESTONLY-greeting',variables:
    ['nombre_paciente','usuario_nombre','nombre_clinica'].map((name,i)=>({name,index:i+1})),components:[{type:'BODY',text:'Hola {{1}}, soy {{2}} de {{3}}.'}]};
  const binding={sendEnabled:true}, local={role:'secondary',purposes:['bulk_campaigns']};
  const health={state:'blocked',reason_code:'meta_error_131042_payment_missing',provider_status:'CONNECTED',can_send:false};
  const db={
    ClinicMetaAsset:{findOne:async()=>asset},Clinica:{findByPk:async()=>({id_clinica:56,nombre_clinica:'TESTONLY clinic'})},
    WhatsappChannelBinding:{findOne:async()=>local},WhatsappTemplate:{findOne:async()=>template},
    MarketingPatientList:{findOne:async({where})=>lists.find(row=>row.clinica_id===where.clinica_id&&row.created_by===where.created_by&&row.criteria.request_id===where['criteria.request_id']),
      create:async row=>{const record={...row,id:lists.length+1};lists.push(record);return record;}},
    MarketingPatientListItem:{create:async row=>{const record={...row,id:items.length+1};items.push(record);return record;}},
    Message:{findOne:async({where})=>messages.find(row=>row.metadata.list_id===where['metadata.list_id']&&row.metadata.kind===where['metadata.kind'])},
    sequelize:{transaction:async fn=>fn({}),query:async(sql,{replacements:{lock}})=>{
      if(sql.includes('GET_LOCK')) {if(locks.has(lock))return [[{acquired:0}]];locks.add(lock);return [[{acquired:1}]];}
      locks.delete(lock);return [[]];}},
  };
  const bulk={sendTest:async(scope,id,body)=>{
    calls.push({scope,id,body}); const message={id:messages.length+1,status:'pending',metadata:{list_id:id,kind:'mass_campaign_test'}};
    messages.push(message); asset.additionalData.payment.last_probe_at=now.toISOString();
    if(behavior)await behavior(message);
  }};
  const service=createService({db,bulk,broker:{binding:async()=>binding},manual:{current:()=>asset.manualDisconnect===true},
    health:{summarizeAssetHealth:()=>health},payment:{derivePaymentSnapshot:data=>data.payment},
    authorize:async ({clinicId,userId})=>allowed&&clinicId===56&&userId===1,now:()=>now});
  return {service,asset,template,binding,local,health,db,lists,items,messages,calls,locks,
    deny:()=>{allowed=false;},behavior:fn=>{behavior=fn;}};
}
test('GET is read-only and exposes exact sender/preview with no destination or patient data',async()=>{
  const f=fixture(), result=await f.service.get(input);
  assert.equal(result.available.allowed,true);assert.equal(result.sender.phone,'+34 600 000 002');
  assert.match(result.preview,/prueba, ignora este mensaje/);assert(!JSON.stringify(result).includes('600000001'));
  assert.equal(f.lists.length,0);assert.equal(f.calls.length,0);
});
test('explicit test reuses native transport, archived diagnostic and a nonpatient sample',async()=>{
  const f=fixture(), result=await f.service.send(input);
  assert.equal(result.message_status,'pending');assert.equal(result.recovered,false);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.sender_origin_id,404);
  assert.equal(f.calls[0].body.payment_recovery_probe,true);assert.equal(f.calls[0].body.to,'34600000001');
  assert.equal(f.lists[0].status,'archived');assert.equal(f.lists[0].criteria.whatsapp_payment_recovery_test,true);
  assert.equal(f.items[0].paciente_id,null);assert.equal(f.items[0].selected,false);assert.equal(f.items[0].phone,null);
  assert.equal(f.items[0].status,'test_sample');assert.equal(f.locks.size,0);
});
test('same UUID returns its stored result despite cooldown, without another send',async()=>{
  const f=fixture();const first=await f.service.send(input),second=await f.service.send(input);
  assert.equal(first.app_message_id,second.app_message_id);assert.equal(f.calls.length,1);assert.equal(f.lists.length,1);
  await assert.rejects(f.service.send({...input,to:'+34 600 000 003'}),{code:'payment_test_request_conflict'});
});
test('payment rejection is reported without recovering or sending again',async()=>{
  const f=fixture();f.behavior(async message=>{message.status='failed';message.metadata.wa_error=[{code:131042}];throw Error('provider failure');});
  const result=await f.service.send(input);assert.equal(result.error_code,131042);assert.equal(result.recovered,false);
  await f.service.send(input);assert.equal(f.calls.length,1);
});
test('acceptance, sent without reconciliation, and delivery are not confused with recovered billing',async()=>{
  const f=fixture();await f.service.send(input);f.messages[0].status='sent';
  assert.equal((await f.service.get(input)).recovered,false);
  f.asset.additionalData.payment.status='active';f.health.can_send=true;f.messages[0].status='delivered';
  assert.equal((await f.service.get(input)).recovered,true);assert.equal(f.calls.length,1);
});
test('a lost native response with a durable message is queried instead of resent',async()=>{
  const f=fixture();f.behavior(async()=>{throw Error('TESTONLY_RESPONSE_LOST');});
  assert.equal((await f.service.send(input)).message_status,'pending');
  await f.service.send(input);assert.equal(f.calls.length,1);
});
test('a native failure before message creation leaves a durable nonretryable attempt',async()=>{
  const f=fixture();f.db.Message.findOne=async()=>null;f.behavior(async()=>{throw Error('TESTONLY_PREFLIGHT');});
  await assert.rejects(f.service.send(input));assert.equal((await f.service.send(input)).message_status,'unknown');
  assert.equal(f.calls.length,1);assert.equal(f.locks.size,0);
});
test('simultaneous attempts never dispatch twice on the same sender',async()=>{
  const f=fixture();const results=await Promise.allSettled([f.service.send(input),f.service.send(input)]);
  assert.equal(f.calls.length,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.locks.size,0);
});
for(const [name,change,reason] of [
  ['disconnected binding',f=>{f.binding.sendEnabled=false;},'payment_probe_sender_unavailable'],
  ['local manual stop',f=>{f.asset.manualDisconnect=true;},'payment_probe_sender_unavailable'],
  ['secondary wrong purpose',f=>{f.local.purposes=['review_requests'];},'payment_probe_purpose_unavailable'],
  ['template pending',f=>{f.template.components=[];},'payment_probe_template_unavailable'],
  ['extra button/header',f=>{f.template.components.push({type:'BUTTONS'});},'payment_probe_template_unavailable'],
  ['changed variable semantics',f=>{f.template.variables[0].name='profesional_nombre';},'payment_probe_template_unavailable'],
  ['failure too recent',f=>{f.asset.additionalData.payment.last_detected_at='2030-01-02T09:59:00Z';},'payment_probe_failure_too_recent'],
  ['cooldown',f=>{f.asset.additionalData.payment.last_probe_at='2030-01-02T09:59:00Z';},'payment_probe_cooldown'],
  ['other health block',f=>{f.health.reason_code='security_block';},'payment_probe_not_applicable'],
])test(`${name} prevents even preparing a diagnostic send`,async()=>{
  const f=fixture();change(f);await assert.rejects(f.service.send(input),{code:reason});
  assert.equal(f.lists.length,0);assert.equal(f.calls.length,0);
});
test('permission is checked before loading any asset and scope mismatch is rejected',async()=>{
  const f=fixture();f.deny();f.db.ClinicMetaAsset.findOne=()=>{throw Error('must not load asset');};
  await assert.rejects(f.service.get(input),{code:'payment_test_forbidden'});
  const g=fixture();g.asset.clinicaId=57;await assert.rejects(g.service.send(input),{code:'payment_test_phone_not_found'});
  assert.equal(g.calls.length,0);
});
test('invalid request IDs and phone input do not reach transport',async()=>{
  for(const patch of [{requestId:'bad'}, {to:''}, {to:'someone +34 600 000 001'}, {to:'123'}]){
    const f=fixture();await assert.rejects(f.service.send({...input,...patch}));assert.equal(f.calls.length,0);
  }
});
test('native campaign preparation/dispatch cannot consume archived diagnostic records',()=>{
  const source=fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'),'utf8');
  const start=source.indexOf('function ensureDispatchableCampaignRecord('),end=source.indexOf('\nfunction computeCounters',start);
  const context={normalizeMassSendRecordKind:()=> 'campaign'};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const list={criteria:{record_kind:'campaign',whatsapp_payment_recovery_test:true}};
  assert.throws(()=>context.ensureDispatchableCampaignRecord(list),{code:'payment_test_not_dispatchable'});
  context.ensureDispatchableCampaignRecord(list,{allowPaymentTest:true});
  assert.match(source,/sample\.status !== 'test_sample'/);assert.match(source,/sample\.paciente_id/);
});
test('the ordinary campaign test endpoint cannot replay a diagnostic attempt',async()=>{
  const source=fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'),'utf8');
  const guard=source.slice(source.indexOf('function ensureDispatchableCampaignRecord('),source.indexOf('\nfunction computeCounters'));
  const command=source.slice(source.indexOf('async function sendTest('),source.indexOf('\nasync function getEmailTestStatus'));
  const context={MarketingPatientList:{findByPk:async()=>({source:'whatsapp_payment_recovery_test',criteria:{whatsapp_payment_recovery_test:true}})},
    ensureScopeAccess:()=>{},normalizeMassSendRecordKind:()=> 'campaign'};
  vm.createContext(context);vm.runInContext(guard+'\n'+command,context);
  await assert.rejects(context.sendTest({},1,{payment_recovery_probe:true}),{code:'payment_test_not_dispatchable'});
});
