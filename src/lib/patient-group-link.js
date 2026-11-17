'use strict';

const { normalizePhoneDigits } = require('./phone');

const GROUP_LINK_FEATURE = 'patients.group.link';
const positive = value => ['number', 'string'].includes(typeof value)
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const email = value => String(value || '').trim().toLowerCase();
const plain = value => typeof value?.toJSON === 'function' ? value.toJSON() : value || {};

function samePositivePatientGroup(source, target) {
  const origin = plain(source), destination = plain(target);
  const group = positive(origin.grupoClinicaId);
  return !!group && group === positive(destination.grupoClinicaId);
}

function matchingPatientGroupContact(patient, contact = {}) {
  const row = plain(patient), phone = normalizePhoneDigits(contact?.telefono), address = email(contact?.email);
  return {
    phone: phone && phone === normalizePhoneDigits(row.telefono_movil) ? phone : null,
    email: address && address === email(row.email) ? address : null,
  };
}

function hasMatchingPatientGroupContact(patient, contact) {
  const matched = matchingPatientGroupContact(patient, contact);
  return !!(matched.phone || matched.email);
}

function groupLinkCandidate({ patient, sourceClinic, targetClinic, contact, permitted, alreadyLinked = false }) {
  const row = plain(patient), source = plain(sourceClinic), target = plain(targetClinic);
  if (permitted !== true || alreadyLinked || !positive(row.id_paciente)
    || !positive(source.id_clinica) || !positive(target.id_clinica)
    || positive(source.id_clinica) !== positive(row.clinica_id)
    || positive(source.id_clinica) === positive(target.id_clinica)
    || !samePositivePatientGroup(source, target) || !hasMatchingPatientGroupContact(row, contact)) return null;
  return {
    id_paciente: positive(row.id_paciente),
    ...(row.public_id ? { public_id: String(row.public_id) } : {}),
    nombre: String(row.nombre || ''), apellidos: String(row.apellidos || ''),
    ...(row.numero_historia != null ? { numero_historia: String(row.numero_historia) } : {}),
    clinica_id: positive(source.id_clinica), clinicaNombre: String(source.nombre_clinica || ''),
  };
}

function basicLinkedPatient(patient, clinicId, contact = {}) {
  const row = plain(patient), matched = matchingPatientGroupContact(row, contact);
  return {
    id_paciente: positive(row.id_paciente),
    ...(row.public_id ? { public_id: String(row.public_id) } : {}),
    nombre: String(row.nombre || ''), apellidos: String(row.apellidos || ''),
    ...(row.numero_historia != null ? { numero_historia: String(row.numero_historia) } : {}),
    clinica_id: positive(clinicId),
    ...(matched.phone ? { telefono_movil: matched.phone } : {}),
    ...(matched.email ? { email: matched.email } : {}),
  };
}

module.exports = { GROUP_LINK_FEATURE, samePositivePatientGroup, matchingPatientGroupContact,
  hasMatchingPatientGroupContact, groupLinkCandidate, basicLinkedPatient };
