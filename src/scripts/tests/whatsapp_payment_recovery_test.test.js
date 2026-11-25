'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createService } = require('../../services/whatsappPaymentRecoveryTest.service');
const now = new Date('2030-01-02T10:00:00Z');
const input = { clinicId:56,userId:1,phoneNumberId:'123456',requestId:'11111111-1111-4111-8111-111111111111',to:'+34 600 000 001' };
function fixture({evidence} = {}) {
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
    MarketingPatientList:{findOne:async({where})=>lists.slice().reverse().find(row=>row.clinica_id===where.clinica_id&&row.created_by===where.created_by
      && Object.entries(where).filter(([key])=>key.startsWith('criteria.')).every(([key,value])=>row.criteria[key.slice(9)]===value)),
      create:async row=>{const record={...row,id:lists.length+1};lists.push(record);return record;}},
    MarketingPatientListItem:{create:async row=>{const record={...row,id:items.length+1};items.push(record);return record;}},
    Message:{findOne:async({where})=>messages.find(row=>row.metadata.list_id===where['metadata.list_id']&&row.metadata.kind===where['metadata.kind'])},
    sequelize:{transaction:async fn=>fn({}),query:async(sql,{replacements:{lock}})=>{
      if(sql.includes('GET_LOCK')) {if(locks.has(lock))return [[{acquired:0}]];locks.add(lock);return [[{acquired:1}]];}
      if(sql.includes('IS_FREE_LOCK')) return [[{idle:locks.has(lock)?0:1}]];
      locks.delete(lock);return [[]];}},
  };
  const bulk={sendTest:async(scope,id,body)=>{
    calls.push({scope,id,body}); const message={id:messages.length+1,status:'pending',metadata:{list_id:id,kind:'mass_campaign_test',
      sender_origin_id:asset.id,phoneNumberId:asset.phoneNumberId,wabaId:asset.wabaId}};
    messages.push(message); asset.additionalData.payment.last_probe_at=now.toISOString();
    if(behavior)await behavior(message);
  }};
  const service=createService({db,bulk,broker:{binding:async()=>binding},manual:{current:()=>asset.manualDisconnect===true},
    health:{summarizeAssetHealth:()=>health},payment:{derivePaymentSnapshot:data=>data.payment},
    authorize:async ({clinicId,userId})=>allowed&&clinicId===56&&userId===1,now:()=>now,...(evidence?{evidence}:{})});
  return {service,asset,template,binding,local,health,db,lists,items,messages,calls,locks,
    deny:()=>{allowed=false;},behavior:fn=>{behavior=fn;}};
}
test('GET is read-only and exposes exact sender/preview with no destination or patient data',async()=>{
  const f=fixture(), result=await f.service.get(input);
  assert.equal(result.available.allowed,true);assert.equal(result.sender.phone,'+34 600 000 002');
  assert.match(result.preview,/prueba, ignora este mensaje/);assert(!JSON.stringify(result).includes('600000001'));
  assert.equal(f.lists.length,0);assert.equal(f.calls.length,0);
});
test('preflight throttling is distinguishable from a rate limit while reading an existing send', async () => {
  const limited = () => Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
  for (const rateLimitedRead of [1, 2, 3]) {
    let reads = 0;
    const f = fixture({ evidence: { createService: () => ({ read: async () => {
      if (++reads === rateLimitedRead) throw limited();
      return { verified: false };
    } }) } });
    await assert.rejects(f.service.send(input), { code: rateLimitedRead < 3 ? 'payment_test_rate_limited' : 'rate_limited' });
    assert.equal(f.calls.length, rateLimitedRead < 3 ? 0 : 1);
    if (rateLimitedRead === 3) {
      assert.equal((await f.service.get(input)).request_id, input.requestId);
      await f.service.send(input);
      assert.equal(f.calls.length, 1);
    }
  }
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
test('healthy unknown configuration uses the same isolated command and reopening adopts its durable request',async()=>{
  const f=fixture();f.asset.whatsappAuthorizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.asset.additionalData.payment={};Object.assign(f.health,{state:'healthy',can_send:true,reason_code:'provider_connected'});
  const first=await f.service.send(input);assert.equal(first.mode,'configuration');assert.equal(first.recovered,false);
  assert.equal(first.delivery_confirmed,false);assert.equal(f.lists[0].criteria.payment_test_mode,'configuration');
  const reloaded=await f.service.get({...input,requestId:undefined});assert.equal(reloaded.request_id,input.requestId);
  assert.equal(reloaded.app_message_id,first.app_message_id);assert.equal(f.calls.length,1);
  f.messages[0].status='sent';assert.equal((await f.service.get(input)).delivery_confirmed,false);
  f.messages[0].status='delivered';const delivered=await f.service.get(input);
  assert.equal(delivered.delivery_confirmed,false);assert.equal(delivered.recovered,false); // A status alone has no current-authority proof in this fixture.
  assert.equal(f.asset.additionalData.payment.status,undefined);assert.equal(f.asset.additionalData.payment.last_success_at,undefined);
  f.asset.whatsappAuthorizationId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await assert.rejects(f.service.get(input),{code:'payment_test_binding_changed'});
  assert.equal((await f.service.get({...input,requestId:undefined})).request_id,undefined);
  assert.equal(f.calls.length,1);
});
test('a legacy diagnostic request without an authority binding is not adopted after a managed authorization',async()=>{
  const f=fixture();await f.service.send(input);delete f.lists[0].criteria.authorization_id;
  f.asset.whatsappAuthorizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';f.messages[0].status='delivered';
  await assert.rejects(f.service.get(input),{code:'payment_test_binding_changed'});assert.equal(f.calls.length,1);
});
test('a diagnostic result cannot adopt a message from another sender even if the list ID matches',async()=>{
  const f=fixture();await f.service.send(input);f.messages[0].metadata.wabaId='OTHER';
  await assert.rejects(f.service.get(input),{code:'payment_test_binding_changed'});
  assert.equal(f.calls.length,1);
});
test('an older verified manual send does not confirm delivery of a new pending or failed request',async()=>{
  const proof={verified:true,app_message_id:999,message_status:'delivered'};
  const f=fixture({evidence:{createService:()=>({read:async()=>proof})}});
  f.asset.whatsappAuthorizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';f.asset.additionalData.payment={};
  Object.assign(f.health,{state:'healthy',can_send:true,reason_code:'provider_connected'});
  const pending=await f.service.send(input);assert.equal(pending.configuration_test.verified,true);
  assert.equal(pending.delivery_confirmed,false);assert.equal(pending.message_status,'pending');
  f.messages[0].status='failed';assert.equal((await f.service.get(input)).delivery_confirmed,false);
});
test('a later payment failure starts recovery instead of automatically adopting an old configuration request',async()=>{
  for(const terminal of ['delivered','failed']){
  const f=fixture();f.asset.whatsappAuthorizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';f.asset.additionalData.payment={};
  Object.assign(f.health,{state:'healthy',can_send:true,reason_code:'provider_connected'});
  await f.service.send(input);f.messages[0].status=terminal;
  f.asset.additionalData.payment={status:'missing_payment_method',last_error_code:131042,last_message_id:100,
    last_detected_at:'2030-01-02T09:00:00Z'};
  Object.assign(f.health,{state:'blocked',can_send:false,reason_code:'meta_error_131042_payment_missing'});
  const recovery=await f.service.get({...input,requestId:undefined});
  assert.equal(recovery.mode,'recovery');assert.equal(recovery.request_id,undefined);assert.equal(f.calls.length,1);
  const history=await f.service.get(input);assert.equal(history.mode,'configuration');assert.equal(history.request_id,input.requestId);
  assert.equal(history.message_status,terminal);assert.equal(history.delivery_confirmed,false);assert.equal(f.calls.length,1);
  }
});
test('an older terminal recovery does not capture a later failure cycle, but its explicit UUID remains readable',async()=>{
  for(const terminal of ['delivered','read','failed']){
    const f=fixture();await f.service.send(input);f.messages[0].status=terminal;
    f.asset.additionalData.payment.last_message_id=100;
    const state=await f.service.get({...input,requestId:undefined});
    assert.equal(state.mode,'recovery');assert.equal(state.request_id,undefined);
    assert.equal((await f.service.get(input)).request_id,input.requestId);assert.equal(f.calls.length,1);
  }
});
test('the current failed recovery and uncertain requests keep their UUID without repeating a send',async()=>{
  for(const status of ['failed','pending','sent']){
    const f=fixture();await f.service.send(input);f.messages[0].status=status;
    f.asset.additionalData.payment.last_message_id=status==='failed'?f.messages[0].id:100;
    assert.equal((await f.service.get({...input,requestId:undefined})).request_id,input.requestId);
    assert.equal((await f.service.send(input)).request_id,input.requestId);assert.equal(f.calls.length,1);
  }
});
test('a new explicit failed recovery request replaces the prior cycle for automatic adoption without duplicating either send',async()=>{
  const f=fixture();await f.service.send(input);f.messages[0].status='delivered';
  f.asset.additionalData.payment.last_message_id=100;f.asset.additionalData.payment.last_probe_at='2030-01-02T09:00:00Z';
  assert.equal((await f.service.get({...input,requestId:undefined})).request_id,undefined);
  f.behavior(async message=>{message.status='failed';message.metadata.wa_error=[{code:131042}];
    f.asset.additionalData.payment.last_message_id=message.id;throw Error('TESTONLY-current-payment-failure');});
  const next={...input,requestId:'22222222-2222-4222-8222-222222222222'};
  assert.equal((await f.service.send(next)).message_status,'failed');
  assert.equal((await f.service.get({...input,requestId:undefined})).request_id,next.requestId);
  await f.service.send(next);assert.equal(f.calls.length,2);assert.equal(f.lists.length,2);
});
test('terminal recovery history with no comparable message ID uses the later provider-failure clock',async()=>{
  const f=fixture();await f.service.send(input);f.messages[0].status='delivered';f.messages[0].updatedAt='2030-01-02T08:59:00Z';
  assert.equal((await f.service.get({...input,requestId:undefined})).request_id,undefined);
  f.messages[0].status='failed';f.messages[0].updatedAt='2030-01-02T09:00:00Z';
  assert.equal((await f.service.get({...input,requestId:undefined})).request_id,input.requestId);assert.equal(f.calls.length,1);
});
test('the approved dedicated configuration family is preferred with its exact one-variable preview',async()=>{
  const f=fixture();f.db.WhatsappTemplateCatalog={findOne:async({where})=>{
    assert.deepEqual(where,{family_key:'clinicaclick_prueba_configuracion',locale:'es',is_active:true});return {id:123};}};
  const dedicated={id:6135,name:'TESTONLY-configuration',language:'es',status:'APPROVED',category:'MARKETING',
    variables:[{name:'nombre_clinica',index:1}],components:[{type:'BODY',text:'Hola, prueba de configuración para {{1}}.'}]};
  f.db.WhatsappTemplate.findOne=async({where})=>where.catalog_template_id===123?dedicated:f.template;
  const state=await f.service.get(input);assert.equal(state.template_name,dedicated.name);
  assert.equal(state.preview,'Hola, prueba de configuración para TESTONLY clinic.');
  f.db.WhatsappTemplate.findOne=async({where})=>where.catalog_template_id===123?null:f.template;
  assert.equal((await f.service.get(input)).template_name,f.template.name);
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
test('a native failure before message creation remains queryable as not sent and does not replay the same request',async()=>{
  const f=fixture();f.db.Message.findOne=async()=>null;f.behavior(async()=>{throw Error('TESTONLY_PREFLIGHT');});
  assert.equal((await f.service.send(input)).message_status,'not_sent');
  assert.equal((await f.service.get(input)).message_status,'not_sent');
  assert.equal((await f.service.send(input)).message_status,'not_sent');
  f.locks.add('cc-wa-payment-test:404');
  assert.equal((await f.service.get(input)).message_status,'unknown');
  f.locks.clear();
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
test('a secondary without bulk permissions can run the single approved diagnostic', async () => {
  const f=fixture();
  f.local.purposes=[];
  f.behavior(message=>{message.metadata.dispatch_wait={state:'waiting',next_attempt_at:now.toISOString()};});
  const result=await f.service.send(input);
  assert.equal(result.transport_state,'waiting');
  assert.equal(result.next_attempt_at,now.toISOString());
  assert.equal(f.calls.length,1);
});
test('the optional recipient suggestion comes from the authorized operator record', async () => {
  const f=fixture();
  f.db.Usuario={findByPk:async (id,options)=>{
    assert.equal(id,input.userId);
    assert.deepEqual(options.attributes,['telefono']);
    return {telefono:'600000003'};
  }};
  assert.equal((await f.service.get({...input,requestId:undefined})).suggested_to,'+34600000003');
  assert.equal(f.calls.length,0);
  f.deny();
  await assert.rejects(f.service.get({...input,requestId:undefined}),{code:'payment_test_forbidden'});
});
test('permission is checked before loading any asset and scope mismatch is rejected',async()=>{
  const f=fixture();f.deny();f.db.ClinicMetaAsset.findOne=()=>{throw Error('must not load asset');};
  await assert.rejects(f.service.get(input),{code:'payment_test_forbidden'});
  const g=fixture();g.asset.clinicaId=57;await assert.rejects(g.service.send(input),{code:'payment_test_phone_not_found'});
  assert.equal(g.calls.length,0);
});
test('invalid request IDs and phone input do not reach transport',async()=>{
  for(const patch of [{requestId:'bad'}, {requestId:[input.requestId]}, {to:''}, {to:'someone +34 600 000 001'}, {to:'123'}]){
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
    ensureScopeAccess:()=>{},guardReviewCare:async()=>{},normalizeMassSendRecordKind:()=> 'campaign'};
  vm.createContext(context);vm.runInContext(guard+'\n'+command,context);
  await assert.rejects(context.sendTest({},1,{payment_recovery_probe:true}),{code:'payment_test_not_dispatchable'});
});

test('native sender resolution permits the exact active diagnostic on a secondary and leaves campaign routing closed', async () => {
  const source=fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'),'utf8');
  const start=source.indexOf('async function resolveWhatsappClinicConfigForList(');
  const end=source.indexOf('\nfunction isWhatsappRoutingConfigAvailable',start);
  const asset={id:404,assignmentScope:'clinic',clinicaId:56,whatsappAuthorizationId:'current',additionalData:{}};
  const config={originId:404,phoneNumberId:'123456',wabaId:'987654',authorizedBroker:{sendEnabled:true}};
  const list={criteria:{phone_number_id:'123456',waba_id:'987654',authorization_id:'current'}};
  const context={
    getRequestedWhatsappSenderOriginId:()=>404,
    Clinica:{findByPk:async()=>({id_clinica:56})},ClinicMetaAsset:{findOne:async()=>asset},
    whatsappChannelBindingsService:{listClinicBindings:async()=>[]},
    resolveWhatsappRouting:()=>({role:'secondary',purposes:[]}),getWhatsappRoutingPurposeForList:()=> 'bulk_campaigns',
    whatsappService:{getConfigByAssetId:async()=>config},require:()=>({current:()=>null}),
  };
  vm.runInNewContext(source.slice(start,end),context);
  const resolve=context.resolveWhatsappClinicConfigForList;
  await assert.rejects(resolve(list,56,{}),{code:'whatsapp_sender_purpose_not_allowed'});
  const probe=await resolve(list,56,{}, {diagnostic:true});
  assert.equal(probe.routingPurpose,null);
  assert.equal(probe.phoneNumberId,'123456');
  asset.whatsappAuthorizationId='replacement';
  await assert.rejects(resolve(list,56,{}, {diagnostic:true}),{code:'payment_test_binding_changed'});
});

test('a deferred diagnostic revalidates the single outlet, recipient and existing cooldown claim', async () => {
  const source=fs.readFileSync(require.resolve('../../services/whatsappDispatchWait.service'),'utf8');
  const start=source.indexOf('async function assertRetryablePaymentProbe(');
  const end=source.indexOf('\nasync function defer(',start);
  const phoneNumberId='123456', wabaId='987654', recipient='34600000001';
  const now=Date.parse('2030-01-02T10:00:00Z');
  const asset={id:404,phoneNumberId,wabaId,whatsappAuthorizationId:'current',additionalData:{payment:{last_probe_message_id:50}}};
  const message={id:50,direction:'outbound',message_type:'template',createdAt:new Date(now-30000).toISOString(),
    metadata:{sender_origin_id:404,phoneNumberId,wabaId,recipient,template_id:12,template_name:'qa_test',template_language:'es'}};
  const list={source:'whatsapp_payment_recovery_test',status:'archived',clinica_id:56,created_by:1,
    criteria:{whatsapp_payment_recovery_test:true,sender_origin_id:404,phone_number_id:phoneNumberId,waba_id:wabaId,
      authorization_id:'current',probe_to:recipient,whatsapp_template_id:12}};
  const wait={intent:{clinicId:56,assetId:404,expectedBinding:{phoneId:phoneNumberId,wabaId},
    message:{type:'template',to:recipient,template:{name:'qa_test',language:{code:'es'}}}}};
  const context={PROBE_MAX_AGE_MS:600000,Date:class extends Date {static now(){return now;}},require:name=>{
    if(name.endsWith('whatsappManualDisconnect')) return {current:()=>null};
    if(name.endsWith('whatsappAccountHealth.service')) return {summarizeAssetHealth:()=>({can_send:true})};
    if(name.endsWith('whatsapp-payment-recovery-probe')) return {availability:({asset})=>({allowed:asset.additionalData.payment.last_probe_at===null})};
    if(name.endsWith('marketingScopeAccess')) return {hasMarketingClinicScopeAccess:async()=>true};
    throw Error('unexpected dependency');
  }};
  vm.runInNewContext(source.slice(start,end),context);
  const models={ClinicMetaAsset:{findByPk:async()=>asset}};
  const check=context.assertRetryablePaymentProbe;
  await check(models,list,message,wait);
  await assert.rejects(check(models,{...list,source:'import'},message,wait),{code:'payment_probe_retry_unavailable'});
  await assert.rejects(check(models,list,{...message,metadata:{...message.metadata,recipient:'34600000002'}},wait),{code:'payment_probe_retry_unavailable'});
  asset.additionalData.payment.last_probe_message_id=51;
  await assert.rejects(check(models,list,message,wait),{code:'payment_probe_retry_unavailable'});
});
