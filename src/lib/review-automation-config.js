'use strict';

const REVIEW_AUTOMATION_TRIGGER = 'appointment_completed';
const REVIEW_AUTOMATION_ACTION = 'action/request_review';
const REVIEW_AUTOMATION_MANAGED_FEATURE = 'review_request';
const REVIEW_AUTOMATION_CONFIGURATION_VERSION = 1;

const REVIEW_DELAY_HOURS = Object.freeze({
  same_day: 0,
  '24h': 24,
  '48h': 48,
  '7d': 7 * 24,
});

const REVIEW_SOURCE_VALUES = new Set([
  'completed_treatment',
  'first_completed_appointment',
  'first_completed_or_completed_treatment',
]);

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function asPlainTemplate(template) {
  return template?.toJSON ? template.toJSON() : (template || {});
}

function getTemplateNodes(template) {
  const plain = asPlainTemplate(template);
  return Array.isArray(plain.nodes) ? plain.nodes : [];
}

function findNodeByType(template, nodeType) {
  const normalizedType = cleanString(nodeType).toLowerCase();
  return getTemplateNodes(template).find(
    (node) => cleanString(node?.type).toLowerCase() === normalizedType
  ) || null;
}

function normalizeReviewDelay(value, fallback = null) {
  const normalized = cleanString(value).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(REVIEW_DELAY_HOURS, normalized)) {
    return normalized;
  }

  const aliases = {
    now: 'same_day',
    today: 'same_day',
    '0h': 'same_day',
    '1d': '24h',
    '2d': '48h',
    '168h': '7d',
  };
  return aliases[normalized] || fallback;
}

function reviewDelayToHours(value, fallback = null) {
  const delay = normalizeReviewDelay(value, null);
  return delay === null ? fallback : REVIEW_DELAY_HOURS[delay];
}

function hoursToReviewDelay(value, fallback = null) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) return fallback;
  const match = Object.entries(REVIEW_DELAY_HOURS).find(([, candidate]) => candidate === hours);
  return match?.[0] || fallback;
}

function readFixedDelayHours(template) {
  const delayNode = findNodeByType(template, 'delay/fixed');
  const duration = Number(delayNode?.config?.duration);
  const unit = cleanString(delayNode?.config?.unit).toLowerCase();
  if (!Number.isFinite(duration) || duration < 0) return null;
  if (unit === 'minutes') return duration / 60;
  if (unit === 'days') return duration * 24;
  if (unit === 'hours') return duration;
  return null;
}

function inspectExplicitReviewAutomation(template, options = {}) {
  const plain = asPlainTemplate(template);
  const clinicId = toIntOrNull(plain.clinic_id);
  const expectedClinicId = toIntOrNull(options.clinicId || options.clinic_id);
  const triggerConfig = plain.trigger_config && typeof plain.trigger_config === 'object'
    ? plain.trigger_config
    : {};
  const actionNode = findNodeByType(plain, REVIEW_AUTOMATION_ACTION);
  const actionConfig = actionNode?.config && typeof actionNode.config === 'object'
    ? actionNode.config
    : {};
  const actionReviewSource = cleanString(actionConfig.review_source).toLowerCase();
  const configuredReviewSource = cleanString(triggerConfig.review_source).toLowerCase();
  const reviewSource = actionReviewSource || configuredReviewSource;
  const delayHours = readFixedDelayHours(plain);
  const configuredDelay = normalizeReviewDelay(triggerConfig.review_delay, null);
  const delay = configuredDelay || hoursToReviewDelay(delayHours, null);
  const errors = [];

  if (!clinicId) errors.push('clinic_scope_missing');
  if (expectedClinicId && clinicId !== expectedClinicId) errors.push('clinic_scope_mismatch');
  if (plain.is_system === true || plain.is_system === 1) errors.push('system_template_not_operational');
  if (cleanString(plain.trigger_type).toLowerCase() !== REVIEW_AUTOMATION_TRIGGER) {
    errors.push('invalid_trigger');
  }
  if (!plain.published_at) errors.push('template_not_published');
  if (options.requireActive && plain.is_active !== true && plain.is_active !== 1) {
    errors.push('template_not_active');
  }
  if (cleanString(triggerConfig.managed_feature).toLowerCase() !== REVIEW_AUTOMATION_MANAGED_FEATURE) {
    errors.push('managed_configuration_missing');
  }
  if (triggerConfig.configured !== true) errors.push('explicit_configuration_missing');
  if (Number(triggerConfig.configuration_version || 0) < REVIEW_AUTOMATION_CONFIGURATION_VERSION) {
    errors.push('configuration_version_missing');
  }
  if (!actionNode) errors.push('review_action_missing');
  if (!REVIEW_SOURCE_VALUES.has(reviewSource)) errors.push('review_source_missing');
  if (!REVIEW_SOURCE_VALUES.has(configuredReviewSource)) errors.push('review_source_metadata_missing');
  if (actionReviewSource && configuredReviewSource && actionReviewSource !== configuredReviewSource) {
    errors.push('review_source_mismatch');
  }
  if (!configuredDelay || delayHours === null) errors.push('review_delay_missing');
  if (!toIntOrNull(actionConfig.whatsapp_template_id)) errors.push('whatsapp_template_missing');
  if (!cleanString(actionConfig.review_sender_name)) errors.push('review_sender_missing');

  const configuredDelayHours = Number(triggerConfig.initial_delay_hours);
  if (!Number.isFinite(configuredDelayHours) || configuredDelayHours < 0) {
    errors.push('review_delay_metadata_missing');
  }
  if (
    delayHours !== null
    && Number.isFinite(configuredDelayHours)
    && Math.abs(delayHours - configuredDelayHours) > 0.0001
  ) {
    errors.push('review_delay_mismatch');
  }

  return {
    configured: errors.length === 0,
    errors,
    clinic_id: clinicId,
    review_source: reviewSource || null,
    review_delay: delay,
    initial_delay_hours: delayHours,
    whatsapp_template_id: toIntOrNull(actionConfig.whatsapp_template_id),
    review_sender_name: cleanString(actionConfig.review_sender_name) || null,
  };
}

module.exports = {
  REVIEW_AUTOMATION_TRIGGER,
  REVIEW_AUTOMATION_ACTION,
  REVIEW_AUTOMATION_MANAGED_FEATURE,
  REVIEW_AUTOMATION_CONFIGURATION_VERSION,
  REVIEW_DELAY_HOURS,
  REVIEW_SOURCE_VALUES,
  findNodeByType,
  normalizeReviewDelay,
  reviewDelayToHours,
  hoursToReviewDelay,
  inspectExplicitReviewAutomation,
};
