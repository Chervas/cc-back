'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { resolveNativeGoogleLeadIdentity } = require('./leadAdvertisingIdentity.service');
const { receptionAccount, receivingClinic } = require('./googleLeadReception.service');
const { loadSignalRoutingScope, resolveWorkspaceSignalRoute } = require('./campaignWorkspaceSignalRouting.service');
const { CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { resolveEffectiveTrackingConfig } = require('./effectiveMarketingAssets.service');
const { googleWorkspaceNativeDeliveryContext } = require('./googleWorkspaceDeliveryContext.service');
const { ensureGoogleConnectionAccessToken, GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE } = require('./googleAdsScopedRuntime.service');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const reason = error => /^(workspace_|google_lead_)[a-z_]+$/.test(error.code || '') ? error.code : 'workspace_google_native_unavailable';
const enabled = dependencies => (dependencies.env || process.env).CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true';
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const supportedEvent = value => ['qualified_lead', 'schedule'].includes(value);

async function resolveWorkspaceGoogleNativeRoute({ models, clinicId, identity, eventName, now = new Date(),
  routingScope = null, verifyRoute, trackingRecords = null, readReceptionAccount = receptionAccount, transaction = null }) {
  if (!Number.isSafeInteger(clinicId) || clinicId < 1 || identity?.provider !== 'google_ads' || !supportedEvent(eventName)) fail('workspace_google_native_source_required');
  const scope = routingScope || await loadSignalRoutingScope({ models, clinicId, transaction });
  const route = await resolveWorkspaceSignalRoute({ models, provider: 'google_ads', clinicId, accountId: identity.account_id,
    campaignId: identity.campaign_id, eventName, crmEventSource: CRM_MILESTONE_SOURCE, now, transaction, loadScope: async () => scope, verify: verifyRoute });
  if (!route) fail('workspace_google_native_mandate_required');
  // Reuse reception's current account/clinic ownership, not the historical label on the lead.
  const account = await readReceptionAccount({ models, settingId: route.authorization.policyRefs[0].setting_id, accountId: identity.account_id, now, transaction });
  const clinic = await receivingClinic({ models, context: account, identity, transaction });
  if (Number(clinic.id_clinica) !== clinicId || Number(account.connection.id) !== route.connectionId) fail('workspace_google_native_scope_changed');
  const groupId = Number(scope.clinic.grupoClinicaId) || null;
  // Existing optional user-data authorizations remain usable. No installation, CMP or empty Web config is required or created.
  const records = trackingRecords || await models.IntakeConfig.findAll({ where: { [Op.or]: [
    { assignment_scope: 'clinic', clinic_id: clinicId },
    ...(groupId ? [{ assignment_scope: 'group', group_id: groupId }] : []),
  ] }, raw: true, transaction });
  const tracking = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic', clinic_id: clinicId, group_id: groupId }, {
    clinicRecord: records.find(row => row.assignment_scope === 'clinic' && Number(row.clinic_id) === clinicId),
    groupRecord: records.find(row => row.assignment_scope === 'group' && Number(row.group_id) === groupId),
  }).google_ads;
  const config = { enabled: true, customer_id: identity.account_id, user_data_enabled: tracking.user_data_enabled === true,
    enhanced_conversions: tracking.enhanced_conversions, phone_country_code: tracking.phone_country_code,
    events: { [eventName]: { enabled: true, conversion_action_id: route.destinationId,
      user_data_enabled: tracking.events?.[eventName]?.user_data_enabled === true } } };
  return { route, identity, config: structuredClone(config), clinicId, groupId, assignmentScope: 'clinic' };
}

async function nativeLifecycleContext(input, dependencies = {}) {
  const models = dependencies.models || require('../../models');
  const transaction = dependencies.transaction || null;
  const now = (dependencies.now || (() => new Date()))();
  const time = +new Date(input.occurredAt);
  if (!positive(input.leadId) || !positive(input.clinicId) || !supportedEvent(input.eventName)
    || !Number.isFinite(time) || time > +now + 300000 || time < +now - 7 * 86400000) fail('workspace_google_native_milestone_invalid');
  const appointmentId = input.eventName === 'schedule' ? /^appointment-([1-9][0-9]*)$/.exec(input.eventId || '')?.[1] : null;
  if (input.eventName === 'qualified_lead' ? input.eventId !== `lead-${input.leadId}-qualified` : !positive(appointmentId)) fail('workspace_google_native_milestone_invalid');
  const lead = await models.LeadIntake.findByPk(input.leadId, { raw: true, attributes: ['id', 'clinica_id', 'grupo_clinica_id',
    'source', 'source_detail', 'external_source', 'external_id', 'google_ads_customer_id', 'google_ads_campaign_id',
    'consentimiento_canal', 'status_lead', 'archived_at', 'gclid', 'email', 'telefono'], transaction });
  if (!lead || Number(lead.clinica_id) !== Number(input.clinicId) || lead.archived_at || lead.status_lead === 'descartado') fail('workspace_google_native_lead_unavailable');
  const identity = await resolveNativeGoogleLeadIdentity({ models, lead, transaction });
  if (!identity) fail('workspace_google_native_identity_required');
  const appointments = await models.CitaPaciente.findAll({ where: { lead_intake_id: lead.id, clinica_id: Number(input.clinicId),
    ...(appointmentId ? { id_cita: Number(appointmentId) } : {}),
    [Op.or]: [{ es_provisional: false }, { es_provisional: null }],
    estado: { [Op.in]: ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
      'recordatorio_confirmado', 'cambio_solicitado', 'reprogramada', 'completada'] } }, attributes: ['id_cita'], limit: 1, raw: true, transaction });
  if (appointmentId ? !appointments.length : lead.status_lead !== 'cualificado' && !appointments.length) fail('workspace_google_native_milestone_not_current');
  const context = await resolveWorkspaceGoogleNativeRoute({ models, clinicId: Number(input.clinicId), identity, eventName: input.eventName, now, transaction });
  const consent = lead.consentimiento_canal && typeof lead.consentimiento_canal === 'object' && !Array.isArray(lead.consentimiento_canal)
    ? structuredClone(lead.consentimiento_canal) : null;
  const contact = { email: lead.email || null, phone: lead.telefono || null };
  const gclid = typeof lead.gclid === 'string' && lead.gclid.length <= 128 && !/\s/.test(lead.gclid) ? lead.gclid : null;
  return { ...context, consent, contact, gclid,
    sourceFingerprint: hash([lead.id, identity, context.route.destinationKey, context.route.authorization.policyRefs,
      context.config, consent, contact, gclid, input.eventName, input.eventId, time]) };
}

async function maybeUploadNativeGoogleLifecycleConversion(input, dependencies = {}) {
  if (!enabled(dependencies)) return { sent: false, reason: 'workspace_activation_disabled' };
  if (input.crmEventSource !== CRM_MILESTONE_SOURCE) return { sent: false, reason: 'workspace_crm_milestone_required' };
  const models = dependencies.models || require('../../models');
  let context;
  try { context = await nativeLifecycleContext(input, dependencies); }
  catch (error) {
    if (reason(error) === 'workspace_google_native_unavailable') throw error;
    return { sent: false, reason: reason(error) };
  }
  if (input.expectedSourceFingerprint && input.expectedSourceFingerprint !== context.sourceFingerprint) {
    return { sent: false, reason: 'workspace_google_native_source_changed' };
  }
  const revalidate = async () => {
    try {
      if (!enabled(dependencies)) fail('workspace_activation_disabled');
      const fresh = await nativeLifecycleContext(input, dependencies);
      if (context.sourceFingerprint !== fresh.sourceFingerprint) fail('workspace_google_native_source_changed');
      return fresh.route.authorization;
    } catch (error) { return { applicable: true, allowed: false, reason: reason(error) }; }
  };
  const upload = dependencies.upload || require('./googleAdsConversionUpload.service').maybeUploadGoogleConversion;
  return upload({ cfgRecord: null, googleAdsConfig: context.config, eventName: input.eventName, eventId: input.eventId,
    clinicId: context.clinicId, groupId: context.groupId, assignmentScope: context.assignmentScope,
    crmEventSource: CRM_MILESTONE_SOURCE, customData: { customer_id: context.identity.account_id,
      campaign_id: context.identity.campaign_id, gclid: context.gclid, conversion_time: input.occurredAt, currency: 'EUR' },
    userData: context.contact,
    dependencies: { ...dependencies, auditModel: models.GoogleAdsConversionUploadAttempt,
      resolveNativeConsent: async () => ({ source: 'google_ads_native_crm', consent: context.consent }),
      resolveWorkspaceSignalPolicy: revalidate,
      googleDeliveryContext: () => googleWorkspaceNativeDeliveryContext({ context }),
      resolveRuntime: async () => {
        const connection = await models.GoogleConnection.findByPk(context.route.connectionId);
        if (!connection) fail('workspace_google_permissions_required');
        const token = await (dependencies.ensureToken || ensureGoogleConnectionAccessToken)(connection,
          { requiredScopes: [GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE] });
        return { connection, accessToken: token.accessToken, loginCustomerId: context.route.loginCustomerId,
          connectionSource: 'workspace_native_mandate' };
      },
    } });
}

module.exports = { resolveWorkspaceGoogleNativeRoute, nativeLifecycleContext, maybeUploadNativeGoogleLifecycleConversion };
