'use strict';
const { Op } = require('sequelize');
const { isGlobalAdmin, MARKETING_WRITE_ROLES } = require('../lib/role-helpers');
const C = require('./googleOAuthCohort.contract');
const properties = require('./googlePropertyRevocation.contract');
const SPECS = Object.freeze({ ...properties.KINDS, business_profile: {
  model: 'BusinessProfileBrokerBinding', mappingModel: 'ClinicBusinessLocation',
  modeField: 'business_profile_assignment_mode', primaryField: 'business_profile_primary_location_id',
} });
const live = row => ['active', 'reauthorization_required'].includes(row?.status);
const id = value => { if (!C.positive(String(value))) C.fail(); return Number(value); };
const bounded = async promise => { const rows = await promise; if (!Array.isArray(rows) || rows.length > 1000) C.fail(); return rows; };
const optionsFor = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false, limit: 1001 });
async function permission(models, actorId, clinicIds, options) {
  if (isGlobalAdmin(actorId)) return;
  const rows = await bounded(models.UsuarioClinica.findAll({ ...options, attributes: ['id_clinica'], where: {
    id_usuario: id(actorId), id_clinica: { [Op.in]: clinicIds }, rol_clinica: { [Op.in]: MARKETING_WRITE_ROLES },
    [Op.or]: [{ estado_invitacion: null }, { estado_invitacion: 'aceptada' }],
  } }));
  if (clinicIds.some(clinicId => !rows.some(row => id(row.id_clinica) === clinicId))) C.fail('google_oauth_scope_forbidden', 403);
}
async function connectionMetadata(models, connectionId, subject, transaction) {
  // Only the NULL predicate is read. Neither credential is ever materialized.
  const [rows] = await models.sequelize.query('SELECT id, googleUserId, (accessToken IS NULL AND refreshToken IS NULL) AS credentials_external '
    + 'FROM GoogleConnections WHERE id=:id OR googleUserId=:subject LIMIT 1001 FOR UPDATE',
  { replacements: { id: id(connectionId), subject }, transaction, logging: false });
  if (rows.length !== 1 || id(rows[0].id) !== id(connectionId) || rows[0].googleUserId !== subject || Number(rows[0].credentials_external) !== 1) C.fail();
}
async function authorizeConnection({ models, connectionId, subject, requestScopeKey, actorId, sessionRef, expiresAt, transaction, sessions }) {
  if (!transaction) C.fail(); id(actorId);
  await sessions.verifyReference({ userId: id(actorId), sessionRef, expiresAt }, { transaction });
  const options = optionsFor(transaction); const scope = C.requestedScope(requestScopeKey);
  await connectionMetadata(models, connectionId, subject, transaction);
  const clinics = await bounded(models.Clinica.findAll({ ...options, attributes: ['id_clinica', 'grupoClinicaId'],
    where: scope.type === 'clinic' ? { id_clinica: scope.id } : { grupoClinicaId: scope.id }, order: [['id_clinica', 'ASC']] }));
  if (!clinics.length || scope.type === 'clinic' && clinics.length !== 1) C.fail();
  const clinicIds = clinics.map(row => id(row.id_clinica));
  const candidates = [requestScopeKey];
  if (scope.type === 'clinic' && clinics[0].grupoClinicaId != null) candidates.push('group:' + id(clinics[0].grupoClinicaId));
  const assignments = await bounded(models.GoogleConnectionAssignment.findAll({ ...options,
    attributes: ['scopeKey', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status'],
    where: { scopeKey: { [Op.in]: candidates } } }));
  // An explicit disconnected/revoked override stops group inheritance.
  const assignment = candidates.map(key => assignments.filter(row => row.scopeKey === key)).find(rows => rows.length);
  if (!assignment || assignment.length !== 1 || !live(assignment[0]) || id(assignment[0].googleConnectionId) !== id(connectionId)) C.fail();
  const selected = C.requestedScope(assignment[0].scopeKey);
  if (assignment[0].assignmentScope !== selected.type || id(selected.type === 'clinic' ? assignment[0].clinicaId : assignment[0].grupoClinicaId) !== selected.id) C.fail();
  await permission(models, actorId, clinicIds, options);
  return { clinicIds, options };
}
async function consumers(models, kind, binding, options) {
  const spec = SPECS[kind]; const gbp = kind === 'business_profile';
  const selected = kind === C.cohortOf(binding);
  const connectionField = gbp ? 'google_connection_id' : 'googleConnectionId';
  const clinicField = gbp ? 'clinica_id' : 'clinicaId'; const activeField = gbp ? 'is_active' : 'isActive';
  const resourceField = gbp ? 'location_id' : spec.mappingResourceField;
  const records = await bounded(models[spec.model].findAll({ ...options, where: { [Op.or]: [
    { google_connection_id: id(binding.google_connection_id) }, ...(!gbp ? [{ google_user_id: binding.google_user_id }] : []),
    ...(selected ? [{ connection_ref: binding.connection_ref }] : []),
  ] } }));
  const mappings = await bounded(models[spec.mappingModel].findAll({ ...options, attributes: ['id', clinicField, connectionField, activeField,
    resourceField, 'broker_read_connection_ref', 'broker_read_asset_ref'], where: { [Op.or]: [
    { [connectionField]: id(binding.google_connection_id) }, ...(selected ? [{ broker_read_connection_ref: binding.connection_ref }] : []),
  ] } }));
  const tombstones = !records.length ? [] : gbp
    ? await bounded(models.BusinessProfileBrokerRevocation.findAll({ ...options, attributes: ['external_location_id'],
      where: { external_location_id: { [Op.in]: records.map(record => record.external_location_id) } } }))
    : await bounded(models.GooglePropertyBrokerRevocation.findAll({ ...options,
      where: { tuple_hash: { [Op.in]: records.map(record => properties.fromBinding(kind, record).tuple_hash) } } }));
  if (!gbp) for (const tombstone of tombstones) properties.validate(tombstone);
  const controls = []; const affected = new Set(); const usage = new Set(); const mappingIds = new Set(); const activeMappingIds = new Set();
  for (const record of records) {
    if (id(record.google_connection_id) !== id(binding.google_connection_id) || !gbp && record.google_user_id !== binding.google_user_id
      || selected && record.connection_ref !== binding.connection_ref) C.fail();
    let matching;
    if (gbp) {
      C.validate({ ...binding, ...record, cohort: 'business_profile', scope_key: 'connection:' + id(binding.google_connection_id), policy_version: C.POLICY });
      if (String(record.external_location_id) !== record.asset_ref.split(':')[2]) C.fail();
      matching = mappings.filter(row => /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(String(row.location_id))?.[1] === record.external_location_id);
    } else {
      properties.fromBinding(kind, record); matching = mappings.filter(row => id(row.id) === id(record.mapping_id));
    }
    // A surviving registry still owns its original authority. A reused mapping
    // ID or a changed identity cannot be accepted as a replacement.
    for (const mapping of matching) {
      if (id(mapping[clinicField]) !== id(record.clinica_id) || id(mapping[connectionField]) !== id(record.google_connection_id)
        || mapping.broker_read_connection_ref !== record.connection_ref || mapping.broker_read_asset_ref !== record.asset_ref
        || !gbp && mapping[resourceField] !== record[spec.resourceField]) C.fail();
    }
    const revocations = tombstones.filter(row => gbp ? row.external_location_id === record.external_location_id
      : row.kind === kind && id(row.clinica_id) === id(record.clinica_id) && row.connection_ref === record.connection_ref && row.asset_ref === record.asset_ref);
    if (!gbp) for (const revoked of revocations) {
      properties.validate(revoked);
      if (id(revoked.google_connection_id) !== id(record.google_connection_id) || revoked.google_user_id !== record.google_user_id) C.fail();
    }
    const available = !revocations.length && (gbp || record.state === 'active');
    if (selected && available) {
      affected.add(id(record.clinica_id));
      if (!gbp) mappingIds.add(id(record.mapping_id));
      for (const mapping of matching) mappingIds.add(id(mapping.id));
      for (const mapping of matching.filter(mapping => mapping[activeField])) {
        usage.add(id(mapping[clinicField])); activeMappingIds.add(id(mapping.id));
      }
      if (record.asset_ref === binding.asset_ref && id(record.clinica_id) === id(binding.clinica_id)
        && matching.some(mapping => mapping[activeField])) controls.push(record);
    }
  }
  for (const mapping of mappings.filter(row => row[activeField])) {
    if (id(mapping[connectionField]) !== id(binding.google_connection_id)) C.fail();
    const record = records.find(row => (gbp
      ? row.asset_ref === mapping.broker_read_asset_ref && id(row.clinica_id) === id(mapping[clinicField])
      : id(row.mapping_id) === id(mapping.id)));
    if (!record) C.fail('google_oauth_consumers_pending');
    if (mapping.broker_read_connection_ref !== record.connection_ref || mapping.broker_read_asset_ref !== record.asset_ref
      || id(mapping[clinicField]) !== id(record.clinica_id)
      || (gbp ? /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(String(mapping[resourceField]))?.[1] !== record.external_location_id
        : mapping[resourceField] !== record[spec.resourceField])) C.fail();
  }
  if (!selected) return null;
  if (!controls.length) C.fail();
  if (mappingIds.size) {
    const ids = [...mappingIds];
    const shared = await bounded(models.GroupAssetClinicAssignment.findAll({ ...options,
      attributes: ['clinicaId', 'assetId'], where: { assetType: 'google.' + kind, assetId: { [Op.in]: ids } } }));
    for (const row of shared) { affected.add(id(row.clinicaId)); if (activeMappingIds.has(id(row.assetId))) usage.add(id(row.clinicaId)); }
    const groups = await bounded(models.GrupoClinica.findAll({ ...options,
      attributes: ['id_grupo', spec.primaryField], where: { [spec.modeField]: 'group', [spec.primaryField]: { [Op.in]: ids } } }));
    if (groups.length) {
      const activeGroups = new Set(groups.filter(group => activeMappingIds.has(id(group[spec.primaryField]))).map(group => id(group.id_grupo)));
      const members = await bounded(models.Clinica.findAll({ ...options, attributes: ['id_clinica', 'grupoClinicaId'],
        where: { grupoClinicaId: { [Op.in]: groups.map(row => id(row.id_grupo)) } } }));
      for (const row of members) { affected.add(id(row.id_clinica)); if (activeGroups.has(id(row.grupoClinicaId))) usage.add(id(row.id_clinica)); }
    }
  }
  if (!affected.size || affected.size > 1000) C.fail();
  return { affected, usage };
}
async function authorize({ models, binding, requestScopeKey, actorId, sessionRef, expiresAt, expectedClinicIds, transaction, sessions }) {
  C.validate(binding); if (binding.policy_version !== C.POLICY || !transaction) C.fail();
  const options = optionsFor(transaction);
  const fresh = await models.GoogleOAuthBrokerBinding.findOne({ ...options, where: C.keyFor(binding) });
  if (!fresh || C.digest(fresh) !== C.digest(binding)) C.fail();
  const requested = await authorizeConnection({ models, connectionId: binding.google_connection_id, subject: binding.google_user_id,
    requestScopeKey, actorId, sessionRef, expiresAt, transaction, sessions });
  let selected = await require('./googleAdsOAuthScope.service').consumers(models, binding, options);
  for (const kind of Object.keys(SPECS)) {
    const result = await consumers(models, kind, binding, options); if (result) selected = result;
  }
  if (!selected || !requested.clinicIds.some(clinicId => selected.usage.has(clinicId))) C.fail('google_oauth_scope_forbidden', 403);
  const clinicIds = [...new Set([...selected.affected, ...requested.clinicIds])].sort((a, b) => a - b);
  if (clinicIds.length > 1000 || expectedClinicIds && JSON.stringify(clinicIds) !== JSON.stringify(expectedClinicIds)) C.fail();
  const clinics = await bounded(models.Clinica.findAll({ ...options, attributes: ['id_clinica'], where: { id_clinica: { [Op.in]: clinicIds } } }));
  if (clinics.length !== clinicIds.length) C.fail();
  await permission(models, actorId, clinicIds, options);
  return { binding: fresh, clinicIds };
}
module.exports = { authorize, authorizeConnection };
