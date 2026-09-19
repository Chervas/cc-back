'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{Readable}=require('node:stream');
const {fromMetaAccessCheck}=require('../src/meta-access-check-event'),{pack,unpack,keyFor}=require('../src/event'),{refFor}=require('../src/reader-protocol');
const make=(reason='check_requested',result=null)=>fromMetaAccessCheck({actor:{userId:9,sessionRef:randomUUID()},captured:{scopeKey:'group:5',mappingId:11,connectionRef:'meta:fixture',assetRef:'meta-ad_account:301',clinicIds:[59,71]},requestId:randomUUID(),operation:'meta.marketing.asset.read.v1',reason,result,now:new Date('2026-09-19T04:00:00.000Z')});
test('v20 intent, verified asset and denied/error results retain actor/scope but no provider response or secret',()=>{
  for(const [reason,result] of [['check_requested',null],['asset_verified',{name:'FICTITIOUS_PROVIDER_NAME',accessToken:'FICTITIOUS_SECRET'}],['access_changed',null],['read_unavailable',null]]){
    const e=make(reason,result),row=pack(e);assert.deepEqual(unpack(row).event,e);assert.match(keyFor(row),/^app\/platform\/v20\//);assert(!row.body.includes('FICTITIOUS'));assert(Buffer.byteLength(row.body)<2000);refFor({key:keyFor(row),digest:row.digest,versionId:'v20-test'},'confirmed');
  }
});
test('v20 rejects open fields, false success, foreign actor/scope, excessive cardinality and write operations',()=>{
  const e=make();for(const patch of [{payload:{}},{actor:{type:'job',id:'9'}},{scope:{type:'platform',id:null}},{version:21},{resultDigest:'a'.repeat(64)},{clinicCount:1001},{clinicSetDigest:['a'.repeat(64)]},{operation:'meta.marketing.asset.revoke.v1'},{assetRef:'meta-whatsapp_phone_number:301'},{mappingId:11},{outcome:'success'}])assert.throws(()=>pack({...e,...patch}));
  const done=make('asset_verified',{ok:true});for(const patch of [{reason:'credential_verified'},{resultDigest:null},{stage:'attempted'},{operation:'meta.marketing.connection.read.v1'},{outcome:'denied'}])assert.throws(()=>pack({...done,...patch}));
});
test('v20 exact S3 version, digest and KMS verification; v23 refs stay closed',async()=>{
  const row=pack(make('asset_verified',{id:'act_301'})),{KEY_ARN}=require('../src/s3');const ref={key:keyFor(row),digest:row.digest,versionId:'test20'};
  assert.throws(()=>refFor({...ref,key:ref.key.replace('/v20/','/v23/')},'confirmed'));
  for(const wrong of [false,true]){
    const result=await require('../src/reader').readBatch({version:1,audience:'clinicaclick-audit-reader-v1',requestId:randomUUID(),nonce:randomUUID(),issuedAt:Date.now(),mode:'confirmed',actorId:'1',sessionRef:randomUUID(),refs:[ref]},{send:async command=>{assert.equal(command.input.VersionId,ref.versionId);return {ContentLength:Buffer.byteLength(row.body),ContentType:'application/json',ChecksumSHA256:Buffer.from(row.digest,'hex').toString('base64'),ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN,VersionId:wrong?'wrong':ref.versionId,Body:Readable.from([row.body])};}});
    assert.equal(result.results[0].status,wrong?'error':'verified');
  }
});
