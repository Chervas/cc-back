'use strict';

const db = require('../../models');
const {
  maybeUploadGoogleConversion,
  normalizeGoogleConsent,
} = require('./googleAdsConversionUpload.service');

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function groupConfigCoversClinic(configRecord, clinicId) {
  const normalizedClinicId = positiveInt(clinicId);
  if (!normalizedClinicId) return false;
  const locations = Array.isArray(configRecord?.config?.locations)
    ? configRecord.config.locations
    : [];
  return locations.some((location) => (
    positiveInt(location?.id ?? location?.clinic_id) === normalizedClinicId
  ));
}

async function resolveLeadIntakeConfig({ lead, clinicId, dependencies = {} }) {
  const IntakeConfig = dependencies.IntakeConfig || db.IntakeConfig;
  const Clinica = dependencies.Clinica || db.Clinica;
  const normalizedClinicId = positiveInt(clinicId ?? lead?.clinica_id);
  let groupId = positiveInt(lead?.grupo_clinica_id);

  if (!groupId && normalizedClinicId && Clinica) {
    const clinic = await Clinica.findOne({
      where: { id_clinica: normalizedClinicId },
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    groupId = positiveInt(clinic?.grupoClinicaId);
  }

  let groupConfig = null;
  if (groupId) {
    groupConfig = await IntakeConfig.findOne({
      where: { group_id: groupId, assignment_scope: 'group' },
      raw: true,
    });
  }
  let clinicConfig = null;
  if (normalizedClinicId) {
    clinicConfig = await IntakeConfig.findOne({
      where: { clinic_id: normalizedClinicId, assignment_scope: 'clinic' },
      raw: true,
    });
  }

  // Group web measurement is shared only with the clinics explicitly listed
  // in config.locations. Falling back to the group merely because the clinic
  // belongs to it can route a French/independent clinic's offline milestone to
  // another advertiser account.
  const config = groupConfigCoversClinic(groupConfig, normalizedClinicId)
    ? groupConfig
    : clinicConfig;

  return { config, clinicId: normalizedClinicId, groupId };
}

function buildLifecycleConversionPayload({ lead, eventName, eventId, value, currency = 'EUR', occurredAt = new Date() }) {
  const consent = lead?.consentimiento_canal && typeof lead.consentimiento_canal === 'object'
    ? lead.consentimiento_canal
    : null;
  return {
    eventName,
    eventId,
    customData: {
      gclid: clean(lead?.gclid),
      gbraid: clean(lead?.gbraid),
      wbraid: clean(lead?.wbraid),
      client_id: clean(lead?.ga_client_id),
      customer_id: clean(lead?.google_ads_customer_id),
      campaign_id: clean(lead?.google_ads_campaign_id),
      ...(value !== undefined && value !== null ? { value } : {}),
      currency,
      conversion_time: occurredAt,
      consent,
    },
    userData: {
      email: clean(lead?.email),
      phone: clean(lead?.telefono),
      name: clean(lead?.nombre),
    },
    consent,
  };
}

async function maybeUploadLeadLifecycleConversion({
  lead,
  eventName,
  eventId,
  clinicId = null,
  value,
  currency = 'EUR',
  occurredAt = new Date(),
  dependencies = {},
} = {}) {
  if (!lead || !eventName || !eventId) {
    return { sent: false, reason: 'lead_event_required' };
  }

  const resolved = await resolveLeadIntakeConfig({ lead, clinicId, dependencies });
  const configObject = resolved.config?.config && typeof resolved.config.config === 'object'
    ? resolved.config.config
    : {};
  const googleAdsConfig = configObject.google_ads || null;
  if (!resolved.config || !googleAdsConfig) {
    return { sent: false, reason: 'intake_google_config_missing' };
  }

  const payload = buildLifecycleConversionPayload({
    lead,
    eventName,
    eventId,
    value,
    currency,
    occurredAt,
  });
  const consentModeEnabled = configObject.features?.consent_mode_enabled === true;
  const consentStatus = normalizeGoogleConsent(payload.consent);
  const allowUpload = !consentModeEnabled || consentStatus === 'GRANTED';
  const upload = dependencies.maybeUploadGoogleConversion || maybeUploadGoogleConversion;

  return upload({
    cfgRecord: resolved.config,
    googleAdsConfig,
    ...payload,
    clinicId: resolved.clinicId,
    groupId: resolved.groupId,
    assignmentScope: resolved.config.assignment_scope === 'group' ? 'group' : 'clinic',
    allowUpload,
    consentModeEnabled,
  });
}

module.exports = {
  buildLifecycleConversionPayload,
  groupConfigCoversClinic,
  maybeUploadLeadLifecycleConversion,
  resolveLeadIntakeConfig,
};
