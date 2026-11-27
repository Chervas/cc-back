'use strict';

// PatientDirectionSettings assigns the person to a clinic. Its is_enabled flag
// governs the separate phone workflow; the director can be assigned before that.
async function recipients(db, clinicId, transaction) {
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
    if (director) return { destination: 'patient_director', ids: [director.user_id] };
  }
  const members = await db.UsuarioClinica.findAll({
    where: { id_clinica: clinicId, rol_clinica: 'personaldeclinica', estado_invitacion: 'aceptada',
      subrol_clinica: 'Recepción / Comercial ventas' },
    attributes: ['id_usuario'], include: [activeAccount('Usuario')], transaction, raw: true,
    order: [['id_usuario', 'ASC']],
  });
  return { destination: members.length ? 'reception' : 'unassigned', ids: members.map(member => member.id_usuario) };
}

// Only invoked from the service that holds the assistant's verified turn.
// Keep the owner change, the audit marker and all recipients in one transaction.
async function handoff(db, { clinicId, conversationId, messageId, templateId, version }, {
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
    if (session.state === 'human' && former?.recorded) return former;
    if (session.state !== 'active' && !(session.state === 'unassigned' && former?.destination === 'unassigned')) {
      return { recorded: false, destination: null };
    }

    const route = await recipients(db, clinicId, transaction);
    const featureKey = thread.patient_id ? 'quickchat.read_patients' : 'quickchat.read_leads';
    let delivered = 0;
    for (const userId of route.ids) {
      if (!await canAccess({ actorId: userId, featureKey, clinicId, transaction })) continue;
      const dedupeKey = 'lead-assistant-handoff:' + [clinicId, conversationId, messageId, userId].join(':');
      const [notification, created] = await db.Notification.findOrCreate({ where: { dedupeKey }, transaction, defaults: {
        dedupeKey, userId, clinicaId: clinicId, category: 'general', event: 'automation.system_notification',
        title: 'Conversación pendiente de atención', message: 'Abre QuickChat para atender esta conversación.',
        icon: 'heroicons_outline:chat-bubble-left-right', level: 'warning',
        data: { source: 'lead_assistant', clinicId, quickChatConversationId: conversationId, quickChatResponseMessageId: messageId },
      } });
      delivered++;
      if (created) transaction.afterCommit(() => emitCreated(notification));
    }
    const result = { recorded: delivered > 0, destination: delivered ? route.destination : 'unassigned' };
    await message.update({ metadata: { ...message.metadata, assistantHandoff: result } }, { transaction });
    await session.update({ state: result.recorded ? 'human' : 'unassigned', updated_at: new Date() }, { transaction });
    return result;
  });
}

module.exports = { recipients, handoff };
