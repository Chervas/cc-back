'use strict';

// An explicit reception attestation is not a patient signature. It has its own
// reserved source and append-only server receipt; generic external-document
// checkboxes, imported history and optional permissions cannot authorize it.
const { randomUUID, createHash } = require('node:crypto');
const digital = require('./bs-privacy-digital-template');
const PAPER_SOURCE = 'registration_privacy_paper/v1';
const PATIENT_PAPER_SOURCE = 'registration_privacy_paper/v2';
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

function receiptMetadata({ attestationId, appointmentId, template, version, recordedAt, patientOnly = false }) {
  return { schema_version: patientOnly ? PATIENT_PAPER_SOURCE : PAPER_SOURCE, attestation_id: Number(attestationId),
    appointment_id: patientOnly ? null : Number(appointmentId),
    clinic_template_id: Number(template.id), clinic_template_version_id: Number(version.id), catalog_key: FINAL_PRIVACY_KEY,
    source_document_sha256: digital.SOURCE_DOCUMENT_SHA256, legal_text_sha256: digital.LEGAL_TEXT_SHA256,
    acknowledged: true, recorded_at: recordedAt };
}

function matchesPaperEvidence({ attestation, event, patientId, clinicId, template, approvedVersions, now }) {
  const row = plain(attestation), audit = plain(event), metadata = object(audit?.metadata);
  const patientOnly = row?.source === PATIENT_PAPER_SOURCE;
  const source = patientOnly ? PATIENT_PAPER_SOURCE : PAPER_SOURCE;
  const approved = approvedVersions.get(Number(metadata.clinic_template_version_id));
  if (!approved || !isApprovedPaperFamilyVersion(approved.version)
    || Number(approved.version.clinic_template_id) !== Number(template.id)
    || template.catalog_key !== FINAL_PRIVACY_KEY || Number(template.clinic_id) !== Number(clinicId)
    || template.purpose !== 'data_protection' || template.status !== 'active' || template.is_default !== true
    || template.blocking_policy !== 'hard' || !positive(row?.id)
    || (patientOnly ? metadata.appointment_id !== null : !positive(metadata.appointment_id))
    || Number(row.paciente_id) !== Number(patientId) || Number(row.clinica_id) !== Number(clinicId)
    || row.tratamiento_id != null || row.purpose !== 'data_protection' || row.source !== source
    || row.status !== 'active' || row.revoked_at || row.revoked_by || !positive(row.attested_by)
    || !positive(audit?.id) || Number(audit.patient_id) !== Number(patientId) || Number(audit.clinic_id) !== Number(clinicId)
    || audit.source !== source || audit.event_type !== PAPER_EVENT || audit.channel !== 'internal'
    || Number(audit.actor_user_id) !== Number(row.attested_by)) return false;
  const attested = dateValue(row.attested_at), occurred = dateValue(audit.occurred_at), recorded = dateValue(metadata.recorded_at);
  if (![attested, occurred, recorded].every(value => Number.isFinite(value) && value <= now.getTime())
    || Math.abs(attested - recorded) >= 1000 || Math.abs(occurred - recorded) >= 1000) return false;
  const expected = receiptMetadata({ attestationId: row.id, appointmentId: metadata.appointment_id,
    template, version: approved.version, recordedAt: metadata.recorded_at, patientOnly });
  return Object.keys(metadata).length === Object.keys(expected).length
    && Object.keys(expected).every(key => metadata[key] === expected[key]);
}

async function findRegistrationPrivacyPaper({ db, patientId, clinicId, template, version, approvedVersions, transaction, now = new Date() }) {
  if (!isApprovedPaperFamilyVersion(version)) return null;
  if (!transaction || !db.PatientConsentExternalAttestation || !db.PatientOperationalEvent) throw invalidConfiguration();
  const { Op } = db.Sequelize;
  const sources = { [Op.in]: [PAPER_SOURCE, PATIENT_PAPER_SOURCE] };
  const attestations = await db.PatientConsentExternalAttestation.findAll({ where: { paciente_id: Number(patientId),
    clinica_id: Number(clinicId), purpose: 'data_protection', source: sources, status: 'active', revoked_at: null },
    order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
  if (attestations.length > 100) throw invalidConfiguration();
  if (!attestations.length) return null;
  const events = await db.PatientOperationalEvent.findAll({ where: { patient_id: Number(patientId), clinic_id: Number(clinicId),
    event_type: PAPER_EVENT, source: sources }, order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
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

// Supersede only outstanding attempts for this exact approved LOPD family.
// The original snapshots/delivery events remain history; no digital signature
// is manufactured. Mixed packages keep all their other clinical/intake work.
async function retirePendingPrivacyRequests({ db, patientId, clinicId, template, approvedVersions,
  evidence, actorId, source, transaction, now, refreshPackageCounts = null }) {
  const { Op } = db.Sequelize;
  const pending = ['pending', 'sent', 'viewed'];
  const candidates = (await db.PatientConsentDocument.findAll({ where: { paciente_id: patientId, clinica_id: clinicId,
    clinic_template_id: Number(template.id), clinic_template_version_id: { [Op.in]: [...approvedVersions.keys()] },
    purpose: 'data_protection', status: { [Op.in]: pending }, signed_at: null, revoked_at: null,
    [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: now } }] },
  attributes: ['id', 'package_id', 'paciente_id', 'clinica_id', 'clinic_template_id', 'clinic_template_version_id',
    'purpose', 'status', 'signed_at', 'revoked_at', 'expires_at'], order: [['id', 'ASC']], limit: 101,
  raw: true, transaction })).map(plain);
  if (candidates.length > 100) throw invalidConfiguration();
  if (!candidates.length) return [];
  const packageIds = [...new Set(candidates.map(row => positive(row.package_id) ? Number(row.package_id) : null).filter(Boolean))].sort((a, b) => a - b);
  const available = new Set();
  for (const id of packageIds) {
    const pkg = plain(await db.ConsentSignaturePackage.findByPk(id, { attributes: ['id', 'paciente_id', 'clinica_id', 'status', 'expires_at'],
      transaction, lock: transaction.LOCK.UPDATE }));
    if (pkg && Number(pkg.paciente_id) === patientId && Number(pkg.clinica_id) === clinicId
      && ['draft', 'pending', 'sent', 'viewed'].includes(pkg.status)
      && (!pkg.expires_at || dateValue(pkg.expires_at) > now.getTime())) available.add(id);
  }
  const retired = [], changedPackages = new Set();
  for (const row of candidates) {
    if (!positive(row.id) || Number(row.paciente_id) !== patientId || Number(row.clinica_id) !== clinicId
      || Number(row.clinic_template_id) !== Number(template.id) || !approvedVersions.has(Number(row.clinic_template_version_id))
      || row.purpose !== 'data_protection' || !pending.includes(row.status) || row.signed_at || row.revoked_at
      || row.expires_at && dateValue(row.expires_at) <= now.getTime() || row.package_id && !available.has(Number(row.package_id))) continue;
    const [changed] = await db.PatientConsentDocument.update({ status: 'superseded', delivery_status: 'superseded' }, {
      where: { id: Number(row.id), package_id: row.package_id || null, paciente_id: patientId, clinica_id: clinicId,
        clinic_template_id: Number(template.id), clinic_template_version_id: Number(row.clinic_template_version_id),
        purpose: 'data_protection', status: { [Op.in]: pending }, signed_at: null, revoked_at: null }, transaction });
    if (changed !== 1) continue; // A concurrent signature always wins over retirement.
    retired.push(Number(row.id)); if (row.package_id) changedPackages.add(Number(row.package_id));
  }
  if (!retired.length) return [];
  const refresh = refreshPackageCounts || require('../services/consentimientos.service').refreshPackageCounts;
  for (const id of [...changedPackages].sort((a, b) => a - b)) await refresh(id, transaction);
  await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: clinicId, actor_user_id: Number(actorId),
    event_type: 'registration_privacy.pending_superseded', source, channel: 'internal', occurred_at: now,
    metadata: { schema_version: 'registration_privacy_pending_superseded/v1', attestation_id: Number(evidence.attestation_id),
      clinic_template_id: Number(template.id), document_ids: retired, package_ids: [...changedPackages].sort((a, b) => a - b),
      reason: 'privacy_received_on_paper' } }, { transaction });
  return retired;
}

async function recordPaper({ db, appointment, patientId: patientIdRaw, clinicId: clinicIdRaw,
  actorId, acknowledged, transaction, now = null, patientOnly = false }) {
  const cita = plain(appointment), patientId = Number(patientOnly ? patientIdRaw : cita?.paciente_id),
    clinicId = Number(patientOnly ? clinicIdRaw : cita?.clinica_id), source = patientOnly ? PATIENT_PAPER_SOURCE : PAPER_SOURCE;
  if (acknowledged !== true) throw failure('appointment_consent_privacy_paper_acknowledgement_required',
    'Confirma que ya dispones del consentimiento de protección de datos firmado en papel.', 400);
  if (!transaction || !positive(actorId) || (!patientOnly && !positive(cita?.id_cita)) || !positive(patientId)
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
  if (existing) {
    await retirePendingPrivacyRequests({ db, patientId, clinicId, template, approvedVersions, evidence: existing,
      actorId, source, transaction, now });
    return { created: false, ...paperAssessment(existing) };
  }
  const attestation = plain(await db.PatientConsentExternalAttestation.create({ public_id: `cext_${randomUUID().replace(/-/g, '')}`,
    paciente_id: patientId, clinica_id: clinicId, tratamiento_id: null, purpose: 'data_protection', title: PAPER_TITLE,
    note: PAPER_NOTE, source, status: 'active', attested_by: Number(actorId), attested_at: now,
    revoked_by: null, revoked_at: null }, { transaction }));
  await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: clinicId, actor_user_id: Number(actorId),
    event_type: PAPER_EVENT, source, channel: 'internal', occurred_at: now,
    metadata: receiptMetadata({ attestationId: attestation.id, appointmentId: cita?.id_cita,
      template, version, recordedAt: now.toISOString(), patientOnly }) }, { transaction });
  const evidence = { kind: 'paper', attestation_id: Number(attestation.id), recorded_at: now.toISOString() };
  await retirePendingPrivacyRequests({ db, patientId, clinicId, template, approvedVersions, evidence,
    actorId, source, transaction, now });
  return { created: true, ...paperAssessment(evidence) };
}

const recordRegistrationPrivacyPaper = options => recordPaper({ ...options, patientOnly: false });
const recordPatientRegistrationPrivacyPaper = options => recordPaper({ ...options, patientOnly: true });

module.exports = { PAPER_SOURCE, PATIENT_PAPER_SOURCE, PAPER_EVENT, PAPER_TITLE, PAPER_NOTE, FINAL_PRIVACY_KEY,
  isApprovedPaperFamilyVersion, matchesPaperEvidence, findRegistrationPrivacyPaper, paperAssessment,
  recordRegistrationPrivacyPaper, recordPatientRegistrationPrivacyPaper, retirePendingPrivacyRequests };
