'use strict';

const {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
} = require('../config/notifications.config');

function getEventDefinition(event) {
  return NOTIFICATION_EVENTS.find((item) => item.event === event) || null;
}

function getCategoryDefinition(categoryId) {
  return NOTIFICATION_CATEGORIES.find((item) => item.id === categoryId) || null;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value || new Date().toISOString();
}

function mapNotificationToDto(notification) {
  const plain = typeof notification?.get === 'function'
    ? notification.get({ plain: true })
    : (notification || {});
  const categoryDef = getCategoryDefinition(plain.category);
  const eventDef = getEventDefinition(plain.event);

  return {
    id: String(plain.id),
    title: plain.title,
    description: plain.message,
    time: normalizeTimestamp(plain.createdAt || plain.created_at),
    link: plain.data?.link || null,
    useRouter: Boolean(plain.data?.useRouter),
    icon: plain.icon || categoryDef?.icon || 'heroicons_outline:bell',
    read: Boolean(plain.isRead ?? plain.is_read),
    category: plain.category,
    categoryLabel: categoryDef?.label || plain.category,
    event: plain.event,
    level: plain.level || eventDef?.level || 'info',
    data: plain.data || {},
    clinicaId: plain.clinicaId || plain.clinica_id || null,
  };
}

module.exports = {
  getCategoryDefinition,
  getEventDefinition,
  mapNotificationToDto,
};
