'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const C=require('../../services/metaMarketingEnrollment.contract'),G=require('../../services/metaMarketingLegacyRecovery.service');
const {resolveUserIdentity}=require('../../services/metaMarketingCanonicalIdentity.service');
function fixture(){
  const at=new Date('2030-01-01T00:00:00Z'),flowId=randomUUID(),enrollmentId=randomUUID(),scopes=['ads_read','pages_show_list','public_profile'];
  const rows=[{id:158,userId:1,metaUserId:'201',broker_app_id:null,credentials_external:0,credentials_absent:0},
    {id:159,userId:null,metaUserId:'201',broker_app_id:'101',credentials_external:1,credentials_absent:1}];
  const owner={meta_user_id:'201',app_id:'101',meta_connection_id:159};
  const alias={id:359,metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_301',assignmentScope:'group',clinicaId:null,grupoClinicaId:28,
    isActive:1,whatsappAuthorizationId:null,page_credential_present:0,page_credential_sha256:null,wa_credential_present:0,wa_credential_sha256:null,
    additional_data_present:0,additional_data_sha256:null};
  const snapshot=G.validateSnapshot({version:2,scopeKey:'group:28',clinicIds:[1],sourceConnectionId:158,canonicalConnectionId:159,
    appId:'101',subjectId:'201',actorId:1,mappingIds:[359],newPageCount:0,cleanup:[],inventory:{clinics:[{id_clinica:1,grupoClinicaId:28}],
      blocks:[],assignments:[],groups:[],shares:[],connections:rows.map(row=>({id:row.id,userId:row.userId,metaUserId:row.metaUserId,broker_app_id:row.broker_app_id,
        credentials_external:row.credentials_external,credential_present:row.id===158?1:0,credential_sha256:row.id===158?'a'.repeat(64):null})),aliases:[alias]}});
  const candidate={versionId:flowId,digest:C.hash('FICTITIOUS_CANDIDATE'),appId:'101',subjectId:'201',tokenType:'USER',scopes,
    expiresAt:+at+3600000,dataAccessExpiresAt:null,granularScopes:[]};
  const flow={flow_id:flowId,scope_key:'group:28',connection_ref:'connection:fixture-28',asset_ref:'meta-enroll:group:28',app_id:'101',clinic_ids:'[1]',
    scopes:JSON.stringify(scopes),redirect_uri:'https://app.example.invalid/oauth/meta/marketing/callback',slot_digest:C.hash('SLOT'),scope_digest:C.hash('SCOPE'),
    actor_user_id:1,session_ref:randomUUID(),session_expires_at:new Date(+at+7200000),state_hash:C.hash('STATE'),candidate_metadata:JSON.stringify(candidate),state:'staged',completed_at:at};
  const selected=C.assets([{kind:'ad_account',id:'301',assetRef:'meta-ad_account:301',parentPageId:null}]);
  const origin={enrollment_id:enrollmentId,flow_id:flowId,scope_key:flow.scope_key,clinic_ids:flow.clinic_ids,connection_ref:flow.connection_ref,
    scope_digest:flow.scope_digest,flow_digest:C.sourceDigest(flow),candidate_digest:candidate.digest,meta_user_id:'201',app_id:'101',meta_connection_id:159,
    assignment_digest:C.hash('ASSIGNMENT'),assets:JSON.stringify(selected),mapping_ids:'[359]',actor_user_id:1,session_ref:flow.session_ref,
    session_expires_at:flow.session_expires_at,prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),
    selection_digest:C.hash('SELECTION'),state:'active',requested_at:at,updated_at:at,next_attempt_at:at,prepared_at:at,activated_at:at,revoked_at:null,
    attempts:0,lease_token:null,lease_until:null,last_error:null};
  const recovery={recovery_id:randomUUID(),scope_key:flow.scope_key,clinic_ids:flow.clinic_ids,app_id:'101',meta_user_id:'201',source_connection_id:158,
    canonical_connection_id:null,mapping_ids:'[359]',snapshot:G.encode(snapshot),snapshot_digest:G.hash(G.encode(snapshot)),prepared_by_user_id:1,
    prepared_at:at,expires_at:new Date(+at+3600000),state:'active',flow_id:flowId,candidate_digest:candidate.digest,enrollment_id:enrollmentId,
    bound_at:at,activated_at:at,retired_at:null};
  const calls=[],tx={LOCK:{UPDATE:'UPDATE'}};
  const read=(name,result)=>(options)=>{calls.push({name,options});return result;};
  const byPk=(name,result)=>(_id,options)=>{calls.push({name,options});return result;};
  const models={MetaConnection:{findAll:read('connections',rows)},MetaMarketingEnrollmentIdentity:{findByPk:byPk('owner',owner)},
    MetaMarketingRecovery:{findAll:read('history',[recovery])},MetaMarketingEnrollmentRequest:{findByPk:byPk('origin',origin)},
    MetaMarketingOAuthRequest:{findByPk:byPk('flow',flow)}};
  const run=(extra={})=>resolveUserIdentity({models,appId:'101',subjectId:'201',expectedConnectionId:159,transaction:tx,
    lock:true,requireRegistered:true,allowHistoricalReuse:true,...extra});
  return {rows,owner,flow,origin,recovery,models,calls,tx,run};
}
test('actual resolver selects only canonical with registered exact V2 lineage and no foreign locks/credential hydration',async()=>{
  const f=fixture(),selected=await f.run();assert.equal(selected.connection.id,159);assert.match(selected.provenanceDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.map(c=>c.name),['connections','owner','history','origin','flow']);
  for(const call of f.calls){assert.equal(call.options.transaction,f.tx);assert.equal(call.options.lock,['connections','owner'].includes(call.name)?'UPDATE':undefined);}
  assert.equal(f.calls[0].options.limit,3);assert.equal(f.calls[2].options.limit,1);
  assert(!f.calls[0].options.attributes.some(a=>typeof a==='string'&&/token|credential_sha/i.test(a)));
  assert.deepEqual(Object.keys(selected).sort(),['connection','owner','provenanceDigest']);
});
test('durable digest survives origin withdrawal/cancel/supersession, expiry, errors and mutable timestamps',async()=>{
  const f=fixture(),before=(await f.run()).provenanceDigest;
  for(const state of ['active','revoke_pending','revoked','superseded'])for(const flowState of ['staged','cancel_pending','cancelled']){
    f.origin.state=state;f.origin.revoked_at=state==='revoked'?new Date('2040-01-01'):null;f.origin.updated_at=new Date('2040-01-01');
    f.origin.last_error='broker_timeout';f.origin.attempts++;f.flow.state=flowState;f.flow.completed_at=new Date('2040-01-01');
    f.recovery.state=state==='active'?'active':'retired';f.recovery.retired_at=state==='active'?null:new Date('2040-01-01');
    assert.equal((await f.run()).provenanceDigest,before,state+'/'+flowState);
  }
});
test('unproved duplicates, wrong registry/shape and invalid historical lineage stay closed',async t=>{
  const cases=[f=>f.rows.push({...f.rows[1],id:160}),f=>f.owner.app_id='999',f=>f.owner.meta_connection_id=158,
    f=>f.rows[0].credentials_absent=1,f=>f.rows[1].userId=1,f=>f.rows[1].credentials_absent=0,f=>f.rows[0].metaUserId='999',f=>f.rows[0].broker_app_id='101',
    f=>f.models.MetaMarketingEnrollmentIdentity.findByPk=async()=>null,f=>f.models.MetaMarketingRecovery.findAll=async()=>[],
    f=>f.recovery.snapshot+=' ',f=>f.recovery.activated_at=null,f=>f.recovery.state='flow_bound',f=>f.origin.activated_at=null,
    f=>f.origin.mapping_ids='[]',f=>f.origin.mapping_ids='[360]',f=>f.origin.state='activate_pending',f=>f.origin.flow_digest='b'.repeat(64),
    f=>f.flow.state='processing',f=>f.flow.state='begin_pending',f=>f.flow.actor_user_id=2,f=>f.recovery.candidate_digest='b'.repeat(64),
    f=>f.origin.meta_connection_id=158,f=>f.origin.assets=JSON.stringify(C.assets([{kind:'ad_account',id:'999',assetRef:'meta-ad_account:999',parentPageId:null}]))];
  for(let i=0;i<cases.length;i++)await t.test(String(i),async()=>{const f=fixture();cases[i](f);await assert.rejects(f.run(),{code:'meta_enrollment_identity_review'});});
});
test('uncertain history reads propagate unchanged, and read-only review has no locking options',async()=>{
  const f=fixture(),unavailable=Object.assign(Error('FICTITIOUS_STORAGE_TIMEOUT'),{code:'ETIMEDOUT'});
  f.models.MetaMarketingRecovery.findAll=async()=>{throw unavailable;};await assert.rejects(f.run(),error=>error===unavailable);
  const r=fixture();await r.run({lock:false});assert(r.calls.every(call=>call.options.lock===undefined));
});
test('single clean external identity retains ordinary behavior without requiring legacy provenance',async()=>{
  const f=fixture();f.rows.splice(0,1);f.rows[0].userId=1;
  const result=await f.run();assert.equal(result.connection.id,159);assert.equal(result.provenanceDigest,null);
  assert.deepEqual(f.calls.map(c=>c.name),['connections','owner']);
  f.models.MetaMarketingEnrollmentIdentity.findByPk=async()=>null;assert.equal((await f.run({requireRegistered:false})).connection.id,159);
  await assert.rejects(f.run(),{code:'meta_enrollment_identity_review'});
});

test('a different valid historical witness for the same tuple preserves pending/active identity digest',async()=>{
  const f=fixture(),before=(await f.run()).provenanceDigest;
  f.recovery.recovery_id=randomUUID();f.recovery.enrollment_id=randomUUID();f.origin.enrollment_id=f.recovery.enrollment_id;
  f.recovery.flow_id=randomUUID();f.flow.flow_id=f.recovery.flow_id;f.origin.flow_id=f.recovery.flow_id;
  const metadata=JSON.parse(f.flow.candidate_metadata);metadata.versionId=f.flow.flow_id;metadata.digest=C.hash('ANOTHER_VALID_CANDIDATE');
  f.flow.candidate_metadata=JSON.stringify(metadata);f.origin.candidate_digest=metadata.digest;f.recovery.candidate_digest=metadata.digest;
  f.origin.flow_digest=C.sourceDigest(f.flow);f.origin.selection_digest=C.hash('ANOTHER_VALID_SELECTION');
  assert.equal((await f.run()).provenanceDigest,before);
});
test('unowned or finished transactions cannot observe multi-table provenance',async()=>{
  for(const transaction of [null,{finished:'commit'},{}]){
    const f=fixture();await assert.rejects(f.run({transaction}),{code:'meta_enrollment_unavailable'});assert.equal(f.calls.length,0);
  }
});
