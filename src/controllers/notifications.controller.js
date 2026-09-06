'use strict';

const { Notification } = require('../../models');
const {
  getEventDefinition
} = require('../services/notifications.service');
const { mapNotificationToDto } = require('../lib/notification-dto');
const { emitNotificationCreated } = require('../services/notificationsRealtime.service');

exports.list = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const notifications = await Notification.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
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
      role: payload.role || '',
      subrole: payload.subrole || '',
      category,
      event: payload.event || 'custom',
      title: payload.title || 'Notificación',
      message: payload.description || payload.message || '',
      icon: payload.icon || 'heroicons_outline:bell',
      level: payload.level || eventDef?.level || 'info',
      data: payload.data || null,
      clinicaId: payload.clinicaId || null
    });
    emitNotificationCreated(notification);
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
    const existing = await Notification.findOne({ where: { id, userId } });
    if (!existing) {
      return res.status(404).json({ message: 'Notificación no encontrada' });
    }
    const updates = {};
    if (notification && typeof notification.read === 'boolean') {
      updates.isRead = notification.read;
      updates.readAt = notification.read ? new Date() : null;
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
    const deleted = await Notification.destroy({ where: { id, userId } });
    res.json(deleted > 0);
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'No se pudo eliminar la notificación' });
  }
};

exports.removeAll = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const deleted = await Notification.destroy({ where: { userId } });
    res.json({ deleted });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({ message: 'No se pudieron eliminar las notificaciones' });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.userData.userId;
    await Notification.update({
      isRead: true,
      readAt: new Date()
    }, {
      where: {
        userId,
        isRead: false
      }
    });
    res.json(true);
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    res.status(500).json({ message: 'No se pudo marcar como leídas' });
  }
};
