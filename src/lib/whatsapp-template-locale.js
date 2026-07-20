'use strict';

const SUPPORTED_PATIENT_LANGUAGES = Object.freeze(['es', 'ca', 'en']);
const SUPPORTED_PATIENT_LANGUAGE_SET = new Set(SUPPORTED_PATIENT_LANGUAGES);

function normalizeWhatsappLocale(value, { fallback = null } = {}) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .split('-')[0];
  if (SUPPORTED_PATIENT_LANGUAGE_SET.has(normalized)) return normalized;
  return fallback;
}

function requireWhatsappLocale(value) {
  const locale = normalizeWhatsappLocale(value);
  if (locale) return locale;
  const error = new Error('whatsapp_template_locale_invalid');
  error.code = 'whatsapp_template_locale_invalid';
  error.statusCode = 400;
  throw error;
}

function resolveCatalogLocale(catalog, fallback = 'es') {
  return normalizeWhatsappLocale(catalog?.locale, { fallback }) || fallback;
}

function resolveMetaTemplateLanguage(locale) {
  const normalized = normalizeWhatsappLocale(locale, { fallback: 'es' });
  if (normalized === 'en') return 'en_US';
  if (normalized === 'ca') return 'ca';
  // Conserva el código histórico aprobado de las plantillas españolas.
  return 'es';
}

function resolveCatalogFamilyKey(catalog) {
  return String(catalog?.family_key || catalog?.name || '').trim() || null;
}

function resolvePatientPreferredLanguageCandidate(context = {}) {
  const candidates = [
    context?.patient?.preferred_language,
    context?.patient?.idioma_preferido,
    context?.paciente?.preferred_language,
    context?.paciente?.idioma_preferido,
    context?.trigger?.data?.preferred_language,
    context?.trigger?.data?.idioma_preferido,
  ];
  for (const candidate of candidates) {
    const locale = normalizeWhatsappLocale(candidate);
    if (locale) return locale;
  }
  return null;
}

function resolvePatientPreferredLanguage(context = {}) {
  const locale = resolvePatientPreferredLanguageCandidate(context);
  if (locale) return locale;
  // Contrato de pacientes: los registros históricos y los nuevos tienen
  // español como valor por defecto. No se infiere el idioma por el texto.
  return 'es';
}

function captureExecutionCommunicationLanguage(context = {}) {
  return resolvePatientPreferredLanguage(context);
}

function resolveExecutionCommunicationLanguage(context = {}) {
  // Cada nuevo mensaje parte del paciente enriquecido justo antes de resolver
  // plantilla. Los reintentos del mismo Message conservan su selección durable
  // en metadata, así que esto no duplica ni cambia mensajes ya materializados.
  const patientLanguage = resolvePatientPreferredLanguageCandidate({
    patient: context?.patient,
    paciente: context?.paciente,
  });
  if (patientLanguage) return patientLanguage;
  return normalizeWhatsappLocale(context?.communication_language, { fallback: 'es' }) || 'es';
}

function stampExecutionCommunicationLanguage(context = {}) {
  return {
    ...(context && typeof context === 'object' && !Array.isArray(context) ? context : {}),
    communication_language: captureExecutionCommunicationLanguage(context),
  };
}

module.exports = {
  SUPPORTED_PATIENT_LANGUAGES,
  normalizeWhatsappLocale,
  requireWhatsappLocale,
  resolveCatalogLocale,
  resolveMetaTemplateLanguage,
  resolveCatalogFamilyKey,
  resolvePatientPreferredLanguage,
  captureExecutionCommunicationLanguage,
  resolveExecutionCommunicationLanguage,
  stampExecutionCommunicationLanguage,
};
