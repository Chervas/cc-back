'use strict';
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { getIO } = require('../services/socket.service');
const whatsappService = require('../services/whatsapp.service');

const { Conversation, Message, UsuarioClinica, Paciente, Lead, ConversationRead, Clinica } = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((n) => !Number.isNaN(n));

async function getUserClinics(userId) {
  const isAdmin = ADMIN_USER_IDS.includes(Number(userId));
  if (isAdmin) {
    const clinics = await Clinica.findAll({ attributes: ['id_clinica'], raw: true });
    return {
      clinicIds: clinics.map((c) => c.id_clinica),
      isAggregateAllowed: true,
    };
  }
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

function parseClinicIdsParam(requestedClinicId) {
  if (requestedClinicId === null || requestedClinicId === undefined) return null;
  if (requestedClinicId === 'all') return 'all';
  const rawParts = String(requestedClinicId)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!rawParts.length) return null;
  const ids = rawParts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (ids.length !== rawParts.length) return null;
  return ids;
}

function ensureAccess({ clinicIds, isAggregateAllowed }, requestedClinicId) {
  if (!requestedClinicId) return false;
  const parsed = parseClinicIdsParam(requestedClinicId);
  if (parsed === 'all') return isAggregateAllowed;
  if (!parsed) return false;
  return parsed.every((id) => clinicIds.includes(id));
}

async function getReadMap(userId, conversationIds) {
  if (!conversationIds.length) return new Map();
  const reads = await ConversationRead.findAll({
    where: {
      user_id: userId,
      conversation_id: { [Op.in]: conversationIds },
    },
    raw: true,
  });
  return new Map(reads.map((r) => [r.conversation_id, r.last_read_at]));
}

async function getUnreadCountForConversation(conversationId, lastReadAt) {
  const where = { conversation_id: conversationId, direction: 'inbound' };
  if (lastReadAt) {
    where.createdAt = { [Op.gt]: lastReadAt };
  }
  return Message.count({ where });
}

async function getUnreadCountsByConversation(userId, conversationIds) {
  const readMap = await getReadMap(userId, conversationIds);
  const counts = await Promise.all(
    conversationIds.map(async (conversationId) => {
      const lastReadAt = readMap.get(conversationId);
      const count = await getUnreadCountForConversation(conversationId, lastReadAt);
      return [conversationId, count];
    })
  );
  return new Map(counts);
}

async function getTotalUnreadCountForUser(userId, clinicIds, isAggregateAllowed, requestedClinicId) {
  const where = {};
  if (requestedClinicId && requestedClinicId !== 'all') {
    const parsed = parseClinicIdsParam(requestedClinicId);
    if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, requestedClinicId)) {
      return 0;
    }
    where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
  } else if (!isAggregateAllowed) {
    where.clinic_id = { [Op.in]: clinicIds };
  }

  const conversations = await Conversation.findAll({
    where,
    attributes: ['id'],
    raw: true,
  });
  const ids = conversations.map((c) => c.id);
  if (!ids.length) return 0;

  const unreadMap = await getUnreadCountsByConversation(userId, ids);
  let total = 0;
  unreadMap.forEach((count) => {
    total += count || 0;
  });
  return total;
}

exports.listConversations = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinic_id, filter, channel } = req.query;
    const patientId = req.query.patient_id ? Number(req.query.patient_id) : null;

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!clinicIds.length) {
      return res.status(403).json({ error: 'Sin clínicas asignadas' });
    }

    const where = {};
    let patient = null;
    if (patientId) {
      patient = await Paciente.findByPk(patientId, {
        attributes: ['id_paciente', 'clinica_id', 'telefono_movil'],
        raw: true,
      });
      if (!patient) {
        return res.status(404).json({ error: 'Paciente no encontrado' });
      }
      if (!ensureAccess({ clinicIds, isAggregateAllowed }, patient.clinica_id)) {
        return res.status(403).json({ error: 'Acceso denegado a la clínica' });
      }
      // Forzar scope a la clínica del paciente para evitar cruces
      where.clinic_id = patient.clinica_id;
      where.patient_id = patientId;
    } else if (clinic_id && clinic_id !== 'all') {
      const parsed = parseClinicIdsParam(clinic_id);
      if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
        return res.status(403).json({ error: 'Acceso denegado a la clínica' });
      }
      where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
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

    // Si se solicita por paciente y no existe conversación, crearla con su móvil
    if (patientId && !conversations.length && patient?.telefono_movil) {
      const normalized = whatsappService.normalizePhoneNumber(patient.telefono_movil) || patient.telefono_movil;
      await Conversation.create({
        clinic_id: patient.clinica_id,
        channel: 'whatsapp',
        contact_id: normalized,
        patient_id: patientId,
        last_message_at: new Date(),
        unread_count: 0,
      });
      // Repetir la consulta ya con la conversación creada
      return exports.listConversations(req, res);
    }

    const conversationIds = conversations.map((c) => c.id);
    const unreadMap = await getUnreadCountsByConversation(userId, conversationIds);

    const payload = conversations.map((c) => {
      const data = c.toJSON();
      data.lastMessage = data.messages && data.messages.length ? data.messages[0] : null;
      delete data.messages;
      data.unread_count = unreadMap.get(data.id) ?? 0;
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

exports.getConversationByPatient = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const patientId = req.params.patientId || req.params.patient_id;

    const conversation = await Conversation.findOne({
      where: { patient_id: patientId },
      order: [['last_message_at', 'DESC']],
      raw: true,
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const messages = await Message.findAll({
      where: { conversation_id: conversation.id },
      order: [['createdAt', 'ASC']],
      raw: true,
    });

    return res.json({ conversation, messages });
  } catch (err) {
    console.error('Error getConversationByPatient', err);
    return res.status(500).json({ error: 'Error obteniendo conversación' });
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

    await ConversationRead.upsert({
      conversation_id: conversation.id,
      user_id: userId,
      last_read_at: new Date(),
    });

    const totalUnread = await getTotalUnreadCountForUser(
      userId,
      clinicIds,
      isAggregateAllowed,
      conversation.clinic_id
    );
    const io = getIO();
    if (io) {
      const room = `user:${userId}`;
      io.to(room).emit('unread:updated', { totalUnreadCount: totalUnread || 0 });
      io.to(room).emit('conversation:updated', {
        id: conversation.id,
        unread_count: 0,
        last_message_at: conversation.last_message_at,
      });
    }
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
      templateParams,
      templateComponents,
      previewUrl = false,
      metadata = {},
    } = req.body;
    let outboundJobPayload = null;

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
        metadata: {
          ...(metadata || {}),
          ...(templateParams ? { templateParams } : {}),
          ...(templateComponents ? { templateComponents } : {}),
        },
      },
      { transaction }
    );

    // Emit creación de mensaje outbound (aplica también a interno/instagram)
    const io = getIO();
    if (io) {
      const room = `clinic:${conversation.clinic_id}`;
      io.to(room).emit('message:created', {
        id: msg.id,
        conversation_id: conversation.id,
        content: msg.content,
        direction: msg.direction,
        message_type: msg.message_type,
        status: msg.status,
        sent_at: msg.sent_at,
      });
    }

    if (conversation.channel === 'whatsapp') {
      const to = conversation.contact_id;
      if (!to) {
        await transaction.rollback();
        return res.status(400).json({ error: 'contacto_sin_numero' });
      }
      const clinicConfig = await whatsappService.getClinicConfig(conversation.clinic_id);
      if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId) {
        await transaction.rollback();
        return res.status(500).json({ error: 'whatsapp_config_missing' });
      }
      // Encolar solo despues del commit para evitar carreras con la transaccion
      outboundJobPayload = {
        messageId: msg.id,
        conversationId: conversation.id,
        to,
        body: message,
        previewUrl,
        useTemplate: isTemplate,
        templateName,
        templateLanguage,
        templateParams,
        templateComponents,
        clinicConfig,
      };
    }

    conversation.last_message_at = new Date();
    await conversation.save({ transaction });

    // No emitir conversation:updated aquí para evitar sobrescribir unread_count del usuario.

    await transaction.commit();

    if (outboundJobPayload) {
      try {
        await queues.outboundWhatsApp.add('send', outboundJobPayload);
      } catch (enqueueErr) {
        console.error('Error encolando outbound WhatsApp', enqueueErr);
        const errorMetadata = {
          ...(msg.metadata || {}),
          enqueue_error: enqueueErr?.message || 'enqueue_failed',
        };
        await Message.update(
          { status: 'failed', metadata: errorMetadata },
          { where: { id: msg.id } }
        );
        const io = getIO();
        if (io) {
          const room = `clinic:${conversation.clinic_id}`;
          io.to(room).emit('message:updated', {
            id: msg.id,
            conversation_id: conversation.id,
            status: 'failed',
          });
        }
        msg.status = 'failed';
        msg.metadata = errorMetadata;
      }
    }

    return res.json({ message: msg });
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
    const io = getIO();
    if (io) {
      const room = `clinic:${conversation.clinic_id}`;
      io.to(room).emit('message:created', {
        id: msg.id,
        conversation_id: conversation.id,
        content: msg.content,
        direction: msg.direction,
        message_type: msg.message_type,
        status: msg.status,
        sent_at: msg.sent_at,
      });
    }
    return res.json({ conversation, message: msg });
  } catch (err) {
    await transaction.rollback();
    console.error('Error createInternalMessage', err);
    return res.status(500).json({ error: 'Error en chat interno' });
  }
};
