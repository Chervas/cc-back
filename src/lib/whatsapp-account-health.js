'use strict';

const BLOCKED_STATES = new Set(['blocked', 'disconnected']);
const BLOCKED_PROVIDER_STATUSES = new Set([
  'BANNED',
  'BLOCKED',
  'DISABLED',
  'LOCKED',
  'SUSPENDED',
]);
const DISCONNECTED_PROVIDER_STATUSES = new Set([
  'DELETED',
  'DISCONNECTED',
  'NOT_REGISTERED',
  'OFFLINE',
  'PENDING',
  'UNREGISTERED',
]);
const BLOCKED_COMPLIANCE_STATUSES = new Set([
  'banned',
  'blocked',
  'deleted',
  'disabled',
  'locked',
  'restricted',
  'scheduled_for_disable',
  'suspended',
]);
const DISCONNECTED_EVENTS = new Set(['ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED']);
const BLOCKED_ACCOUNT_REVIEW_STATUSES = new Set(['REJECTED']);
const DEGRADED_ACCOUNT_REVIEW_STATUSES = new Set([
  'IN_REVIEW',
  'PENDING',
  'PENDING_REVIEW',
]);
const DEGRADED_BUSINESS_VERIFICATION_STATUSES = new Set([
  'EXPIRED',
  'FAILED',
  'INELIGIBLE',
  'NOT_VERIFIED',
  'PENDING',
  'PENDING_NEED_MORE_INFO',
  'PENDING_SUBMISSION',
  'REJECTED',
  'REVOKED',
]);

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanLimitedText(value, maxLength = 255) {
  return String(value ?? '').trim().slice(0, maxLength) || null;
}

function normalizeWabaOperationalSnapshot(payload, observedAt = new Date()) {
  if (!payload || typeof payload !== 'object') return null;
  const health = safeObject(payload.health_status);
  const entities = Array.isArray(health.entities)
    ? health.entities.slice(0, 20).map((entity) => ({
        entity_type: cleanLimitedText(entity?.entity_type, 32)?.toUpperCase() || null,
        id: cleanLimitedText(entity?.id, 255),
        can_send_message: cleanLimitedText(entity?.can_send_message, 32)?.toUpperCase() || null,
        errors: Array.isArray(entity?.errors)
          ? entity.errors.slice(0, 20).map((error) => ({
              error_code: Number(error?.error_code || 0) || null,
              error_description: cleanLimitedText(error?.error_description, 500),
              possible_solution: cleanLimitedText(error?.possible_solution, 500),
            }))
          : [],
      }))
    : [];
  const businessEntity = entities.find((entity) => entity.entity_type === 'BUSINESS') || null;
  return {
    waba_name: cleanLimitedText(payload.name, 255),
    account_review_status: cleanLimitedText(payload.account_review_status, 64)?.toUpperCase() || null,
    business_verification_status: cleanLimitedText(payload.business_verification_status, 64)?.toLowerCase() || null,
    can_send_message: cleanLimitedText(health.can_send_message, 32)?.toUpperCase() || null,
    business_id: businessEntity?.id || null,
    entities,
    source: 'meta_waba_graph',
    observed_at: observedAt instanceof Date ? observedAt.toISOString() : new Date(observedAt).toISOString(),
  };
}

function extractProviderErrorCode(error) {
  const candidate = error?.response?.data?.error?.error
    || error?.response?.data?.error
    || error?.error?.error
    || error?.error
    || (Array.isArray(error?.errors) ? error.errors[0] : null)
    || error;
  const raw = candidate?.code || candidate?.error_subcode || error?.code || null;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function deriveHealthCandidate(input = {}) {
  const providerStatus = upper(input.providerStatus);
  const registrationStatus = lower(input.registrationStatus);
  const complianceStatus = lower(input.complianceStatus);
  const providerEvent = upper(input.providerEvent);
  const qualityRating = upper(input.qualityRating);
  const accountReviewStatus = upper(input.accountReviewStatus);
  const wabaCanSendMessage = upper(input.wabaCanSendMessage);
  const businessVerificationStatus = upper(input.businessVerificationStatus);
  const webhookSubscriptionStatus = lower(input.webhookSubscriptionStatus);
  const providerErrorCode = Number(input.providerErrorCode || 0) || null;

  if (providerErrorCode === 131031) {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: 'meta_error_131031_account_locked',
      provider_status: providerStatus || null,
      provider_error_code: providerErrorCode,
    };
  }

  if (input.assetActive === false) {
    return {
      state: 'disconnected',
      can_send: false,
      severity: 'critical',
      reason_code: 'asset_inactive',
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (DISCONNECTED_EVENTS.has(providerEvent)) {
    return {
      state: 'disconnected',
      can_send: false,
      severity: 'critical',
      reason_code: `account_event_${providerEvent.toLowerCase()}`,
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (providerEvent === 'ACCOUNT_RESTRICTION') {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: 'account_event_account_restriction',
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (providerEvent === 'ACCOUNT_DELETED') {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: 'account_event_account_deleted',
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (BLOCKED_COMPLIANCE_STATUSES.has(complianceStatus)) {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: `compliance_${complianceStatus}`,
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (BLOCKED_PROVIDER_STATUSES.has(providerStatus)) {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: `provider_status_${providerStatus.toLowerCase()}`,
      provider_status: providerStatus,
      provider_error_code: null,
    };
  }

  if (wabaCanSendMessage === 'BLOCKED') {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: 'waba_health_blocked',
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (BLOCKED_ACCOUNT_REVIEW_STATUSES.has(accountReviewStatus)) {
    return {
      state: 'blocked',
      can_send: false,
      severity: 'critical',
      reason_code: `waba_account_review_${accountReviewStatus.toLowerCase()}`,
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  if (providerEvent === 'ACCOUNT_RECONNECTED') {
    return {
      state: ['YELLOW', 'RED'].includes(qualityRating) ? 'degraded' : 'healthy',
      can_send: true,
      severity: qualityRating === 'RED' ? 'warning' : 'info',
      reason_code: 'account_event_account_reconnected',
      provider_status: 'CONNECTED',
      provider_error_code: null,
    };
  }

  if (DISCONNECTED_PROVIDER_STATUSES.has(providerStatus)) {
    return {
      state: 'disconnected',
      can_send: false,
      severity: 'critical',
      reason_code: `provider_status_${providerStatus.toLowerCase()}`,
      provider_status: providerStatus,
      provider_error_code: null,
    };
  }

  if (['blocked', 'deleted', 'failed', 'not_registered'].includes(registrationStatus)) {
    return {
      state: 'disconnected',
      can_send: false,
      severity: 'critical',
      reason_code: `registration_${registrationStatus}`,
      provider_status: providerStatus || null,
      provider_error_code: null,
    };
  }

  const connected = providerStatus === 'CONNECTED'
    || (!providerStatus && registrationStatus === 'registered');
  if (connected) {
    const degraded = ['YELLOW', 'RED'].includes(qualityRating)
      || complianceStatus === 'warning'
      || providerEvent === 'ACCOUNT_VIOLATION'
      || wabaCanSendMessage === 'LIMITED'
      || DEGRADED_ACCOUNT_REVIEW_STATUSES.has(accountReviewStatus)
      || DEGRADED_BUSINESS_VERIFICATION_STATUSES.has(businessVerificationStatus)
      || webhookSubscriptionStatus === 'missing';
    return {
      state: degraded ? 'degraded' : 'healthy',
      can_send: true,
      severity: degraded ? 'warning' : 'info',
      reason_code: wabaCanSendMessage === 'LIMITED'
        ? 'waba_health_limited'
        : DEGRADED_ACCOUNT_REVIEW_STATUSES.has(accountReviewStatus)
          ? `waba_account_review_${accountReviewStatus.toLowerCase()}`
          : webhookSubscriptionStatus === 'missing'
            ? 'webhook_subscription_missing'
          : DEGRADED_BUSINESS_VERIFICATION_STATUSES.has(businessVerificationStatus)
            ? `business_verification_${businessVerificationStatus.toLowerCase()}`
            : qualityRating === 'RED'
              ? 'quality_red'
              : qualityRating === 'YELLOW'
                ? 'quality_yellow'
                : complianceStatus === 'warning' || providerEvent === 'ACCOUNT_VIOLATION'
                  ? 'compliance_warning'
                  : 'provider_connected',
      provider_status: providerStatus || 'CONNECTED',
      provider_error_code: null,
    };
  }

  return {
    state: 'unknown',
    can_send: null,
    severity: 'warning',
    reason_code: 'provider_status_unknown',
    provider_status: providerStatus || null,
    provider_error_code: null,
  };
}

function deriveAssetSignal(asset = {}, overrides = {}) {
  const additionalData = safeObject(asset.additionalData);
  const registration = safeObject(additionalData.registration);
  const compliance = safeObject(additionalData.whatsappCompliance);
  const businessHealth = safeObject(additionalData.whatsappBusinessHealth);
  const webhookSubscription = safeObject(additionalData.whatsappWebhookSubscription);
  return {
    assetActive: overrides.assetActive ?? asset.isActive,
    providerStatus: overrides.providerStatus ?? registration.phoneStatus,
    registrationStatus: overrides.registrationStatus ?? registration.status,
    complianceStatus: overrides.complianceStatus ?? compliance.status,
    providerEvent: overrides.providerEvent,
    providerErrorCode: overrides.providerErrorCode,
    qualityRating: overrides.qualityRating ?? asset.quality_rating,
    accountReviewStatus: overrides.accountReviewStatus ?? businessHealth.account_review_status,
    wabaCanSendMessage: overrides.wabaCanSendMessage ?? businessHealth.can_send_message,
    businessVerificationStatus: overrides.businessVerificationStatus
      ?? businessHealth.business_verification_status
      ?? additionalData.businessVerificationStatus,
    webhookSubscriptionStatus: overrides.webhookSubscriptionStatus
      ?? webhookSubscription.status,
  };
}

function isBlockingState(state) {
  return BLOCKED_STATES.has(lower(state));
}

function applyRecoveryPolicy({
  previousState = 'unknown',
  previousRecoveryCount = 0,
  candidate,
  explicitRecovery = false,
  observationsRequired = 2,
  previousReason = null,
} = {}) {
  const safeCandidate = candidate || deriveHealthCandidate();
  const pollingRecovery = !explicitRecovery
    && isBlockingState(previousState)
    && !isBlockingState(safeCandidate.state)
    && safeCandidate.provider_status === 'CONNECTED';
  const recoveryCount = pollingRecovery ? Number(previousRecoveryCount || 0) + 1 : 0;
  const recoveryPending = pollingRecovery && recoveryCount < Math.max(1, Number(observationsRequired || 2));
  return {
    health: recoveryPending
      ? {
          ...safeCandidate,
          state: lower(previousState) || 'blocked',
          can_send: false,
          severity: 'warning',
          reason_code: 'recovery_confirmation_pending',
          blocking_reason_code: previousReason || null,
        }
      : safeCandidate,
    recovery_count: recoveryPending ? recoveryCount : 0,
    recovery_pending: recoveryPending,
  };
}

function effectiveStoredHealth(asset = {}, { now = new Date(), staleMinutes = 30 } = {}) {
  const additionalData = safeObject(asset.additionalData);
  const stored = safeObject(additionalData.whatsappHealth);
  const derived = deriveHealthCandidate(deriveAssetSignal(asset));
  let health = Object.keys(stored).length ? { ...stored } : { ...derived };
  const providerObservedCandidates = [
    additionalData.registration?.lastAttemptAt,
    additionalData.whatsappPhoneSync?.status_checked_at,
    additionalData.whatsappBusinessHealth?.observed_at,
  ]
    .map((value) => ({ value, time: value ? new Date(value).getTime() : 0 }))
    .filter((item) => Number.isFinite(item.time) && item.time > 0)
    .sort((left, right) => right.time - left.time);
  const latestProviderObservation = providerObservedCandidates[0] || null;
  const storedObservedMs = stored.observed_at ? new Date(stored.observed_at).getTime() : 0;
  const providerSnapshotIsNewer = latestProviderObservation
    && latestProviderObservation.time > (Number.isFinite(storedObservedMs) ? storedObservedMs : 0);

  // A fresh provider snapshot may advance a non-blocking state immediately.
  // Recovery from a blocking state still goes through the confirmation policy.
  if (
    (isBlockingState(derived.state) && !isBlockingState(health.state))
    || (providerSnapshotIsNewer && (
      isBlockingState(derived.state)
      || !isBlockingState(health.state)
    ))
  ) {
    health = {
      ...health,
      ...derived,
      observed_at: latestProviderObservation?.value
        || additionalData.registration?.lastAttemptAt
        || asset.updatedAt
        || null,
      source: 'stored_provider_snapshot',
    };
  }

  const observedAt = health.observed_at || additionalData.registration?.lastAttemptAt || asset.updatedAt || null;
  const observedMs = observedAt ? new Date(observedAt).getTime() : 0;
  const staleAfterMs = Math.max(1, Number(staleMinutes || 30)) * 60 * 1000;
  const isStale = !isBlockingState(health.state)
    && (!Number.isFinite(observedMs) || observedMs <= 0 || now.getTime() - observedMs > staleAfterMs);

  return {
    state: isStale ? 'stale' : (health.state || 'unknown'),
    base_state: health.state || 'unknown',
    can_send: health.can_send === undefined ? derived.can_send : health.can_send,
    severity: isStale ? 'warning' : (health.severity || derived.severity || 'warning'),
    reason_code: isStale ? 'monitoring_stale' : (health.reason_code || derived.reason_code),
    provider_status: health.provider_status || derived.provider_status || null,
    provider_error_code: health.provider_error_code || null,
    source: health.source || 'derived_from_asset',
    observed_at: observedAt,
    last_transition_at: health.last_transition_at || null,
    last_healthy_at: health.last_healthy_at || null,
    last_blocked_at: health.last_blocked_at || null,
    last_blocked_send_at: health.last_blocked_send_at || null,
    blocked_send_count: Number(health.blocked_send_count || 0),
    recovery_connected_observations: Number(health.recovery_connected_observations || 0),
    is_stale: isStale,
  };
}

module.exports = {
  BLOCKED_ACCOUNT_REVIEW_STATUSES,
  BLOCKED_COMPLIANCE_STATUSES,
  BLOCKED_PROVIDER_STATUSES,
  BLOCKED_STATES,
  DEGRADED_ACCOUNT_REVIEW_STATUSES,
  DEGRADED_BUSINESS_VERIFICATION_STATUSES,
  DISCONNECTED_EVENTS,
  DISCONNECTED_PROVIDER_STATUSES,
  applyRecoveryPolicy,
  deriveAssetSignal,
  deriveHealthCandidate,
  effectiveStoredHealth,
  extractProviderErrorCode,
  isBlockingState,
  normalizeWabaOperationalSnapshot,
};
