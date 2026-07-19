'use strict';

const { hasCurrentCatalogContract } = require('./whatsapp-template-catalog-coverage');

const DEFAULT_PENDING_THRESHOLD_MS = 60 * 60 * 1000;

function cleanString(value) {
  return String(value ?? '').trim();
}

function isEnabled(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(cleanString(value).toLowerCase());
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(cleanString(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluatePendingTemplateAutoResubmit({
  row,
  catalog,
  now = new Date(),
  approvedSiblingExists = false,
  pendingThresholdMs = DEFAULT_PENDING_THRESHOLD_MS,
  featureEnabled = true,
} = {}) {
  if (!featureEnabled) return { eligible: false, reason: 'feature_disabled' };
  if (!row || !cleanString(row.waba_id)) return { eligible: false, reason: 'missing_waba' };
  if (toPositiveInt(row.clinic_id)) return { eligible: false, reason: 'clinic_override' };
  if (!toPositiveInt(row.catalog_template_id) || !catalog) {
    return { eligible: false, reason: 'not_catalog' };
  }
  if (!isEnabled(row.is_active)) return { eligible: false, reason: 'inactive' };
  if (!isEnabled(catalog.is_active)) return { eligible: false, reason: 'catalog_inactive' };

  const status = cleanString(row.status).toUpperCase();
  if (!['PENDING', 'IN_REVIEW'].includes(status)) {
    return { eligible: false, reason: 'not_pending' };
  }
  if (!cleanString(row.meta_template_id)) {
    return { eligible: false, reason: 'missing_remote_identity' };
  }
  if (Number(row.auto_resubmit_attempt_count || 0) > 0) {
    return { eligible: false, reason: 'attempt_already_consumed' };
  }
  if (toPositiveInt(row.superseded_by_template_id)) {
    return { eligible: false, reason: 'superseded' };
  }
  if (approvedSiblingExists) {
    return { eligible: false, reason: 'approved_sibling_exists' };
  }
  if (!hasCurrentCatalogContract(catalog, row)) {
    return { eligible: false, reason: 'catalog_contract_stale' };
  }

  const nowTimestamp = toTimestamp(now);
  const pendingSinceTimestamp = toTimestamp(row.pending_since_at);
  const threshold = Math.max(1, Number(pendingThresholdMs) || DEFAULT_PENDING_THRESHOLD_MS);
  if (
    nowTimestamp === null
    || pendingSinceTimestamp === null
    || pendingSinceTimestamp >= nowTimestamp - threshold
  ) {
    return { eligible: false, reason: 'pending_threshold_not_met' };
  }

  return { eligible: true, reason: 'eligible' };
}

function buildPendingTemplateResubmitDedupeScope(row) {
  const templateId = toPositiveInt(row?.id);
  if (!templateId) return null;
  return `whatsapp-template-auto-resubmit:${templateId}`;
}

function shouldKeepRemoteTemplateActive({
  existing,
  catalogIsActive = true,
  isStaleReviewTemplate = false,
} = {}) {
  return !!(
    catalogIsActive
    && !isStaleReviewTemplate
    && !existing?.retired_at
    && !toPositiveInt(existing?.superseded_by_template_id)
  );
}

module.exports = {
  DEFAULT_PENDING_THRESHOLD_MS,
  evaluatePendingTemplateAutoResubmit,
  buildPendingTemplateResubmitDedupeScope,
  shouldKeepRemoteTemplateActive,
};
