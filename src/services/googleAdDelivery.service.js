'use strict';

const enumValue = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : null;
const primaryStates = new Set(['ELIGIBLE', 'PAUSED', 'REMOVED', 'PENDING', 'LIMITED', 'NOT_ELIGIBLE']);
const approvalStates = new Set(['APPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY']);

function googleAdHasUnrestrictedDelivery({ campaignStatus, adGroupStatus, groupAd }) {
  const policy = groupAd?.policySummary || groupAd?.policy_summary || {};
  // Restricted ads can serve, but cannot be the assured replacement for an automatic pause.
  return campaignStatus === 'ENABLED' && adGroupStatus === 'ENABLED' && groupAd?.status === 'ENABLED'
    && (groupAd.primaryStatus ?? groupAd.primary_status) === 'ELIGIBLE'
    && (policy.approvalStatus ?? policy.approval_status) === 'APPROVED';
}

function googleAdDeliveryObservation(groupAd, observedAt) {
  const policy = groupAd.policySummary || groupAd.policy_summary || {};
  const reasons = groupAd.primaryStatusReasons || groupAd.primary_status_reasons;
  return { schemaVersion: 1, observedAt: new Date(observedAt).toISOString(),
    primaryStatus: enumValue(groupAd.primaryStatus ?? groupAd.primary_status),
    primaryStatusReasons: Array.isArray(reasons) ? [...new Set(reasons.map(enumValue).filter(Boolean))].slice(0, 32) : [],
    approvalStatus: enumValue(policy.approvalStatus ?? policy.approval_status),
    reviewStatus: enumValue(policy.reviewStatus ?? policy.review_status) };
}

function googleAdDeliveryStatus(item) {
  if (item.present !== true && item.present !== 1) return 'UNKNOWN';
  const states = [item.campaignStatus, item.adGroupStatus, item.adStatus];
  if (states.includes('REMOVED')) return 'REMOVED';
  if (states.includes('PAUSED')) return 'PAUSED';
  const proof = item.deliveryObservation;
  const observed = +new Date(item.observedAt || NaN);
  // An older writer can refresh the inventory without refreshing its policy evidence.
  if (!proof || proof.schemaVersion !== 1 || !Number.isFinite(observed)
    || +new Date(proof.observedAt || NaN) !== observed) return 'UNKNOWN';
  if (proof.approvalStatus === 'DISAPPROVED') return 'DISAPPROVED';
  if (!primaryStates.has(proof.primaryStatus)) return 'UNKNOWN';
  if (['PAUSED', 'REMOVED', 'PENDING', 'NOT_ELIGIBLE'].includes(proof.primaryStatus)) return proof.primaryStatus;
  if (!states.every(state => state === 'ENABLED') || !approvalStates.has(proof.approvalStatus)) return 'UNKNOWN';
  if (proof.primaryStatus === 'LIMITED' || proof.approvalStatus !== 'APPROVED') return 'LIMITED';
  return 'ENABLED';
}

module.exports = { googleAdDeliveryObservation, googleAdDeliveryStatus, googleAdHasUnrestrictedDelivery };
