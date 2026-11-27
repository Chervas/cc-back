'use strict';

const { randomUUID } = require('node:crypto');
const dialogue = require('./leadAssistantDialogue.service');
const { catalog, offerSections, isOfferActive } = require('./leadAssistantPromotionImages.service');
const { assistantCommercialText } = require('./socialLeadInterestClassification.service');
const { handoff, refreshAfterCommit } = require('./leadAssistantHandoff.service');

function commercialOffer(fields, entry, priorKey, options) {
  const sections = offerSections(fields.promotions);
  const images = catalog(fields.promotions, options, sections);
  const explicit = String(entry.text || '').toUpperCase();
  const origin = [entry.post?.caption, entry.ad?.title, entry.postId].filter(Boolean).join(' ').toUpperCase();
  const matched = (text) =>
    [...sections.keys()].filter((key) => new RegExp('\\b' + key + '\\b', 'i').test(text));
  let matches = matched(explicit);
  if (!matches.length) matches = matched(origin);
  if (!matches.length) {
    const normalize = require('../lib/lead-assistant-tables').normalize;
    const titlesIn = (value) => [...sections].filter(([, item]) => {
      const title = normalize(item.title.split(' · ')[0]);
      return title && (' ' + normalize(value).replace(/[^a-z0-9]+/g, ' ') + ' ').includes(' ' + title.replace(/[^a-z0-9]+/g, ' ') + ' ');
    }).map(([key]) => key);
    matches = titlesIn(explicit);
    if (!matches.length) matches = titlesIn(origin);
  }
  if (!matches.length) {
    const words = (value) =>
      value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .match(/[a-z0-9]+/g) || [];
    const meaningful = (value) =>
      words(value).filter(
        (word) =>
          (word.length > 2 || /^\d+$/.test(word)) &&
          ![
            'una',
            'del',
            'para',
            'con',
            'por',
            'promo',
            'promocion',
            'imagen',
            'foto',
            'cartel',
            'creatividad',
            'figma',
          ].includes(word)
      );
    const requested = meaningful(explicit + ' ' + origin);
    matches = [...sections]
      .filter(([code, lines]) => {
        const aliases = [lines.title.split('.')[0], ...(images.get(code) || []).map((image) => image.label)];
        return aliases.some((alias) => {
          const names = meaningful(alias);
          return (
            (names.length === 1 && requested.includes(names[0])) ||
            names.some(
              (word, i) =>
                i > 0 &&
                requested.some((part, j) => j > 0 && part === word && requested[j - 1] === names[i - 1])
            )
          );
        });
      })
      .map(([code]) => code);
  }
  const key = matches.length === 1 ? matches[0] : !matches.length && sections.has(priorKey) ? priorKey : null;
  if (!key || !isOfferActive(sections.get(key), options)) return null;
  const stripLinks = (line) =>
    line.replace(/!?\[([^\]\n]*)\]\(https?:\/\/[^\s()]+\)/gi, '$1').replace(/https?:\/\/\S+/gi, '');
  const section = sections.get(key);
  const body = [section.preamble, ...section.lines].filter(Boolean).map(stripLinks).join('\n').trim();
  if (!body) return null;
  return {
    key,
    title: sections.get(key).title.split(/[.\n]/)[0].slice(0, 180),
    description: body,
    images: (images.get(key) || []).slice(0, 24),
  };
}

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
  recordHandoff = (scope) => handoff(db, scope),
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
    if (
      session.state !== 'active' ||
      session.template_id !== scope.templateId ||
      session.publication_version !== scope.version
    )
      return null;
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
        id: { [db.Sequelize.Op.lt]: message.id },
        'metadata.leadAssistantTurn.templateId': scope.templateId,
        'metadata.leadAssistantTurn.publicationVersion': scope.version,
      },
      attributes: ['metadata'],
      order: [['id', 'DESC']],
      transaction,
    });
    const timezone = require('../lib/availability-calendar').resolveClinicTimezone(clinic);
    const offer = commercialOffer(
      publication.fields,
      entry,
      previous?.metadata?.leadAssistantTurn?.promotionKey,
      { timezone }
    );
    let turn = message.metadata.leadAssistantTurn;
    if (!turn) {
      turn = {
        templateId: scope.templateId,
        publicationVersion: scope.version,
        executionId: execution.id,
        promotionKey: offer?.key || null,
        timezone,
        imageAttemptId: randomUUID(),
        firstTurn: session.origin_message_id === message.id,
      };
      await message.update({ metadata: { ...message.metadata, leadAssistantTurn: turn } }, { transaction });
    }
    if (turn.executionId !== execution.id || turn.promotionKey !== (offer?.key || null)) return null;
    return { turn, offer, originMessageId: session.origin_message_id };
  });
  if (!lockTurn) return stopped('assistant_turn_unavailable');
  const { turn, offer } = lockTurn;
  const raw = String(entry.text || '').trim();
  const human = raw.length <= 1000 && raw ? dialogue.requestedHumanHandoff(raw) : null;
  const userText = assistantCommercialText(raw);
  let appointment;
  if (entry.type === 'dm' && !human) {
    const previousResult = initial.metadata?.assistantBooking;
    if (previousResult?.executionId === execution.id) appointment = { reply: previousResult.reply };
    else {
      try {
        appointment = await require('./leadAssistantBooking.service').processTurn({
          db,
          thread,
          entry,
          scope: {
            ...scope,
            audience: rule.audience,
            originMessageId: lockTurn.originMessageId,
            promotionKey: offer?.key,
          },
          execution,
          fields: publication.fields,
          offer,
          blockReason: stillOwnsTurn,
          availability: async () => !!(await social.availability(thread, [])).dm?.available,
          ...bookingOptions,
        });
      } catch (error) {
        if (
          !(
            [400, 404, 409, 422].includes(error.status || error.statusCode) &&
            /^(?:booking_|treatment_|appointment_)/.test(error.code || '')
          )
        )
          throw error;
        appointment = { review: true };
      }
    }
    if (appointment?.stop) return stopped(appointment.stop);
    if (appointment?.reply) {
      const text = dialogue.formatCommercialReply({
        firstTurn: turn.firstTurn, tone: publication.fields.tone,
        clinicName: clinic.nombre_clinica,
        draft: appointment.reply,
      });
      const result = await social.reply(
        thread,
        { actorId: execution.created_by, attemptId: saved.attemptId, text, commentMessageId: null },
        { executionId: execution.id, blockReason: stillOwnsTurn }
      );
      return {
        outcome: result.outcome,
        reason: result.reason || 'assistant_booking',
        attention: result.outcome !== 'sent',
      };
    }
  }
  if (appointment?.review || !userText || human || saved.decision.kind === 'review') {
    const destination = await recordHandoff(scope);
    if (destination.recorded && (human || appointment?.review)) {
      const text = dialogue.formatHandoffReceipt({
        firstTurn: turn.firstTurn, tone: publication.fields.tone,
        clinicName: clinic.nombre_clinica,
        recorded: true,
        destination: destination.destination,
        requestedCallback: !!human?.requestedCallback,
      });
      await social.reply(
        thread,
        { actorId: execution.created_by, attemptId: saved.attemptId, text, commentMessageId: null },
        { executionId: execution.id, blockReason }
      );
    }
    return {
      reason: destination.recorded ? 'assistant_handoff_recorded' : 'assistant_handoff_unassigned',
      attention: false,
    };
  }
  async function stillOwnsTurn(transaction) {
    const blocked = await blockReason(transaction);
    if (blocked) return blocked;
    const active = await db.LeadAssistantSession.findOne({
      where: {
        conversation_id: thread.id,
        clinic_id: scope.clinicId,
        state: 'active',
        template_id: scope.templateId,
        publication_version: scope.version,
      },
      attributes: ['conversation_id'],
      transaction,
      raw: true,
    });
    return active ? null : 'assistant_turn_unavailable';
  }
  const commentId = entry.type === 'comment' ? scope.messageId : null;
  if (!turn.answer) {
    const availability = await social.availability(thread, commentId ? [initial] : []);
    const window = commentId ? availability.comments[commentId] : availability.dm;
    if (!window?.available) return stopped(window?.reason || 'reply_unavailable');
  }
  let answer = turn.answer;
  if (!answer) {
    const approvedContext = publication.fields.context.replace(/https?:\/\/\S+/gi, '').trim();
    const facts = [publication.fields.guardrails, publication.fields.booking]
      .filter(Boolean)
      .flatMap((value) => value.replace(/https?:\/\/\S+/g, '').match(/[\s\S]{1,1000}/g) || []);
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
    const history = historyRows.reverse().flatMap((row) => {
      const item = row.metadata?.leadAssistantTurn;
      return item?.answer?.reply && item?.commercialQuestion
        ? [
            { role: 'user', text: item.commercialQuestion },
            { role: 'assistant', text: item.answer.reply },
          ]
        : [];
    });
    const request = dialogue.buildDraftRequest({
      clinicName: clinic.nombre_clinica,
      tone: publication.fields.tone,
      approvedContext,
      approvedFacts: facts,
      matchedPromotion: offer,
      commercialHistory: history,
      userText,
      availableSlots: [],
    });
    const generated = await analyze({
      ...request,
      useCase: 'lead_assistant_reply',
      clinicId: scope.clinicId,
      groupId: execution.group_id,
      beforeDispatch: async () => {
        if (await stillOwnsTurn()) throw Error('assistant_turn_unavailable');
      },
    });
    if (
      typeof generated?.reply !== 'string' ||
      !generated.reply.trim() ||
      generated.reply.length > 800 ||
      !dialogue.supportsQuotedAmounts(generated.reply,[approvedContext,...facts,offer?.description]) ||
      /https?:\/\//i.test(generated.reply)
    )
      return { reason: 'assistant_reply_requires_review', attention: false, ...(await recordHandoff(scope)) };
    const image = offer?.images.find((item) => item.id === generated.imageId);
    answer = { reply: generated.reply.trim(), imageId: image?.id || null };
    answer = await db.sequelize.transaction(async (transaction) => {
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
    });
  }
  const image = offer?.images.find((item) => item.id === answer.imageId);
  let text = dialogue.formatCommercialReply({
    firstTurn: turn.firstTurn, tone: publication.fields.tone,
    clinicName: clinic.nombre_clinica,
    draft: answer.reply,
  });
  if (entry.type === 'comment' && image && text.length + image.url.length + 1 <= 1000)
    text += '\n' + image.url;
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
      reason: result.reason || 'assistant_reply',
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
