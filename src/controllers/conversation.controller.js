'use strict';
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { getIO } = require('../services/socket.service');
const whatsappService = require('../services/whatsapp.service');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');

const { Conversation, Message, UsuarioClinica, Paciente, LeadIntake, ConversationRead, Clinica } = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1,44')
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

function roleToPermissions(role) {
  const normalized = String(role || '').toLowerCase();
  if (ROLE_AGGREGATE.includes(normalized)) {
    return { read_patients: true, read_team: true, read_leads: true };
  }
  if (['administrador', 'admin', 'personaldeclinica', 'recepcion', 'assistant', 'auxiliar'].includes(normalized)) {
    return { read_patients: true, read_team: true, read_leads: true };
  }
  if (['doctor', 'medico'].includes(normalized)) {
    return { read_patients: true, read_team: false, read_leads: true };
  }
  return { read_patients: false, read_team: false, read_leads: false };
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

async function enrichConversationUnreadForUser(userId, conversationLike) {
  if (!conversationLike) {
    return conversationLike;
  }

  const plain =
    typeof conversationLike.toJSON === 'function'
      ? conversationLike.toJSON()
      : { ...conversationLike };

  const conversationId = Number(plain.id);
  if (!Number.isFinite(conversationId) || !userId) {
    return plain;
  }

  const unreadMap = await getUnreadCountsByConversation(userId, [conversationId]);
  plain.unread_count = unreadMap.get(conversationId) ?? 0;
  return plain;
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
    const leadId = req.query.lead_id ? Number(req.query.lead_id) : null;

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!clinicIds.length) {
      return res.status(403).json({ error: 'Sin clínicas asignadas' });
    }

    const where = {};
    let patient = null;
    let lead = null;
    let canonicalConversationId = null;
    if (patientId) {
      patient = await Paciente.findByPk(patientId, {
        attributes: ['id_paciente', 'clinica_id', 'telefono_movil'],
        raw: true,
      });
      if (!patient) {
        return res.status(404).json({ error: 'Paciente no encontrado' });
      }
      const parsed = clinic_id && clinic_id !== 'all' ? parseClinicIdsParam(clinic_id) : null;
      const clinicToResolve =
        Array.isArray(parsed) && parsed.length
          ? parsed[0]
          : (clinicIds.includes(patient.clinica_id) ? patient.clinica_id : clinicIds[0]);
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: clinicToResolve,
        contactId: patient.telefono_movil,
        patientId,
        createIfMissing: false,
      });
      canonicalConversationId = canonical?.id || null;
      if (clinic_id && clinic_id !== 'all') {
        if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
          return res.status(403).json({ error: 'Acceso denegado a la clínica' });
        }
        where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
      } else if (!isAggregateAllowed) {
        where.clinic_id = { [Op.in]: clinicIds };
      }
    } else if (leadId) {
      lead = await LeadIntake.findByPk(leadId, {
        attributes: ['id', 'clinica_id', 'telefono'],
        raw: true,
      });
      if (!lead) {
        return res.status(404).json({ error: 'Lead no encontrado' });
      }
      const parsed = clinic_id && clinic_id !== 'all' ? parseClinicIdsParam(clinic_id) : null;
      const clinicToResolve =
        Array.isArray(parsed) && parsed.length
          ? parsed[0]
          : (clinicIds.includes(lead.clinica_id) ? lead.clinica_id : clinicIds[0]);
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: clinicToResolve,
        contactId: lead.telefono,
        leadId,
        createIfMissing: false,
      });
      canonicalConversationId = canonical?.id || null;
      if (clinic_id && clinic_id !== 'all') {
        if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
          return res.status(403).json({ error: 'Acceso denegado a la clínica' });
        }
        where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
      } else if (!isAggregateAllowed) {
        where.clinic_id = { [Op.in]: clinicIds };
      }
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
      // Si la conversación ya está vinculada a un paciente, debe vivir en la pestaña
      // de pacientes y no duplicarse en leads.
      where.lead_id = { [Op.not]: null };
      where.patient_id = null;
    } else if (filter === 'pacientes') {
      where.patient_id = { [Op.not]: null };
    } else if (filter === 'equipo') {
      where.channel = 'internal';
    }

    if (canonicalConversationId) {
      where.id = canonicalConversationId;
    } else if (patientId) {
      where.patient_id = patientId;
    } else if (leadId) {
      where.lead_id = leadId;
    }

    const conversations = await Conversation.findAll({
      where,
      order: [['last_message_at', 'DESC'], ['createdAt', 'DESC'], ['id', 'DESC']],
      include: [
        { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
        { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email'] },
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

exports.getPermissions = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const requestedClinic = req.query?.clinic_id;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);

    if (!clinicIds.length) {
      return res.status(403).json({
        selected_clinic_id: null,
        read_patients: false,
        read_team: false,
        read_leads: false,
        can_use_all_clinics: false,
        effective_role: 'unknown',
      });
    }

    let selectedClinicId = null;
    const parsed = parseClinicIdsParam(requestedClinic);
    if (Array.isArray(parsed) && parsed.length === 1) {
      selectedClinicId = parsed[0];
    }

    const memberships = await UsuarioClinica.findAll({
      where: { id_usuario: userId },
      attributes: ['id_clinica', 'rol_clinica'],
      raw: true,
    });
    const selectedMembership =
      memberships.find((m) => Number(m.id_clinica) === Number(selectedClinicId)) ||
      memberships[0] ||
      null;
    const effectiveRole = String(selectedMembership?.rol_clinica || 'unknown').toLowerCase();
    const perms = roleToPermissions(effectiveRole);

    return res.json({
      selected_clinic_id: selectedClinicId,
      read_patients: perms.read_patients,
      read_team: perms.read_team,
      read_leads: perms.read_leads,
      can_use_all_clinics: !!isAggregateAllowed,
      effective_role: effectiveRole,
    });
  } catch (err) {
    console.error('Error getPermissions', err);
    return res.status(500).json({ error: 'Error obteniendo permisos de conversaciones' });
  }
};

exports.getConversationPermissions = exports.getPermissions;

exports.getMessages = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    let conversation = await Conversation.findByPk(conversationId, {
      include: [
        { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
        { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email'] },
      ],
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    if (conversation.channel === 'whatsapp' && conversation.contact_id) {
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: conversation.clinic_id,
        contactId: conversation.contact_id,
        patientId: conversation.patient_id || null,
        leadId: conversation.lead_id || null,
        createIfMissing: false,
      });
      if (canonical?.id && Number(canonical.id) !== Number(conversation.id)) {
        conversation = await Conversation.findByPk(canonical.id, {
          include: [
            { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
            { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email'] },
          ],
        });
      }
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

    const conversationPayload = await enrichConversationUnreadForUser(userId, conversation);
    return res.json({ conversation: conversationPayload, messages });
  } catch (err) {
    console.error('Error getMessages', err);
    return res.status(500).json({ error: 'Error obteniendo mensajes' });
  }
};

exports.streamMessageMedia = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const messageId = Number(req.params.messageId || req.params.message_id);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      return res.status(400).json({ error: 'message_id_invalid' });
    }

    const message = await Message.findByPk(messageId, { raw: true });
    if (!message) {
      return res.status(404).json({ error: 'message_not_found' });
    }

    const conversation = await Conversation.findByPk(message.conversation_id, { raw: true });
    if (!conversation) {
      return res.status(404).json({ error: 'conversation_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const metadata = message.metadata || {};
    const media = metadata.media || {};
    const kind = String(media.kind || '').toLowerCase();
    const mediaId = String(media.id || '').trim();
    if (kind !== 'audio' || !mediaId) {
      return res.status(410).json({ error: 'audio_unavailable' });
    }

    const clinicConfig = await whatsappService.getClinicConfig(conversation.clinic_id);
    if (!clinicConfig?.accessToken) {
      return res.status(410).json({ error: 'audio_unavailable' });
    }

    try {
      const { buffer, contentType, mediaInfo } = await whatsappService.downloadMediaBuffer({
        mediaId,
        accessToken: clinicConfig.accessToken,
      });
      const mimeType = contentType || mediaInfo?.mime_type || media.mime_type || 'audio/ogg';
      res.set({
        'Content-Type': mimeType,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="whatsapp-audio-${messageId}"`,
      });
      return res.send(buffer);
    } catch (downloadError) {
      const status = downloadError?.response?.status;
      if ([400, 401, 403, 404, 410].includes(Number(status))) {
        return res.status(410).json({ error: 'audio_unavailable' });
      }
      console.error('Error streamMessageMedia', downloadError?.message || downloadError);
      return res.status(502).json({ error: 'audio_download_failed' });
    }
  } catch (err) {
    console.error('Error streamMessageMedia', err);
    return res.status(500).json({ error: 'Error obteniendo audio' });
  }
};

exports.getConversationByPatient = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const patientId = req.params.patientId || req.params.patient_id;
    const patient = await Paciente.findByPk(patientId, {
      attributes: ['id_paciente', 'clinica_id', 'telefono_movil'],
      raw: true,
    });
    const conversation = patient
      ? await findCanonicalWhatsappConversation({
          clinicId: patient.clinica_id,
          contactId: patient.telefono_movil,
          patientId: Number(patientId),
          createIfMissing: false,
        })
      : null;

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

    const conversationPayload = await enrichConversationUnreadForUser(userId, conversation);
    return res.json({ conversation: conversationPayload, messages });
  } catch (err) {
    console.error('Error getConversationByPatient', err);
    return res.status(500).json({ error: 'Error obteniendo conversación' });
  }
};

exports.getConversationByLead = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const leadId = req.params.leadId || req.params.lead_id;
    const lead = await LeadIntake.findByPk(leadId, {
      attributes: ['id', 'clinica_id', 'telefono'],
      raw: true,
    });
    const conversation = lead
      ? await findCanonicalWhatsappConversation({
          clinicId: lead.clinica_id,
          contactId: lead.telefono,
          leadId: Number(leadId),
          createIfMissing: false,
        })
      : null;

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

    const conversationPayload = await enrichConversationUnreadForUser(userId, conversation);
    return res.json({ conversation: conversationPayload, messages });
  } catch (err) {
    console.error('Error getConversationByLead', err);
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

    let conversation = await Conversation.findByPk(conversationId, { transaction });
    if (!conversation) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    if (conversation.channel === 'whatsapp' && conversation.contact_id) {
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: conversation.clinic_id,
        contactId: conversation.contact_id,
        patientId: conversation.patient_id || null,
        leadId: conversation.lead_id || null,
        createIfMissing: false,
        transaction,
      });
      if (canonical?.id) {
        conversation = canonical;
      }
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const isTemplate = useTemplate || message_type === 'template';
    const windowOpen =
      !!conversation.last_inbound_at &&
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
      let preferredPhone = null;
      if (conversation.patient_id) {
        const patient = await Paciente.findByPk(conversation.patient_id, {
          attributes: ['telefono_movil'],
          transaction,
        });
        preferredPhone = patient?.telefono_movil || null;
      }
      if (!preferredPhone && conversation.lead_id) {
        const lead = await LeadIntake.findByPk(conversation.lead_id, {
          attributes: ['telefono'],
          transaction,
        });
        preferredPhone = lead?.telefono || null;
      }
      to = whatsappService.normalizePhoneNumber(preferredPhone)
        || whatsappService.normalizePhoneNumber(conversation.contact_id)
        || null;
      if (!to) {
        await transaction.rollback();
        return res.status(400).json({ error: 'contacto_sin_numero' });
      }
      if (conversation.contact_id !== to) {
        conversation.contact_id = to;
        await conversation.save({ transaction });
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
