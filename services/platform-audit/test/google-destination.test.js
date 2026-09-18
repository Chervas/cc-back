'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { Readable } = require('node:stream');
const { fromDestination } = require('../src/google-destination-event');
const { fromDestinationList } = require('../src/google-destination-event');
const { pack, unpack, keyFor } = require('../src/event');
const { refFor, signRequest } = require('../src/reader-protocol');
function fixture(family = 'authorize', reason = 'command_admitted') {
  const actor = { userId: 9, sessionRef: randomUUID() };
  const p = { authorization_id: randomUUID(), plan_id: randomUUID(), scope_key: 'group:5', mapping_id: 11,
    input: { targets: [{ event: 'lead', sources: ['WEB'] }] }, receipt: null };
  const q = { command_id: randomUUID(), family, session_ref: actor.sessionRef };
  const captured = { connectionRef: 'google:fixture', assetRef: 'ads:1234567890', clinicIds: [59,71] };
  if (reason !== 'command_admitted') p.receipt = { state: family === 'revoke' || reason === 'authorization_withdrawn' ? 'revoked' : 'active' };
  const relatedCommandRef = ['result_recovered','authorization_withdrawn'].includes(reason) ? randomUUID() : null;
  if (relatedCommandRef) actor.sessionRef = randomUUID();
  return fromDestination(p,q,captured,actor,reason,{now:new Date('2026-09-18T22:00:00.000Z'),relatedCommandRef});
}
test('v18 preserves human attempts, confirmation, renewed-session recovery and honest unknown withdrawn outcomes', () => {
  for (const [family,reason] of [['authorize','command_admitted'],['revoke','command_admitted'],['authorize','broker_acknowledged'],
    ['status','broker_acknowledged'],['revoke','broker_acknowledged'],['authorize','result_recovered'],['revoke','result_recovered'],['authorize','authorization_withdrawn']]) {
    const value=fixture(family,reason),row=pack(value);assert.equal(unpack(row).body,row.body);
    assert(Buffer.byteLength(row.body)<4096);assert.match(keyFor(row),/^app\/platform\/v18\//);
    assert.doesNotMatch(row.body,/targets|userIdentifiers|token|patient|secret/i);
    if(reason==='authorization_withdrawn')assert.equal(value.outcome,'unknown');
    refFor({key:keyFor(row),digest:row.digest,versionId:'fictitious-v18'},'confirmed');
  }
});
test('v18 rejects invented success, foreign sessions, open envelopes and invalid phase/receipt combinations', () => {
  const value=fixture();
  for(const patch of [{token:'FICTITIOUS'},{outcome:'success'},{stage:'completed'},{reason:'constructor'},
    {sessionRef:randomUUID()},{correlationId:randomUUID()},{relatedCommandRef:randomUUID()},
    {eventCount:0},{eventCount:6},{clinicCount:1001},{authorizationRef:'invalid'},{receiptState:'applied'},
    {scope:{type:'platform',id:null}},{assetRef:'ads:0000000000'},{actor:{type:'job',id:'9'}}])assert.throws(()=>pack({...value,...patch}));
  for(const [family,reason,patch] of [['authorize','broker_acknowledged',{receiptState:'revoked'}],
    ['revoke','result_recovered',{receiptState:'active'}],['authorize','authorization_withdrawn',{outcome:'success'}],
    ['authorize','authorization_withdrawn',{relatedCommandRef:null}],['authorize','result_recovered',{family:'status'}]])assert.throws(()=>pack({...fixture(family,reason),...patch}));
});
test('signed v18 reader checks the precise S3 version, body digest and KMS object',async()=>{
  const {readBatch}=require('../src/reader'),{KEY_ARN}=require('../src/s3');
  const row=pack(fixture('authorize','authorization_withdrawn')),{privateKey}=generateKeyPairSync('ed25519');
  const ref={key:keyFor(row),digest:row.digest,versionId:'fictitious-v18'};
  assert.throws(()=>refFor({...ref,key:ref.key.replace('/v18/','/v20/')},'confirmed'));
  const input=signRequest({mode:'confirmed',actorId:'1',sessionRef:randomUUID(),refs:[ref]},
    {keyId:'fixture',privateKey:privateKey.export({type:'pkcs8',format:'pem'})}).input;
  for(const wrong of [false,true]){
    const result=await readBatch(input,{send:async command=>{
      assert.equal(command.input.VersionId,ref.versionId);
      return {ContentLength:Buffer.byteLength(row.body),ContentType:'application/json',ChecksumSHA256:Buffer.from(row.digest,'hex').toString('base64'),
        ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN,VersionId:wrong?'substituted':ref.versionId,Body:Readable.from([row.body])};
    }});assert.equal(result.results[0].status,wrong?'error':'verified');
  }
});
test('v18 list audit separates the prepared page from a permission decision and keeps rows out of the event', () => {
  const common = { actor: { userId: 9, sessionRef: randomUUID() }, captured: { connectionRef: 'google:fixture', assetRef: 'ads:1234567890', clinicIds: [59,71] },
    scopeKey: 'group:5', mappingId: 11, requestId: randomUUID(), input: { cursor: null, planId: null }, now: new Date('2026-09-18T22:45:00.000Z') };
  for (const [reason, rows] of [['list_requested', null], ['list_prepared', []], ['list_prepared', [{ authorizationId: randomUUID() }]]]) {
    const e = fromDestinationList({ ...common, reason, rows }), row = pack(e);
    assert.equal(unpack(row).body, row.body); assert.match(keyFor(row), /^app\/platform\/v18\//);
    assert.equal(e.resultCount, rows === null ? null : rows.length); assert.doesNotMatch(row.body, /authorizationId|targets|token|clickId/);
    for (const patch of [{ authorizationId: randomUUID() }, { actor: { type: 'job', id: '9' } }, { resultCount: 21 }, { resultDigest: 'raw' },
      { reason: 'broker_acknowledged' }, { capturePolicy: 'google-destinations-durable-v1' }, { scope: { type: 'platform', id: null } }]) assert.throws(() => pack({ ...e, ...patch }));
  }
});
