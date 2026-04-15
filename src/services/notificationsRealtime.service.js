'use strict';

const { getIO } = require('./socket.service');
const { mapNotificationToDto } = require('../lib/notification-dto');

function emitNotificationCreated(notification) {
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

    io.to(`user:${userId}`).emit('notification:created', mapNotificationToDto(notification));
  } catch (error) {
    console.warn('[notifications] realtime emit failed:', error?.message || error);
  }
}

module.exports = {
  emitNotificationCreated,
};
