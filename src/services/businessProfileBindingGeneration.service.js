'use strict';
const { Op } = require('sequelize');
const C = require('./businessProfileAssociation.contract');
const Owner = require('../../services/integrations-broker/src/google-business-profile-enrollment-contract');
const fail = () => C.fail('broker_binding_invalid');
const plain = row => row?.get ? row.get({ plain: true }) : row;
const query = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), raw: true, logging: false });
function validateResolvedBinding({ mapping, registry, generation }) {
  mapping=plain(mapping); registry=plain(registry); generation=plain(generation);
  if (!mapping || !registry || registry.external_location_id !== C.location(mapping.location_id)) fail();
  let effective=registry;
  if (registry.current_generation_id != null) {
    if (!C.UUID.test(registry.current_generation_id) || !generation || generation.generation_id !== registry.current_generation_id
      || !C.UUID.test(generation.association_attempt_id) || !C.HASH.test(generation.source_fingerprint)
      || Number(generation.mapping_id) !== Number(mapping.id) || generation.external_location_id !== registry.external_location_id
      || generation.scope_ref !== 'gbp-enroll:clinic:' + Number(generation.clinica_id)) fail();
    effective=generation;
    if(generation.reassociation!=null){
      const proof=C.object(generation.reassociation);Owner.validateReassociation(proof);
      const expected=Owner.reassociationDigest(proof,{tenantRef:'clinic:'+Number(generation.clinica_id),connectionRef:generation.connection_ref,assetRef:generation.scope_ref,
        payload:{enrollmentId:generation.association_attempt_id,accountId:generation.asset_ref.split(':')[1],locationId:generation.external_location_id,previousAssetRef:generation.previous_asset_ref??null,clinicCount:1,clinicSetDigest:C.hash([Number(generation.clinica_id)]),reassociation:proof}});
      if(generation.proof_digest!==expected||proof.sourceAssetRef!==generation.asset_ref)fail();
    }else if(generation.proof_digest!=null)fail();
  }
  if (effective.state !== 'active' || !mapping.is_active || !C.positive(mapping.id)
    || Number(effective.clinica_id) !== Number(mapping.clinica_id) || Number(effective.google_connection_id) !== Number(mapping.google_connection_id)
    || effective.connection_ref !== mapping.broker_read_connection_ref || effective.asset_ref !== mapping.broker_read_asset_ref
    || !C.ref(effective.connection_ref) || !/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(effective.asset_ref)
    || effective.asset_ref.split(':')[2] !== registry.external_location_id) fail();
  return { ...effective, mapping_id: Number(mapping.id), generation_id: generation?.generation_id ?? null, external_location_id: registry.external_location_id };
}
async function resolveMappingBinding({ models, mapping, transaction }) {
  const id=C.location(mapping?.location_id), q=query(transaction);
  if (await models.BusinessProfileBrokerRevocation.findByPk(id, { ...q, attributes: ['external_location_id'] })) C.fail('asset_revoked');
  const registry=plain(await models.BusinessProfileBrokerBinding.findByPk(id,q));
  if (!registry && mapping.broker_read_connection_ref == null && mapping.broker_read_asset_ref == null) return null;
  const generation=registry?.current_generation_id == null ? null : plain(await models.BusinessProfileBrokerBindingGeneration.findByPk(registry.current_generation_id,q));
  return validateResolvedBinding({ mapping, registry, generation });
}
async function listEffectiveBindings({models, clinicIds, connectionId, transaction,forRevocation=false}) {
  const q=query(transaction);
  const scoped={clinica_id:{[Op.in]:clinicIds},google_connection_id:Number(connectionId)};
  const result=[];
  if(!forRevocation){
    // Start with mappings of the requested scope. An unrelated damaged head
    // must neither be hydrated nor make a healthy tenant unavailable.
    const mappings=await models.ClinicBusinessLocation.findAll({...q,where:{...scoped,is_active:true},order:[['id','ASC']],limit:1001});
    if(mappings.length>1000)C.fail('broker_discovery_limit');
    for(const mapping of mappings){const binding=await resolveMappingBinding({models,mapping,transaction});if(binding)result.push(binding);}
    return result;
  }
  // Revoke-only metadata can outlive local mapping deactivation/deletion.
  // Selecting active generations by scope does not itself grant authority:
  // each must still be the exact persistent head of its physical location.
  const activeMappings=await models.ClinicBusinessLocation.findAll({...q,where:{...scoped,is_active:true},order:[['id','ASC']],limit:1001});
  if(activeMappings.length>1000)C.fail('broker_discovery_limit');
  for(const mapping of activeMappings){
    const registry=plain(await models.BusinessProfileBrokerBinding.findByPk(C.location(mapping.location_id),q));
    if(!registry&&mapping.broker_read_connection_ref==null&&mapping.broker_read_asset_ref==null)continue;
    const generation=registry?.current_generation_id==null?null:plain(await models.BusinessProfileBrokerBindingGeneration.findByPk(registry.current_generation_id,q));
    validateResolvedBinding({mapping,registry,generation});
  }
  const legacy=await models.BusinessProfileBrokerBinding.findAll({...q,where:{...scoped,state:'active',current_generation_id:null},order:[['external_location_id','ASC']],limit:101});
  const generations=await models.BusinessProfileBrokerBindingGeneration.findAll({...q,where:{...scoped,state:'active'},order:[['mapping_id','ASC']],limit:101});
  if(legacy.length>100||generations.length>100)C.fail('broker_discovery_limit');
  for(const row of legacy){
    if(!C.ref(row.connection_ref)||!/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(row.asset_ref)||row.asset_ref.split(':')[2]!==row.external_location_id)fail();
    result.push({...row,generation_id:null});
  }
  for(const generation of generations){
    const registry=plain(await models.BusinessProfileBrokerBinding.findByPk(generation.external_location_id,q));
    const mapping={id:generation.mapping_id,clinica_id:generation.clinica_id,google_connection_id:generation.google_connection_id,
      location_id:generation.external_location_id,is_active:true,broker_read_connection_ref:generation.connection_ref,broker_read_asset_ref:generation.asset_ref};
    result.push(validateResolvedBinding({mapping,registry,generation}));
  }
  return result;
}
async function observationMappingIds({models,mapping,transaction}){
  const binding=await resolveMappingBinding({models,mapping,transaction});
  const result=[Number(mapping.id)];if(!binding?.generation_id)return result;
  const q=query(transaction),target=await models.Clinica.findByPk(Number(mapping.clinica_id),{...q,attributes:['id_clinica','grupoClinicaId']});
  for(const predecessor of C.array(binding.predecessor)){
    const source=await models.ClinicBusinessLocation.findByPk(Number(predecessor.mappingId),q);
    const origin=source&&await models.Clinica.findByPk(Number(source.clinica_id),{...q,attributes:['id_clinica','grupoClinicaId']});
    if(!source||source.is_active||Number(source.clinica_id)!==Number(predecessor.clinicId)||source.broker_read_asset_ref!==mapping.broker_read_asset_ref
      ||source.broker_read_connection_ref!==predecessor.connectionRef||C.location(source.location_id)!==binding.external_location_id
      ||!origin)fail();
    if(Number(source.clinica_id)!==Number(mapping.clinica_id)&&(!C.positive(target?.grupoClinicaId)||Number(origin.grupoClinicaId)!==Number(target.grupoClinicaId)||Number(origin.grupoClinicaId)!==Number(predecessor.groupId)))continue;
    result.push(Number(source.id));
  }return result;
}
async function preserveObservationOrigin({models,mapping,existing,transaction}){
  if(Number(existing.business_location_id)===Number(mapping.id)&&Number(existing.clinica_id)===Number(mapping.clinica_id))return true;
  const ids=await observationMappingIds({models,mapping,transaction});
  const origin=await models.ClinicBusinessLocation.findByPk(Number(existing.business_location_id),query(transaction));
  if(!origin||Number(origin.clinica_id)!==Number(existing.clinica_id))fail();
  if(ids.includes(Number(existing.business_location_id)))return true;
  const binding=await resolveMappingBinding({models,mapping,transaction});
  if(binding?.generation_id&&C.array(binding.predecessor).some(p=>Number(p.mappingId)===Number(origin.id)&&Number(p.clinicId)===Number(origin.clinica_id)))return false;
  fail();
}
module.exports={resolveMappingBinding,validateResolvedBinding,listEffectiveBindings,observationMappingIds,preserveObservationOrigin,query};
