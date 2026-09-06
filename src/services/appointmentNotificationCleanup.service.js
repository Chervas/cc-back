'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { emitNotificationUpdated } = require('./notificationsRealtime.service');

const Notification = db.Notification;

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function markAutomationNotificationsReadForAppointment(appointmentId, options = {}) {
  const numericAppointmentId = toIntOrNull(appointmentId);
  if (!numericAppointmentId || !Notification) {
    return { success: false, skipped: true, reason: 'invalid_appointment' };
  }

  const where = {
    event: { [Op.in]: ['automation.system_notification', 'automation.persistent_alert'] },
    isRead: false,
    [Op.and]: [
      db.sequelize.where(
        db.sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(data, '$.trigger_entity_type'))"),
        'appointment'
      ),
      db.sequelize.where(
        db.sequelize.literal("CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.trigger_entity_id')) AS UNSIGNED)"),
        numericAppointmentId
      ),
    ],
  };

  const notifications = await Notification.findAll({ where });
  if (!notifications.length) {
    return { success: true, updated: 0 };
  }

  const now = new Date();
  await Notification.update(
    {
      isRead: true,
      readAt: now,
      data: db.sequelize.literal(
        `JSON_SET(COALESCE(data, JSON_OBJECT()), '$.auto_read_reason', ${db.sequelize.escape(String(options.reason || 'appointment_resolved'))}, '$.auto_read_at', ${db.sequelize.escape(now.toISOString())})`
      ),
    },
    { where }
  );

  notifications.forEach((notification) => {
    notification.set('isRead', true);
    notification.set('readAt', now);
    const data = notification.get('data') && typeof notification.get('data') === 'object'
      ? { ...notification.get('data') }
      : {};
    notification.set('data', {
      ...data,
      auto_read_reason: String(options.reason || 'appointment_resolved'),
      auto_read_at: now.toISOString(),
    });
    emitNotificationUpdated(notification);
  });

  return { success: true, updated: notifications.length };
}

module.exports = {
  markAutomationNotificationsReadForAppointment,
};
