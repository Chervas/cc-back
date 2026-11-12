'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {randomUUID}=require('node:crypto'),C=require('../../services/metaMarketingEnrollment.contract');
function load(relative,overrides){
  const filename=path.resolve(__dirname,relative),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  const original=loaded.require.bind(loaded);loaded.require=name=>Object.hasOwn(overrides,name)?overrides[name]:original(name);
  loaded._compile(fs.readFileSync(filename,'utf8'),filename);return loaded.exports;
}
function fixture(){
  const now=()=>new Date('2030-01-01T12:00:00Z'),tx={LOCK:{UPDATE:'UPDATE'}},hash='a'.repeat(64),flowId=randomUUID(),id=randomUUID();
  const candidate={versionId:flowId,digest:hash,appId:'101',subjectId:'201',tokenType:'USER',scopes:['ads_read'],
    expiresAt:+now()+3600000,dataAccessExpiresAt:null,granularScopes:[]};
  const flow={flow_id:flowId,scope_key:'group:29',app_id:'101',scopes:JSON.stringify(candidate.scopes),state:'staged',candidate_metadata:JSON.stringify(candidate)};
  const assets=C.assets([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null},
    {assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null}]);
  const row={enrollment_id:id,flow_id:flowId,session_ref:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),
    scope_digest:hash,flow_digest:C.sourceDigest(flow),candidate_digest:hash,assignment_digest:hash,selection_digest:hash,scope_key:'group:29',actor_user_id:99,
    meta_connection_id:172,connection_ref:'meta:fixture',meta_user_id:'201',app_id:'101',clinic_ids:'[66,72]',assets:JSON.stringify(assets),mapping_ids:'[31,32]',
    session_expires_at:now(),requested_at:now(),updated_at:now(),next_attempt_at:now(),prepared_at:now(),activated_at:now(),revoked_at:null,attempts:0,last_error:null,
    lease_token:null,lease_until:null,state:'active'};
  const state={revoked:false,scopeBlocked:false,structureChanged:false,pointer:{enrollment_id:id,epoch:0,renewal_id:null,owner_receipt_digest:null,
    version_id:flowId,candidate_digest:hash,candidate_metadata:JSON.stringify(candidate),last_error:'credential_revoked'}};
  const mappings=assets.map((asset,i)=>({id:31+i,metaConnectionId:172,assetType:asset.kind,metaAssetId:asset.id,assignmentScope:'group',clinicaId:null,grupoClinicaId:29,
    isActive:true,credentials_absent:1}));
  const bindings=assets.map((asset,i)=>({mapping_id:31+i,enrollment_id:id,asset_ref:asset.assetRef,meta_connection_id:172,meta_user_id:'201',app_id:'101',
    connection_ref:row.connection_ref,scope_key:row.scope_key,tenant_clinic_id:66,parent_page_id:null,state:'active'}));
  const connection={id:172,metaUserId:'201',broker_app_id:'101',userId:null,credentials_external:1,credentials_absent:1};
  const models={sequelize:{transaction:async(_options,work)=>work(tx)},
    MetaMarketingEnrollmentRequest:{findByPk:async()=>row},MetaMarketingOAuthRequest:{findByPk:async()=>flow},
    MetaMarketingEffectiveCredential:{findByPk:async()=>state.pointer},
    MetaMarketingEnrollmentClaim:{findAll:async()=>assets.map(asset=>({asset_ref:asset.assetRef,enrollment_id:id}))},
    MetaMarketingBrokerBinding:{findAll:async({where})=>where.mapping_id?bindings.filter(v=>v.mapping_id===where.mapping_id)
      :typeof where.asset_ref==='string'?bindings.filter(v=>v.asset_ref===where.asset_ref):bindings},
    ClinicMetaAsset:{findAll:async({where})=>where.assetType?mappings.filter(v=>v.assetType===where.assetType):mappings,findByPk:async n=>mappings.find(v=>v.id===n)},
    MetaMarketingBrokerRevocation:{findOne:async()=>state.revoked?{tuple_hash:hash}:null,findAll:async()=>state.revoked?[{tuple_hash:hash}]:[]},
    Clinica:{findAll:async()=>[{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:29}]},
    MetaConnectionAssignment:{findAll:async()=>[{scopeKey:'group:29',assignmentScope:'group',clinicaId:null,grupoClinicaId:29,metaConnectionId:172,status:'active'}]},
    GroupAssetClinicAssignment:{findAll:async()=>[]},GrupoClinica:{findAll:async()=>[]}};
  const business={createSource:()=>({forEnrollment:async()=>null})};
  const effective=load('../../services/metaMarketingEffectiveCredential.service.js',{'./metaMarketingBusinessSource.service':business});
  const canonical={resolveUserIdentity:async()=>({connection,provenanceDigest:'canonical-identity'})};
  const scopeBlock={blocked:async()=>state.scopeBlocked};
  const createBindings=load('../../services/metaMarketingEnrollmentBinding.service.js',{
    './metaMarketingOAuthScope.service':{createScope:()=>({revalidateStructure:async()=>{if(state.structureChanged)throw Object.assign(Error('changed'),{code:'meta_oauth_scope_changed'});}})},
    './metaMarketingBusinessSource.service':business,'./metaMarketingEffectiveCredential.service':effective,'./metaScopeBlock.service':scopeBlock,
    './metaMarketingCanonicalIdentity.service':canonical,'./metaMarketingLegacyRecovery.service':{createRecovery:()=>({assertActive:async()=>null})},
    './platformAudit.repository':{createRepository:()=>({})},
  }).createBindings;
  const module=load('../../services/metaMarketingBrokerScope.service.js',{'./metaMarketingEnrollmentBinding.service':{createBindings:options=>createBindings({...options,now})},
    './metaMarketingCanonicalIdentity.service':canonical,'./metaScopeBlock.service':scopeBlock});
  const ingress=module.createMetaMarketingBrokerScope({...module.createMetaMarketingLeadIngressScopeRepository(()=>models),enabled:()=>true});
  const reader=module.createMetaMarketingBrokerScope({...module.createMetaMarketingScopeRepository(()=>models),enabled:()=>true});
  function rotate(){
    const versionId=randomUUID(),next={...candidate,versionId,digest:'b'.repeat(64)};
    const metadata=Object.fromEntries(Object.entries(next).filter(([key])=>!['versionId','digest'].includes(key)));
    const receipt={status:'active',activationApplied:true,renewalId:versionId,enrollmentId:id,
      effectiveCredential:{epoch:1,versionId,digest:next.digest,metadata}};
    const renewal={renewal_id:versionId,state:'active',enrollment_id:id,scope_key:row.scope_key,app_id:row.app_id,
      meta_user_id:row.meta_user_id,clinic_ids:row.clinic_ids,assets:row.assets,expected_epoch:0,
      candidate_metadata:JSON.stringify(next),owner_receipt:JSON.stringify(receipt)};
    models.MetaMarketingCredentialRenewal={findByPk:async()=>renewal};
    state.pointer={enrollment_id:id,epoch:1,renewal_id:versionId,version_id:versionId,candidate_digest:next.digest,
      candidate_metadata:JSON.stringify(next),owner_receipt_digest:C.hash(renewal.owner_receipt),last_error:null};
  }
  return {state,candidate,flow,row,bindings,mappings,models,ingress,reader,tx,createBindings:options=>createBindings({...options,now}),rotate};
}
test('signed-ingress metadata remains usable for a revoked or expired USER reader while ordinary readers stay blocked',async()=>{
  const f=fixture();await assert.rejects(f.reader.prepare(31),{code:'meta_credential_renewal_required'});
  const context=await f.ingress.prepare(31),before=await f.ingress.assertContext(context);
  assert.equal(before.credentialEpoch,0);assert.equal(before.credentialVersionId,null);
  f.state.pointer.last_error=null;const candidate={...f.candidate,expiresAt:+new Date('2030-01-01T12:00:00Z')-1};
  f.flow.candidate_metadata=JSON.stringify(candidate);f.row.flow_digest=C.sourceDigest(f.flow);f.state.pointer.candidate_metadata=f.flow.candidate_metadata;
  await assert.rejects(f.reader.prepare(31),{code:'meta_credential_renewal_required'});
  assert.equal((await f.ingress.prepare(31)) instanceof Object,true);
});
test('ingress retains explicit asset, binding, enrollment, structural and scope withdrawals despite unavailable reader credentials',async()=>{
  for(const change of [f=>f.state.revoked=true,f=>f.bindings[0].state='blocked',f=>f.row.state='revoked',f=>f.state.structureChanged=true,f=>f.state.scopeBlocked=true]){
    const f=fixture(),context=await f.ingress.prepare(31);change(f);await assert.rejects(f.ingress.assertContext(context));
  }
});
test('ingress has stable grant context across effective credential epochs without exposing an HTTP bypass',async()=>{
  const f=fixture(),bindings=f.createBindings({models:f.models}),before=await bindings.committedForLeadIngress(f.row.enrollment_id,f.tx);
  assert.equal(before.credential,null);assert.equal(typeof before.digest,'string');
  const ingressContext=await f.ingress.prepare(31);f.state.pointer.last_error=null;
  const readerContext=await f.reader.prepare(31);f.rotate();
  assert.equal((await f.ingress.assertContext(ingressContext)).enrollmentHash,before.digest);
  await assert.rejects(f.reader.assertContext(readerContext),{code:'meta_broker_scope_changed'});
  // Ignore an unrecognized option supplied to the ordinary repository. Only
  // the separate server-only factory can select the ingress inspection.
  const module=require('../../services/metaMarketingBrokerScope.service');
  const repository=module.createMetaMarketingScopeRepository(()=>({sequelize:{transaction:async()=>{throw Error('ordinary-reader-only');}}}),{leadIngress:true});
  await assert.rejects(repository.inspectEnrollment(f.row.enrollment_id),/ordinary-reader-only/);
});
