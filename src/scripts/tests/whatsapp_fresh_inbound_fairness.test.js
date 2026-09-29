'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('./fixtures/campaign_offline_runtime.cjs');
test('a full page of imported-patient HOLDs cannot starve a later ordinary reply; retained rows are revisited',async()=>{
 const now=Date.now(),binding={clinicId:2,phoneId:'123',wabaId:'456',assetId:4,sendEnabled:true};
 const config={bindings:[binding],messageNotBefore:new Date(now-3600000).toISOString()};
 const snapshot={version:1,observedAt:now,recoveryHold:false,clinics:[{clinicId:2,oldestPendingAt:null,blockingReview:0}]};
 const messages=Array.from({length:51},(_,n)=>({id:n+1,conversation_id:n+1,direction:'inbound',message_type:'text',sent_at:new Date(now-5000),
  metadata:{passive_recovery:true,historical:false,provider_type:'text',phone_number_id:'123',waba_id:'456',wamid:'wamid.SYNTHETIC'+n,inbox_receipt:'a1234567-1234-4234-8234-123456789abc'},async update(p){Object.assign(this,p)}}));
 const cursors=[],sent=[];
 const db={sequelize:{query:async(sql,{replacements})=>{assert.match(sql,/m.id>:afterMessageId/);cursors.push(replacements.afterMessageId);return [messages.filter(m=>m.id>replacements.afterMessageId&&!m.metadata.fresh_inbound_dispatched_at).slice(0,50).map(m=>({id:m.id}))]},transaction:work=>work({LOCK:{UPDATE:'UPDATE'}})},
  Message:{findByPk:async id=>messages[id-1]},Conversation:{findByPk:async id=>({id,clinic_id:2,channel:'whatsapp',patient_id:id})}};
 const sandbox={Date,module:{exports:{}},require:name=>{
  if(name==='../lib/whatsappFreshInboundEligibility')return require('../../lib/whatsappFreshInboundEligibility');
  if(name==='../lib/whatsappAuthorizedBrokerClient')return {configuration:()=>config,binding:async()=>binding};
  if(name==='../lib/whatsappAppointmentEligibility')return {patientImportHeld:async id=>id<=50};
  if(name==='../lib/whatsappInboxHealth')return {...require('../../lib/whatsappInboxHealth'),read:()=>snapshot};
  if(name==='../../models')return db;
  if(name==='./automationInboundMessage.service')return {enqueueInboundDispatch:async({inboundMessage})=>sent.push(inboundMessage.id)};
  throw Error(name);
 }};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require.resolve('../../services/whatsappFreshInbound.service'),'utf8'),sandbox);
 for(let n=0;n<4;n++)await sandbox.module.exports.tick();
 assert.deepEqual(cursors,[0,50,51,0]);assert.deepEqual(sent,[51]);
 assert(messages.slice(0,50).every(m=>!m.metadata.fresh_inbound_dispatched_at));
});
