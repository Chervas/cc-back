'use strict';
// Read-only observation. This is NOT a reservation or authority for a writer.
const {Op,literal}=require('sequelize');
const C=require('./metaMarketingOAuth.contract');
const D=require('../../services/integrations-broker/src/meta-marketing-discovery-contract');
const REASONS=Object.freeze(['identity_review','scope_assignment_review','scope_blocked','asset_assigned','asset_registered','asset_revoked','recovery_not_selected']);
const fail=()=>C.fail('meta_oauth_unavailable');
function createReview({models,sessions,now=()=>new Date(),recoveryGuard}) {
  const recovery=recoveryGuard||require('./metaMarketingLegacyRecovery.service').createRecovery({models,sessions,now});
  return async function review({row,inventory},transaction) {
    if(!transaction||transaction.finished||row.state!=='staged'||inventory.flowId!==row.flow_id
      ||inventory.scopeKey!==row.scope_key||inventory.scopeDigest!==row.scope_digest||inventory.accessBlocked!==true)fail();
    const metadata=C.candidate(JSON.parse(row.candidate_metadata),row),clinicIds=JSON.parse(row.clinic_ids);
    if(!Array.isArray(clinicIds)||!clinicIds.length||clinicIds.length>1000||clinicIds.some((v,i)=>!C.positive(v)||i&&v<=clinicIds[i-1])
      ||inventory.candidateDigest!==metadata.digest||inventory.clinicSetDigest!==C.hash(row.clinic_ids))fail();
    D.checkAssets(inventory.assets,metadata);
    const [scopeType,rawId]=row.scope_key.split(':'),scopeId=Number(rawId);
    if(!['clinic','group'].includes(scopeType)||!C.positive(scopeId)||row.scope_key!==scopeType+':'+scopeId)fail();
    // The caller holds the session/clinical authorization locks. This diagnostic
    // uses consistent reads, not asset/identity gap locks: it must not reserve
    // physical identities or delay a withdrawal in another clinical scope.
    const options={transaction,raw:true,logging:false};
    const clinics=await models.Clinica.findAll({...options,attributes:['id_clinica','grupoClinicaId'],
      where:scopeType==='group'?{grupoClinicaId:scopeId}:{id_clinica:scopeId},order:[['id_clinica','ASC']],limit:1001});
    if(JSON.stringify(clinics.map(v=>Number(v.id_clinica)))!==row.clinic_ids)fail();
    const groupIds=[...new Set(clinics.map(v=>Number(v.grupoClinicaId)).filter(C.positive))].sort((a,b)=>a-b);
    const scope={assignmentScope:scopeType,clinicId:scopeType==='clinic'?scopeId:null,groupId:scopeType==='group'?scopeId:null};
    const proof=await recovery.forFlow(row,transaction,{phase:'pending'});
    if(proof&&(proof.scopeKey!==row.scope_key||proof.appId!==metadata.appId||proof.subjectId!==metadata.subjectId
      ||JSON.stringify(proof.clinicIds)!==row.clinic_ids||!Array.isArray(proof.aliases)||!Array.isArray(proof.mappingIds)))fail();
    const scopeReasons=[];
    if(await require('./metaScopeBlock.service').blocked(scope,{models,transaction,purpose:'meta'})&&!proof)scopeReasons.push('scope_blocked');
    // Project only a boolean about credential presence; never materialize a token.
    const connections=await models.MetaConnection.findAll({...options,attributes:['id','broker_app_id','credentials_external',
      [literal('(accessToken IS NULL)'),'credentials_absent']],where:{metaUserId:metadata.subjectId},order:[['id','ASC']],limit:2});
    const connection=connections.length===1?connections[0]:null;
    if(!proof&&(connections.length>1||connection&&(!C.positive(Number(connection.id))||Number(connection.credentials_external)!==1
      ||Number(connection.credentials_absent)!==1||connection.broker_app_id!==metadata.appId)))scopeReasons.push('identity_review');
    const keys=[...clinicIds.map(id=>'clinic:'+id),...groupIds.map(id=>'group:'+id)];
    const grants=await models.MetaConnectionAssignment.findAll({...options,attributes:['id','scopeKey','assignmentScope','clinicaId','grupoClinicaId','metaConnectionId','status'],
      where:{[Op.or]:[{scopeKey:{[Op.in]:keys}},{assignmentScope:'clinic',clinicaId:{[Op.in]:clinicIds}},{assignmentScope:'group',grupoClinicaId:{[Op.in]:groupIds}}]},
      order:[['id','ASC']],limit:keys.length+1});
    const grantType=v=>v.assignmentScope==='clinic'&&C.positive(Number(v.clinicaId))&&v.grupoClinicaId===null?'clinic'
      :v.assignmentScope==='group'&&C.positive(Number(v.grupoClinicaId))&&v.clinicaId===null?'group':null;
    let invalid=grants.length>keys.length||grants.some(v=>{const type=grantType(v);return !type||v.scopeKey!==type+':'+Number(type==='clinic'?v.clinicaId:v.grupoClinicaId);});
    const check=matches=>{if(matches.length>1||matches.length===1&&(!connection||matches[0].status!=='active'||Number(matches[0].metaConnectionId)!==Number(connection.id)))invalid=true;};
    if(scopeType==='group')check(grants.filter(v=>v.scopeKey==='group:'+scopeId));
    for(const clinic of clinics){
      const direct=grants.filter(v=>v.scopeKey==='clinic:'+clinic.id_clinica);
      check(direct.length?direct:grants.filter(v=>v.scopeKey==='group:'+clinic.grupoClinicaId));
    }
    if(invalid&&!proof)scopeReasons.push('scope_assignment_review');

    // Group selected identities and IG parents. No N queries per asset and no
    // token/additionalData column, even when an alias belongs to another clinic.
    const physical=new Map();
    for(const asset of inventory.assets){physical.set(asset.assetRef,{kind:asset.kind,id:asset.id});
      if(asset.parentPageId)physical.set('meta-facebook_page:'+asset.parentPageId,{kind:'facebook_page',id:asset.parentPageId});}
    const refs=[...physical.keys()].sort(),mappingWhere=[];
    for(const kind of ['ad_account','facebook_page','instagram_business']){
      const ids=[...physical.values()].filter(v=>v.kind===kind).flatMap(v=>kind==='ad_account'?[v.id,'act_'+v.id]:[v.id]);
      if(ids.length)mappingWhere.push({assetType:kind,metaAssetId:{[Op.in]:ids}});
    }
    const assigned=new Set(),registered=new Set(),revoked=new Set();
    if(refs.length){
      // Deduplicate in SQL: thousands of aliases/history entries cannot turn a
      // bounded inventory into an unbounded response or a scan per row.
      const aliases=await models.ClinicMetaAsset.findAll({...options,attributes:['assetType','metaAssetId'],where:{[Op.or]:mappingWhere},
        group:['assetType','metaAssetId'],limit:physical.size*2+1});
      if(aliases.length>physical.size*2)fail();
      for(const v of aliases){const ref='meta-'+v.assetType+':'+String(v.metaAssetId).replace(/^act_/,'');if(!physical.has(ref))fail();assigned.add(ref);}
      for(const [model,set] of [[models.MetaMarketingBrokerBinding,registered],[models.MetaMarketingBrokerRevocation,revoked]]){
        const values=await model.findAll({...options,attributes:['asset_ref'],where:{asset_ref:{[Op.in]:refs}},group:['asset_ref'],limit:refs.length+1});
        if(values.length>refs.length)fail();
        for(const v of values){if(!physical.has(v.asset_ref))fail();set.add(v.asset_ref);}
        // A different IG identity can hold the very same parent page. Check the
        // inverse relationship too, without returning that other account's ID.
        const pages=[...physical.values()].filter(v=>v.kind==='facebook_page').map(v=>v.id);
        if(pages.length){
          const parents=await model.findAll({...options,attributes:['parent_page_id'],where:{parent_page_id:{[Op.in]:pages}},group:['parent_page_id'],limit:pages.length+1});
          if(parents.length>pages.length)fail();
          for(const v of parents){const ref='meta-facebook_page:'+v.parent_page_id;if(!physical.has(ref))fail();set.add(ref);}
        }
      }
    }
    const checkedAt=+now();
    if(!Number.isSafeInteger(inventory.expiresAt)||inventory.expiresAt<=checkedAt
      ||[metadata.expiresAt,metadata.dataAccessExpiresAt].some(v=>v!==null&&v<=checkedAt))fail();
    return {version:1,checkedAt,reservationMade:false,scopeStatus:scopeReasons.length?'review_required':'clear',scopeReasons:scopeReasons.sort(),
      assets:inventory.assets.map(asset=>{
        const identities=[asset.assetRef,...(asset.parentPageId?['meta-facebook_page:'+asset.parentPageId]:[])],reasons=[];
        const reviewed=proof?.version===2&&require('./metaMarketingLegacyRecovery.service').selectable(proof,asset,inventory.assets);
        const adopted=proof&&(proof.version===2?reviewed&&proof.aliases.some(alias=>proof.legacyMappingIds.includes(Number(alias.id))
          &&'meta-'+alias.assetType+':'+String(alias.metaAssetId).replace(/^act_/,'')===asset.assetRef)
          :asset.kind==='ad_account'&&proof.aliases.some(alias=>proof.mappingIds.includes(Number(alias.id))
            &&alias.assetType==='ad_account'&&'meta-ad_account:'+String(alias.metaAssetId).replace(/^act_/,'')===asset.assetRef&&Number(alias.credentials_absent)===1));
        if(identities.some(ref=>assigned.has(ref))&&!adopted)reasons.push('asset_assigned');
        if(proof&&!adopted&&!reviewed)reasons.push('recovery_not_selected');
        if(identities.some(ref=>registered.has(ref)))reasons.push('asset_registered');
        if(identities.some(ref=>revoked.has(ref)))reasons.push('asset_revoked');
        return {assetRef:asset.assetRef,status:scopeReasons.length||reasons.length?'review_required':'clear',reasons};
      })};
  };
}
module.exports={createReview,REASONS};
