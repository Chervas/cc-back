'use strict';
const { createHash } = require('node:crypto');
const { Op, literal } = require('sequelize');
const contract = require('../../services/integrations-broker/src/google-ads-contract');
const revocations = require('./googleAdsRevocation.contract');
const positive = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 2147483647;
const fail = (code = 'broker_binding_invalid') => { throw Object.assign(Error(code), { code }); };
const ref = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const marked = row => row?.broker_read_connection_ref != null || row?.broker_read_asset_ref != null;
const MAPPING_FIELDS = ['id', 'customerId', 'googleConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId',
  'isActive', 'loginCustomerId', 'managerCustomerId', 'broker_read_connection_ref', 'broker_read_asset_ref'];
const BINDING_FIELDS = ['customer_id', 'mapping_id', 'google_connection_id', 'google_user_id', 'connection_ref', 'asset_ref',
  'scope_key', 'tenant_clinic_id', 'login_customer_id', 'state'];
function customer(value) {
  if (typeof value !== 'string' || !/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(value)) fail();
  const id = value.replace(/-/g, ''); if (!contract.customer(id)) fail(); return id;
}
function scopeOf(row) {
  if (!['clinic', 'group'].includes(row?.assignmentScope)) fail();
  const id = row.assignmentScope === 'group' ? row.grupoClinicaId : row.clinicaId;
  if (!positive(id)) fail(); return `${row.assignmentScope}:${Number(id)}`;
}
function identity(row) {
  if (!positive(row?.id) || !positive(row.googleConnectionId)
    || row.clinicaId != null && !positive(row.clinicaId) || row.grupoClinicaId != null && !positive(row.grupoClinicaId)) fail();
  return { id: Number(row.id), customerId: customer(row.customerId), googleConnectionId: Number(row.googleConnectionId),
    scopeKey: scopeOf(row), clinicId: row.clinicaId == null ? null : Number(row.clinicaId),
    groupId: row.grupoClinicaId == null ? null : Number(row.grupoClinicaId),
    loginCustomerId: row.loginCustomerId != null ? customer(row.loginCustomerId)
      : row.managerCustomerId != null ? customer(row.managerCustomerId) : null };
}
function binding(row) {
  if (!row || !contract.customer(row.customer_id) || !positive(row.mapping_id) || !positive(row.google_connection_id)
    || !positive(row.tenant_clinic_id) || !ref(row.connection_ref) || row.asset_ref !== 'ads:' + row.customer_id
    || !/^(clinic|group):[1-9]\d{0,9}$/.test(row.scope_key || '') || !positive(row.scope_key.split(':')[1])
    || typeof row.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.google_user_id) || row.google_user_id === 'unknown'
    || row.login_customer_id !== null && !contract.customer(row.login_customer_id) || !['active', 'blocked'].includes(row.state)) fail();
  return Object.fromEntries(BINDING_FIELDS.map(key => [key, ['mapping_id', 'google_connection_id', 'tenant_clinic_id'].includes(key) ? Number(row[key]) : row[key]]));
}
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) fail(); return rows; };
const sortedIds = rows => {
  if (rows.some(id => !positive(id))) fail();
  return [...new Set(rows.map(Number))].sort((a, b) => a - b);
};
function createGoogleAdsBrokerScope({ loadMapping, loadBindings, loadMappings, loadConnection, loadClinics, loadShared, loadGrants, loadRevocations,
  enabled = () => process.env.GOOGLE_ADS_BROKER_ENABLED === 'true' }) {
  const contexts = new WeakMap();
  async function inspect(hint, expected, transaction) {
    const requested = identity(hint);
    const current = await loadMapping(requested.id, transaction);
    // Read the independent registry even if the mapping has disappeared.
    const records = bounded(await loadBindings(requested.customerId, requested.id, transaction)).map(binding);
    const history = bounded(await loadRevocations(requested.customerId, transaction)).map(revocations.validate);
    if (history.some(row => row.customer_id !== requested.customerId)) fail();
    if (!records.length && history.length) fail('asset_revoked');
    if (!current || ![true, 1].includes(current.isActive) || digest(identity(current)) !== digest(requested)) fail();
    if (!records.length && !marked(current) && !expected) return null;
    if (records.some(row => row.customer_id !== requested.customerId)) fail();
    const matches = records.filter(row => row.mapping_id === requested.id);
    if (matches.length !== 1) fail(); const selected = matches[0];
    if (selected.state !== 'active' || history.some(row => Number(row.tenant_clinic_id) === selected.tenant_clinic_id
      && row.connection_ref === selected.connection_ref && row.asset_ref === selected.asset_ref)) fail('asset_revoked');
    if (selected.scope_key !== requested.scopeKey || current.broker_read_connection_ref !== selected.connection_ref
      || current.broker_read_asset_ref !== selected.asset_ref) fail();
    const mappings = bounded(await loadMappings(requested.customerId, transaction));
    if (mappings.some(row => !positive(row?.id) || customer(row.customerId) !== requested.customerId
      || ![true, false, 0, 1].includes(row.isActive))) fail();
    const active = mappings.filter(row => [true, 1].includes(row.isActive));
    if (!active.length || new Set(mappings.map(row => Number(row.id))).size !== mappings.length) fail();
    if (active.filter(row => Number(row.id) === requested.id).length !== 1) fail();
    if (digest(identity(active.find(row => Number(row.id) === requested.id))) !== digest(requested)) fail();
    const clinics = bounded(await loadClinics(requested, transaction));
    const allowedIds = sortedIds(clinics.map(row => row.id_clinica));
    if (!allowedIds.length || clinics.length !== allowedIds.length || !allowedIds.includes(selected.tenant_clinic_id)) fail();
    if (requested.scopeKey.startsWith('clinic:') && (allowedIds.length !== 1 || allowedIds[0] !== requested.clinicId)
      || requested.groupId != null && clinics.some(row => Number(row.grupoClinicaId) !== requested.groupId)) fail();
    const allowed = new Set(allowedIds);
    for (const record of records) {
      if (record.google_connection_id !== requested.googleConnectionId || record.connection_ref !== selected.connection_ref
        || record.google_user_id !== selected.google_user_id || record.tenant_clinic_id !== selected.tenant_clinic_id
        || record.login_customer_id !== requested.loginCustomerId) fail();
      if (record.scope_key.startsWith('group:') ? record.scope_key !== requested.scopeKey
        : !allowed.has(Number(record.scope_key.split(':')[1]))) fail('scope_denied');
    }
    const usedBindings = [];
    for (const row of active) {
      const owner = identity(row); const candidates = records.filter(item => item.mapping_id === owner.id);
      if (candidates.length !== 1) fail(); const record = candidates[0];
      if (record.state !== 'active') fail('asset_revoked');
      if (owner.customerId !== requested.customerId || owner.googleConnectionId !== requested.googleConnectionId
        || owner.loginCustomerId !== requested.loginCustomerId || record.google_connection_id !== owner.googleConnectionId
        || record.scope_key !== owner.scopeKey || record.login_customer_id !== owner.loginCustomerId
        || record.connection_ref !== selected.connection_ref || record.google_user_id !== selected.google_user_id
        || record.tenant_clinic_id !== selected.tenant_clinic_id
        || row.broker_read_connection_ref !== record.connection_ref || row.broker_read_asset_ref !== record.asset_ref) fail();
      if (owner.scopeKey.startsWith('group:') ? owner.scopeKey !== requested.scopeKey : !allowed.has(owner.clinicId)) fail('scope_denied');
      usedBindings.push(record);
    }
    // A removed mapping's blocked tuple cannot be bypassed by a surviving alias.
    if (records.some(row => row.state === 'blocked' && row.connection_ref === selected.connection_ref
      && row.tenant_clinic_id === selected.tenant_clinic_id)) fail('asset_revoked');
    const ids = sortedIds([...mappings.map(row => row.id), ...records.map(row => row.mapping_id)]);
    if (ids.length > 1000) fail();
    const shared = bounded(await loadShared(ids, transaction));
    if (shared.some(row => !positive(row.assetId) || !ids.includes(Number(row.assetId))
      || !positive(row.clinicaId) || !allowed.has(Number(row.clinicaId)))) fail('scope_denied');
    const grants = bounded(await loadGrants(requested, allowedIds, transaction));
    if (grants.some(row => !positive(row.id) || !positive(row.googleConnectionId)
      || !['clinic', 'group'].includes(row.assignmentScope))) fail();
    const matching = (scope, id) => grants.filter(row => row.assignmentScope === scope
      && Number(scope === 'group' ? row.grupoClinicaId : row.clinicaId) === id);
    const assertGrant = rows => {
      if (rows.length !== 1 || rows[0].status !== 'active' || Number(rows[0].googleConnectionId) !== requested.googleConnectionId) fail('scope_denied');
    };
    if (requested.scopeKey.startsWith('group:')) {
      assertGrant(matching('group', requested.groupId));
      for (const id of allowedIds) { const direct = matching('clinic', id); if (direct.length) assertGrant(direct); }
    } else {
      const direct = matching('clinic', requested.clinicId);
      if (direct.length) assertGrant(direct); else if (requested.groupId != null) assertGrant(matching('group', requested.groupId)); else fail('scope_denied');
    }
    const connection = await loadConnection(requested.googleConnectionId, selected.google_user_id, transaction);
    if (!connection || Number(connection.id) !== requested.googleConnectionId || connection.googleUserId !== selected.google_user_id
      || Number(connection.credentials_external) !== 1) fail();
    const capture = { ...requested, connectionRef: selected.connection_ref, assetRef: selected.asset_ref,
      tenantRef: `clinic:${selected.tenant_clinic_id}`, googleSubject: selected.google_user_id, clinicIds: allowedIds,
      bindingsHash: digest(usedBindings.sort((a, b) => a.mapping_id - b.mapping_id)),
      mappingsHash: digest(active.map(identity).sort((a, b) => a.id - b.id)),
      sharedHash: digest(shared.map(row => [Number(row.assetId), Number(row.clinicaId)]).sort()),
      grantsHash: digest(grants.map(row => [row.id, row.assignmentScope, row.clinicaId, row.grupoClinicaId, row.googleConnectionId, row.status]).sort()) };
    if (expected && digest(capture) !== digest(expected)) fail();
    if (!enabled()) fail('broker_cohort_disabled'); return capture;
  }
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (error) {
      fail(['broker_binding_invalid', 'scope_denied', 'asset_revoked', 'broker_cohort_disabled'].includes(error?.code) ? error.code : 'broker_binding_invalid');
    }
  };
  const assertContext = guarded(async (context, { transaction } = {}) => {
    const saved = context && typeof context === 'object' && contexts.get(context); if (!saved) fail();
    return inspect(saved.hint, saved.captured, transaction);
  });
  return { assertContext, prepare: guarded(async mapping => {
    const hint = Object.fromEntries(MAPPING_FIELDS.map(key => [key, mapping?.[key] ?? null]));
    const captured = await inspect(hint); if (!captured) return null;
    const context = Object.freeze({}); contexts.set(context, { hint, captured }); return context;
  }) };
}
function createGoogleAdsScopeRepository(getModels) {
  const options = { raw: true, logging: false, limit: 1001 };
  const locked = transaction => transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
  return {
    loadRevocations: (id, transaction) => getModels().GoogleAdsBrokerRevocation.findAll({ ...options, ...locked(transaction),
      attributes: [...revocations.FIELDS, 'state', 'request_id', 'actor_user_id', 'requested_at'], order: [['tuple_hash', 'ASC']], where: { customer_id: id } }),
    loadMapping: (id, transaction) => getModels().ClinicGoogleAdsAccount.findByPk(id, { attributes: MAPPING_FIELDS, raw: true, logging: false, ...locked(transaction) }),
    loadBindings: (id, mappingId, transaction) => getModels().GoogleAdsBrokerBinding.findAll({ ...options, ...locked(transaction), attributes: BINDING_FIELDS, order: [['customer_id', 'ASC'], ['mapping_id', 'ASC']],
      where: { [Op.or]: [{ customer_id: id }, { mapping_id: mappingId }] } }),
    loadMappings: (id, transaction) => getModels().ClinicGoogleAdsAccount.findAll({ ...options, ...locked(transaction), attributes: MAPPING_FIELDS, order: [['id', 'ASC']],
      where: { customerId: { [Op.in]: [id, `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`] } } }),
    loadClinics: (owner, transaction) => getModels().Clinica.findAll({ ...options, ...locked(transaction), attributes: ['id_clinica', 'grupoClinicaId'], order: [['id_clinica', 'ASC']],
      where: owner.scopeKey.startsWith('group:') ? { grupoClinicaId: owner.groupId } : { id_clinica: owner.clinicId } }),
    loadShared: (ids, transaction) => getModels().GroupAssetClinicAssignment.findAll({ ...options, ...locked(transaction), attributes: ['assetId', 'clinicaId'], order: [['id', 'ASC']],
      where: { assetType: 'google.ads_account', assetId: { [Op.in]: ids } } }),
    loadGrants: (owner, clinicIds, transaction) => getModels().GoogleConnectionAssignment.findAll({ ...options, ...locked(transaction), order: [['id', 'ASC']],
      attributes: ['id', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status'],
      where: { [Op.or]: [{ assignmentScope: 'clinic', clinicaId: { [Op.in]: clinicIds } },
        ...(owner.groupId != null ? [{ assignmentScope: 'group', grupoClinicaId: owner.groupId }] : [])] } }),
    loadConnection: async (id, subject, transaction) => {
      const rows = await getModels().GoogleConnection.findAll({ attributes: ['id', 'googleUserId',
        [literal('(accessToken IS NULL AND refreshToken IS NULL)'), 'credentials_external']],
      where: { [Op.or]: [{ id }, { googleUserId: subject }] }, limit: 2, raw: true, logging: false, ...locked(transaction) });
      return rows.length === 1 ? rows[0] : null;
    },
  };
}
module.exports = { createGoogleAdsBrokerScope, createGoogleAdsScopeRepository, MAPPING_FIELDS, BINDING_FIELDS, customer, scopeOf, identity, binding, positive };
