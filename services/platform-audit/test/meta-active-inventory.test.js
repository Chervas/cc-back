'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {pack,unpack,keyFor}=require('../src/event'),{refFor}=require('../src/reader-protocol'),{criteriaFor}=require('../src/view-contract');
const {fromActiveInventory}=require('../src/meta-active-inventory-event');
const {generateKeyPairSync}=require('node:crypto'),{Readable}=require('node:stream');
function value(reason='inventory_requested'){
 const captured={row:{scope_key:'clinic:95',connection_ref:'fictitious-connection',enrollment_id:randomUUID(),clinicIds:[95],clinic_ids:'[95]'},effective:{versionId:randomUUID(),epoch:2}};
 return fromActiveInventory(captured,{actorId:225,sessionRef:randomUUID()},randomUUID(),reason,new Date('2030-01-01T12:00:00Z'),reason==='inventory_verified'?{assets:[{assetRef:'meta-ad_account:301'}]}:null);
}
test('active inventory v32 preserves current actor/epoch and durable phases without candidate history',()=>{
 for(const reason of ['inventory_requested','inventory_verified','access_changed','inventory_unavailable']){
  const event=value(reason),row=pack(event);assert.deepEqual(unpack(row).event,event);assert.match(keyFor(row),/^app\/platform\/v32\//);
  refFor({key:keyFor(row),digest:row.digest,versionId:'synthetic-v32'},'confirmed');
  assert.equal(event.epoch,2);assert.equal(event.actor.id,'225');assert.equal(event.flowRef,undefined);assert.equal(event.candidateDigest,undefined);
 }
 criteriaFor({from:'2030-01-01',to:'2030-01-01',action:'integration.meta.active_asset_list',userId:'225'});
});
test('active inventory rejects secret/free content, pending impersonation and malformed pins',()=>{
 for(const patch of [{token:'FICTITIOUS_SECRET'},{epoch:-1},{credentialVersionRef:null},{capturePolicy:'meta-candidate-inventory-v1'},{actor:{type:'job',id:'worker'}},{assetCount:101},{resultDigest:'a'.repeat(64)},{flowRef:randomUUID()}])assert.throws(()=>pack({...value(),...patch}));
});
test('v32 signed Reader verifies the exact S3 version/digest/KMS and rejects substituted evidence',async()=>{
 const {readBatch}=require('../src/reader'),{signRequest}=require('../src/reader-protocol'),{KEY_ARN}=require('../src/s3');
 const row=pack(value('inventory_verified')),key=generateKeyPairSync('ed25519').privateKey;
 const input=signRequest({mode:'confirmed',actorId:'1',sessionRef:randomUUID(),refs:[{key:keyFor(row),digest:row.digest,versionId:'synthetic-v32'}]},
  {keyId:'fixture',privateKey:key.export({type:'pkcs8',format:'pem'})}).input;
 for(const substituted of [false,true]){
  const result=await readBatch(input,{send:async command=>{assert.equal(command.input.VersionId,'synthetic-v32');return {ContentLength:Buffer.byteLength(row.body),ContentType:'application/json',
   ChecksumSHA256:Buffer.from(row.digest,'hex').toString('base64'),ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN,VersionId:substituted?'other-version':'synthetic-v32',Body:Readable.from([row.body])};}});
  assert.equal(result.results[0].status,substituted?'error':'verified');
 }
});
