'use strict';
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { getIO } = require('../services/socket.service');
const whatsappService = require('../services/whatsapp.service');
const { isGlobalAdmin } = require('../lib/role-helpers');
const {
  buildQuickChatContextFromMemberships,
  canReadConversationInClinic,
} = require('../lib/quickchat-helpers');

const { Conversation, Message, UsuarioClinica, Paciente, Lead, ConversationRead } = db;

async function getUserQuickChatContext(userId) {
  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica', 'subrol_clinica'],
    raw: true,
  });

  return buildQuickChatContextFromMemberships(memberships, {
    isGlobalAdmin: isGlobalAdmin(userId),
  });
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

function parseRequestedClinicScope(context, requestedClinicId) {
  const hasValue =
    requestedClinicId !== null &&
    requestedClinicId !== undefined &&
    String(requestedClinicId).trim() !== '';

  const parsed = parseClinicIdsParam(requestedClinicId);
  if (parsed === 'all') {
    if (!context.canUseAllClinics) {
      return { ok: false, reason: 'aggregate_disabled' };
    }
    return { ok: true, clinicIds: context.clinicIds };
  }

  if (!hasValue) {
    if (!context.canUseAllClinics) {
      return { ok: false, reason: 'clinic_required' };
    }
    return { ok: true, clinicIds: context.clinicIds };
  }

  if (!parsed) {
    return { ok: false, reason: 'invalid' };
  }

  const uniqueIds = Array.from(new Set(parsed));
  const allAllowed = uniqueIds.every((id) => context.clinicIds.includes(id));
  if (!allAllowed) {
    return { ok: false, reason: 'forbidden' };
  }

  return { ok: true, clinicIds: uniqueIds };
}

function canReadTeamInClinic(context, clinicId) {
  return !!context.permissionsByClinic.get(Number(clinicId))?.readTeam;
}

function canReadPatientsInClinic(context, clinicId) {
  return !!context.permissionsByClinic.get(Number(clinicId))?.readPatients;
}

function resolvePermissionScope(context, clinicIds) {
  const selected = new Set((clinicIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)));
  const teamClinicIds = context.teamClinicIds.filter((id) => selected.has(id));
  const patientClinicIds = context.patientClinicIds.filter((id) => selected.has(id));
  return {
    teamClinicIds,
    patientClinicIds,
    readableClinicIds: Array.from(new Set([...teamClinicIds, ...patientClinicIds])),
  };
}

function getScopeErrorResponse(reason) {
  if (reason === 'invalid') {
    return { status: 400, body: { error: 'clinic_id inválido' } };
  }
  if (reason === 'forbidden') {
    return { status: 403, body: { error: 'Acceso denegado a la clínica' } };
  }
  return null;
}

async function requireConversationReadAccess(userId, conversation) {
  const context = await getUserQuickChatContext(userId);
  if (!context.hasAnyRead) {
    return { ok: false, status: 403, error: 'QuickChat no habilitado para este usuario' };
  }

  const clinicId = Number(conversation?.clinic_id);
  if (!Number.isFinite(clinicId) || !context.clinicIds.includes(clinicId)) {
    return { ok: false, status: 403, error: 'Acceso denegado a la clínica' };
  }

  if (!canReadConversationInClinic(context.permissionsByClinic, clinicId, conversation)) {
    return { ok: false, status: 403, error: 'No tienes permisos para este tipo de conversación' };
  }

  return { ok: true, context };
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

async function getTotalUnreadCountForUser(userId, context, requestedClinicId) {
  if (!context?.hasAnyRead) return 0;

  let scopeClinicIds = context.clinicIds;
  if (requestedClinicId && requestedClinicId !== 'all') {
    const parsed = parseClinicIdsParam(requestedClinicId);
    if (!parsed) return 0;
    const uniqueIds = Array.from(new Set(parsed));
    const allAllowed = uniqueIds.every((id) => context.clinicIds.includes(id));
    if (!allAllowed) return 0;
    scopeClinicIds = uniqueIds;
  }

  const permissionScope = resolvePermissionScope(context, scopeClinicIds);
  if (!permissionScope.readableClinicIds.length) return 0;

  const clauses = [];
  if (permissionScope.teamClinicIds.length) {
    clauses.push({
      clinic_id: { [Op.in]: permissionScope.teamClinicIds },
      channel: 'internal',
    });
  }
  if (permissionScope.patientClinicIds.length) {
    clauses.push({
      clinic_id: { [Op.in]: permissionScope.patientClinicIds },
      channel: { [Op.ne]: 'internal' },
    });
  }
  if (!clauses.length) return 0;

  const where = clauses.length === 1 ? clauses[0] : { [Op.or]: clauses };

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

exports.getConversationPermissions = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const context = await getUserQuickChatContext(userId);
    const scope = parseRequestedClinicScope(context, req.query?.clinic_id);
    const scopeError = getScopeErrorResponse(scope.reason);
    if (scopeError) {
      return res.status(scopeError.status).json(scopeError.body);
    }

    const selectedClinicIds = scope.ok ? scope.clinicIds : [];
    const selectedPermissions = resolvePermissionScope(context, selectedClinicIds);

    return res.json({
      can_use_all_clinics: context.canUseAllClinics,
      has_quickchat_access: context.hasAnyRead,
      has_agencia_role: context.hasAgenciaRole,
      clinics: context.clinicIds.map((clinicId) => {
        const role = context.roleByClinic.get(clinicId) || {};
        const permissions = context.permissionsByClinic.get(clinicId) || {};
        return {
          clinic_id: clinicId,
          rol_clinica: role.rol_clinica || null,
          subrol_clinica: role.subrol_clinica || null,
          quickchat: {
            read_team: !!permissions.readTeam,
            read_patients: !!permissions.readPatients,
          },
        };
      }),
      selected: {
        clinic_ids: selectedClinicIds,
        read_team: selectedPermissions.teamClinicIds.length > 0,
        read_patients: selectedPermissions.patientClinicIds.length > 0,
      },
    });
  } catch (err) {
    console.error('Error getConversationPermissions', err);
    return res.status(500).json({ error: 'Error obteniendo permisos de QuickChat' });
  }
};

exports.listConversations = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinic_id, filter, channel } = req.query;
    const patientId = req.query.patient_id ? Number(req.query.patient_id) : null;

    const context = await getUserQuickChatContext(userId);
    if (!context.hasAnyRead) {
      return res.json([]);
    }

    const clinicScope = parseRequestedClinicScope(context, clinic_id);
    const scopeError = getScopeErrorResponse(clinicScope.reason);
    if (scopeError) {
      return res.status(scopeError.status).json(scopeError.body);
    }
    if (!clinicScope.ok) {
      return res.json([]);
    }

    let scopedClinicIds = clinicScope.clinicIds;
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
      const patientClinicId = Number(patient.clinica_id);
      if (!scopedClinicIds.includes(patientClinicId)) {
        return res.status(403).json({ error: 'Acceso denegado a la clínica' });
      }
      if (!canReadPatientsInClinic(context, patientClinicId)) {
        return res.status(403).json({ error: 'No tienes permisos para ver conversaciones de pacientes' });
      }

      // Forzar scope a la clínica del paciente para evitar cruces
      where.clinic_id = patientClinicId;
      where.patient_id = patientId;
      scopedClinicIds = [patientClinicId];
    }

    if (channel) {
      where.channel = channel;
    }

    const permissionScope = resolvePermissionScope(context, scopedClinicIds);
    if (!patientId) {
      if (filter === 'equipo') {
        if (!permissionScope.teamClinicIds.length) {
          return res.json([]);
        }
        where.clinic_id =
          permissionScope.teamClinicIds.length === 1
            ? permissionScope.teamClinicIds[0]
            : { [Op.in]: permissionScope.teamClinicIds };
        where.channel = 'internal';
      } else if (filter === 'pacientes') {
        if (!permissionScope.patientClinicIds.length) {
          return res.json([]);
        }
        where.clinic_id =
          permissionScope.patientClinicIds.length === 1
            ? permissionScope.patientClinicIds[0]
            : { [Op.in]: permissionScope.patientClinicIds };
        where.patient_id = { [Op.not]: null };
      } else if (filter === 'leads') {
        if (!permissionScope.patientClinicIds.length) {
          return res.json([]);
        }
        where.clinic_id =
          permissionScope.patientClinicIds.length === 1
            ? permissionScope.patientClinicIds[0]
            : { [Op.in]: permissionScope.patientClinicIds };
        where.lead_id = { [Op.not]: null };
      } else {
        if (!permissionScope.readableClinicIds.length) {
          return res.json([]);
        }
        where.clinic_id =
          permissionScope.readableClinicIds.length === 1
            ? permissionScope.readableClinicIds[0]
            : { [Op.in]: permissionScope.readableClinicIds };
      }
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

    const visibleConversations = conversations.filter((conversation) =>
      canReadConversationInClinic(context.permissionsByClinic, conversation.clinic_id, conversation)
    );

    // Si se solicita por paciente y no existe conversación, crearla con su móvil
    if (patientId && !visibleConversations.length && patient?.telefono_movil) {
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

    const conversationIds = visibleConversations.map((c) => c.id);
    const unreadMap = await getUnreadCountsByConversation(userId, conversationIds);

    const payload = visibleConversations.map((c) => {
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

    const access = await requireConversationReadAccess(userId, conversation);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
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

    const access = await requireConversationReadAccess(userId, conversation);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
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

    const access = await requireConversationReadAccess(userId, conversation);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    await ConversationRead.upsert({
      conversation_id: conversation.id,
      user_id: userId,
      last_read_at: new Date(),
    });

    const totalUnread = await getTotalUnreadCountForUser(
      userId,
      access.context,
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

    const access = await requireConversationReadAccess(userId, conversation);
    if (!access.ok) {
      await transaction.rollback();
      return res.status(access.status).json({ error: access.error });
    }

    const isTemplate = useTemplate || message_type === 'template';
    const windowOpen =
      !conversation.last_inbound_at ||
      Date.now() - new Date(conversation.last_inbound_at).getTime() <= 24 * 60 * 60 * 1000;

    if (!isTemplate && !windowOpen && conversation.channel === 'whatsapp') {
      await transaction.rollback();
      return res.status(400).json({ error: 'session_closed' });
    }

    const io = getIO();
    let clinicConfig = null;
    let limitStatus = null;
    let to = null;
    if (conversation.channel === 'whatsapp') {
      to = conversation.contact_id;
      if (!to) {
        await transaction.rollback();
        return res.status(400).json({ error: 'contacto_sin_numero' });
      }
      clinicConfig = await whatsappService.getClinicConfig(conversation.clinic_id);
      if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId) {
        await transaction.rollback();
        return res.status(500).json({ error: 'whatsapp_config_missing' });
      }
      limitStatus = await whatsappService.checkOutboundLimit({
        clinicConfig,
        conversation,
      });
    }

    const baseMetadata = {
      ...(metadata || {}),
      ...(templateParams ? { templateParams } : {}),
      ...(templateComponents ? { templateComponents } : {}),
      ...(clinicConfig?.phoneNumberId
        ? { phoneNumberId: clinicConfig.phoneNumberId }
        : {}),
      ...(clinicConfig?.wabaId ? { wabaId: clinicConfig.wabaId } : {}),
      ...(limitStatus?.limitedMode
        ? {
            limitedMode: true,
            limitSnapshot: {
              count: limitStatus.count,
              limit: limitStatus.limit,
            },
          }
        : {}),
    };

    // Si el numero esta en modo limitado y se alcanzo el cupo, cortamos el envio
    if (limitStatus?.limitReached) {
      const limitMeta = {
        ...baseMetadata,
        limitReason: 'limit_reached',
        limitExceededAt: new Date().toISOString(),
      };
      const limitedMsg = await Message.create(
        {
          conversation_id: conversation.id,
          sender_id: userId || null,
          direction: 'outbound',
          content: message,
          message_type: message_type === 'template' ? 'template' : 'text',
          status: 'failed',
          sent_at: new Date(),
          metadata: limitMeta,
        },
        { transaction }
      );

      conversation.last_message_at = new Date();
      await conversation.save({ transaction });
      await transaction.commit();

      if (io) {
        const room = `clinic:${conversation.clinic_id}`;
        const payload = {
          id: limitedMsg.id,
          conversation_id: conversation.id,
          content: limitedMsg.content,
          direction: limitedMsg.direction,
          message_type: limitedMsg.message_type,
          status: limitedMsg.status,
          sent_at: limitedMsg.sent_at,
        };
        io.to(room).emit('message:created', payload);
        io.to(room).emit('message:updated', {
          id: limitedMsg.id,
          conversation_id: conversation.id,
          status: 'failed',
          error: 'limit_reached',
          limit: {
            count: limitStatus.count,
            limit: limitStatus.limit,
          },
        });
      }

      return res.status(429).json({
        error: 'limit_reached',
        limit: limitStatus,
        message: limitedMsg,
      });
    }

    // Crear registro de mensaje en estado pending/sent
    const msg = await Message.create(
      {
        conversation_id: conversation.id,
        sender_id: userId || null,
        direction: 'outbound',
        content: message,
        message_type: message_type === 'template' ? 'template' : 'text',
        status: conversation.channel === 'whatsapp' ? 'pending' : 'sent',
        sent_at: new Date(),
        metadata: baseMetadata,
      },
      { transaction }
    );

    // Emit creación de mensaje outbound (aplica también a interno/instagram)
    if (io) {
      const rooms = new Set();
      if (conversation.clinic_id) rooms.add(`clinic:${conversation.clinic_id}`);
      if (conversation.assignee_id) rooms.add(`user:${conversation.assignee_id}`);
      const payload = {
        id: msg.id,
        conversation_id: String(conversation.id),
        content: msg.content,
        direction: msg.direction,
        message_type: msg.message_type,
        status: msg.status,
        sent_at: msg.sent_at,
      };
      if (rooms.size === 0) {
        io.emit('message:created', payload);
        if (process.env.CHAT_DEBUG === 'true') {
          console.log('[CHAT] Emit outbound message:created broadcast', { payload });
        }
      } else {
        rooms.forEach((r) => io.to(r).emit('message:created', payload));
        if (process.env.CHAT_DEBUG === 'true') {
          console.log('[CHAT] Emit outbound message:created rooms', { rooms: Array.from(rooms), payload });
        }
      }
    }

    if (conversation.channel === 'whatsapp') {
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

    const context = await getUserQuickChatContext(userId);
    const clinicId = Number(clinic_id);
    if (!Number.isFinite(clinicId) || !context.clinicIds.includes(clinicId)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    if (!canReadTeamInClinic(context, clinicId)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'No tienes permisos para conversaciones de equipo' });
    }

    const conversation =
      (await Conversation.findOne({
        where: { clinic_id: clinicId, channel: 'internal', contact_id: 'team' },
        transaction,
      })) ||
      (await Conversation.create(
        {
          clinic_id: clinicId,
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
