'use strict';
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
module.exports=async({sql,models,report,C,scope,input,account,oldId,old,other,payload,client})=>{
 const {createAssociationService}=require('../../../services/businessProfileAssociation.service');
 const Owner=require('../../../../services/integrations-broker/src/google-business-profile-enrollment-contract');
 let proof={descriptorId:randomUUID(),sourceTenantRef:'clinic:71',sourceConnectionRef:'connection:test',sourceScopeRef:'gbp-enroll:clinic:71',sourceAssetRef:`gbp:${account}:${oldId}`,retirementEnrollmentId:payload.attemptId,retirementDigest:'f'.repeat(64)};
 const remote=new Map();const transport={execute:async cmd=>{
  const p=cmd.payload,kind=cmd.operation.split('.').at(-2);
  if(kind==='discover'){const scope=await models.BusinessProfileAssociationScope.findByPk(cmd.assetRef.replace('gbp-enroll:',''));return {requestId:cmd.requestId,replayed:false,data:{locations:C.array(scope.location_ids).map(id=>({accountId:account,accountName:'accounts/'+account,locationId:id,name:'locations/'+id,title:'FICTITIOUS_REASSOCIATION',...(proof&&proof.sourceAssetRef===`gbp:${account}:${id}`?{reassociation:proof}:{}),metadata:{hasVoiceOfMerchant:true,newReviewUri:'https://search.google.com/local/writereview?placeid=FICTITIOUS_REASSOCIATION'}})),nextPageToken:null}};}
  if(kind==='status')return {requestId:cmd.requestId,replayed:false,data:remote.get(p.enrollmentId)};
  const data={enrollmentId:p.enrollmentId,assetRef:`gbp:${p.accountId}:${p.locationId}`,scopeRef:cmd.assetRef,accountId:p.accountId,locationId:p.locationId,previousAssetRef:p.previousAssetRef,clinicCount:p.clinicCount,clinicSetDigest:p.clinicSetDigest,state:kind==='prepare'?'prepared':'active',previousAssetRetired:kind==='retire',accessBlocked:false,...(p.reassociation?{reassociation:{...p.reassociation,proofDigest:Owner.reassociationDigest(p.reassociation,cmd)},reassociationCleanupPending:false}:{})};remote.set(p.enrollmentId,data);
  return {requestId:cmd.requestId,replayed:false,data};
 }};
 const nativeClient=require('../../../services/businessProfileAssociationClient.service').createClient({client:transport,controlClient:transport});
 const service=createAssociationService({models,sessions:{verifyReference:async()=>true},client:nativeClient,now:()=>new Date(input.sessionExpiresAt-1000),enabled:()=>true});
 await models.UsuarioClinica.create({id_usuario:9,id_clinica:72,rol_clinica:require('../../../lib/role-helpers').MARKETING_WRITE_ROLES[0],estado_invitacion:'aceptada'});
 await models.BusinessProfileAssociationScope.create({...scope,scope_key:'clinic:72',clinica_id:72,scope_ref:'gbp-enroll:clinic:72',location_ids:[oldId]});
 const second={...input,clinicId:72,scopeKey:'clinic:72'},oldBefore=(await old.reload()).get({plain:true});
 const legacyBefore=(await models.BusinessProfileBrokerBinding.findByPk(oldId)).get({plain:true});
 const p2={attemptId:randomUUID(),sourceFingerprint:(await service.capabilities(second)).sourceFingerprint,accountName:'accounts/'+account,locationName:'locations/'+oldId};
 await models.UsuarioClinica.create({id_usuario:902,id_clinica:72,rol_clinica:'agencia',estado_invitacion:'aceptada'});
 const denied={...second,actorId:902};await assert.rejects(service.prepare(denied,{...p2,attemptId:randomUUID(),sourceFingerprint:(await service.capabilities(denied)).sourceFingerprint}),{code:'scope_denied'});
 const direct=await models.GoogleConnectionAssignment.create({scopeKey:'clinic:72',assignmentScope:'clinic',clinicaId:72,googleConnectionId:81,status:'active'});
 await models.Clinica.update({grupoClinicaId:6},{where:{id_clinica:72}});await assert.rejects(service.prepare(second,{...p2,attemptId:randomUUID(),sourceFingerprint:(await service.capabilities(second)).sourceFingerprint}),{code:'scope_denied'});await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:72}});await direct.destroy();
 assert.equal((await service.prepare(second,p2)).attempt.state,'prepared');
 const attempt=await models.BusinessProfileAssociationRequest.findByPk(p2.attemptId);assert.notEqual(Number(attempt.target_mapping_id),Number(old.id));assert.equal(attempt.previous_asset_ref,null);
 await models.BusinessProfileDailyMetric.create({business_location_id:old.id,clinica_id:71,value:5});
 const confirmed=await service.confirm(second,p2.attemptId);assert.equal(confirmed.attempt.state,'active',JSON.stringify(confirmed.attempt));
 const G=require('../../../services/businessProfileBindingGeneration.service'),target=await models.ClinicBusinessLocation.findByPk(attempt.target_mapping_id);
 const resolved=await G.resolveMappingBinding({models,mapping:target});assert.equal(resolved.mapping_id,Number(target.id));assert.equal(resolved.clinica_id,72);
 assert.deepEqual((await old.reload()).get({plain:true}),oldBefore);
 const after=(await models.BusinessProfileBrokerBinding.findByPk(oldId)).get({plain:true});assert(after.current_generation_id);delete after.current_generation_id;delete legacyBefore.current_generation_id;assert.deepEqual(after,legacyBefore);
 await assert.rejects(G.resolveMappingBinding({models,mapping:old}),{code:'broker_binding_invalid'});
 const history=await require('../../../services/businessProfileHistoryScope.service').createHistoryProjection({models,clinicId:72,userId:9,locations:[target]});assert.deepEqual(history.mappingIds,[Number(target.id),Number(old.id)]);
 const unrelated=await models.ClinicBusinessLocation.findOne({where:{clinica_id:71,is_active:true}});assert(unrelated);assert(!history.mappingIds.includes(Number(unrelated.id)));assert.equal(target.sync_status,'pending');
 await models.UsuarioClinica.create({id_usuario:901,id_clinica:72,rol_clinica:'personaldeclinica',estado_invitacion:'aceptada'});
 const destinationOnly=await require('../../../services/businessProfileHistoryScope.service').createHistoryProjection({models,clinicId:72,userId:901,locations:[target]});assert.deepEqual(destinationOnly.mappingIds,history.mappingIds);
 await history.assert();await models.Clinica.update({grupoClinicaId:6},{where:{id_clinica:71}});await assert.rejects(history.assert(),{code:'scope_denied'});await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:71}});
 await models.Clinica.update({grupoClinicaId:6},{where:{id_clinica:71}});const ownOnly=await require('../../../services/businessProfileHistoryScope.service').createHistoryProjection({models,clinicId:72,userId:901,locations:[target]});assert.deepEqual(ownOnly.mappingIds,[Number(target.id)]);await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:71}});
 await models.UsuarioClinica.update({rol_clinica:'agencia'},{where:{id_usuario:901,id_clinica:72}});await assert.rejects(destinationOnly.assert(),{code:'scope_denied'});
 await sql.transaction(transaction=>G.preserveObservationOrigin({models,mapping:target,existing:{business_location_id:old.id,clinica_id:71},transaction}));
 await assert.rejects(G.preserveObservationOrigin({models,mapping:target,existing:{business_location_id:other.id,clinica_id:99}}),{code:'broker_binding_invalid'});
 const D=require('sequelize').DataTypes;
 for(const [name,file]of[['BusinessProfileReview','businessprofilereview'],['BusinessProfilePost','businessprofilepost']]){models[name]=require('../../../../models/'+file)(sql,D);await models[name].sync();}
 await require('../../../../migrations/20260919210000-create-business-profile-cache-coordination').up(sql.getQueryInterface());models.BusinessProfileCacheState=require('../../../../models/businessprofilecachestate')(sql,D);
 const reviewName=`accounts/${account}/locations/${oldId}/reviews/fictitious-review`,postName=`accounts/${account}/locations/${oldId}/localPosts/fictitious-post`;
 const oldReview=await models.BusinessProfileReview.create({clinica_id:71,business_location_id:old.id,review_name:reviewName,comment:'FICTITIOUS_OLD',update_time:new Date('2026-11-01T00:00:00Z')}),oldPost=await models.BusinessProfilePost.create({clinica_id:71,business_location_id:old.id,post_name:postName,summary:'FICTITIOUS_OLD'});
 const matches=[];const broker={managed:()=>true,binding:()=>({assetRef:`gbp:${account}:${oldId}`}),assertRead:async(_m,_context,options)=>G.resolveMappingBinding({models,mapping:target,transaction:options?.transaction}),read:async(_m,_context,family)=>({data:family==='reviews'?{reviews:[{name:reviewName,starRating:'FIVE',comment:'FICTITIOUS_UPDATED',createTime:'2026-11-01T00:00:00Z',updateTime:'2026-11-13T00:00:00Z'}],totalReviewCount:1}:{localPosts:[{name:postName,summary:'FICTITIOUS_UPDATED'}]}})};
 const {metaSyncJobs:jobs}=require('./business_profile_jobs.fixture').loadBusinessProfileJobs({models,broker,matching:async id=>matches.push(id),legacyHttp:{get:()=>assert.fail('legacy provider forbidden')}});
 await jobs._syncBusinessProfileReviews(target,{}, {enqueueOnlyNewReviews:true});await jobs._syncBusinessProfilePosts(target,{});
 await oldReview.reload();await oldPost.reload();assert.equal(oldReview.business_location_id,Number(old.id));assert.equal(oldReview.clinica_id,71);assert.equal(oldReview.comment,'FICTITIOUS_UPDATED');assert.equal(oldPost.business_location_id,Number(old.id));assert.equal(oldPost.clinica_id,71);assert.equal(oldPost.summary,'FICTITIOUS_UPDATED');assert.equal(matches.length,0);
 assert.equal(await models.BusinessProfileReview.count(),1);assert.equal(await models.BusinessProfilePost.count(),1);
 await require('./business_profile_generations_sync.fixture')({models,jobs,broker,matches,target,old,oldReview,oldPost,unrelated,account,oldId,report});
 await require('./business_profile_generations_activity.fixture')({sql,models,report,target,old,unrelated,account,oldId});
 // Retire this generation, then reassociate again: legacy registry never
 // becomes the authority for the new owner and ancestors stay asset-specific.
 const replace=async(context,locationId)=>{const cap=await service.capabilities(context),p={attemptId:randomUUID(),sourceFingerprint:cap.sourceFingerprint,accountName:'accounts/'+account,locationName:'locations/'+locationId,...(cap.reviewDestinationChangeRequired?{reviewDestinationChangeAccepted:true}:{})};assert.equal((await service.prepare(context,p)).attempt.state,'prepared');const result=await service.confirm(context,p.attemptId);assert.equal(result.attempt.state,'active',JSON.stringify(result.attempt));return models.BusinessProfileAssociationRequest.findByPk(p.attemptId);};
 const other72='90000000000000000001';proof=null;await models.BusinessProfileAssociationScope.update({location_ids:[oldId,other72]},{where:{scope_key:'clinic:72'}});const retired72=await replace(second,other72);
 const other73='90000000000000000002';await models.Clinica.create({id_clinica:73,grupoClinicaId:5,nombre_clinica:'FICTITIOUS_THIRD'});await models.UsuarioClinica.create({id_usuario:9,id_clinica:73,rol_clinica:'agencia',estado_invitacion:'aceptada'});await models.BusinessProfileAssociationScope.create({...scope,scope_key:'clinic:73',clinica_id:73,scope_ref:'gbp-enroll:clinic:73',location_ids:[oldId,other73]});
 const third={...input,clinicId:73,scopeKey:'clinic:73'};const occupied=await replace(third,other73);
 await models.MarketingPatientList.create({clinica_id:73,objective_id:'review_requests',status:'paused',criteria:{review_request:1}});
 proof={descriptorId:randomUUID(),sourceTenantRef:'clinic:72',sourceConnectionRef:'connection:test',sourceScopeRef:'gbp-enroll:clinic:72',sourceAssetRef:`gbp:${account}:${oldId}`,retirementEnrollmentId:retired72.attempt_id,retirementDigest:'e'.repeat(64)};
 const p3={attemptId:randomUUID(),sourceFingerprint:(await service.capabilities(third)).sourceFingerprint,accountName:'accounts/'+account,locationName:'locations/'+oldId,reviewDestinationChangeAccepted:true};
 await assert.rejects(service.prepare(third,{...p3,reviewDestinationChangeAccepted:false}),{code:'gbp_association_campaign_dependency'});
 await models.Clinica.update({grupoClinicaId:6},{where:{id_clinica:72}});await assert.rejects(service.prepare(third,p3),{code:'gbp_association_scope_changed'});await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:72}});
 assert.equal((await service.prepare(third,p3)).attempt.state,'prepared');assert.equal((await service.confirm(third,p3.attemptId)).attempt.state,'active');
 const request3=await models.BusinessProfileAssociationRequest.findByPk(p3.attemptId),target3=await models.ClinicBusinessLocation.findByPk(request3.target_mapping_id);
 assert.equal(request3.previous_asset_ref,`gbp:${account}:${other73}`);assert.equal((await G.resolveMappingBinding({models,mapping:target3})).previous_asset_ref,request3.previous_asset_ref);
 const history3=await require('../../../services/businessProfileHistoryScope.service').createHistoryProjection({models,clinicId:73,userId:9,locations:[target3]});assert.deepEqual(history3.mappingIds,[Number(target3.id),Number(target.id),Number(old.id)]);assert(!history3.mappingIds.includes(Number(unrelated.id)));assert(!history3.mappingIds.includes(Number(retired72.target_mapping_id)));
 const storedGlobal=(await models.BusinessProfileBrokerBinding.findByPk(oldId)).get({plain:true});delete storedGlobal.current_generation_id;assert.deepEqual(storedGlobal,legacyBefore);
 const thirdNew='90000000000000000003';proof=null;await models.BusinessProfileAssociationScope.update({location_ids:[oldId,other73,thirdNew]},{where:{scope_key:'clinic:73'}});const retired73=await replace(third,thirdNew);
 proof={descriptorId:randomUUID(),sourceTenantRef:'clinic:73',sourceConnectionRef:'connection:test',sourceScopeRef:'gbp-enroll:clinic:73',sourceAssetRef:`gbp:${account}:${oldId}`,retirementEnrollmentId:retired73.attempt_id,retirementDigest:'c'.repeat(64)};
 await models.BusinessProfileAssociationScope.update({location_ids:[...scope.location_ids,oldId]},{where:{scope_key:'clinic:71'}});
 await assert.rejects(service.prepare(input,{attemptId:randomUUID(),sourceFingerprint:(await service.capabilities(input)).sourceFingerprint,accountName:'accounts/'+account,locationName:'locations/'+oldId,reviewDestinationChangeAccepted:true}),{code:'gbp_association_target_forbidden'});
 // Same-tenant returns need the future signed v2 authority protocol. No
 // generation or restored legacy grant may fake that capability today.
 const own={...input,clinicId:99,scopeKey:'clinic:99'},ownA=await models.ClinicBusinessLocation.findOne({where:{clinica_id:99,is_active:true}}),ownAId=C.location(ownA.location_id),ownBId='80000000000000000002';
 await models.Clinica.update({grupoClinicaId:null},{where:{id_clinica:99}});await models.BusinessProfileAssociationScope.update({location_ids:[ownAId,ownBId]},{where:{scope_key:'clinic:99'}});proof=null;const ownRetirement=await replace(own,ownBId);
 proof={descriptorId:randomUUID(),sourceTenantRef:'clinic:99',sourceConnectionRef:'connection:test',sourceScopeRef:'gbp-enroll:clinic:99',sourceAssetRef:`gbp:${account}:${ownAId}`,retirementEnrollmentId:ownRetirement.attempt_id,retirementDigest:'d'.repeat(64)};
 await assert.rejects(service.prepare(own,{attemptId:randomUUID(),sourceFingerprint:(await service.capabilities(own)).sourceFingerprint,accountName:'accounts/'+account,locationName:'locations/'+ownAId}),{code:'gbp_association_target_forbidden'});
 assert.equal((await models.ClinicBusinessLocation.findByPk(ownA.id)).is_active,false);assert.equal((await models.ClinicBusinessLocation.findByPk(ownRetirement.target_mapping_id)).is_active,true);
 await assert.rejects(require('../../../../migrations/20261113160000-business-profile-binding-generations').down(sql.getQueryInterface()),/gbp_generation_preserve_history/);
 report.checks.push('Reassociation creates new mapping/generation with Owner proof and explicit lineage; original mapping/legacy registry preserved exactly; same-group history revalidates and data-only jobs do not invalidate structural confirmation');
 report.checks.push('Destination-only READ sees only accepted same-asset predecessor, never the active sibling owned by origin; pending first sync retains historical observations; group/role changes close captured history and a new request still sees its own head; real sync methods update facts without moving origin IDs or enqueueing historical matches');
 report.checks.push('Two distinct-tenant reassociations resolve retired generation heads and flattened same-asset ancestors, preserve legacy row, pin actual occupied target C plus review-destination consent, exclude C history, and close group drift. Same-tenant return remains denied without reviving retired grants');
};
