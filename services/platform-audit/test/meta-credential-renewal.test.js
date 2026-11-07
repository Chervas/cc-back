'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fromRenewal,PHASES}=require('../src/meta-credential-renewal-event'),{pack,unpack,keyFor}=require('../src/event');
function row(){const id=randomUUID();return {renewal_id:id,enrollment_id:randomUUID(),expected_version_id:randomUUID(),expected_epoch:0,actor_user_id:1,session_ref:randomUUID(),
  scope_key:'group:29',clinic_ids:'[66,72]',assets:JSON.stringify([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null}]),asset_set_digest:'a'.repeat(64),
  state:'staged',candidate_metadata:JSON.stringify({versionId:id})};}
test('renewal audit has its own version, action, closed reasons and separate immutable enrollment reference',()=>{
  const value=row(),now=new Date('2030-01-01T12:00:00Z');
  for(const reason of Object.keys(PHASES)){
    const event=fromRenewal(value,reason,{now}),packed=pack(event);assert.equal(unpack({body:packed.body,digest:packed.digest}).event.version,28);
    assert.equal(event.action,'integration.meta.credential_renewal');assert.equal(event.enrollmentRef,value.enrollment_id);assert.equal(event.requestRef,value.renewal_id);
    assert.match(keyFor({body:packed.body,digest:packed.digest}),/^app\/platform\/v28\//);
  }
});
test('unknown reasons, token/provider fields, forged actors and false activation semantics are rejected',()=>{
  const value=row(),event=fromRenewal(value,'meta_credential_renewal_requested',{now:new Date('2030-01-01T12:00:00Z')});
  assert.throws(()=>fromRenewal(value,'meta_enrollment_activated'));
  for(const mutate of [v=>v.reason='free_provider_error',v=>v.token='FICTITIOUS_SECRET',v=>v.actor.id='2',v=>v.version=24,v=>v.action='integration.meta.enrollment']){
    const copy=structuredClone(event);mutate(copy);assert.throws(()=>pack(copy));
  }
  assert(!JSON.stringify(event).includes('FICTITIOUS_SECRET'));
});
