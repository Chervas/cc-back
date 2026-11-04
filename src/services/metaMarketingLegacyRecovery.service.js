'use strict';
// Explicit, pinned replacement of a legacy non-WA generation. This never opens
// the legacy transport, changes a scope tombstone, or reads an SQL credential.
const { createHash } = require('node:crypto');
const { Op, literal } = require('sequelize');
const C = require('./metaMarketingOAuth.contract');
const POSITIVE = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ['prepared', 'flow_bound', 'active', 'retired'];
const fail = (code = 'meta_recovery_changed') => { throw Object.assign(Error(code), { code, httpStatus: 409 }); };
const plain = value => value?.get ? value.get({ plain: true }) : value;
const hash = value => createHash('sha256').update(value).digest('hex');
const ALIAS_FIELDS = Object.freeze(['id', 'metaConnectionId', 'assetType', 'metaAssetId', 'assignmentScope', 'clinicaId', 'grupoClinicaId',
  'isActive', 'whatsappAuthorizationId', 'page_credential_present', 'page_credential_sha256', 'wa_credential_present', 'wa_credential_sha256',
  'additional_data_present', 'additional_data_sha256']);
const CONNECTION_FIELDS = Object.freeze(['id', 'userId', 'metaUserId', 'broker_app_id', 'credentials_external', 'credential_present', 'credential_sha256']);
const ASSIGNMENT_FIELDS = Object.freeze(['id', 'scopeKey', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'metaConnectionId', 'status', 'updated_at']);
const GROUP_FIELDS = Object.freeze(['id_grupo', 'facebook_assignment_mode', 'facebook_primary_asset_id', 'instagram_assignment_mode',
  'instagram_primary_asset_id', 'ads_assignment_mode', 'ads_assignment_delimiter']);
const BLOCK_FIELDS = Object.freeze(['scope_key', 'reason', 'connection_id', 'actor_user_id', 'created_at']);
const SHARE_FIELDS = Object.freeze(['id', 'assetId', 'assetType', 'clinicaId', 'grupoClinicaId']);
const CLINIC_FIELDS = Object.freeze(['id_clinica', 'grupoClinicaId']);
const FIELDS = Object.freeze({ aliases: ALIAS_FIELDS, connections: CONNECTION_FIELDS, assignments: ASSIGNMENT_FIELDS,
  groups: GROUP_FIELDS, blocks: BLOCK_FIELDS, shares: SHARE_FIELDS, clinics: CLINIC_FIELDS });
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'number' && !Number.isFinite(value)) fail('meta_recovery_invalid');
  return value;
}
const encode = value => JSON.stringify(canonical(value));
function exact(value, keys) { return value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === keys.slice().sort().join(','); }
function ids(value) {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some((v, i) => !POSITIVE(v) || i && v <= value[i - 1])) fail('meta_recovery_invalid');
  return value.slice();
}
function normalizeRows(rows, fields, key) {
  if (!Array.isArray(rows) || rows.length > 2000) fail('meta_recovery_invalid');
  const result = rows.map(value => {
    const row = plain(value), out = {};
    for (const field of fields) {
      if (!Object.hasOwn(row, field)) fail('meta_recovery_invalid');
      let item = row[field];
      if (item instanceof Date) item = item.toISOString();
      if (typeof item === 'boolean') item = Number(item);
      if (field.endsWith('_present') || field === 'isActive' || field === 'credentials_external') {
        if (![0, 1].includes(Number(item))) fail('meta_recovery_invalid'); item = Number(item);
      }
      if (field.endsWith('_sha256') && item !== null && !HASH.test(item)) fail('meta_recovery_invalid');
      if (item !== null && !['string', 'number'].includes(typeof item)) fail('meta_recovery_invalid');
      out[field] = item;
    }
    return out;
  });
  result.sort((a, b) => typeof a[key] === 'number' && typeof b[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key])));
  if (new Set(result.map(row => String(row[key]))).size !== result.length) fail('meta_recovery_invalid');
  return result;
}
function normalizeInventory(input) {
  if (!exact(input, Object.keys(FIELDS))) fail('meta_recovery_invalid');
  const key = { clinics: 'id_clinica', blocks: 'scope_key', connections: 'id', aliases: 'id', assignments: 'id', shares: 'id', groups: 'id_grupo' };
  return Object.fromEntries(Object.entries(FIELDS).map(([name, fields]) => [name, normalizeRows(input[name], fields, key[name])]));
}
function aliasMetadata(alias, connectionId = alias.metaConnectionId, scopeKey = null) {
  const [type, raw] = scopeKey ? scopeKey.split(':') : [];
  return { id: Number(alias.id), metaConnectionId: connectionId, assetType: alias.assetType, metaAssetId: alias.metaAssetId,
    assignmentScope: scopeKey ? type : alias.assignmentScope, clinicaId: scopeKey ? (type === 'clinic' ? Number(raw) : null) : alias.clinicaId,
    grupoClinicaId: scopeKey ? (type === 'group' ? Number(raw) : null) : alias.grupoClinicaId,
    isActive: scopeKey ? 1 : Number(alias.isActive),
    credentials_absent: Number(!alias.page_credential_present && !alias.wa_credential_present && !alias.additional_data_present) };
}
function validateSnapshot(input) {
  if (!exact(input, ['version', 'scopeKey', 'clinicIds', 'sourceConnectionId', 'appId', 'subjectId', 'actorId', 'mappingIds', 'inventory'])
    || input.version !== 1 || !/^(clinic|group):[1-9][0-9]{0,9}$/.test(input.scopeKey) || !POSITIVE(Number(input.scopeKey.split(':')[1]))
    || !POSITIVE(input.sourceConnectionId) || !POSITIVE(input.actorId) || !/^[1-9][0-9]{0,29}$/.test(input.appId)
    || !/^[1-9][0-9]{0,29}$/.test(input.subjectId)) fail('meta_recovery_invalid');
  const clinicIds = ids(input.clinicIds), mappingIds = ids(input.mappingIds), inventory = normalizeInventory(input.inventory);
  if (JSON.stringify(inventory.clinics.map(row => Number(row.id_clinica))) !== JSON.stringify(clinicIds)
    || input.scopeKey.startsWith('clinic:') && (clinicIds.length !== 1 || input.scopeKey !== 'clinic:' + clinicIds[0])) fail('meta_recovery_invalid');
  const source = inventory.connections.find(row => Number(row.id) === input.sourceConnectionId);
    if (!source || inventory.connections.length !== 1 || source.metaUserId !== input.subjectId || source.credentials_external !== 0
      || source.broker_app_id !== null || source.credential_present !== 1 || !HASH.test(source.credential_sha256)) fail('meta_recovery_invalid');
  for (const mappingId of mappingIds) {
    const alias = inventory.aliases.find(row => Number(row.id) === mappingId);
    // This first recovery cohort is Ads only. Existing page/WA tokens are not
    // an admissible source of credentials or candidates for adoption.
    if (!alias || alias.assetType !== 'ad_account' || !/^(?:act_)?[1-9][0-9]{0,29}$/.test(alias.metaAssetId)
      || Number(alias.metaConnectionId) !== input.sourceConnectionId || ![0, 1].includes(Number(alias.isActive)) || !aliasMetadata(alias).credentials_absent
      || alias.whatsappAuthorizationId !== null || alias.grupoClinicaId !== (input.scopeKey.startsWith('group:') ? Number(input.scopeKey.split(':')[1]) : null)
      || alias.clinicaId !== null && !clinicIds.includes(Number(alias.clinicaId))) fail('meta_recovery_invalid');
  }
  return canonical({ ...input, clinicIds, mappingIds, inventory });
}
function snapshotRecord(row) {
  const value = plain(row); let snapshot, clinicIds, mappingIds;
  try { snapshot = validateSnapshot(JSON.parse(value.snapshot)); clinicIds = ids(JSON.parse(value.clinic_ids)); mappingIds = ids(JSON.parse(value.mapping_ids)); } catch { fail('meta_recovery_invalid'); }
  if (!C.UUID.test(value.recovery_id) || !STATES.includes(value.state) || !HASH.test(value.snapshot_digest) || hash(encode(snapshot)) !== value.snapshot_digest
    || value.snapshot !== encode(snapshot) || JSON.stringify(clinicIds) !== value.clinic_ids || JSON.stringify(mappingIds) !== value.mapping_ids
    || snapshot.scopeKey !== value.scope_key || snapshot.sourceConnectionId !== Number(value.source_connection_id)
    || snapshot.actorId !== Number(value.prepared_by_user_id) || snapshot.appId !== value.app_id || snapshot.subjectId !== value.meta_user_id
    || JSON.stringify(snapshot.clinicIds) !== value.clinic_ids || JSON.stringify(snapshot.mappingIds) !== value.mapping_ids
    || !(value.prepared_at instanceof Date) || !(value.expires_at instanceof Date) || !Number.isFinite(+value.prepared_at)
    || !Number.isFinite(+value.expires_at) || +value.expires_at <= +value.prepared_at || +value.expires_at - +value.prepared_at > 3600000
    || value.canonical_connection_id !== null && (!POSITIVE(Number(value.canonical_connection_id)) || Number(value.canonical_connection_id) === Number(value.source_connection_id))) fail('meta_recovery_invalid');
  for (const field of ['flow_id', 'enrollment_id']) if (value[field] !== null && !C.UUID.test(value[field])) fail('meta_recovery_invalid');
  if (value.candidate_digest !== null && !HASH.test(value.candidate_digest)) fail('meta_recovery_invalid');
  if (['flow_bound', 'active'].includes(value.state) && (!value.flow_id || !value.candidate_digest || !(value.bound_at instanceof Date))) fail('meta_recovery_invalid');
  if (value.state === 'prepared' && (value.flow_id || value.candidate_digest || value.enrollment_id || value.canonical_connection_id)) fail('meta_recovery_invalid');
  if (value.state === 'active' && (!value.enrollment_id || !value.canonical_connection_id || !(value.activated_at instanceof Date))) fail('meta_recovery_invalid');
  return { ...value, snapshot, clinicIds, mappingIds };
}
const digestAttributes = (field, prefix) => [[literal(`(${field} IS NOT NULL)`), prefix + '_present'],
  [literal(`IF(${field} IS NULL,NULL,SHA2(CAST(${field} AS CHAR),256))`), prefix + '_sha256']];
const CONNECTION_ATTRIBUTES = Object.freeze(['id', 'userId', 'metaUserId', 'broker_app_id', 'credentials_external', ...digestAttributes('accessToken', 'credential')]);
const ALIAS_ATTRIBUTES = Object.freeze(['id', 'metaConnectionId', 'assetType', 'metaAssetId', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive', 'whatsappAuthorizationId',
  ...digestAttributes('pageAccessToken', 'page_credential'), ...digestAttributes('waAccessToken', 'wa_credential'), ...digestAttributes('additionalData', 'additional_data')]);
function createRecovery({ models, sessions, now = () => new Date(), enabled = () => process.env.META_MARKETING_LEGACY_RECOVERY_ENABLED === 'true',
  isDevelopment = () => process.env.JOB_RUNTIME_NAMESPACE === 'dev' }) {
  const model = models.MetaMarketingRecovery;
  const options = transaction => {
    if (!transaction?.LOCK?.UPDATE || transaction.finished) fail('meta_recovery_transaction_required');
    return { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
  };
  async function inspectInventory(descriptor, transaction, canonicalConnectionId = null, phase = 'archive') {
    const o = options(transaction), [kind, rawId] = descriptor.scopeKey.split(':'), scopeId = Number(rawId);
    const clinics = await models.Clinica.findAll({ ...o, attributes: CLINIC_FIELDS, where: kind === 'group' ? { grupoClinicaId: scopeId } : { id_clinica: scopeId }, order: [['id_clinica', 'ASC']], limit: 1001 });
    const groupIds = [...new Set(clinics.map(row => Number(row.grupoClinicaId)).filter(POSITIVE))];
    const scopeKeys = [...new Set([descriptor.scopeKey, ...descriptor.clinicIds.map(id => 'clinic:' + id), ...groupIds.map(id => 'group:' + id)])];
    const keys = [...scopeKeys, ...scopeKeys.map(key => 'meta:' + key)];
    const blocks = await models.MetaScopeBlock.findAll({ ...o, attributes: BLOCK_FIELDS, where: { scope_key: { [Op.in]: keys } }, order: [['scope_key', 'ASC']], limit: 2001 });
    const connections = await models.MetaConnection.findAll({ ...o, attributes: CONNECTION_ATTRIBUTES,
      where: phase === 'active' ? { id: canonicalConnectionId } : { [Op.or]: [{ id: descriptor.sourceConnectionId }, { metaUserId: descriptor.subjectId }] }, order: [['id', 'ASC']], limit: 3 });
    const selected = descriptor.inventory?.aliases.filter(row => descriptor.mappingIds.includes(Number(row.id)))
      || await models.ClinicMetaAsset.findAll({ ...o, attributes: ['id', 'assetType', 'metaAssetId'], where: { id: { [Op.in]: descriptor.mappingIds } }, limit: 1001 });
    const physical = selected.map(row => ({ assetType: row.assetType, metaAssetId: { [Op.in]: [String(row.metaAssetId).replace(/^act_/, ''), 'act_' + String(row.metaAssetId).replace(/^act_/, '')] } }));
    const connectionIds = [...(phase === 'archive' ? [descriptor.sourceConnectionId] : []), ...(canonicalConnectionId ? [canonicalConnectionId] : [])];
    const aliases = await models.ClinicMetaAsset.findAll({ ...o, attributes: ALIAS_ATTRIBUTES,
      where: { [Op.or]: [...(connectionIds.length ? [{ metaConnectionId: { [Op.in]: connectionIds } }] : []), { id: { [Op.in]: descriptor.mappingIds } }, ...physical] },
      order: [['id', 'ASC']], limit: 2001 });
    const allMappingIds = aliases.map(row => Number(row.id));
    const assignments = phase === 'active' ? [] : await models.MetaConnectionAssignment.findAll({ ...o, attributes: ASSIGNMENT_FIELDS,
      where: phase === 'archive' ? { [Op.or]: [{ metaConnectionId: { [Op.in]: [descriptor.sourceConnectionId, ...(canonicalConnectionId ? [canonicalConnectionId] : [])] } }, { scopeKey: { [Op.in]: scopeKeys } }] }
        : { scopeKey: { [Op.in]: scopeKeys } }, order: [['id', 'ASC']], limit: 2001 });
    const shares = allMappingIds.length ? await models.GroupAssetClinicAssignment.findAll({ ...o, attributes: SHARE_FIELDS,
      where: { assetType: { [Op.in]: ['meta.ad_account', 'meta.facebook_page', 'meta.instagram_business', 'meta.whatsapp_business_account', 'meta.whatsapp_phone_number'] }, assetId: { [Op.in]: allMappingIds } }, order: [['id', 'ASC']], limit: 2001 }) : [];
    const groups = await models.GrupoClinica.findAll({ ...o, attributes: GROUP_FIELDS,
      where: { [Op.or]: [...(phase === 'archive' ? [{ id_grupo: { [Op.in]: groupIds } }] : []), { facebook_primary_asset_id: { [Op.in]: allMappingIds } }, { instagram_primary_asset_id: { [Op.in]: allMappingIds } }] }, order: [['id_grupo', 'ASC']], limit: 2001 });
    return normalizeInventory({ clinics, blocks, connections, aliases, assignments, shares, groups });
  }
  async function captureSnapshot(input, transaction) {
    if (!exact(input, ['scopeKey', 'clinicIds', 'sourceConnectionId', 'appId', 'subjectId', 'actorId', 'mappingIds'])
      || !/^(clinic|group):[1-9][0-9]{0,9}$/.test(input.scopeKey) || !POSITIVE(Number(input.scopeKey.split(':')[1]))
      || !POSITIVE(input.sourceConnectionId) || !POSITIVE(input.actorId) || !/^[1-9][0-9]{0,29}$/.test(input.appId)
      || !/^[1-9][0-9]{0,29}$/.test(input.subjectId)) fail('meta_recovery_invalid');
    ids(input.clinicIds); ids(input.mappingIds);
    const descriptor = { ...input, version: 1 };
    // Observation is read-only. The operator still owns plan/CAS/apply and the
    // private journal; this function does not prepare or activate a recovery.
    const inventory = await inspectInventory(descriptor, transaction);
    return validateSnapshot({ ...descriptor, inventory });
  }
  function dto(row) {
    const selected = row.snapshot.inventory.aliases.filter(alias => row.mappingIds.includes(Number(alias.id)));
    const immutableDigest = hash(encode({ recoveryId: row.recovery_id, snapshotDigest: row.snapshot_digest, preparedAt: row.prepared_at, expiresAt: row.expires_at }));
    return { recoveryId: row.recovery_id, flowId: row.flow_id, enrollmentId: row.enrollment_id,
      sourceConnectionId: Number(row.source_connection_id), canonicalConnectionId: row.canonical_connection_id === null ? null : Number(row.canonical_connection_id),
      scopeKey: row.scope_key, clinicIds: row.clinicIds.slice(), appId: row.app_id, subjectId: row.meta_user_id, mappingIds: row.mappingIds.slice(),
      aliases: selected.map(alias => aliasMetadata(alias)),
      postimages: selected.map(alias => aliasMetadata(alias, row.canonical_connection_id === null ? null : Number(row.canonical_connection_id), row.scope_key)),
      snapshotDigest: row.snapshot_digest, immutableDigest };
  }
  function focusedInventory(inventory, row, phase) {
    const keys = new Set([row.scope_key, ...row.clinicIds.map(id => 'clinic:' + id)]);
    const physical = new Set(row.snapshot.inventory.aliases.filter(alias => row.mappingIds.includes(Number(alias.id)))
      .map(alias => alias.assetType + ':' + String(alias.metaAssetId).replace(/^act_/, '')));
    const aliases = inventory.aliases.filter(alias => row.mappingIds.includes(Number(alias.id))
      || physical.has(alias.assetType + ':' + String(alias.metaAssetId).replace(/^act_/, ''))
      || row.canonical_connection_id !== null && Number(alias.metaConnectionId) === Number(row.canonical_connection_id));
    const mappingIds = new Set(aliases.map(alias => Number(alias.id)));
    return { clinics: inventory.clinics, blocks: inventory.blocks,
      connections: phase === 'active' ? [] : inventory.connections,
      aliases, assignments: phase === 'active' ? [] : inventory.assignments.filter(assignment => keys.has(assignment.scopeKey)),
      shares: inventory.shares.filter(share => mappingIds.has(Number(share.assetId))),
      groups: inventory.groups.filter(group => mappingIds.has(Number(group.facebook_primary_asset_id)) || mappingIds.has(Number(group.instagram_primary_asset_id))) };
  }
  async function validateCurrent(row, transaction, { phase = 'pending' } = {}) {
    const expected = cloneInventory(row.snapshot.inventory);
    if (phase === 'active') for (const alias of expected.aliases) if (row.mappingIds.includes(Number(alias.id))) {
      Object.assign(alias, { metaConnectionId: Number(row.canonical_connection_id), assignmentScope: row.scope_key.split(':')[0],
        clinicaId: row.scope_key.startsWith('clinic:') ? Number(row.scope_key.split(':')[1]) : null,
        grupoClinicaId: row.scope_key.startsWith('group:') ? Number(row.scope_key.split(':')[1]) : null, isActive: 1 });
    }
    const actual = await inspectInventory(row.snapshot, transaction, row.canonical_connection_id === null ? null : Number(row.canonical_connection_id), phase);
    if (row.canonical_connection_id !== null) {
      const canonicalConnection = actual.connections.find(value => Number(value.id) === Number(row.canonical_connection_id));
      if (!canonicalConnection || canonicalConnection.userId !== null || canonicalConnection.metaUserId !== row.meta_user_id
        || canonicalConnection.broker_app_id !== row.app_id || Number(canonicalConnection.credentials_external) !== 1
        || canonicalConnection.credential_present !== 0 || canonicalConnection.credential_sha256 !== null) fail('meta_recovery_canonical_invalid');
      actual.connections = actual.connections.filter(value => Number(value.id) !== Number(row.canonical_connection_id));
    }
    // The complete archive is retained. Only the selected physical identity and
    // its authority are a live dependency; unrelated WhatsApp/profile activity
    // must not suspend an independently authorized canonical Meta connection.
    if (encode(focusedInventory(actual, row, phase)) !== encode(focusedInventory(expected, row, phase))) fail();
    return dto(row);
  }
  async function actorCheck(row, actor, transaction) {
    if (Number(actor.actorId) !== Number(row.prepared_by_user_id) || actor.scopeKey !== row.scope_key || !C.UUID.test(actor.sessionRef)
      || !(actor.sessionExpiresAt instanceof Date) || +actor.sessionExpiresAt <= +now() || typeof sessions?.verifyReference !== 'function') fail('meta_recovery_actor_required');
    try { await sessions.verifyReference({ userId: Number(actor.actorId), sessionRef: actor.sessionRef, expiresAt: actor.sessionExpiresAt }, { transaction, requireEmail: true }); }
    catch { fail('meta_recovery_actor_required'); }
  }
  const actorOf = flow => ({ scopeKey: flow.scope_key, actorId: Number(flow.actor_user_id), sessionRef: flow.session_ref, sessionExpiresAt: flow.session_expires_at });
  async function rowsForScope(scopeKey, transaction) {
    return model.findAll({ ...options(transaction), where: { scope_key: scopeKey, state: { [Op.in]: ['prepared', 'flow_bound', 'active'] } }, order: [['prepared_at', 'DESC']], limit: 2 });
  }
  function pendingTime(row) { if (+now() < +row.prepared_at || +now() >= +row.expires_at) fail('meta_recovery_expired'); }
  async function update(row, patch, transaction) {
    const [changed] = await model.update(patch, { ...options(transaction), where: { recovery_id: row.recovery_id, state: row.state,
      flow_id: row.flow_id, enrollment_id: row.enrollment_id, canonical_connection_id: row.canonical_connection_id, snapshot_digest: row.snapshot_digest } });
    if (changed !== 1) fail('meta_recovery_conflict');
    return snapshotRecord({ ...row, snapshot: encode(row.snapshot), ...patch });
  }
  async function inspectPrepared(input, transaction) {
    if (!model || !enabled()) return null;
    const rows = await rowsForScope(input.scopeKey, transaction); if (!rows.length) return null;
    if (rows.length !== 1) fail('meta_recovery_conflict');
    const row = snapshotRecord(rows[0]);
    if (row.app_id !== input.appId || encode(row.clinicIds) !== encode(input.clinicIds)) fail();
    await actorCheck(row, input, transaction);
    // The status/begin consumer captures the scope before inspecting its latest
    // OAuth request. Preserve the same immutable digest for that status read;
    // begin still rejects the existing non-cancelled flow and cannot claim anew.
    if (row.state !== 'prepared') {
      const boundFlow = await models.MetaMarketingOAuthRequest.findByPk(row.flow_id, options(transaction));
      if (!boundFlow) fail();
      return forFlow(boundFlow, transaction, { phase: row.state === 'active' ? 'active' : 'pending' });
    }
    pendingTime(row); return validateCurrent(row, transaction);
  }
  async function forFlow(flowInput, transaction, { phase = 'pending' } = {}) {
    if (!model || !enabled()) return null;
    if (!['pending', 'active'].includes(phase)) fail('meta_recovery_invalid');
    const input = plain(flowInput);
    if (!input || !C.UUID.test(input.flow_id)) fail('meta_recovery_invalid');
    const flow = plain(await models.MetaMarketingOAuthRequest.findByPk(input.flow_id, options(transaction)));
    if (!flow || ['scope_key', 'clinic_ids', 'app_id', 'actor_user_id', 'session_ref', 'state'].some(key => input[key] !== flow[key])
      || (input.candidate_metadata ?? null) !== (flow.candidate_metadata ?? null)) fail();
    const rows = await rowsForScope(flow.scope_key, transaction);
    if (!rows.length) {
      const retired = await model.findOne({ ...options(transaction), where: { flow_id: flow.flow_id } });
      if (retired) fail('meta_recovery_retired'); return null;
    }
    if (rows.length !== 1) fail('meta_recovery_conflict'); let row = snapshotRecord(rows[0]);
    if (flow.app_id !== row.app_id || flow.clinic_ids !== row.clinic_ids || Number(flow.actor_user_id) !== Number(row.prepared_by_user_id)
      || !(flow.requested_at instanceof Date) || +flow.requested_at < +row.prepared_at || row.flow_id && row.flow_id !== flow.flow_id) fail();
    if (phase === 'active') {
      if (row.state !== 'active' || row.flow_id !== flow.flow_id) fail();
    } else { pendingTime(row); await actorCheck(row, actorOf(flow), transaction); }
    if (flow.state !== 'staged') {
      if (phase === 'active' || row.state !== 'prepared' || !['begin_pending', 'awaiting', 'processing'].includes(flow.state)) fail();
      return validateCurrent(row, transaction);
    }
    let candidate; try { candidate = C.candidate(JSON.parse(flow.candidate_metadata), flow); } catch { fail(); }
    if (candidate.subjectId !== row.meta_user_id || candidate.appId !== row.app_id
      || [candidate.expiresAt, candidate.dataAccessExpiresAt].some(value => value !== null && value <= +now())
      || !(flow.completed_at instanceof Date) || +flow.completed_at < +row.prepared_at) fail();
    if (row.state === 'prepared') {
      await validateCurrent(row, transaction);
      row = await update(row, { state: 'flow_bound', flow_id: flow.flow_id, candidate_digest: candidate.digest, bound_at: now() }, transaction);
    } else if (row.candidate_digest !== candidate.digest) fail();
    if (phase === 'active') {
      const enrollment = plain(await models.MetaMarketingEnrollmentRequest.findByPk(row.enrollment_id, options(transaction)));
      if (!enrollment || enrollment.state !== 'active' || enrollment.flow_id !== row.flow_id || Number(enrollment.meta_connection_id) !== Number(row.canonical_connection_id)
        || enrollment.mapping_ids !== row.mapping_ids || enrollment.candidate_digest !== row.candidate_digest) fail();
    }
    return validateCurrent(row, transaction, { phase });
  }
  async function boundRow(flow, transaction) {
    const proof = await forFlow(flow, transaction); if (!proof || !proof.flowId) fail('meta_recovery_required');
    return snapshotRecord(await model.findByPk(proof.recoveryId, options(transaction)));
  }
  async function bindCanonical({ flow, canonicalConnectionId }, transaction) {
    if (!model || !enabled()) fail('meta_recovery_required');
    if (!POSITIVE(canonicalConnectionId)) fail('meta_recovery_invalid');
    const stored = await model.findOne({ ...options(transaction), where: { flow_id: flow.flow_id } });
    if (!stored) fail('meta_recovery_required'); let row = snapshotRecord(stored);
    pendingTime(row); await actorCheck(row, actorOf(flow), transaction);
    const currentFlow = plain(await models.MetaMarketingOAuthRequest.findByPk(flow.flow_id, options(transaction)));
    let candidate; try { candidate = C.candidate(JSON.parse(currentFlow?.candidate_metadata), currentFlow); } catch { fail(); }
    if (row.state !== 'flow_bound' || currentFlow.state !== 'staged' || row.flow_id !== currentFlow.flow_id
      || currentFlow.scope_key !== row.scope_key || currentFlow.clinic_ids !== row.clinic_ids || Number(currentFlow.actor_user_id) !== Number(row.prepared_by_user_id)
      || currentFlow.session_ref !== flow.session_ref || candidate.digest !== row.candidate_digest || candidate.subjectId !== row.meta_user_id || candidate.appId !== row.app_id
      || [candidate.expiresAt, candidate.dataAccessExpiresAt].some(value => value !== null && value <= +now())) fail();
    if (row.canonical_connection_id !== null && Number(row.canonical_connection_id) !== canonicalConnectionId) fail('meta_recovery_conflict');
    await validateCurrent({ ...row, canonical_connection_id: canonicalConnectionId }, transaction);
    if (row.canonical_connection_id === null) row = await update(row, { canonical_connection_id: canonicalConnectionId }, transaction);
    return validateCurrent(row, transaction);
  }
  async function attachEnrollment({ flow, enrollmentId }, transaction) {
    if (!C.UUID.test(enrollmentId)) fail('meta_recovery_invalid'); let row = await boundRow(flow, transaction);
    if (!row.canonical_connection_id || row.enrollment_id !== null && row.enrollment_id !== enrollmentId) fail('meta_recovery_conflict');
    if (row.enrollment_id === null) row = await update(row, { enrollment_id: enrollmentId }, transaction);
    return validateCurrent(row, transaction);
  }
  async function activate({ flow, enrollment }, transaction) {
    if (!model || !enabled()) fail('meta_recovery_required');
    const value = plain(enrollment), stored = await model.findOne({ ...options(transaction), where: { flow_id: flow.flow_id } });
    if (!stored) fail('meta_recovery_required'); let row = snapshotRecord(stored);
    if (row.state === 'active') return forFlow(flow, transaction, { phase: 'active' });
    pendingTime(row);
    await actorCheck(row, actorOf(flow), transaction);
    if (value.enrollment_id !== row.enrollment_id || value.state !== 'active' || value.flow_id !== row.flow_id || value.mapping_ids !== row.mapping_ids
      || Number(value.meta_connection_id) !== Number(row.canonical_connection_id) || value.candidate_digest !== row.candidate_digest) fail();
    const persisted = plain(await models.MetaMarketingEnrollmentRequest.findByPk(row.enrollment_id, options(transaction)));
    if (!persisted || ['enrollment_id', 'state', 'flow_id', 'mapping_ids', 'meta_connection_id', 'candidate_digest'].some(key => persisted[key] !== value[key])) fail();
    await validateCurrent(row, transaction, { phase: 'active' });
    if (row.state === 'flow_bound') row = await update(row, { state: 'active', activated_at: now() }, transaction);
    else if (row.state !== 'active') fail();
    return validateCurrent(row, transaction, { phase: 'active' });
  }
  async function assertActive({ flow, enrollmentId }, transaction) {
    if (!model || !enabled()) return null;
    if (!C.UUID.test(enrollmentId)) fail('meta_recovery_invalid');
    const row = await model.findOne({ ...options(transaction), where: { enrollment_id: enrollmentId } });
    if (!row) return null;
    if (!flow) flow = await models.MetaMarketingOAuthRequest.findByPk(plain(row).flow_id, options(transaction));
    if (!flow) fail(); const proof = await forFlow(flow, transaction, { phase: 'active' });
    if (!proof || proof.enrollmentId !== enrollmentId) fail(); return proof;
  }
  async function retire(enrollmentId, transaction) {
    // Withdrawal remains available when the admission flag is closed.
    if (!model) return null;
    if (!C.UUID.test(enrollmentId)) fail('meta_recovery_invalid');
    const stored = await model.findOne({ ...options(transaction), where: { enrollment_id: enrollmentId } });
    if (!stored) return null; const row = snapshotRecord(stored);
    if (row.state === 'retired') return dto(row);
    const retired = await update(row, { state: 'retired', retired_at: now() }, transaction); return dto(retired);
  }
  async function retireForScope({ scope, clinicIds }, transaction) {
    const result = { retired: 0, enrollmentsQueued: 0, blockedBindings: 0, deactivatedMappings: 0 };
    if (!model) return result;
    const scopeKey = scope?.assignmentScope === 'group' && POSITIVE(Number(scope.groupId)) ? 'group:' + Number(scope.groupId)
      : scope?.assignmentScope === 'clinic' && POSITIVE(Number(scope.clinicId)) ? 'clinic:' + Number(scope.clinicId) : null;
    if (!scopeKey || !Array.isArray(clinicIds) || clinicIds.some(id => !POSITIVE(Number(id)))) fail('meta_recovery_invalid');
    const affected = new Set(clinicIds.map(Number));
    if (scope.assignmentScope === 'clinic') affected.add(Number(scope.clinicId));
    const o = options(transaction); let rows;
    try {
      rows = await model.findAll({ ...o, attributes: ['recovery_id', 'scope_key', 'clinic_ids', 'canonical_connection_id', 'mapping_ids',
        'flow_id', 'enrollment_id', 'state', 'snapshot_digest'], where: { state: { [Op.in]: ['prepared', 'flow_bound', 'active'] } },
      order: [['recovery_id', 'ASC']], limit: 1001 });
    } catch (error) {
      // An unapplied optional DEV migration cannot contain prior authority.
      // Never conceal a missing table in CRM or any other SQL failure.
      const code = error?.original?.code || error?.parent?.code || error?.code;
      if (!enabled() && isDevelopment() && code === 'ER_NO_SUCH_TABLE') return { ...result, skipped: true, reason: 'meta_recovery_dev_table_absent' };
      throw error;
    }
    if (!Array.isArray(rows) || rows.length > 1000) fail('meta_recovery_unavailable');
    for (const value of rows) {
      const row = plain(value); let members, mappings;
      try { members = ids(JSON.parse(row.clinic_ids)); mappings = ids(JSON.parse(row.mapping_ids)); } catch { fail('meta_recovery_invalid'); }
      if (row.scope_key !== scopeKey && !members.some(id => affected.has(id))) continue;
      if (!C.UUID.test(row.recovery_id) || !HASH.test(row.snapshot_digest)) fail('meta_recovery_invalid');
      if (row.enrollment_id !== null) {
        if (!C.UUID.test(row.enrollment_id) || !C.UUID.test(row.flow_id) || !POSITIVE(Number(row.canonical_connection_id))) fail('meta_recovery_invalid');
        const enrollment = plain(await models.MetaMarketingEnrollmentRequest.findByPk(row.enrollment_id, o));
        if (!enrollment || enrollment.flow_id !== row.flow_id || enrollment.scope_key !== row.scope_key
          || Number(enrollment.meta_connection_id) !== Number(row.canonical_connection_id)
          || !['prepare_pending', 'prepared', 'activate_pending', 'active', 'revoke_pending', 'revoked'].includes(enrollment.state)) fail('meta_recovery_changed');
        let owned;
        try { owned = JSON.parse(enrollment.mapping_ids); } catch { fail('meta_recovery_invalid'); }
        if (!Array.isArray(owned) || owned.some(id => !mappings.includes(Number(id)))
          || enrollment.state === 'active' && encode(owned) !== row.mapping_ids) fail('meta_recovery_changed');
        const bindings = await models.MetaMarketingBrokerBinding.findAll({ ...o, attributes: ['mapping_id', 'meta_connection_id'],
          where: { enrollment_id: row.enrollment_id }, limit: mappings.length + 1 });
        if (bindings.length > mappings.length || bindings.some(binding => !mappings.includes(Number(binding.mapping_id))
          || Number(binding.meta_connection_id) !== Number(row.canonical_connection_id))) fail('meta_recovery_changed');
        const [blocked] = await models.MetaMarketingBrokerBinding.update({ state: 'blocked' }, { ...o,
          where: { enrollment_id: row.enrollment_id, meta_connection_id: Number(row.canonical_connection_id), mapping_id: { [Op.in]: mappings } } });
        const [deactivated] = await models.ClinicMetaAsset.update({ isActive: false }, { ...o,
          where: { id: { [Op.in]: mappings }, metaConnectionId: Number(row.canonical_connection_id), assetType: 'ad_account' } });
        result.blockedBindings += blocked; result.deactivatedMappings += deactivated;
        if (!['revoke_pending', 'revoked'].includes(enrollment.state)) {
          const [queued] = await models.MetaMarketingEnrollmentRequest.update({ state: 'revoke_pending', updated_at: now(), next_attempt_at: now(), attempts: 0, last_error: null },
            { ...o, where: { enrollment_id: row.enrollment_id, state: enrollment.state, flow_id: row.flow_id,
              meta_connection_id: Number(row.canonical_connection_id), lease_token: enrollment.lease_token ?? null } });
          if (queued !== 1) fail('meta_recovery_conflict'); result.enrollmentsQueued++;
        }
      }
      const [changed] = await model.update({ state: 'retired', retired_at: now() }, { ...o,
        where: { recovery_id: row.recovery_id, state: row.state, flow_id: row.flow_id, enrollment_id: row.enrollment_id, snapshot_digest: row.snapshot_digest } });
      if (changed !== 1) fail('meta_recovery_conflict'); result.retired++;
    }
    return result;
  }
  return { captureSnapshot, inspectPrepared, forFlow, bindCanonical, attachEnrollment, activate, assertActive, retire, retireForScope };
}
const cloneInventory = value => JSON.parse(encode(value));
module.exports = { createRecovery, validateSnapshot, normalizeInventory, snapshotRecord, canonical, encode, hash, FIELDS,
  ALIAS_ATTRIBUTES, CONNECTION_ATTRIBUTES, aliasMetadata };
