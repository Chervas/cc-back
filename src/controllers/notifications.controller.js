'use strict';

const { Notification } = require('../../models');
const {
  getEventDefinition
} = require('../services/notifications.service');
const { mapNotificationToDto } = require('../lib/notification-dto');
const { emitNotificationCreated } = require('../services/notificationsRealtime.service');
const { Op } = require('sequelize');
const db = require('../../models');

function withoutPendingAppointmentFollowup() {
  return db.sequelize.literal("(is_read = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.appointment_human_followup')), 'false') <> 'true')");
}
function withoutActiveClinicalReminder(){return db.sequelize.literal("(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.kind')),'')<>'patient_follow_up_reminder' OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.reminder_active')),'false')<>'true')");}

exports.list = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const followUps=require('../services/patientFollowUpNotices.service').current();
    const visibility=await followUps.notificationVisibilityWhere(userId);
    const where={userId,[Op.and]:[visibility]};
    if(req.query.clinic_id!=null){const clinicId=Number(req.query.clinic_id);if(!Number.isSafeInteger(clinicId)||clinicId<1)return res.status(400).json({message:'Clínica no válida.'});
      where.clinicaId=clinicId;}
    if(req.query.paged==='true'){
      const page=Number(req.query.page||0),size=Number(req.query.page_size||25);
      const columns={created_at:'createdAt',title:'title',category:'category',read:'isRead'};
      const column=columns[req.query.sort||'created_at'],direction=String(req.query.direction||'desc').toUpperCase();
      const q=String(req.query.q||'').trim();
      if(!Number.isInteger(page)||page<0||page>10000||!Number.isInteger(size)||size<1||size>100||!column||!['ASC','DESC'].includes(direction)||q.length>150)return res.status(400).json({message:'Filtros o paginación no válidos.'});
      if(![undefined,'','all','read','unread'].includes(req.query.read))return res.status(400).json({message:'Filtro de lectura no válido.'});
      if(req.query.read==='read')where.isRead=true;if(req.query.read==='unread')where.isRead=false;
      if(q){const term='%'+q.replace(/[!%_]/g,'!$&')+'%';where[Op.and].push(db.sequelize.literal(`(title LIKE ${db.sequelize.escape(term)} ESCAPE '!' OR message LIKE ${db.sequelize.escape(term)} ESCAPE '!')`));}
      const result=await Notification.findAndCountAll({where,order:[[column,direction],['id',direction]],limit:size,offset:page*size});
      res.set('Cache-Control','no-store');return res.json({items:result.rows.map(mapNotificationToDto),total:result.count,page,page_size:size});
    }
    const notifications = await Notification.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 200
    });
    await require('../services/recoveredReplyNotifications.service').current()
      .reconcileForUser(notifications,userId).catch(()=>{
        // Uncertain evidence leaves the reviews visible. Do not break the inbox.
        console.warn('[notifications] recovered review reconciliation unavailable');
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
    if(!await require('../services/patientFollowUpNotices.service').current().canReadNotification(existing,userId))return res.status(404).json({message:'Notificación no encontrada'});
    const updates = {};
    if (notification && typeof notification.read === 'boolean') {
      if (notification.read && existing.data?.appointment_human_followup === true && !existing.isRead) {
        updates.data = { ...existing.data, human_followup_seen_at: new Date().toISOString() };
      } else {
        updates.isRead = notification.read;
        updates.readAt = notification.read ? new Date() : null;
      }
    }
    if (notification?.title !== undefined && existing.data?.kind !== 'patient_follow_up_reminder') {
      updates.title = notification.title;
    }
    if (notification?.description !== undefined && existing.data?.kind !== 'patient_follow_up_reminder') {
      updates.message = notification.description;
    }
    if (Object.keys(updates).length) {
      await existing.update(updates);
    }
    const refreshed = await Notification.findByPk(id);
    if(refreshed.data?.kind==='patient_follow_up_reminder')await require('../services/patientFollowUpNotices.service').current().emitSafe(refreshed);
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
    const deleted = await Notification.destroy({ where: { id, userId, [Op.and]: [withoutPendingAppointmentFollowup(),withoutActiveClinicalReminder()] } });
    res.json(deleted > 0);
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'No se pudo eliminar la notificación' });
  }
};

exports.removeAll = async (req, res) => {
  try {
    const userId = req.userData.userId;
    const deleted = await Notification.destroy({ where: { userId, [Op.and]: [withoutPendingAppointmentFollowup(),withoutActiveClinicalReminder()] } });
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
        isRead: false,
        [Op.and]: withoutPendingAppointmentFollowup()
      }
    });
    res.json(true);
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    res.status(500).json({ message: 'No se pudo marcar como leídas' });
  }
};
