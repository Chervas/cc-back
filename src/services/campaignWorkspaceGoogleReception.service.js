'use strict';

const { Op, json } = require('sequelize');
const { googleNativeAdvertisingIdentity } = require('./leadAdvertisingIdentity.service');
const { receptionAccount, receivingClinic, enabled } = require('./googleLeadReception.service');
const { googleDestinationDetection, TTL_MS } = require('./campaignWorkspaceGoogleDestination.service');

function googleNativeForms(raw) {
  const detection = googleDestinationDetection(raw);
  return (Array.isArray(detection?.forms) ? detection.forms : []).filter(form => typeof form?.form_id === 'string' && /^[1-9][0-9]{0,31}$/.test(form.form_id))
    .map(form => ({ id: form.form_id, name: typeof form.name === 'string' ? form.name.slice(0, 255) : null,
      metadataAccessible: form.metadata_accessible === true }));
}

async function loadGoogleNativeEvidence({ models, campaigns, selectedClinics, scope = null, now = new Date(), transaction = null,
  env = process.env, accountContext = receptionAccount, resolveClinic = receivingClinic }) {
  const eligible = campaigns.filter(row => row.provider === 'google_ads' && row.assigned && row.nativeForms?.length);
  if (!eligible.length) return new Map();
  const clinicIds = [...new Set(eligible.map(row => row.clinicId))];
  const groupIds = [...new Set(selectedClinics.map(row => row.grupoClinicaId).filter(Boolean))];
  const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
    { scope_type: 'clinic', scope_id: { [Op.in]: clinicIds } },
    ...(groupIds.length ? [{ scope_type: 'group', scope_id: { [Op.in]: groupIds } }] : []),
  ] }, raw: true, transaction });
  const caches = await models.ExternalCampaignInventory.findAll({ where: { provider: 'google_ads', [Op.or]: eligible.map(row => ({
    customer_id: row.account_id, campaign_id: row.campaign_id,
  })) }, attributes: ['customer_id', 'campaign_id', 'destination_detection'], raw: true, transaction });
  const since = new Date(+now - 7 * TTL_MS);
  // Server receipt metadata and a required CRM join, never contact fields or form answers.
  const audits = await models.LeadAttributionAudit.findAll({ where: { created_at: { [Op.between]: [since, now] } },
    attributes: ['lead_intake_id', [json('attribution_steps.advertising_identity'), 'identity'],
      [json('attribution_steps.google_native_received_at'), 'received_at']],
    include: [{ model: models.LeadIntake, as: 'leadIntake', required: true,
      attributes: ['clinica_id', 'google_ads_customer_id', 'google_ads_campaign_id', 'source_detail'],
      where: { clinica_id: { [Op.in]: clinicIds }, source: 'google_ads', external_source: 'google_lead_form' } }],
    raw: true, transaction });
  const identities = new Map(); const receipts = new Map();
  const valid = audit => {
    const identity = googleNativeAdvertisingIdentity(audit.identity, audit['leadIntake.clinica_id']);
    return identity && identity.account_id === audit['leadIntake.google_ads_customer_id']
      && identity.campaign_id === audit['leadIntake.google_ads_campaign_id']
      && audit['leadIntake.source_detail'] === `leadgen_form:${identity.form_id}` ? identity : null;
  };
  for (const audit of audits) {
    const key = String(audit.lead_intake_id);
    if (!identities.has(key)) identities.set(key, new Set());
    identities.get(key).add(JSON.stringify(valid(audit)));
  }
  for (const audit of audits) {
    const identity = valid(audit); const received = +new Date(audit.received_at);
    if (!audit.lead_intake_id || !identity || identities.get(String(audit.lead_intake_id)).size !== 1
      || !Number.isFinite(received) || received < +since || received > +now) continue;
    const key = [audit['leadIntake.clinica_id'], identity.account_id, identity.campaign_id, identity.form_id].join(':');
    receipts.set(key, Math.max(receipts.get(key) || 0, received));
  }
  const contexts = new Map(); const evidence = new Map();
  for (const campaign of eligible) {
    const clinic = selectedClinics.find(row => Number(row.id_clinica) === campaign.clinicId);
    const setting = scope?.groupId ? settings.find(row => row.scope_type === 'group' && Number(row.scope_id) === scope.groupId)
      : settings.find(row => row.scope_type === 'clinic' && Number(row.scope_id) === campaign.clinicId)
        || settings.find(row => row.scope_type === 'group' && Number(row.scope_id) === Number(clinic?.grupoClinicaId));
    let context = null;
    try {
      if (setting) {
        const key = `${setting.id}:${campaign.account_id}`;
        if (!contexts.has(key)) contexts.set(key, await accountContext({ models, settingId: setting.id, accountId: campaign.account_id, now, transaction }));
        context = contexts.get(key);
        const recipient = await resolveClinic({ models, context, identity: campaign, transaction });
        if (Number(recipient.id_clinica) !== campaign.clinicId) context = null;
      }
    } catch (error) { if (!/^google_lead_/.test(error.code || '')) throw error; context = null; }
    const matches = caches.filter(row => row.customer_id === campaign.account_id && row.campaign_id === campaign.campaign_id);
    const detection = matches.length === 1 ? googleDestinationDetection(matches[0].destination_detection) : null;
    const age = +now - +new Date(detection?.checked_at);
    const fresh = !!context && detection?.status === 'checked' && detection.complete === true
      && detection.access_fingerprint === context.fingerprint && Number.isFinite(age) && age >= 0 && age < TTL_MS;
    const forms = campaign.nativeForms.map(form => {
      const received = receipts.get([campaign.clinicId, campaign.account_id, campaign.campaign_id, form.id].join(':'));
      return { id: form.id, name: form.name, receivedAt: received ? new Date(received).toISOString() : null,
        state: !context || !form.metadataAccessible ? 'access_required' : !fresh ? 'check_required'
          : !enabled(env) ? 'service_pending' : received ? 'receiving' : 'prepared' };
    });
    const configured = fresh && enabled(env) && forms.every(form => ['prepared', 'receiving'].includes(form.state));
    const ready = configured && forms.every(form => form.state === 'receiving');
    evidence.set(campaign.id, { forms, reception: { checked: true, ready, configured,
      state: ready ? 'verified' : configured ? 'pending_confirmation' : context && !fresh ? 'unverified' : 'action_required',
      checkedAt: ready ? forms.map(form => form.receivedAt).sort()[0] : null,
      detail: !context ? 'Revisa el acceso y la clínica que debe recibir los formularios de esta cuenta.'
        : !fresh ? 'Actualiza la comprobación de los destinos de esta campaña en Google.'
        : forms.some(form => form.state === 'access_required') ? 'Falta comprobar el acceso a todos los formularios.'
        : !enabled(env) ? 'La recepción automática de formularios de Google está pendiente de habilitación del servicio.'
        : ready ? 'Se han recibido interesados de todos los formularios de Google durante los últimos siete días.'
        : 'La conexión está preparada. La recepción se confirmará cuando llegue un interesado de cada formulario.',
    } });
  }
  return evidence;
}

module.exports = { googleNativeForms, loadGoogleNativeEvidence };
