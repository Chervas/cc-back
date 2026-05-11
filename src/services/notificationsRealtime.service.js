'use strict';

const { getIO } = require('./socket.service');
const { mapNotificationToDto } = require('../lib/notification-dto');

function emitNotificationCreated(notification) {
  emitNotificationEvent(notification, 'notification:created');
}

function emitNotificationUpdated(notification) {
  emitNotificationEvent(notification, 'notification:updated');
}

function emitNotificationEvent(notification, eventName) {
  try {
    const plain = typeof notification?.get === 'function'
      ? notification.get({ plain: true })
      : (notification || {});
    const userId = plain.userId || plain.user_id;
    if (!userId) {
      return;
    }

    const io = getIO();
    if (!io) {
      return;
    }

    io.to(`user:${userId}`).emit(eventName, mapNotificationToDto(notification));
  } catch (error) {
    console.warn('[notifications] realtime emit failed:', error?.message || error);
  }
}

module.exports = {
  emitNotificationCreated,
  emitNotificationUpdated,
};
