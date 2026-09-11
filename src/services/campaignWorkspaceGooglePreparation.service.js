'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { settingScope, publicSettings } = require('./campaignWorkspaceSettings.service');
const { EVENTS } = require('./campaignWorkspacePreferences.service');
const { EVENT_CATALOG, listConversionActions, inspectCanonicalConversion, conversionFingerprint,
  successfulValidationResponse } = require('./googleAdsConversionPreparation.service');
const { GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE, missingGoogleScopes,
  ensureGoogleConnectionAccessToken } = require('./googleAdsScopedRuntime.service');
const { uploadConversionEvent } = require('./googleDataManagerConversion.service');

const TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_LEASE_MS = 2 * 60 * 1000;
const REQUIRED_SCOPES = [GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE];
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = row => row.assignmentScope === 'group' ? `group:${row.grupoClinicaId}` : `clinic:${row.clinicaId}`;
const query = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const sorted = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function checkInput(input, write = false) {
  const allowed = write ? ['account_id', 'expected_version'] : ['account_id'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))
    || typeof input.account_id !== 'string' || !/^[0-9]{1,64}$/.test(input.account_id)
    || write && (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1)) fail('invalid_google_preparation', 400);
  return input.account_id;
}

async function googlePreparationContext({ models, scope, accountId, transaction = null, signalEvents = null }) {
  const owner = settingScope(scope); const options = query(transaction);
  const ownerRow = await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, options);
  if (!ownerRow) fail('scope_not_found', 404);
  const clinics = scope.groupId ? await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId }, ...options }) : [ownerRow];
  const clinicIds = clinics.map(row => Number(row.id_clinica)).sort((a, b) => a - b);
  if (JSON.stringify(clinicIds) !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...options });
  const selected = setting?.accounts?.find(row => row.provider === 'google_ads' && row.account_id === accountId);
  if (!selected) fail('workspace_account_not_selected', 403);
  const signals = signalEvents ? { enabled: true, events: signalEvents } : setting.preferences?.signals;
  if (!signals?.enabled || !Array.isArray(signals.events) || !signals.events.length
    || signals.events.some(event => !EVENTS.includes(event))) fail('workspace_signal_preferences_required');
  const events = [...new Set(signals.events)].sort();
  const groupIds = [...new Set(clinics.map(row => Number(row.grupoClinicaId)).filter(Boolean))];
  const mappings = await models.ClinicGoogleAdsAccount.findAll({ where: { customerId: accountId, isActive: true,
    [Op.or]: [{ assignmentScope: 'clinic', clinicaId: { [Op.in]: clinicIds } },
      ...(groupIds.length ? [{ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groupIds } }] : [])] }, ...options });
  const assignments = mappings.length ? await models.GoogleConnectionAssignment.findAll({ where: { status: 'active',
    scopeKey: { [Op.in]: mappings.map(key) } }, ...options }) : [];
  const authorized = mappings.filter(row => assignments.some(assignment => assignment.scopeKey === key(row)
    && Number(assignment.googleConnectionId) === Number(row.googleConnectionId)));
  const preferred = authorized.filter(row => row.assignmentScope === owner.scope_type
    && Number(owner.scope_type === 'group' ? row.grupoClinicaId : row.clinicaId) === owner.scope_id);
  const eligible = preferred.length ? preferred : authorized;
  if (!eligible.length) fail('workspace_google_permissions_required');
  const grantIds = new Set(eligible.map(row => Number(row.googleConnectionId)));
  const loginIds = new Set(eligible.map(row => String(row.loginCustomerId || row.managerCustomerId || '').replace(/\D/g, '')));
  if (grantIds.size !== 1 || loginIds.size !== 1) fail('workspace_google_connection_ambiguous');
  const connection = await models.GoogleConnection.findByPk(eligible[0].googleConnectionId, options);
  if (!connection?.accessToken || missingGoogleScopes(connection.scopes, REQUIRED_SCOPES).length) fail('workspace_google_permissions_required');
  const relevantAssignments = assignments.filter(assignment => eligible.some(row => assignment.scopeKey === key(row)
    && Number(assignment.googleConnectionId) === Number(row.googleConnectionId)));
  // Tokens rotate routinely. Bind evidence to the grant/assignment, not to its access token or refresh timestamp.
  const grantFingerprint = hash([owner, clinicIds,
    sorted(eligible.map(row => [row.id, key(row), row.googleConnectionId, row.loginCustomerId || row.managerCustomerId || null])),
    sorted(relevantAssignments.map(row => [row.id, row.scopeKey, row.googleConnectionId, row.status, row.connectedAt])),
    connection.id, connection.googleUserId, String(connection.scopes || '').split(/[\s,]+/).filter(Boolean).sort()]);
  const fingerprint = hash([grantFingerprint, setting.preferences,
    sorted(setting.accounts.map(row => ({ ...row, campaign_ids: [...row.campaign_ids].sort() })))]);
  return { setting, connection, fingerprint, grantFingerprint, events, accountId, loginCustomerId: [...loginIds][0] || null };
}

function publicProof(context, now = new Date()) {
  const record = context.setting.signal_preparation?.google_ads?.[context.accountId];
  const base = { account_id: context.accountId, status: 'unchecked', checked_at: null, expires_at: null, events: [] };
  if (!record) return base;
  if (record.schema_version !== 1 || record.fingerprint !== context.fingerprint) return { ...base, status: 'stale' };
  if (record.status === 'checking') return { ...base, status: +new Date(record.started_at) + CHECK_LEASE_MS > +now ? 'checking' : 'stale' };
  if (record.status !== 'checked' || !Number.isFinite(+new Date(record.expires_at)) || +new Date(record.expires_at) <= +now) return { ...base, status: 'stale' };
  return { ...base, status: 'checked', checked_at: record.checked_at, expires_at: record.expires_at,
    events: context.events.map(event => record.events?.find(row => row.event === event)).filter(Boolean) };
}

async function loadGooglePreparation({ models, scope, input, now = () => new Date() }) {
  const context = await googlePreparationContext({ models, scope, accountId: checkInput(input) });
  return { success: true, configuration: publicSettings(context.setting, scope), preparation: publicProof(context, now()) };
}

function checkError(error) {
  const code = String(error.code || '').toLowerCase();
  if (/scope|token|refresh|permission|connection/.test(code) || [401, 403].includes(error.response?.status)) return 'workspace_google_permissions_required';
  if (/quota|rate_limit|google_ads_paused/.test(code) || error.response?.status === 429) return 'workspace_google_rate_limited';
  if (code === 'data_manager_validation_unconfirmed') return code;
  return 'workspace_google_check_failed';
}

async function checkConversions(context, { list = listConversionActions, ensureToken = ensureGoogleConnectionAccessToken,
  upload = uploadConversionEvent, now = () => new Date() } = {}) {
  const rows = context.events.map(event => ({ event, action_id: null, action_fingerprint: null, state: 'failed', error: null }));
  const deadline = Date.now() + 55000;
  const remaining = max => {
    const time = Math.min(max, deadline - Date.now());
    if (time < 1000) fail('workspace_google_check_timeout');
    return time;
  };
  let listed; let accessToken;
  try {
    ({ accessToken } = await ensureToken(context.connection, { requiredScopes: REQUIRED_SCOPES }));
    listed = await list({ accessToken, customerId: context.accountId, loginCustomerId: context.loginCustomerId,
      includeAllTypes: true, timeoutMs: remaining(15000) });
    if (!Array.isArray(listed?.actions)) fail('workspace_google_check_failed');
  } catch (error) { return rows.map(row => ({ ...row, error: checkError(error) })); }
  for (const row of rows) {
    const matches = listed.actions.filter(action => action.name?.trim().toLowerCase() === EVENT_CATALOG[row.event].name.toLowerCase());
    if (!matches.length) { row.state = 'missing'; row.error = 'canonical_conversion_action_required'; continue; }
    const action = matches.length === 1 ? matches[0] : null;
    row.action_id = action?.id || null;
    const problem = inspectCanonicalConversion({ listed, customerId: context.accountId, conversionActionId: row.action_id, event: row.event });
    if (problem) { row.state = 'review'; row.error = problem; continue; }
    row.action_fingerprint = conversionFingerprint(action);
    try {
      const response = await upload({ customerId: context.accountId, loginCustomerId: context.loginCustomerId, accessToken,
        conversionAction: action.resource_name, conversionDateTime: now(), externalId: `cc-check-${crypto.randomUUID()}`,
        gclid: 'GCLID_1', value: 0, currency: 'EUR', eventName: row.event, eventSource: 'WEB', validateOnly: true,
        timeoutMs: remaining(8000),
      });
      if (!successfulValidationResponse(response)) fail('data_manager_validation_unconfirmed');
      row.state = 'verified';
    } catch (error) { row.error = checkError(error); }
  }
  return rows;
}

async function saveProof({ models, context, record, actorId, scope, transaction, eventType, now }) {
  const setting = context.setting;
  const signal_preparation = { ...setting.signal_preparation, google_ads: {
    ...setting.signal_preparation?.google_ads, [context.accountId]: { ...record, schema_version: 1 },
  } };
  const version = Number(setting.version) + 1;
  await setting.update({ signal_preparation, version, updated_by_user_id: actorId }, { transaction });
  await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version,
    actor_user_id: actorId, event_type: eventType, changes: { account_id: context.accountId, run_id: record.run_id,
      events: record.events?.map(row => ({ event: row.event, state: row.state, error: row.error })) || [], validate_only: true },
    created_at: now() }, { transaction });
  return { success: true, configuration: publicSettings(setting, scope), preparation: publicProof(context, now()) };
}

async function checkGooglePreparation({ models, scope, actorId, input, hasAccess, now = () => new Date(), ...provider }) {
  const accountId = checkInput(input, true);
  if (!Number.isSafeInteger(actorId) || actorId < 1) fail('unauthenticated', 401);
  const permitted = async () => {
    if (!hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write' })) fail('marketing_scope_forbidden', 403);
  };
  const runId = crypto.randomUUID();
  // Persist an invalidating marker before network I/O. Crashes/timeouts cannot leave the old green check in place.
  const started = await models.sequelize.transaction(async transaction => {
    await permitted();
    const context = await googlePreparationContext({ models, scope, accountId, transaction });
    if (Number(context.setting.version) !== input.expected_version) fail('workspace_version_conflict');
    if (publicProof(context, now()).status === 'checking') fail('workspace_google_check_busy');
    await saveProof({ models, context, actorId, scope, transaction, now, eventType: 'google_check_started', record: {
      status: 'checking', fingerprint: context.fingerprint, run_id: runId, started_at: now().toISOString(),
    } });
    return context;
  });
  const rows = await checkConversions(started, { ...provider, now });
  return models.sequelize.transaction(async transaction => {
    await permitted();
    const context = await googlePreparationContext({ models, scope, accountId, transaction });
    const pending = context.setting.signal_preparation?.google_ads?.[accountId];
    if (context.fingerprint !== started.fingerprint || pending?.run_id !== runId || pending?.status !== 'checking') fail('workspace_google_check_conflict');
    const checkedAt = now();
    return saveProof({ models, context, actorId, scope, transaction, now, eventType: 'google_check_completed', record: {
      status: 'checked', fingerprint: context.fingerprint, run_id: runId, checked_at: checkedAt.toISOString(),
      expires_at: new Date(+checkedAt + TTL_MS).toISOString(), events: rows,
    } });
  });
}

module.exports = { TTL_MS, CHECK_LEASE_MS, checkInput, googlePreparationContext, publicProof,
  loadGooglePreparation, checkConversions, checkGooglePreparation, checkError };
