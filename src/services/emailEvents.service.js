'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { revokePendingPasswordResetToken } = require('./emailRelatedState.service');

const EVENT_PRECEDENCE = Object.freeze({
  unknown: 0,
  send: 10,
  delivery_delay: 20,
  delivery: 30,
  reject: 40,
  rendering_failure: 40,
  bounce: 50,
  complaint: 60,
});

const SUPPORTED_EVENT_TYPES = new Set([
  'send',
  'delivery',
  'bounce',
  'complaint',
  'reject',
  'rendering_failure',
  'delivery_delay',
  'subscription',
  'open',
  'click',
]);

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function sanitizeSummaryString(value) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  return normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\s().-]?){9,}/g, '[phone]')
    .slice(0, 500);
}

function normalizeOutboxPublicId(value) {
  const normalized = cleanString(value);
  return normalized && /^em_[A-Za-z0-9_-]{1,60}$/.test(normalized) ? normalized : null;
}

function firstTagValue(tags, name) {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (!tag || typeof tag !== 'object') continue;
      const tagName = cleanString(tag.Name || tag.name || tag.key);
      if (tagName !== name) continue;
      const value = tag.Value ?? tag.value ?? tag.values;
      return cleanString(Array.isArray(value) ? value[0] : value);
    }
    return null;
  }
  if (typeof tags !== 'object') return null;
  const value = tags[name];
  return cleanString(Array.isArray(value) ? value[0] : value);
}

function isRecoverableUnknownOutcome(value) {
  return [
    'email_provider_timeout_unknown_outcome',
    'email_provider_server_error_unknown_outcome',
    'email_provider_transport_unknown_outcome',
    'email_provider_response_missing_message_id',
  ].includes(String(value || ''));
}

function parseJsonMessage(payload) {
  if (payload && typeof payload === 'object' && typeof payload.Message === 'string') {
    try {
      return JSON.parse(payload.Message);
    } catch (_) {
      return payload;
    }
  }
  return payload;
}

function normalizeEventType(value) {
  const normalized = String(value || '').trim();
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const lookup = {
    Send: 'send',
    Delivery: 'delivery',
    Bounce: 'bounce',
    Complaint: 'complaint',
    Reject: 'reject',
    RenderingFailure: 'rendering_failure',
    DeliveryDelay: 'delivery_delay',
    Subscription: 'subscription',
    Open: 'open',
    Click: 'click',
    send: 'send',
    delivery: 'delivery',
    bounce: 'bounce',
    complaint: 'complaint',
    reject: 'reject',
    rendering_failure: 'rendering_failure',
    renderingfailure: 'rendering_failure',
    delivery_delay: 'delivery_delay',
    deliverydelay: 'delivery_delay',
    subscription: 'subscription',
    open: 'open',
    click: 'click',
    email_sent: 'send',
    email_delivered: 'delivery',
    email_bounced: 'bounce',
    email_complaint_received: 'complaint',
    email_rejected: 'reject',
    email_rendering_failed: 'rendering_failure',
    email_delivery_delayed: 'delivery_delay',
    email_subscribed: 'subscription',
    email_opened: 'open',
    email_clicked: 'click',
  };
  return lookup[normalized] || lookup[compact] || compact || 'unknown';
}

function severityFor(eventType) {
  if (['bounce', 'complaint', 'reject', 'rendering_failure'].includes(eventType)) return 'error';
  if (['delivery_delay'].includes(eventType)) return 'warning';
  return 'info';
}

function normalizeSesEvent(rawPayload = {}) {
  const payload = parseJsonMessage(rawPayload) || {};
  const detail = payload.detail && typeof payload.detail === 'object' ? payload.detail : payload;
  const mail = detail.mail && typeof detail.mail === 'object' ? detail.mail : {};
  const eventType = normalizeEventType(
    detail.eventType
    || detail.event_type
    || detail.notificationType
    || detail.notification_type
    || payload.eventType
    || payload.event_type
    || payload.notificationType
    || payload.notification_type
    || payload['detail-type']
  );
  const providerMessageId = cleanString(
    mail.messageId
    || detail.mailMessageId
    || detail.mail_message_id
    || detail.messageId
    || detail.MessageId
    || detail.providerMessageId
    || detail.provider_message_id
    || payload.providerMessageId
    || payload.provider_message_id
  );
  const outboxPublicId = normalizeOutboxPublicId(
    firstTagValue(mail.tags, 'cc_outbox')
    || detail.outboxPublicId
    || detail.outbox_public_id
    || payload.outboxPublicId
    || payload.outbox_public_id
  );
  const occurredAt = new Date(
    cleanString(detail.timestamp)
    || cleanString(detail.occurredAt)
    || cleanString(detail.occurred_at)
    || cleanString(mail.timestamp)
    || cleanString(payload.time)
    || cleanString(payload.occurredAt)
    || cleanString(payload.occurred_at)
    || Date.now()
  );
  const providerEventId = cleanString(payload.id)
    || cleanString(detail.eventId)
    || cleanString(detail.event_id)
    || cleanString(payload.eventId)
    || cleanString(payload.event_id)
    || cleanString(detail.notificationId)
    || cleanString(detail.notification_id)
    || ((providerMessageId || outboxPublicId)
      ? `${providerMessageId || outboxPublicId}:${eventType}:${occurredAt.toISOString()}`
      : null);

  return {
    provider: 'ses',
    providerEventId,
    providerMessageId,
    outboxPublicId,
    eventType,
    severity: severityFor(eventType),
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    summary: {
      event_type: eventType,
      provider_message_id: providerMessageId,
      outbox_public_id: outboxPublicId,
      destination_count: Array.isArray(mail.destination) ? mail.destination.length : null,
      bounce_type: sanitizeSummaryString(detail.bounce?.bounceType),
      bounce_sub_type: sanitizeSummaryString(detail.bounce?.bounceSubType),
      complaint_feedback_type: sanitizeSummaryString(detail.complaint?.complaintFeedbackType),
      reject_reason: sanitizeSummaryString(detail.reject?.reason),
      delivery_delay_type: sanitizeSummaryString(detail.deliveryDelay?.delayType),
      delivery_processing_time_millis: detail.delivery?.processingTimeMillis ?? null,
      smtp_response: sanitizeSummaryString(detail.delivery?.smtpResponse),
    },
  };
}

function assertValidEvent(event) {
  if (!event?.providerEventId || !SUPPORTED_EVENT_TYPES.has(event.eventType)) {
    const error = new Error('email_provider_event_invalid');
    error.code = 'email_provider_event_invalid';
    throw error;
  }
  return event;
}

function eventPrecedence(eventType) {
  return EVENT_PRECEDENCE[eventType] || 0;
}

function shouldReplaceLastEvent(message, eventType) {
  return eventPrecedence(eventType) >= eventPrecedence(message?.last_event_type);
}

async function applyEventToMessage(message, event, { transaction = null } = {}) {
  if (!message) return;
  const now = event.occurredAt || new Date();
  const recoverableUnknownOutcome = message.status === 'failed'
    && isRecoverableUnknownOutcome(message.last_error_code);
  const patch = {
    event_count: Number(message.event_count || 0) + 1,
  };
  if (event.providerMessageId && !message.provider_message_id) {
    patch.provider_message_id = event.providerMessageId;
  }
  if (shouldReplaceLastEvent(message, event.eventType)) patch.last_event_type = event.eventType;
  if (event.eventType === 'delivery') {
    if (
      !['bounced', 'complained', 'rejected', 'suppressed', 'cancelled'].includes(message.status)
      && (message.status !== 'failed' || recoverableUnknownOutcome)
    ) {
      patch.status = 'delivered';
      patch.delivered_at = now;
      patch.completed_at = recoverableUnknownOutcome ? now : (message.completed_at || now);
      patch.rejected_at = null;
      patch.last_error_code = null;
      patch.last_error_message = null;
    }
  } else if (event.eventType === 'bounce') {
    if (message.status !== 'complained') {
      patch.status = 'bounced';
      patch.bounced_at = now;
      patch.completed_at = now;
      patch.last_error_code = 'email_bounced';
      patch.last_error_message = 'El proveedor notificó rebote.';
    }
  } else if (event.eventType === 'complaint') {
    patch.status = 'complained';
    patch.complained_at = now;
    patch.completed_at = now;
    patch.last_error_code = 'email_complaint';
    patch.last_error_message = 'El proveedor notificó queja.';
  } else if (event.eventType === 'reject' || event.eventType === 'rendering_failure') {
    if (!['bounced', 'complained'].includes(message.status)) {
      patch.status = 'rejected';
      patch.rejected_at = now;
      patch.completed_at = now;
      patch.last_error_code = `email_${event.eventType}`;
      patch.last_error_message = 'El proveedor rechazó el mensaje.';
    }
  } else if (
    event.eventType === 'send'
    && (['queued', 'sending'].includes(message.status) || recoverableUnknownOutcome)
  ) {
    patch.status = 'sent';
    patch.sent_at = message.sent_at || now;
    patch.completed_at = recoverableUnknownOutcome ? now : (message.completed_at || now);
    patch.rejected_at = null;
    patch.last_error_code = null;
    patch.last_error_message = null;
  }
  await message.update(patch, { transaction });
}

async function suppressRecipientFromEvent(message, event, providerEventRow, { transaction = null } = {}) {
  if (!message || !['bounce', 'complaint'].includes(event.eventType)) return null;
  const stream = event.eventType === 'complaint' ? 'all' : message.stream;
  const scope = message.clinica_id ? `clinic:${message.clinica_id}` : 'global';
  const [suppression] = await db.EmailSuppression.findOrCreate({
    where: {
      email_hash: message.recipient_hash,
      stream,
      scope,
      status: 'active',
    },
    defaults: {
      email_domain: message.recipient_domain || null,
      reason: event.eventType,
      source: 'provider_event',
      provider_event_id: providerEventRow?.id || null,
      clinica_id: message.clinica_id || null,
      suppressed_at: event.occurredAt || new Date(),
    },
    transaction,
  });
  return suppression;
}

async function reconcileSystemNotificationDelivery(message, event, { transaction = null } = {}) {
  if (!message || message.related_type !== 'system_notification' || !db.SystemNotificationDelivery) return null;
  const delivery = await db.SystemNotificationDelivery.findOne({
    where: { email_message_id: message.id, channel: 'email' },
    transaction,
    ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!delivery) return null;

  const patch = {
    provider: 'ses',
    provider_message_id: event.providerMessageId || message.provider_message_id || null,
  };
  const recoverableUnknownOutcome = delivery.status === 'failed'
    && isRecoverableUnknownOutcome(delivery.error_code);
  if (
    event.eventType === 'send'
    && (!['delivered', 'failed', 'skipped'].includes(delivery.status) || recoverableUnknownOutcome)
  ) {
    patch.status = 'sent';
    patch.sent_at = delivery.sent_at || event.occurredAt || new Date();
    patch.error_code = null;
    patch.error_message = null;
    patch.failed_at = null;
  } else if (
    event.eventType === 'delivery'
    && (!['failed', 'skipped'].includes(delivery.status) || recoverableUnknownOutcome)
  ) {
    patch.status = 'delivered';
    patch.sent_at = delivery.sent_at || message.sent_at || event.occurredAt || new Date();
    patch.completed_at = event.occurredAt || new Date();
    patch.error_code = null;
    patch.error_message = null;
    patch.failed_at = null;
  } else if (['bounce', 'complaint', 'reject', 'rendering_failure'].includes(event.eventType)) {
    patch.status = 'failed';
    patch.error_code = `email_${event.eventType}`;
    patch.error_message = 'El proveedor notificó un fallo terminal del email.';
    patch.failed_at = event.occurredAt || new Date();
    patch.completed_at = event.occurredAt || new Date();
  }
  await delivery.update(patch, { transaction });
  return delivery;
}

async function reconcileTerminalRelatedState(message, event, { transaction = null } = {}) {
  if (!['bounce', 'complaint', 'reject', 'rendering_failure'].includes(event.eventType)) return null;
  return revokePendingPasswordResetToken(message, { transaction });
}

async function recordProviderEvent(rawPayload = {}) {
  const event = assertValidEvent(normalizeSesEvent(rawPayload));
  return db.sequelize.transaction(async (transaction) => {
    let message = event.providerMessageId
      ? await db.EmailMessage.findOne({
        where: { provider_message_id: event.providerMessageId },
        transaction,
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
      })
      : null;
    if (!message && event.outboxPublicId) {
      message = await db.EmailMessage.findOne({
        where: { public_id: event.outboxPublicId },
        transaction,
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
      });
    }

    const [row, created] = await db.EmailProviderEvent.findOrCreate({
      where: {
        provider: event.provider,
        provider_event_id: event.providerEventId
          || `${event.providerMessageId || event.outboxPublicId || 'unknown'}:${event.eventType}:${event.occurredAt.toISOString()}`,
      },
      defaults: {
        email_message_id: message?.id || null,
        provider_message_id: event.providerMessageId,
        event_type: event.eventType,
        severity: event.severity,
        occurred_at: event.occurredAt,
        payload_summary: event.summary,
      },
      transaction,
    });

    if (!created) {
      return { created: false, event: row, email_message_id: row.email_message_id || null };
    }

    await applyEventToMessage(message, event, { transaction });
    const suppression = await suppressRecipientFromEvent(message, event, row, { transaction });
    await reconcileSystemNotificationDelivery(message, event, { transaction });
    await reconcileTerminalRelatedState(message, event, { transaction });
    return {
      created: true,
      event: row,
      email_message_id: message?.id || null,
      suppression_id: suppression?.id || null,
    };
  });
}

async function listEvents({ limit = 50, emailMessageId = null, eventType = null } = {}) {
  const where = {};
  if (emailMessageId) where.email_message_id = emailMessageId;
  if (eventType) where.event_type = eventType;
  const rows = await db.EmailProviderEvent.findAll({
    where,
    limit,
    order: [['occurred_at', 'DESC']],
  });
  return rows;
}

async function recentEventCounts(since) {
  return db.EmailProviderEvent.findAll({
    attributes: [
      'event_type',
      [db.sequelize.fn('COUNT', db.sequelize.col('event_type')), 'total'],
    ],
    where: { occurred_at: { [Op.gte]: since } },
    group: ['event_type'],
    raw: true,
  });
}

module.exports = {
  normalizeSesEvent,
  assertValidEvent,
  recordProviderEvent,
  applyEventToMessage,
  listEvents,
  recentEventCounts,
};
