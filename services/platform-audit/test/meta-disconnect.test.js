'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fromRevocation}=require('../src/meta-disconnect-event'),{pack,unpack,keyFor}=require('../src/event'),{refFor}=require('../src/reader-protocol');
const row={request_id:randomUUID(),actor_user_id:9,scope_key:'group:5',clinic_ids:'[59,71]',connection_ref:'meta:fixture',asset_ref:'meta-ad_account:301'};
test('v21 withdrawal preserves actor/scope correlation through confirmation without provider data',()=>{
  for(const stage of ['attempted','completed']){
    const event=fromRevocation(row,stage,new Date('2026-09-19T04:00:00.000Z'),stage==='attempted'?randomUUID():null),record=pack(event);
    assert.deepEqual(unpack(record).event,event);assert.equal(event.correlationId,row.request_id);assert.equal(event.affectedClinicCount,2);
    assert.match(keyFor(record),/^app\/platform\/v21\//);refFor({key:keyFor(record),digest:record.digest,versionId:'test21'},'confirmed');
    assert(Buffer.byteLength(record.body)<2000);
  }
});
test('v21 rejects WhatsApp, unscoped actors, unsupported operations, secrets and false confirmations',()=>{
  const event=fromRevocation(row,'attempted',new Date('2026-09-19T04:00:00.000Z'),randomUUID());
  for(const patch of [{payload:{}},{accessToken:'FICTITIOUS'},{provider:'whatsapp'},{assetRef:'meta-whatsapp_phone_number:301'},{scope:{type:'platform',id:null}},
    {sessionRef:null},{stage:'completed'},{outcome:'success'},{operation:'meta.marketing.asset.read.v1'},{affectedClinicCount:1001},{version:22}])assert.throws(()=>pack({...event,...patch}));
});
