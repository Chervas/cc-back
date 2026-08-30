#!/usr/bin/env node
'use strict';

const db = require('../../models');

const EVENT_PRECEDENCE = Object.freeze({
  send: 10,
  delivery_delay: 20,
  delivery: 30,
  reject: 40,
  rendering_failure: 40,
  bounce: 50,
  complaint: 60,
});

function dateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function strongestEvent(events = []) {
  return [...events]
    .filter((event) => EVENT_PRECEDENCE[event.event_type])
    .sort((left, right) => {
      const precedence = EVENT_PRECEDENCE[right.event_type] - EVENT_PRECEDENCE[left.event_type];
      if (precedence !== 0) return precedence;
      return (dateValue(right.occurred_at)?.getTime() || 0) - (dateValue(left.occurred_at)?.getTime() || 0);
    })[0] || null;
}

function firstEventAt(events, type) {
  return events
    .filter((event) => event.event_type === type)
    .map((event) => dateValue(event.occurred_at))
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime())[0] || null;
}

function canonicalStatus(eventType) {
  return {
    send: 'sent',
    delivery_delay: 'sent',
    delivery: 'delivered',
    reject: 'rejected',
    rendering_failure: 'rejected',
    bounce: 'bounced',
    complaint: 'complained',
  }[eventType] || null;
}

function messagePatch(message, events) {
  const strongest = strongestEvent(events);
  if (!strongest) return { event_count: events.length };
  const status = canonicalStatus(strongest.event_type);
  const occurredAt = dateValue(strongest.occurred_at) || new Date();
  const sendAt = firstEventAt(events, 'send');
  const patch = {
    event_count: events.length,
    last_event_type: strongest.event_type,
    status,
  };
  if (sendAt && !message.sent_at) patch.sent_at = sendAt;

  if (strongest.event_type === 'delivery') {
    patch.delivered_at = dateValue(message.delivered_at) || occurredAt;
    patch.completed_at = dateValue(message.completed_at) || occurredAt;
    patch.last_error_code = null;
    patch.last_error_message = null;
  } else if (strongest.event_type === 'bounce') {
    patch.bounced_at = dateValue(message.bounced_at) || occurredAt;
    patch.completed_at = occurredAt;
    patch.last_error_code = 'email_bounced';
    patch.last_error_message = 'El proveedor notificó rebote.';
  } else if (strongest.event_type === 'complaint') {
    patch.complained_at = dateValue(message.complained_at) || occurredAt;
    patch.completed_at = occurredAt;
    patch.last_error_code = 'email_complaint';
    patch.last_error_message = 'El proveedor notificó queja.';
  } else if (['reject', 'rendering_failure'].includes(strongest.event_type)) {
    patch.rejected_at = dateValue(message.rejected_at) || occurredAt;
    patch.completed_at = occurredAt;
    patch.last_error_code = `email_${strongest.event_type}`;
    patch.last_error_message = 'El proveedor rechazó el mensaje.';
  } else if (strongest.event_type === 'send') {
    patch.sent_at = dateValue(message.sent_at) || occurredAt;
    patch.completed_at = dateValue(message.completed_at) || occurredAt;
    patch.last_error_code = null;
    patch.last_error_message = null;
  }
  return patch;
}

function notificationPatch(message, strongest) {
  const providerMessageId = message.provider_message_id || null;
  const occurredAt = dateValue(strongest?.occurred_at)
    || dateValue(message.completed_at)
    || dateValue(message.updated_at)
    || new Date();
  const base = { provider: 'ses', provider_message_id: providerMessageId };
  if (message.status === 'delivered') {
    return { ...base, status: 'delivered', sent_at: dateValue(message.sent_at) || occurredAt, completed_at: occurredAt, error_code: null, error_message: null };
  }
  if (message.status === 'sent') {
    return { ...base, status: 'sent', sent_at: dateValue(message.sent_at) || occurredAt, error_code: null, error_message: null };
  }
  if (['bounced', 'complained', 'rejected', 'failed'].includes(message.status)) {
    return {
      ...base,
      status: 'failed',
      error_code: message.last_error_code || `email_${message.status}`,
      error_message: message.last_error_message || 'El email terminó con un fallo.',
      failed_at: occurredAt,
      completed_at: occurredAt,
    };
  }
  return { ...base, status: 'queued' };
}

function comparable(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

function changedFields(instance, patch) {
  return Object.keys(patch).filter((key) => {
    const current = typeof instance.get === 'function' ? instance.get(key) : instance[key];
    const left = dateValue(current);
    const right = dateValue(patch[key]);
    if (left && right) return left.getTime() !== right.getTime();
    return comparable(current) !== comparable(patch[key]);
  });
}

async function reconcile({ apply = false } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const messages = await db.EmailMessage.findAll({
      where: { provider: 'ses' },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const report = {
      mode: apply ? 'apply' : 'dry_run',
      scannedMessages: messages.length,
      changedMessageIds: [],
      changedNotificationDeliveryIds: [],
    };

    for (const message of messages) {
      const events = await db.EmailProviderEvent.findAll({
        where: { email_message_id: message.id },
        order: [['occurred_at', 'ASC'], ['id', 'ASC']],
        transaction,
      });
      const plainEvents = events.map((event) => event.get({ plain: true }));
      const strongest = strongestEvent(plainEvents);
      if (events.length) {
        const patch = messagePatch(message, plainEvents);
        if (changedFields(message, patch).length) {
          report.changedMessageIds.push(message.id);
          if (apply) await message.update(patch, { transaction });
          else Object.assign(message.dataValues, patch);
        }
      }

      if (message.related_type !== 'system_notification' || !db.SystemNotificationDelivery) continue;
      const delivery = await db.SystemNotificationDelivery.findOne({
        where: { email_message_id: message.id, channel: 'email' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!delivery) continue;
      const deliveryPatch = notificationPatch(message, strongest);
      if (changedFields(delivery, deliveryPatch).length) {
        report.changedNotificationDeliveryIds.push(delivery.id);
        if (apply) await delivery.update(deliveryPatch, { transaction });
      }
    }

    return report;
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  try {
    const report = await reconcile({ apply });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error?.code || error?.message || 'email_reconciliation_failed' }));
    process.exitCode = 1;
  });
}

module.exports = {
  canonicalStatus,
  changedFields,
  messagePatch,
  notificationPatch,
  reconcile,
  strongestEvent,
};
