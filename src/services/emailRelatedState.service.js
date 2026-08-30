'use strict';

const db = require('../../models');

const AMBIGUOUS_PROVIDER_OUTCOMES = new Set([
  'email_provider_timeout_unknown_outcome',
  'email_provider_server_error_unknown_outcome',
  'email_provider_transport_unknown_outcome',
  'email_provider_response_missing_message_id',
]);

function isPasswordResetMessage(message) {
  if (!message) return false;
  return message.related_type === 'password_reset_token'
    || message.template_key === 'auth.password_reset';
}

function isAmbiguousProviderOutcome(errorCode) {
  return AMBIGUOUS_PROVIDER_OUTCOMES.has(String(errorCode || ''));
}

async function revokePendingPasswordResetToken(message, { transaction = null } = {}) {
  if (!db.PasswordResetToken || !message?.id || !isPasswordResetMessage(message)) {
    return { affectedRows: 0 };
  }

  const [affectedRows] = await db.PasswordResetToken.update({
    status: 'revoked',
  }, {
    where: {
      email_message_id: message.id,
      status: 'pending',
    },
    transaction,
  });
  return { affectedRows: Number(affectedRows || 0) };
}

module.exports = {
  isAmbiguousProviderOutcome,
  revokePendingPasswordResetToken,
};
