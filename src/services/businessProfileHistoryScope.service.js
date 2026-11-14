'use strict';
const {Op}=require('sequelize');
const C=require('./businessProfileAssociation.contract');
const G=require('./businessProfileBindingGeneration.service');
const plain=r=>r?.get?r.get({plain:true}):r;
const fail=()=>{throw Object.assign(Error('scope_denied'),{code:'scope_denied',httpStatus:403,status:403});};
// The accepted link grants this asset's cached history, not access to the
// source clinic or to any of its other patients, assets or campaign records.
async function createHistoryProjection({models,clinicId,userId,locations,permission,resolveEffectiveMappingIds}){
  const initialIds=locations.map(r=>Number(r.id));
  async function capture(){
    if(resolveEffectiveMappingIds){const effective=await resolveEffectiveMappingIds();if(!Array.isArray(effective)||initialIds.some(id=>!effective.includes(id)))fail();}
    return models.sequelize.transaction(async transaction=>{
    const q=G.query(transaction),clinic=plain(await models.Clinica.findByPk(Number(clinicId),{...q,attributes:['id_clinica','grupoClinicaId']}));
    if(!clinic)fail();
    const memberships=await models.UsuarioClinica.findAll({...q,attributes:['id_clinica','rol_clinica','estado_invitacion'],where:{id_usuario:Number(userId),id_clinica:Number(clinicId)},order:[['id_clinica','ASC'],['rol_clinica','ASC']]});
    const access=permission||require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
    if(!await access({userId:Number(userId),clinicIds:[Number(clinicId)],access:'read',membershipModel:{findAll:args=>models.UsuarioClinica.findAll({...args,...q})}}))fail();
    const lineages=[];
    for(const id of initialIds){
      const mapping=plain(await models.ClinicBusinessLocation.findByPk(id,q));if(!mapping?.is_active)fail();
      const binding=await G.resolveMappingBinding({models,mapping,transaction});
      const chain=[id],sources=[];
      if(binding?.generation_id){
        const owner=plain(await models.Clinica.findByPk(Number(mapping.clinica_id),{...q,attributes:['id_clinica','grupoClinicaId']}));
        const sameOwnerGroup=C.positive(clinic.grupoClinicaId)&&Number(owner?.grupoClinicaId)===Number(clinic.grupoClinicaId);
        const attempt=plain(await models.BusinessProfileAssociationRequest.findByPk(binding.association_attempt_id,q));
        if(!attempt||attempt.state!=='active'||Number(attempt.target_mapping_id)!==id||C.object(attempt.target_snapshot).generationId!==binding.generation_id
          ||C.hash(C.array(C.object(attempt.target_snapshot).predecessors))!==C.hash(C.array(binding.predecessor)))fail();
        const predecessors=C.array(binding.predecessor);
        if(predecessors.length>20)fail();
        for(const predecessor of predecessors){
          const source=plain(await models.ClinicBusinessLocation.findByPk(Number(predecessor.mappingId),q));
          const origin=source&&plain(await models.Clinica.findByPk(Number(source.clinica_id),{...q,attributes:['id_clinica','grupoClinicaId']}));
          const sameGroup=Number(source?.clinica_id)===Number(clinicId)||sameOwnerGroup&&origin&&Number(origin.grupoClinicaId)===Number(clinic.grupoClinicaId)&&Number(origin.grupoClinicaId)===Number(predecessor.groupId);
          if(!source||source.is_active||!origin||C.location(source.location_id)!==binding.external_location_id
            ||source.broker_read_asset_ref!==binding.asset_ref||source.broker_read_asset_ref!==predecessor.assetRef
            ||source.broker_read_connection_ref!==predecessor.connectionRef||Number(source.clinica_id)!==Number(predecessor.clinicId)
            ||!binding.reassociation||!C.HASH.test(binding.proof_digest))fail();
          if(sameGroup)chain.push(Number(source.id));
          sources.push({identity:C.identity(source),groupId:origin.grupoClinicaId??null,visible:!!sameGroup});
        }
      }
      lineages.push({headId:id,chain,identity:C.identity(mapping),generationId:binding?.generation_id??null,proofDigest:binding?.proof_digest??null,sources});
    }
    return {clinicId:Number(clinicId),groupId:clinic.grupoClinicaId??null,memberships,lineages};
  });}
  const captured=await capture(),fingerprint=C.hash(captured);
  const projection={mappingIds:[...new Set(captured.lineages.flatMap(l=>l.chain))],lineages:captured.lineages,
    fingerprint,assert:async()=>{if(C.hash(await capture())!==fingerprint)fail();}};
  return projection;
}
function deduplicateMetrics(rows,projection){
  if(!projection)return rows;
  const membership=new Map();for(const l of projection.lineages)l.chain.forEach((id,rank)=>{if(!membership.has(id))membership.set(id,{headId:l.headId,rank});});
  const selected=new Map();
  for(const row of rows){const ref=membership.get(Number(row.business_location_id));if(!ref)continue;
    const key=JSON.stringify([ref.headId,String(row.date).slice(0,10),row.metric_type,row.metric_subtype||'']);
    const previous=selected.get(key);if(!previous||ref.rank<previous.rank)selected.set(key,{rank:ref.rank,row:{...row,business_location_id:ref.headId,source_business_location_id:Number(row.business_location_id)}});
  }
  return [...selected.values()].map(v=>v.row);
}
// The SQL readers keep stored mapping/clinic IDs intact. These expressions
// identify the same public review across accepted generations for this read.
function reviewRankingSql(projection){
  const membership=new Map();
  for(const lineage of projection?.lineages||[]){
    const headId=Number(lineage.headId);
    if(!Number.isSafeInteger(headId)||headId<=0)fail();
    for(const [rank,value]of lineage.chain.entries()){
      const mappingId=Number(value),previous=membership.get(mappingId);
      if(!Number.isSafeInteger(mappingId)||mappingId<=0||previous&&previous.headId!==headId)fail();
      if(!previous||rank<previous.rank)membership.set(mappingId,{headId,rank});
    }
  }
  const entries=[...membership].sort((a,b)=>a[0]-b[0]);
  const canonical=column=>entries.length?'CASE '+column+' '+entries.map(([id,{headId}])=>`WHEN ${id} THEN ${headId}`).join(' ')+' ELSE '+column+' END':column;
  const rank=entries.length?'CASE r.business_location_id '+entries.map(([id,{rank}])=>`WHEN ${id} THEN ${rank}`).join(' ')+' ELSE 0 END':'CAST(0 AS UNSIGNED)';
  const reviewKey=`BINARY CASE WHEN r.review_name IS NULL OR BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)=BINARY ''
    THEN CONCAT('row:',r.id) ELSE CONCAT('review:',SUBSTRING_INDEX(r.review_name,'/reviews/',-1)) END`;
  return {canonicalMapping:canonical('r.business_location_id'),canonicalMatch:canonical('location_id'),lineageRank:rank,reviewKey};
}
module.exports={createHistoryProjection,deduplicateMetrics,reviewRankingSql};
