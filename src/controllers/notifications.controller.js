'use strict';

const { Notification } = require('../../models');
const {
  getCategoryDefinition,
  getEventDefinition
} = require('../services/notifications.service');

function mapNotificationToDto(notification) {
  const plain = notification.get({ plain: true });
  const categoryDef = getCategoryDefinition(plain.category);
  const eventDef = getEventDefinition(plain.event);
  return {
    id: String(plain.id),
    title: plain.title,
    description: plain.message,
    time: plain.created_at instanceof Date ? plain.created_at.toISOString() : plain.created_at,
    link: plain.data?.link || null,
    useRouter: Boolean(plain.data?.useRouter),
    icon: plain.icon || categoryDef?.icon || 'heroicons_outline:bell',
    read: Boolean(plain.is_read),
    category: plain.category,
    categoryLabel: categoryDef?.label || plain.category,
    event: plain.event,
    level: plain.level || eventDef?.level || 'info',
    data: plain.data || {},
    clinicaId: plain.clinica_id || null
  };
}

exports.list = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const notifications = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit: 200
    });
    res.json(notifications.map(mapNotificationToDto));
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Error obteniendo notificaciones' });
  }
};

exports.create = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const payload = req.body.notification || req.body;
    const eventDef = getEventDefinition(payload.event || 'custom');
    const category = payload.category || eventDef?.category || 'general';
    const notification = await Notification.create({
      userId,
      role: payload.role || null,
      subrole: payload.subrole || null,
      category,
      event: payload.event || 'custom',
      title: payload.title || 'Notificación',
      message: payload.description || payload.message || '',
      icon: payload.icon || 'heroicons_outline:bell',
      level: payload.level || eventDef?.level || 'info',
      data: payload.data || null,
      clinicaId: payload.clinicaId || null
    });
    res.status(201).json(mapNotificationToDto(notification));
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({ message: 'No se pudo crear la notificación' });
  }
};

exports.update = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const { id, notification } = req.body;
    const existing = await Notification.findOne({ where: { id, user_id: userId } });
    if (!existing) {
      return res.status(404).json({ message: 'Notificación no encontrada' });
    }
    const updates = {};
    if (notification && typeof notification.read === 'boolean') {
      updates.is_read = notification.read;
      updates.read_at = notification.read ? new Date() : null;
    }
    if (notification?.title !== undefined) {
      updates.title = notification.title;
    }
    if (notification?.description !== undefined) {
      updates.message = notification.description;
    }
    if (Object.keys(updates).length) {
      await existing.update(updates);
    }
    const refreshed = await Notification.findByPk(id);
    res.json(mapNotificationToDto(refreshed));
  } catch (error) {
    console.error('Error updating notification:', error);
    res.status(500).json({ message: 'No se pudo actualizar la notificación' });
  }
};

exports.remove = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const id = req.query.id || req.params.id;
    const deleted = await Notification.destroy({ where: { id, user_id: userId } });
    res.json(deleted > 0);
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'No se pudo eliminar la notificación' });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.userData.userId;
    await Notification.update({
      is_read: true,
      read_at: new Date()
    }, {
      where: {
        user_id: userId,
        is_read: false
      }
    });
    res.json(true);
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    res.status(500).json({ message: 'No se pudo marcar como leídas' });
  }
};
