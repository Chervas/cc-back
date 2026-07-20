'use strict';

const DEFAULT_PATIENT_LANGUAGE = 'es';
const SUPPORTED_PATIENT_LANGUAGES = Object.freeze(['es', 'ca', 'en']);
const PATIENT_LANGUAGE_LABELS = Object.freeze({
  es: 'Español',
  ca: 'Catalán',
  en: 'Inglés',
});

const normalizePatientLanguage = (value, { optional = false } = {}) => {
  if (value === undefined && optional) return undefined;

  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SUPPORTED_PATIENT_LANGUAGES.includes(normalized)) {
    const error = new Error('unsupported_patient_language');
    error.status = 400;
    error.details = { allowed: SUPPORTED_PATIENT_LANGUAGES };
    throw error;
  }
  return normalized;
};

const languageForNewPatient = (value) => (
  value === undefined
    ? DEFAULT_PATIENT_LANGUAGE
    : normalizePatientLanguage(value)
);

const preferredLanguagePayload = (language) => {
  const normalized = SUPPORTED_PATIENT_LANGUAGES.includes(String(language || '').toLowerCase())
    ? String(language).toLowerCase()
    : DEFAULT_PATIENT_LANGUAGE;
  return {
    idioma_preferido: normalized,
    idioma_preferido_label: PATIENT_LANGUAGE_LABELS[normalized],
  };
};

async function applyExplicitPatientLanguage(patient, requestedLanguage, { transaction } = {}) {
  if (!patient || requestedLanguage === undefined) return false;
  const normalized = normalizePatientLanguage(requestedLanguage);
  const current = preferredLanguagePayload(patient.idioma_preferido).idioma_preferido;
  if (current === normalized) return false;

  if (typeof patient.update === 'function') {
    await patient.update(
      { idioma_preferido: normalized },
      transaction ? { transaction } : undefined,
    );
  } else {
    patient.idioma_preferido = normalized;
    if (typeof patient.save === 'function') {
      await patient.save({
        fields: ['idioma_preferido'],
        ...(transaction ? { transaction } : {}),
      });
    }
  }
  patient.idioma_preferido = normalized;
  return true;
}

async function createAppointmentWithPatientLanguage({
  sequelize,
  AppointmentModel,
  appointmentValues,
  patient,
  requestedLanguage,
}) {
  if (!sequelize?.transaction || !AppointmentModel?.create) {
    throw new Error('appointment_language_transaction_dependencies_missing');
  }

  return sequelize.transaction(async (transaction) => {
    const appointment = await AppointmentModel.create(
      appointmentValues,
      { transaction },
    );
    await applyExplicitPatientLanguage(
      patient,
      requestedLanguage,
      { transaction },
    );
    return appointment;
  });
}

module.exports = {
  DEFAULT_PATIENT_LANGUAGE,
  SUPPORTED_PATIENT_LANGUAGES,
  PATIENT_LANGUAGE_LABELS,
  normalizePatientLanguage,
  languageForNewPatient,
  preferredLanguagePayload,
  applyExplicitPatientLanguage,
  createAppointmentWithPatientLanguage,
};
