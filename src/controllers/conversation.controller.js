'use strict';
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('../services/queue.service');

const { Conversation, Message, UsuarioClinica, Paciente, Lead } = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];

async function getUserClinics(userId) {
  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });
  const clinicIds = memberships.map((m) => m.id_clinica);
  const roles = memberships.map((m) => m.rol_clinica);
  const isAggregateAllowed = roles.some((r) => ROLE_AGGREGATE.includes(r));
  return { clinicIds, isAggregateAllowed };
}

function ensureAccess({ clinicIds, isAggregateAllowed }, requestedClinicId) {
  if (!requestedClinicId) return false;
  if (requestedClinicId === 'all') return isAggregateAllowed;
  const numericId = Number(requestedClinicId);
  return clinicIds.includes(numericId);
}

exports.listConversations = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinic_id, filter, channel } = req.query;

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!clinicIds.length) {
      return res.status(403).json({ error: 'Sin clínicas asignadas' });
    }

    const where = {};
    if (clinic_id && clinic_id !== 'all') {
      if (!ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
        return res.status(403).json({ error: 'Acceso denegado a la clínica' });
      }
      where.clinic_id = Number(clinic_id);
    } else if (!isAggregateAllowed) {
      where.clinic_id = { [Op.in]: clinicIds };
    }

    if (channel) {
      where.channel = channel;
    }

    if (filter === 'leads') {
      where.lead_id = { [Op.not]: null };
    } else if (filter === 'pacientes') {
      where.patient_id = { [Op.not]: null };
    } else if (filter === 'equipo') {
      where.channel = 'internal';
    }

    const conversations = await Conversation.findAll({
      where,
      order: [['last_message_at', 'DESC']],
      include: [
        { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
        { model: Lead, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email'] },
        {
          model: Message,
          as: 'messages',
          separate: true,
          limit: 1,
          order: [['createdAt', 'DESC']],
          attributes: ['id', 'direction', 'content', 'message_type', 'status', 'sent_at', 'createdAt', 'metadata'],
        },
      ],
    });

    const payload = conversations.map((c) => {
      const data = c.toJSON();
      data.lastMessage = data.messages && data.messages.length ? data.messages[0] : null;
      delete data.messages;
      return data;
    });

    return res.json(payload);
  } catch (err) {
    console.error('Error listConversations', err);
    return res.status(500).json({ error: 'Error obteniendo conversaciones' });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    const conversation = await Conversation.findByPk(conversationId, { raw: true });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const messages = await Message.findAll({
      where: { conversation_id: conversationId },
      order: [['createdAt', 'ASC']],
      raw: true,
    });

    return res.json({ conversation, messages });
  } catch (err) {
    console.error('Error getMessages', err);
    return res.status(500).json({ error: 'Error obteniendo mensajes' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    const conversation = await Conversation.findByPk(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    conversation.unread_count = 0;
    await conversation.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('Error markAsRead', err);
    return res.status(500).json({ error: 'Error marcando conversación como leída' });
  }
};

exports.postMessage = async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    const {
      message,
      message_type = 'text',
      useTemplate = false,
      templateName,
      templateLanguage,
      previewUrl = false,
      metadata = {},
    } = req.body;

    const conversation = await Conversation.findByPk(conversationId, { transaction });
    if (!conversation) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const isTemplate = useTemplate || message_type === 'template';
    const windowOpen =
      !conversation.last_inbound_at ||
      Date.now() - new Date(conversation.last_inbound_at).getTime() <= 24 * 60 * 60 * 1000;

    if (!isTemplate && !windowOpen && conversation.channel === 'whatsapp') {
      await transaction.rollback();
      return res.status(400).json({ error: 'session_closed' });
    }

    // Crear registro de mensaje en estado sending
    const msg = await Message.create(
      {
        conversation_id: conversation.id,
        sender_id: userId || null,
        direction: 'outbound',
        content: message,
        message_type: message_type === 'template' ? 'template' : 'text',
        status: conversation.channel === 'whatsapp' ? 'pending' : 'sent',
        sent_at: new Date(),
        metadata,
      },
      { transaction }
    );

    if (conversation.channel === 'whatsapp') {
      const to = conversation.contact_id;
      if (!to) {
        await transaction.rollback();
        return res.status(400).json({ error: 'contacto_sin_numero' });
      }
      await queues.outboundWhatsApp.add('send', {
        messageId: msg.id,
        conversationId: conversation.id,
        to,
        body: message,
        previewUrl,
        useTemplate: isTemplate,
        templateName,
        templateLanguage,
        clinicConfig: {}, // TODO: credenciales por clínica
      });
    }

    conversation.last_message_at = new Date();
    await conversation.save({ transaction });

    await transaction.commit();
    return res.json({ message: msg, waResponse });
  } catch (err) {
    await transaction.rollback();
    console.error('Error postMessage', err);
    return res.status(500).json({ error: 'Error enviando mensaje' });
  }
};

exports.createInternalMessage = async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const userId = req.userData?.userId;
    const { clinic_id, message } = req.body;
    if (!clinic_id) {
      await transaction.rollback();
      return res.status(400).json({ error: 'clinic_id requerido' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const conversation =
      (await Conversation.findOne({
        where: { clinic_id, channel: 'internal', contact_id: 'team' },
        transaction,
      })) ||
      (await Conversation.create(
        {
          clinic_id,
          channel: 'internal',
          contact_id: 'team',
          last_message_at: new Date(),
        },
        { transaction }
      ));

    const msg = await Message.create(
      {
        conversation_id: conversation.id,
        sender_id: userId || null,
        direction: 'outbound',
        content: message,
        message_type: 'text',
        status: 'sent',
        sent_at: new Date(),
      },
      { transaction }
    );

    conversation.last_message_at = new Date();
    await conversation.save({ transaction });

    await transaction.commit();
    return res.json({ conversation, message: msg });
  } catch (err) {
    await transaction.rollback();
    console.error('Error createInternalMessage', err);
    return res.status(500).json({ error: 'Error en chat interno' });
  }
};
