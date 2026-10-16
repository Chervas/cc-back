'use strict';

// One read-only projection for the patient, reception and appointment cards.
// No issue/sign/send operation is ever called from this module. Legal validity
// is delegated to the same pinned checks used by the care-start gate.
const eligibility = require('./appointmentPrivacyEligibility.service');
const paper = require('../lib/registration-privacy-paper');
const plain = value => value?.toJSON ? value.toJSON() : value;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const stamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const key = (patient, clinic) => `${Number(patient)}:${Number(clinic)}`;
const failure = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const isFuture = (value, now) => !value || new Date(value).getTime() > now.getTime();
const pairWhere = pairs => pairs.map(pair => ({ paciente_id: pair.patientId, clinica_id: pair.clinicId }));
const safeDocument = doc => doc ? { id: Number(doc.id), public_id: doc.public_id || null,
  title: doc.title || 'Protección de datos', status: doc.status, signed_at: stamp(doc.signed_at) } : null;

async function patientForPrivacyClinic({ db, identifier, clinicId: rawClinicId, transaction, lock = false }) {
  const clinicId = positive(rawClinicId), identifierValue = String(identifier ?? '').trim();
  if (!clinicId) throw failure('clinic_id_required', 400);
  if (!identifierValue || identifierValue.length > 128) throw failure('patient_not_found', 404);
  const locks = lock ? { lock: transaction.LOCK.UPDATE } : {};
  const options = { attributes: ['id_paciente', 'public_id', 'clinica_id'], transaction, ...locks };
  const { Op } = db.Sequelize;
  const patient = plain(/^\d+$/.test(identifierValue)
    ? await db.Paciente.findByPk(positive(identifierValue), options)
    : await db.Paciente.findOne({ where: { public_id: { [Op.in]: identifierValue.startsWith('pat_')
      ? [identifierValue, `pac_${identifierValue.slice(4)}`] : [identifierValue] } }, ...options }));
  if (!patient || !positive(patient.id_paciente) || !positive(patient.clinica_id)) throw failure('patient_not_found', 404);
  if (Number(patient.clinica_id) === clinicId) return patient;
  const shared = lock ? { lock: transaction.LOCK.SHARE } : {};
  const membership = plain(await db.PacienteClinica.findOne({ where: { paciente_id: Number(patient.id_paciente), clinica_id: clinicId },
    attributes: ['id', 'paciente_id', 'clinica_id'], transaction, ...shared }));
  if (!membership || Number(membership.paciente_id) !== Number(patient.id_paciente)
    || Number(membership.clinica_id) !== clinicId) throw failure('patient_privacy_scope_forbidden', 403);
  const clinics = [];
  for (const id of [clinicId, Number(patient.clinica_id)].sort((a, b) => a - b)) {
    const clinic = plain(await db.Clinica.findByPk(id, { attributes: ['id_clinica', 'grupoClinicaId'], transaction, ...shared }));
    if (!clinic || Number(clinic.id_clinica) !== id) throw failure('patient_privacy_scope_forbidden', 403);
    clinics.push(clinic);
  }
  if (!positive(clinics[0].grupoClinicaId) || Number(clinics[0].grupoClinicaId) !== Number(clinics[1].grupoClinicaId)) {
    throw failure('patient_privacy_scope_forbidden', 403);
  }
  return patient;
}

const empty = (appointment, now) => ({ patient_id: Number(appointment.paciente_id), clinic_id: Number(appointment.clinica_id),
  appointment_id: positive(appointment.id_cita), applicable: eligibility.CLINICS.includes(Number(appointment.clinica_id)),
  required: false, allowed: true, reason: 'outside_registration_scope', state: 'not_requested',
  has_pending: false, attention_required: false, document_id: null, package_id: null, document: null,
  evidence: null, updated_at: null });

async function bounded(model, options, limit) {
  const rows = (await model.findAll({ ...options, limit: limit + 1 })).map(plain);
  if (rows.length > limit) throw failure('patient_privacy_review_required');
  return rows;
}

// Batched across the whole authorized appointment page, not once per card.
// Every query is bounded, uses the same snapshot and carries explicit scope.
async function loadPrivacyContext({ db, appointments, transaction, now = new Date() }) {
  const { Op } = db.Sequelize;
  const pairs = [...new Map(appointments.map(plain).filter(cita => positive(cita?.paciente_id)
    && eligibility.CLINICS.includes(Number(cita.clinica_id))).map(cita => [key(cita.paciente_id, cita.clinica_id),
    { patientId: Number(cita.paciente_id), clinicId: Number(cita.clinica_id) }])).values()];
  const context = { pairs, now, templates: new Map(), versions: new Map(), imported: new Set(), care: [],
    documents: [], packages: new Map(), deliveries: new Map(), attestations: [], events: [], stateCache: new Map() };
  if (!pairs.length) return context;
  if (pairs.length > 1000) throw failure('patient_privacy_review_required');
  const clinicIds = [...new Set(pairs.map(pair => pair.clinicId))], patientIds = [...new Set(pairs.map(pair => pair.patientId))];
  const templates = await bounded(db.ClinicConsentTemplate, { where: { clinic_id: { [Op.in]: clinicIds },
    catalog_key: eligibility.FINAL_PRIVACY_KEY, purpose: 'data_protection', status: 'active', is_default: true,
    blocking_policy: 'hard' }, transaction }, clinicIds.length * 2);
  for (const template of templates) {
    if (context.templates.has(Number(template.clinic_id))) throw failure('patient_privacy_configuration');
    context.templates.set(Number(template.clinic_id), template);
  }
  const templateIds = templates.map(template => Number(template.id));
  const versions = templateIds.length ? await bounded(db.ClinicConsentTemplateVersion, { where: {
    clinic_template_id: { [Op.in]: templateIds }, status: 'published', locale: 'es' },
  order: [['version', 'DESC'], ['id', 'DESC']], transaction }, templateIds.length * 101) : [];
  for (const template of templates) {
    const list = versions.filter(version => Number(version.clinic_template_id) === Number(template.id));
    if (list.length > 101) throw failure('patient_privacy_configuration');
    const version = list[0];
    if (!version || !String(version.body_html || '').trim()) continue;
    try {
      if (!require('../lib/consent-document-choices').getConsentChoiceForm({ snapshot_json: { version: { body_json: version.body_json } } })) continue;
    } catch { continue; }
    const approved = await eligibility.approvedPrivacyVersions({ db, template, version, transaction,
      publishedVersions: list.slice(1) });
    context.versions.set(Number(template.id), { version, approved });
  }
  const imported = await bounded(db.PatientCustomField, { where: { paciente_id: { [Op.in]: patientIds },
    source: 'cliniccloud', clinica_id: { [Op.in]: eligibility.CLINICS }, source_column: 'idContacto' },
  attributes: ['paciente_id', 'value'], transaction }, patientIds.length * 100);
  for (const row of imported) if (/^[1-9]\d*$/.test(String(row.value || '').trim())) context.imported.add(Number(row.paciente_id));
  context.care = await bounded(db.CitaPaciente, { where: { [Op.and]: [{ [Op.or]: pairWhere(pairs) }, { [Op.or]: [
    { care_started_at: { [Op.ne]: null, [Op.lte]: now } }, { care_legacy_attendance: true },
  ] }] }, attributes: ['paciente_id', 'clinica_id', [db.Sequelize.fn('MIN', db.Sequelize.col('id_cita')), 'first_care_id'],
    [db.Sequelize.fn('MAX', db.Sequelize.col('id_cita')), 'last_care_id']],
  group: ['paciente_id', 'clinica_id'], raw: true, transaction }, pairs.length);
  if (!templateIds.length) return context;
  context.documents = await bounded(db.PatientConsentDocument, { where: { [Op.or]: pairWhere(pairs),
    clinic_template_id: { [Op.in]: templateIds }, purpose: 'data_protection', revoked_at: null,
    status: { [Op.in]: ['pending', 'sent', 'viewed', 'signed'] }, [Op.and]: [{ [Op.or]: [
      { expires_at: null }, { expires_at: { [Op.gt]: now } },
    ] }] }, order: [['id', 'DESC']], transaction }, pairs.length * 101);
  const packageIds = [...new Set(context.documents.map(doc => positive(doc.package_id)).filter(Boolean))];
  if (packageIds.length) {
    const packages = await bounded(db.ConsentSignaturePackage, { where: { id: { [Op.in]: packageIds } },
      attributes: ['id', 'paciente_id', 'clinica_id', 'status', 'expires_at'], transaction }, packageIds.length);
    for (const pkg of packages) context.packages.set(Number(pkg.id), pkg);
    const deliveries = await bounded(db.ConsentDeliveryEvent, { where: { package_id: { [Op.in]: packageIds },
      patient_consent_document_id: { [Op.in]: context.documents.map(doc => Number(doc.id)) },
      status: { [Op.in]: ['queued', 'sent', 'viewed'] } },
    attributes: ['id', 'patient_consent_document_id', 'package_id', 'channel', 'status', 'createdAt'],
    order: [['id', 'DESC']], transaction }, packageIds.length * 100);
    for (const delivery of deliveries) if (!context.deliveries.has(Number(delivery.patient_consent_document_id))) {
      context.deliveries.set(Number(delivery.patient_consent_document_id), delivery);
    }
  }
  const sources = { [Op.in]: [paper.PAPER_SOURCE, paper.PATIENT_PAPER_SOURCE] };
  context.attestations = await bounded(db.PatientConsentExternalAttestation, { where: {
    [Op.or]: pairWhere(pairs), purpose: 'data_protection', source: sources, status: 'active', revoked_at: null },
  order: [['id', 'DESC']], transaction }, pairs.length * 101);
  if (context.attestations.length) context.events = await bounded(db.PatientOperationalEvent, { where: {
    [Op.or]: pairs.map(pair => ({ patient_id: pair.patientId, clinic_id: pair.clinicId })),
    event_type: paper.PAPER_EVENT, source: sources }, order: [['id', 'DESC']], transaction }, pairs.length * 101);
  return context;
}

function privacyStateFromContext({ appointment, context }) {
  const cita = plain(appointment), { now } = context, result = empty(cita, now);
  if (!result.applicable) return result;
  const patientId = result.patient_id, clinicId = result.clinic_id;
  const imported = context.imported.has(patientId), prior = context.care.some(row => Number(row.paciente_id) === patientId
    && Number(row.clinica_id) === clinicId && (Number(row.first_care_id) !== result.appointment_id
      || Number(row.last_care_id) !== result.appointment_id));
  result.required = !imported && !prior;
  result.reason = imported ? 'existing_imported_patient' : prior ? 'existing_clinical_patient' : 'current_privacy_pending';
  result.allowed = !result.required;
  // A combined visit can have many cards for the same patient and clinic.
  // Cache the expensive legal/body/hash checks, keeping only the appointment
  // identity and its own prior-care classification separate.
  const cacheKey = `${key(patientId, clinicId)}:${result.required}:${result.reason}`;
  const cached = context.stateCache.get(cacheKey);
  if (cached) return { ...cached, appointment_id: result.appointment_id };
  const complete = value => { context.stateCache.set(cacheKey, value); return value; };
  const template = context.templates.get(clinicId), published = template && context.versions.get(Number(template.id));
  if (!published) return complete({ ...result, configuration_error: true, attention_required: true });
  const { version, approved } = published;
  const documents = context.documents.filter(doc => Number(doc.paciente_id) === patientId && Number(doc.clinica_id) === clinicId
    && Number(doc.clinic_template_id) === Number(template.id));
  if (documents.length > 100) throw failure('patient_privacy_review_required');
  const signed = documents.find(document => eligibility.isValidSignedPrivacyDocument({ document, template,
    patientId, clinicId, approvedVersions: approved, now }));
  if (signed) return complete({ ...result, allowed: true, reason: 'current_privacy_signed', state: 'signed',
    document_id: Number(signed.id), document: safeDocument(signed), updated_at: stamp(signed.signed_at) || result.updated_at });
  const attestations = context.attestations.filter(row => Number(row.paciente_id) === patientId && Number(row.clinica_id) === clinicId);
  const events = context.events.filter(row => Number(row.patient_id) === patientId && Number(row.clinic_id) === clinicId);
  if (attestations.length > 100 || events.length > 100) throw failure('patient_privacy_review_required');
  for (const attestation of attestations) for (const event of events) {
    if (paper.matchesPaperEvidence({ attestation, event, patientId, clinicId, template, approvedVersions: approved, now })) {
      return complete({ ...result, allowed: true, reason: 'privacy_received_on_paper', state: 'paper', evidence: {
        kind: 'paper', attestation_id: Number(attestation.id), recorded_at: stamp(attestation.attested_at),
      }, updated_at: stamp(attestation.attested_at) || result.updated_at });
    }
  }
  const pending = documents.find(doc => {
    if (!['pending', 'sent', 'viewed'].includes(doc.status) || Number(doc.clinic_template_version_id) !== Number(version.id)
      || doc.revoked_at || !isFuture(doc.expires_at, now)) return false;
    const pkg = context.packages.get(Number(doc.package_id));
    return pkg && Number(pkg.paciente_id) === patientId && Number(pkg.clinica_id) === clinicId
      && ['draft', 'pending', 'sent', 'viewed'].includes(pkg.status) && isFuture(pkg.expires_at, now);
  });
  if (pending) {
    const delivery = context.deliveries.get(Number(pending.id));
    const safeDelivery = delivery && Number(delivery.package_id) === Number(pending.package_id) ? delivery : null;
    result.state = pending.status === 'viewed' || safeDelivery?.status === 'viewed' ? 'viewed'
      : pending.status === 'sent' || safeDelivery ? 'sent' : 'pending';
    Object.assign(result, { document_id: Number(pending.id), package_id: Number(pending.package_id), document: safeDocument(pending),
      has_pending: true, attention_required: true, updated_at: stamp(safeDelivery?.createdAt || pending.updatedAt || pending.createdAt) || result.updated_at });
  } else {
    // Reception must see missing LOPD evidence on existing/imported patients as
    // well. This visual action is independent of the new-patient care gate:
    // preserve required/allowed and never invent a pending document/request.
    result.attention_required = true;
  }
  return complete(result);
}

async function getPatientPrivacyStatus({ db, patientId, clinicId, appointmentId = null, transaction, now = new Date() }) {
  if (!transaction || !positive(patientId) || !positive(clinicId)) throw failure('patient_privacy_scope_required', 400);
  const appointment = { paciente_id: Number(patientId), clinica_id: Number(clinicId), id_cita: positive(appointmentId) };
  const context = await loadPrivacyContext({ db, appointments: [appointment], transaction, now });
  return privacyStateFromContext({ appointment, context });
}

module.exports = { patientForPrivacyClinic, getPatientPrivacyStatus, loadPrivacyContext, privacyStateFromContext };
