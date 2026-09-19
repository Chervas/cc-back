'use strict';
const { createHash } = require('node:crypto');
const { Op, literal } = require('sequelize');
const C = require('../../services/integrations-broker/src/meta-marketing-contract');
const positive = value => ['number','string'].includes(typeof value) && /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 2147483647;
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const fail = (code = 'meta_broker_binding_invalid') => { throw Object.assign(Error(code), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) fail(); return rows; };
const ids = values => { if (values.some(v => !positive(v))) fail(); return [...new Set(values.map(Number))].sort((a,b) => a-b); };
const MAPPING_FIELDS = ['id','metaConnectionId','assetType','metaAssetId','assignmentScope','clinicaId','grupoClinicaId','isActive'];
const BINDING_FIELDS = ['mapping_id','enrollment_id','asset_ref','meta_connection_id','meta_user_id','app_id','connection_ref','scope_key','tenant_clinic_id','parent_page_id','state'];
function asset(value) {
  if (typeof value !== 'string') fail();
  const match = /^meta-(ad_account|facebook_page|instagram_business):([1-9][0-9]{0,29})$/.exec(value);
  if (!match) fail(); return { kind: match[1], id: match[2], assetRef: value };
}
function binding(value) {
  if (!value || !positive(value.mapping_id) || !positive(value.meta_connection_id) || !positive(value.tenant_clinic_id)
    || !reference(value.connection_ref) || !C.graphId(value.meta_user_id) || !C.graphId(value.app_id)
    || !/^(clinic|group):[1-9]\d{0,9}$/.test(value.scope_key || '') || !positive(value.scope_key.split(':')[1])
    || !['staged','active','blocked'].includes(value.state)
    || value.enrollment_id != null && !require('./metaMarketingEnrollment.contract').UUID.test(value.enrollment_id)) fail();
  const resource = asset(value.asset_ref);
  if (resource.kind === 'instagram_business' ? !C.graphId(value.parent_page_id) : value.parent_page_id !== null) fail();
  return Object.fromEntries(BINDING_FIELDS.map(k => [k, k==='enrollment_id' ? value[k]??null : ['mapping_id','meta_connection_id','tenant_clinic_id'].includes(k) ? Number(value[k]) : value[k]]));
}
function mapping(value) {
  if (!value || !positive(value.id) || !positive(value.metaConnectionId) || !['clinic','group'].includes(value.assignmentScope)
    || ![true,false,0,1].includes(value.isActive)) fail();
  for (const field of ['clinicaId','grupoClinicaId']) if (value[field] !== null && !positive(value[field])) fail();
  if (!positive(value.assignmentScope === 'clinic' ? value.clinicaId : value.grupoClinicaId)) fail();
  const id = value.assetType === 'ad_account' && typeof value.metaAssetId === 'string' && value.metaAssetId.startsWith('act_') ? value.metaAssetId.slice(4) : value.metaAssetId;
  const resource = asset(`meta-${value.assetType}:${id}`);
  return { ...resource, mappingId:Number(value.id), connectionId:Number(value.metaConnectionId), assignmentScope:value.assignmentScope,
    clinicId:value.clinicaId === null ? null : Number(value.clinicaId), groupId:value.grupoClinicaId === null ? null : Number(value.grupoClinicaId), active:[true,1].includes(value.isActive) };
}
function createMetaMarketingBrokerScope({ loadMapping, loadBindings, loadRevocations, loadMappings, loadClinics, loadShared, loadPrimaryGroups, inspectEnrollment,
  loadGrants, loadConnection, blocked, enabled = () => process.env.META_MARKETING_BROKER_ENABLED === 'true' }) {
  const contexts = new WeakMap();
  async function inspect(mappingId, expected) {
    if (!enabled()) fail('broker_cohort_disabled');
    if (!positive(mappingId)) fail();
    const current = await loadMapping(Number(mappingId));
    // The independent record is read even after mapping/connection deletion.
    const ownedRecords = bounded(await loadBindings(null, Number(mappingId))).map(binding);
    if (ownedRecords.length !== 1 || ownedRecords[0].mapping_id !== Number(mappingId)) fail(); const selected = ownedRecords[0];
    if (selected.state === 'blocked') fail('asset_revoked');
    // The independent delivery history remains an exclusion if a binding is recreated.
    if (bounded(await loadRevocations(selected.asset_ref)).length) fail('asset_revoked');
    if (selected.state !== 'active') fail('meta_broker_not_active');
    let enrollment=null;
    if(selected.enrollment_id){
      if(typeof inspectEnrollment!=='function')fail();
      enrollment=await inspectEnrollment(selected.enrollment_id);
      if(enrollment?.enrollmentId!==selected.enrollment_id||!Array.isArray(enrollment.mappingIds)||!enrollment.mappingIds.includes(Number(mappingId)))fail();
    }
    if (!current) fail(); const requested = mapping(current);
    if (!requested.active || requested.assetRef !== selected.asset_ref || requested.connectionId !== selected.meta_connection_id) fail();
    const [scopeType, rawScopeId] = selected.scope_key.split(':'), scopeId = Number(rawScopeId);
    const scope = { assignmentScope:scopeType, clinicId:scopeType === 'clinic' ? scopeId : null, groupId:scopeType === 'group' ? scopeId : null };
    const clinics = bounded(await loadClinics(scope));
    const clinicIds = ids(clinics.map(row => row.id_clinica));
    if (!clinicIds.length || clinics.length !== clinicIds.length || !clinicIds.includes(selected.tenant_clinic_id)
      || scopeType === 'clinic' && (clinicIds.length !== 1 || clinicIds[0] !== scopeId)
      || scopeType === 'group' && clinics.some(row => Number(row.grupoClinicaId) !== scopeId)) fail();
    if(enrollment&&JSON.stringify(enrollment.clinicIds)!==JSON.stringify(clinicIds))fail('scope_denied');
    if (await blocked(scope)) fail('asset_revoked');
    const records = bounded(await loadBindings(selected.asset_ref, null)).map(binding);
    const aliases = bounded(await loadMappings(requested));
    const all = aliases.map(mapping), active = all.filter(row => row.active);
    if (new Set(all.map(row => row.mappingId)).size !== all.length || !active.some(row => row.mappingId === requested.mappingId)) fail();
    for (const record of records) {
      if (record.asset_ref !== selected.asset_ref || record.connection_ref !== selected.connection_ref
        || record.meta_connection_id !== selected.meta_connection_id || record.meta_user_id !== selected.meta_user_id
        || record.app_id !== selected.app_id || record.scope_key !== selected.scope_key || record.tenant_clinic_id !== selected.tenant_clinic_id
        || record.parent_page_id !== selected.parent_page_id || record.enrollment_id!==selected.enrollment_id) fail();
      // A deleted alias's block still excludes this credential/asset tuple.
      if (record.state === 'blocked') fail('asset_revoked');
      const owner = all.find(row => row.mappingId === record.mapping_id);
      if (!owner || owner.active !== (record.state === 'active')) fail();
    }
    for (const owner of active) {
      if (owner.assetRef !== requested.assetRef || owner.connectionId !== requested.connectionId
        || owner.assignmentScope === 'group' && (scopeType !== 'group' || owner.groupId !== scopeId)
        || owner.clinicId !== null && !clinicIds.includes(owner.clinicId)
        || owner.groupId !== null && clinics.some(row => Number(row.grupoClinicaId) !== owner.groupId)) fail('scope_denied');
      const matches = records.filter(row => row.mapping_id === owner.mappingId);
      if (matches.length !== 1 || matches[0].state !== 'active') fail();
      const raw = aliases.find(row => Number(row.id) === owner.mappingId);
      if (Number(raw.credentials_absent) !== 1) fail();
    }
    const mappingIds = ids([...all.map(row => row.mappingId), ...records.map(row => row.mapping_id)]);
    const shared = bounded(await loadShared(requested.kind, mappingIds));
    if (shared.some(row => !mappingIds.includes(Number(row.assetId)) || !clinicIds.includes(Number(row.clinicaId))
      || !positive(row.grupoClinicaId) || clinics.some(clinic => Number(clinic.grupoClinicaId) !== Number(row.grupoClinicaId)))) fail('scope_denied');
    const primary = bounded(await loadPrimaryGroups(requested.kind, mappingIds));
    for (const group of primary) {
      if (!positive(group.id_grupo) || !mappingIds.includes(Number(group.asset_id))) fail();
      const referenced = bounded(await loadClinics({ assignmentScope:'group', groupId:Number(group.id_grupo), clinicId:null }));
      if (!referenced.length || referenced.some(row => !clinicIds.includes(Number(row.id_clinica)))
        || scopeType === 'group' && Number(group.id_grupo) !== scopeId) fail('scope_denied');
    }
    const groupIds = ids(clinics.map(row => row.grupoClinicaId).filter(value => value !== null));
    const grants = bounded(await loadGrants(clinicIds, groupIds));
    const match = (type,id) => grants.filter(row => row.assignmentScope === type && Number(type === 'clinic' ? row.clinicaId : row.grupoClinicaId) === id);
    const assertGrant = rows => { if (rows.length !== 1 || rows[0].status !== 'active' || Number(rows[0].metaConnectionId) !== requested.connectionId) fail('scope_denied'); };
    if (scopeType === 'group') assertGrant(match('group',scopeId));
    for (const id of clinicIds) {
      const direct = match('clinic',id);
      if (direct.length) assertGrant(direct);
      else assertGrant(match('group',Number(clinics.find(row => Number(row.id_clinica) === id).grupoClinicaId)));
    }
    const connection = await loadConnection(selected.meta_connection_id, selected.meta_user_id);
    if (!connection || Number(connection.id) !== selected.meta_connection_id || connection.metaUserId !== selected.meta_user_id
      || connection.broker_app_id !== selected.app_id || Number(connection.credentials_external) !== 1 || Number(connection.credentials_absent) !== 1) fail();
    const captured = { mappingId:requested.mappingId, ...asset(selected.asset_ref), parentPageId:selected.parent_page_id,
      connectionId:selected.meta_connection_id, connectionRef:selected.connection_ref, appId:selected.app_id, subjectId:selected.meta_user_id,
      tenantRef:`clinic:${selected.tenant_clinic_id}`, scopeKey:selected.scope_key, clinicIds,
      enrollmentHash:enrollment?.digest??null,
      registryHash:digest(records.sort((a,b) => a.mapping_id-b.mapping_id)), mappingsHash:digest(active.sort((a,b) => a.mappingId-b.mappingId)),
      sharedHash:digest(shared), primaryHash:digest(primary), grantsHash:digest(grants), clinicsHash:digest(clinics) };
    if (expected && digest(captured) !== digest(expected)) fail('meta_broker_scope_changed');
    if (!enabled()) fail('broker_cohort_disabled'); return captured;
  }
  const guard = fn => async (...args) => { try { return await fn(...args); } catch (error) {
    fail(['meta_broker_binding_invalid','broker_cohort_disabled','asset_revoked','meta_broker_not_active','scope_denied','meta_broker_scope_changed'].includes(error?.code) ? error.code : 'meta_broker_binding_invalid');
  } };
  return { describe:context => { // Metadata from preparation, never a replacement for assertContext.
      const captured=contexts.get(context);if(!captured)fail();return structuredClone(captured);
    }, prepare:guard(async mappingId => { const captured=await inspect(mappingId); const context=Object.freeze({}); contexts.set(context,captured);return context; }),
    assertContext:guard(async context => { const captured=contexts.get(context);if(!captured)fail();return structuredClone(await inspect(captured.mappingId,captured)); }) };
}
function createMetaMarketingScopeRepository(getModels) {
  const options = { raw:true,logging:false,limit:1001 };
  const mappingOptions = { ...options, attributes:[...MAPPING_FIELDS,[literal('(pageAccessToken IS NULL AND waAccessToken IS NULL AND additionalData IS NULL)'),'credentials_absent']] };
  return {
    inspectEnrollment:id=>getModels().sequelize.transaction({isolationLevel:'REPEATABLE READ'},transaction=>
      require('./metaMarketingEnrollmentBinding.service').createBindings({models:getModels()}).committed(id,transaction)),
    loadMapping:id => getModels().ClinicMetaAsset.findByPk(id,mappingOptions),
    loadRevocations:assetRef => getModels().MetaMarketingBrokerRevocation.findAll({ ...options,attributes:['tuple_hash'],where:{asset_ref:assetRef} }),
    loadBindings:(assetRef,mappingId) => getModels().MetaMarketingBrokerBinding.findAll({ ...options,attributes:BINDING_FIELDS,
      where:assetRef ? { asset_ref:assetRef } : { mapping_id:mappingId },order:[['mapping_id','ASC']] }),
    loadMappings:resource => getModels().ClinicMetaAsset.findAll({ ...mappingOptions,where:{assetType:resource.kind,metaAssetId:{[Op.in]:resource.kind === 'ad_account' ? [resource.id,'act_'+resource.id] : [resource.id]}},order:[['id','ASC']] }),
    loadClinics:scope => getModels().Clinica.findAll({ ...options,attributes:['id_clinica','grupoClinicaId'],where:scope.assignmentScope === 'group' ? { grupoClinicaId:scope.groupId } : { id_clinica:scope.clinicId },order:[['id_clinica','ASC']] }),
    loadShared:(kind,mappingIds) => getModels().GroupAssetClinicAssignment.findAll({ ...options,attributes:['id','assetId','clinicaId','grupoClinicaId'],where:{assetType:'meta.'+kind,assetId:{[Op.in]:mappingIds}},order:[['id','ASC']] }),
    loadPrimaryGroups:(kind,mappingIds) => { const field={facebook_page:'facebook_primary_asset_id',instagram_business:'instagram_primary_asset_id'}[kind];
      return field ? getModels().GrupoClinica.findAll({ ...options,attributes:['id_grupo',[field,'asset_id']],where:{[field]:{[Op.in]:mappingIds}},order:[['id_grupo','ASC']] }) : Promise.resolve([]); },
    loadGrants:(clinicIds,groupIds) => getModels().MetaConnectionAssignment.findAll({ ...options,attributes:['id','assignmentScope','clinicaId','grupoClinicaId','metaConnectionId','status','updated_at'],
      where:{[Op.or]:[{assignmentScope:'clinic',clinicaId:{[Op.in]:clinicIds}},{assignmentScope:'group',grupoClinicaId:{[Op.in]:groupIds}}]},order:[['id','ASC']] }),
    loadConnection:async(id,subject) => { const rows=await getModels().MetaConnection.findAll({ ...options,limit:2,
      attributes:['id','metaUserId','broker_app_id','credentials_external',[literal('(accessToken IS NULL)'),'credentials_absent']],
      where:{[Op.or]:[{id},{metaUserId:subject}]},order:[['id','ASC']] });return rows.length === 1 ? rows[0] : null; },
    blocked:scope => require('./metaScopeBlock.service').blocked(scope,{models:getModels(),purpose:'meta'}),
  };
}
module.exports={createMetaMarketingBrokerScope,createMetaMarketingScopeRepository,BINDING_FIELDS,MAPPING_FIELDS,binding,mapping,asset,positive,reference};
