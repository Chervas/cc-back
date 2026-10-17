'use strict';

// A verified "No" is a restriction, never an opt-in or a replacement for
// existing import/manual marketing HOLDs. Read signed evidence without changing
// it, including documents signed before this integration existed.
const eligibility = require('../services/appointmentPrivacyEligibility.service');
const choices = require('./consent-document-choices');
const digital = require('./bs-privacy-digital-template');
const { normalizePhoneDigits, getPhoneIdentityCandidates } = require('./phone');
const plain = value => value?.toJSON ? value.toJSON() : value;
const record = value => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};

function isVerifiedCommercialRefusal(document, now = new Date()) {
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
    || Number(snapshot.context?.clinica?.id) !== Number(doc.clinica_id)) return false;
  const answers = choices.signedConsentChoiceAnswers(doc);
  if (answers?.commercial !== 'no') return false;
  const bodyJson = record(snapshot.version).body_json;
  if (!digital.isApprovedPrivacyPresentation({ bodyHtml: digital.buildBsPrivacyDigitalHtml().html, bodyJson })) return false;
  const expected = choices.appendSignedChoiceHtml(digital.buildBsPrivacyDigitalHtml(snapshot.context).html, doc,
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
  const limit = selected ? Math.max(101, selected.length * 101) : 10001;
  const rows = await db.PatientConsentDocument.findAll({ where, order: [['id', 'DESC']], transaction, limit });
  if (rows.length >= limit) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
  const valid = rows.map(plain).filter(doc => isVerifiedCommercialRefusal(doc, now)
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
