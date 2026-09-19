'use strict';
const {Op,literal}=require('sequelize'),C=require('./metaMarketingEnrollment.contract');
const {fromEnrollment}=require('../../services/platform-audit/src/meta-enrollment-event');
const plain=v=>v?.get?v.get({plain:true}):v;
const fail=(code='meta_enrollment_scope_changed')=>C.fail(code,409);
const scopeOf=row=>{const [assignmentScope,id]=row.scope_key.split(':');return {assignmentScope,clinicId:assignmentScope==='clinic'?Number(id):null,groupId:assignmentScope==='group'?Number(id):null};};
function createBindings({models,authority,sessions,now=()=>new Date()}){
  const R=models.MetaMarketingEnrollmentRequest,B=models.MetaMarketingBrokerBinding;
  const S=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now});
  const audit=require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const opts=transaction=>{
    if(!transaction?.LOCK?.UPDATE||transaction.finished)C.fail();
    return {transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false};
  };
  async function record(row,reason,transaction,actor){
    const health=await audit.health(now(),{includeUnresolved:false,transaction});
    if(!Number.isSafeInteger(health.pending)||health.pending>=10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable');
    await audit.append(fromEnrollment(row,reason,{now:now(),...actor}),{transaction});
  }
  async function references(row,mappings,transaction,{newlyAllocated=false}={}){
    const o=opts(transaction),scope=scopeOf(row),ids=mappings.map(v=>Number(v.id)),clinics=C.clinics(row.clinic_ids);
    const shares=await models.GroupAssetClinicAssignment.findAll({...o,attributes:['id','assetId','assetType','clinicaId','grupoClinicaId'],
      where:{assetType:{[Op.in]:['meta.ad_account','meta.facebook_page','meta.instagram_business']},assetId:{[Op.in]:ids}},order:[['id','ASC']],limit:1001});
    if(shares.length>1000||newlyAllocated&&shares.length)fail('meta_enrollment_assignment_review');
    for(const share of shares){
      const mapping=mappings.find(v=>Number(v.id)===Number(share.assetId));
      if(!mapping||share.assetType!=='meta.'+mapping.assetType||!clinics.includes(Number(share.clinicaId))
        ||scope.assignmentScope!=='group'||Number(share.grupoClinicaId)!==scope.groupId)fail('meta_enrollment_assignment_review');
    }
    const groups=await models.GrupoClinica.findAll({...o,attributes:['id_grupo','facebook_primary_asset_id','instagram_primary_asset_id'],
      where:{[Op.or]:[{facebook_primary_asset_id:{[Op.in]:ids}},{instagram_primary_asset_id:{[Op.in]:ids}}]},order:[['id_grupo','ASC']],limit:1001});
    if(groups.length>1000||newlyAllocated&&groups.length)fail('meta_enrollment_assignment_review');
    for(const group of groups){
      if(scope.assignmentScope==='group'&&Number(group.id_grupo)!==scope.groupId)fail('meta_enrollment_assignment_review');
      const members=await models.Clinica.findAll({...o,attributes:['id_clinica'],where:{grupoClinicaId:group.id_grupo},limit:1001});
      if(!members.length||members.length>1000||members.some(v=>!clinics.includes(Number(v.id_clinica))))fail('meta_enrollment_assignment_review');
      for(const [field,type] of [['facebook_primary_asset_id','facebook_page'],['instagram_primary_asset_id','instagram_business']]){
        if(ids.includes(Number(group[field]))&&mappings.find(v=>Number(v.id)===Number(group[field]))?.assetType!==type)fail('meta_enrollment_assignment_review');
      }
    }
  }
  async function committed(id,transaction){
    if(!C.UUID.test(id))C.fail();const o=opts(transaction),raw=await R.findByPk(id,o);
    if(!raw)fail();const row=C.request(raw);if(row.state!=='active')fail('meta_enrollment_not_active');
    const scope=scopeOf(row),flow=await models.MetaMarketingOAuthRequest.findByPk(row.flow_id,o);
    if(!flow||flow.state!=='staged'||C.sourceDigest(flow)!==row.flow_digest)fail();
    await S.revalidateStructure(flow,transaction);
    const candidate=C.candidate(JSON.parse(flow.candidate_metadata),flow);
    if(candidate.digest!==row.candidate_digest||candidate.appId!==row.app_id||candidate.subjectId!==row.meta_user_id
      ||[candidate.expiresAt,candidate.dataAccessExpiresAt].some(v=>v!==null&&v<=+now()))fail();
    if(await require('./metaScopeBlock.service').blocked(scope,{models,transaction,purpose:'meta'}))fail('meta_enrollment_scope_blocked');
    const identity=await models.MetaMarketingEnrollmentIdentity.findByPk(row.meta_user_id,o);
    if(!identity||identity.app_id!==row.app_id||Number(identity.meta_connection_id)!==Number(row.meta_connection_id))fail();
    const connections=await models.MetaConnection.findAll({...o,attributes:['id','metaUserId','broker_app_id','credentials_external',[literal('(accessToken IS NULL)'),'credentials_absent']],
      where:{[Op.or]:[{id:row.meta_connection_id},{metaUserId:row.meta_user_id}]},limit:2});
    if(connections.length!==1||Number(connections[0].id)!==Number(row.meta_connection_id)||connections[0].metaUserId!==row.meta_user_id
      ||connections[0].broker_app_id!==row.app_id||Number(connections[0].credentials_external)!==1||Number(connections[0].credentials_absent)!==1)fail();
    const refs=C.physical(row.selected),claims=await models.MetaMarketingEnrollmentClaim.findAll({...o,attributes:['asset_ref','enrollment_id'],
      where:{[Op.or]:[{asset_ref:{[Op.in]:refs}},{enrollment_id:id}]},order:[['asset_ref','ASC']],limit:201});
    if(claims.length!==refs.length||claims.some((v,i)=>v.asset_ref!==refs[i]||v.enrollment_id!==id))fail('meta_enrollment_asset_in_use');
    const bindings=await B.findAll({...o,where:{enrollment_id:id},order:[['mapping_id','ASC']],limit:101});
    if(bindings.length!==row.selected.length||JSON.stringify(bindings.map(v=>Number(v.mapping_id)))!==row.mapping_ids)fail();
    const expected=new Map(row.selected.map(v=>[v.assetRef,v])),aliases=[];
    for(const kind of ['ad_account','facebook_page','instagram_business']){
      const ids=refs.filter(v=>v.startsWith('meta-'+kind+':')).flatMap(v=>kind==='ad_account'?[v.split(':')[1],'act_'+v.split(':')[1]]:[v.split(':')[1]]);
      if(ids.length)aliases.push({assetType:kind,metaAssetId:{[Op.in]:ids}});
    }
    const mappings=await models.ClinicMetaAsset.findAll({...o,attributes:['id','metaConnectionId','assetType','metaAssetId','assignmentScope','clinicaId','grupoClinicaId','isActive',
      [literal('(pageAccessToken IS NULL AND waAccessToken IS NULL AND additionalData IS NULL)'),'credentials_absent']],where:{[Op.or]:aliases},order:[['id','ASC']],limit:201});
    if(mappings.length!==row.selected.length||JSON.stringify(mappings.map(v=>Number(v.id)))!==row.mapping_ids)fail('meta_enrollment_asset_in_use');
    for(const mapping of mappings){
      const ref='meta-'+mapping.assetType+':'+mapping.metaAssetId,asset=expected.get(ref),binding=bindings.find(v=>Number(v.mapping_id)===Number(mapping.id));
      if(!asset||!binding||Number(mapping.metaConnectionId)!==Number(row.meta_connection_id)||Number(mapping.isActive)!==1||Number(mapping.credentials_absent)!==1
        ||mapping.assignmentScope!==scope.assignmentScope||mapping.clinicaId!==scope.clinicId||mapping.grupoClinicaId!==scope.groupId
        ||binding.asset_ref!==ref||binding.parent_page_id!==asset.parentPageId||binding.state!=='active'||binding.enrollment_id!==id
        ||Number(binding.meta_connection_id)!==Number(row.meta_connection_id)||binding.meta_user_id!==row.meta_user_id||binding.app_id!==row.app_id
        ||binding.scope_key!==row.scope_key||binding.connection_ref!==row.connection_ref||Number(binding.tenant_clinic_id)!==row.clinicIds[0])fail();
      expected.delete(ref);
    }
    if(expected.size)fail();
    const pages=refs.filter(v=>v.startsWith('meta-facebook_page:')).map(v=>v.split(':')[1]);
    const physicalWhere={[Op.or]:[{asset_ref:{[Op.in]:refs}},...(pages.length?[{parent_page_id:{[Op.in]:pages}}]:[])]};
    if(await models.MetaMarketingBrokerRevocation.findOne({...o,attributes:['tuple_hash'],where:physicalWhere}))fail('meta_enrollment_asset_revoked');
    const physicalBindings=await B.findAll({...o,attributes:['mapping_id','enrollment_id'],where:physicalWhere,limit:201});
    if(physicalBindings.length!==bindings.length||physicalBindings.some(v=>v.enrollment_id!==id||!row.mappingIds.includes(Number(v.mapping_id))))fail('meta_enrollment_asset_in_use');
    const clinics=await models.Clinica.findAll({...o,attributes:['id_clinica','grupoClinicaId'],where:{id_clinica:{[Op.in]:row.clinicIds}},order:[['id_clinica','ASC']],limit:1001});
    if(clinics.length!==row.clinicIds.length)fail();
    const groups=[...new Set(clinics.map(v=>v.grupoClinicaId).filter(v=>v!==null))];
    const grants=await models.MetaConnectionAssignment.findAll({...o,attributes:['id','scopeKey','assignmentScope','clinicaId','grupoClinicaId','metaConnectionId','status'],
      where:{[Op.or]:[{assignmentScope:'clinic',clinicaId:{[Op.in]:row.clinicIds}},{assignmentScope:'group',grupoClinicaId:{[Op.in]:groups}}]},limit:2001});
    if(grants.length>2000)fail();
    const match=(kind,id)=>grants.filter(v=>v.assignmentScope===kind&&Number(kind==='clinic'?v.clinicaId:v.grupoClinicaId)===id);
    const check=rows=>{if(rows.length!==1)fail();const g=rows[0];if(g.status!=='active'||Number(g.metaConnectionId)!==Number(row.meta_connection_id)
      ||g.scopeKey!==g.assignmentScope+':'+(g.assignmentScope==='clinic'?g.clinicaId:g.grupoClinicaId)
      ||(g.assignmentScope==='clinic'?g.grupoClinicaId!==null:g.clinicaId!==null))fail('meta_enrollment_assignment_review');};
    if(scope.assignmentScope==='group')check(match('group',scope.groupId));
    for(const clinic of clinics){const direct=match('clinic',Number(clinic.id_clinica));check(direct.length?direct:match('group',Number(clinic.grupoClinicaId)));}
    await references(row,mappings,transaction);
    return {enrollmentId:id,flowId:row.flow_id,clinicIds:row.clinicIds,mappingIds:row.mappingIds,
      digest:C.hash(JSON.stringify([id,row.flow_id,row.flow_digest,row.selection_digest,row.assets,row.mapping_ids,row.clinic_ids]))};
  }
  async function activate(value,remote,transaction){
    const expected=C.request(plain(value)),o=opts(transaction),stored=await R.findByPk(expected.enrollment_id,o);
    if(!stored)fail();const row=C.request(stored);
    if(!C.UUID.test(row.lease_token)||row.lease_token!==expected.lease_token||+row.lease_until<=+now())fail('meta_enrollment_lease_lost');
    if(row.state!=='activate_pending'||row.mappingIds.length)fail();
    const receipt=C.receipt(remote,row,{states:['active']});if(receipt.accessBlocked!==false)fail('meta_enrollment_asset_revoked');
    await authority.assertPending(row,transaction);
    const scope=scopeOf(row),grant=await models.MetaConnectionAssignment.findOne({...o,where:{scopeKey:row.scope_key}});
    if(!grant){
      // Generic connection grants are shared with WhatsApp. Never broaden that
      // access as a side effect of assigning new non-WhatsApp assets.
      if(await models.ClinicMetaAsset.findOne({...o,attributes:['id'],where:{metaConnectionId:row.meta_connection_id,
        assetType:{[Op.in]:['whatsapp_business_account','whatsapp_phone_number']}}}))fail('meta_enrollment_assignment_review');
      await models.MetaConnectionAssignment.create({scopeKey:row.scope_key,assignmentScope:scope.assignmentScope,clinicaId:scope.clinicId,grupoClinicaId:scope.groupId,
        metaConnectionId:row.meta_connection_id,status:'active',authorizedByUserId:row.actor_user_id,connectedAt:now(),lastValidatedAt:now()},{transaction,logging:false});
    }
    const mappings=[];
    for(const asset of row.selected){
      const mapping=await models.ClinicMetaAsset.create({metaConnectionId:row.meta_connection_id,assignmentScope:scope.assignmentScope,clinicaId:scope.clinicId,
        grupoClinicaId:scope.groupId,assetType:asset.kind,metaAssetId:asset.id,metaAssetName:null,isActive:true,pageAccessToken:null,waAccessToken:null,additionalData:null},{transaction,logging:false});
      mappings.push({id:Number(mapping.id),assetType:asset.kind});
      await B.create({mapping_id:Number(mapping.id),enrollment_id:row.enrollment_id,asset_ref:asset.assetRef,meta_connection_id:row.meta_connection_id,meta_user_id:row.meta_user_id,
        app_id:row.app_id,connection_ref:row.connection_ref,scope_key:row.scope_key,tenant_clinic_id:row.clinicIds[0],parent_page_id:asset.parentPageId,state:'active'},{transaction,logging:false});
    }
    await references(row,mappings,transaction,{newlyAllocated:true});
    const current=C.request({...row,mapping_ids:JSON.stringify(mappings.map(v=>v.id).sort((a,b)=>a-b)),state:'active',activated_at:now(),updated_at:now(),last_error:null,
      lease_token:null,lease_until:null,next_attempt_at:new Date(+now()+300000)});
    const [changed]=await R.update({mapping_ids:current.mapping_ids,state:current.state,activated_at:current.activated_at,updated_at:current.updated_at,last_error:null,
      lease_token:null,lease_until:null,next_attempt_at:current.next_attempt_at},{where:{enrollment_id:row.enrollment_id,state:'activate_pending',lease_token:row.lease_token},transaction,logging:false});
    if(changed!==1)fail('meta_enrollment_lease_lost');
    await committed(row.enrollment_id,transaction);await record(current,'meta_enrollment_activated',transaction);return current;
  }
  return {activate,committed,record,scopeOf};
}
module.exports={createBindings,scopeOf};
