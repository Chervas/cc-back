'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');const {Readable}=require('node:stream');
const {fromReceiptReview}=require('../src/google-receipt-review-event');const {pack,unpack,keyFor}=require('../src/event');
const {refFor}=require('../src/reader-protocol');
const make=(family='list',reason='list_requested',result=null)=>fromReceiptReview({
  actor:{userId:9,sessionRef:randomUUID()},captured:{id:11,connectionRef:'google:fixture',assetRef:'ads:1234567890',clinicIds:[59,71]},
  scopeKey:'group:5',requestId:randomUUID(),family,input:family==='list'?{cursor:null}:{submissionId:randomUUID()},reason,result,now:new Date('2026-09-18T23:50:00.000Z')});
test('v19 bounded human list/check audit records intent and results without receipt or patient bodies',()=>{
  for(const [family,reason,result] of [['list','list_requested',null],['list','list_prepared',{items:[]}],['check','check_requested',null],
    ['check','receipt_checked',{item:{state:'accepted'}}],['check','receipt_checked',{item:{state:'succeeded'}}],
    ['check','receipt_already_terminal',{item:{state:'failed'}}],['check','receipt_not_dispatched',{item:{state:'prepared'}}]]){
    const e=make(family,reason,result),r=pack(e);assert.deepEqual(unpack(r).event,e);assert.match(keyFor(r),/^app\/platform\/v19\//);
    refFor({key:keyFor(r),digest:r.digest,versionId:'test'},'confirmed');assert(Buffer.byteLength(r.body)<2000);
    assert.doesNotMatch(r.body,/providerRequestId|requestStatusPerDestination|userIdentifiers|clickId|token|patient/);
  }
});
test('v19 rejects open payload, wrong actor/scope/version, arrays as digests and invented success',()=>{
  const e=make();for(const patch of [{payload:{}},{actor:{type:'job',id:'9'}},{scope:{type:'platform',id:null}},
    {version:20},{outcome:'success'},{resultCount:0},{clinicSetDigest:['a'.repeat(64)]},{criteriaDigest:['a'.repeat(64)]},
    {submissionRef:randomUUID()},{family:'status'},{assetRef:'ads:0000000000'},{mappingId:11},{clinicCount:1001}])assert.throws(()=>pack({...e,...patch}));
  const done=make('check','receipt_checked',{item:{state:'succeeded'}});
  for(const patch of [{reason:'receipt_not_dispatched'},{resultState:'unknown'},{resultCount:0},{resultDigest:['a'.repeat(64)]},
    {submissionRef:null},{outcome:'unknown'},{stage:'attempted'}])assert.throws(()=>pack({...done,...patch}));
});
test('v19 reader verifies exact S3 version/digest/KMS and rejects future refs',async()=>{
  const row=pack(make('check','receipt_checked',{item:{state:'partial_success'}}));const {KEY_ARN}=require('../src/s3');
  const ref={key:keyFor(row),digest:row.digest,versionId:'test19'};assert.throws(()=>refFor({...ref,key:ref.key.replace('/v19/','/v23/')},'confirmed'));
  for(const wrong of [false,true]){
    const result=await require('../src/reader').readBatch({version:1,audience:'clinicaclick-audit-reader-v1',requestId:randomUUID(),nonce:randomUUID(),issuedAt:Date.now(),mode:'confirmed',actorId:'1',sessionRef:randomUUID(),refs:[ref]},{send:async command=>{
      assert.equal(command.input.VersionId,ref.versionId);return {ContentLength:Buffer.byteLength(row.body),ContentType:'application/json',
        ChecksumSHA256:Buffer.from(row.digest,'hex').toString('base64'),ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN,
        VersionId:wrong?'wrong':ref.versionId,Body:Readable.from([row.body])};}});
    assert.equal(result.results[0].status,wrong?'error':'verified');
  }
});
