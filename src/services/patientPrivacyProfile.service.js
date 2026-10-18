'use strict';

// A completed, verified LOPD fills only still-empty master fields atomically
// with signing. Reception explicitly accepts each conflicting value inline.
// Signed evidence is immutable and existing values are never cleared here.
const { createHash } = require('node:crypto');
const privacy = require('./patientPrivacyStatus.service');
const identity = require('../lib/consent-document-personal-data');
const choices = require('../lib/consent-document-choices');
const { normalizePhoneDigits, getPhoneIdentityCandidates } = require('../lib/phone');
const plain = value => value?.toJSON ? value.toJSON() : value;
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const specs = [
  ['nombre', 'nombre', 'Nombre'], ['apellidos', 'apellidos', 'Apellidos'], ['dni', 'dni', 'DNI, NIE o pasaporte'],
  ['fecha_nacimiento', 'fecha_nacimiento', 'Fecha de nacimiento'], ['direccion', 'direccion', 'Dirección'],
  ['codigo_postal', 'codigo_postal', 'Código postal'], ['poblacion', 'ciudad', 'Población'], ['provincia', 'provincia', 'Provincia'],
  ['telefono_movil', 'telefono', 'Teléfono móvil', true], ['telefono_secundario', 'telefono2', 'Segundo teléfono', true],
  ['email', 'email', 'Correo electrónico', true],
];
const text = value => value == null ? '' : String(value).trim();
const date = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() > 0 ? parsed.toISOString().slice(0, 10) : '';
};
const currentValue = (patient, key) => key === 'fecha_nacimiento' ? date(patient[key]) : text(patient[key]);
const patientVersion = patient => createHash('sha256').update(JSON.stringify([Number(patient.id_paciente),
  ...specs.map(([key]) => [key, currentValue(patient, key)])])).digest('hex');
const equivalent = (key, left, right) => key.startsWith('telefono_')
  ? normalizePhoneDigits(left) === normalizePhoneDigits(right) : key === 'email'
    ? text(left).toLowerCase() === text(right).toLowerCase() : text(left) === text(right);

async function view({ db, patientId, clinicId, transaction }) {
  const patient = plain(await db.Paciente.findByPk(patientId, { transaction }));
  if (!patient) throw fail('patient_not_found', 'No se encuentra el paciente.', 404);
  const context = await privacy.loadPrivacyContext({ db, appointments: [{ paciente_id: patientId, clinica_id: clinicId }], transaction });
  const state = privacy.privacyStateFromContext({ appointment: { paciente_id: patientId, clinica_id: clinicId }, context });
  const doc = state.state === 'signed' ? context.documents.find(row => Number(row.id) === state.document_id) : null;
  const available = !!doc && identity.isIdentityDocument(doc) && doc.snapshot_json?.patient_identity?.confirmed === true;
  const values = available ? identity.contextValues(doc.snapshot_json.context) : {};
  const fields = available ? specs.map(([key, source, label, contact = false]) => ({ key, label,
    current: currentValue(patient, key), proposed: text(values[source]), contact,
    selected_by_default: !contact && !currentValue(patient, key) && !!text(values[source]),
  })).filter(field => field.proposed && !equivalent(field.key, field.current, field.proposed)) : [];
  return { available, privacy_state: state.state, document: available ? { id: Number(doc.id), public_id: doc.public_id, title: doc.title,
    signed_at: new Date(doc.signed_at).toISOString(), snapshot_hash: doc.snapshot_hash } : null,
  patient_version: patientVersion(patient), fields,
  commercial_choice: available ? choices.signedConsentChoiceAnswers(doc)?.commercial || null : null,
  choice_answers: available ? choices.signedConsentChoiceAnswers(doc) : null };
}

async function groupClinicIds(db, clinicId, transaction) {
  const clinic = plain(await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'grupoClinicaId'], transaction }));
  if (!clinic) throw fail('clinic_not_found', 'No se encuentra la clínica.', 404);
  const clinics = clinic.grupoClinicaId ? await db.Clinica.findAll({ where: { grupoClinicaId: clinic.grupoClinicaId },
    attributes: ['id_clinica'], transaction, order: [['id_clinica', 'ASC']] }) : [clinic];
  return clinics.map(row => Number(plain(row).id_clinica)).sort((a, b) => a - b);
}

async function checkContactCollisions({ db, patient, patch, clinicIds, transaction, allowExistingPatientChat = false }) {
  const { Op } = db.Sequelize, predicates = [];
  const phoneMatch = (column, raw, negate = false) => db.Sequelize.where(db.Sequelize.fn('REGEXP_REPLACE',
    db.Sequelize.fn('REGEXP_REPLACE', db.Sequelize.col(column), '[^0-9]', ''), '^00', ''), {
    [negate ? Op.notIn : Op.in]: [...new Set(getPhoneIdentityCandidates(raw).map(value => value.replace(/\D/g, '')))],
  });
  if (patch.email) predicates.push(db.Sequelize.where(db.Sequelize.fn('LOWER', db.Sequelize.fn('TRIM', db.Sequelize.col('email'))), patch.email));
  for (const key of ['telefono_movil', 'telefono_secundario']) if (patch[key]) {
    predicates.push(phoneMatch('telefono_movil', patch[key]), phoneMatch('telefono_secundario', patch[key]));
  }
  if (!predicates.length) return;
  const matches = (await db.Paciente.findAll({ where: { id_paciente: { [Op.ne]: patient.id_paciente }, [Op.or]: predicates },
    attributes: ['id_paciente', 'clinica_id'], transaction, limit: 51, lock: transaction.LOCK.SHARE })).map(plain);
  if (matches.length > 50) throw fail('privacy_profile_contact_collision', 'Revisa los datos de contacto en la ficha antes de aplicarlos.');
  const linked = matches.length ? await db.PacienteClinica.findAll({ where: { paciente_id: { [Op.in]: matches.map(row => row.id_paciente) },
    clinica_id: { [Op.in]: clinicIds } }, attributes: ['paciente_id'], transaction }) : [];
  if (matches.some(row => clinicIds.includes(Number(row.clinica_id))) || linked.length) {
    throw fail('privacy_profile_contact_collision', 'Ese teléfono o correo ya pertenece a otro paciente del grupo. Revisa la ficha antes de aplicarlo.');
  }
  if (patch.telefono_movil && db.Conversation) {
    const other = await db.Conversation.findOne({ where: { clinic_id: { [Op.in]: clinicIds }, channel: 'whatsapp', [Op.and]: [phoneMatch('contact_id', patch.telefono_movil)],
      [Op.or]: [{ patient_id: { [Op.ne]: patient.id_paciente } }, { patient_id: null }] }, transaction, lock: transaction.LOCK.SHARE });
    if (other) throw fail('privacy_profile_phone_chat_collision', 'El teléfono está asociado a otra conversación. Revísalo en la ficha del paciente.');
    const currentChat = await db.Conversation.findOne({ where: { clinic_id: { [Op.in]: clinicIds }, channel: 'whatsapp', patient_id: patient.id_paciente,
      [Op.and]: [phoneMatch('contact_id', patch.telefono_movil, true)] }, transaction, lock: transaction.LOCK.SHARE });
    if (currentChat && !allowExistingPatientChat) throw fail('privacy_profile_phone_chat_review_required',
      'El paciente tiene una conversación con otro teléfono. Revisa el cambio desde su ficha.');
  }
}

async function apply({ db, patientId, clinicId, actorId, authorizedPrimaryClinicId, authorizeCurrent, payload, transaction }) {
  const allowed = ['clinic_id', 'clinica_id', 'document_id', 'snapshot_hash', 'patient_version', 'fields', 'acknowledge_contact_changes'];
  if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))
    || !Array.isArray(payload.fields) || !payload.fields.length || payload.fields.length > specs.length
    || new Set(payload.fields).size !== payload.fields.length || payload.fields.some(key => !specs.some(spec => spec[0] === key))) {
    throw fail('privacy_profile_payload_invalid', 'Selecciona los datos que quieres incorporar.', 400);
  }
  // Stable group anchors serialize contact checks with other reconciliation
  // operations. Lock before patient, matching the clinic -> patient convention.
  const clinicIds = await groupClinicIds(db, clinicId, transaction);
  for (const id of clinicIds) await db.Clinica.findByPk(id, { attributes: ['id_clinica'], transaction, lock: transaction.LOCK.UPDATE });
  const patientRow = await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!patientRow || Number(patientRow.clinica_id) !== Number(authorizedPrimaryClinicId)) {
    throw fail('privacy_profile_changed', 'La clínica de la ficha ha cambiado. Vuelve a revisar los datos.');
  }
  await privacy.patientForPrivacyClinic({ db, identifier: patientId, clinicId, transaction, lock: true });
  if (authorizeCurrent) await authorizeCurrent(Number(patientRow.clinica_id));
  const patient = plain(patientRow), current = await view({ db, patientId, clinicId, transaction });
  if (!current.available || Number(payload.document_id) !== current.document.id
    || payload.snapshot_hash !== current.document.snapshot_hash || payload.patient_version !== current.patient_version) {
    throw fail('privacy_profile_changed', 'La ficha o el documento han cambiado. Vuelve a revisar los datos.');
  }
  // A concurrent revocation/countersignature cannot invalidate or change the
  // exact source receipt between the comparison and the audited patient write.
  const source = plain(await db.PatientConsentDocument.findByPk(current.document.id, { transaction, lock: transaction.LOCK.SHARE }));
  if (!source || source.status !== 'signed' || source.revoked_at || source.snapshot_hash !== current.document.snapshot_hash) {
    throw fail('privacy_profile_changed', 'El documento ha cambiado. Vuelve a revisar los datos.');
  }
  const selected = payload.fields.map(key => current.fields.find(field => field.key === key));
  if (selected.some(field => !field)) throw fail('privacy_profile_changed', 'Los datos seleccionados ya no están disponibles. Vuelve a revisarlos.');
  if (selected.some(field => field.contact) && payload.acknowledge_contact_changes !== true) {
    throw fail('privacy_profile_contact_acknowledgement_required', 'Confirma expresamente la revisión de los datos de contacto.', 400);
  }
  const patch = Object.fromEntries(selected.map(field => [field.key, field.key.startsWith('telefono_')
    ? normalizePhoneDigits(field.proposed) : field.key === 'email' ? field.proposed.toLowerCase() : field.proposed]));
  if (Object.entries(patch).some(([, value]) => !value)) throw fail('privacy_profile_payload_invalid', 'No se pueden borrar datos desde este documento.', 400);
  await checkContactCollisions({ db, patient, patch, clinicIds, transaction,
    allowExistingPatientChat: payload.acknowledge_contact_changes === true });
  if (patch.fecha_nacimiento) patch.edad = null;
  await patientRow.update(patch, { transaction });
  await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: clinicId, actor_user_id: actorId,
    event_type: 'patient.privacy_profile_applied', source: 'privacy_profile_review', channel: 'internal', metadata: {
      document_id: current.document.id, snapshot_hash: current.document.snapshot_hash,
      fields: selected.map(field => field.key), previous: Object.fromEntries(selected.map(field => [field.key, field.current])),
      applied: Object.fromEntries(selected.map(field => [field.key, patch[field.key]])),
    } }, { transaction });
  // This is a durable handoff to the separately owned verification automation,
  // NOT a WhatsApp send or a grant of messaging/marketing permission.
  if (patch.telefono_movil && !equivalent('telefono_movil', patient.telefono_movil, patch.telefono_movil)) {
    await require('./patientMobileVerification.service').recordRequest({ db, patient_id: patientId, clinic_id: clinicId, actor_user_id: actorId,
      event_type: 'patient.mobile_verification_requested', source: 'privacy_profile_review', channel: 'internal', metadata: {
        schema_version: 'patient-mobile-verification/v1', document_id: current.document.id,
        snapshot_hash: current.document.snapshot_hash, previous_phone: currentValue(patient, 'telefono_movil'),
        phone: patch.telefono_movil, state: 'pending', delivery_enabled: false,
      } }, { transaction });
  }
  return { applied: true, fields: selected.map(field => field.key), review: await view({ db, patientId, clinicId, transaction }) };
}

const identityDocument = document => {
  const doc = plain(document);
  return doc?.purpose === 'data_protection' && identity.isIdentityDocument(doc);
};

// Acquire all clinic anchors before all patients before package/document locks.
// Package signing calls this once for the complete selected set, preventing an
// identity batch from acquiring another patient's anchor after a document lock.
async function lockAutofillAnchors({ db, documents, transaction }) {
  const relevant = documents.map(plain).filter(identityDocument);
  const clinicIds = new Set();
  for (const clinicId of [...new Set(relevant.map(doc => Number(doc.clinica_id)))].sort((a, b) => a - b)) {
    for (const id of await groupClinicIds(db, clinicId, transaction)) clinicIds.add(id);
  }
  for (const clinicId of [...clinicIds].sort((a, b) => a - b)) {
    await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica'], transaction, lock: transaction.LOCK.UPDATE });
  }
  for (const patientId of [...new Set(relevant.map(doc => Number(doc.paciente_id)))].sort((a, b) => a - b)) {
    await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE });
  }
}

function emptyCandidates(review) {
  return review?.available ? review.fields.filter(field => !text(field.current) && text(field.proposed)) : [];
}

async function autofillEmptyFromDocument({ db, documentId, actorId = null, transaction, anchorsLocked = false }) {
  if (!transaction) return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, tx =>
    autofillEmptyFromDocument({ db, documentId, actorId, transaction: tx }));
  const initial = plain(await db.PatientConsentDocument.findByPk(documentId, { transaction }));
  if (!identityDocument(initial) || initial.status !== 'signed' || initial.revoked_at
    || initial.snapshot_json?.patient_identity?.confirmed !== true) return { applied: false, fields: [], skipped_fields: [] };
  if (!anchorsLocked) await lockAutofillAnchors({ db, documents: [initial], transaction });
  const patientRow = await db.Paciente.findByPk(initial.paciente_id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!patientRow) throw fail('patient_not_found', 'No se encuentra el paciente.', 404);
  await privacy.patientForPrivacyClinic({ db, identifier: initial.paciente_id, clinicId: initial.clinica_id, transaction, lock: true });
  const review = await view({ db, patientId: initial.paciente_id, clinicId: initial.clinica_id, transaction });
  if (!review.available || review.document.id !== Number(documentId) || review.document.snapshot_hash !== initial.snapshot_hash) {
    return { applied: false, fields: [], skipped_fields: [] };
  }
  const source = plain(await db.PatientConsentDocument.findByPk(documentId, { transaction, lock: transaction.LOCK.SHARE }));
  if (!source || source.status !== 'signed' || source.revoked_at || source.snapshot_hash !== initial.snapshot_hash) {
    throw fail('privacy_profile_changed', 'El documento ha cambiado. Vuelve a revisar los datos.');
  }
  const candidates = emptyCandidates(review), patient = plain(patientRow), patch = {}, skipped = [];
  const clinicIds = await groupClinicIds(db, initial.clinica_id, transaction);
  for (const field of candidates) {
    const value = field.key.startsWith('telefono_') ? normalizePhoneDigits(field.proposed)
      : field.key === 'email' ? field.proposed.toLowerCase() : field.proposed;
    if (!value) continue;
    if (field.contact) {
      try { await checkContactCollisions({ db, patient, patch: { [field.key]: value }, clinicIds, transaction }); }
      catch (error) {
        if (!['privacy_profile_contact_collision', 'privacy_profile_phone_chat_collision', 'privacy_profile_phone_chat_review_required'].includes(error.code)) throw error;
        skipped.push({ key: field.key, reason: error.code });
        continue;
      }
    }
    patch[field.key] = value;
  }
  const fields = Object.keys(patch);
  if (!fields.length) return { applied: false, fields: [], skipped_fields: skipped };
  if (patch.fecha_nacimiento) patch.edad = null;
  await patientRow.update(patch, { transaction });
  await db.PatientOperationalEvent.create({ patient_id: initial.paciente_id, clinic_id: initial.clinica_id, actor_user_id: actorId,
    event_type: 'patient.privacy_profile_autofilled', source: 'signed_privacy_document', channel: 'internal', metadata: {
      schema_version: 'patient-privacy-autofill/v1', document_id: Number(documentId), snapshot_hash: source.snapshot_hash,
      fields, previous: Object.fromEntries(fields.map(key => [key, currentValue(patient, key)])),
      applied: Object.fromEntries(fields.map(key => [key, patch[key]])), skipped_fields: skipped,
    } }, { transaction });
  return { applied: true, fields, skipped_fields: skipped };
}

module.exports = { view, apply, patientVersion, checkContactCollisions, emptyCandidates,
  lockAutofillAnchors, autofillEmptyFromDocument, groupClinicIds };
