'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const A=require('../src/meta-business-continuity-event'),E=require('../src/event'),P=require('../src/reader-protocol');
test('Business handover and maintenance have independent closed events, storage keys and readable receipts',()=>{
  const id=randomUUID(),old=randomUUID(),row={handover_id:id,new_enrollment_id:id,old_enrollment_id:old,maintenance_id:id,enrollment_id:old,expected_version_id:randomUUID(),expected_epoch:0,
    actor_user_id:99,session_ref:randomUUID(),scope_key:'group:29',clinic_ids:'[66,72]',assets:JSON.stringify([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null}]),state:'active',candidate_metadata:JSON.stringify({versionId:id})};
  for(const reason of Object.keys(A.PHASES)){
    const event=reason.startsWith('meta_business')?A.fromHandover(row,reason,{now:new Date('2030-01-01T12:00:00Z')}):A.fromMaintenance({...row,state:'succeeded'},row,reason,{now:new Date('2030-01-01T12:00:00Z')});
    const packed=E.pack(event),key=E.keyFor(packed);assert.match(key,/^app\/platform\/v(?:29|30)\//);assert.equal(E.unpack(packed).event.action,event.action);
    assert.deepEqual(P.refFor({key,digest:packed.digest,versionId:'FICTITIOUS_AUDIT_VERSION'},'confirmed'),{key,digest:packed.digest,versionId:'FICTITIOUS_AUDIT_VERSION'});
    for(const mutate of [value=>value.token='FICTITIOUS_SECRET',value=>value.reason='provider_raw_message',value=>value.actor.id='forged_actor']){const copy=structuredClone(event);mutate(copy);assert.throws(()=>E.pack(copy));}
  }
});
