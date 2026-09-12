'use strict';

const { Op } = require('sequelize');
const { campaignIncluded } = require('./campaignWorkspaceSettings.service');
const google = require('./campaignWorkspaceGoogleDestination.service');
const meta = require('./campaignWorkspaceMetaDestination.service');

const DISPATCH_TYPE = 'campaign_workspace_destinations_refresh';
const JOB_TYPE = 'campaign_workspace_destination_check';
const ORIGIN = 'campaign_workspace_destination_cache';
const PAGE_SIZE = 50;
const DAY_MS = 86400000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const enabled = env => env.CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED === 'true';
const providerEnabled = (provider, env) => enabled(env) && (provider === 'google_ads'
  || provider === 'meta_ads' && env.CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED === 'true');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const instant = deps => (deps.now || (() => new Date()))();
const modelsFor = deps => deps.models || require('../../models');
const enqueueFor = deps => deps.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest;
const inventoryFor = deps => deps.loadInventory || require('./campaignWorkspace.service').loadWorkspaceInventory;
const query = transaction => ({ raw: true, transaction });
const signature = setting => JSON.stringify([setting.id, setting.scope_type, setting.scope_id,
  setting.updated_by_user_id, setting.version, setting.accounts]);
const scopeErrors = new Set(['marketing_scope_forbidden', 'workspace_account_not_selected', 'workspace_campaign_not_in_scope',
  'workspace_scope_changed', 'workspace_clinic_assignment_required', 'workspace_clinic_inactive', 'scope_not_found',
  'invalid_google_destination', 'invalid_meta_preparation']);
const safeError = error => scopeErrors.has(error?.code) || /^workspace_(meta|google|destination)_[a-z_]{1,70}$/.test(error?.code || '')
  ? error.code : 'workspace_destination_refresh_failed';
const runtimeKeys = ['__runtime_namespace', '__dedupe_scope'];

function cycleTime(value, now) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
    || +new Date(value) > +now || +now - +new Date(value) >= DAY_MS) fail('workspace_destination_cycle_expired');
  return value;
}

// The cron only fans out IDs. Provider work belongs to the serialized integration lane.
async function enqueueDestinationRefreshes(payload = {}, deps = {}) {
  const env = deps.env || process.env;
  if (!enabled(env)) return { status: 'completed', disabled: true, queued: 0 };
  try {
    if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => ![...runtimeKeys, 'cycle_at', 'after_setting_id'].includes(key))
      || payload.after_setting_id != null && !uuid(payload.after_setting_id)) fail('workspace_destination_job_invalid');
    const models = modelsFor(deps); const enqueue = enqueueFor(deps);
    const now = instant(deps);
    // Root retries retain their original cycle, even after partially enqueuing the first page.
    const root = !payload.cycle_at && deps.jobRequestId
      ? await models.JobRequest.findByPk(deps.jobRequestId, { attributes: ['created_at'], raw: true }) : null;
    if (deps.jobRequestId && !payload.cycle_at && !root) fail('workspace_destination_job_invalid');
    const cycleAt = cycleTime(payload.cycle_at || new Date(root?.created_at || now).toISOString(), now);
    const settings = await models.CampaignWorkspaceSetting.findAll({ attributes: ['id', 'accounts'],
      where: payload.after_setting_id ? { id: { [Op.gt]: payload.after_setting_id } } : {},
      order: [['id', 'ASC']], limit: PAGE_SIZE + 1, raw: true });
    let queued = 0; let duplicates = 0;
    for (const setting of settings.slice(0, PAGE_SIZE)) {
      if (!uuid(setting.id)) fail('workspace_destination_setting_invalid');
      const seen = new Set();
      for (const account of Array.isArray(setting.accounts) ? setting.accounts : []) {
        if (!providerEnabled(account.provider, env) || !id(account.account_id)) continue;
        const key = `${account.provider}:${account.account_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = await enqueue({ type: JOB_TYPE, origin: ORIGIN, priority: 'low', maxAttempts: 3,
          payload: { schema_version: 1, setting_id: setting.id, provider: account.provider, account_id: account.account_id, cycle_at: cycleAt },
          dedupeScope: `${JOB_TYPE}:${setting.id}:${key}:${cycleAt}:start` });
        if (result.created) queued++; else duplicates++;
      }
    }
    const more = settings.length > PAGE_SIZE;
    if (more) await enqueue({ type: DISPATCH_TYPE, origin: ORIGIN, priority: 'low', maxAttempts: 3,
      payload: { cycle_at: cycleAt, after_setting_id: settings[PAGE_SIZE - 1].id },
      dedupeScope: `${DISPATCH_TYPE}:${cycleAt}:${settings[PAGE_SIZE - 1].id}` });
    return { status: 'completed', queued, duplicates, settings: Math.min(settings.length, PAGE_SIZE), continued: more };
  } catch (error) {
    const code = safeError(error);
    return { status: 'failed', retryable: code === 'workspace_destination_refresh_failed', error_message: code };
  }
}

async function refreshScope({ models, setting, hasAccess, transaction = null }) {
  if (!setting || !['clinic', 'group'].includes(setting.scope_type) || !Number.isSafeInteger(Number(setting.scope_id))
    || Number(setting.scope_id) <= 0) fail('workspace_destination_setting_invalid');
  const actorId = Number(setting.updated_by_user_id);
  const user = Number.isSafeInteger(actorId) && actorId > 0
    ? await models.Usuario.findByPk(actorId, { attributes: ['id_usuario', 'estado_cuenta'], ...query(transaction) }) : null;
  if (user?.estado_cuenta !== 'activo') fail('marketing_scope_forbidden');
  const members = setting.scope_type === 'group'
    ? await models.Clinica.findAll({ where: { grupoClinicaId: setting.scope_id },
      attributes: ['id_clinica', 'estado_clinica'], ...query(transaction) })
    : [await models.Clinica.findByPk(setting.scope_id, { attributes: ['id_clinica', 'estado_clinica'], ...query(transaction) })].filter(Boolean);
  if (!members.length || members.some(row => ![true, 1, '1'].includes(row.estado_clinica))) fail('workspace_destination_scope_inactive');
  const clinicIds = [...new Set(members.map(row => Number(row.id_clinica)))].sort((a, b) => a - b);
  if (clinicIds.some(id => !Number.isSafeInteger(id) || id <= 0)) fail('workspace_destination_scope_inactive');
  if (!await hasAccess({ userId: actorId, clinicIds, access: 'write' })) fail('marketing_scope_forbidden');
  return { actorId, scope: { groupId: setting.scope_type === 'group' ? Number(setting.scope_id) : null, clinicIds } };
}

function cacheOutcome(context, provider) {
  const detection = provider === 'google_ads' ? context.detection : context.cached?.destination_detection;
  return { detection, error: provider === 'google_ads' ? detection?.error : meta.destinationCheck(detection).error,
    status: provider === 'google_ads' ? detection?.status : meta.destinationCheck(detection).status || 'checked' };
}

// One campaign per durable task keeps a large account from monopolizing the provider lease.
async function runDestinationRefresh(payload, job, deps = {}) {
  const env = deps.env || process.env;
  if (!enabled(env)) return { status: 'completed', disabled: true };
  try {
    if (job?.type !== JOB_TYPE || job.origin !== ORIGIN || job.requested_by != null
      || !payload || Array.isArray(payload) || payload.schema_version !== 1
      || Object.keys(payload).some(key => ![...runtimeKeys, 'schema_version', 'setting_id', 'provider', 'account_id', 'cycle_at', 'after_campaign_id'].includes(key))
      || !uuid(payload.setting_id) || !['google_ads', 'meta_ads'].includes(payload.provider)
      || !id(payload.account_id) || payload.after_campaign_id != null && !id(payload.after_campaign_id)) fail('workspace_destination_job_invalid');
    if (!providerEnabled(payload.provider, env)) return { status: 'completed', disabled: true };
    cycleTime(payload.cycle_at, instant(deps));
    const models = modelsFor(deps); const loadInventory = inventoryFor(deps);
    const hasAccess = deps.hasAccess || require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
    const setting = await models.CampaignWorkspaceSetting.findByPk(payload.setting_id, { raw: true });
    const { scope, actorId } = await refreshScope({ models, setting, hasAccess });
    const initialSetting = signature(setting);
    const selected = setting.accounts?.filter(row => row.provider === payload.provider && row.account_id === payload.account_id);
    if (selected?.length !== 1) fail('workspace_destination_account_not_selected');
    const inventory = await loadInventory({ models, scope, accountReference: { provider: payload.provider, account_id: payload.account_id } });
    const clinicSettings = scope.groupId ? await models.CampaignWorkspaceSetting.findAll({
      where: { scope_type: 'clinic', scope_id: { [Op.in]: scope.clinicIds } }, attributes: ['scope_id', 'accounts'], raw: true,
    }) : [];
    const campaigns = inventory.campaigns.filter(row => row.provider === payload.provider && row.account_id === payload.account_id
      && campaignIncluded(row, setting) && campaignIncluded(row, clinicSettings.find(local => Number(local.scope_id) === row.clinicId))
      && !/REMOVED|DELETED|ARCHIVED/i.test(row.status || ''));
    const pendingAssignment = campaigns.filter(row => !row.assigned).length;
    const candidates = campaigns.filter(row => row.assigned && (!payload.after_campaign_id || row.campaign_id > payload.after_campaign_id))
      .sort((a, b) => a.campaign_id < b.campaign_id ? -1 : a.campaign_id > b.campaign_id ? 1 : 0);
    if (!candidates.length) return { status: 'completed', checked: 0, pending_assignment: pendingAssignment };
    const campaign = candidates[0];
    const reference = { account_id: payload.account_id, campaign_id: campaign.campaign_id };
    const identity = { provider: payload.provider, ...reference };
    const authorize = async ({ transaction = null } = {}) => {
      if (!providerEnabled(payload.provider, env)) fail('workspace_destination_refresh_disabled');
      cycleTime(payload.cycle_at, instant(deps));
      const latest = await models.CampaignWorkspaceSetting.findByPk(setting.id, query(transaction));
      if (!latest || signature(latest) !== initialSetting) fail('workspace_destination_scope_changed');
      const current = await refreshScope({ models, setting: latest, hasAccess, transaction });
      if (JSON.stringify(current.scope) !== JSON.stringify(scope)) fail('workspace_destination_scope_changed');
      if (scope.groupId) {
        const local = await models.CampaignWorkspaceSetting.findOne({ where: { scope_type: 'clinic', scope_id: campaign.clinicId },
          attributes: ['accounts'], ...query(transaction) });
        if (!campaignIncluded(campaign, local)) fail('workspace_destination_account_not_selected');
      }
      return true;
    };
    const contextFor = payload.provider === 'google_ads' ? deps.googleContext || google.googleDestinationContext : deps.metaContext || meta.metaCampaignContext;
    const context = await contextFor({ models, scope, reference: identity, loadInventory, now: instant(deps) });
    const before = cacheOutcome(context, payload.provider);
    // A known permission rejection needs an explicit connection check, not unattended token retries.
    if (/permissions_required$/.test(before.error || '')) fail(before.error);
    const checkedAt = +new Date(before.detection?.checked_at);
    const expectedSource = payload.provider === 'google_ads' ? google.SOURCE : 'workspace_meta_graph';
    const fresh = before.detection?.source === expectedSource && before.status === 'checked' && Number.isFinite(checkedAt)
      && checkedAt >= +new Date(payload.cycle_at) && checkedAt <= +instant(deps)
      && (payload.provider !== 'google_ads' || before.detection.access_fingerprint === context.account.fingerprint);
    if (!fresh) {
      const refresh = payload.provider === 'google_ads' ? deps.refreshGoogle || google.refreshGoogleDestinations
        : deps.refreshMeta || meta.refreshMetaCampaignDestinations;
      await authorize();
      await refresh({ models, scope, actorId, input: { ...reference, revision: context.revision }, loadInventory,
        now: () => instant(deps), hasAccess: authorize, authorize });
      const outcome = cacheOutcome(await contextFor({ models, scope, reference: identity, loadInventory, now: instant(deps) }), payload.provider);
      if (outcome.error) fail(outcome.error);
      if (outcome.status !== 'checked') fail('workspace_destination_check_pending');
    }
    await authorize();
    if (candidates.length > 1) await enqueueFor(deps)({ type: JOB_TYPE, origin: ORIGIN, priority: 'low', maxAttempts: 3,
      payload: { schema_version: 1, setting_id: setting.id, provider: payload.provider, account_id: payload.account_id,
        cycle_at: payload.cycle_at, after_campaign_id: campaign.campaign_id },
      dedupeScope: `${JOB_TYPE}:${setting.id}:${payload.provider}:${payload.account_id}:${payload.cycle_at}:${campaign.campaign_id}` });
    return { status: 'completed', checked: fresh ? 0 : 1, cached: fresh ? 1 : 0,
      pending_assignment: pendingAssignment, continued: candidates.length > 1, campaign_id: campaign.campaign_id };
  } catch (error) {
    const code = safeError(error);
    const retryable = /_(rate_limited|unavailable|check_timeout|check_busy|check_conflict)$/.test(code)
      || code === 'workspace_destination_refresh_failed';
    return { status: 'failed', retryable, error_message: code };
  }
}

module.exports = { DISPATCH_TYPE, JOB_TYPE, ORIGIN, PAGE_SIZE, enabled, providerEnabled,
  enqueueDestinationRefreshes, refreshScope, runDestinationRefresh };
