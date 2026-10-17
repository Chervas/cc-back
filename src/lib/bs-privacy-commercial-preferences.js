'use strict';

// A verified "No" is a restriction, never an opt-in or a replacement for
// existing import/manual marketing HOLDs. Read signed evidence without changing
// it, including documents signed before this integration existed.
const eligibility = require('../services/appointmentPrivacyEligibility.service');
const choices = require('./consent-document-choices');
const digital = require('./bs-privacy-digital-template');
const { createHash } = require('node:crypto');
const { normalizePhoneDigits, getPhoneIdentityCandidates } = require('./phone');
const plain = value => value?.toJSON ? value.toJSON() : value;
const record = value => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};

function signedRefusalCandidate(document, now) {
  const doc = plain(document), snapshot = record(doc?.snapshot_json);
  if (!eligibility.CLINICS.includes(Number(doc?.clinica_id)) || doc.purpose !== 'data_protection'
    || doc.status !== 'signed' || doc.revoked_at || !doc.signed_at || !Number.isFinite(new Date(doc.signed_at).getTime()) || new Date(doc.signed_at) > now
    || !Number.isFinite(new Date(snapshot.signature_evidence?.signed_at).getTime()) || new Date(snapshot.signature_evidence.signed_at) > now
    || doc.expires_at && new Date(doc.expires_at) <= now
    || snapshot.template?.catalog_key !== eligibility.FINAL_PRIVACY_KEY
    || Number(snapshot.template?.id) !== Number(doc.clinic_template_id)
    || Number(snapshot.template?.clinic_id) !== Number(doc.clinica_id)
    || Number(snapshot.version?.id) !== Number(doc.clinic_template_version_id)
    || Number(snapshot.context?.paciente?.id) !== Number(doc.paciente_id)
    || Number(snapshot.context?.clinica?.id) !== Number(doc.clinica_id)) return null;
  const answers = choices.signedConsentChoiceAnswers(doc);
  return answers?.commercial === 'no' ? { doc, snapshot, answers } : null;
}

function isVerifiedCommercialRefusal(document, now = new Date(), legacySourceVersion = null) {
  const candidate = signedRefusalCandidate(document, now);
  if (!candidate) return false;
  const { doc, snapshot, answers } = candidate;
  const bodyJson = record(snapshot.version).body_json;
  let legalHtml;
  if (digital.isApprovedPrivacyPresentation({ bodyHtml: digital.buildBsPrivacyDigitalHtml().html, bodyJson })) {
    legalHtml = digital.buildBsPrivacyDigitalHtml(snapshot.context).html;
  } else {
    // Historical paper-style documents did not embed their source HTML. A
    // caller's copied body_json marker cannot prove them: fetch their bounded
    // immutable source version and require the exact server-pinned legacy body.
    const source = plain(legacySourceVersion);
    if (!source || Number(source.id) !== Number(doc.clinic_template_version_id)
      || Number(source.clinic_template_id) !== Number(doc.clinic_template_id)
      || !['published', 'archived'].includes(source.status) || source.locale !== 'es'
      || createHash('sha256').update(String(source.body_html || '')).digest('hex') !== digital.APPROVED_LEGACY_HTML_SHA256) return false;
    try {
      if (!choices.getConsentChoiceForm({ snapshot_json: { version: {
        body_json: source.body_json, variable_schema: source.variable_schema,
      } } })) return false;
    } catch { return false; }
    legalHtml = String(source.body_html).trim();
  }
  const expected = choices.appendSignedChoiceHtml(legalHtml, doc,
    { schema_version: choices.CHOICE_SCHEMA_VERSION, answers });
  return expected === doc.snapshot_html;
}

async function commercialRefusals({ db, clinicIds = [], patientIds = null, phone = null, email = null, transaction = null, now = new Date() }) {
  const result = { patientIds: new Set(), phoneDigits: new Set(), documentIds: [] };
  if (!clinicIds.some(id => eligibility.CLINICS.includes(Number(id)))) return result;
  // Test doubles/older tenants without this optional domain do not acquire a
  // new table dependency. Real deployed BS schemas have PatientConsentDocument.
  if (!db.PatientConsentDocument) return result;
  const { Op } = db.Sequelize, ids = patientIds && [...new Set(patientIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  const candidates = phone ? getPhoneIdentityCandidates(phone) : [];
  let selected = ids;
  if (phone && db.Paciente) {
    const patients = await db.Paciente.findAll({ where: { telefono_movil: { [Op.in]: candidates } },
      attributes: ['id_paciente'], transaction, limit: 101 });
    if (patients.length > 100) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
    selected = [...new Set([...(ids || []), ...patients.map(row => Number(plain(row).id_paciente))])];
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail && db.Paciente) {
    const patients = await db.Paciente.findAll({ where: db.Sequelize.where(db.Sequelize.fn('LOWER',
      db.Sequelize.fn('TRIM', db.Sequelize.col('email'))), normalizedEmail),
    attributes: ['id_paciente'], transaction, limit: 101 });
    if (patients.length > 100) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
    selected = [...new Set([...(selected || []), ...patients.map(row => Number(plain(row).id_paciente))])];
  }
  if (selected && !selected.length && !phone && !normalizedEmail) return result;
  // A phone-only queued message may still carry the number frozen in an older
  // signed document after reception corrected the live contact. Scan the
  // bounded BS evidence set in that uncommon case, then match full identity.
  const matchSignedPhone = !!phone && !selected?.length;
  const matchSignedEmail = !!normalizedEmail && !selected?.length;
  const where = { clinica_id: { [Op.in]: eligibility.CLINICS }, purpose: 'data_protection', status: 'signed', revoked_at: null,
    ...(selected?.length ? { paciente_id: { [Op.in]: selected } } : {}) };
  const limit = selected?.length ? Math.max(101, selected.length * 101) : 10001;
  const rows = await db.PatientConsentDocument.findAll({ where, order: [['id', 'DESC']], transaction, limit });
  if (rows.length >= limit) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
  const documents = rows.map(plain), legacyCandidates = documents.filter(doc => {
    const candidate = signedRefusalCandidate(doc, now);
    return candidate && !digital.isApprovedPrivacyPresentation({ bodyHtml: digital.buildBsPrivacyDigitalHtml().html,
      bodyJson: record(candidate.snapshot.version).body_json });
  });
  const legacyVersions = new Map();
  if (legacyCandidates.length) {
    if (!db.ClinicConsentTemplateVersion) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
    const ids = [...new Set(legacyCandidates.map(doc => Number(doc.clinic_template_version_id)))];
    const templateIds = [...new Set(legacyCandidates.map(doc => Number(doc.clinic_template_id)))];
    const versions = await db.ClinicConsentTemplateVersion.findAll({ where: { id: { [Op.in]: ids },
      clinic_template_id: { [Op.in]: templateIds }, locale: 'es', status: { [Op.in]: ['published', 'archived'] } },
    attributes: ['id', 'clinic_template_id', 'locale', 'status', 'body_html', 'body_json', 'variable_schema'],
    transaction, limit: ids.length + 1 });
    if (versions.length > ids.length) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
    for (const raw of versions) { const source = plain(raw); legacyVersions.set(Number(source.id), source); }
  }
  const valid = documents.filter(doc => isVerifiedCommercialRefusal(doc, now, legacyVersions.get(Number(doc.clinic_template_version_id)))
    && (!matchSignedPhone || normalizePhoneDigits(record(doc.snapshot_json).context?.paciente?.telefono) === normalizePhoneDigits(phone))
    && (!matchSignedEmail || String(record(doc.snapshot_json).context?.paciente?.email || '').trim().toLowerCase() === normalizedEmail));
  for (const doc of valid) {
    result.patientIds.add(Number(doc.paciente_id)); result.documentIds.push(Number(doc.id));
    const signedPhone = record(doc.snapshot_json).context?.paciente?.telefono;
    const digits = normalizePhoneDigits(signedPhone); if (digits) result.phoneDigits.add(digits);
  }
  // Phone matching must also protect a phone-only queued job whose patient_id
  // is missing; do not infer that another patient's new number is consented.
  if (phone && valid.length) {
    const digits = normalizePhoneDigits(phone); if (digits) result.phoneDigits.add(digits);
  }
  return result;
}

async function assertCommercialAllowed(options) {
  const result = await commercialRefusals(options);
  if (result.patientIds.size || result.phoneDigits.size) throw Object.assign(new Error('privacy_commercial_communications_restricted'), {
    code: 'AUTOMATION_COMMUNICATIONS_RESTRICTED', status: 409, statusCode: 409, retryable: false,
    details: { scope: 'marketing', reason_code: 'lopd_commercial_refused' },
  });
}

module.exports = { isVerifiedCommercialRefusal, commercialRefusals, assertCommercialAllowed };
