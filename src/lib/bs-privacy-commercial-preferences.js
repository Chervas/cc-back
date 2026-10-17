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

function signedChoiceCandidate(document, now) {
  const doc = plain(document), snapshot = record(doc?.snapshot_json);
  const generic = require('./registration-privacy-template').schema(record(snapshot.version).body_json);
  if ((!generic && !eligibility.CLINICS.includes(Number(doc?.clinica_id))) || doc.purpose !== 'data_protection'
    || doc.status !== 'signed' || doc.revoked_at || !doc.signed_at || !Number.isFinite(new Date(doc.signed_at).getTime()) || new Date(doc.signed_at) > now
    || !Number.isFinite(new Date(snapshot.signature_evidence?.signed_at).getTime()) || new Date(snapshot.signature_evidence.signed_at) > now
    || doc.expires_at && new Date(doc.expires_at) <= now
    || !generic && snapshot.template?.catalog_key !== eligibility.FINAL_PRIVACY_KEY
    || Number(snapshot.template?.id) !== Number(doc.clinic_template_id)
    || Number(snapshot.template?.clinic_id) !== Number(doc.clinica_id)
    || Number(snapshot.version?.id) !== Number(doc.clinic_template_version_id)
    || Number(snapshot.context?.paciente?.id) !== Number(doc.paciente_id)
    || Number(snapshot.context?.clinica?.id) !== Number(doc.clinica_id)) return null;
  const answers = choices.signedConsentChoiceAnswers(doc);
  return answers ? { doc, snapshot, answers, generic } : null;
}

function verifiedSignedChoices(document, { now = new Date(), sourceVersion = null, sourceTemplate = null } = {}) {
  const candidate = signedChoiceCandidate(document, now);
  if (!candidate) return null;
  const { doc, snapshot, answers, generic } = candidate;
  const bodyJson = record(snapshot.version).body_json;
  let legalHtml;
  if (generic) {
    const source = plain(sourceVersion), template = plain(sourceTemplate);
    if (!source || !template || Number(source.id) !== Number(doc.clinic_template_version_id)
      || Number(source.clinic_template_id) !== Number(doc.clinic_template_id) || source.locale !== 'es'
      || !['published', 'archived'].includes(source.status) || Number(template.id) !== Number(doc.clinic_template_id)
      || Number(template.clinic_id) !== Number(doc.clinica_id) || template.purpose !== 'data_protection'
      || snapshot.version.body_html !== source.body_html
      || JSON.stringify(canonical(record(source.body_json))) !== JSON.stringify(canonical(record(bodyJson)))) return null;
    legalHtml = require('./registration-privacy-template').render(source, snapshot.context);
  } else if (digital.isApprovedPrivacyPresentation({ bodyHtml: digital.buildBsPrivacyDigitalHtml().html, bodyJson })) {
    legalHtml = digital.buildBsPrivacyDigitalHtml(snapshot.context).html;
  } else {
    // Historical paper-style documents did not embed their source HTML. A
    // caller's copied body_json marker cannot prove them: fetch their bounded
    // immutable source version and require the exact server-pinned legacy body.
    const source = plain(sourceVersion);
    if (!source || Number(source.id) !== Number(doc.clinic_template_version_id)
      || Number(source.clinic_template_id) !== Number(doc.clinic_template_id)
      || !['published', 'archived'].includes(source.status) || source.locale !== 'es'
      || createHash('sha256').update(String(source.body_html || '')).digest('hex') !== digital.APPROVED_LEGACY_HTML_SHA256) return null;
    try {
      if (!choices.getConsentChoiceForm({ snapshot_json: { version: {
        body_json: source.body_json, variable_schema: source.variable_schema,
      } } })) return null;
    } catch { return null; }
    legalHtml = String(source.body_html).trim();
  }
  const evidence = { schema_version: choices.getConsentChoiceForm(doc).schema_version, answers };
  // Ordered folios render the verified authorizations in their decisions block.
  // Only use the immutable source already checked above, never caller-supplied
  // block definitions or free-form answers as a substitute for consent choices.
  const ordered = generic ? require('./consent-document-blocks').renderVersion(plain(sourceVersion), snapshot.context,
    { answers: record(snapshot.document_block_answers).answers || {}, choiceEvidence: evidence }) : null;
  const expected = ordered ?? choices.appendSignedChoiceHtml(legalHtml, doc, evidence);
  return expected === doc.snapshot_html ? answers : null;
}
function isVerifiedCommercialRefusal(document, now = new Date(), sourceVersion = null, sourceTemplate = null) {
  return verifiedSignedChoices(document, { now, sourceVersion, sourceTemplate })?.commercial === 'no';
}

async function verifiedRefusals({ db, clinicIds = [], patientIds = null, phone = null, phones = null, email = null, transaction = null, now = new Date(), choiceKey = 'commercial' }) {
  const result = { patientIds: new Set(), phoneDigits: new Set(), documentIds: [] };
  const requested = [...new Set(clinicIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!requested.length) return result;
  const scopes = choiceKey === 'commercial' && requested.some(id => eligibility.CLINICS.includes(id))
    ? [...new Set([...requested, ...eligibility.CLINICS])] : requested;
  // Test doubles/older tenants without this optional domain do not acquire a
  // new table dependency. Real deployed BS schemas have PatientConsentDocument.
  if (!db.PatientConsentDocument) return result;
  const { Op } = db.Sequelize, ids = patientIds && [...new Set(patientIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (phones !== null && (!Array.isArray(phones) || phones.length > 200)) throw Object.assign(new Error('privacy_channel_phone_batch_invalid'), { code: 'privacy_channel_phone_batch_invalid', statusCode: 400 });
  const targetPhones = [...new Set([...(phones || []), ...(phone ? [phone] : [])].map(normalizePhoneDigits).filter(Boolean))];
  const matchPhones = new Set(targetPhones);
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
  if (selected && !selected.length && !targetPhones.length && !normalizedEmail) return result;
  // A phone-only queued message may still carry the number frozen in an older
  // signed document after reception corrected the live contact. Scan the
  // bounded BS evidence set in that uncommon case, then match full identity.
  const matchSignedPhone = targetPhones.length > 0 && (choiceKey === 'sms_whatsapp' || !selected?.length);
  const matchSignedEmail = !!normalizedEmail && !selected?.length;
  const where = { clinica_id: { [Op.in]: scopes }, purpose: 'data_protection', status: 'signed', revoked_at: null,
    ...(selected?.length ? { paciente_id: { [Op.in]: selected } } : {}) };
  if (choiceKey === 'sms_whatsapp' && targetPhones.length) {
    // Match signed full-number evidence even if the live patient number has
    // since changed; bounded batches avoid N-per-card reads in QuickChat.
    const digits = [...new Set(targetPhones.flatMap(value => getPhoneIdentityCandidates(value)).map(value => value.replace(/\D/g, '')))];
    const frozenPhone = db.Sequelize.where(db.Sequelize.fn('REGEXP_REPLACE', db.Sequelize.fn('REGEXP_REPLACE',
      // Sequelize v6 doubles dollars in string fn arguments for bind escaping.
      // This path is a fixed server literal, never caller-provided SQL/input.
      db.Sequelize.fn('JSON_UNQUOTE', db.Sequelize.fn('JSON_EXTRACT', db.Sequelize.col('snapshot_json'),
        db.Sequelize.literal("'$.context.paciente.telefono'"))),
      '[^0-9]', ''), '^00', ''), { [Op.in]: digits });
    delete where.paciente_id;
    where[Op.or] = [...(selected?.length ? [{ paciente_id: { [Op.in]: selected } }] : []), frozenPhone];
  }
  const limit = selected?.length || targetPhones.length && choiceKey === 'sms_whatsapp'
    ? Math.max(101, Math.max(selected?.length || 0, targetPhones.length) * 101) : 10001;
  const rows = await db.PatientConsentDocument.findAll({ where, order: [['id', 'DESC']], transaction, limit });
  if (rows.length >= limit) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
  const documents = rows.map(plain).filter(row => scopes.includes(Number(row.clinica_id))), legacyCandidates = documents.filter(doc => {
    const candidate = signedChoiceCandidate(doc, now);
    return (candidate?.answers[choiceKey] === 'no' || choiceKey === 'sms_whatsapp' && candidate?.answers[choiceKey] === 'yes')
      && !digital.isApprovedPrivacyPresentation({ bodyHtml: digital.buildBsPrivacyDigitalHtml().html,
      bodyJson: record(candidate.snapshot.version).body_json });
  });
  const legacyVersions = new Map();
  const sourceTemplates = new Map();
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
    const genericIds = [...new Set(legacyCandidates.filter(doc => require('./registration-privacy-template')
      .schema(record(record(doc.snapshot_json).version).body_json)).map(doc => Number(doc.clinic_template_id)))];
    if (genericIds.length) {
      if (!db.ClinicConsentTemplate) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
      const templates = await db.ClinicConsentTemplate.findAll({ where: { id: { [Op.in]: genericIds }, clinic_id: { [Op.in]: scopes },
        purpose: 'data_protection' }, attributes: ['id', 'clinic_id', 'purpose'], transaction, limit: genericIds.length + 1 });
      if (templates.length > genericIds.length) throw Object.assign(new Error('privacy_commercial_review_required'), { code: 'privacy_commercial_review_required', statusCode: 409 });
      for (const raw of templates) { const source = plain(raw); sourceTemplates.set(Number(source.id), source); }
    }
  }
  const verified = documents.map(doc => ({ doc, answer: verifiedSignedChoices(doc, { now, sourceVersion: legacyVersions.get(Number(doc.clinic_template_version_id)), sourceTemplate: sourceTemplates.get(Number(doc.clinic_template_id)) })?.[choiceKey] }))
    .filter(({ doc, answer }) => ['yes', 'no'].includes(answer)
    && (!matchSignedPhone || matchPhones.has(normalizePhoneDigits(record(doc.snapshot_json).context?.paciente?.telefono)))
    && (!matchSignedEmail || String(record(doc.snapshot_json).context?.paciente?.email || '').trim().toLowerCase() === normalizedEmail));
  const latest = new Map();
  if (choiceKey === 'sms_whatsapp') for (const item of verified.sort((a, b) =>
    new Date(b.doc.signed_at).getTime() - new Date(a.doc.signed_at).getTime() || Number(b.doc.id) - Number(a.doc.id))) {
    const doc = item.doc, identity = `${doc.clinica_id}:${doc.paciente_id}:${normalizePhoneDigits(record(doc.snapshot_json).context?.paciente?.telefono)}`;
    if (!latest.has(identity)) latest.set(identity, item);
  }
  const valid = (choiceKey === 'sms_whatsapp' ? [...latest.values()] : verified).filter(item => item.answer === 'no').map(item => item.doc);
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
const commercialRefusals = options => verifiedRefusals({ ...options, choiceKey: 'commercial' });
const channelRefusals = options => verifiedRefusals({ ...options, choiceKey: 'sms_whatsapp' });

async function assertCommercialAllowed(options) {
  const result = await commercialRefusals(options);
  if (result.patientIds.size || result.phoneDigits.size) throw Object.assign(new Error('privacy_commercial_communications_restricted'), {
    code: 'AUTOMATION_COMMUNICATIONS_RESTRICTED', status: 409, statusCode: 409, retryable: false,
    details: { scope: 'marketing', reason_code: 'lopd_commercial_refused' },
  });
}

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
module.exports = { verifiedSignedChoices, isVerifiedCommercialRefusal, commercialRefusals, channelRefusals, assertCommercialAllowed };
