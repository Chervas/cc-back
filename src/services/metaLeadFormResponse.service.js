'use strict';

const { createHash } = require('node:crypto');
const { validateFormResponse } = require('../../services/integrations-broker/src/meta-marketing-lead-form-response');

const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const plain = value => value?.get ? value.get({ plain: true }) : value;
const fail = code => { throw Object.assign(Error(code), { code }); };
const json = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { fail('meta_lead_form_response_invalid'); }
};
const canonical = value => JSON.stringify(value, function (_key, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
});

function validatedResponse(value, formId) {
  try { return validateFormResponse(value, formId); }
  catch { fail('meta_lead_form_response_invalid'); }
}

function nativeFormSource(leadId) {
  if (!graphId(leadId)) fail('meta_lead_form_identity_mismatch');
  return 'meta_leadgen:' + leadId;
}

// Call only after resolving current Page/account authority, and while owning the
// parent LeadIntake row lock (or that row's INSERT) in this same transaction.
// Every native delivery and enrichment uses that parent lock as its mutex;
// an absent FormSubmissionEvent range is never used as a concurrency fence.
async function storeMetaLeadFormResponse({ models, event, lead: leadRow, clinic: clinicRow,
  formResponse, providerCreatedAt, transaction }) {
  const lead = plain(leadRow), clinic = plain(clinicRow);
  if (!transaction?.LOCK?.UPDATE || transaction.finished || !models.FormSubmissionEvent
    || !lead || !clinic || !Number.isSafeInteger(Number(lead.id)) || Number(lead.id) < 1
    || Number(lead.clinica_id) !== Number(clinic.id_clinica)
    || lead.external_source !== 'meta_leadgen' || lead.external_id !== event?.lead_id
    || !graphId(event?.page_id) || !graphId(event?.form_id)) fail('meta_lead_form_identity_mismatch');
  const response = validatedResponse(formResponse, event.form_id);
  const submittedAt = new Date(providerCreatedAt);
  if (!Number.isFinite(+submittedAt)) fail('meta_lead_form_response_invalid');
  const responseDigest = createHash('sha256').update(canonical(response)).digest('hex');
  const sourceDetail = nativeFormSource(event.lead_id);
  const fields = { provider: 'meta_leadgen', version: 2, fields: response.fields };
  const metadata = { provider: 'meta_leadgen', version: 2, lead_id: event.lead_id,
    page_id: event.page_id, form_id: event.form_id, response_digest: responseDigest };
  // The display column is VARCHAR(255); do not truncate any question or answer.
  const formName = Array.from(response.name).slice(0, 255).join('');
  const found = await models.FormSubmissionEvent.findAll({
    where: { lead_intake_id: Number(lead.id), source_detail: sourceDetail },
    order: [['id', 'ASC']], limit: 2, transaction, lock: transaction.LOCK.UPDATE,
    logging: false,
  });
  if (found.length > 1) fail('meta_lead_form_conflict');
  if (found.length) {
    const saved = plain(found[0]);
    if (Number(saved.clinic_id) !== Number(clinic.id_clinica)
      || (saved.group_id == null ? null : Number(saved.group_id)) !== (clinic.grupoClinicaId == null ? null : Number(clinic.grupoClinicaId))
      || saved.form_id !== event.form_id || saved.form_name !== formName || saved.page_url !== null
      || canonical(json(saved.fields_json)) !== canonical(fields)
      || canonical(json(saved.payload_json)) !== canonical(metadata)) fail('meta_lead_form_conflict');
    return { stored: false, eventId: Number(saved.id), fieldCount: response.fields.length };
  }
  const saved = await models.FormSubmissionEvent.create({
    clinic_id: Number(clinic.id_clinica), group_id: clinic.grupoClinicaId == null ? null : Number(clinic.grupoClinicaId),
    lead_intake_id: Number(lead.id), page_url: null, form_id: event.form_id,
    form_name: formName, form_selector: null, match_domain: null,
    source_detail: sourceDetail, email_normalized: null, phone_normalized: null,
    fields_json: fields, payload_json: metadata, submitted_at: submittedAt,
  }, { transaction, logging: false });
  return { stored: true, eventId: Number(saved.id), fieldCount: response.fields.length };
}

module.exports = { validatedResponse, nativeFormSource, storeMetaLeadFormResponse };
