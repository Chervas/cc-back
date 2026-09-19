'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PHASES,fromEnrollment}=require('../src/meta-enrollment-event'),{pack,unpack,keyFor}=require('../src/event'),{refFor}=require('../src/reader-protocol');
const row={enrollment_id:randomUUID(),flow_id:randomUUID(),scope_key:'group:5',connection_ref:'meta:fixture',clinic_ids:'[59,71]',actor_user_id:9,session_ref:randomUUID(),
  assets:JSON.stringify([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null}]),candidate_digest:'a'.repeat(64),selection_digest:null};
const now=new Date('2026-09-19T08:00:00Z');
test('v24 transitions preserve request/flow/human and counts without inventory or credentials',()=>{
  for(const [reason,phase] of Object.entries(PHASES)){
    const value=fromEnrollment({...row,selection_digest:phase[1]>1?'b'.repeat(64):null},reason,{now}),record=pack(value);
    assert.deepEqual(unpack(record).event,value);assert(!record.body.includes('meta-ad_account:301'));assert.equal(value.state,phase[0]);assert.match(keyFor(record),/^app\/platform\/v24\//);
    refFor({key:keyFor(record),versionId:'fictitious-version',digest:record.digest},'confirmed');
  }
});
test('v24 distinguishes pending reservation from activation and rejects forged completion or leaked payload',()=>{
  const value=fromEnrollment(row,'meta_enrollment_requested',{now});
  for(const patch of [{version:23},{token:'FICTITIOUS'},{assets:[]},{state:'active'},{outcome:'unknown'},{stage:'attempted'},{requestRef:randomUUID()},
    {actor:{type:'job',id:'meta_marketing_enrollment_worker'},sessionRef:null},{actor:{type:'user',id:'10'}},{scope:{type:'clinic',id:'59'}},
    {clinicCount:0},{assetCount:101},{candidateDigest:null},{selectionDigest:'b'.repeat(64)}])assert.throws(()=>pack({...value,...patch}));
  const active=fromEnrollment({...row,selection_digest:'b'.repeat(64)},'meta_enrollment_activated',{now});
  assert.throws(()=>pack({...active,selectionDigest:null}));assert.throws(()=>pack({...active,actor:{type:'user',id:'9'},sessionRef:row.session_ref}));
});
test('v24 authorized cancellation can record a different human without rewriting initiating identity',()=>{
  const value=fromEnrollment(row,'meta_enrollment_cancel_requested',{now,actorId:10,sessionRef:randomUUID()});
  assert.equal(value.actor.id,'10');assert.equal(value.subjectUserId,'9');assert.equal(value.state,'revoke_pending');assert.equal(pack(value).event.selectionDigest,null);
});
