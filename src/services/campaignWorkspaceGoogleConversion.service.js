'use strict';

const { loadSignalRoutingScope, resolveWorkspaceSignalRoute } = require('./campaignWorkspaceSignalRouting.service');
const { resolveWorkspaceWebSignalContext } = require('./campaignWorkspaceWebSignalContext.service');
const { workspaceSignalDecision } = require('./campaignWorkspaceSignalPolicy.service');
const { extractGoogleLeadIdentity } = require('../lib/google-lead-routing');
const { resolveEffectiveTrackingConfig } = require('./effectiveMarketingAssets.service');
const { googleWorkspaceRouteDeliveryContext } = require('./googleWorkspaceDeliveryContext.service');
const { ensureGoogleConnectionAccessToken, GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE } = require('./googleAdsScopedRuntime.service');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const eventKey = value => String(value || '').replace(/[_\s-]/g, '').toLowerCase();
const reason = error => /^workspace_[a-z_]+$/.test(error.code || '') ? error.code : 'workspace_signal_authorization_unavailable';

async function resolveWorkspaceGoogleWebContext({ models, clinicId, recordId, customData = {}, eventName, crmEventSource = null,
  now = new Date(), routingScope = null, verifyRoute, webRecords = null,
  readConnection = id => models.GoogleConnection.findByPk(id) }) {
  const scope = routingScope || await loadSignalRoutingScope({ models, clinicId });
  const mandates = scope.settings.filter(row => row.activation && row.activation.schema_version !== 1);
  if (!mandates.length) return null;
  const identity = extractGoogleLeadIdentity(customData);
  const candidates = [...new Set(mandates.flatMap(row => row.accounts || [])
    .filter(row => row.provider === 'google_ads').map(row => row.account_id))];
  const eligible = identity.customerId ? [identity.customerId] : candidates.filter(accountId => mandates.every(setting =>
    workspaceSignalDecision({ setting, provider: 'google_ads', accountId, campaignId: identity.campaignId, eventName, crmEventSource }).allowed));
  if (eligible.length !== 1) fail('workspace_signal_account_ambiguous');
  const route = await resolveWorkspaceSignalRoute({ models, provider: 'google_ads', clinicId, accountId: eligible[0],
    campaignId: identity.campaignId, eventName, crmEventSource, now, loadScope: async () => scope, verify: verifyRoute });
  if (!route) fail('workspace_signal_authorization_unavailable');
  const web = await resolveWorkspaceWebSignalContext({ models, clinic: scope.clinic, recordId, records: webRecords });
  const connection = await readConnection(route.connectionId);
  if (!connection?.accessToken || (!Number.isFinite(+new Date(connection.expiresAt))
    || +new Date(connection.expiresAt) <= +now) && !connection.refreshToken) fail('workspace_google_permissions_required');
  const tracking = resolveEffectiveTrackingConfig({ assignment_scope: web.record.assignment_scope,
    clinic_id: clinicId, group_id: web.groupId }, web.records).google_ads;
  const key = eventKey(eventName) === 'qualifiedlead' ? 'qualified_lead' : eventKey(eventName);
  // Preserve the documented user-data policy, never the old web conversion target or fan-out.
  const config = { enabled: true, customer_id: eligible[0], user_data_enabled: tracking.user_data_enabled === true,
    enhanced_conversions: tracking.enhanced_conversions, phone_country_code: tracking.phone_country_code,
    events: { [key]: { enabled: true, conversion_action_id: route.destinationId,
      user_data_enabled: tracking.events?.[key]?.user_data_enabled === true } } };
  return { route, web, config: structuredClone(config), accountId: eligible[0], campaignId: identity.campaignId };
}

async function maybeUploadCampaignGoogleConversion(options = {}) {
  const dependencies = options.dependencies || {};
  const models = dependencies.models || require('../../models');
  const now = () => typeof dependencies.now === 'function' ? dependencies.now() : dependencies.now || new Date();
  const upload = dependencies.upload || require('./googleAdsConversionUpload.service').maybeUploadGoogleConversion;
  const existingUpload = () => upload({ ...options, dependencies: { ...dependencies,
    auditModel: dependencies.auditModel || models.GoogleAdsConversionUploadAttempt } });
  if (!['lead', 'contact', 'qualifiedlead', 'schedule', 'purchase'].includes(eventKey(options.eventName))) return existingUpload();
  let context;
  try {
    if (!Number.isSafeInteger(options.clinicId) || options.clinicId < 1) {
      if (options.cfgRecord?.assignment_scope === 'group') {
        const setting = await models.CampaignWorkspaceSetting.findOne({
          where: { scope_type: 'group', scope_id: Number(options.cfgRecord.group_id) }, raw: true,
        });
        if (setting?.activation && setting.activation.schema_version !== 1) fail('workspace_clinic_required');
      }
      return existingUpload();
    }
    context = await resolveWorkspaceGoogleWebContext({ models, clinicId: options.clinicId, recordId: options.cfgRecord?.id,
      customData: options.customData, eventName: options.eventName, crmEventSource: options.crmEventSource, now: now() });
  } catch (error) {
    if (/^workspace_/.test(error.code || '')) return { sent: false, reason: reason(error) };
    throw error;
  }
  if (!context) return existingUpload();
  const { route, web, config, campaignId } = context;
  const eventName = eventKey(options.eventName) === 'qualifiedlead' ? 'qualified_lead' : eventKey(options.eventName);
  const binding = () => googleWorkspaceRouteDeliveryContext({ context, campaignId });
  return upload({ ...options, cfgRecord: web.record, signalPolicyRecord: null, googleAdsConfig: config, eventName,
    groupId: web.groupId, assignmentScope: web.record.assignment_scope,
    dependencies: { ...dependencies,
      auditModel: dependencies.auditModel || models.GoogleAdsConversionUploadAttempt,
      googleDeliveryContext: binding,
      resolveWorkspaceSignalPolicy: async () => {
        try {
          const fresh = await resolveWorkspaceGoogleWebContext({ models, clinicId: options.clinicId, recordId: web.record.id,
            customData: options.customData, eventName, crmEventSource: options.crmEventSource, now: now() });
          if (!fresh || fresh.route.destinationKey !== route.destinationKey || fresh.web.fingerprint !== web.fingerprint
            || JSON.stringify(fresh.config) !== JSON.stringify(config)
            || JSON.stringify(fresh.route.authorization.policyRefs) !== JSON.stringify(route.authorization.policyRefs)) fail('workspace_signal_connection_changed');
          return fresh.route.authorization;
        } catch (error) { return { applicable: true, allowed: false, reason: reason(error) }; }
      },
      resolveRuntime: async () => {
        const connection = await models.GoogleConnection.findByPk(route.connectionId);
        if (!connection) fail('workspace_google_permissions_required');
        const token = await (dependencies.ensureToken || ensureGoogleConnectionAccessToken)(connection,
          { requiredScopes: [GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE] });
        return { connection, accessToken: token.accessToken, loginCustomerId: route.loginCustomerId, connectionSource: 'workspace_mandate' };
      },
    } });
}

module.exports = { resolveWorkspaceGoogleWebContext, maybeUploadCampaignGoogleConversion };
