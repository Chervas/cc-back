'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fromFlow}=require('../src/meta-oauth-event'),{pack,unpack,keyFor}=require('../src/event'),{refFor}=require('../src/reader-protocol');
const row={flow_id:randomUUID(),actor_user_id:9,session_ref:randomUUID(),scope_key:'group:5',clinic_ids:'[59,71]',connection_ref:'meta:fixture',asset_ref:'meta-enroll:group:5'};
test('v22 records Meta candidate authorization and cancellation with immutable correlation and closed payload',()=>{
  for(const reason of ['authorization_requested','credentials_staged','authorization_cancel_requested','authorization_cancelled']){
    const event=fromFlow(row,reason,new Date('2026-09-19T05:00:00Z'),reason==='authorization_cancelled'),record=pack(event);
    assert.deepEqual(unpack(record).event,event);assert.equal(event.correlationId,row.flow_id);assert.equal(event.clinicCount,2);assert(Buffer.byteLength(record.body)<2000);
    assert.match(keyFor(record),/^app\/platform\/v22\//);refFor({key:keyFor(record),digest:record.digest,versionId:'test22'},'confirmed');
  }
});
test('v22 rejects credentials, wrong group/provider, false success and unsupported stages/actors',()=>{
  const event=fromFlow(row,'authorization_requested',new Date('2026-09-19T05:00:00Z'));
  for(const patch of [{accessToken:'FICTITIOUS'},{code:'FICTITIOUS'},{state:'FICTITIOUS'},{provider:'google_ads'},{scope:{type:'platform',id:null}},
    {sessionRef:null},{outcome:'success'},{stage:'completed'},{actor:{type:'job',id:'meta_marketing_oauth_worker'},sessionRef:null},{clinicCount:1001},{assetRef:'meta-enroll:clinic:5'},
    {scope:{type:'clinic',id:'5'},assetRef:'meta-enroll:clinic:5',clinicCount:2}])assert.throws(()=>pack({...event,...patch}));
});
