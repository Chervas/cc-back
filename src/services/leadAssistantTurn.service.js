'use strict';

const { randomUUID } = require('node:crypto');
const { commercialOffer, exchangeContext, postReference, respondToLead } = require('./leadAssistantConversation.service');
const { handoff, refreshAfterCommit } = require('./leadAssistantHandoff.service');

async function attend({
  db,
  social,
  execution,
  entry,
  thread,
  saved,
  rule,
  initial,
  blockReason,
  analyze,
  bookingOptions,
  recordHandoff = (scope, prepareReply) => handoff(db, scope, { prepareReply }),
}) {
  const scope = {
    clinicId: thread.clinic_id,
    conversationId: thread.id,
    messageId: entry.messageId,
    templateId: execution.template_version_id,
    version: rule.version,
  };
  const stopped = (reason) => ({ reason, attention: false });
  const { excludedPatient } = require('./leadAssistantBooking.service');
  if (await excludedPatient(db, rule, thread, entry.messageId)) return stopped('assistant_audience_excluded');
  const publication = await db.LeadAssistantPublication.findOne({
    where: { clinic_id: scope.clinicId, version: scope.version },
    attributes: ['fields'],
    raw: true,
  });
  if (!publication) return stopped('assistant_version_unavailable');
  const clinic = await db.Clinica.findByPk(scope.clinicId, {
    attributes: ['nombre_clinica', 'configuracion'],
    raw: true,
  });
  const invalid = await blockReason();
  if (invalid) return stopped(invalid);
  // The conversation row serializes this session. Distinct new threads must not lock the same missing-key range.
  const lockTurn = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async (transaction) => {
    const locked = { transaction, lock: transaction.LOCK.UPDATE };
    const c = await db.Conversation.findByPk(thread.id, locked);
    if (
      !c ||
      c.clinic_id !== scope.clinicId ||
      c.contact_id !== entry.senderId ||
      (entry.channel !== 'whatsapp' && c.social_account_id !== entry.accountId) ||
      c.channel !== entry.channel ||
      (await excludedPatient(db, rule, c, entry.messageId, transaction)) ||
      (await blockReason(transaction))
    )
      return null;
    const message = await db.Message.findOne({
      where: { id: scope.messageId, conversation_id: c.id, direction: 'inbound' },
      ...locked,
    });
    if (
      !message ||
      (entry.channel === 'whatsapp' ? message.metadata?.assistantInbound : message.metadata?.socialLead)
        ?.executionId !== execution.id
    )
      return null;
    let session = await db.LeadAssistantSession.findByPk(c.id, locked);
    if (!session) {
      session = await db.LeadAssistantSession.create(
        {
          conversation_id: c.id,
          clinic_id: scope.clinicId,
          template_id: scope.templateId,
          publication_version: scope.version,
          origin_message_id: message.id,
          origin_input: entry.channel + '_' + entry.type,
          state: 'active',
          updated_at: new Date(),
        },
        { transaction }
      );
      refreshAfterCommit(transaction, c.clinic_id, c.id, message.id);
    }
    if (session.template_id !== scope.templateId || session.publication_version !== scope.version) return null;
    if (session.state !== 'active') {
      const receipt = message.metadata?.assistantHandoffReply;
      if (receipt && ['human', 'unassigned'].includes(session.state) && session.state === receipt.state &&
          receipt.executionId === execution.id && receipt.attemptId === saved.attemptId) return { receipt };
      return null;
    }
    const humanMessage = await db.Message.findOne({
      where: {
        conversation_id: c.id,
        direction: 'outbound',
        id: { [db.Sequelize.Op.gt]: session.origin_message_id },
        status: { [db.Sequelize.Op.ne]: 'failed' },
        [db.Sequelize.Op.and]: [
          db.sequelize.where(
            db.sequelize.fn(
              'COALESCE',
              db.sequelize.fn(
                'JSON_UNQUOTE',
                db.sequelize.fn(
                  'JSON_EXTRACT',
                  db.sequelize.col('metadata'),
                  db.sequelize.literal("'$.source'")
                )
              ),
              ''
            ),
            { [db.Sequelize.Op.ne]: 'automations_v2' }
          ),
        ],
      },
      attributes: ['id'],
      transaction,
    });
    if (humanMessage) {
      await session.update({ state: 'human', updated_at: new Date() }, { transaction });
      refreshAfterCommit(transaction, c.clinic_id, c.id, message.id);
      return null;
    }
    const previous = await db.Message.findOne({
      where: {
        conversation_id: c.id,
        direction: 'inbound',
        id: { [db.Sequelize.Op.lt]: message.id, [db.Sequelize.Op.gte]: session.origin_message_id },
        'metadata.leadAssistantTurn.templateId': scope.templateId,
        'metadata.leadAssistantTurn.publicationVersion': scope.version,
      },
      attributes: ['metadata'],
      order: [['id', 'DESC']],
      transaction,
    });
    const timezone = require('../lib/availability-calendar').resolveClinicTimezone(clinic);
    const priorTurn = previous?.metadata?.leadAssistantTurn;
    const { offer, changed, post } = exchangeContext(publication.fields, entry, {
      promotionKey:priorTurn?.promotionKey,
      postReference:priorTurn?.postReference || postReference(previous?.metadata?.social),
    }, timezone);
    const contextStartId = changed ? message.id : priorTurn?.contextStartId || session.origin_message_id;
    let turn = message.metadata.leadAssistantTurn;
    if (!turn) {
      turn = {
        templateId: scope.templateId,
        publicationVersion: scope.version,
        executionId: execution.id,
        promotionKey: offer?.key || null,
        postReference: post,
        contextStartId,
        timezone,
        imageAttemptId: randomUUID(),
        firstTurn: session.origin_message_id === message.id,
      };
      await message.update({ metadata: { ...message.metadata, leadAssistantTurn: turn } }, { transaction });
    }
    if (turn.executionId !== execution.id || turn.promotionKey !== (offer?.key || null)) return null;
    return { turn, offer, previousAnswer: changed ? null : priorTurn?.answer?.reply || previous?.metadata?.assistantBooking?.reply, originMessageId: turn.contextStartId || contextStartId };
  });
  if (!lockTurn) return stopped('assistant_turn_unavailable');
  if (lockTurn.receipt) return deliverReceipt(lockTurn.receipt);
  const { turn, offer } = lockTurn;
  const commentId = entry.type === 'comment' ? scope.messageId : null;

  // Store the exact acknowledgement with the staff notification. A retry
  // reconciles the same channel attempt without reopening an assistant session.
  async function handoffAndReply(prepare) {
    const destination = await recordHandoff(scope, (route) => {
      const reply = prepare(route);
      return reply && { ...reply, executionId: execution.id, attemptId: saved.attemptId, commentMessageId: commentId };
    });
    return destination.reply ? deliverReceipt(destination.reply) : {
      reason: destination.recorded ? 'assistant_handoff_recorded' : 'assistant_handoff_unassigned',
      attention: false,
    };
  }
  async function deliverReceipt(receipt) {
    const reason = await sessionBlockReason(receipt.state);
    if (reason) return stopped(reason);
    const sent = await social.reply(thread, {
      actorId: execution.created_by, attemptId: receipt.attemptId,
      text: receipt.text, commentMessageId: receipt.commentMessageId,
    }, { executionId: execution.id, blockReason: (transaction) => sessionBlockReason(receipt.state, transaction) });
    return { outcome: sent.outcome, reason: sent.reason || receipt.reason, attention: receipt.attention || sent.outcome !== 'sent' };
  }
  function stillOwnsTurn(transaction) { return sessionBlockReason('active', transaction); }
  async function sessionBlockReason(state, transaction) {
    const blocked = await blockReason(transaction);
    if (blocked) return blocked;
    const active = await db.LeadAssistantSession.findOne({
      where: {
        conversation_id: thread.id,
        clinic_id: scope.clinicId,
        state,
        template_id: scope.templateId,
        publication_version: scope.version,
      },
      attributes: ['conversation_id'],
      transaction,
      raw: true,
    });
    return active ? null : 'assistant_turn_unavailable';
  }
  const plan = await respondToLead({
    entry, fields:publication.fields, clinicName:clinic.nombre_clinica, timezone:turn.timezone,
    offer, firstTurn:turn.firstTurn, previousAnswer:lockTurn.previousAnswer, post:turn.postReference,
    decisionKind:saved.decision.kind, analyze, clinicId:scope.clinicId, groupId:execution.group_id,
    cachedAnswer:turn.answer,
    beforeDispatch:async () => { if (await stillOwnsTurn()) throw Error('assistant_turn_unavailable'); },
    checkWindow:async () => {
      const availability = await social.availability(thread, commentId ? [initial] : []);
      const window = commentId ? availability.comments[commentId] : availability.dm;
      return window?.available ? null : window?.reason || 'reply_unavailable';
    },
    book:(bookingEntry,readHistory) => {
      const previous = initial.metadata?.assistantBooking;
      if (previous?.executionId === execution.id) return {reply:previous.reply};
      return require('./leadAssistantBooking.service').processTurn({
        db, thread, entry:bookingEntry, readHistory, execution, fields:publication.fields, offer,
        scope:{ ...scope, audience:rule.audience, originMessageId:lockTurn.originMessageId, promotionKey:offer?.key },
        blockReason:stillOwnsTurn, availability:async () => !!(await social.availability(thread, [])).dm?.available,
        ...bookingOptions,
      });
    },
    readHistory:async () => {
      const historyRows = await db.Message.findAll({
        where: {
          conversation_id: thread.id,
          direction: 'inbound',
          id: { [db.Sequelize.Op.lt]: scope.messageId, [db.Sequelize.Op.gte]: lockTurn.originMessageId },
          'metadata.leadAssistantTurn.templateId': scope.templateId,
          'metadata.leadAssistantTurn.publicationVersion': scope.version,
        },
        attributes: ['metadata'],
        order: [['id', 'DESC']],
        limit: 6,
      });
      return historyRows.reverse().flatMap((row) => {
        const item = row.metadata?.leadAssistantTurn;
        return item?.answer?.reply && item?.commercialQuestion
          ? [
              { role: 'user', text: item.commercialQuestion },
              { role: 'assistant', text: item.answer.reply },
            ]
          : require('./leadAssistantBooking.service').bookingHistory(row.metadata?.assistantBooking);
      });
    },
    saveAnswer:(answer, userText) => db.sequelize.transaction(async (transaction) => {
      const message = await db.Message.findByPk(scope.messageId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const data = message?.metadata?.leadAssistantTurn;
      if (data?.executionId !== execution.id) throw Error('assistant_turn_unavailable');
      if (data.answer) return data.answer;
      await message.update(
        {
          metadata: {
            ...message.metadata,
            leadAssistantTurn: { ...data, answer, commercialQuestion: userText },
          },
        },
        { transaction }
      );
      return answer;
    }),
  });
  if (plan.kind === 'silent') return stopped(plan.reason);
  if (plan.kind === 'handoff') return handoffAndReply(plan.prepare);
  const { text, image } = plan;
  const selection = image
    ? {
        templateId: scope.templateId,
        version: scope.version,
        executionId: execution.id,
        messageId: scope.messageId,
        key: offer.key,
        id: image.id,
      }
    : null;
  if (selection && entry.channel === 'whatsapp') {
    const delivered = await social.replyWithPromotionImage(
      thread,
      { actorId: execution.created_by, attemptId: turn.imageAttemptId, text, selection },
      { executionId: execution.id, blockReason: stillOwnsTurn }
    );
    return {
      outcome: delivered.outcome,
      reason: delivered.reason || 'assistant_promotion_image',
      attention: delivered.outcome !== 'sent',
    };
  }
  const result = await social.reply(
    thread,
    { actorId: execution.created_by, attemptId: saved.attemptId, text, commentMessageId: commentId },
    { executionId: execution.id, blockReason: stillOwnsTurn }
  );
  if (result.outcome !== 'sent' || !image || entry.type !== 'dm')
    return {
      outcome: result.outcome,
      reason: result.reason || plan.reason,
      attention: result.outcome !== 'sent',
    };
  const attachment = await social.replyWithPromotionImage(
    thread,
    { actorId: execution.created_by, attemptId: turn.imageAttemptId, selection },
    { executionId: execution.id, blockReason: stillOwnsTurn }
  );
  return {
    outcome: result.outcome,
    image: attachment.outcome || 'blocked',
    reason: attachment.reason || 'assistant_promotion_image',
    attention: attachment.outcome !== 'sent',
  };
}

module.exports = { attend, commercialOffer };
