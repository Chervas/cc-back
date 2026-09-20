'use strict';

// Bounds receipt queries, never provider writes. Review does not release locks.
const MAX_RECEIPT_CHECKS = 8;
const MAX_RECEIPT_WAIT_MS = 24 * 60 * 60 * 1000;
const PENDING_REASON = 'business_profile_mutation_pending';
const REVIEW_ERROR = 'business_profile_mutation_review_required';
const isReceiptWait = execution => execution?.status === 'waiting'
  && execution.waiting_meta?.reason === PENDING_REASON;
const needsReview = execution => isReceiptWait(execution)
  && execution.waiting_meta?.manual_review_required === true;

function nextReceiptWait({ previous, operationId, createdAt, now }) {
  const count = previous?.operation_id === operationId ? Number(previous.receipt_checks) : 0;
  const checks = Math.min(MAX_RECEIPT_CHECKS, (Number.isSafeInteger(count) && count > 0 ? count : 0) + 1);
  const admittedAt = new Date(createdAt).getTime();
  // Corrupt/missing admission times cannot grant a fresh automatic retry window.
  const review = checks >= MAX_RECEIPT_CHECKS || !Number.isFinite(admittedAt)
    || now - admittedAt >= MAX_RECEIPT_WAIT_MS;
  return {
    checks, review,
    waitUntil: review ? null : new Date(now + Math.min(3600000, 60000 * 2 ** Math.min(checks - 1, 6))),
  };
}

module.exports = { MAX_RECEIPT_CHECKS, MAX_RECEIPT_WAIT_MS, PENDING_REASON, REVIEW_ERROR,
  isReceiptWait, needsReview, nextReceiptWait };
