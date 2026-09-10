'use strict';

const { Op } = require('sequelize');
const { resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { resolveMetaSignalContext } = require('./metaWorkspaceSignalContext.service');
const { resolveWebMeasurementMarketingState } = require('./campaignMeasurementReadiness.service');
const { resolveEffectiveTrackingConfig } = require('./effectiveMarketingAssets.service');

const FRESH_MS = 24 * 3600000;
const MAX_ROWS = 10000;
const canonicalRefs = refs => !Array.isArray(refs) || !refs.length || refs.some(ref => !ref || typeof ref.setting_id !== 'string'
  || !['clinic', 'group'].includes(ref.scope_type) || !Number.isSafeInteger(ref.scope_id) || !Number.isSafeInteger(ref.version))
  ? null : JSON.stringify(refs.map(ref => ({ setting_id: ref.setting_id, scope_type: ref.scope_type, scope_id: ref.scope_id, version: ref.version }))
    .sort((a, b) => a.setting_id.localeCompare(b.setting_id)));

function deliveryEvidence(rows, now = new Date()) {
  if (!rows.length) return { checked: false };
  const counts = { accepted: 0, warning: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 };
  for (const row of rows) {
    if (!Object.hasOwn(counts, row.status)) return { checked: false };
    if (row.status === 'pending' && +new Date(row.attempted_at) + 90000 <= +now) counts.unknown++;
    else counts[row.status]++;
  }
  const issues = [];
  if (counts.failed) issues.push(`${counts.failed} ${counts.failed === 1 ? 'envío rechazado' : 'envíos rechazados'}`);
  if (counts.unknown) issues.push(`${counts.unknown} sin confirmación`);
  if (counts.pending) issues.push(`${counts.pending} en proceso`);
  if (counts.warning) issues.push(`${counts.warning} ${counts.warning === 1 ? 'recibido con avisos' : 'recibidos con avisos'}`);
  if (counts.skipped) issues.push(`${counts.skipped} ${counts.skipped === 1 ? 'envío cancelado' : 'envíos cancelados'}`);
  return { checked: true, ready: !issues.length,
    detail: issues.length ? `Meta: ${issues.join('; ')} en las últimas 24 horas. Recibido no significa atribuido como conversión.`
      : `${counts.accepted} envíos recibidos por Meta en las últimas 24 horas. No confirma su atribución como conversiones.`,
    received: counts.accepted + counts.warning, warnings: counts.warning, pending: rows.length - counts.accepted - counts.warning };
}

async function loadMetaSignalEvidence({ models, campaigns, selectedClinics, now = new Date(), context = resolveMetaSignalContext }) {
  const eligible = campaigns.filter(row => row.provider === 'meta_ads' && row.assigned && row.clinicId);
  const evidence = new Map();
  if (!eligible.length) return evidence;
  const rows = await models.MetaSignalDelivery.findAll({ where: {
    [Op.or]: eligible.map(row => ({ clinic_id: row.clinicId, account_id: row.account_id, campaign_id: row.campaign_id })),
    attempted_at: { [Op.between]: [new Date(+now - FRESH_MS), now] },
  }, attributes: ['clinic_id', 'account_id', 'campaign_id', 'dataset_id', 'destination_key', 'event_name',
    'policy_refs', 'status', 'attempted_at', 'completed_at'], order: [['attempted_at', 'DESC']], limit: MAX_ROWS + 1, raw: true });
  // Never turn a truncated delivery history green; a rejected older row could have been omitted.
  if (!rows.length || rows.length > MAX_ROWS) return evidence;
  const clinics = [...new Set(eligible.map(row => row.clinicId))];
  const groups = [...new Set(selectedClinics.filter(row => clinics.includes(Number(row.id_clinica))).map(row => row.grupoClinicaId).filter(Boolean))];
  const records = await models.IntakeConfig.findAll({ where: { [Op.or]: [
    { assignment_scope: 'clinic', clinic_id: { [Op.in]: clinics } },
    ...(groups.length ? [{ assignment_scope: 'group', group_id: { [Op.in]: groups } }] : []),
  ] }, raw: true });
  const contexts = new Map(); const decisions = new Map();
  for (const campaign of eligible) {
    const history = rows.filter(row => Number(row.clinic_id) === campaign.clinicId && row.account_id === campaign.account_id
      && row.campaign_id === campaign.campaign_id);
    if (!history.length) continue;
    const clinic = selectedClinics.find(row => Number(row.id_clinica) === campaign.clinicId);
    if (!clinic) continue;
    const scope = { assignment_scope: 'clinic', clinic_id: campaign.clinicId, group_id: clinic.grupoClinicaId };
    const configRecords = {
      clinicRecord: records.find(row => row.assignment_scope === 'clinic' && Number(row.clinic_id) === campaign.clinicId),
      groupRecord: records.find(row => row.assignment_scope === 'group' && Number(row.group_id) === Number(clinic.grupoClinicaId)),
    };
    const state = resolveWebMeasurementMarketingState(scope, { scope, records: configRecords });
    if (!state.record) continue;
    const tracking = resolveEffectiveTrackingConfig({ ...scope, assignment_scope: state.record.assignment_scope }, configRecords).meta_ads;
    const signalPolicyRecord = tracking.config_source === 'group' ? configRecords.groupRecord : configRecords.clinicRecord;
    const key = `${campaign.clinicId}:${campaign.account_id}:${tracking.pixel_id}`;
    if (!contexts.has(key)) {
      try { contexts.set(key, await context({ models, now, input: { clinicId: campaign.clinicId,
        adAccountId: campaign.account_id, pixelId: tracking.pixel_id, webPolicyRecord: state.record, signalPolicyRecord } })); }
      catch (error) {
        if (!/^workspace_/.test(error.code || '')) throw error;
        contexts.set(key, null);
      }
    }
    const current = contexts.get(key);
    if (!current) continue;
    const verified = [];
    for (const row of history) {
      if (row.dataset_id !== tracking.pixel_id || row.destination_key !== current.destinationKey
        || row.status !== 'pending' && (!row.completed_at || !Number.isFinite(+new Date(row.completed_at)) || +new Date(row.completed_at) > +now
          || +new Date(row.completed_at) < +new Date(row.attempted_at))) continue;
      const eventKey = `${campaign.id}:${row.event_name}`;
      if (!decisions.has(eventKey)) decisions.set(eventKey, await resolveWorkspaceSignalPolicy({
        records: [current.webPolicyRecord, current.signalPolicyRecord], provider: 'meta_ads',
        models, now, clinicId: campaign.clinicId, destinationId: row.dataset_id, connectionId: current.connectionId || 0,
        accountId: campaign.account_id, campaignId: campaign.campaign_id, eventName: row.event_name,
        crmEventSource: CRM_MILESTONE_SOURCE,
        loadSetting: settingId => models.CampaignWorkspaceSetting.findByPk(settingId, { raw: true }),
      }));
      const policy = decisions.get(eventKey);
      if (policy.applicable && policy.allowed && canonicalRefs(row.policy_refs) === canonicalRefs(policy.policyRefs)) verified.push(row);
    }
    evidence.set(campaign.id, { ...deliveryEvidence(verified, now), key: campaign.id });
  }
  return evidence;
}

module.exports = { FRESH_MS, MAX_ROWS, deliveryEvidence, loadMetaSignalEvidence };
