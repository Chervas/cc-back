'use strict';
function definitiveRecipientFailure(message, status = {}) {
  const metadata = message?.metadata || {};
  const retry = metadata.outbound_retry || {};
  if (message?.status !== 'failed' || retry.retrying === true || retry.reason === 'delivery_unknown'
    || metadata.delivery_unknown === true || metadata.post_acceptance_error) return false;
  let error = metadata.error;
  if (typeof error === 'string') { try { error = JSON.parse(error); } catch { error = null; } }
  const nested = error?.error?.error || error?.error || error;
  return [...(Array.isArray(status.errors) ? status.errors : []),
    ...(Array.isArray(metadata.wa_error) ? metadata.wa_error : []),
    ...(Array.isArray(metadata.wa_status?.errors) ? metadata.wa_status.errors : []), nested]
    .some(value => String(value?.code || '') === '131026');
}
module.exports = { definitiveRecipientFailure };
