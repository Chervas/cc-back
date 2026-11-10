'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Identity=require('../../lib/whatsapp-contact-identity');
function fixture(commercial) {
  const source=fs.readFileSync(require.resolve('../../services/whatsapp.service'),'utf8');
  const start=source.indexOf('    async dispatchMessage('),end=source.indexOf('\n    /**',start);
  assert(start>0&&end>start);
  const calls=[],sent=[];const broker={isManagedMessage:async()=>false,send:async body=>{sent.push(body);return {accepted:true};}};
  const deps={
    '../lib/whatsapp-contact-identity':Identity,
    './whatsappContactIdentity.service':{assertDestination:async(to,config,policy={})=>{calls.push({to,policy});if(policy.commercial)throw Object.assign(Error('review_required'),{code:'WHATSAPP_IDENTITY_MARKETING_REVIEW_REQUIRED'});return {recipient:'ES.Fictitious123'};}},
    './marketingOptOut.service':{isMarketingOutboundMessage:()=>commercial},
    '../lib/automation-runtime-stop':{assertMessageCanDispatch:async()=>{}},
  };
  const context={require:name=>{assert(Object.hasOwn(deps,name),'unexpected dependency '+name);return deps[name];},db:{Message:{findByPk:async()=>({id:1,conversation_id:2})}},whatsappAuthorizedBroker:broker};
  const actual=vm.runInNewContext('({'+source.slice(start,end)+'})',context);
  Object.assign(actual,{assertRecipientCanReceive:async()=>{},assertClinicNonOperationalAllowed:async()=>{},assertPrivacyCommercialAllowed:async()=>{}});
  const config={clinicId:71,originId:9,phoneNumberId:'201',wabaId:'101',authorizedBroker:{phoneId:'201',wabaId:'101'}};
  return {run:()=>actual.dispatchMessage({messaging_product:'whatsapp',to:'bsuid:301:ES.Fictitious123',type:'text',text:{body:'Fictitious response'}},config,{messageId:1}),calls,sent};
}
test('a service reply keeps its opaque recipient through the actual final sender',async()=>{
 const f=fixture(false);await f.run();assert.equal(f.sent.length,1);assert.equal(f.sent[0].message.recipient,'ES.Fictitious123');assert(!Object.hasOwn(f.sent[0].message,'to'));
});
test('commercial text to an unknown-phone contact cannot bypass the template-only review gate',async()=>{
 const f=fixture(true);await assert.rejects(f.run(),e=>e.code==='WHATSAPP_IDENTITY_MARKETING_REVIEW_REQUIRED');assert.equal(f.sent.length,0);assert(f.calls.some(c=>c.policy.commercial));
});
