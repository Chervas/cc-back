'use strict';

const { eventKey } = require('./socialInboxEvents');
const { incomingDm, matches, sameSignedScope, withdrawalKey, withdrawnEvent } = require('./socialInboxWithdrawal.service');

async function applyWithdrawal(db, marker) {
  const R = db.SocialInboxReceipt;
  return db.sequelize.transaction(async t => {
    const opts = { transaction: t, lock: t.LOCK.UPDATE };
    // Intake, import and removal always lock the original receipt first.
    const original = await R.findByPk(eventKey(marker.event), opts);
    const record = await R.findByPk(marker.key, opts);
    if (!record || record.state !== 'pending') return;
    const { event, route } = record;
    if (record.key !== withdrawalKey(event, route) || event.source !== 'withdrawal' || !incomingDm(event))
      throw Error('social_withdrawal_scope');
    let messageId = null, conversationId = null;
    const originalScope = sameSignedScope(original?.route, route) || (original && !original.route && !original.message_id &&
      original.event.verifiedClinicId === route.clinicId && original.event.verifiedAppId === route.appId);
    if (originalScope && matches(original.event, event)) {
      const clean = withdrawnEvent(original.event);
      if (original.message_id) {
        const stored = await db.Message.findByPk(original.message_id, { attributes: ['conversation_id'], transaction: t });
        const conversation = stored && await db.Conversation.findByPk(stored.conversation_id, opts);
        if (!conversation || (original.event.conversationId != null && original.event.conversationId !== conversation.id) ||
            conversation.clinic_id !== route.clinicId || conversation.channel !== event.channel ||
            conversation.social_account_id !== event.accountId || conversation.contact_id !== event.senderId)
          throw Error('social_withdrawal_scope');
        const message = await db.Message.findByPk(original.message_id, opts);
        if (!message || message.conversation_id !== conversation.id || message.direction !== 'inbound' ||
            message.metadata?.providerId !== event.eventId || !matches(message.metadata.social, event))
          throw Error('social_withdrawal_scope');
        messageId = message.id;
        conversationId = conversation.id;
        Object.assign(clean, { clinicId: route.clinicId, conversationId });
        const meta = { providerId: event.eventId, social: clean };
        if (message.metadata.socialContactOptOut === true || message.metadata.socialLead?.decision?.kind === 'opt_out') {
          meta.socialContactOptOut = true;
          meta.socialLead = { decision: { kind: 'opt_out' } };
        }
        await message.update({ content: 'Mensaje retirado', message_type: 'text', metadata: meta }, { transaction: t });
        const previous = await db.Message.findOne({ where: { conversation_id: conversationId, direction: 'inbound',
          'metadata.social.source': 'new', 'metadata.social.type': 'dm' }, attributes: ['sent_at'],
          order: [['sent_at', 'DESC'], ['id', 'DESC']], transaction: t });
        await conversation.update({ last_inbound_at: previous?.sent_at || null }, { transaction: t });
      }
      await original.update({ state: 'withdrawn', event: clean, reason: null }, { transaction: t });
    }
    await record.update({ state: messageId ? 'notify' : 'withdrawn', message_id: messageId,
      event: messageId ? { ...event, clinicId: route.clinicId, conversationId } : event }, { transaction: t });
  });
}
module.exports = { applyWithdrawal };
