'use strict';

const { Op } = require('sequelize');
const { enabled } = require('./campaignWorkspaceOptimizationCommand.service');
const { digest, optimizationReference, inspectGoogleOptimization, inspectMetaOptimization } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { performancePeriod, inspectGooglePerformance, inspectMetaPerformance } = require('./campaignWorkspacePerformanceSnapshot.service');
const { canonicalLeadAdvertisingIdentity, attachLeadAdvertisingIdentities } = require('./leadAdvertisingIdentity.service');
const { createLeadAdMatcher } = require('./campaignAdAttribution.service');
const { formatDateLocal, localDateTimeToUtc } = require('../lib/availability-calendar');

const MAX_LEADS = 10000;
const TTL_MS = 60000;
const ACTIONS = ['pause_underperforming_ads', 'adjust_bids', 'adjust_budget', 'negative_keywords'];
const LEAD_FIELDS = ['id', 'clinica_id', 'source', 'channel', 'source_detail', 'google_ads_customer_id',
  'google_ads_campaign_id', 'external_source', 'external_id', 'created_at'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const instant = deps => (deps.now || (() => new Date()))();
const sameCampaign = (a, b) => ['provider', 'account_id', 'campaign_id'].every(key => a?.[key] === b?.[key]);
const nextDay = day => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

function sourceStamp(setting, scope, source) {
  const grant = source.context.grant;
  if (!positive(Number(grant.connection?.id)) || !/^[a-f0-9]{64}$/.test(grant.grantFingerprint || grant.fingerprint || '')) {
    fail('workspace_optimization_connection_changed');
  }
  const campaign = source.context.campaign;
  return digest([setting.id, setting.version, setting.accounts, setting.activation.optimization, scope, source.entry,
    grant.grantFingerprint || grant.fingerprint, Number(grant.connection.id), grant.loginCustomerId || null,
    campaign.clinicId, campaign.destination, campaign.urls, campaign.destinationCheckedAt, campaign.destinationCheck]);
}

// Only aggregate counts leave this function; no contact details, payloads or lead IDs enter the evidence record.
function leadCounts(leads, campaign, snapshot) {
  const reference = snapshot.reference; const period = snapshot.period;
  const ads = snapshot.inventory.map(ad => ({ advertisingId: ad.id, groupId: ad.group_id }));
  const matchAd = createLeadAdMatcher([campaign], new Map([[campaign.id, ads]]));
  const seen = new Set(); const counts = new Map(); let unattributed = 0;
  for (const lead of leads) {
    if (!positive(Number(lead.id)) || seen.has(String(lead.id)) || Number(lead.clinica_id) !== campaign.clinicId
      || !Number.isFinite(+new Date(lead.created_at))) fail('workspace_optimization_attribution_incomplete');
    seen.add(String(lead.id));
    const day = formatDateLocal(new Date(lead.created_at), 'Europe/Madrid');
    if (day < period.start || day > period.end) fail('workspace_optimization_attribution_incomplete');
    if (!['paid', null, undefined].includes(lead.channel)) continue;
    const identity = canonicalLeadAdvertisingIdentity(lead);
    if (!identity || lead.advertising_identity_conflict) {
      if (lead.channel === 'paid' || ['google_ads', 'meta_ads'].includes(lead.source)) unattributed++;
      continue;
    }
    if (!sameCampaign(reference, identity)) continue;
    const ad = matchAd(lead, campaign.id);
    if (!ad) { unattributed++; continue; }
    const key = `${day}:${ad}`;
    const [group_id, ad_id] = ad.split('~');
    const row = counts.get(key) || { date: day, ad_id, group_id, leads: 0 };
    row.leads++; counts.set(key, row);
  }
  return { schema_version: 1, basis: 'crm_created_at', complete: unattributed === 0, unattributed_leads: unattributed,
    ad_daily: [...counts.values()].sort((a, b) => `${a.date}:${a.group_id}:${a.ad_id}`.localeCompare(`${b.date}:${b.group_id}:${b.ad_id}`)) };
}

function safeError(error) {
  if (['NO_SCOPED_CONNECTION', 'INSUFFICIENT_SCOPE', 'NO_TOKEN', 'TOKEN_EXPIRED', 'REFRESH_FAILED',
    'workspace_meta_permissions_required', 'workspace_google_permissions_required', 'marketing_scope_forbidden'].includes(error?.code)
    || [10, 190, 200].includes(Number(error?.response?.data?.error?.code)) || [401, 403].includes(error?.response?.status)) {
    return 'workspace_optimization_permissions_required';
  }
  if ([4, 17, 613].includes(Number(error?.response?.data?.error?.code)) || error?.response?.status === 429) return 'workspace_optimization_rate_limited';
  if (/^workspace_optimization_[a-z_]{1,80}$/.test(error?.code || '')) return error.code;
  return 'workspace_optimization_evidence_unavailable';
}

async function assertOptimizationReception({ models, scope, campaign, now, transaction = null }, deps = {}) {
  if (campaign.destinationCheck?.status) fail('workspace_optimization_reception_unverified');
  const inventory = await (deps.loadInventory || require('./campaignWorkspace.service').loadWorkspaceInventory)({ models, scope, transaction });
  const evidence = await (deps.loadReception || require('./campaignWorkspace.service').loadWebEvidence)({ models, campaigns: [campaign],
    selectedClinics: inventory.selectedClinics, groups: inventory.groups, scope, now, transaction });
  const value = evidence.get(campaign.id)?.reception;
  if (value?.checked !== true || value.ready !== true || value.state !== 'verified') fail('workspace_optimization_reception_unverified');
  return { checked: true, ready: true, state: 'verified' };
}

// Internal collection only. No public route, scheduler, persistent command or provider mutation is created here.
async function collectOptimizationEvidence({ settingId, mandateId, reference: input, action = 'pause_underperforming_ads' }, deps = {}) {
  if (!enabled(deps.env || process.env)) return { collected: false, reason: 'workspace_optimization_disabled' };
  try {
    if (!uuid(settingId) || !uuid(mandateId) || !ACTIONS.includes(action)) fail('workspace_optimization_evidence_invalid');
    const reference = optimizationReference(input);
    if (action === 'negative_keywords' && reference.provider !== 'google_ads') fail('workspace_optimization_search_terms_unsupported');
    const models = deps.models || require('../../models');
    const resolve = deps.resolveAuthorization || require('./campaignWorkspaceOptimizationAuthorization.service').resolveOptimizationAuthorization;
    const hasAccess = deps.hasAccess || require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
    const started = instant(deps); const period = performancePeriod(started);
    let initialStamp; let initialCampaign;
    const checkTime = () => {
      if (!enabled(deps.env || process.env)) fail('workspace_optimization_disabled');
      const age = +instant(deps) - +started;
      if (!Number.isFinite(age) || age < 0 || age >= TTL_MS) fail('workspace_optimization_evidence_timeout');
      if (digest(performancePeriod(instant(deps))) !== digest(period)) fail('workspace_optimization_evidence_period_changed');
    };
    const authorize = async () => {
      checkTime();
      const setting = await models.CampaignWorkspaceSetting.findByPk(settingId, { raw: true });
      const mandate = setting?.activation?.optimization;
      if (!setting || mandate?.id !== mandateId || !Array.isArray(mandate.authorization?.clinic_ids)
        || !mandate.authorization.clinic_ids.length || mandate.authorization.clinic_ids.some(id => !positive(id))) {
        fail('workspace_optimization_mandate_changed');
      }
      const scope = { groupId: setting.scope_type === 'group' ? setting.scope_id : null, clinicIds: mandate.authorization.clinic_ids };
      const source = await resolve({ models, setting, scope, campaign: reference, action,
        now: instant(deps), hasAccess, loadInventory: deps.loadInventory });
      const campaign = source.context.campaign;
      if (!campaign?.assigned || campaign.paused || !positive(campaign.clinicId) || !scope.clinicIds.includes(campaign.clinicId)
        || source.entry.clinic_id !== campaign.clinicId || !sameCampaign(campaign, reference)) fail('workspace_optimization_scope_changed');
      // A persisted failed check needs an explicit repair. Do not retry a known revoked connection in the background.
      if (campaign.destinationCheck?.status || source.context.latest?.error) fail('workspace_optimization_reception_unverified');
      const stamp = sourceStamp(setting, scope, source);
      if (initialStamp && initialStamp !== stamp) fail('workspace_optimization_scope_changed');
      if (!initialStamp) { initialStamp = stamp; initialCampaign = structuredClone(campaign); }
      checkTime();
      return { source, setting, scope };
    };
    const initial = await authorize();
    const reception = async () => {
      const current = await authorize();
      return assertOptimizationReception({ models, scope: current.scope, campaign: initialCampaign, now: instant(deps) }, deps);
    };
    await reception();
    const google = require('./googleAdsScopedRuntime.service');
    let credentials = { accessToken: initial.source.context.grant.connection.accessToken,
      loginCustomerId: initial.source.context.grant.loginCustomerId };
    if (reference.provider === 'google_ads') {
      await authorize();
      const token = await (deps.ensureToken || google.ensureGoogleConnectionAccessToken)(initial.source.context.grant.connection,
        { requiredScopes: [google.GOOGLE_ADS_SCOPE] });
      credentials = { ...credentials, accessToken: token.accessToken };
    }
    if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) fail('workspace_optimization_permissions_required');
    const guardedRead = read => async (...args) => {
      await authorize();
      const result = await read(...args);
      await authorize();
      return result;
    };
    const googleRead = options => require('../lib/googleAdsSearchRows').googleAdsSearchRows({ ...options,
      request: guardedRead(deps.googleRequest || require('../lib/googleAdsClient').googleAdsRequest) });
    const metaRead = guardedRead(deps.metaRead || require('../lib/metaClient').metaGet);
    if (action === 'negative_keywords') {
      const searchTerms = await require('./campaignWorkspaceSearchTerms.service').inspectGoogleSearchTerms({ reference, ...credentials,
        now: () => instant(deps), clock: deps.clock, read: googleRead });
      const readiness = await reception(); await authorize();
      // Provider search terms cannot be joined to a CRM lead by query text. Keep a separate evidence contract.
      const record = { schema_version: 2, setting_id: settingId, mandate_id: mandateId, clinic_id: initialCampaign.clinicId,
        reference, action, source_fingerprint: initialStamp, search_terms: searchTerms, reception: readiness,
        authorization_targets: initial.source.entry.targets.filter(target => target.action === action).map(target => structuredClone(target)),
        collected_at: started.toISOString(), observed_at: instant(deps).toISOString() };
      return { collected: true, evidence: { ...record, fingerprint: digest(record) } };
    }
    const targetReader = require('./campaignWorkspaceGoogleTargetSnapshot.service');
    if (action === 'adjust_bids' && initial.source.entry.targets.some(target => targetReader.supportedTarget(target, reference))) {
      const snapshot = await targetReader.inspectGoogleTargetSnapshot({ reference, ...credentials, now: () => instant(deps), clock: deps.clock, read: googleRead });
      const readiness = await reception(); await authorize();
      // Provider recommendations use the campaign's conversion goals, not the CRM lead-cost comparison.
      const record = { schema_version: 3, setting_id: settingId, mandate_id: mandateId, clinic_id: initialCampaign.clinicId,
        reference, action, source_fingerprint: initialStamp, target_snapshot: snapshot, reception: readiness,
        authorization_targets: initial.source.entry.targets.filter(target => target.action === action).map(target => structuredClone(target)),
        collected_at: started.toISOString(), observed_at: instant(deps).toISOString() };
      return { collected: true, evidence: { ...record, fingerprint: digest(record) } };
    }
    let controls;
    if (['adjust_bids', 'adjust_budget'].includes(action)) {
      const inspection = reference.provider === 'google_ads'
        ? await inspectGoogleOptimization({ reference, ...credentials, read: googleRead, now: instant(deps) })
        : await inspectMetaOptimization({ reference, ...credentials, read: metaRead, now: instant(deps) });
      if (inspection.currency !== 'EUR' || !sameCampaign(inspection.reference, reference)) fail('workspace_optimization_evidence_invalid');
      controls = inspection.targets.filter(target => target.action === action);
      await authorize();
    }
    const performance = reference.provider === 'google_ads'
      ? await inspectGooglePerformance({ reference, ...credentials, now: () => instant(deps), clock: deps.clock,
        read: googleRead })
      : await inspectMetaPerformance({ reference, ...credentials, now: () => instant(deps), clock: deps.clock,
        read: metaRead });
    await authorize();
    const leads = await models.LeadIntake.findAll({ where: { clinica_id: initialCampaign.clinicId, created_at: {
      [Op.gte]: localDateTimeToUtc(period.start, '00:00', 'Europe/Madrid'),
      [Op.lt]: localDateTimeToUtc(nextDay(period.end), '00:00', 'Europe/Madrid'),
    } }, attributes: LEAD_FIELDS, limit: MAX_LEADS + 1, order: [['id', 'ASC']], raw: true });
    if (leads.length > MAX_LEADS) fail('workspace_optimization_attribution_incomplete');
    await (deps.attachIdentities || attachLeadAdvertisingIdentities)({ models, leads });
    const attribution = leadCounts(leads, initialCampaign, performance);
    const readiness = await reception();
    await authorize();
    const record = { schema_version: 1, setting_id: settingId, mandate_id: mandateId, clinic_id: initialCampaign.clinicId,
      reference, action, source_fingerprint: initialStamp, performance, attribution, reception: readiness,
      authorization_targets: initial.source.entry.targets.filter(target => target.action === action).map(target => structuredClone(target)),
      ...(controls ? { [action === 'adjust_bids' ? 'bid_controls' : 'budget_controls']: controls } : {}),
      collected_at: started.toISOString(), observed_at: instant(deps).toISOString() };
    return { collected: true, evidence: { ...record, fingerprint: digest(record) } };
  } catch (error) { return { collected: false, reason: safeError(error) }; }
}

module.exports = { collectOptimizationEvidence, sourceStamp, assertOptimizationReception, leadCounts, MAX_LEADS, TTL_MS };
