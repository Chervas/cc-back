'use strict';
const {Op}=require('sequelize');
const C=require('./businessProfileAssociation.contract');
const Owner=require('../../services/integrations-broker/src/google-business-profile-enrollment-contract');
const {query}=require('./businessProfileBindingGeneration.service');
const fields=['id','clinica_id','google_connection_id','location_id','is_active','broker_read_connection_ref','broker_read_asset_ref'];
const bindingFields=['external_location_id','connection_ref','asset_ref','clinica_id','google_connection_id','state','association_attempt_id','current_generation_id'];
const plain=row=>row?.get?row.get({plain:true}):row;
async function sourceRows({models,scope,transaction}){
  if(!scope.location_ids.length)return [];
  const rows=await models.ClinicBusinessLocation.findAll({...query(transaction),attributes:fields,where:{[Op.or]:scope.location_ids.flatMap(id=>[
    {location_id:{[Op.in]:[id,'locations/'+id]}},{location_id:{[Op.like]:'%/locations/'+id}}])},order:[['id','ASC']],limit:1001});
  if(rows.length>1000)C.fail('gbp_association_limit');return rows;
}
// Structural evidence only. Routine changes to metrics/review counts/raw caches
// do not invalidate a human confirmation.
async function lineageSnapshot({models,scope,clinic,actorId,transaction}){
  const rows=await sourceRows({models,scope,transaction}),q=query(transaction),result=[];
  for(const row of rows){
    if(row.is_active)continue;
    const sourceClinic=plain(await models.Clinica.findByPk(Number(row.clinica_id),{...q,attributes:['id_clinica','grupoClinicaId']}));
    const registry=plain(await models.BusinessProfileBrokerBinding.findByPk(C.location(row.location_id),q));
    if(registry?.state!=='retired'&&registry?.current_generation_id==null)continue;
    const ownedAttempt=await models.BusinessProfileAssociationRequest.findOne({...q,where:{target_mapping_id:Number(row.id)}});
    if(ownedAttempt&&ownedAttempt.state!=='active')continue;
    if(registry?.association_attempt_id){const prior=await models.BusinessProfileAssociationRequest.findByPk(registry.association_attempt_id,q);if(prior?.state==='cancelled'&&Number(prior.target_mapping_id)===Number(row.id))continue;}
    const memberships=await models.UsuarioClinica.findAll({...q,attributes:['id_clinica','rol_clinica','estado_invitacion'],where:{id_usuario:Number(actorId),id_clinica:{[Op.in]:[Number(row.clinica_id),Number(clinic.id_clinica)]}},order:[['id_clinica','ASC'],['rol_clinica','ASC']]});
    const head=registry?.current_generation_id?plain(await models.BusinessProfileBrokerBindingGeneration.findByPk(registry.current_generation_id,q)):null;
    result.push({mapping:C.identity(row),registry:registry?bindingFields.map(k=>registry[k]??null):null,memberships,
      head:head?Object.fromEntries(['generation_id','mapping_id','external_location_id','clinica_id','google_connection_id','connection_ref','asset_ref','scope_ref','previous_asset_ref','state','association_attempt_id','source_fingerprint','predecessor','reassociation','proof_digest'].map(k=>[k,head[k]??null])):null,
      sourceGroupId:sourceClinic?.grupoClinicaId??null,targetGroupId:clinic.grupoClinicaId??null});
  }
  return result;
}
async function inspectSource({models,proof,accountId,locationId,targetClinic,targetConnectionRef,targetConnectionId,actorId,transaction,writeAccess}){
  Owner.validateReassociation(proof);const q=query(transaction);
  if(proof.sourceAssetRef!==`gbp:${accountId}:${locationId}`)C.fail('gbp_association_target_forbidden');
  const sourceId=Number(proof.sourceTenantRef.split(':')[1]);
  if(sourceId===Number(targetClinic.id_clinica))C.fail('gbp_association_target_forbidden');
  if(targetConnectionRef&&proof.sourceConnectionRef!==targetConnectionRef)C.fail('gbp_association_identity_mismatch');
  const sourceClinic=plain(await models.Clinica.findByPk(sourceId,{...q,attributes:['id_clinica','grupoClinicaId']}));
  if(!sourceClinic||sourceId!==Number(targetClinic.id_clinica)&&(!C.positive(targetClinic.grupoClinicaId)||Number(sourceClinic.grupoClinicaId)!==Number(targetClinic.grupoClinicaId)))C.fail('scope_denied');
  const check=writeAccess||((args)=>require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess(args));
  if(!await check({userId:Number(actorId),clinicIds:[...new Set([sourceId,Number(targetClinic.id_clinica)])],access:'write',
    membershipModel:{findAll:args=>models.UsuarioClinica.findAll({...args,...q})}}))C.fail('scope_denied');
  const rows=await sourceRows({models,scope:{location_ids:[locationId]},transaction});
  // This is the successor which retired the old association, not the old
  // location's own enrollment. Owner independently verifies its durable row.
  const retirement=plain(await models.BusinessProfileAssociationRequest.findByPk(proof.retirementEnrollmentId,q));
  const source=retirement&&rows.find(r=>Number(r.id)===Number(retirement.source_mapping_id));
  if(!source||source.is_active||rows.some(r=>r.is_active)||Number(source.clinica_id)!==sourceId||source.broker_read_connection_ref!==proof.sourceConnectionRef||source.broker_read_asset_ref!==proof.sourceAssetRef)C.fail('gbp_association_location_in_use');
  if(targetConnectionId&&Number(source.google_connection_id)!==Number(targetConnectionId))C.fail('gbp_association_identity_mismatch');
  if(!retirement||retirement.state!=='active'
    ||retirement.previous_asset_ref!==proof.sourceAssetRef||retirement.connection_ref!==proof.sourceConnectionRef
    ||retirement.scope_ref!==proof.sourceScopeRef||Number(retirement.clinica_id)!==sourceId)C.fail('gbp_association_scope_changed');
  const registry=plain(await models.BusinessProfileBrokerBinding.findByPk(locationId,q));
  if(!registry)C.fail('broker_binding_invalid');
  const head=registry.current_generation_id==null?null:plain(await models.BusinessProfileBrokerBindingGeneration.findByPk(registry.current_generation_id,q));
  const effective=head||registry;
  if(registry.current_generation_id!=null&&(!head||head.generation_id!==registry.current_generation_id||Number(head.mapping_id)!==Number(source.id)||head.external_location_id!==locationId||head.scope_ref!==proof.sourceScopeRef))C.fail('broker_binding_invalid');
  if(effective.state!=='retired'||effective.connection_ref!==proof.sourceConnectionRef||effective.asset_ref!==proof.sourceAssetRef||Number(effective.clinica_id)!==sourceId||Number(effective.google_connection_id)!==Number(source.google_connection_id))C.fail('broker_binding_invalid');
  let ancestors=[];
  if(head){
    const installed=plain(await models.BusinessProfileAssociationRequest.findByPk(head.association_attempt_id,q));
    if(!installed||installed.state!=='active'||Number(installed.target_mapping_id)!==Number(source.id)||C.object(installed.target_snapshot).generationId!==head.generation_id||installed.previous_asset_ref!==head.previous_asset_ref)C.fail('broker_binding_invalid');
    if(head.reassociation&&head.proof_digest!==digestFor(installed,C.object(head.reassociation)))C.fail('broker_binding_invalid');
    ancestors=C.array(head.predecessor);if(ancestors.length>19)C.fail('gbp_association_limit');
    if(C.hash(ancestors)!==C.hash(C.array(C.object(installed.target_snapshot).predecessors)))C.fail('broker_binding_invalid');
    const ids=new Set([Number(source.id)]);
    for(const ancestor of ancestors){
      if(Number(ancestor.clinicId)===Number(targetClinic.id_clinica))C.fail('gbp_association_target_forbidden');
      if(ids.has(Number(ancestor.mappingId)))C.fail('broker_binding_invalid');ids.add(Number(ancestor.mappingId));
      const old=plain(await models.ClinicBusinessLocation.findByPk(Number(ancestor.mappingId),q));
      if(!old||old.is_active||Number(old.clinica_id)!==Number(ancestor.clinicId)||C.location(old.location_id)!==locationId||old.broker_read_asset_ref!==proof.sourceAssetRef||old.broker_read_asset_ref!==ancestor.assetRef||old.broker_read_connection_ref!==ancestor.connectionRef)C.fail('broker_binding_invalid');
    }
  }
  if(await models.BusinessProfileBrokerRevocation.findByPk(locationId,q))C.fail('asset_revoked');
  return {mappingId:Number(source.id),clinicId:sourceId,groupId:sourceClinic.grupoClinicaId==null?null:Number(sourceClinic.grupoClinicaId),generationId:registry.current_generation_id??null,
    assetRef:proof.sourceAssetRef,connectionRef:proof.sourceConnectionRef,sourceScopeRef:proof.sourceScopeRef,
    retirementEnrollmentId:proof.retirementEnrollmentId,retirementDigest:proof.retirementDigest,ancestors};
}
function digestFor(row,proof){return Owner.reassociationDigest(proof,{tenantRef:'clinic:'+row.clinica_id,connectionRef:row.connection_ref,assetRef:row.scope_ref,
  payload:{enrollmentId:row.attempt_id,accountId:row.account_id,locationId:row.location_id,previousAssetRef:row.previous_asset_ref,clinicCount:1,
    clinicSetDigest:C.hash([Number(row.clinica_id)]),reassociation:proof}});}
module.exports={lineageSnapshot,inspectSource,digestFor};
