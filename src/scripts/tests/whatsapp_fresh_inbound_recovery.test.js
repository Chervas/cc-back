'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('./fixtures/campaign_offline_runtime.cjs');
const health=require('../../lib/whatsappInboxHealth'),fresh=require('../../lib/whatsappFreshInboundEligibility');
function fixture({hold=false,beforeCut=false}={}) {
 const now=Date.now(),cut=new Date(now-60000).toISOString();
 const b={clinicId:2,assetId:4,phoneId:'123',wabaId:'456',sendEnabled:true,authorizationId:'synthetic'};
 const config={bindings:[b],messageNotBefore:new Date(now-86400000).toISOString()};
 const snapshot={version:1,observedAt:now,recoveryHold:hold,recoveryNotBefore:cut,clinics:[{clinicId:2,oldestPendingAt:null,blockingReview:0}]};
 const conversation={id:3,clinic_id:2,channel:'whatsapp'};
 const message={id:5,conversation_id:3,direction:'inbound',message_type:'text',sent_at:new Date(now-(beforeCut?120000:5000)),
  metadata:{passive_recovery:true,historical:false,provider_type:'text',phone_number_id:'123',waba_id:'456',wamid:'wamid.SYNTHETIC',inbox_receipt:'a1234567-1234-4234-8234-123456789abc'},
  async update(p){Object.assign(this,p)}};
 let dispatched=0,queried=0;
 const db={sequelize:{query:async(_sql,{replacements})=>{queried++;assert.equal(replacements.cutoff.toISOString(),cut);return [[{id:5}]]},transaction:work=>work({LOCK:{UPDATE:'UPDATE'}})},
  Message:{findByPk:async()=>message},Conversation:{findByPk:async()=>conversation}};
 const c={module:{exports:{}},Date,require:name=>{
  if(name==='../lib/whatsappFreshInboundEligibility')return fresh;
  if(name==='../lib/whatsappAuthorizedBrokerClient')return {configuration:()=>config,binding:async()=>b};
  if(name==='../lib/whatsappAppointmentEligibility')return {patientImportHeld:async()=>false};
  if(name==='../lib/whatsappInboxHealth')return {...health,read:()=>snapshot};
  if(name==='../../models')return db;
  if(name==='./automationInboundMessage.service')return {enqueueInboundDispatch:async()=>{dispatched++}};
  throw Error('unexpected dependency');
 }};
 vm.createContext(c);vm.runInContext(fs.readFileSync(require.resolve('../../services/whatsappFreshInbound.service'),'utf8'),c);
 return {run:()=>c.module.exports.tick(),get dispatched(){return dispatched},get queried(){return queried},message};
}
test('hold never dispatches and a previously imported row without a recovery marker still respects the new cutoff',async()=>{
 const held=fixture({hold:true});await held.run();assert.equal(held.dispatched,0);assert.equal(held.queried,0);
 const old=fixture({beforeCut:true});await old.run();assert.equal(old.dispatched,0);assert.equal(old.message.metadata.fresh_inbound_dispatched_at,undefined);
});
test('fresh replies after reopening resume the ordinary flow exactly once',async()=>{
 const f=fixture();await f.run();assert.equal(f.dispatched,1);assert.equal(f.message.metadata.automatic_actions_allowed,true);
 await f.run();assert.equal(f.dispatched,1);
});
