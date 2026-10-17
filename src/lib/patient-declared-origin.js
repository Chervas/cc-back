'use strict';
const CODES = Object.freeze(['social_media', 'search_engines', 'press_radio_tv', 'family_friend', 'professional_referral', 'clinic_signage', 'none']);
function validatePatientDeclaredOrigin(body = {}) {
  if (!Object.hasOwn(body, 'como_nos_conocio_codigo')) return {};
  const value = body.como_nos_conocio_codigo;
  if (value !== null && !CODES.includes(value)) throw Object.assign(new Error('invalid_patient_declared_origin'), { code: 'invalid_patient_declared_origin', status: 400 });
  return { como_nos_conocio_codigo: value };
}
module.exports = { CODES, validatePatientDeclaredOrigin };
