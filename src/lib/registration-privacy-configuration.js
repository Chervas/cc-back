'use strict';
const { createHash } = require('node:crypto');
const BS_KEY = 'bs-final-20261015-e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f';
const object = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const fail = code => Object.assign(new Error(code), { code, status: 400, statusCode: 400 });
const fields = ['legal_name', 'tax_id', 'address', 'email', 'phone', 'dpo_name', 'dpo_email'];
function policy(clinic) {
  const settings = object(object(clinic?.configuracion).patient_intake), explicit = Object.hasOwn(settings, 'privacy_enabled');
  const legacy = !explicit && [66, 72].includes(Number(clinic?.id_clinica));
  return { enabled: settings.privacy_enabled === true || legacy,
    beforeFirstCare: settings.privacy_before_first_care === true || legacy,
    templateId: positive(settings.privacy_template_id), legacy, catalogKey: legacy ? BS_KEY : null,
    medicalQuestionnaireEnabled: settings.medical_questionnaire_enabled !== false };
}
function controller(clinic) {
  const fiscal = object(clinic?.datos_fiscales_clinica), custom = object(object(clinic?.configuracion).patient_intake).privacy_controller || {};
  return { legal_name: String(custom.legal_name || fiscal.denominacion_social || fiscal.razon_social || fiscal.razonSocial || fiscal.nombre_fiscal || '').trim(),
    tax_id: String(custom.tax_id || fiscal.cif_nif || fiscal.cif || fiscal.nif || fiscal.documento || '').trim(),
    address: String(custom.address || fiscal.direccion || clinic?.direccion || '').trim(),
    email: String(custom.email || clinic?.email || '').trim(), phone: String(custom.phone || clinic?.telefono || clinic?.telefono_movil || '').trim(),
    dpo_name: String(custom.dpo_name || '').trim(), dpo_email: String(custom.dpo_email || '').trim() };
}
function normalize(clinic) {
  const configured = object(object(clinic?.configuracion).patient_intake), resolved = policy(clinic);
  return { privacy_enabled: resolved.enabled, privacy_template_id: resolved.templateId,
    privacy_before_first_care: resolved.beforeFirstCare, medical_questionnaire_enabled: resolved.medicalQuestionnaireEnabled,
    additional_documents: [], ...configured, privacy_controller: controller(clinic) };
}
function assertLegalControllerForIssue(clinic) {
  const responsible = controller(clinic);
  if (['legal_name', 'tax_id', 'address', 'email'].some(key => !responsible[key])) {
    throw Object.assign(new Error('Completa los datos legales del responsable en Documentos y formularios antes de emitir la protección de datos.'), {
      code: 'patient_intake_legal_controller_incomplete', statusCode: 409,
      details: { action: 'configure_patient_intake' },
    });
  }
  return responsible;
}
function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('patient_intake_settings_invalid');
  const allowed = ['privacy_enabled', 'privacy_template_id', 'privacy_before_first_care', 'medical_questionnaire_enabled', 'privacy_controller', 'additional_documents'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw fail('patient_intake_settings_unknown_field');
  for (const key of allowed.filter(key => key.endsWith('_enabled') || key === 'privacy_before_first_care')) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') throw fail('patient_intake_settings_invalid');
  }
  if (Object.hasOwn(raw, 'privacy_template_id') && raw.privacy_template_id !== null && !positive(raw.privacy_template_id)) throw fail('patient_intake_template_invalid');
  if (Object.hasOwn(raw, 'additional_documents')) {
    const rows = raw.additional_documents;
    if (!Array.isArray(rows) || rows.length > 20 || new Set(rows.map(row => row?.template_id)).size !== rows.length
      || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).length !== 3 || Object.keys(row).some(key => !['template_id', 'required', 'sort_order'].includes(key))
        || !positive(row.template_id) || typeof row.required !== 'boolean'
        || !Number.isSafeInteger(row.sort_order) || row.sort_order < 0 || row.sort_order > 1000)) throw fail('patient_intake_additional_documents_invalid');
  }
  if (Object.hasOwn(raw, 'privacy_controller')) {
    const source = raw.privacy_controller;
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !fields.includes(key))) throw fail('patient_intake_controller_invalid');
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string' || value.length > (key === 'address' ? 2000 : 255) || /[\u0000-\u001f]/.test(value)) throw fail('patient_intake_controller_invalid');
      if (key.endsWith('email') && value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw fail('patient_intake_controller_invalid');
    }
  }
  return raw;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const version = clinic => createHash('sha256').update(JSON.stringify(canonical(normalize(clinic)))).digest('hex');
module.exports = { BS_KEY, object, policy, controller, normalize, validate, version, assertLegalControllerForIssue };
