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
  load, hasAccess, buildBody, resolveLeadConversation, transaction = null }) {
  template = plain(template);
  const catalogId = Number(template?.catalog_template_id);
  let catalog;
  const readCatalog = async (fresh = false) => {
    if (fresh || catalog === undefined) catalog = Number.isSafeInteger(catalogId) && catalogId > 0
      ? plain(await models.WhatsappTemplateCatalog.findByPk(catalogId, {
        attributes: ['id', 'name', 'family_key', 'category', 'is_active'],
        ...(transaction ? { transaction, ...(transaction.LOCK?.SHARE ? { lock: transaction.LOCK.SHARE } : {}) } : {}) })) : null;
    return catalog;
  };
  if (input === undefined && !isAdSharingTemplate(template)) {
    // Runtime template names may have been customized. The common catalog
    // family remains authoritative even when the caller omits the selection.
    const linked = await readCatalog();
    if (!Object.values(FAMILIES).some(formats => Object.values(formats).includes(linked?.family_key))) return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['purpose', 'ad_id', 'lead_id', 'creative_sha256', 'variant_id'].includes(key))
    || !PURPOSES.includes(input.purpose) || !positiveId(input.ad_id)
    || input.creative_sha256 !== undefined && (typeof input.creative_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.creative_sha256))
    || input.variant_id !== undefined && (typeof input.variant_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.variant_id)
      || input.creative_sha256 === undefined)) fail('ad_sharing_selection_required', 400);
  if (conversation.channel !== 'whatsapp') fail('ad_sharing_whatsapp_required', 400);
  const clinicId = Number(conversation.clinic_id);
  const access = hasAccess || require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
  if (!await access({ userId: Number(userId), clinicIds: [clinicId], access: 'read' })) fail('ad_sharing_scope_forbidden', 403);
  let requestedLeadId = null;
  if (input.purpose === 'lead_ad') {
    requestedLeadId = input.lead_id === undefined ? Number(conversation.lead_id) : input.lead_id;
    if (!Number.isSafeInteger(requestedLeadId) || requestedLeadId <= 0) fail('ad_sharing_lead_required', 400);
    if (requestedLeadId !== Number(conversation.lead_id)) {
      // The canonical chat may retain a patient's earlier lead. Only the
      // native patient-context and exact-contact resolver can prove that a new
      // enquiry belongs to this same existing chat. Never repoint its link.
      const lead = plain(await models.LeadIntake?.findOne({ where: { id: requestedLeadId, clinica_id: clinicId, archived_at: null },
        attributes: ['id', 'clinica_id', 'grupo_clinica_id', 'created_at', 'telefono', 'email', 'nombre'],
        raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.SHARE } : {}) }));
      if (!lead || Number(lead.id) !== requestedLeadId || Number(lead.clinica_id) !== clinicId
        || typeof resolveLeadConversation !== 'function') fail('ad_sharing_lead_mismatch');
      const canonical = await resolveLeadConversation({ lead, conversation, transaction });
      if (!canonical || Number(canonical.id) !== Number(conversation.id)
        || Number(canonical.clinic_id) !== clinicId || canonical.channel !== 'whatsapp') fail('ad_sharing_lead_mismatch');
    }
  } else if (!Number.isSafeInteger(Number(conversation.patient_id)) || Number(conversation.patient_id) <= 0 || input.lead_id !== undefined) fail('ad_sharing_patient_required', 400);
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
        ...(input.purpose === 'lead_ad' ? { lead_id: String(requestedLeadId) } : {}) }, selectedAdId: input.ad_id,
      selectedVariantId: input.variant_id ?? null });
  } catch (error) {
    if (String(error.code || '').startsWith('ad_sharing_')) throw error;
    fail(error.status === 403 ? 'ad_sharing_source_forbidden' : 'ad_sharing_source_unavailable', error.status === 403 ? 403 : 409);
  }
  const selected = selection.items?.find(item => item.reference?.ad_id === input.ad_id);
  if (!selected?.creative?.available || !selected.selection?.allowed) fail('ad_sharing_media_unavailable');
  const creative = selected.creative;
  if ((creative.variant_id ?? null) !== (input.variant_id ?? null)) fail('ad_sharing_variant_changed');
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
  if (input.variant_id !== undefined) {
    const currentCatalog = await readCatalog(true);
    if (!currentCatalog?.is_active || currentCatalog.category !== 'MARKETING'
      || currentCatalog.family_key !== FAMILIES[input.purpose][format]) fail('ad_sharing_template_mismatch');
  }
  if (!await access({ userId: Number(userId), clinicIds: [clinicId], access: 'read' })) fail('ad_sharing_scope_forbidden', 403);
  const link = creative.mediaParameter?.[format.toLowerCase()]?.link;
  if (!require('./adSharing.service').mediaUrl(link, new Date())) fail('ad_sharing_media_unavailable');
  return {
    templateParams: params,
    templateComponents: [{ type: 'header', parameters: [creative.mediaParameter] }, ...body],
    message: bodyText.replace(/{{\s*([123])\s*}}/g, (_token, key) => params[key]),
    metadata: { purpose: input.purpose, ...(requestedLeadId ? { lead_id: requestedLeadId } : {}), reference: selected.reference, creative_sha256: creative.fingerprint,
      source: creative.source, media_kind: creative.kind,
      ...(creative.variant_id ? { variant_id: creative.variant_id, snapshot_sha256: creative.snapshot_sha256,
        copy_id: creative.copy_id, provenance: creative.provenance } : {}) },
  };
}

async function resolveExistingPatientLeadConversation({ lead, conversation, transaction = null,
  getPatientContext, resolvePhone, findCanonical }) {
  const context = await getPatientContext(lead, { transaction });
  if (context?.relationship !== 'existing_patient' || context.same_clinic !== true
    || Number(context.clinic_id) !== Number(conversation.clinic_id)
    || !Number.isSafeInteger(Number(context.patient_id)) || Number(context.patient_id) <= 0
    || Number(context.patient_id) !== Number(conversation.patient_id)) return null;
  // lead is a raw row: the phone helper can read historical form fields but
  // cannot persist a fallback as a side effect of this validation.
  const phone = await resolvePhone(lead, { transaction });
  if (!phone) return null;
  return findCanonical({ clinicId: Number(conversation.clinic_id), contactId: phone,
    patientId: Number(context.patient_id), leadId: null, preserveExistingLead: true,
    createIfMissing: false, requireExactContact: true, readOnly: true, transaction });
}

module.exports = { isAdSharingTemplate, resolveAdSharingMessage, resolveExistingPatientLeadConversation };
