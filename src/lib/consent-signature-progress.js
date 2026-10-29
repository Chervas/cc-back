'use strict';

const plain = row => row?.toJSON ? row.toJSON() : row || {};
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const past = (value, now) => !!value && Number.isFinite(new Date(value).getTime()) && new Date(value) <= now;
function requiresProfessional(document) {
  const frozen = object(plain(document).snapshot_json).template;
  // A document is already issued. Missing frozen policy is the legacy
  // patient/representative-only contract, never a reason to inherit today's
  // mutable template flag. Both current issuers freeze an explicit boolean.
  return frozen?.requires_professional_signature === true;
}
function signatureProgress(document, template = {}, now = new Date()) {
  const doc = plain(document), needsProfessional = requiresProfessional(doc);
  const expired = !!doc.expires_at && (!Number.isFinite(new Date(doc.expires_at).getTime()) || new Date(doc.expires_at) <= now);
  const closed = !!doc.revoked_at || ['rejected', 'revoked', 'expired', 'cancelled', 'superseded', 'voided'].includes(doc.status) || expired;
  const patientSigned = doc.status === 'signed' && past(doc.signed_at, now) && !closed;
  const professionalSigned = positive(doc.professional_signed_by) && past(doc.professional_signed_at, now) && !closed;
  const complete = patientSigned && (!needsProfessional || professionalSigned);
  const pendingParty = closed || complete || doc.status === 'completed' ? null
    : patientSigned && needsProfessional ? 'professional' : 'patient';
  return { requires_professional_signature: needsProfessional, patient_signed: patientSigned,
    professional_signed: professionalSigned, complete, pending_party: pendingParty,
    label: closed ? (doc.revoked_at || doc.status === 'revoked' ? 'Revocado' : expired || doc.status === 'expired' ? 'Caducado' : 'Documento cerrado')
      : complete ? 'Firmado' : pendingParty === 'professional' ? 'Paciente ha firmado, falta profesional'
        : doc.status === 'completed' ? 'Completado sin firma' : 'Pendiente de firma del paciente' };
}
function isCurrentSignedDocument(document, template = {}, now = new Date()) {
  return signatureProgress(document, template, now).complete;
}
module.exports = { signatureProgress, isCurrentSignedDocument, requiresProfessional };
