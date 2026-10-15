'use strict';

// An explicit reception attestation is not a patient signature. It has its own
// reserved source and append-only server receipt; generic external-document
// checkboxes, imported history and optional permissions cannot authorize it.
const { randomUUID, createHash } = require('node:crypto');
const digital = require('./bs-privacy-digital-template');
const PAPER_SOURCE = 'registration_privacy_paper/v1';
const PAPER_EVENT = 'registration_privacy.paper_recorded';
const FINAL_PRIVACY_KEY = `bs-final-20261015-${digital.SOURCE_DOCUMENT_SHA256}`;
const PAPER_TITLE = 'Protección de datos firmada en papel';
const PAPER_NOTE = 'Recepción declara que el consentimiento de protección de datos firmado por el paciente ya está disponible y custodiado en papel. No registra una firma digital ni preferencias opcionales.';
const plain = row => row?.toJSON ? row.toJSON() : row;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return record(value) ? value : {};
};
const failure = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const invalidConfiguration = () => failure('appointment_consent_privacy_configuration', 'Revisa la configuración de protección de datos de esta clínica.');
const dateValue = value => value ? new Date(value).getTime() : NaN;

function isApprovedPaperFamilyVersion(version) {
  if (!version || version.status !== 'published' || version.locale !== 'es') return false;
  const html = String(version.body_html || '');
  if (!digital.isApprovedPrivacyPresentation({ bodyHtml: html, bodyJson: version.body_json })
    && createHash('sha256').update(html).digest('hex') !== digital.APPROVED_LEGACY_HTML_SHA256) return false;
  try {
    return !!require('./consent-document-choices').getConsentChoiceForm({ snapshot_json: { version: {
      body_json: version.body_json, variable_schema: version.variable_schema,
    } } });
  } catch { return false; }
}

function receiptMetadata({ attestationId, appointmentId, template, version, recordedAt }) {
  return { schema_version: PAPER_SOURCE, attestation_id: Number(attestationId), appointment_id: Number(appointmentId),
    clinic_template_id: Number(template.id), clinic_template_version_id: Number(version.id), catalog_key: FINAL_PRIVACY_KEY,
    source_document_sha256: digital.SOURCE_DOCUMENT_SHA256, legal_text_sha256: digital.LEGAL_TEXT_SHA256,
    acknowledged: true, recorded_at: recordedAt };
}

function matchesPaperEvidence({ attestation, event, patientId, clinicId, template, approvedVersions, now }) {
  const row = plain(attestation), audit = plain(event), metadata = object(audit?.metadata);
  const approved = approvedVersions.get(Number(metadata.clinic_template_version_id));
  if (!approved || !isApprovedPaperFamilyVersion(approved.version)
    || Number(approved.version.clinic_template_id) !== Number(template.id)
    || template.catalog_key !== FINAL_PRIVACY_KEY || Number(template.clinic_id) !== Number(clinicId)
    || template.purpose !== 'data_protection' || template.status !== 'active' || template.is_default !== true
    || template.blocking_policy !== 'hard' || !positive(row?.id) || !positive(metadata.appointment_id)
    || Number(row.paciente_id) !== Number(patientId) || Number(row.clinica_id) !== Number(clinicId)
    || row.tratamiento_id != null || row.purpose !== 'data_protection' || row.source !== PAPER_SOURCE
    || row.status !== 'active' || row.revoked_at || row.revoked_by || !positive(row.attested_by)
    || !positive(audit?.id) || Number(audit.patient_id) !== Number(patientId) || Number(audit.clinic_id) !== Number(clinicId)
    || audit.source !== PAPER_SOURCE || audit.event_type !== PAPER_EVENT || audit.channel !== 'internal'
    || Number(audit.actor_user_id) !== Number(row.attested_by)) return false;
  const attested = dateValue(row.attested_at), occurred = dateValue(audit.occurred_at), recorded = dateValue(metadata.recorded_at);
  if (![attested, occurred, recorded].every(value => Number.isFinite(value) && value <= now.getTime())
    || Math.abs(attested - recorded) >= 1000 || Math.abs(occurred - recorded) >= 1000) return false;
  const expected = receiptMetadata({ attestationId: row.id, appointmentId: metadata.appointment_id,
    template, version: approved.version, recordedAt: metadata.recorded_at });
  return Object.keys(metadata).length === Object.keys(expected).length
    && Object.keys(expected).every(key => metadata[key] === expected[key]);
}

async function findRegistrationPrivacyPaper({ db, patientId, clinicId, template, version, approvedVersions, transaction, now = new Date() }) {
  if (!isApprovedPaperFamilyVersion(version)) return null;
  if (!transaction || !db.PatientConsentExternalAttestation || !db.PatientOperationalEvent) throw invalidConfiguration();
  const attestations = await db.PatientConsentExternalAttestation.findAll({ where: { paciente_id: Number(patientId),
    clinica_id: Number(clinicId), purpose: 'data_protection', source: PAPER_SOURCE, status: 'active', revoked_at: null },
    order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
  if (attestations.length > 100) throw invalidConfiguration();
  if (!attestations.length) return null;
  const events = await db.PatientOperationalEvent.findAll({ where: { patient_id: Number(patientId), clinic_id: Number(clinicId),
    event_type: PAPER_EVENT, source: PAPER_SOURCE }, order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
  if (events.length > 100) throw invalidConfiguration();
  for (const attestation of attestations) for (const event of events) {
    if (matchesPaperEvidence({ attestation, event, patientId, clinicId, template, approvedVersions, now })) {
      return { kind: 'paper', attestation_id: Number(plain(attestation).id), recorded_at: new Date(plain(attestation).attested_at).toISOString() };
    }
  }
  return null;
}

const paperAssessment = evidence => ({ required: true, allowed: true, reason: 'privacy_received_on_paper',
  privacy_satisfied: true, privacy_signed: false, privacy_on_paper: true, evidence });

async function recordRegistrationPrivacyPaper({ db, appointment, actorId, acknowledged, transaction, now = null }) {
  const cita = plain(appointment), patientId = Number(cita?.paciente_id), clinicId = Number(cita?.clinica_id);
  if (acknowledged !== true) throw failure('appointment_consent_privacy_paper_acknowledgement_required',
    'Confirma que ya dispones del consentimiento de protección de datos firmado en papel.', 400);
  if (!transaction || !positive(actorId) || !positive(cita?.id_cita) || !positive(patientId)
    || ![66, 72].includes(clinicId)) throw invalidConfiguration();
  const patient = await db.Paciente.findByPk(patientId, { attributes: ['id_paciente'], transaction, lock: transaction.LOCK.UPDATE });
  if (!patient) throw failure('appointment_not_found', 'No se encontró el paciente de la cita.', 404);
  // Capture the operating clock only after acquiring the patient anchor. A
  // request waiting behind another appointment for this same patient must see
  // that committed receipt as past evidence, not as a future observation.
  now = now || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw invalidConfiguration();
  const template = plain(await db.ClinicConsentTemplate.findOne({ where: { clinic_id: clinicId, catalog_key: FINAL_PRIVACY_KEY,
    purpose: 'data_protection', status: 'active', is_default: true, blocking_policy: 'hard' }, transaction, lock: transaction.LOCK.SHARE }));
  if (!template) throw invalidConfiguration();
  const version = plain(await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id,
    status: 'published', locale: 'es' }, order: [['version', 'DESC'], ['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE }));
  if (!isApprovedPaperFamilyVersion(version)) throw invalidConfiguration();
  const approvedVersions = await require('../services/appointmentPrivacyEligibility.service').approvedPrivacyVersions({ db, template, version, transaction });
  const existing = await findRegistrationPrivacyPaper({ db, patientId, clinicId, template, version, approvedVersions, transaction, now });
  if (existing) return { created: false, ...paperAssessment(existing) };
  const attestation = plain(await db.PatientConsentExternalAttestation.create({ public_id: `cext_${randomUUID().replace(/-/g, '')}`,
    paciente_id: patientId, clinica_id: clinicId, tratamiento_id: null, purpose: 'data_protection', title: PAPER_TITLE,
    note: PAPER_NOTE, source: PAPER_SOURCE, status: 'active', attested_by: Number(actorId), attested_at: now,
    revoked_by: null, revoked_at: null }, { transaction }));
  await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: clinicId, actor_user_id: Number(actorId),
    event_type: PAPER_EVENT, source: PAPER_SOURCE, channel: 'internal', occurred_at: now,
    metadata: receiptMetadata({ attestationId: attestation.id, appointmentId: cita.id_cita,
      template, version, recordedAt: now.toISOString() }) }, { transaction });
  return { created: true, ...paperAssessment({ kind: 'paper', attestation_id: Number(attestation.id), recorded_at: now.toISOString() }) };
}

module.exports = { PAPER_SOURCE, PAPER_EVENT, PAPER_TITLE, PAPER_NOTE, FINAL_PRIVACY_KEY,
  isApprovedPaperFamilyVersion, matchesPaperEvidence, findRegistrationPrivacyPaper, paperAssessment, recordRegistrationPrivacyPaper };
