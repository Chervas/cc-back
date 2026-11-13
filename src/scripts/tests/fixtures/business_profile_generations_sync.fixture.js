'use strict';
const assert=require('node:assert/strict');
module.exports=async({models,jobs,broker,matches,target,old,oldReview,oldPost,unrelated,account,oldId,report})=>{
 const previous=broker.read,reviewName=oldReview.review_name,postName=oldPost.post_name;
 const newReview=`accounts/${account}/locations/${oldId}/reviews/FICTITIOUS_NEW_HEAD`,newPost=`accounts/${account}/locations/${oldId}/localPosts/FICTITIOUS_NEW_HEAD`;
 const beforeReview=(await oldReview.reload()).get({plain:true}),beforePost=(await oldPost.reload()).get({plain:true});
 try{
  broker.read=async(_location,_context,family)=>{
    // Source membership changes while the provider I/O is in flight.
    await models.Clinica.update({grupoClinicaId:6},{where:{id_clinica:71}});
    return {data:family==='reviews'?{reviews:[{name:reviewName,starRating:'ONE',comment:'FICTITIOUS_MUST_NOT_OVERWRITE',updateTime:'2031-01-01T00:00:00Z'},
      {name:newReview,starRating:'FIVE',comment:'FICTITIOUS_NEW',createTime:'2026-11-13T10:00:00Z',updateTime:'2026-11-13T10:00:00Z'}],totalReviewCount:2}:{localPosts:[{name:postName,summary:'FICTITIOUS_MUST_NOT_OVERWRITE'},{name:newPost,summary:'FICTITIOUS_NEW'}]}};
  };
  await jobs._syncBusinessProfileReviews(target,{}, {enqueueOnlyNewReviews:true});await jobs._syncBusinessProfilePosts(target,{});
  assert.deepEqual((await oldReview.reload()).get({plain:true}),beforeReview);assert.deepEqual((await oldPost.reload()).get({plain:true}),beforePost);
  const created=await models.BusinessProfileReview.findOne({where:{review_name:newReview}});assert(created);assert.equal(created.clinica_id,72);assert.equal(created.business_location_id,Number(target.id));assert.deepEqual(matches,[created.id]);
  assert.equal((await models.BusinessProfilePost.findOne({where:{post_name:newPost}})).business_location_id,Number(target.id));
  await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:71}});
  await oldReview.update({business_location_id:unrelated.id},{silent:true});
  const count=await models.BusinessProfileReview.count(),collision=`accounts/${account}/locations/${oldId}/reviews/FICTITIOUS_COLLISION_PAGE`;
  broker.read=async()=>({data:{reviews:[{name:collision,starRating:'FIVE'},{name:reviewName,starRating:'ONE',updateTime:'2031-01-01T00:00:00Z'}],totalReviewCount:2}});
  await assert.rejects(jobs._syncBusinessProfileReviews(target,{}, {enqueueOnlyNewReviews:true}),{code:'broker_binding_invalid'});
  assert.equal(await models.BusinessProfileReview.count(),count);assert.equal(await models.BusinessProfileReview.count({where:{review_name:collision}}),0);
  assert.deepEqual(matches,[created.id]);
 }finally{
  broker.read=previous;await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:71}});await oldReview.update({business_location_id:old.id,clinica_id:71,updated_at:beforeReview.updated_at},{silent:true});
 }
 report.checks.push('Source group change during provider await skips only verified foreign ancestor observations byte-for-byte while persisting/matching new head rows; unknown collision rolls back page and creates no historical matches or duplicate records');
};
