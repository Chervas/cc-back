'use strict';
const { Op } = require('sequelize');
const C = require('./googleOAuthCohort.contract');
const { binding: bindingOf, identity, BINDING_FIELDS, MAPPING_FIELDS } = require('./googleAdsBrokerScope.service');
const revocation = require('./googleAdsRevocation.contract');
const id = value => { if (!C.positive(String(value))) C.fail(); return Number(value); };
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) C.fail(); return rows; };
const active = row => [true, 1].includes(row.isActive);
// Credential renewal may span several customers/groups. Capture all consumers
// of this credential; it never clears read bindings or revocation history.
async function consumers(models, oauthBinding, options) {
  const selected = C.cohortOf(oauthBinding) === 'ads';
  const records = bounded(await models.GoogleAdsBrokerBinding.findAll({ ...options, attributes: BINDING_FIELDS,
    order: [['customer_id', 'ASC'], ['mapping_id', 'ASC']], where: { google_connection_id: id(oauthBinding.google_connection_id) } })).map(bindingOf);
  const customers = [...new Set(records.map(r => r.customer_id))];
  const alternatives = customers.flatMap(value => [value, `${value.slice(0, 3)}-${value.slice(3, 6)}-${value.slice(6)}`]);
  const rows = bounded(await models.ClinicGoogleAdsAccount.findAll({ ...options, attributes: MAPPING_FIELDS, order: [['id', 'ASC']],
    where: { [Op.or]: [{ googleConnectionId: id(oauthBinding.google_connection_id) },
      ...(alternatives.length ? [{ customerId: { [Op.in]: alternatives } }, { id: { [Op.in]: records.map(r => r.mapping_id) } }] : [])] } }));
  if (rows.some(r => ![true, false, 0, 1].includes(r.isActive)) || new Set(rows.map(r => id(r.id))).size !== rows.length
    || new Set(records.map(r => r.customer_id + ':' + r.mapping_id)).size !== records.length) C.fail();
  const history = customers.length ? bounded(await models.GoogleAdsBrokerRevocation.findAll({ ...options,
    attributes: [...revocation.FIELDS, 'state', 'request_id', 'actor_user_id', 'requested_at'], order: [['tuple_hash', 'ASC']],
    where: { customer_id: { [Op.in]: customers } } })).map(revocation.validate) : [];
  const available = []; const usedMappings = new Set(); const controls = [];
  for (const record of records) {
    if (record.google_connection_id !== id(oauthBinding.google_connection_id) || record.google_user_id !== oauthBinding.google_user_id
      || selected && record.connection_ref !== oauthBinding.connection_ref) C.fail();
    const mapping = rows.find(row => id(row.id) === record.mapping_id);
    if (mapping) {
      const owner = identity(mapping);
      if (owner.customerId !== record.customer_id || owner.googleConnectionId !== record.google_connection_id
        || owner.scopeKey !== record.scope_key || owner.loginCustomerId !== record.login_customer_id
        || mapping.broker_read_connection_ref !== record.connection_ref || mapping.broker_read_asset_ref !== record.asset_ref) C.fail();
    }
    const revoked = history.filter(row => Number(row.tenant_clinic_id) === record.tenant_clinic_id
      && row.connection_ref === record.connection_ref && row.asset_ref === record.asset_ref);
    if (revoked.some(row => Number(row.google_connection_id) !== record.google_connection_id || row.google_user_id !== record.google_user_id)) C.fail();
    if (record.state === 'active' && !revoked.length) {
      available.push(record); if (mapping && active(mapping)) usedMappings.add(record.mapping_id);
      if (mapping && active(mapping) && record.asset_ref === oauthBinding.asset_ref && record.tenant_clinic_id === id(oauthBinding.clinica_id)) controls.push(record);
    }
  }
  for (const row of rows.filter(active)) {
    const owner = identity(row); const record = records.find(r => r.mapping_id === owner.id && r.customer_id === owner.customerId);
    if (owner.googleConnectionId !== id(oauthBinding.google_connection_id)) C.fail();
    if (!record) C.fail('google_oauth_consumers_pending');
  }
  if (!selected) return null;
  if (!controls.length) C.fail();
  const groups = [...new Set(available.filter(r => r.scope_key.startsWith('group:')).map(r => id(r.scope_key.split(':')[1])))];
  const clinicOwners = [...new Set(available.flatMap(r => [r.tenant_clinic_id, ...(r.scope_key.startsWith('clinic:') ? [id(r.scope_key.split(':')[1])] : [])]))];
  const clinics = bounded(await models.Clinica.findAll({ ...options, attributes: ['id_clinica', 'grupoClinicaId'], order: [['id_clinica', 'ASC']],
    where: { [Op.or]: [{ id_clinica: { [Op.in]: clinicOwners } }, ...(groups.length ? [{ grupoClinicaId: { [Op.in]: groups } }] : [])] } }));
  const groupIds = [...new Set([...groups, ...clinics.filter(r => r.grupoClinicaId != null).map(r => id(r.grupoClinicaId))])];
  const grants = bounded(await models.GoogleConnectionAssignment.findAll({ ...options,
    attributes: ['id', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status'], order: [['id', 'ASC']],
    where: { [Op.or]: [{ assignmentScope: 'clinic', clinicaId: { [Op.in]: clinics.map(r => id(r.id_clinica)) } },
      ...(groupIds.length ? [{ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groupIds } }] : [])] } }));
  const groupGrant = groupId => grants.filter(r => r.assignmentScope === 'group' && Number(r.grupoClinicaId) === groupId);
  const directGrant = clinicId => grants.filter(r => r.assignmentScope === 'clinic' && Number(r.clinicaId) === clinicId);
  const requireGrant = rows => { if (rows.length !== 1 || rows[0].status !== 'active' || Number(rows[0].googleConnectionId) !== id(oauthBinding.google_connection_id)) C.fail(); };
  const affected = new Set(); const usage = new Set(); const mappingIds = new Set();
  for (const record of available) {
    const ownerId = id(record.scope_key.split(':')[1]); const group = record.scope_key.startsWith('group:');
    const owners = group ? clinics.filter(r => Number(r.grupoClinicaId) === ownerId) : clinics.filter(r => id(r.id_clinica) === ownerId);
    if (!owners.length || !clinics.some(r => id(r.id_clinica) === record.tenant_clinic_id)) C.fail();
    if (group) {
      if (!owners.some(r => id(r.id_clinica) === record.tenant_clinic_id)) C.fail(); requireGrant(groupGrant(ownerId));
      for (const clinic of owners) { const direct = directGrant(id(clinic.id_clinica)); if (direct.length) requireGrant(direct); }
    } else {
      const direct = directGrant(ownerId);
      if (direct.length) requireGrant(direct); else if (owners[0].grupoClinicaId != null) requireGrant(groupGrant(id(owners[0].grupoClinicaId))); else C.fail();
    }
    const ids = [...new Set([record.tenant_clinic_id, ...owners.map(r => id(r.id_clinica))])];
    for (const clinicId of ids) { affected.add(clinicId); if (usedMappings.has(record.mapping_id)) usage.add(clinicId); }
    mappingIds.add(record.mapping_id);
  }
  const shared = bounded(await models.GroupAssetClinicAssignment.findAll({ ...options, attributes: ['assetId', 'clinicaId'], order: [['id', 'ASC']],
    where: { assetType: 'google.ads_account', assetId: { [Op.in]: [...mappingIds] } } }));
  for (const row of shared) {
    if (!mappingIds.has(id(row.assetId))) C.fail(); affected.add(id(row.clinicaId));
    if (usedMappings.has(id(row.assetId))) usage.add(id(row.clinicaId));
  }
  if (!affected.size || affected.size > 1000) C.fail(); return { affected, usage };
}
module.exports = { async consumers(...args) {
  try { return await consumers(...args); } catch (error) {
    C.fail(error?.code === 'google_oauth_consumers_pending' ? error.code : 'google_oauth_scope_conflict');
  }
} };
