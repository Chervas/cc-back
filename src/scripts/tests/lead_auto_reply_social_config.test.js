'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const file = require.resolve('../../services/leadAutoReply.service');
const requireService = Module.createRequire(file);
const unexpected = () => assert.fail('Unexpected operation outside the configuration test');
const db = { Sequelize: require('sequelize'), sequelize:{transaction:unexpected}, Clinica:{findByPk:unexpected},
  AutomationFlowTemplateV2:{findOne:unexpected,create:unexpected,update:unexpected}, LeadIntake:{findOne:unexpected,findAll:unexpected},
  WhatsappTemplate:{findOne:unexpected} };
const whatsapp = {getClinicConfig:unexpected};
const services = {'../../models':db,'./jobRequests.service':{},'./jobScheduler.service':{},
  './clinicOpeningHours.service':{resolveLeadAutoReplyWait:unexpected},'./leadContactState.service':{},
  './whatsappTemplateScope.service':{},'./whatsapp.service':whatsapp};
const loaded = new Module(file);
loaded.filename=file;
loaded.require=dep=>Object.hasOwn(services,dep) ? services[dep] : requireService(dep);
loaded._compile(fs.readFileSync(file,'utf8'),file);
const service = loaded.exports;
const inputs = {
  instagram_dm: { action: 'message', text: 'Una respuesta ficticia' },
  instagram_comment: { action: 'notify' },
  messenger_dm: { action: 'notify' },
};

function clinic(t) {
  let flow = null;
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  t.mock.method(db.sequelize, 'transaction', async fn => fn(transaction));
  t.mock.method(db.Clinica, 'findByPk', async () => ({ id_clinica: 7, nombre_clinica: 'Clínica de prueba' }));
  t.mock.method(db.AutomationFlowTemplateV2, 'findOne', async ({ where }) => where.is_active && !flow?.is_active ? null : flow);
  t.mock.method(db.AutomationFlowTemplateV2, 'update', async () => [1]);
  t.mock.method(db.AutomationFlowTemplateV2, 'create', async values => { flow = { ...values, id: values.version }; return flow; });
  const wh = t.mock.method(whatsapp,'getClinicConfig', async()=>({wabaId:'test'}));
  const template = t.mock.method(db.WhatsappTemplate,'findOne', async()=>({
    id:17, clinic_id:7, is_active:true, waba_id:'test', status:'APPROVED', name:'lead_auto_reply_example', variables:[], language:'es', catalog_template_id:7,
  }));
  const leads = t.mock.method(db.LeadIntake, 'findOne', async()=>assert.fail('Unexpected historical contact lookup'));
  t.mock.method(db.LeadIntake, 'findAll', async()=>assert.fail('Unexpected historical contact listing'));
  return {save:input=>service.saveConfig({clinicId:7,actorUserId:11,input}), flow:()=>flow, wh, template, leads};
}

test('explicit social-only configuration activates without Whatsapp, a contact name or a clinic schedule and excludes prior leads and calls', async t => {
  const c=clinic(t);
  const result=await c.save({active:true,sources:[],social_entries:inputs});
  assert(result.active && result.readiness.ready);
  assert.deepEqual(result.config.social_entries,inputs);
  assert.equal(c.wh.mock.callCount()+c.template.mock.callCount(),0);
  assert.deepEqual(await service.getPendingPreview(7),{clinic_id:7,count:0,optional_call_count:0,configured:false});
  assert.deepEqual(await service.startPendingBatch({clinicId:7,actorUserId:11,includeCallPending:true}),{job_id:null,total:0,status:'completed'});
  const prior=await service.runPendingBatchJob({clinic_id:7,lead_ids:[1,2],include_call_pending:true});
  assert.equal(prior.queued,0); assert.deepEqual(prior.skipped_reasons,{event_source_disabled:2});
  assert.equal(c.leads.mock.callCount(),0);
  assert.equal(c.flow().nodes.find(node=>node.id==='social_route').outputs.on_false,'N10');
  assert(!c.flow().nodes.some(node=>node.type==='action/send_whatsapp'));
  await assert.rejects(c.save({active:true,sources:[],social_entries:{}}),{code:'lead_auto_reply_configuration_incomplete'});
  const cleared=await c.save({sources:[],social_entries:{},schedule_scope:'all_days'});
  assert(!cleared.active && !cleared.configured);
  assert.deepEqual(cleared.config.social_entries,{});
});

test('client omitting social_entries preserves the rules and Whatsapp requirements; explicit empty removes every social action',async t=>{
  const c=clinic(t);
  const request={sources:['write','call'],schedule_scope:'all_days',sender_display_name:'Marta',whatsapp_template_id:17};
  await c.save({...request,active:true,social_entries:inputs});
  assert(c.flow().nodes.some(node=>node.type==='action/send_whatsapp'));
  assert.equal(c.flow().nodes.find(node=>node.id==='social_route').outputs.on_false,'N2');
  assert.deepEqual((await c.save({...request,timing:'next_day'})).config.social_entries,inputs);
  await assert.rejects(c.save({sources:['call'],sender_display_name:''}),{code:'lead_auto_reply_configuration_incomplete'});
  const next=await c.save({...request,social_entries:{}});
  assert.deepEqual(next.config.social_entries,{}); assert(!c.flow().nodes.some(node=>node.id==='social_route'));
  await assert.rejects(c.save({sources:[],social_entries:{}}),{code:'lead_auto_reply_configuration_incomplete'});
});

test('invalid social rules are rejected without creating a flow; previously stored malformed social rules cannot trigger sends',async t=>{
  const c=clinic(t);
  for (const invalid of [null,[],{other:{action:'notify'}},{instagram_dm:{action:'bot'}},{instagram_dm:{action:'message',text:'  '}},
    {instagram_dm:{action:'message',text:'a'.repeat(1001)}},{messenger_dm:{action:'message',text:'hello'}},{instagram_dm:{action:'notify',text:'unexpected'}},
    {instagram_dm:{action:'message',text:'hi',recipient:'foreign'}}]) {
    await assert.rejects(c.save({sources:[],social_entries:invalid}),{code:'lead_auto_reply_social_entry_invalid'});
    assert.deepEqual(service.normalizeConfig({social_entries:invalid}).social_entries,{});
  }
  assert.equal(c.flow(),null);
  const edge=await c.save({social_entries:{instagram_dm:{action:'message',text:' '+ 'a'.repeat(1000)+' '}}});
  assert.equal(edge.config.social_entries.instagram_dm.text.length,1000);
});
