'use strict';

const { createHmac, randomBytes } = require('node:crypto');

// A retry is recognizable inside this process, without publishing a stable digest of a message.
const correlationKey = randomBytes(32);
const hosts = new Set(['app.clinicaclick.com', 'autenticacion.clinicaclick.com', 'crm.clinicaclick.com']);
const causes = new Set([
  'meta_lead_unsupported_notification', 'meta_leads_disabled', 'broker_configuration_invalid',
  'meta_lead_page_access_required', 'meta_lead_account_access_required', 'meta_lead_clinic_assignment_required',
  'meta_lead_identity_mismatch', 'meta_lead_conflicting_notification', 'meta_lead_receipt_review_required',
  'meta_lead_receipt_unavailable', 'social_verification_unavailable', 'scope_denied', 'operation_denied',
  'asset_revoked', 'credential_revoked', 'provider_failed', 'broker_unavailable', 'broker_timeout',
  'rate_limited', 'queue_unavailable', 'connection_blocked', 'broker_response_invalid', 'broker_cohort_disabled',
  'meta_broker_binding_invalid', 'meta_broker_scope_changed', 'meta_broker_not_active', 'meta_broker_scope_forbidden',
  'meta_broker_session_required', 'social_history_route_changed'
]);

const databaseErrors = new Set([
  'SequelizeConnectionError', 'SequelizeConnectionAcquireTimeoutError', 'SequelizeConnectionRefusedError',
  'SequelizeDatabaseError', 'SequelizeTimeoutError', 'SequelizeUniqueConstraintError'
]);

function failureCause(error) {
  if (causes.has(error?.code)) return error.code;
  if (causes.has(error?.message)) return error.message;
  return databaseErrors.has(error?.name) ? 'database_error' : 'other';
}

function envelopeType(body) {
  if (!['instagram', 'page'].includes(body?.object)) return 'other';
  const kinds = new Set();
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    if (Array.isArray(entry?.messaging) && entry.messaging.length) kinds.add('messaging');
    if (Array.isArray(entry?.standby) && entry.standby.length) kinds.add('standby');
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      kinds.add(['leadgen', 'comments', 'messages'].includes(change?.field) ? change.field : 'other_change');
    }
  }
  const shape = kinds.size > 1 ? 'mixed' : kinds.values().next().value || 'other';
  return body.object + '_' + shape;
}

function reportUnavailable({ req, body, stage, error, log }) {
  try {
    const host = req.headers?.host?.toLowerCase();
    const record = {
      event: 'meta_webhook_reception_unavailable',
      host: hosts.has(host) ? host : 'other',
      envelope: stage === 'challenge' ? 'challenge' : envelopeType(body),
      stage,
      cause: failureCause(error)
    };
    if (stage !== 'challenge' && Buffer.isBuffer(req.rawBody) && req.rawBody.length <= 65536) {
      record.delivery = createHmac('sha256', correlationKey).update(req.rawBody).digest('hex').slice(0, 24);
    }
    log(record);
  } catch {
    // Logging must never change the acknowledgment already owed to the provider.
  }
}

module.exports = { reportUnavailable };
