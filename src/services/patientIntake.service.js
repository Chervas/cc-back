'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const db = require('../../models');
const q = require('../lib/patient-intake-questionnaire');
const { patientForIntakeClinic } = require('../lib/patient-intake-clinic-scope');
const { Op } = db.Sequelize;
const json = row => row?.toJSON ? row.toJSON() : row;
const patientHash = p => createHash('sha256').update(JSON.stringify({ personal: q.personalSnapshot(p), alergias: p.alergias || '', medicacion: p.medicacion || '', antecedentes: p.antecedentes || '' })).digest('hex');

async function scopedPatient(patientId, clinicId, transaction) {
  return patientForIntakeClinic({ db, identifier: patientId, clinicId, transaction });
}

async function prepare({ patientId, clinicId, actorId }) {
  await scopedPatient(patientId, clinicId);
  const pendingReview = await db.PatientIntakeRequest.findOne({ where: { patient_id: patientId, clinic_id: clinicId }, order: [['id', 'DESC']] });
  if (pendingReview?.status === 'submitted') throw q.error('intake_review_pending', 'El paciente ya ha enviado sus respuestas. El profesional debe revisarlas antes de solicitar otro formulario.', 409);
  // This explicit action prepares clinical answers only. Privacy has its own
  // action/package; never create a signature request as a side effect here.
  return db.sequelize.transaction(async transaction => {
    const patient = await scopedPatient(patientId, clinicId, transaction);
    // Current read: answers submitted while scope was checked must not be
    // hidden by a new empty request. The patient lock serializes preparations.
    const previous = await db.PatientIntakeRequest.findOne({ where: { patient_id: patientId, clinic_id: clinicId },
      order: [['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE || transaction.LOCK.UPDATE });
    if (previous?.status === 'submitted') throw q.error('intake_review_pending', 'El paciente ya ha enviado sus respuestas. El profesional debe revisarlas antes de solicitar otro formulario.', 409);
    if (previous?.status === 'pending') {
      const pkg = await db.ConsentSignaturePackage.findByPk(previous.package_id, { transaction });
      const healthOnly = pkg && Number(pkg.paciente_id ?? patientId) === Number(patientId)
        && Number(pkg.clinica_id ?? clinicId) === Number(clinicId)
        && await db.PatientConsentDocument.count({ where: { package_id: pkg.id }, transaction }) === 0;
      if (healthOnly && !['expired', 'cancelled'].includes(pkg.status) && new Date(pkg.expires_at) > new Date()) return { package_id: pkg.id, intake_id: previous.id, reused: true };
    }
    // Do not attach clinical questions to an existing LOPD package, even if it
    // is unsigned. Each button controls exactly one independent tablet item.
    const pkg = await db.ConsentSignaturePackage.create({ public_id: `cpkg_${randomUUID().replace(/-/g, '')}`,
      paciente_id: patientId, clinica_id: clinicId, status: 'pending', trigger_source: 'patient_intake', created_by: actorId,
      expires_at: new Date(Date.now() + 30 * 86400000) }, { transaction });
    const request = await db.PatientIntakeRequest.create({ package_id: pkg.id, patient_id: patientId, clinic_id: clinicId,
      schema_version: q.VERSION, personal_snapshot: q.personalSnapshot(patient), created_by: actorId }, { transaction });
    return { package_id: pkg.id, intake_id: request.id, reused: false };
  });
}

async function publicView(pkg) {
  const request = await db.PatientIntakeRequest.findOne({ where: { package_id: pkg.id, patient_id: pkg.paciente_id, clinic_id: pkg.clinica_id } });
  if (!request) return null;
  let answers = request.answers;
  if (!answers) {
    const prior = await db.PatientIntakeRequest.findOne({ where: { patient_id: request.patient_id, clinic_id: request.clinic_id,
      id: { [Op.lt]: request.id }, submitted_at: { [Op.ne]: null } }, order: [['id', 'DESC']] });
    answers = prior?.answers || {};
  }
  // Never return the doctor's notes, edits or confirmed clinical history here.
  return { status: request.status, version: request.version, schema_version: request.schema_version,
    fields: q.fields, personal: request.submitted_personal || request.personal_snapshot, answers, submitted_at: request.submitted_at };
}

async function submit(pkg, payload) {
  const input = q.validateSubmission(payload);
  return db.sequelize.transaction(async transaction => {
    // Same lock order as prepare: patient -> package -> request. A tablet with
    // an older combined form cannot race a new independent questionnaire.
    await scopedPatient(pkg.paciente_id, pkg.clinica_id, transaction);
    const active = await db.ConsentSignaturePackage.findByPk(pkg.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!active || ['expired', 'cancelled'].includes(active.status) || !active.expires_at || new Date(active.expires_at) <= new Date()
      || active.paciente_id !== pkg.paciente_id || active.clinica_id !== pkg.clinica_id) {
      throw q.error('intake_package_expired', 'El formulario ya no está disponible. Pide a recepción un nuevo acceso.', 410);
    }
    const request = await db.PatientIntakeRequest.findOne({ where: { package_id: pkg.id, patient_id: pkg.paciente_id, clinic_id: pkg.clinica_id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!request) throw q.error('intake_not_requested', 'Este enlace no incluye un formulario inicial.', 404);
    if (request.schema_version !== q.VERSION) throw q.error('intake_schema_changed', 'Vuelve a abrir el formulario.', 409);
    if (request.status !== 'pending') {
      if (isDeepStrictEqual(request.answers, input.answers) && isDeepStrictEqual(request.submitted_personal, input.personal)) return { submitted: true, replayed: true };
      throw q.error('intake_already_submitted', 'Las respuestas ya se enviaron. Pide a recepción un nuevo formulario para corregirlas.', 409);
    }
    const latest = await db.PatientIntakeRequest.findOne({ where: { patient_id: pkg.paciente_id, clinic_id: pkg.clinica_id },
      order: [['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE || transaction.LOCK.UPDATE });
    if (!latest || latest.id !== request.id) throw q.error('intake_request_superseded',
      'Este formulario se ha sustituido. Vuelve a la tablet y abre el formulario más reciente.', 409);
    if (request.version !== payload.expected_version) throw q.error('intake_version_conflict', 'El formulario ha cambiado. Vuelve a abrirlo.', 409);
    await request.update({ answers: input.answers, submitted_personal: input.personal, status: 'submitted', submitted_at: new Date(), version: request.version + 1 }, { transaction });
    // No Patient update, clinical diagnosis, signature, provider delivery or
    // appointment completion occurs when the patient submits answers.
    return { submitted: true, replayed: false };
  });
}

async function reviewView({ patientId, clinicId }) {
  return db.sequelize.transaction(async transaction => {
    const patient = await scopedPatient(patientId, clinicId, transaction);
    const request = await db.PatientIntakeRequest.findOne({ where: { patient_id: patientId, clinic_id: clinicId }, order: [['id', 'DESC']], transaction });
    const current = { alergias: patient.alergias || '', medicacion: patient.medicacion || '', antecedentes: patient.antecedentes || '' };
    const proposed = q.suggestedSummary(request?.answers || {});
    const merged = Object.fromEntries(Object.keys(current).map(key => [key, !proposed[key] || current[key].includes(proposed[key]) ? current[key] : [current[key], proposed[key]].filter(Boolean).join('\n\n')]));
    return { request: request ? json(request) : null, fields: q.fields, current, proposed: merged, personal: q.personalSnapshot(patient), patient_version: patientHash(patient) };
  });
}

async function confirm({ patientId, clinicId, actorId, payload }) {
  if (!Number.isSafeInteger(payload?.id) || payload.id < 1 || !Number.isSafeInteger(payload.expected_version) || payload.expected_version < 1) {
    throw q.error('intake_review_invalid', 'Vuelve a abrir las respuestas antes de confirmar.');
  }
  return db.sequelize.transaction(async transaction => {
    const patient = await scopedPatient(patientId, clinicId, transaction);
    const request = await db.PatientIntakeRequest.findOne({ where: { id: payload.id, patient_id: patientId, clinic_id: clinicId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!request || request.status !== 'submitted' || request.version !== payload.expected_version) throw q.error('intake_review_conflict', 'Vuelve a abrir las respuestas: ya se revisaron o han cambiado.', 409);
    const latest = await db.PatientIntakeRequest.findOne({ where: { patient_id: patientId, clinic_id: clinicId }, order: [['id', 'DESC']], transaction });
    if (latest.id !== request.id || payload.patient_version !== patientHash(patient)) throw q.error('intake_patient_changed', 'La ficha ha cambiado. Revisa la versión actual antes de confirmar.', 409);
    const confirmed = {};
    for (const key of ['alergias', 'medicacion', 'antecedentes']) {
      if (typeof payload.summary?.[key] !== 'string' || payload.summary[key].length > 20000) throw q.error('intake_summary_invalid', 'Revisa el resumen clínico.');
      confirmed[key] = payload.summary[key].trim();
    }
    if (typeof payload.apply_personal_changes !== 'boolean') throw q.error('intake_personal_confirmation_required', 'Indica si has revisado los cambios de identificación.');
    const patch = { ...confirmed };
    if (payload.apply_personal_changes) {
      Object.assign(patch, request.submitted_personal);
      patch.fecha_nacimiento = patch.fecha_nacimiento || null;
      patch.edad = null; // age is recalculated from DOB, never copied from a stale form
    }
    const previous = { alergias: patient.alergias, medicacion: patient.medicacion, antecedentes: patient.antecedentes, personal: q.personalSnapshot(patient) };
    await patient.update(patch, { transaction });
    await request.update({ status: 'reviewed', reviewed_at: new Date(), reviewed_by: actorId, version: request.version + 1,
      confirmed_summary: { ...confirmed, applied_personal_changes: payload.apply_personal_changes, previous } }, { transaction });
    return { reviewed: true };
  });
}
module.exports = { prepare, publicView, submit, reviewView, confirm };
