'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {packetFor}=require('../../lib/socket-payload');
const base=()=>({id:'12',event:'crm.call_back_reminder',clinicaId:72,title:'Synthetic reminder',description:'Synthetic contact',read:false,
 link:'/marketing/leads',useRouter:true,data:{leadId:99,clinicId:66,kind:'lead_callback_reminder',displayMode:'persistent_alert',requiresAcknowledgement:true,notes:'PRIVATE NOTES',providerToken:'NEVER EXPOSE'}});
test('live callbacks preserve the closed persistent presentation and lead id, derive clinic from scoped DTO, strip private metadata',()=>{
 const p=packetFor('notification:created',base());
 assert.deepEqual(p.body.data,{leadId:99,kind:'lead_callback_reminder',displayMode:'persistent_alert',requiresAcknowledgement:true,clinicId:72});
 assert.deepEqual(p.resource,{type:'notification',id:'12'});assert(!JSON.stringify(p).includes('PRIVATE'));assert(!JSON.stringify(p).includes('NEVER'));
});
test('a lookalike event, missing lead or incomplete presentation cannot gain persistent callback metadata',()=>{
 for(const mutate of [n=>n.event='custom',n=>n.data.leadId=null,n=>n.data.requiresAcknowledgement=false,n=>n.clinicaId=null]){
  const n=base();mutate(n);const p=packetFor('notification:created',n);assert.equal(p.body.data.kind,undefined);assert.equal(p.body.data.displayMode,undefined);
 }
});
test('arbitrary navigation remains forbidden even for a callback reminder',()=>{const n=base();n.link='https://example.invalid/private';assert.equal(packetFor('notification:updated',n).body.link,null)});
