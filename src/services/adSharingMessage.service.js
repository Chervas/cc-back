'use strict';

const { FAMILIES, PURPOSES } = require('../lib/ad-sharing-templates');
const { extractWhatsappTemplatePlaceholderIndexes } = require('../lib/whatsapp-template-contract');
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const plain = value => value?.get ? value.get({ plain: true }) : value;
const positiveId = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);

function isAdSharingTemplate(template) {
  return Object.values(FAMILIES).flatMap(value => Object.values(value)).some(family =>
    template?.name === family || String(template?.name || '').startsWith(family + '_')
    || template?.catalog?.family_key === family);
}

// Only resolves the new catalog families. Existing template selection, sender,
// marketing restrictions, limits, queue, retry and WhatsApp transport stay in
// the native conversation command; no dispatch occurs in this module.
async function resolveAdSharingMessage({ models, conversation, template, input, templateParams, userId,
  load, hasAccess, buildBody }) {
  template = plain(template);
  const catalogId = Number(template?.catalog_template_id);
  let catalog;
  const readCatalog = async () => {
    if (catalog === undefined) catalog = Number.isSafeInteger(catalogId) && catalogId > 0
      ? plain(await models.WhatsappTemplateCatalog.findByPk(catalogId, {
        attributes: ['id', 'name', 'family_key', 'category', 'is_active'] })) : null;
    return catalog;
  };
  if (input === undefined && !isAdSharingTemplate(template)) {
    // Runtime template names may have been customized. The common catalog
    // family remains authoritative even when the caller omits the selection.
    const linked = await readCatalog();
    if (!Object.values(FAMILIES).some(formats => Object.values(formats).includes(linked?.family_key))) return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['purpose', 'ad_id', 'lead_id', 'creative_sha256'].includes(key))
    || !PURPOSES.includes(input.purpose) || !positiveId(input.ad_id)
    || input.creative_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.creative_sha256)) fail('ad_sharing_selection_required', 400);
  if (conversation.channel !== 'whatsapp') fail('ad_sharing_whatsapp_required', 400);
  if (input.purpose === 'lead_ad') {
    if (!Number.isSafeInteger(Number(conversation.lead_id)) || Number(conversation.lead_id) <= 0) fail('ad_sharing_lead_required', 400);
    if (input.lead_id !== undefined && (!Number.isSafeInteger(input.lead_id) || input.lead_id !== Number(conversation.lead_id))) fail('ad_sharing_lead_mismatch');
  } else if (!Number.isSafeInteger(Number(conversation.patient_id)) || Number(conversation.patient_id) <= 0 || input.lead_id !== undefined) fail('ad_sharing_patient_required', 400);
  const clinicId = Number(conversation.clinic_id);
  const access = hasAccess || require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
  if (!await access({ userId: Number(userId), clinicIds: [clinicId], access: 'read' })) fail('ad_sharing_scope_forbidden', 403);
  catalog = await readCatalog();
  const format = catalog && Object.entries(FAMILIES[input.purpose]).find(([, family]) => family === catalog.family_key)?.[0];
  if (!format || catalog.category !== 'MARKETING' || !catalog.is_active
    || template.category !== 'MARKETING' || template.status !== 'APPROVED' || !template.is_active) fail('ad_sharing_template_mismatch');
  let components = template.components;
  if (typeof components === 'string') { try { components = JSON.parse(components); } catch { components = []; } }
  const headers = Array.isArray(components) ? components.filter(c => String(c?.type).toUpperCase() === 'HEADER') : [];
  if (headers.length !== 1 || String(headers[0].format).toUpperCase() !== format
    || JSON.stringify(extractWhatsappTemplatePlaceholderIndexes(components)) !== '[1,2,3]') fail('ad_sharing_template_header_mismatch');
  let selection;
  try {
    selection = await (load || require('./adSharing.service').loadAdSharing)({ models,
      scope: { clinicIds: [clinicId], groupId: null }, input: { purpose: input.purpose,
        ...(input.purpose === 'lead_ad' ? { lead_id: String(conversation.lead_id) } : {}) }, selectedAdId: input.ad_id });
  } catch (error) {
    if (String(error.code || '').startsWith('ad_sharing_')) throw error;
    fail(error.status === 403 ? 'ad_sharing_source_forbidden' : 'ad_sharing_source_unavailable', error.status === 403 ? 403 : 409);
  }
  const selected = selection.items?.find(item => item.reference?.ad_id === input.ad_id);
  if (!selected?.creative?.available || !selected.selection?.allowed) fail('ad_sharing_media_unavailable');
  const creative = selected.creative;
  if (selected.templateFamily !== FAMILIES[input.purpose][format] || creative.kind !== format
    || creative.mediaParameter?.type !== format.toLowerCase()) fail('ad_sharing_template_header_mismatch');
  if (input.creative_sha256 !== undefined && input.creative_sha256 !== creative.fingerprint) fail('ad_sharing_creative_changed');
  const incoming = Array.isArray(templateParams) ? Object.fromEntries(templateParams.map((v, i) => [String(i + 1), v])) : templateParams;
  if (!incoming || typeof incoming !== 'object' || ['1', '2'].some(key => typeof incoming[key] !== 'string' || !incoming[key].trim() || incoming[key].length > 255)
    || Object.keys(incoming).some(key => !['1', '2', '3'].includes(key)) || typeof creative.shareText !== 'string' || !creative.shareText.trim()) fail('ad_sharing_template_parameters_invalid', 400);
  const params = { '1': incoming['1'], '2': incoming['2'], '3': creative.shareText };
  const body = buildBody(params);
  const bodyText = components.find(c => String(c.type).toUpperCase() === 'BODY')?.text;
  if (typeof bodyText !== 'string' || !Array.isArray(body) || body.length !== 1 || body[0].type !== 'body') fail('ad_sharing_template_parameters_invalid', 400);
  if (!await access({ userId: Number(userId), clinicIds: [clinicId], access: 'read' })) fail('ad_sharing_scope_forbidden', 403);
  return {
    templateParams: params,
    templateComponents: [{ type: 'header', parameters: [creative.mediaParameter] }, ...body],
    message: bodyText.replace(/{{\s*([123])\s*}}/g, (_token, key) => params[key]),
    metadata: { purpose: input.purpose, reference: selected.reference, creative_sha256: creative.fingerprint,
      source: creative.source, media_kind: creative.kind },
  };
}

module.exports = { isAdSharingTemplate, resolveAdSharingMessage };
