'use strict';

const {
  ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH,
  normalizeAccessGuidance,
} = require('./clinic-configuration');

const FIRST_VISIT_APPOINTMENT_TYPES = Object.freeze([
  'primera_sin_trat',
  'primera_con_trat',
]);
const FIRST_VISIT_APPOINTMENT_TYPE_SET = new Set(FIRST_VISIT_APPOINTMENT_TYPES);
const AUTOMATION_WHATSAPP_MAX_ATTEMPTS = 5;
const AUTOMATION_WHATSAPP_RETRY_DELAY_MS = 60 * 1000;

function cleanText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isHttpsUrl(value) {
  try {
    return new URL(cleanText(value)).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeTemplateComponents(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const components = plain.components;
  if (Array.isArray(components)) return components;
  if (typeof components !== 'string') return [];
  try {
    const parsed = JSON.parse(components);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function templateHasImageHeader(template) {
  return normalizeTemplateComponents(template).some((component) => (
    cleanText(component?.type).toUpperCase() === 'HEADER'
    && cleanText(component?.format).toUpperCase() === 'IMAGE'
  ));
}

function isAccessGuidanceReminderBranchEnabled({ appointmentType, accessGuidance } = {}) {
  const normalizedAppointmentType = cleanText(appointmentType).toLowerCase();
  const normalizedAccessGuidance = normalizeAccessGuidance(accessGuidance);
  return FIRST_VISIT_APPOINTMENT_TYPE_SET.has(normalizedAppointmentType)
    && normalizedAccessGuidance.enabled;
}

function evaluateAccessGuidanceVariantEligibility({
  appointmentType,
  accessGuidance,
  variantConfigured = false,
} = {}) {
  const normalizedAppointmentType = cleanText(appointmentType).toLowerCase();
  const normalizedAccessGuidance = normalizeAccessGuidance(accessGuidance);
  const isFirstVisit = FIRST_VISIT_APPOINTMENT_TYPE_SET.has(normalizedAppointmentType);

  if (!isFirstVisit) {
    return {
      eligible: false,
      is_first_visit: false,
      fallback_used: false,
      reason: 'appointment_not_first_visit',
      access_guidance: normalizedAccessGuidance,
    };
  }
  if (!normalizedAccessGuidance.enabled) {
    return {
      eligible: false,
      is_first_visit: true,
      fallback_used: false,
      reason: 'access_guidance_disabled',
      access_guidance: normalizedAccessGuidance,
    };
  }

  let reason = null;
  if (!normalizedAccessGuidance.directions) reason = 'access_guidance_directions_missing';
  else if (normalizedAccessGuidance.directions.length > ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH) {
    reason = 'access_guidance_directions_too_long';
  } else if (!normalizedAccessGuidance.image_asset_id) reason = 'access_guidance_image_asset_missing';
  else if (!normalizedAccessGuidance.image_url) reason = 'access_guidance_image_url_missing';
  else if (!isHttpsUrl(normalizedAccessGuidance.image_url)) reason = 'access_guidance_image_url_invalid';
  else if (!variantConfigured) reason = 'access_guidance_variant_not_configured';

  return {
    eligible: !reason,
    is_first_visit: true,
    fallback_used: !!reason,
    reason,
    access_guidance: normalizedAccessGuidance,
  };
}

function selectAccessGuidanceTemplateBranch({
  appointmentType,
  accessGuidance,
  variantConfigured = false,
  variantTemplate = null,
  targetWabaId = '',
  lookupError = null,
} = {}) {
  const eligibility = evaluateAccessGuidanceVariantEligibility({
    appointmentType,
    accessGuidance,
    variantConfigured,
  });

  const baseDecision = {
    branch: 'base',
    variant_requested: eligibility.is_first_visit && eligibility.access_guidance.enabled,
    variant_used: false,
    fallback_used: eligibility.fallback_used,
    fallback_reason: eligibility.reason,
    access_guidance: eligibility.access_guidance,
  };
  if (!eligibility.eligible) return baseDecision;

  if (lookupError) {
    return {
      ...baseDecision,
      fallback_used: true,
      fallback_reason: 'access_guidance_variant_lookup_failed',
    };
  }
  if (!variantTemplate) {
    return {
      ...baseDecision,
      fallback_used: true,
      fallback_reason: 'access_guidance_variant_unavailable',
    };
  }

  const plain = variantTemplate?.get
    ? variantTemplate.get({ plain: true })
    : variantTemplate;
  const status = cleanText(plain?.status).toUpperCase() || 'UNKNOWN';
  if (status !== 'APPROVED') {
    return {
      ...baseDecision,
      fallback_used: true,
      fallback_reason: `access_guidance_variant_${status.toLowerCase()}`,
      variant_status: status,
    };
  }

  const expectedWabaId = cleanText(targetWabaId);
  const templateWabaId = cleanText(plain?.waba_id || plain?.wabaId);
  if (!expectedWabaId) {
    return {
      ...baseDecision,
      fallback_used: true,
      fallback_reason: 'access_guidance_target_waba_unverified',
      variant_status: status,
    };
  }
  if (templateWabaId !== expectedWabaId) {
    return {
      ...baseDecision,
      fallback_used: true,
      fallback_reason: templateWabaId
        ? 'access_guidance_variant_waba_mismatch'
        : 'access_guidance_variant_waba_unverified',
      variant_status: status,
    };
  }
  if (!templateHasImageHeader(plain)) {
    return {
      ...baseDecision,
      fallback_used: true,
      fallback_reason: 'access_guidance_variant_image_header_missing',
      variant_status: status,
    };
  }

  return {
    branch: 'access_guidance',
    variant_requested: true,
    variant_used: true,
    fallback_used: false,
    fallback_reason: null,
    variant_status: status,
    access_guidance: eligibility.access_guidance,
  };
}

function buildAccessGuidanceTemplateComponents({ templateParams, imageUrl } = {}) {
  if (!isHttpsUrl(imageUrl)) {
    throw new Error('access_guidance_image_url_invalid');
  }

  const bodyParameters = Object.keys(templateParams || {})
    .filter((key) => /^\d+$/.test(String(key)))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => ({ type: 'text', text: String(templateParams[key] ?? '') }));

  return [
    {
      type: 'header',
      parameters: [{ type: 'image', image: { link: cleanText(imageUrl) } }],
    },
    {
      type: 'body',
      parameters: bodyParameters,
    },
  ];
}

function buildAutomationWhatsappTransportJobOptions(messageId) {
  const parsedMessageId = Number.parseInt(String(messageId), 10);
  if (!Number.isInteger(parsedMessageId) || parsedMessageId <= 0) {
    throw new Error('automation_whatsapp_message_id_invalid');
  }
  return {
    jobId: `automation-whatsapp-${parsedMessageId}`,
    attempts: AUTOMATION_WHATSAPP_MAX_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: AUTOMATION_WHATSAPP_RETRY_DELAY_MS,
    },
    // La auditoria durable vive en Messages/FlowExecution. Redis conserva una
    // ventana operativa acotada para no retener cuerpo, telefono e imagen de
    // forma indefinida.
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
  };
}

module.exports = {
  AUTOMATION_WHATSAPP_MAX_ATTEMPTS,
  AUTOMATION_WHATSAPP_RETRY_DELAY_MS,
  FIRST_VISIT_APPOINTMENT_TYPES,
  buildAccessGuidanceTemplateComponents,
  buildAutomationWhatsappTransportJobOptions,
  evaluateAccessGuidanceVariantEligibility,
  isAccessGuidanceReminderBranchEnabled,
  isHttpsUrl,
  selectAccessGuidanceTemplateBranch,
  templateHasImageHeader,
};
