'use strict';

function canResendFailedTemplate(message) {
  const m = message?.metadata || {};
  if (message?.direction !== 'outbound' || message?.message_type !== 'template' || message?.status !== 'failed'
    || m.manual_retry_message_id || !m.template_name || !m.template_language
    || m.delivery_unknown || m.outcome_unknown || m.post_acceptance_error
    || m.outbound_retry?.reason === 'delivery_unknown'
    || m.wa_status_timestamps?.delivered || m.wa_status_timestamps?.read
    || (Array.isArray(m.wa_status_history) && m.wa_status_history.some(s => ['delivered', 'read'].includes(s?.status)))) return false;
  const status = m.wa_status;
  return status?.status === 'failed' && Array.isArray(status.errors) && status.errors.some(e => Number(e?.code) > 0)
    || !m.wamid && !m.wa_response && Number(m.error?.error?.code || m.error?.error?.error?.code) > 0;
}

function retryMetadata(message, userId, now) {
  const metadata = structuredClone(message.metadata || {});
  // A confirmed rejection permits a NEW identity, never replaying the broker
  // receipt of the failed send. Keep scope, sender, template and execution pins.
  const discard = ['wamid', 'providerMessageId', 'provider_message_id', 'provider_acceptance_status', 'provider_acceptance_at',
    'wa_response', 'wa_error', 'wa_status', 'wa_status_history', 'wa_status_timestamps', 'error', 'error_code',
    'delivery_failed', 'delivery_unknown', 'outcome_unknown', 'outbound_retry', 'sender_health_blocked', 'sender_health',
    'manual_retry_message_id', 'automation_delivery_key', 'enqueue_error', 'forced_send_at', 'forced_send_by',
    'scheduled_for', 'queued_by_quiet_hours', 'quiet_hours_job_request_id'];
  for (const key of Object.keys(metadata)) {
    if (discard.includes(key) || key.startsWith('fresh_delivery_') || key.startsWith('automation_transport_')
      || key.startsWith('quiet_hours_transport_') || key.startsWith('immediate_transport_')) delete metadata[key];
  }
  return { ...metadata, manual_retry_of_message_id: message.id, manual_retry_requested_by: userId,
    manual_retry_requested_at: now.toISOString() };
}

module.exports = { canResendFailedTemplate, retryMetadata };
