'use strict';
const { Op } = require('sequelize');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { resolveEffectiveTrackingConfig } = require('./effectiveMarketingAssets.service');
const { resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { googleDeliveryContext, googleWorkspaceRouteDeliveryContext, googleWorkspaceNativeDeliveryContext } = require('./googleWorkspaceDeliveryContext.service');
const { googleNativeAdvertisingIdentity } = require('./leadAdvertisingIdentity.service');
const { getGoogleAdsEventConfigs, selectConfiguredEventConfigs, buildConversionActionResource, resolveUserDataPolicy } = require('./googleAdsConversionUpload.service');
const fail = () => { throw Object.assign(Error('conversion_paused'), { code: 'conversion_paused' }); };
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

// Authorization for reading an already-owned receipt, never permission to send.
// No contact, click, lead body or local OAuth credential is loaded here.
async function receiptPolicy({ models, attempt, runtime, now }) {
  const captured = await runtime.broker.assert(runtime.account, runtime.brokerContext);
  const clinicIds = attempt.clinicaId == null ? captured.clinicIds : [Number(attempt.clinicaId)];
  if (!clinicIds.length || clinicIds.some(id => !captured.clinicIds.includes(id))
    || attempt.grupoClinicaId != null && Number(attempt.grupoClinicaId) !== captured.groupId
    || attempt.consentStatus !== 'GRANTED') fail();
  const clinics = [];
  for (const id of clinicIds) {
    const clinic = await models.Clinica.findByPk(id, {
      attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], raw: true, logging: false });
    if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)
      || attempt.grupoClinicaId != null && Number(clinic.grupoClinicaId) !== Number(attempt.grupoClinicaId)) fail();
    clinics.push(clinic);
  }
  const original = attempt.requestMetadata?.workspace_delivery;
  let config, eventConfig, policySnapshot;
  if (['workspace_mandate', 'workspace_native_mandate'].includes(attempt.connectionSource)) {
    const native = attempt.connectionSource === 'workspace_native_mandate';
    if (!positive(attempt.clinicaId) || original?.schema_version !== (native ? 3 : 2)) fail();
    let context, proof;
    if (native) {
      if (attempt.intakeConfigId != null || attempt.requestMetadata.consent_source !== 'google_ads_native_crm') fail();
      const identity = googleNativeAdvertisingIdentity({ ...original.native_identity, version: 1,
        verified_by: 'google_ads_api', clinic_id: Number(attempt.clinicaId) }, Number(attempt.clinicaId));
      if (!identity || identity.account_id !== attempt.customerId || identity.campaign_id !== original.campaign_id) fail();
      context = await require('./campaignWorkspaceGoogleNative.service').resolveWorkspaceGoogleNativeRoute({
        models, clinicId: Number(attempt.clinicaId), identity, eventName: attempt.eventName, now });
      proof = googleWorkspaceNativeDeliveryContext({ context });
    } else {
      context = await require('./campaignWorkspaceGoogleConversion.service').resolveWorkspaceGoogleWebContext({
        models, clinicId: Number(attempt.clinicaId), recordId: attempt.intakeConfigId,
        customData: { customer_id: attempt.customerId, campaign_id: original.campaign_id },
        eventName: attempt.eventName, crmEventSource: CRM_MILESTONE_SOURCE, now });
      proof = googleWorkspaceRouteDeliveryContext({ context, campaignId: original.campaign_id });
    }
    if (!context?.route.brokerGrant || !proof || canonical(proof) !== canonical(original)
      || context.route.connectionId !== Number(attempt.googleConnectionId)
      || (context.route.loginCustomerId || null) !== (attempt.loginCustomerId || null)
      || `customers/${attempt.customerId}/conversionActions/${context.route.destinationId}` !== attempt.conversionAction
      || attempt.assignmentScope !== (native ? context.assignmentScope : context.web.record.assignment_scope)
      || Number(attempt.grupoClinicaId || 0) !== Number((native ? context.groupId : context.web.groupId) || 0)) fail();
    config = context.config; policySnapshot = proof;
    eventConfig = getGoogleAdsEventConfigs(config, attempt.eventName)[0];
  } else {
    if (!['mapping_clinic', 'mapping_group'].includes(attempt.connectionSource)
      || original != null && original.schema_version !== 1 || !positive(attempt.intakeConfigId)) fail();
    const records = await models.IntakeConfig.findAll({ where: { [Op.or]: [
      { assignment_scope: 'clinic', clinic_id: { [Op.in]: clinicIds } },
      ...(captured.groupId ? [{ assignment_scope: 'group', group_id: captured.groupId }] : []),
    ] }, attributes: ['id', 'assignment_scope', 'clinic_id', 'group_id', 'config'], raw: true, logging: false });
    const record = records.find(row => Number(row.id) === Number(attempt.intakeConfigId));
    if (!record || record.assignment_scope !== attempt.assignmentScope
      || (record.assignment_scope === 'clinic' ? Number(record.clinic_id) !== Number(attempt.clinicaId)
        : record.assignment_scope !== 'group' || Number(record.group_id) !== Number(attempt.grupoClinicaId))
      || record.config?.features?.consent_mode_enabled !== true) fail();
    // A newly installed v2 mandate cannot lend permission to an old direct path.
    const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
      { scope_type: 'clinic', scope_id: { [Op.in]: clinicIds } },
      ...(captured.groupId ? [{ scope_type: 'group', scope_id: captured.groupId }] : []),
    ] }, attributes: ['activation'], raw: true, logging: false });
    if (settings.some(row => row.activation && row.activation.schema_version !== 1)) fail();
    const scopedRecords = {
      clinicRecord: records.find(row => row.assignment_scope === 'clinic' && Number(row.clinic_id) === Number(attempt.clinicaId)),
      groupRecord: records.find(row => row.assignment_scope === 'group' && Number(row.group_id) === captured.groupId),
    };
    config = resolveEffectiveTrackingConfig({ assignment_scope: record.assignment_scope,
      clinic_id: attempt.clinicaId, group_id: attempt.grupoClinicaId }, scopedRecords).google_ads;
    const advertiser = config.config_source === 'group' ? scopedRecords.groupRecord : scopedRecords.clinicRecord;
    const candidates = selectConfiguredEventConfigs(getGoogleAdsEventConfigs(config, attempt.eventName), {
      customer_id: attempt.customerId, campaign_id: original?.campaign_id || null }).configs.filter(row =>
      row.enabled && row.customer_id === attempt.customerId && row.destination_key === attempt.destinationKey
      && buildConversionActionResource({ customerId: row.customer_id, conversionAction: row.conversion_action,
        conversionActionId: row.conversion_action_id, sendTo: row.send_to }) === attempt.conversionAction);
    if (candidates.length !== 1 || !advertiser) fail();
    eventConfig = candidates[0];
    const policy = await resolveWorkspaceSignalPolicy({ models, records: [record, advertiser], provider: 'google_ads',
      accountId: attempt.customerId, campaignId: original?.campaign_id || null, eventName: attempt.eventName,
      crmEventSource: CRM_MILESTONE_SOURCE, clinicId: attempt.clinicaId, destinationId: attempt.conversionAction,
      connectionId: attempt.googleConnectionId, loginCustomerId: attempt.loginCustomerId, now });
    if (!policy.allowed || Boolean(original) !== policy.applicable) fail();
    if (original) {
      const proof = googleDeliveryContext({ cfgRecord: record, signalPolicyRecord: advertiser, runtime, policy, campaignId: original.campaign_id });
      if (!proof || canonical(proof) !== canonical(original)) fail();
    }
    policySnapshot = { records: [record, advertiser], policy };
  }
  if (!eventConfig?.enabled) fail();
  if (Number(attempt.requestMetadata?.user_identifier_count || 0) > 0) {
    const policy = resolveUserDataPolicy(config, eventConfig, { now,
      adUserDataConsentStatus: attempt.requestMetadata.explicit_ad_user_data_consent_status,
      adPersonalizationConsentStatus: attempt.requestMetadata.visitor_ad_personalization_consent_status });
    if (!policy.enabled || policy.authorization?.digest !== attempt.requestMetadata.enhanced_conversion_authorization_digest) fail();
  }
  return canonical({ clinics, config, eventConfig, policySnapshot });
}
async function assertGoogleConversionReceiptPolicy(input) {
  try { return await receiptPolicy(input); }
  catch (error) {
    if (/^(workspace_|google_lead_)/.test(error?.code || '')) fail();
    throw error;
  }
}
module.exports = { assertGoogleConversionReceiptPolicy };
