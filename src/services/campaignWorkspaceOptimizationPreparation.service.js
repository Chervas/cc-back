'use strict';

const crypto = require('node:crypto');
const { settingScope, publicSettings } = require('./campaignWorkspaceSettings.service');
const { loadWorkspaceInventory } = require('./campaignWorkspace.service');
const { googleDestinationContext } = require('./campaignWorkspaceGoogleDestination.service');
const { metaCampaignContext } = require('./campaignWorkspaceMetaDestination.service');
const { metaSignalPreparationContext } = require('./campaignWorkspaceMetaSignalPreparation.service');
const { ensureGoogleConnectionAccessToken, GOOGLE_ADS_SCOPE } = require('./googleAdsScopedRuntime.service');
const { TTL_MS, digest, optimizationReference, optimizationAvailability, inspectGoogleOptimization, inspectMetaOptimization } = require('./campaignWorkspaceOptimizationCapabilities.service');

const EVENT_TYPE = 'optimization_check';
const LEASE_MS = 120000;
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const query = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });

async function optimizationContext({ models, scope, reference, transaction = null, now = new Date(), loadInventory = loadWorkspaceInventory,
  googleContext = googleDestinationContext, metaContext = metaCampaignContext, metaGrant = metaSignalPreparationContext, requirePreferences = true }) {
  const owner = settingScope(scope); const options = query(transaction);
  const ownerRow = await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, options);
  if (!ownerRow) fail('scope_not_found', 404);
  const clinics = scope.groupId ? await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId }, ...options }) : [ownerRow];
  if (clinics.some(row => ![true, 1, '1'].includes(row.estado_clinica))
    || JSON.stringify(clinics.map(row => Number(row.id_clinica)).sort((a, b) => a - b))
      !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...options });
  if (!setting || requirePreferences && (setting.preferences?.mode !== 'optimize' || !setting.preferences.optimization)) fail('workspace_optimization_preferences_required');
  const google = reference.provider === 'google_ads';
  const source = await (google ? googleContext : metaContext)({ models, scope, reference, transaction, now, loadInventory });
  // Reuse account authorization independently of the CRM signal preference. No signal is checked or sent here.
  const grant = google ? source.account : await metaGrant({ models, scope, accountId: reference.account_id, transaction, now, signalEvents: ['lead'] });
  if (!source.campaign.assigned || !scope.clinicIds.includes(source.campaign.clinicId)) fail('workspace_clinic_assignment_required');
  if (!google && Number(source.connection.id) !== Number(grant.connection.id)) fail('workspace_meta_connection_ambiguous');
  const fingerprint = digest([owner, setting.id, setting.preferences, setting.accounts,
    source.campaign.clinicId, reference, grant.grantFingerprint || grant.fingerprint]);
  const latest = await models.CampaignWorkspaceEvent.findOne({ where: { setting_id: setting.id, event_type: EVENT_TYPE,
    'changes.reference.provider': reference.provider, 'changes.reference.account_id': reference.account_id,
    'changes.reference.campaign_id': reference.campaign_id }, order: [['version', 'DESC']], ...options });
  return { setting, campaign: source.campaign, grant, fingerprint, reference, latest: latest?.changes || null };
}

function publicOptimizationProof(context, now = new Date()) {
  const base = { reference: context.reference, status: 'unchecked', checked_at: null, expires_at: null, actions: [], error: null,
    compatible: false, authorized: false };
  const proof = context.latest;
  if (!proof) return base;
  if (proof.schema_version !== 1 || proof.fingerprint !== context.fingerprint) return { ...base, status: 'stale' };
  if (proof.status === 'checking') return { ...base, status: Number.isFinite(Date.parse(proof.started_at))
    && +new Date(proof.started_at) <= +now && +new Date(proof.started_at) + LEASE_MS > +now ? 'checking' : 'stale' };
  if (proof.status !== 'checked' || !Number.isFinite(Date.parse(proof.checked_at)) || +new Date(proof.checked_at) > +now
    || +new Date(proof.expires_at) !== +new Date(proof.checked_at) + TTL_MS || +new Date(proof.expires_at) <= +now) return { ...base, status: 'stale' };
  if (proof.error) return { ...base, status: 'failed', error: proof.error, checked_at: proof.checked_at, expires_at: proof.expires_at };
  const requested = [...context.setting.preferences.optimization.actions,
    ...(context.setting.preferences.optimization.budget_changes ? ['adjust_budget'] : [])];
  if (!Array.isArray(proof.inspection?.actions) || proof.inspection.schema_version !== 1
    || !proof.inspection.reference
    || digest(proof.inspection.reference) !== digest(context.reference)) return { ...base, status: 'stale' };
  let available;
  try { available = optimizationAvailability(proof.inspection); }
  catch { return { ...base, status: 'stale' }; }
  const actions = available.actions.map(({ action, targets, reasons }) => ({ action, targets, reasons, requested: requested.includes(action) }));
  return { ...base, status: 'checked', checked_at: proof.checked_at, expires_at: proof.expires_at,
    compatible: actions.some(action => action.requested && action.targets > 0), currency: proof.inspection.currency, actions };
}

async function permitted({ models, scope, actorId, hasAccess, transaction }, access) {
  const membershipModel = models.UsuarioClinica ? { findAll: input => models.UsuarioClinica.findAll({ ...input, ...query(transaction) }) } : undefined;
  if (!Number.isSafeInteger(actorId) || actorId < 1 || !hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access, membershipModel })) fail('marketing_scope_forbidden', 403);
}

async function loadOptimizationPreparation(options) {
  const reference = optimizationReference(options.input); const now = options.now?.() || new Date();
  await permitted(options, 'read');
  const context = await optimizationContext({ ...options, reference, now });
  await permitted(options, 'read');
  return { success: true, configuration: publicSettings(context.setting, options.scope), preparation: publicOptimizationProof(context, now) };
}

async function saveCheck({ models, context, record, actorId, transaction, now }) {
  const version = Number(context.setting.version) + 1;
  await context.setting.update({ version, updated_by_user_id: actorId }, { transaction });
  await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: context.setting.id, version,
    event_type: EVENT_TYPE, actor_user_id: actorId, created_at: now, changes: { ...record,
      schema_version: 1, reference: context.reference, fingerprint: context.fingerprint, provider_mutation: false } }, { transaction });
}

function checkError(error) {
  const providerCode = Number(error.response?.data?.error?.code);
  if (/permission|access|token|scope/.test(String(error.code || '').toLowerCase()) || [10, 190, 200].includes(providerCode)
    || [401, 403].includes(error.response?.status)) return 'workspace_optimization_permissions_required';
  if (/quota|rate_limit|paused/.test(String(error.code || '').toLowerCase()) || [4, 17, 613].includes(providerCode)
    || error.response?.status === 429) return 'workspace_optimization_rate_limited';
  return ['workspace_optimization_incomplete', 'workspace_optimization_campaign_unavailable', 'workspace_optimization_timeout'].includes(error.code)
    ? error.code : 'workspace_optimization_unavailable';
}

async function checkOptimizationPreparation(options) {
  const reference = optimizationReference(options.input, true); const now = options.now || (() => new Date());
  const runId = crypto.randomUUID();
  const started = await options.models.sequelize.transaction(async transaction => {
    await permitted({ ...options, transaction }, 'write');
    const context = await optimizationContext({ ...options, reference, transaction, now: now() });
    if (Number(context.setting.version) !== options.input.expected_version) fail('workspace_version_conflict');
    if (publicOptimizationProof(context, now()).status === 'checking') fail('workspace_optimization_busy');
    await saveCheck({ ...options, context, transaction, now: now(), record: { status: 'checking', run_id: runId, started_at: now().toISOString() } });
    return context;
  });
  let inspection = null; let error = null;
  try {
    await permitted(options, 'write');
    let accessToken = started.grant.connection.accessToken;
    if (reference.provider === 'google_ads') ({ accessToken } = await (options.ensureToken || ensureGoogleConnectionAccessToken)(started.grant.connection, { requiredScopes: [GOOGLE_ADS_SCOPE] }));
    await permitted(options, 'write');
    const fresh = await optimizationContext({ ...options, reference, now: now() });
    if (fresh.fingerprint !== started.fingerprint) fail('workspace_optimization_changed');
    inspection = await (reference.provider === 'google_ads' ? options.inspectGoogle || inspectGoogleOptimization : options.inspectMeta || inspectMetaOptimization)({ reference,
      accessToken, loginCustomerId: started.grant.loginCustomerId, read: options.read, now: now() });
  } catch (failure) { error = checkError(failure); }
  return options.models.sequelize.transaction(async transaction => {
    await permitted({ ...options, transaction }, 'write');
    const context = await optimizationContext({ ...options, reference, transaction, now: now() });
    if (context.fingerprint !== started.fingerprint || context.latest?.run_id !== runId || context.latest.status !== 'checking') fail('workspace_optimization_changed');
    const checkedAt = now();
    const record = { status: 'checked', run_id: runId, inspection, error,
      checked_at: checkedAt.toISOString(), expires_at: new Date(+checkedAt + TTL_MS).toISOString() };
    await saveCheck({ ...options, context, record, transaction, now: checkedAt });
    return { success: true, configuration: publicSettings(context.setting, options.scope),
      preparation: publicOptimizationProof({ ...context, latest: { ...record, schema_version: 1, fingerprint: context.fingerprint } }, checkedAt) };
  });
}

module.exports = { EVENT_TYPE, LEASE_MS, optimizationContext, publicOptimizationProof, loadOptimizationPreparation, checkOptimizationPreparation };
