'use strict';

// PatientDirectionSettings assigns the person to a clinic. Its is_enabled flag
// governs the separate phone workflow; the director can be assigned before that.
async function recipients(db, clinicId, transaction, {
  featureKey = 'quickchat.read_leads',
  canAccess = require('../lib/access-policy').canUserAccessFeature,
} = {}) {
  const permitted = actorId => canAccess({ actorId, clinicId, featureKey, transaction });
  const activeAccount = alias => ({
    model: db.Usuario, as: alias, required: true, where: { estado_cuenta: 'activo' }, attributes: [],
  });
  const assignment = await db.PatientDirectionSetting.findOne({
    where: { clinic_id: clinicId }, attributes: ['director_user_id'],
    include: [activeAccount('director')], transaction, raw: true,
  });
  if (assignment) {
    const director = await db.PatientDirectionProfile.findOne({
      where: { user_id: assignment.director_user_id, is_active: true },
      attributes: ['user_id'], transaction, raw: true,
    });
    if (director && await permitted(director.user_id)) return { destination: 'patient_director', ids: [director.user_id] };
  }
  const members = await db.UsuarioClinica.findAll({
    where: { id_clinica: clinicId, rol_clinica: 'personaldeclinica', estado_invitacion: 'aceptada',
      subrol_clinica: 'Recepción / Comercial ventas' },
    attributes: ['id_usuario'], include: [activeAccount('Usuario')], transaction, raw: true,
    order: [['id_usuario', 'ASC']],
  });
  const reception = [];
  for (const member of members) {
    if (await permitted(member.id_usuario)) reception.push(member.id_usuario);
  }
  if (reception.length) return { destination: 'reception', ids: reception };
  const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['configuracion'], transaction, raw: true });
  const fallbackId = clinic?.configuracion?.leadAssistantHandoffUserId;
  if (Number.isSafeInteger(fallbackId) && fallbackId > 0) {
    const account = await db.Usuario.findOne({
      where: { id_usuario: fallbackId, estado_cuenta: 'activo' }, attributes: ['id_usuario'], transaction, raw: true,
    });
    if (account && await permitted(account.id_usuario)) return { destination: 'designated_staff', ids: [account.id_usuario] };
  }
  return { destination: 'unassigned', ids: [] };
}

// Open QuickChat threads reload their authorized state after a committed transition.
function refreshAfterCommit(transaction, clinicId, conversationId, messageId) {
  transaction.afterCommit(() => {
    require('./socket.service').getIO()?.to('clinic:' + clinicId).emit('message:updated', {
      id: Number(messageId), conversation_id: Number(conversationId),
    });
  });
}

// Only invoked from the service that holds the assistant's verified turn.
// Keep the owner change, the audit marker and all recipients in one transaction.
async function handoff(db, { clinicId, conversationId, messageId, templateId, version }, {
  prepareReply,
  emitCreated = require('./notificationsRealtime.service').emitNotificationCreated,
  canAccess = require('../lib/access-policy').canUserAccessFeature,
} = {}) {
  return db.sequelize.transaction(async transaction => {
    const locked = { transaction, lock: transaction.LOCK.UPDATE };
    const thread = await db.Conversation.findOne({
      where: { id: conversationId, clinic_id: clinicId }, attributes: ['id', 'channel', 'patient_id'], ...locked,
    });
    if (!thread || !['instagram', 'messenger', 'whatsapp'].includes(thread.channel)) throw new Error('assistant_handoff_scope');
    const session = await db.LeadAssistantSession.findOne({ where: {
      conversation_id: conversationId, clinic_id: clinicId, template_id: templateId, publication_version: version,
    }, ...locked });
    const message = await db.Message.findOne({ where: { id: messageId, conversation_id: conversationId, direction: 'inbound' },
      attributes: ['id', 'metadata'], ...locked });
    if (!session || !message || message.id < session.origin_message_id) throw new Error('assistant_handoff_scope');
    const former = message.metadata?.assistantHandoff;
    if (prepareReply && message.metadata?.assistantHandoffReply?.state === session.state &&
        ['unassigned', 'human'].includes(session.state)) return { ...former, reply: message.metadata.assistantHandoffReply };
    if (session.state === 'human' && former?.recorded) {
      return prepareReply ? { ...former, reply: message.metadata.assistantHandoffReply } : former;
    }
    if (session.state !== 'active' && !(session.state === 'unassigned' && former?.destination === 'unassigned')) {
      return { recorded: false, destination: null };
    }

    const featureKey = thread.patient_id ? 'quickchat.read_patients' : 'quickchat.read_leads';
    const route = await recipients(db, clinicId, transaction, { featureKey, canAccess });
    for (const userId of route.ids) {
      const dedupeKey = 'lead-assistant-handoff:' + [clinicId, conversationId, messageId, userId].join(':');
      const [notification, created] = await db.Notification.findOrCreate({ where: { dedupeKey }, transaction, defaults: {
        dedupeKey, userId, clinicaId: clinicId, category: 'general', event: 'automation.system_notification',
        title: 'Conversación pendiente de atención', message: 'Abre QuickChat para atender esta conversación.',
        icon: 'heroicons_outline:chat-bubble-left-right', level: 'warning',
        data: { source: 'lead_assistant', clinicId, quickChatConversationId: conversationId, quickChatResponseMessageId: messageId },
      } });
      if (created) transaction.afterCommit(() => emitCreated(notification));
    }
    const result = { recorded: route.ids.length > 0, destination: route.destination };
    const state = result.recorded ? 'human' : 'unassigned';
    const prepared = prepareReply?.(result);
    const reply = prepared && { ...prepared, state };
    await message.update({ metadata: {
      ...message.metadata, assistantHandoff: result, ...(reply && { assistantHandoffReply: reply }),
    } }, { transaction });
    await session.update({ state, updated_at: new Date() }, { transaction });
    refreshAfterCommit(transaction, clinicId, conversationId, messageId);
    return reply ? { ...result, reply } : result;
  });
}

async function takeConversation(db, conversation, actorId) {
  return db.sequelize.transaction(async transaction => {
    const locked = { transaction, lock: transaction.LOCK.UPDATE };
    const local = await db.Conversation.findOne({
      where: { id: conversation.id, clinic_id: conversation.clinic_id }, attributes: ['id'], ...locked,
    });
    const session = local && await db.LeadAssistantSession.findOne({
      where: { conversation_id: local.id, clinic_id: conversation.clinic_id }, ...locked,
    });
    if (!session) return null;
    if (session.state === 'operator') return 'operator';
    const origin = await db.Message.findOne({
      where: { id: session.origin_message_id, conversation_id: local.id }, ...locked,
    });
    if (!origin) throw Error('assistant_session_origin_missing');
    await origin.update({ metadata: { ...origin.metadata, assistantOperator: { actorId, at: new Date().toISOString() } } }, { transaction });
    await session.update({ state: 'operator', updated_at: new Date() }, { transaction });
    refreshAfterCommit(transaction, conversation.clinic_id, local.id, origin.id);
    return session.state;
  });
}

module.exports = { recipients, handoff, takeConversation, refreshAfterCommit };
