'use strict';

function normalizeReviewSenderName(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function requireReviewSenderName(value) {
  const senderName = normalizeReviewSenderName(value);
  if (senderName) return senderName;

  const error = new Error('Indica el remitente que firma la solicitud de reseña antes de continuar.');
  error.status = 409;
  error.details = {
    reason: 'review_sender_name_missing',
    warnings: ['sender_name_missing'],
  };
  throw error;
}

module.exports = {
  normalizeReviewSenderName,
  requireReviewSenderName,
};
