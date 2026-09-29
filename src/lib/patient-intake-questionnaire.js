'use strict';
// First, deliberately bounded questionnaire. This is NOT a diagnosis, a consent
// or a general-purpose form builder. Stable keys + immutable schema version.
const VERSION = 'bsmedical-patient-initial-v1';
const fields = [
  ['allergies', 'Alergias o sensibilidad cutánea', 'text'],
  ['medication', 'Medicación que toma actualmente', 'text'],
  ['conditions', 'Enfermedades, antecedentes o tratamientos actuales', 'text'],
  ['pregnancy', '¿Está embarazada?', 'choice'],
  ['breastfeeding', '¿Está en periodo de lactancia?', 'choice'],
  ['kidney_disease', '¿Tiene alguna enfermedad renal?', 'choice'],
  ['diabetes', '¿Tiene diabetes?', 'choice'],
  ['epilepsy', '¿Tiene epilepsia?', 'choice'],
  ['skin_conditions', 'Problemas de piel, cicatrices o tatuajes en la zona a tratar', 'text'],
  ['endocrine', 'Tratamientos endocrinos o problemas hormonales', 'text'],
  ['implants', '¿Lleva alguna prótesis metálica o marcapasos?', 'choice'],
  ['spine_hip', 'Problemas de columna o cadera', 'text'],
  ['recent_surgery', 'Operaciones en los últimos tres meses', 'text'],
  ['skin_products', 'Productos para la piel, exfoliantes, ácido glicólico o retinoico', 'text'],
  ['habits', 'Agua, alimentación y ejercicio habitual', 'text'],
  ['other', 'Algo más que quiera comentar al profesional', 'text'],
].map(([key, label, type]) => ({ key, label, type }));
const personalKeys = ['nombre', 'apellidos', 'dni', 'fecha_nacimiento', 'telefono_movil', 'email'];
function error(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, message, statusCode }); }
function personalSnapshot(patient) {
  return Object.fromEntries(personalKeys.map(key => [key, key === 'fecha_nacimiento'
    ? (patient[key] ? new Date(patient[key]).toISOString().slice(0, 10) : '') : String(patient[key] || '')]));
}
function validateSubmission(payload) {
  if (payload?.schema_version !== VERSION || payload?.reviewed_answers !== true) throw error('intake_confirmation_required', 'Revisa tus respuestas antes de continuar.');
  if (!Number.isSafeInteger(payload.expected_version) || payload.expected_version < 1) throw error('intake_version_required', 'Vuelve a abrir el formulario.');
  const answers = {}, personal = {};
  if (!payload.answers || Array.isArray(payload.answers) || typeof payload.answers !== 'object') throw error('intake_answers_invalid', 'Revisa las respuestas.');
  for (const f of fields) {
    const value = payload.answers[f.key] ?? '';
    if (typeof value !== 'string' || value.length > 2000 || (f.type === 'choice' && !['', 'yes', 'no', 'unknown', 'not_applicable'].includes(value))) {
      throw error('intake_answer_invalid', `Revisa: ${f.label}.`);
    }
    answers[f.key] = value.trim();
  }
  for (const key of personalKeys) {
    const value = payload.personal?.[key];
    if (typeof value !== 'string' || value.length > 255) throw error('intake_personal_invalid', 'Revisa tus datos personales.');
    personal[key] = value.trim();
  }
  if (!personal.nombre || !personal.apellidos) throw error('intake_name_required', 'Indica nombre y apellidos.');
  if (personal.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personal.email)) throw error('intake_email_invalid', 'Revisa el correo electrónico.');
  if (personal.fecha_nacimiento && (!/^\d{4}-\d{2}-\d{2}$/.test(personal.fecha_nacimiento) || !Number.isFinite(Date.parse(personal.fecha_nacimiento)) || new Date(personal.fecha_nacimiento).toISOString().slice(0, 10) !== personal.fecha_nacimiento || new Date(personal.fecha_nacimiento) > new Date())) throw error('intake_birthdate_invalid', 'Revisa la fecha de nacimiento.');
  return { answers, personal };
}
function suggestedSummary(answers = {}) {
  const choice = { yes: 'Sí', no: 'No', unknown: 'No lo sé', not_applicable: 'No corresponde' };
  return {
    alergias: answers.allergies || '', medicacion: answers.medication || '',
    antecedentes: fields.filter(f => !['allergies', 'medication'].includes(f.key) && answers[f.key])
      .map(f => `${f.label}: ${choice[answers[f.key]] || answers[f.key]}`).join('\n'),
  };
}
module.exports = { VERSION, fields, personalKeys, personalSnapshot, validateSubmission, suggestedSummary, error };
