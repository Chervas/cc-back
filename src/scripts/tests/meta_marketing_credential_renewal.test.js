'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const C=require('../../services/metaMarketingCredentialRenewal.contract'),F=require('../../services/metaMarketingEffectiveCredential.service');
function fixture(){
  const epochZero=randomUUID(),renewalId=randomUUID(),enrollmentId=randomUUID(),at=new Date('2030-01-01T12:00:00Z');
  const metadata={appId:'101',subjectId:'201',tokenType:'USER',scopes:['ads_read','public_profile'],expiresAt:+at+60000,dataAccessExpiresAt:null,granularScopes:[]};
  const initial={versionId:epochZero,digest:'a'.repeat(64),...metadata};
  const grant={enrollment_id:enrollmentId,state:'active',flow_id:epochZero,candidate_digest:initial.digest,app_id:'101',meta_user_id:'201',scope_key:'group:29',clinic_ids:'[66,72]',
    meta_connection_id:172,actor_user_id:1,assets:JSON.stringify(C.assets([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null}])),activated_at:at};
  const flow={flow_id:epochZero,app_id:'101',scopes:JSON.stringify(metadata.scopes),candidate_metadata:JSON.stringify(initial)};
  const row={renewal_id:renewalId,enrollment_id:enrollmentId,expected_epoch:0,expected_version_id:epochZero,expected_candidate_digest:initial.digest,
    app_id:'101',meta_user_id:'201',scope_key:'group:29',clinic_ids:'[66,72]',assets:grant.assets,asset_set_digest:F.assetSetDigest(JSON.parse(grant.assets)),grant_digest:null,scopeValues:metadata.scopes};
  const candidate={versionId:renewalId,digest:'b'.repeat(64),metadata:{...metadata,expiresAt:+at+3600000}};
  const receipt={renewalId,flowId:renewalId,enrollmentId,status:'active',grantDigest:'c'.repeat(64),assetSetDigest:row.asset_set_digest,
    effectiveCredential:{epoch:1,...candidate},candidate,activationApplied:true};
  const renewal={...row,state:'active',candidate_metadata:JSON.stringify({versionId:candidate.versionId,digest:candidate.digest,...candidate.metadata}),owner_receipt:JSON.stringify(receipt)};
  const pointer={enrollment_id:enrollmentId,renewal_id:renewalId,epoch:1,version_id:renewalId,candidate_digest:candidate.digest,
    candidate_metadata:renewal.candidate_metadata,owner_receipt_digest:C.hash(renewal.owner_receipt),activated_at:new Date(+at+1000),last_error:null,last_error_at:null};
  const state={pointer:null,renewal};
  const models={MetaMarketingEffectiveCredential:{findByPk:async()=>state.pointer},MetaMarketingCredentialRenewal:{findByPk:async()=>state.renewal},MetaMarketingOAuthRequest:{findByPk:async()=>flow}};
  return {grant,flow,row,receipt,pointer,state,at,api:F.createEffectiveCredentials({models,now:()=>at})};
}
test('epoch zero keeps the original grant, epoch one requires the exact confirmed owner receipt and metadata',async()=>{
  const f=fixture();assert.equal((await f.api.resolve(f.grant,f.flow)).epoch,0);f.state.pointer=f.pointer;
  const renewed=await f.api.resolve(f.grant,f.flow);assert.equal(renewed.epoch,1);assert.equal(renewed.versionId,f.row.renewal_id);assert.equal(f.grant.candidate_digest,'a'.repeat(64));
  const health=await f.api.getCredentialStatus(f.grant);assert.equal(health.currentMetadata.health,'healthy');assert.equal(health.observedAt,f.pointer.activated_at.toISOString());
  f.pointer.owner_receipt_digest='d'.repeat(64);await assert.rejects(f.api.resolve(f.grant,f.flow),{code:'meta_credential_version_invalid'});
});
test('expiry permits structural renewal admission only, while retired or revoked grant states stay forbidden',async()=>{
  const f=fixture();const candidate=JSON.parse(f.flow.candidate_metadata);candidate.expiresAt=+f.at-1;f.flow.candidate_metadata=JSON.stringify(candidate);
  await assert.rejects(f.api.resolve(f.grant,f.flow),{code:'meta_credential_renewal_required'});
  assert.equal((await f.api.resolve(f.grant,f.flow,null,{allowExpired:true})).expired,true);
  for(const state of ['revoked','revoke_pending']){f.grant.state=state;await assert.rejects(f.api.resolve(f.grant,f.flow,null,{allowExpired:true}),{code:'meta_credential_version_invalid'});}
});
test('receipt CAS rejects wrong epoch, enrollment, identity, asset set or candidate and never treats abort as activation',()=>{
  const f=fixture();assert.equal(C.receipt(f.receipt,f.row).activationApplied,true);
  for(const mutate of [v=>v.effectiveCredential.epoch=2,v=>v.enrollmentId=randomUUID(),v=>v.assetSetDigest='e'.repeat(64),
    v=>v.candidate.metadata.subjectId='999',v=>v.activationApplied=false,v=>v.candidate.versionId=randomUUID()]){
    const value=structuredClone(f.receipt);mutate(value);assert.throws(()=>C.receipt(value,f.row));
  }
  const aborted={...f.receipt,status:'aborted',candidate:null,activationApplied:false,effectiveCredential:{epoch:0,versionId:f.row.expected_version_id,digest:f.row.expected_candidate_digest,metadata:F.split(JSON.parse(f.flow.candidate_metadata))}};
  assert.equal(C.receipt(aborted,f.row).activationApplied,false);
});
test('a verified clinic owner or agency can authorize its entire group without global administrator rights',async()=>{
  const {Op}=require('sequelize'),{createScope}=require('../../services/metaMarketingOAuthScope.service');
  let permitted=[66,72],verified=0;
  const models={Clinica:{findAll:async options=>{assert.deepEqual(options.where,{grupoClinicaId:29});return [{id_clinica:66},{id_clinica:72}];}},
    UsuarioClinica:{findAll:async options=>{assert.equal(options.where.id_usuario,99);assert.deepEqual(options.where.rol_clinica[Op.in],['propietario','agencia']);return permitted.map(id_clinica=>({id_clinica}));}}};
  const sessions={verifyReference:async(input,options)=>{assert.equal(input.userId,99);assert.equal(options.requireEmail,true);verified++;}};
  const scope=createScope({models,sessions,recoveryGuard:{}}),transaction={LOCK:{UPDATE:'UPDATE'}};
  const input={scopeKey:'group:29',actorId:99,sessionRef:randomUUID(),sessionExpiresAt:new Date(Date.now()+60000)};
  assert.deepEqual((await scope.authorize(input,transaction)).clinicIds,[66,72]);
  permitted=[66];await assert.rejects(scope.authorize(input,transaction),{code:'meta_oauth_scope_forbidden'});assert.equal(verified,2);
});
test('secret version contention remains a typed temporary reader result',async()=>{
  const error=Object.assign(Error('secret_version_changed'),{code:'secret_version_changed'});
  assert(F.TEMPORARY.has(error.code));
  assert.equal(require('../../services/metaMarketingAdsReader.service').safeError(error).code,error.code);
  const reader=require('../../services/metaMarketingBrokerReader.service').createMetaMarketingBrokerReader({
    client:{execute:async()=>{throw error;}},assertContext:async()=>({})});
  await assert.rejects(reader.read({},require('../../../services/integrations-broker/src/meta-marketing-contract').ASSET,{authorize:async()=>{}}),{code:error.code});
});
test('the actual maintenance transport preserves only bounded closed429 cooldown hints',async()=>{
  const H=require('node:https'),{EventEmitter}=require('node:events'),{generateKeyPairSync}=require('node:crypto');
  const {createIntegrationsBrokerClient,metaMaintenanceCooldownError}=require('../../lib/integrationsBrokerClient');
  const original=H.request;let body={error:{code:'rate_limited',retryAfterMs:7200000}};
  H.request=(_url,_options,callback)=>{const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=429;response.headers={};callback(response);response.emit('data',Buffer.from(JSON.stringify(body)));response.emit('end');});return request;};
  try{
    const pair=generateKeyPairSync('ed25519'),client=createIntegrationsBrokerClient({origin:'https://broker.example.invalid',keyId:'fixture',privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),audience:'fixture',ca:'FICTITIOUS_CA',transportProfile:'meta-marketing'});
    const command={operation:'meta.marketing.credential.maintenance.rotate.v1',connectionRef:'fixture',assetRef:'meta-enroll:group:29',tenantRef:'clinic:66',payload:{}};
    await assert.rejects(client.execute(command),error=>error.code==='rate_limited'&&error.retryAfterMs===7200000);
    await assert.rejects(client.execute({...command,operation:'meta.marketing.credential.maintenance.health.v1'}),error=>error.code==='rate_limited'&&error.retryAfterMs===7200000);
    await assert.rejects(client.execute({...command,operation:'meta.marketing.asset.read.v1'}),error=>error.code==='rate_limited'&&error.retryAfterMs===undefined);
    body={error:{code:'rate_limited'}};await assert.rejects(client.execute(command),error=>error.code==='rate_limited'&&error.retryAfterMs===undefined);
  }finally{H.request=original;}
  for(const value of[0,-1,'1',86400001,null,Infinity])assert.throws(()=>metaMaintenanceCooldownError({error:{code:'rate_limited',retryAfterMs:value}},429),/broker_response_invalid/);
  assert.throws(()=>metaMaintenanceCooldownError({error:{code:'rate_limited',retryAfterMs:10,raw:'FICTITIOUS_PRIVATE'}},429),/broker_response_invalid/);
});
