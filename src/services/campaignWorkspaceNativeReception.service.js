'use strict';

const { Op, Sequelize } = require('sequelize');
const { metaAdvertisingIdentity } = require('./leadAdvertisingIdentity.service');
const { graphId } = require('./campaignWorkspaceMetaDestination.service');
const { pageProof } = require('./campaignWorkspaceMetaPage.service');

const RECEIPT_WINDOW = 7 * 86400000;
const DESTINATION_WINDOW = 86400000;
const scopeKey = row => row.assignmentScope === 'group' ? `group:${row.grupoClinicaId}` : `clinic:${row.clinicaId}`;
const covers = (row, clinic) => row.assignmentScope === 'clinic' ? Number(row.clinicaId) === Number(clinic.id_clinica)
  : row.assignmentScope === 'group' && Number(row.grupoClinicaId) === Number(clinic.grupoClinicaId);

function nativeForms(detection) {
  if (detection?.source !== 'workspace_meta_graph' || detection.version !== 1 || !Array.isArray(detection.forms)) return [];
  return detection.forms.filter(form => graphId(form.form_id)).map(form => ({
    id: form.form_id, pageId: graphId(form.page_id), name: typeof form.name === 'string' ? form.name.slice(0, 255) : null,
    status: form.status || null, metadataAccessible: form.metadata_accessible === true,
  }));
}

async function loadNativeFormEvidence({ models, campaigns, selectedClinics, scope = null, now = new Date(), transaction = null }) {
  const eligible = campaigns.filter(campaign => campaign.provider === 'meta_ads' && campaign.assigned && campaign.nativeForms?.length);
  if (!eligible.length) return new Map();
  const clinicIds = [...new Set(eligible.map(campaign => campaign.clinicId))];
  const pages = await models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: 'facebook_page',
    metaAssetId: { [Op.in]: [...new Set(eligible.flatMap(campaign => campaign.nativeForms.map(form => form.pageId).filter(Boolean)))] },
  }, attributes: ['id', 'metaAssetId', 'metaAssetName', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId',
    'pageAccessToken', 'additionalData'], raw: true, transaction });
  const accounts = await models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: 'ad_account',
    metaAssetId: { [Op.in]: [...new Set(eligible.flatMap(campaign => [campaign.account_id, `act_${campaign.account_id}`]))] } },
  attributes: ['metaAssetId', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId'], raw: true, transaction });
  const assets = [...pages, ...accounts];
  const assignments = assets.length ? await models.MetaConnectionAssignment.findAll({ where: { status: 'active',
    scopeKey: { [Op.in]: [...new Set(assets.map(scopeKey))] } },
  attributes: ['scopeKey', 'metaConnectionId'], raw: true, transaction }) : [];
  const connections = assets.length ? await models.MetaConnection.findAll({ where: { id: { [Op.in]: [...new Set(assets.map(row => row.metaConnectionId))] } },
    attributes: ['id', 'expiresAt'], raw: true, transaction }) : [];
  const authorized = page => assignments.some(row => row.scopeKey === scopeKey(page)
    && Number(row.metaConnectionId) === Number(page.metaConnectionId)) && connections.some(row => Number(row.id) === Number(page.metaConnectionId)
      && (!row.expiresAt || +new Date(row.expiresAt) > +now));
  const activePages = pages.filter(authorized);
  const activeAccounts = accounts.filter(authorized);
  const since = new Date(+now - RECEIPT_WINDOW);
  // The required CRM join enforces clinic ownership. Never retrieve contact fields or custom form answers.
  const audits = await models.LeadAttributionAudit.findAll({ where: { created_at: { [Op.between]: [since, now] } },
    attributes: ['lead_intake_id', [Sequelize.json('attribution_steps.advertising_identity'), 'identity'],
      [Sequelize.json('attribution_steps.meta_native_received_at'), 'received_at']],
    include: [{ model: models.LeadIntake, as: 'leadIntake', required: true, attributes: ['clinica_id'],
      where: { clinica_id: { [Op.in]: clinicIds }, external_source: 'meta_leadgen' } }], raw: true, transaction });
  const receipts = new Map();
  const identitiesByLead = new Map();
  for (const audit of audits) {
    const identity = metaAdvertisingIdentity(audit.identity, Number(audit['leadIntake.clinica_id']));
    if (!identity || !audit.lead_intake_id) continue;
    const key = String(audit.lead_intake_id);
    if (!identitiesByLead.has(key)) identitiesByLead.set(key, new Set());
    identitiesByLead.get(key).add(JSON.stringify(identity));
  }
  for (const audit of audits) {
    if (identitiesByLead.get(String(audit.lead_intake_id))?.size !== 1) continue;
    const clinicId = Number(audit['leadIntake.clinica_id']);
    let value = audit.identity;
    try { if (typeof value === 'string') value = JSON.parse(value); } catch { continue; }
    const identity = metaAdvertisingIdentity(value, clinicId);
    const received = +new Date(audit.received_at);
    if (!identity || !Number.isFinite(received) || received > +now || received < +since) continue;
    const key = [clinicId, identity.account_id, identity.campaign_id, identity.page_id, identity.form_id].join(':');
    receipts.set(key, Math.max(receipts.get(key) || 0, received));
  }
  return new Map(eligible.map(campaign => {
    const clinic = selectedClinics.find(row => Number(row.id_clinica) === campaign.clinicId);
    const forms = campaign.nativeForms.map(form => {
      const matches = clinic ? activePages.filter(row => row.metaAssetId === form.pageId && covers(row, clinic)) : [];
      const ownerKey = scope?.groupId ? `group:${scope.groupId}` : `clinic:${campaign.clinicId}`;
      const preferred = matches.filter(row => scopeKey(row) === ownerKey);
      const candidates = preferred.length ? preferred : matches;
      const page = candidates.length === 1 ? candidates[0] : null;
      const proof = page && pageProof(page, now);
      const received = receipts.get([campaign.clinicId, campaign.account_id, campaign.campaign_id, form.pageId, form.id].join(':'));
      return { ...form, pageName: page?.metaAssetName || null, connected: !!page, receivedAt: received ? new Date(received).toISOString() : null,
        pageScope: page ? scopeKey(page) : null, canCheckPage: !!page?.pageAccessToken, subscription: proof,
        state: !form.metadataAccessible || proof?.state === 'access_required' ? 'access_required'
          : !form.pageId ? 'page_unknown' : !page ? 'page_required' : proof?.state === 'subscription_required' ? 'subscription_required'
          : received ? 'receiving' : proof?.state === 'verified' ? 'prepared' : 'waiting' };
    });
    const age = +now - +new Date(campaign.destinationCheckedAt);
    const fresh = campaign.destinationComplete === true && Number.isFinite(age) && age >= 0 && age < DESTINATION_WINDOW;
    const accountReady = clinic && activeAccounts.some(row => [campaign.account_id, `act_${campaign.account_id}`].includes(row.metaAssetId) && covers(row, clinic));
    const ready = !!accountReady && fresh && forms.length > 0 && forms.every(form => form.state === 'receiving');
    return [campaign.id, { forms, reception: { checked: true, ready,
      checkedAt: ready ? forms.map(form => form.receivedAt).sort()[0] : null,
      detail: !accountReady ? 'Falta revisar el acceso a la cuenta publicitaria de esta campaña.'
        : !fresh ? 'Falta actualizar la comprobación de los destinos de esta campaña.'
        : forms.some(form => form.state === 'access_required') ? 'Meta no ha permitido comprobar todos los formularios. Revisa los permisos de la conexión.'
        : forms.some(form => !form.connected) ? 'Hay formularios cuya página no está conectada para recibir interesados.'
        : forms.some(form => form.state === 'subscription_required') ? 'Falta habilitar el envío de formularios de esta página a ClinicaClick.'
        : forms.every(form => ['prepared', 'receiving'].includes(form.state)) && !ready ? 'La conexión está preparada. La recepción se confirmará cuando llegue un interesado de cada formulario.'
        : !ready ? 'Falta confirmar una recepción reciente de cada formulario en Interesados (leads).'
        : 'Se han recibido interesados de todos los formularios anunciados durante los últimos siete días.',
    } }];
  }));
}

module.exports = { nativeForms, loadNativeFormEvidence };
