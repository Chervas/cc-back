'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { settingScope, publicSettings, campaignIncluded } = require('./campaignWorkspaceSettings.service');
const { accountAliases } = require('./campaignWorkspaceReport.service');
const { optimizationContext, publicOptimizationProof } = require('./campaignWorkspaceOptimizationPreparation.service');
const { ACTIONS, digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');

const LIMITS = Object.freeze({ max_bid_change_pct: 10, max_budget_change_pct: 10, cooldown_hours: 24,
  preserve_last_active_ad: true, new_campaigns: 'review_required', new_resources: 'review_required' });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const reference = campaign => optimizationReference({ provider: campaign.provider, account_id: campaign.account_id, campaign_id: campaign.campaign_id });
const key = campaign => JSON.stringify(reference(campaign));
const grantHash = context => context.grant.grantFingerprint || context.grant.fingerprint;
const safeError = error => /^(workspace_(optimization_[a-z_]+|scope_changed|clinic_assignment_required|account_not_selected|campaign_not_in_scope|google_permissions_required|meta_[a-z_]+))$/.test(error?.code || '')
  ? error.code : 'workspace_optimization_unavailable';

function scopedTarget(target, campaign) {
  if (!target || !ACTIONS.includes(target.action) || typeof target.id !== 'string' || !/^[1-9][0-9]{0,63}$/.test(target.id)) return false;
  const google = campaign.provider === 'google_ads';
  const prefix = `customers/${campaign.account_id}/`;
  if (target.action === 'pause_underperforming_ads') return target.entity === 'ad' && target.field === 'status'
    && typeof target.group_id === 'string' && /^[1-9][0-9]{0,63}$/.test(target.group_id)
    && target.resource === (google ? `${prefix}adGroupAds/${target.group_id}~${target.id}` : target.id);
  if (target.action === 'negative_keywords') return google && target.entity === 'campaign' && target.id === campaign.campaign_id
    && target.resource === `${prefix}campaigns/${target.id}` && target.field === 'keyword' && target.match_type === 'EXACT';
  if (target.action === 'adjust_budget') return google
    ? target.entity === 'campaign_budget' && target.resource === `${prefix}campaignBudgets/${target.id}` && target.field === 'amount_micros' && target.unit === 'micros'
    : ['ad_set', 'campaign'].includes(target.entity) && (target.entity !== 'campaign' || target.id === campaign.campaign_id)
      && target.resource === target.id && target.field === 'daily_budget' && target.unit === 'minor';
  if (google) {
    if (target.entity === 'ad_group') return target.resource === `${prefix}adGroups/${target.id}` && target.field === 'cpc_bid_micros'
      && target.unit === 'micros' && target.strategy === 'MANUAL_CPC';
    const schemes = { TARGET_CPA: ['target_cpa.target_cpa_micros', 'micros'], TARGET_ROAS: ['target_roas.target_roas', 'ratio'],
      MAXIMIZE_CONVERSIONS: ['maximize_conversions.target_cpa_micros', 'micros'], MAXIMIZE_CONVERSION_VALUE: ['maximize_conversion_value.target_roas', 'ratio'] };
    return target.entity === 'campaign' && target.id === campaign.campaign_id && target.resource === `${prefix}campaigns/${target.id}`
      && Object.hasOwn(schemes, target.strategy) && schemes[target.strategy][0] === target.field && schemes[target.strategy][1] === target.unit;
  }
  return target.entity === 'ad_set' && target.resource === target.id && (['COST_CAP', 'LOWEST_COST_WITH_BID_CAP'].includes(target.strategy)
    ? target.field === 'bid_amount' && target.unit === 'minor'
    : target.strategy === 'LOWEST_COST_WITH_MIN_ROAS' && target.field === 'bid_constraints.roas_average_floor' && target.unit === 'roas_10000');
}

function optimizationLimits(preferences) {
  const value = preferences?.optimization;
  if (preferences?.mode !== 'optimize' || !Array.isArray(value?.actions) || !value.actions.length
    || new Set(value.actions).size !== value.actions.length || value.actions.some(action => !ACTIONS.slice(0, 3).includes(action))
    || typeof value.budget_changes !== 'boolean' || value.max_budget_change_pct !== LIMITS.max_budget_change_pct
    || (value.budget_changes ? !positive(value.monthly_limit_cents) || value.monthly_limit_cents < 10000 || value.monthly_limit_cents > 5000000
      : value.monthly_limit_cents !== null)) fail('workspace_optimization_preferences_required');
  return { ...LIMITS, actions: ACTIONS.filter(action => value.actions.includes(action) || action === 'adjust_budget' && value.budget_changes),
    monthly_limit_cents: value.monthly_limit_cents, currency: 'EUR' };
}

function authorizationTargets(context, requested) {
  const inspection = context.latest?.inspection;
  if (!hash(grantHash(context)) || !positive(Number(context.grant.connection.id))
    || !/^[a-f0-9-]{36}$/.test(context.latest?.run_id || '') || !hash(inspection?.fingerprint) || !Array.isArray(inspection.targets)
    || !Array.isArray(inspection.actions) || inspection.actions.length !== ACTIONS.length
    || new Set(inspection.actions.map(row => row.action)).size !== ACTIONS.length
    || inspection.actions.some(row => !ACTIONS.includes(row.action) || !Number.isSafeInteger(row.targets) || row.targets < 0
      || row.targets !== inspection.targets.filter(target => target.action === row.action).length)
    || inspection.fingerprint !== digest([inspection.reference, inspection.currency, inspection.targets, inspection.actions])
    || inspection.targets.some(target => !scopedTarget(target, context.reference))) fail('workspace_optimization_incomplete');
  const targets = inspection.targets.filter(target => requested.includes(target.action));
  const identities = targets.map(target => JSON.stringify([target.action, target.entity, target.id, target.group_id || null, target.field]));
  if (new Set(identities).size !== identities.length) fail('workspace_optimization_incomplete');
  // Keep the exact reviewed resources; import_future never grants rights over new advertising resources.
  return targets.map(({ action, entity, id, group_id, resource, field, unit, strategy, match_type }) => ({ action, entity, id, resource, field,
    ...(group_id ? { group_id } : {}), ...(unit ? { unit } : {}), ...(strategy ? { strategy } : {}), ...(match_type ? { match_type } : {}) }));
}

async function loadOptimizationAuthorizationReview({ models, scope, setting, campaigns, loadInventory, now = new Date(), transaction = null,
  resolveContext = optimizationContext }) {
  if (setting?.preferences?.mode !== 'optimize') return { review: { enabled: false, ready: false, campaigns: [], limits: null }, authorization: null };
  let limits;
  try { limits = optimizationLimits(setting.preferences); }
  catch (error) { return { review: { enabled: true, ready: false, campaigns: [], limits: null, error: safeError(error) }, authorization: null }; }
  const rows = []; const authorized = []; const seen = new Set();
  for (const campaign of campaigns.filter(campaign => campaignIncluded(campaign, setting))) {
    const row = { ...reference(campaign), campaign_key: campaign.id, name: campaign.name, status: 'unchecked', ready: false,
      actions: [], checked_at: null, expires_at: null, error: null };
    if (seen.has(key(campaign))) fail('workspace_optimization_incomplete');
    seen.add(key(campaign));
    if (!campaign.assigned) { rows.push({ ...row, status: 'unassigned' }); continue; }
    if (campaign.paused) { rows.push({ ...row, status: 'not_applicable' }); continue; }
    try {
      const context = await resolveContext({ models, scope, reference: reference(campaign), loadInventory, now, transaction });
      if (context.setting.id !== setting.id || context.setting.version !== setting.version) fail('workspace_scope_changed');
      const proof = publicOptimizationProof(context, now);
      Object.assign(row, { status: proof.status, checked_at: proof.checked_at, expires_at: proof.expires_at, error: proof.error,
        actions: proof.actions.filter(action => action.requested).map(({ action, targets, reasons }) => ({ action, targets, reasons })) });
      if (proof.status === 'checked') {
        const targets = authorizationTargets(context, limits.actions);
        row.ready = targets.length > 0;
        row.status = row.ready ? 'ready' : 'not_applicable';
        if (row.ready) authorized.push({ ...reference(campaign), clinic_id: campaign.clinicId,
          grant_fingerprint: grantHash(context), connection_id: Number(context.grant.connection.id),
          login_customer_id: context.grant.loginCustomerId || null, targets,
          proof_run_id: context.latest.run_id, proof_checked_at: proof.checked_at });
      }
    } catch (error) { row.status = 'failed'; row.error = safeError(error); row.ready = false; row.actions = []; }
    rows.push(row);
  }
  const ready = authorized.length > 0 && rows.every(row => ['ready', 'not_applicable', 'unassigned'].includes(row.status));
  return { review: { enabled: true, ready, campaigns: rows, limits }, authorization: ready ? {
    schema_version: 1, clinic_ids: [...scope.clinicIds].sort((a, b) => a - b), limits,
    campaigns: authorized.sort((a, b) => key(a).localeCompare(key(b))),
  } : null };
}

async function lockOptimizationAccounts({ models, campaigns, transaction }) {
  const accounts = [...new Map(campaigns.map(row => [`${row.provider}:${row.account_id}`, row])).values()]
    .sort((a, b) => `${a.provider}:${a.account_id}`.localeCompare(`${b.provider}:${b.account_id}`));
  // Common existing account rows serialize authorizations from different clinic/group settings.
  for (const account of accounts) {
    const google = account.provider === 'google_ads';
    const owners = await (google ? models.ClinicGoogleAdsAccount : models.ClinicMetaAsset).findAll({ where: {
      ...(google ? { customerId: { [Op.in]: accountAliases(account.provider, account.account_id) } }
        : { assetType: 'ad_account', metaAssetId: { [Op.in]: accountAliases(account.provider, account.account_id) } }),
    }, attributes: ['id'], order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!owners.length) fail('workspace_optimization_permissions_required');
  }
}

async function assertNoOptimizationOverlap({ models, setting, authorization, transaction }) {
  await lockOptimizationAccounts({ models, campaigns: authorization.campaigns, transaction });
  const others = await models.CampaignWorkspaceSetting.findAll({ where: { id: { [Op.ne]: setting.id },
    'activation.mode': 'optimize', 'activation.status': 'active', 'activation.optimization.status': 'active' },
  transaction, lock: transaction.LOCK.UPDATE });
  const requested = new Set(authorization.campaigns.map(key));
  if (others.some(row => !Array.isArray(row.activation?.optimization?.authorization?.campaigns)
    || row.activation.optimization.authorization.campaigns.some(campaign => requested.has(key(campaign))))) fail('workspace_optimization_conflict');
}

function createOptimizationMandate({ authorization, actorId, now = new Date() }) {
  if (!authorization || !positive(actorId)) fail('workspace_optimization_authorization_required');
  return { schema_version: 1, id: crypto.randomUUID(), status: 'active', authorized_at: now.toISOString(),
    authorized_by_user_id: actorId, authorization: structuredClone(authorization) };
}

async function pauseWorkspaceOptimization({ models, scope, actorId, input, hasAccess, now = () => new Date() }) {
  if (!input || Object.keys(input).sort().join(',') !== 'confirmed,expected_version' || input.confirmed !== true || !positive(input.expected_version)) fail('invalid_workspace_optimization_pause', 400);
  if (!positive(actorId)) fail('unauthenticated', 401);
  const owner = settingScope(scope);
  return models.sequelize.transaction(async transaction => {
    const permitted = async () => {
      const membershipModel = models.UsuarioClinica ? { findAll: query => models.UsuarioClinica.findAll({ ...query, transaction, lock: transaction.LOCK.UPDATE }) } : undefined;
      if (!hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write', membershipModel })) fail('marketing_scope_forbidden', 403);
    };
    await permitted();
    if (!await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, { transaction, lock: transaction.LOCK.UPDATE })) fail('scope_not_found', 404);
    const members = await models.Clinica.findAll({ where: scope.groupId ? { grupoClinicaId: scope.groupId } : { id_clinica: owner.scope_id },
      attributes: ['id_clinica'], transaction, lock: transaction.LOCK.UPDATE });
    if (JSON.stringify(members.map(row => Number(row.id_clinica)).sort((a, b) => a - b)) !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
    const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, transaction, lock: transaction.LOCK.UPDATE });
    if (!setting || setting.version !== input.expected_version) fail('workspace_version_conflict');
    const previous = setting.activation?.optimization;
    if (setting.activation?.schema_version !== 2 || setting.activation.mode !== 'optimize' || previous?.schema_version !== 1
      || !['active', 'paused'].includes(previous.status)) fail('workspace_optimization_authorization_required');
    if (previous.status === 'paused') return { success: true, changed: false, configuration: publicSettings(setting, scope) };
    await permitted();
    const optimization = { ...previous, status: 'paused', paused_at: now().toISOString(), paused_by_user_id: actorId };
    const version = setting.version + 1;
    await setting.update({ activation: { ...setting.activation, optimization }, version, updated_by_user_id: actorId }, { transaction });
    await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version,
      event_type: 'optimization_paused', actor_user_id: actorId, created_at: now(),
      changes: { mandate_id: previous.id, status: { before: previous.status, after: 'paused' }, provider_mutation: false } }, { transaction });
    return { success: true, changed: true, configuration: publicSettings(setting, scope) };
  });
}

async function resolveOptimizationAuthorization({ models, setting, scope, campaign, action, now = new Date(), transaction = null,
  hasAccess, resolveContext = optimizationContext, loadInventory }) {
  const mandate = setting?.activation?.optimization;
  if (setting?.activation?.schema_version !== 2 || setting.activation.mode !== 'optimize' || setting.activation.status !== 'active'
    || mandate?.schema_version !== 1 || mandate.status !== 'active' || !positive(mandate.authorized_by_user_id)
    || !/^[a-f0-9-]{36}$/.test(mandate.id || '') || !Number.isFinite(Date.parse(mandate.authorized_at)) || +new Date(mandate.authorized_at) > +now
    || !mandate.authorization || mandate.authorization.schema_version !== 1
    || !Array.isArray(mandate.authorization.campaigns) || !ACTIONS.includes(action)) fail('workspace_optimization_authorization_required');
  const owner = settingScope(scope);
  if (owner.scope_type !== setting.scope_type || owner.scope_id !== setting.scope_id
    || JSON.stringify(mandate.authorization.clinic_ids) !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
  const membershipModel = transaction && models.UsuarioClinica
    ? { findAll: query => models.UsuarioClinica.findAll({ ...query, transaction, lock: transaction.LOCK.UPDATE }) } : undefined;
  const permitted = () => hasAccess && hasAccess({ userId: mandate.authorized_by_user_id, clinicIds: scope.clinicIds, access: 'write', membershipModel });
  if (!await permitted()) fail('workspace_optimization_permissions_required', 403);
  const authorized = mandate.authorization.campaigns.filter(row => key(row) === key(campaign));
  if (authorized.length !== 1 || !campaignIncluded(campaign, setting)) fail('workspace_optimization_campaign_not_authorized');
  const entry = authorized[0]; const limits = mandate.authorization.limits;
  if (!limits || Object.entries(LIMITS).some(([name, value]) => limits[name] !== value)
    || limits.currency !== 'EUR' || !Array.isArray(limits.actions) || !limits.actions.includes(action)
    || limits.actions.some(value => !ACTIONS.includes(value)) || new Set(limits.actions).size !== limits.actions.length
    || (limits.actions.includes('adjust_budget') ? !positive(limits.monthly_limit_cents)
      || limits.monthly_limit_cents < 10000 || limits.monthly_limit_cents > 5000000 : limits.monthly_limit_cents !== null)
    || !Array.isArray(entry.targets) || entry.targets.some(target => !scopedTarget(target, campaign))
    || !entry.targets.some(target => target.action === action)) fail('workspace_optimization_action_not_authorized');
  const context = await resolveContext({ models, scope, reference: reference(campaign), now, transaction, loadInventory, requirePreferences: false });
  if (context.setting.id !== setting.id || context.setting.version !== setting.version || context.campaign.clinicId !== entry.clinic_id
    || grantHash(context) !== entry.grant_fingerprint || Number(context.grant.connection.id) !== entry.connection_id
    || (context.grant.loginCustomerId || null) !== entry.login_customer_id) fail('workspace_optimization_connection_changed');
  if (!await permitted()) fail('workspace_optimization_permissions_required', 403);
  return { mandate, limits, entry, context };
}

module.exports = { LIMITS, optimizationLimits, loadOptimizationAuthorizationReview, assertNoOptimizationOverlap,
  createOptimizationMandate, pauseWorkspaceOptimization, resolveOptimizationAuthorization, scopedTarget, lockOptimizationAccounts };
