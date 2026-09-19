'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { settingScope, publicSettings } = require('./campaignWorkspaceSettings.service');
const { EVENTS } = require('./campaignWorkspacePreferences.service');
const { graphId, graphList, revision } = require('./campaignWorkspaceMetaDestination.service');

const TTL_MS = 24 * 3600000;
const CHECK_LEASE_MS = 120000;
const ERRORS = ['workspace_meta_inventory_incomplete', 'workspace_meta_dataset_not_available', 'workspace_meta_check_timeout',
  'workspace_meta_permissions_required', 'workspace_meta_rate_limited', 'workspace_meta_unavailable'];
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const scopeKey = row => row.assignmentScope === 'group' ? `group:${row.grupoClinicaId}` : `clinic:${row.clinicaId}`;
const options = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const sorted = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function checkInput(input, write = false) {
  const keys = write ? ['account_id', 'dataset_id', 'expected_version'] : ['account_id'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || !graphId(input.account_id) || write && (!graphId(input.dataset_id)
      || !Number.isSafeInteger(input.expected_version) || input.expected_version < 1)) fail('invalid_meta_signal_preparation', 400);
  return input;
}

async function metaSignalPreparationContext({ models, scope, accountId, now = new Date(), transaction = null, signalEvents = null }) {
  const owner = settingScope(scope); const query = options(transaction);
  const ownerRow = await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, query);
  if (!ownerRow) fail('scope_not_found', 404);
  const clinics = scope.groupId ? await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId }, ...query }) : [ownerRow];
  const clinicIds = clinics.map(row => Number(row.id_clinica)).sort((a, b) => a - b);
  if (JSON.stringify(clinicIds) !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...query });
  if (setting?.accounts?.filter(row => row.provider === 'meta_ads' && row.account_id === accountId).length !== 1) fail('workspace_account_not_selected', 403);
  const signals = signalEvents ? { enabled: true, events: signalEvents } : setting.preferences?.signals;
  if (!signals?.enabled || !Array.isArray(signals.events) || !signals.events.length || signals.events.some(event => !EVENTS.includes(event))) {
    fail('workspace_signal_preferences_required');
  }
  const groups = [...new Set(clinics.map(row => Number(row.grupoClinicaId)).filter(Boolean))];
  const mappings = await models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: 'ad_account',
    metaAssetId: { [Op.in]: [accountId, `act_${accountId}`] },
    [Op.or]: [{ assignmentScope: 'clinic', clinicaId: { [Op.in]: clinicIds } },
      ...(groups.length ? [{ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groups } }] : [])],
  }, ...query });
  const assignments = mappings.length ? await models.MetaConnectionAssignment.findAll({ where: { status: 'active',
    scopeKey: { [Op.in]: mappings.map(scopeKey) } }, ...query }) : [];
  const authorized = mappings.filter(row => assignments.some(assignment => assignment.scopeKey === scopeKey(row)
    && Number(assignment.metaConnectionId) === Number(row.metaConnectionId)
    && assignment.status === 'active' && assignment.connectedAt && Number.isFinite(+new Date(assignment.connectedAt))
    && +new Date(assignment.connectedAt) <= +now));
  const preferred = authorized.filter(row => scopeKey(row) === `${owner.scope_type}:${owner.scope_id}`);
  const eligible = preferred.length ? preferred : authorized;
  if (!eligible.length) fail('workspace_meta_permissions_required');
  if (new Set(eligible.map(row => Number(row.metaConnectionId))).size !== 1) fail('workspace_meta_connection_ambiguous');
  const connection = await models.MetaConnection.findByPk(eligible[0].metaConnectionId, query);
  if (Number(connection?.id) !== Number(eligible[0].metaConnectionId) || !connection?.accessToken || !connection.metaUserId || connection.expiresAt && (!Number.isFinite(+new Date(connection.expiresAt))
    || +new Date(connection.expiresAt) <= +now)) fail('workspace_meta_permissions_required');
  const grants = assignments.filter(assignment => eligible.some(row => assignment.scopeKey === scopeKey(row)
    && Number(assignment.metaConnectionId) === Number(row.metaConnectionId)));
  const grantFingerprint = revision([owner, clinicIds,
    sorted(eligible.map(row => [row.id, scopeKey(row), row.metaConnectionId, row.metaAssetId])),
    sorted(grants.map(row => [row.id, row.scopeKey, row.metaConnectionId, row.status, row.connectedAt])),
    connection.id, connection.metaUserId]);
  const fingerprint = revision([grantFingerprint, setting.preferences,
    sorted(setting.accounts.map(row => ({ ...row, campaign_ids: [...row.campaign_ids].sort() })))]);
  return { setting, accountId, connection, fingerprint, grantFingerprint, events: [...new Set(signals.events)].sort() };
}

function publicProof(context, now = new Date()) {
  const proof = context.setting.signal_preparation?.meta_ads?.[context.accountId];
  const base = { account_id: context.accountId, status: 'unchecked', dataset_id: null, dataset_name: null,
    checked_at: null, expires_at: null, events: context.events, state: null, error: null };
  if (!proof) return base;
  if (proof.schema_version !== 1 || proof.fingerprint !== context.fingerprint) return { ...base, status: 'stale' };
  if (proof.status === 'checking') return { ...base, status: validDate(proof.started_at) && +new Date(proof.started_at) <= +now
    && +new Date(proof.started_at) + CHECK_LEASE_MS > +now ? 'checking' : 'stale' };
  if (proof.status !== 'checked' || !validDate(proof.checked_at) || !validDate(proof.expires_at)
    || +new Date(proof.checked_at) > +now || +new Date(proof.expires_at) <= +now
    || +new Date(proof.expires_at) !== +new Date(proof.checked_at) + TTL_MS || !graphId(proof.dataset_id)
    || !['access_verified', 'failed'].includes(proof.state)
    || (proof.state === 'access_verified' ? proof.error !== null || typeof proof.dataset_name !== 'string' || proof.dataset_name.length > 255
      : !ERRORS.includes(proof.error))) return { ...base, status: 'stale' };
  return { ...base, status: 'checked', dataset_id: proof.dataset_id, dataset_name: proof.dataset_name,
    checked_at: proof.checked_at, expires_at: proof.expires_at, state: proof.state, error: proof.error };
}

function checkError(error) {
  const code = Number(error.response?.data?.error?.code);
  if (ERRORS.includes(error.code)) return error.code;
  if (/^META_RATE_LIMIT/.test(error.code || '') || [4, 17, 613].includes(code) || error.response?.status === 429) return 'workspace_meta_rate_limited';
  if ([10, 190, 200].includes(code) || [401, 403].includes(error.response?.status)) return 'workspace_meta_permissions_required';
  return 'workspace_meta_unavailable';
}

async function listAccountDatasets(context, read = require('../lib/metaClient').metaGet) {
  const deadline = Date.now() + 40000;
  const boundedRead = (path, options) => {
    const remaining = deadline - Date.now();
    if (remaining < 1000) fail('workspace_meta_check_timeout');
    return read(path, { ...options, timeout: Math.min(8000, remaining), maxRetries: 0, sensitivePayload: true,
      source: 'campaign_workspace', operation: 'meta_signal_destination_check' });
  };
  const permissions = await graphList('me/permissions', 'permission,status', context.connection.accessToken, boundedRead, 3);
  if (!permissions.complete || !permissions.rows.some(row => row.permission === 'ads_management' && row.status === 'granted')
    || permissions.rows.some(row => row.permission === 'ads_management' && row.status !== 'granted')) fail('workspace_meta_permissions_required');
  const account = await boundedRead(`act_${context.accountId}`, { accessToken: context.connection.accessToken, params: { fields: 'id,account_id' } });
  if (account.data?.id !== `act_${context.accountId}` || account.data?.account_id !== context.accountId) fail('workspace_meta_permissions_required');
  const inventory = await graphList(`act_${context.accountId}/adspixels`, 'id,name', context.connection.accessToken, boundedRead, 5);
  if (!inventory.complete || inventory.rows.some(row => !graphId(row.id) || typeof row.name !== 'string' || row.name.length > 255)) fail('workspace_meta_inventory_incomplete');
  const unique = new Map();
  for (const row of inventory.rows) {
    if (unique.has(row.id) && unique.get(row.id).name !== row.name) fail('workspace_meta_inventory_incomplete');
    unique.set(row.id, { id: row.id, name: row.name });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadMetaSignalPreparation({ models, scope, input, actorId, hasAccess, now = () => new Date(), read }) {
  const context = await metaSignalPreparationContext({ models, scope, accountId: checkInput(input).account_id, now: now() });
  let datasets;
  try { datasets = await listAccountDatasets(context, read); } catch (error) { fail(checkError(error)); }
  if (!hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'read' })) fail('marketing_scope_forbidden', 403);
  const current = await metaSignalPreparationContext({ models, scope, accountId: context.accountId, now: now() });
  if (current.fingerprint !== context.fingerprint) fail('workspace_meta_check_conflict');
  let preparation = publicProof(current, now());
  if (preparation.state === 'access_verified' && !datasets.some(row => row.id === preparation.dataset_id)) preparation = { ...preparation, status: 'stale', state: null };
  return { success: true, configuration: publicSettings(current.setting, scope), preparation, datasets };
}

async function saveProof({ models, context, scope, actorId, record, transaction, now, eventType }) {
  const setting = context.setting;
  const signal_preparation = { ...setting.signal_preparation, meta_ads: { ...setting.signal_preparation?.meta_ads,
    [context.accountId]: { ...record, schema_version: 1 } } };
  const version = Number(setting.version) + 1;
  await setting.update({ signal_preparation, version, updated_by_user_id: actorId }, { transaction });
  await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version,
    actor_user_id: actorId, event_type: eventType, created_at: now(), changes: { account_id: context.accountId,
      dataset_id: record.dataset_id, state: record.state || 'checking', error: record.error || null, run_id: record.run_id,
      events: context.events, provider_mutation: false } }, { transaction });
  return { success: true, configuration: publicSettings(setting, scope), preparation: publicProof(context, now()) };
}

async function checkMetaSignalPreparation({ models, scope, actorId, input, hasAccess, now = () => new Date(), read }) {
  checkInput(input, true);
  if (!Number.isSafeInteger(actorId) || actorId < 1) fail('unauthenticated', 401);
  const permitted = async () => {
    if (!hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write' })) fail('marketing_scope_forbidden', 403);
  };
  const runId = crypto.randomUUID();
  const started = await models.sequelize.transaction(async transaction => {
    await permitted();
    const context = await metaSignalPreparationContext({ models, scope, accountId: input.account_id, now: now(), transaction });
    if (Number(context.setting.version) !== input.expected_version) fail('workspace_version_conflict');
    if (publicProof(context, now()).status === 'checking') fail('workspace_meta_check_busy');
    await saveProof({ models, context, scope, actorId, transaction, now, eventType: 'meta_signal_check_started', record: {
      status: 'checking', fingerprint: context.fingerprint, run_id: runId, dataset_id: input.dataset_id, started_at: now().toISOString() } });
    return context;
  });
  let dataset = null; let error = null;
  try {
    const datasets = await listAccountDatasets(started, read);
    dataset = datasets.find(row => row.id === input.dataset_id);
    if (!dataset) fail('workspace_meta_dataset_not_available');
  } catch (failure) { error = checkError(failure); }
  return models.sequelize.transaction(async transaction => {
    await permitted();
    const context = await metaSignalPreparationContext({ models, scope, accountId: input.account_id, now: now(), transaction });
    const pending = context.setting.signal_preparation?.meta_ads?.[context.accountId];
    if (context.fingerprint !== started.fingerprint || pending?.run_id !== runId || pending?.status !== 'checking') fail('workspace_meta_check_conflict');
    const checkedAt = now();
    return saveProof({ models, context, scope, actorId, transaction, now, eventType: 'meta_signal_check_completed', record: {
      status: 'checked', fingerprint: context.fingerprint, run_id: runId, dataset_id: input.dataset_id,
      dataset_name: dataset?.name || null, state: error ? 'failed' : 'access_verified', error,
      checked_at: checkedAt.toISOString(), expires_at: new Date(+checkedAt + TTL_MS).toISOString() } });
  });
}

module.exports = { TTL_MS, CHECK_LEASE_MS, checkInput, metaSignalPreparationContext, publicProof,
  listAccountDatasets, loadMetaSignalPreparation, checkMetaSignalPreparation };
