'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { resolveEffectiveTrackingConfig, normalizeMetaAdsConfig } = require('./effectiveMarketingAssets.service');
const { CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { resolveWorkspaceSignalRoute } = require('./campaignWorkspaceSignalRouting.service');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const cleanAccount = value => String(value || '').replace(/^act_/, '');
const scopeKey = row => `${row.assignment_scope}:${Number(row.assignment_scope === 'group' ? row.group_id : row.clinic_id)}`;

async function resolveMetaSignalContext({ models, input, now = new Date(), transaction = null }) {
  const query = transaction ? { transaction } : {};
  if (!Number.isSafeInteger(input.clinicId) || input.clinicId < 1) fail('workspace_clinic_required');
  if (input.crmEventSource === CRM_MILESTONE_SOURCE && /^[0-9]{1,64}$/.test(input.verifiedNativeLeadId || '')) {
    if (!['qualifiedlead', 'schedule'].includes(String(input.eventName || '').replace(/[_\s-]/g, '').toLowerCase())) {
      fail('workspace_meta_native_event_required');
    }
    const route = await resolveWorkspaceSignalRoute({ models, provider: 'meta_ads', accountId: cleanAccount(input.adAccountId),
      campaignId: input.campaignId, clinicId: input.clinicId, eventName: input.eventName, crmEventSource: input.crmEventSource, now, transaction });
    if (route) {
      if (route.destinationId !== input.pixelId) fail('workspace_meta_destination_changed');
      return { destinationKey: route.destinationKey, accessToken: route.accessToken, connectionId: route.connectionId,
        workspaceAuthorization: route.authorization, webPolicyRecord: null, signalPolicyRecord: null };
    }
  }
  const clinic = await models.Clinica.findByPk(input.clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], raw: true, ...query,
  });
  if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)) fail('workspace_clinic_inactive');
  const clinicRecord = await models.IntakeConfig.findOne({ where: { assignment_scope: 'clinic', clinic_id: input.clinicId }, raw: true, ...query });
  const groupRecord = clinic.grupoClinicaId ? await models.IntakeConfig.findOne({
    where: { assignment_scope: 'group', group_id: clinic.grupoClinicaId }, raw: true, ...query,
  }) : null;
  const records = [clinicRecord, groupRecord].filter(Boolean);
  // Reload by current ownership, not by an arbitrary record ID supplied to the emitter.
  const webPolicyRecord = records.find(row => input.webPolicyRecord?.id && row.id === input.webPolicyRecord.id);
  if (!webPolicyRecord || webPolicyRecord.assignment_scope === 'group'
    && (!Array.isArray(webPolicyRecord.config?.locations)
      || !webPolicyRecord.config.locations.some(location => Number(location?.id ?? location?.clinic_id) === input.clinicId))) {
    fail('workspace_meta_web_scope_changed');
  }
  const tracking = resolveEffectiveTrackingConfig({ assignment_scope: webPolicyRecord.assignment_scope,
    clinic_id: input.clinicId, group_id: clinic.grupoClinicaId || null }, { clinicRecord, groupRecord }).meta_ads;
  const signalPolicyRecord = tracking.config_source === 'group' ? groupRecord : clinicRecord;
  if (!signalPolicyRecord || input.signalPolicyRecord?.id !== signalPolicyRecord.id) fail('workspace_meta_advertiser_scope_changed');
  const ownTracking = normalizeMetaAdsConfig(signalPolicyRecord.config?.meta_ads);
  if (!tracking.enabled || !ownTracking.enabled || ownTracking.pixel_id !== tracking.pixel_id
    || ownTracking.connection_id !== tracking.connection_id || ownTracking.ad_account_id !== tracking.ad_account_id
    || !/^[0-9]{1,64}$/.test(tracking.pixel_id || '') || !tracking.connection_id
    || tracking.pixel_id !== input.pixelId || cleanAccount(tracking.ad_account_id) !== cleanAccount(input.adAccountId)) {
    fail('workspace_meta_destination_changed');
  }
  const ownerKey = scopeKey(signalPolicyRecord);
  const assignment = await models.MetaConnectionAssignment.findOne({ where: { scopeKey: ownerKey, status: 'active',
    metaConnectionId: tracking.connection_id }, raw: true, ...query });
  if (!assignment || assignment.assignmentScope !== signalPolicyRecord.assignment_scope
    || Number(assignment.assignmentScope === 'group' ? assignment.grupoClinicaId : assignment.clinicaId)
      !== Number(signalPolicyRecord.assignment_scope === 'group' ? signalPolicyRecord.group_id : signalPolicyRecord.clinic_id)) fail('workspace_meta_permissions_required');
  const mappings = await models.ClinicMetaAsset.findAll({ where: {
    isActive: true, assetType: 'ad_account', metaConnectionId: tracking.connection_id,
    metaAssetId: { [Op.in]: [cleanAccount(input.adAccountId), `act_${cleanAccount(input.adAccountId)}`] },
    assignmentScope: signalPolicyRecord.assignment_scope,
    ...(signalPolicyRecord.assignment_scope === 'group' ? { grupoClinicaId: signalPolicyRecord.group_id } : { clinicaId: input.clinicId }),
  }, attributes: ['id', 'metaAssetId'], raw: true, ...query });
  if (mappings.length !== 1) fail('workspace_meta_account_mapping_required');
  const connection = await models.MetaConnection.findByPk(tracking.connection_id, {
    attributes: ['id', 'accessToken', 'expiresAt'], raw: true, ...query,
  });
  if (!connection?.accessToken || connection.expiresAt && (!Number.isFinite(+new Date(connection.expiresAt))
    || +new Date(connection.expiresAt) <= +now)) fail('workspace_meta_permissions_required');
  const destinationKey = crypto.createHash('sha256').update(JSON.stringify({
    clinic: input.clinicId, group: clinic.grupoClinicaId || null, account: cleanAccount(input.adAccountId),
    dataset: tracking.pixel_id, connection: connection.id, mapping: mappings[0].id,
    assignment: assignment.id, connectedAt: assignment.connectedAt || null, owner: ownerKey,
    web: webPolicyRecord.id, advertiser: signalPolicyRecord.id,
  })).digest('hex');
  return { destinationKey, accessToken: connection.accessToken, connectionId: Number(connection.id), webPolicyRecord, signalPolicyRecord };
}

module.exports = { resolveMetaSignalContext };
