'use strict';
const { Op } = require('sequelize');
const { listScopedGoogleProperties } = require('./effectiveMarketingAssets.service');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const fail = code => { throw Object.assign(Error(code), { code }); };
const positive = n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const FIELDS = ['id', 'clinica_id', 'google_connection_id', 'location_id', 'is_active', 'updated_at',
  'broker_read_connection_ref', 'broker_read_asset_ref'];

// Resolve only GBP metadata. Every read participates in the caller's transaction;
// no credentials, HTTP or unrelated marketing inventory are loaded here.
async function mutationScope({ models: m, clinicId, mappingId, userId, transaction }) {
  if (![clinicId, mappingId, userId].every(positive)) fail('scope_denied');
  const options = { logging: false, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) };
  const wrap = (model, attributes) => ({
    findByPk: (id, query) => model.findByPk(id, { ...query, ...options, ...(attributes ? { attributes } : {}) }),
    findAll: query => model.findAll({ ...query, ...options, ...(attributes ? { attributes } : {}) }),
  });
  const clinic = await m.Clinica.findByPk(clinicId, { ...options, attributes: ['id_clinica', 'grupoClinicaId'], raw: true });
  if (!clinic || Number(clinic.id_clinica) !== clinicId) fail('scope_denied');
  const groupId = Number(clinic.grupoClinicaId) || null;
  const scope = { assignment_scope: 'clinic', clinic_id: clinicId, group_id: groupId, clinic_ids: [clinicId] };
  const assets = await listScopedGoogleProperties(scope, { sections: ['business_profile'],
    groupModel: wrap(m.GrupoClinica), assignmentModel: wrap(m.GroupAssetClinicAssignment),
    propertyModels: { business_profile: wrap(m.ClinicBusinessLocation, FIELDS) } });
  if (!assets.business_profile.some(row => Number(row.mapping_id) === mappingId)) fail('scope_denied');
  const location = await m.ClinicBusinessLocation.findByPk(mappingId, { ...options, attributes: FIELDS, raw: true });
  if (!location?.is_active || !positive(Number(location.clinica_id))) fail('scope_denied');
  const externalId = /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(location.location_id)?.[1];
  if (!externalId) fail('scope_denied');
  // Google location IDs are global. Another local mapping of the same location
  // can expose the change to additional clinics even under a different account.
  const aliases = await m.ClinicBusinessLocation.findAll({ ...options, raw: true, attributes: ['id', 'clinica_id'],
    where: { is_active: true, [Op.or]: [{ location_id: { [Op.in]: [externalId, 'locations/' + externalId] } },
      { location_id: { [Op.like]: '%/locations/' + externalId } }] }, limit: 1001 });
  if (!aliases.length || aliases.length > 1000 || aliases.some(row => !positive(Number(row.id)) || !positive(Number(row.clinica_id)))) fail('scope_denied');
  const aliasIds = aliases.map(row => Number(row.id));
  const affected = new Set([clinicId, Number(location.clinica_id)]);
  for (const row of aliases) affected.add(Number(row.clinica_id));
  const assignments = await m.GroupAssetClinicAssignment.findAll({ ...options, raw: true, attributes: ['clinicaId'],
    where: { assetType: 'google.business_profile', assetId: { [Op.in]: aliasIds } }, limit: 1001 });
  if (assignments.length > 1000) fail('scope_denied');
  for (const row of assignments) affected.add(Number(row.clinicaId));
  // Include groups which use this primary asset even when the request comes
  // from the asset's owning clinic (assignment_origin then says "clinic").
  const groups = await m.GrupoClinica.findAll({ ...options, raw: true, attributes: ['id_grupo'],
    where: { business_profile_assignment_mode: 'group', business_profile_primary_location_id: { [Op.in]: aliasIds } }, limit: 1001 });
  if (groups.length > 1000) fail('scope_denied');
  if (groups.length) {
    const members = await m.Clinica.findAll({ ...options, raw: true, attributes: ['id_clinica'],
      where: { grupoClinicaId: { [Op.in]: groups.map(row => row.id_grupo) } }, limit: 1001 });
    if (members.length > 1000) fail('scope_denied');
    for (const row of members) affected.add(Number(row.id_clinica));
  }
  const clinicIds = [...affected].sort((a, b) => a - b);
  if (clinicIds.length > 1000 || clinicIds.some(id => !positive(id))
    || !await hasMarketingClinicScopeAccess({ userId, clinicIds, access: 'write', membershipModel: wrap(m.UsuarioClinica) })) fail('scope_denied');
  return { location, clinicIds };
}
module.exports = { mutationScope };
