'use strict';

// Canonical, manually maintained patient profile fields. These are deliberately
// not PatientCustomFields: that table is also a source of marketing variables.
// Unknown values stay NULL; imported archives never fill these fields implicitly.
const PATIENT_PROFILE_FIELD_SPECS = Object.freeze({
  notas_medicas: Object.freeze({ kind: 'text', maxLength: 16000 }),
  direccion: Object.freeze({ kind: 'text', maxLength: 2000 }),
  codigo_postal: Object.freeze({ kind: 'string', maxLength: 32 }),
  poblacion: Object.freeze({ kind: 'string', maxLength: 255 }),
  provincia: Object.freeze({ kind: 'string', maxLength: 255 }),
  pais: Object.freeze({ kind: 'string', maxLength: 255 }),
  pais_origen: Object.freeze({ kind: 'string', maxLength: 255 }),
  estudios: Object.freeze({ kind: 'string', maxLength: 255 }),
  tiene_hijos: Object.freeze({ kind: 'boolean' }),
});
const PATIENT_PROFILE_FIELD_NAMES = Object.freeze(Object.keys(PATIENT_PROFILE_FIELD_SPECS));

function invalidField(field, reason) {
  const error = new Error('invalid_patient_profile_field');
  error.status = 400;
  // Never include the submitted value in the error response or logs.
  error.details = { field, reason };
  return error;
}

function validatePatientProfileFields(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidField('profile', 'object_required');
  }
  const values = {};
  for (const field of PATIENT_PROFILE_FIELD_NAMES) {
    if (!Object.hasOwn(body, field) || body[field] === undefined) continue;
    const value = body[field];
    const spec = PATIENT_PROFILE_FIELD_SPECS[field];
    if (value === null) {
      values[field] = null;
      continue;
    }
    if (spec.kind === 'boolean') {
      if (typeof value !== 'boolean') throw invalidField(field, 'boolean_or_null_required');
    } else {
      if (typeof value !== 'string') throw invalidField(field, 'string_or_null_required');
      // Count Unicode code points, matching VARCHAR character limits rather
      // than UTF-16 units. TEXT also stays below its UTF-8 byte limit.
      if (Array.from(value).length > spec.maxLength || Buffer.byteLength(value, 'utf8') > 65535) {
        throw invalidField(field, 'maximum_length_exceeded');
      }
      if (value.includes('\u0000')) throw invalidField(field, 'null_character_not_allowed');
    }
    // Do not trim/reclassify medical text or invent defaults for empty fields.
    values[field] = value;
  }
  return values;
}

function patientProfileAttributes(DataTypes) {
  return Object.fromEntries(PATIENT_PROFILE_FIELD_NAMES.map(field => {
    const spec = PATIENT_PROFILE_FIELD_SPECS[field];
    const type = spec.kind === 'boolean' ? DataTypes.BOOLEAN
      : spec.kind === 'text' ? DataTypes.TEXT : DataTypes.STRING(spec.maxLength);
    return [field, { type, allowNull: true }];
  }));
}

module.exports = {
  PATIENT_PROFILE_FIELD_SPECS,
  PATIENT_PROFILE_FIELD_NAMES,
  validatePatientProfileFields,
  patientProfileAttributes,
};
