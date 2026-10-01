'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../../services/whatsappPhoneDisconnect.service');
const { validate } = require('../whatsapp_disconnect_control');
const { deriveHealthCandidate, deriveAssetSignal } = require('../../lib/whatsapp-account-health');
const actor = { userId:44,sessionRef:'a1234567-1234-4234-8234-123456789abc',sessionExpiresAt:1791000000 };
function fixture({ group=false, memberships=[123,124], denied=false, failed=false }={}) {
  const calls=[],writes=[];
  const asset={id:456,assetType:'whatsapp_phone_number',assignmentScope:group?'group':'clinic',
    clinicaId:group?null:123,grupoClinicaId:group?42:null,phoneNumberId:'401',wabaId:'501',whatsappAuthorizationId:null,
    isActive:true,additionalData:{routing:{role:'secondary'},payment:{status:'active'}},
    async update(values){writes.push(values);Object.assign(this,structuredClone(values));}};
  const binding = clinicId => ({clinicId,assetId:456,connectionRef:'wa:qa:123',authorizationId:'b1234567-1234-4234-8234-123456789abc',phoneId:'401',wabaId:'501',sendEnabled:true});
  const service = createService({models:{sequelize:{transaction:async work=>work({LOCK:{UPDATE:'update'}})},
    ClinicMetaAsset:{findByPk:async id=>{assert.equal(id,456);return asset;}},
    Clinica:{findAll:async ()=> (group?[123,124]:[123]).map(id=>({id_clinica:id}))},
    UsuarioClinica:{findAll:async ()=>memberships.map(id=>({id_clinica:id}))}},
    sessions:{verifyReference:async()=>{if(denied)throw Object.assign(Error('denied'),{httpStatus:403});}},
    broker:{binding:async id=>binding(id)},
    control:{available:()=>true,execute:async command=>{calls.push(structuredClone(command));if(failed)throw Error('unknown');return {requestId:command.requestId,data:{revoked:true},replayed:false};}},
    now:()=>new Date('2026-10-01T15:00:00Z')});
  return {service,asset,calls,writes,binding};
}
test('preview and cancellation perform no local mutation or broker operation',async()=>{
  const f=fixture();const preview=await f.service.preview({assetId:456,clinicId:123},actor);
  assert.equal(preview.clinicCount,1);assert.equal(preview.scope.type,'clinic');assert.match(preview.scopeToken,/^[a-f0-9]{64}$/);
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
});
test('disconnect revokes only the exact phone tuple and retains scope, WABA, history and routing',async()=>{
  const f=fixture();const p=await f.service.preview({assetId:456,clinicId:123},actor);
  const result=await f.service.disconnect({assetId:456,clinicId:123,scopeToken:p.scopeToken},actor);
  assert.equal(result.state,'disconnected');assert.equal(f.calls.length,1);
  assert.deepEqual(validate(f.calls[0]),f.calls[0]);assert.equal(f.calls[0].assetRef,'wa-phone:401');
  assert.equal(f.asset.assignmentScope,'clinic');assert.equal(f.asset.clinicaId,123);assert.equal(f.asset.isActive,true);
  assert.deepEqual(f.asset.additionalData.routing,{role:'secondary'});assert.deepEqual(f.asset.additionalData.payment,{status:'active'});
  const again=await f.service.disconnect({assetId:456,clinicId:123,scopeToken:p.scopeToken},actor);
  assert.equal(again.state,'disconnected');assert.equal(f.calls.length,1);
  assert.equal(deriveHealthCandidate(deriveAssetSignal(f.asset)).reason_code,'clinicaclick_manual_disconnect');
});
test('unknown outcomes retain a local stop and reuse the same durable request ID',async()=>{
  const f=fixture({failed:true});const p=await f.service.preview({assetId:456,clinicId:123},actor);
  for(let i=0;i<2;i++)assert.equal((await f.service.disconnect({assetId:456,clinicId:123,scopeToken:p.scopeToken},actor)).state,'pending');
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].requestId,f.calls[1].requestId);
  assert.equal(deriveHealthCandidate(deriveAssetSignal(f.asset,{providerStatus:'CONNECTED'})).can_send,false);
});
test('group revocation checks all members and never changes another phone',async()=>{
  const f=fixture({group:true});const p=await f.service.preview({assetId:456,clinicId:123},actor);
  assert.equal(p.clinicCount,2);await f.service.disconnect({assetId:456,clinicId:123,scopeToken:p.scopeToken},actor);
  assert.deepEqual(f.calls.map(c=>c.tenantRef),['clinic:123','clinic:124']);assert.equal(new Set(f.calls.map(c=>c.assetRef)).size,1);
  const denied=fixture({group:true,memberships:[123]});
  await assert.rejects(denied.service.preview({assetId:456,clinicId:123},{...actor,userId:77}),{code:'whatsapp_authorization_forbidden'});
  assert.equal(denied.writes.length,0);assert.equal(denied.calls.length,0);
});
test('wrong clinic, changed confirmation and expired session cannot write or revoke',async()=>{
  const f=fixture();await assert.rejects(f.service.preview({assetId:456,clinicId:999},actor),{httpStatus:403});
  await assert.rejects(f.service.disconnect({assetId:456,clinicId:123,scopeToken:'stale'},actor),{httpStatus:409});
  const denied=fixture({denied:true});await assert.rejects(denied.service.preview({assetId:456,clinicId:123},actor));
  assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);assert.equal(denied.calls.length,0);
});

test('a corrupted stored receipt cannot revoke a different tenant',async()=>{
  const f=fixture({failed:true});const p=await f.service.preview({assetId:456,clinicId:123},actor);
  await f.service.disconnect({assetId:456,clinicId:123,scopeToken:p.scopeToken},actor);
  f.asset.additionalData.whatsappManualDisconnect.receipts[0].clinicId=999;
  await assert.rejects(f.service.disconnect({assetId:456,clinicId:123,scopeToken:p.scopeToken},actor),{httpStatus:409});
  assert.equal(f.calls.length,1);
});
test('the privileged control helper refuses sends, arbitrary commands and extra fields',()=>{
  const c={requestId:actor.sessionRef,tenantRef:'clinic:123',connectionRef:'wa:qa:123',assetRef:'wa-phone:401',operation:'meta.whatsapp.authorized.phone.revoke.v1',payload:{}};
  assert.deepEqual(validate(c),c);
  for(const bad of [{...c,operation:'meta.whatsapp.authorized.send.v1'},{...c,assetRef:'page:401'},
    {...c,payload:{token:'fictitious'}},{...c,command:'sh'},{...c,connectionRef:'x; sh'}])assert.throws(()=>validate(bad));
});
test('CONNECTED profile observations cannot clear an unsettled 131042 payment rejection',()=>{
  const asset={isActive:true,additionalData:{payment:{status:'missing_payment_method',last_error_code:131042,
    last_detected_at:'2026-10-01T13:31:18Z',last_success_at:'2026-10-01T12:39:24Z'}}};
  assert.equal(deriveHealthCandidate(deriveAssetSignal(asset,{providerStatus:'CONNECTED'})).reason_code,'meta_error_131042_payment_missing');
  asset.additionalData.payment.last_success_at='2026-10-01T15:30:00Z';
  assert.equal(deriveHealthCandidate(deriveAssetSignal(asset,{providerStatus:'CONNECTED'})).can_send,true);
});
