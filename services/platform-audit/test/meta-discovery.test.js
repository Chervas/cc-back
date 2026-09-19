'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fromDiscovery}=require('../src/meta-discovery-event'),{pack,unpack,keyFor}=require('../src/event'),{refFor}=require('../src/reader-protocol');
const row={scope_key:'group:5',flow_id:randomUUID(),connection_ref:'meta:fixture',clinic_ids:'[59,71]',candidate_metadata:JSON.stringify({digest:'a'.repeat(64)})},actor={actorId:9,sessionRef:randomUUID()};
test('v23 candidate inventory binds human, flow, scope and complete result digest without provider payload',()=>{
  for(const reason of ['inventory_requested','inventory_verified','access_changed','inventory_unavailable']){
    const event=fromDiscovery(row,actor,randomUUID(),reason,new Date('2026-09-19T06:00:00Z'),reason==='inventory_verified'?{assets:[{id:'fictitious'}]}:null),record=pack(event);
    assert.deepEqual(unpack(record).event,event);assert.equal(event.flowRef,row.flow_id);assert(!record.body.includes('fictitious'));assert.match(keyFor(record),/^app\/platform\/v23\//);
    refFor({key:keyFor(record),versionId:'test23',digest:record.digest},'confirmed');
  }
});
test('v23 rejects partial success, extra secrets, wrong scope/count and nonhuman actor',()=>{
  const v=fromDiscovery(row,actor,randomUUID(),'inventory_requested',new Date('2026-09-19T06:00:00Z'));
  for(const patch of [{token:'FICTITIOUS'},{assets:[]},{outcome:'success'},{assetCount:1},{resultDigest:'a'.repeat(64)},{flowRef:'bad'},
    {actor:{type:'job',id:'worker'}},{scope:{type:'clinic',id:'5'}},{candidateDigest:null}])assert.throws(()=>pack({...v,...patch}));
});
