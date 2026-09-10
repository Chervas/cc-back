'use strict';

const { Op } = require('sequelize');
const { googleDeliveryContext, googleWorkspaceRouteDeliveryContext } = require('./googleWorkspaceDeliveryContext.service');
const { resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { resolveWebMeasurementMarketingState } = require('./campaignMeasurementReadiness.service');
const { resolveEffectiveTrackingConfig } = require('./effectiveMarketingAssets.service');
const { getGoogleAdsEventConfigs, selectConfiguredEventConfigs, buildConversionActionResource } = require('./googleAdsConversionUpload.service');
const { resolveScopedGoogleAdsRuntime, missingGoogleScopes, GOOGLE_DATA_MANAGER_SCOPE } = require('./googleAdsScopedRuntime.service');
const { loadSignalRoutingScope } = require('./campaignWorkspaceSignalRouting.service');

const FRESH_MS = 24 * 3600000;
const MAX_ROWS = 10000;
const timestamp = value => value ? +new Date(value) : NaN;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function googleDeliveryEvidence(rows, now = new Date()) {
  if (!rows.length) return { checked: false };
  const counts = { received: 0, processed: 0, processing: 0, warnings: 0, pending: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    if (!['pending', 'accepted', 'succeeded', 'partial_success', 'failed', 'skipped'].includes(row.status)) return { checked: false };
    if (['accepted', 'succeeded', 'partial_success'].includes(row.status) && !row.providerRequestId) return { checked: false };
    if (['succeeded', 'partial_success', 'failed', 'skipped'].includes(row.status)
      && (!Number.isFinite(timestamp(row.completedAt)) || timestamp(row.completedAt) > +now
        || timestamp(row.completedAt) < timestamp(row.attemptedAt))) return { checked: false };
    if (row.status === 'pending') counts.pending++;
    if (row.status === 'accepted') { counts.received++; counts.processing++; }
    if (row.status === 'failed') counts.failed++;
    if (row.status === 'skipped') counts.skipped++;
    if (['succeeded', 'partial_success'].includes(row.status)) {
      const diagnostics = row.responseMetadata?.destinations;
      const actionId = row.conversionAction?.split('/').pop();
      // A generic SUCCESS or an unrelated destination is not proof for this action.
      if (!Array.isArray(diagnostics) || diagnostics.length !== 1
        || diagnostics[0].customer_id !== row.customerId || diagnostics[0].conversion_action_id !== actionId
        || diagnostics[0].record_count !== 1
        || !Array.isArray(diagnostics[0].errors) || !Array.isArray(diagnostics[0].warnings)) return { checked: false };
      const result = diagnostics[0];
      counts.received++;
      if (row.status === 'partial_success' || result.status !== 'SUCCESS' || result.errors.length || result.warnings.length) counts.warnings++;
      else counts.processed++;
    }
  }
  const issues = [];
  if (counts.failed) issues.push(`${counts.failed} ${counts.failed === 1 ? 'envío rechazado' : 'envíos rechazados'}`);
  if (counts.pending) issues.push(`${counts.pending} sin confirmación de recepción`);
  if (counts.processing) issues.push(`${counts.processing} ${counts.processing === 1 ? 'recibido, pendiente' : 'recibidos, pendientes'} de procesamiento`);
  if (counts.warnings) issues.push(`${counts.warnings} con avisos o procesamiento parcial`);
  if (counts.skipped) issues.push(`${counts.skipped} ${counts.skipped === 1 ? 'envío cancelado' : 'envíos cancelados'}`);
  return { checked: true, ready: !issues.length, ...counts, pending: counts.pending + counts.failed + counts.skipped,
    detail: `Google: ${issues.length ? issues.join('; ') : `${counts.processed} ${counts.processed === 1 ? 'envío procesado' : 'envíos procesados'} correctamente`} en las últimas 24 horas. No confirma su atribución como conversiones.` };
}

async function loadGoogleSignalEvidence({ models, campaigns, selectedClinics, now = new Date(), resolveRuntime = resolveScopedGoogleAdsRuntime }) {
  const eligible = campaigns.filter(row => row.provider === 'google_ads' && row.assigned && row.clinicId);
  const evidence = new Map();
  if (!eligible.length) return evidence;
  const rows = await models.GoogleAdsConversionUploadAttempt.findAll({ where: {
    [Op.or]: eligible.map(row => ({ clinicaId: row.clinicId, customerId: row.account_id })),
    attemptedAt: { [Op.between]: [new Date(+now - FRESH_MS), now] },
  }, attributes: ['clinicaId', 'grupoClinicaId', 'intakeConfigId', 'assignmentScope', 'customerId', 'destinationKey', 'conversionAction',
    'googleConnectionId', 'connectionSource', 'loginCustomerId', 'eventName', 'status', 'attemptedAt', 'completedAt',
    'providerRequestId', 'requestMetadata', 'responseMetadata'], order: [['attemptedAt', 'DESC']], limit: MAX_ROWS + 1, raw: true });
  if (!rows.length || rows.length > MAX_ROWS) return evidence;
  const clinics = [...new Set(eligible.map(row => row.clinicId))];
  const groups = [...new Set(selectedClinics.filter(row => clinics.includes(Number(row.id_clinica))).map(row => row.grupoClinicaId).filter(Boolean))];
  const records = await models.IntakeConfig.findAll({ where: { [Op.or]: [
    { assignment_scope: 'clinic', clinic_id: { [Op.in]: clinics } },
    ...(groups.length ? [{ assignment_scope: 'group', group_id: { [Op.in]: groups } }] : []),
  ] }, raw: true });
  const runtimes = new Map(); const policies = new Map();
  const routeContexts = new Map();
  const routeScopes = new Map(); const routeGrants = new Map(); const routeConnections = new Map();
  const verifyRoute = input => {
    const key = JSON.stringify([input.clinicId, input.accountId, input.setting.id, input.setting.version, input.eventName, input.destinationId]);
    if (!routeGrants.has(key)) routeGrants.set(key, require('./campaignWorkspaceSignalAuthorization.service').verifySignalDestination(input));
    return routeGrants.get(key);
  };
  const readConnection = id => {
    if (!routeConnections.has(id)) routeConnections.set(id, models.GoogleConnection.findByPk(id));
    return routeConnections.get(id);
  };
  for (const campaign of eligible) {
    const routeHistory = rows.filter(row => Number(row.clinicaId) === campaign.clinicId && row.customerId === campaign.account_id
      && row.requestMetadata?.workspace_delivery?.schema_version === 2
      && row.requestMetadata.workspace_delivery.campaign_id === campaign.campaign_id
      && timestamp(row.attemptedAt) <= +now && timestamp(row.attemptedAt) >= +now - FRESH_MS);
    if (routeHistory.length && selectedClinics.some(row => Number(row.id_clinica) === campaign.clinicId)) {
      const verified = [];
      for (const row of routeHistory) {
        const key = `${campaign.id}:${row.eventName}:${row.intakeConfigId}`;
        if (!routeContexts.has(key)) {
          try {
            // Report-only memoization. No token refresh, provider call or permission cache across requests.
            if (!routeScopes.has(campaign.clinicId)) routeScopes.set(campaign.clinicId, loadSignalRoutingScope({ models, clinicId: campaign.clinicId }));
            const routingScope = await routeScopes.get(campaign.clinicId);
            const context = await require('./campaignWorkspaceGoogleConversion.service').resolveWorkspaceGoogleWebContext({
              models, clinicId: campaign.clinicId, recordId: row.intakeConfigId, eventName: row.eventName,
              customData: { customer_id: campaign.account_id, campaign_id: campaign.campaign_id }, crmEventSource: CRM_MILESTONE_SOURCE, now,
              routingScope, verifyRoute, readConnection, webRecords: {
                clinicRecord: records.find(record => record.assignment_scope === 'clinic' && Number(record.clinic_id) === campaign.clinicId),
                groupRecord: records.find(record => record.assignment_scope === 'group' && Number(record.group_id) === Number(routingScope.clinic.grupoClinicaId)),
              },
            });
            routeContexts.set(key, context);
          } catch (error) {
            if (!/^workspace_/.test(error.code || '')) throw error;
            routeContexts.set(key, null);
          }
        }
        const context = routeContexts.get(key);
        if (!context || row.connectionSource !== 'workspace_mandate' || row.assignmentScope !== context.web.record.assignment_scope
          || Number(row.grupoClinicaId || 0) !== Number(context.web.groupId || 0)
          || Number(row.googleConnectionId) !== context.route.connectionId
          || (row.loginCustomerId || null) !== (context.route.loginCustomerId || null)
          || row.conversionAction !== `customers/${campaign.account_id}/conversionActions/${context.route.destinationId}`) continue;
        const proof = googleWorkspaceRouteDeliveryContext({ context, campaignId: campaign.campaign_id });
        if (proof?.fingerprint === row.requestMetadata.workspace_delivery.fingerprint) verified.push(row);
      }
      evidence.set(campaign.id, { ...googleDeliveryEvidence(verified, now), key: campaign.id });
      continue;
    }
    const history = rows.filter(row => Number(row.clinicaId) === campaign.clinicId && row.customerId === campaign.account_id
      && row.requestMetadata?.workspace_delivery?.schema_version === 1
      && row.requestMetadata.workspace_delivery.campaign_id === campaign.campaign_id
      && timestamp(row.attemptedAt) <= +now && timestamp(row.attemptedAt) >= +now - FRESH_MS);
    if (!history.length) continue;
    const clinic = selectedClinics.find(row => Number(row.id_clinica) === campaign.clinicId);
    if (!clinic) continue;
    const scope = { assignment_scope: 'clinic', clinic_id: campaign.clinicId, group_id: clinic.grupoClinicaId };
    const configRecords = {
      clinicRecord: records.find(row => row.assignment_scope === 'clinic' && Number(row.clinic_id) === campaign.clinicId),
      groupRecord: records.find(row => row.assignment_scope === 'group' && Number(row.group_id) === Number(clinic.grupoClinicaId)),
    };
    const state = resolveWebMeasurementMarketingState(scope, { scope, records: configRecords });
    if (!state.record || state.source === 'group_fallback') continue;
    const tracking = resolveEffectiveTrackingConfig({ ...scope, assignment_scope: state.record.assignment_scope }, configRecords).google_ads;
    const advertiser = tracking.config_source === 'group' ? configRecords.groupRecord : configRecords.clinicRecord;
    if (!advertiser || state.record.config?.features?.consent_mode_enabled !== true) continue;
    const runtimeKey = `${campaign.clinicId}:${campaign.account_id}:${state.record.assignment_scope}`;
    if (!runtimes.has(runtimeKey)) {
      try {
        const runtime = await resolveRuntime({ clinicId: campaign.clinicId, groupId: clinic.grupoClinicaId,
          assignmentScope: state.record.assignment_scope, customerId: campaign.account_id,
          accountModel: models.ClinicGoogleAdsAccount, connectionModel: models.GoogleConnection,
          requiredScopes: [GOOGLE_DATA_MANAGER_SCOPE], ensureAccessToken: async connection => {
            if (!connection.accessToken || missingGoogleScopes(connection.scopes, [GOOGLE_DATA_MANAGER_SCOPE]).length
              || (!Number.isFinite(timestamp(connection.expiresAt)) || timestamp(connection.expiresAt) <= +now) && !connection.refreshToken) {
              fail('workspace_google_permissions_required');
            }
            // Health is read-only: never refresh credentials or call Google from a report GET.
            return { accessToken: connection.accessToken };
          } });
        const account = runtime.account;
        if (!account) fail('workspace_google_permissions_required');
        const scopeKey = account.assignmentScope === 'group' ? `group:${account.grupoClinicaId}` : `clinic:${account.clinicaId}`;
        const assignment = await models.GoogleConnectionAssignment.findOne({ where: { scopeKey, status: 'active',
          googleConnectionId: runtime.connection.id }, raw: true });
        if (!assignment || assignment.assignmentScope !== account.assignmentScope
          || Number(assignment.assignmentScope === 'group' ? assignment.grupoClinicaId : assignment.clinicaId)
            !== Number(account.assignmentScope === 'group' ? account.grupoClinicaId : account.clinicaId)
          || !Number.isFinite(timestamp(assignment.connectedAt)) || timestamp(assignment.connectedAt) > +now) fail('workspace_google_permissions_required');
        runtimes.set(runtimeKey, { runtime, connectedAt: timestamp(assignment.connectedAt) });
      } catch (error) {
        if (!['workspace_google_permissions_required', 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE', 'GOOGLE_ADS_ACCOUNT_MAPPING_AMBIGUOUS',
          'NO_SCOPED_CONNECTION'].includes(error.code)) throw error;
        runtimes.set(runtimeKey, null);
      }
    }
    const current = runtimes.get(runtimeKey);
    if (!current) continue;
    const verified = [];
    for (const row of history) {
      if (Number(row.intakeConfigId) !== Number(state.record.id) || row.assignmentScope !== state.record.assignment_scope
        || Number(row.grupoClinicaId || 0) !== Number(clinic.grupoClinicaId || 0)
        || Number(row.googleConnectionId) !== Number(current.runtime.connection.id)
        || row.connectionSource !== current.runtime.connectionSource || (row.loginCustomerId || null) !== (current.runtime.loginCustomerId || null)
        || timestamp(row.attemptedAt) < current.connectedAt) continue;
      const selected = selectConfiguredEventConfigs(getGoogleAdsEventConfigs(tracking, row.eventName),
        { customer_id: campaign.account_id, campaign_id: campaign.campaign_id }).configs;
      const matching = selected.filter(config => config.enabled && config.customer_id === row.customerId
        && config.destination_key === row.destinationKey && buildConversionActionResource({ customerId: config.customer_id,
          conversionAction: config.conversion_action, conversionActionId: config.conversion_action_id, sendTo: config.send_to }) === row.conversionAction);
      if (matching.length !== 1) continue;
      const policyKey = `${campaign.id}:${row.eventName}:${row.conversionAction}`;
      if (!policies.has(policyKey)) policies.set(policyKey, await resolveWorkspaceSignalPolicy({
        records: [state.record, advertiser], provider: 'google_ads', accountId: campaign.account_id,
        models, now, clinicId: campaign.clinicId, destinationId: row.conversionAction,
        connectionId: current.runtime.connection.id, loginCustomerId: current.runtime.loginCustomerId || null,
        campaignId: campaign.campaign_id, eventName: row.eventName, crmEventSource: CRM_MILESTONE_SOURCE,
        loadSetting: id => models.CampaignWorkspaceSetting.findByPk(id, { raw: true }),
      }));
      const binding = googleDeliveryContext({ cfgRecord: state.record, signalPolicyRecord: advertiser,
        runtime: current.runtime, policy: policies.get(policyKey), campaignId: campaign.campaign_id });
      if (binding && binding.fingerprint === row.requestMetadata.workspace_delivery.fingerprint) verified.push(row);
    }
    evidence.set(campaign.id, { ...googleDeliveryEvidence(verified, now), key: campaign.id });
  }
  return evidence;
}

module.exports = { FRESH_MS, MAX_ROWS, googleDeliveryEvidence, loadGoogleSignalEvidence };
