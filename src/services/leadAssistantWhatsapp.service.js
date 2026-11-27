'use strict';

const { randomUUID } = require('node:crypto');
const { phone, parseContact } = require('../lib/whatsapp-contact-identity');
const {
  extractWhatsappPhoneNumberId,
  resolveWhatsappReplySender,
  DEFAULT_WINDOW_MS,
} = require('./whatsappServiceWindow.service');
const { resolveForTurn } = require('./leadAssistantPromotionImages.service');
const { assistantCommercialText, explicitOptOut } = require('./socialLeadInterestClassification.service');
const { enqueueInboundExecution } = require('./leadAssistantExecution.service');

function inbound(claim, message, conversation) {
  const meta = message?.metadata;
  if (
    conversation?.channel !== 'whatsapp' ||
    claim?.channel !== 'whatsapp' ||
    claim.clinic_id !== conversation.clinic_id ||
    claim.conversation_id !== conversation.id ||
    claim.message_id !== message?.id ||
    message.conversation_id !== conversation.id ||
    message.direction !== 'inbound' ||
    message.message_type !== 'text' ||
    !message.content ||
    !/^wamid\.[A-Za-z0-9+/=_:.-]{1,500}$/.test(meta?.wamid || '') ||
    meta.wamid !== claim.provider_message_id ||
    meta.historical ||
    meta.recovery_without_automation ||
    meta.automatic_actions_allowed === false ||
    (meta.passive_recovery && !meta.fresh_inbound_authorization_id)
  )
    return null;
  const accountId = extractWhatsappPhoneNumberId(meta);
  const timestamp = meta.passive_recovery ? message.sent_at : meta.provider_sent_at;
  const at = new Date(timestamp).getTime();
  if (
    !accountId ||
    !timestamp ||
    !Number.isFinite(at) ||
    at > Date.now() ||
    at + DEFAULT_WINDOW_MS <= Date.now()
  )
    return null;
  return {
    messageId: message.id,
    senderId: conversation.contact_id,
    accountId,
    type: 'dm',
    channel: 'whatsapp',
    at,
    expiresAt: new Date(at + DEFAULT_WINDOW_MS).toISOString(),
    text: message.content,
  };
}

async function route(conversation, phoneId, transaction) {
  const whatsapp = require('./whatsapp.service');
  const policy = await require('./patientDirection.service').resolveOutboundPolicy({
    clinicId: conversation.clinic_id,
    phone: phone(conversation.contact_id),
    conversationId: conversation.id,
    leadId: conversation.lead_id,
    patientId: conversation.patient_id,
    purpose: conversation.lead_id ? 'lead_capture' : 'general',
    automation: true,
    previewOnly: true,
  });
  const { clinicConfig, serviceWindow } = await resolveWhatsappReplySender({
    conversation,
    clinicConfig: policy.clinicConfig,
    transaction,
    getSecondaryConfig:
      policy.mode === 'clinic_default' && !policy.assignment
        ? () => whatsapp.getClinicConfig(conversation.clinic_id, { secondaryOnly: true })
        : null,
  });
  return !policy.requiresTakeConfirmation &&
    clinicConfig?.authorizedBroker?.sendEnabled &&
    clinicConfig.phoneNumberId === phoneId &&
    serviceWindow.open &&
    serviceWindow.matchedBy === 'message_phone_number_id' &&
    Date.parse(serviceWindow.lastInboundAt) + DEFAULT_WINDOW_MS > Date.now()
    ? clinicConfig
    : null;
}

async function plan(db, thread, entry, transaction) {
  const flow = await db.AutomationFlowTemplateV2.findOne({
    where: {
      clinic_id: thread.clinic_id,
      template_key: 'lead_auto_reply_system__clinic_' + thread.clinic_id,
      published_at: { [db.Sequelize.Op.ne]: null },
    },
    order: [['version', 'DESC']],
    transaction,
  });
  const rule = flow?.trigger_config?.social_entries?.whatsapp_dm;
  if (
    !flow?.is_active ||
    flow.is_system ||
    !flow.trigger_config?.configured ||
    flow.trigger_config?.managed_feature !== 'lead_auto_reply' ||
    +new Date(flow.published_at) > entry.at ||
    rule?.action !== 'assistant' ||
    !Number.isSafeInteger(rule.version) ||
    !['all','leads'].includes(rule.audience) ||
    await require('./leadAssistantBooking.service').excludedPatient(db,rule,thread,entry.messageId,transaction) ||
    explicitOptOut(entry.text)
  )
    return null;
  return { flow, rule };
}

async function supersedingReply(db, conversationId, messageId, executionId, transaction) {
  if (
    await db.Message.count({
      where: {
        conversation_id: conversationId,
        direction: 'inbound',
        id: { [db.Sequelize.Op.gt]: messageId },
      },
      transaction,
    })
  )
    return 'newer_inbound';
  const other = await db.Message.findOne({
    where: {
      conversation_id: conversationId,
      direction: 'outbound',
      id: { [db.Sequelize.Op.gt]: messageId },
      status: { [db.Sequelize.Op.ne]: 'failed' },
      [db.Sequelize.Op.and]: db.sequelize.where(
        db.sequelize.fn(
          'COALESCE',
          db.sequelize.fn(
            'JSON_UNQUOTE',
            db.sequelize.fn(
              'JSON_EXTRACT',
              db.sequelize.col('metadata'),
              db.sequelize.literal("'$.execution_id'")
            )
          ),
          ''
        ),
        { [db.Sequelize.Op.ne]: String(executionId) }
      ),
    },
    attributes: ['id'],
    transaction,
  });
  return other ? 'already_replied' : null;
}

async function authorizeDelivery(db, { message, conversation, intent, selectedBinding }) {
  const marker = message.metadata?.leadAssistantReply;
  const payload = intent.message;
  if (
    !marker ||
    !intent.replyWindowEndsAt ||
    intent.replyWindowEndsAt !== marker.expiresAt ||
    Date.parse(marker.expiresAt) <= Date.now() ||
    selectedBinding.phoneId !== marker.phoneId ||
    message.metadata.source !== 'automations_v2' ||
    message.message_type !== payload.type ||
    message.content !== (payload.text?.body || payload.image?.caption) ||
    (parseContact(conversation.contact_id)
      ? parseContact(conversation.contact_id).bsuid !== payload.recipient
      : !phone(conversation.contact_id) || phone(conversation.contact_id) !== phone(payload.to))
  )
    return false;
  const original = await db.Message.findOne({
    where: { id: marker.messageId, conversation_id: conversation.id, direction: 'inbound' },
  });
  const claim = await db.AutomationInboundMessageClaim.findByPk(marker.claimId);
  const entry = inbound(claim, original, conversation);
  if (
    !entry ||
    entry.accountId !== selectedBinding.phoneId ||
    entry.expiresAt !== marker.expiresAt ||
    original.metadata.assistantInbound?.executionId !== message.metadata.execution_id
  )
    return false;
  const configured = await plan(db, conversation, entry);
  if (!configured || configured.flow.id !== marker.templateId || configured.rule.version !== marker.version)
    return false;
  if (await supersedingReply(db, conversation.id, entry.messageId, message.metadata.execution_id))
    return false;
  if (payload.type === 'text') return !marker.selection && !message.metadata.promotionImage;
  const image = await resolveForTurn(db, conversation, marker.selection);
  return (
    !!image &&
    marker.selection.executionId === message.metadata.execution_id &&
    marker.selection.messageId === entry.messageId &&
    image.id === original.metadata.leadAssistantTurn?.answer?.imageId &&
    image.url === message.metadata.promotionImage?.url &&
    image.url === payload.image?.link
  );
}

function create({
  db,
  createExecution,
  enqueueJob,
  analyze,
  resolveRoute = route,
  send = (args) => require('./whatsapp.service').sendMessage(args),
  restrictions = (thread, transaction) =>
    require('./marketingOptOut.service').getActiveContactRestrictionsForPatient(
      {
        clinicIds: [thread.clinic_id],
        patientId: thread.patient_id,
        phone: phone(thread.contact_id),
      },
      transaction
    ),
  refresh = (thread, message) =>
    require('./socket.service').emit('message:refresh', { id: message.id, conversation_id: thread.id }, [
      'clinic:' + thread.clinic_id,
    ]),
}) {
  async function start({ claim, message, conversation }) {
    const entry = inbound(claim, message, conversation);
    const configured = entry && (await plan(db, conversation, entry));
    if (!configured) return null;
    const { flow } = configured;
    return enqueueInboundExecution({
      db,
      createExecution,
      enqueueJob,
      flow,
      clinicId: conversation.clinic_id,
      messageId: message.id,
      idempotencyKey: 'lead_assistant_whatsapp:' + claim.id,
      entryNodeId: flow.entry_node_id,
      origin: 'lead_assistant',
      context: {
        trigger: {
          type: 'mensaje_recibido',
          data: {
            event_kind: 'whatsapp_dm',
            claim_id: claim.id,
            conversation_id: conversation.id,
            message_id: message.id,
          },
        },
        conversation: { id: conversation.id, channel: 'whatsapp' },
        outputs: {},
      },
    });
  }

  async function run(execution) {
    const data = execution.context?.trigger?.data || {};
    const claim = await db.AutomationInboundMessageClaim.findByPk(data.claim_id);
    const thread = await db.Conversation.findByPk(data.conversation_id);
    const initial = await db.Message.findByPk(data.message_id);
    const entry = inbound(claim, initial, thread);
    if (
      !entry ||
      execution.idempotency_key !== 'lead_assistant_whatsapp:' + claim.id ||
      execution.trigger_type !== 'mensaje_recibido' ||
      execution.clinic_id !== thread.clinic_id ||
      execution.trigger_entity_id !== initial.id
    )
      return { reason: 'whatsapp_entry_unavailable' };
    const configured = await plan(db, thread, entry);
    if (configured?.flow.id !== execution.template_version_id) return { reason: 'automation_inactive' };
    const rule = configured.rule;
    async function blockReason(transaction) {
      const c = await db.Conversation.findByPk(thread.id, { transaction });
      const active = c && (await plan(db, c, entry, transaction));
      if (
        !active ||
        active.flow.id !== execution.template_version_id ||
        active.rule.version !== rule.version ||
        c.contact_id !== entry.senderId ||
        !(await db.FlowExecutionV2.count({
          where: {
            id: execution.id,
            status: 'running',
            clinic_id: c.clinic_id,
            template_version_id: active.flow.id,
          },
          transaction,
        }))
      )
        return 'automation_inactive';
      if (Date.parse(entry.expiresAt) <= Date.now()) return 'dm_window_closed';
      const held = await restrictions(c, transaction);
      if (held.marketing_opt_out || held.whatsapp_number_invalid || held.whatsapp_channel_opt_out)
        return 'marketing_opt_out';
      return supersedingReply(db, c.id, entry.messageId, execution.id, transaction);
    }
    const reason = await blockReason();
    if (reason) return { reason };
    const saved = await db.sequelize.transaction(async (transaction) => {
      const m = await db.Message.findByPk(entry.messageId, { transaction, lock: transaction.LOCK.UPDATE });
      const previous = m.metadata.assistantInbound;
      if (previous) return previous.executionId === execution.id ? previous : null;
      const marker = {
        executionId: execution.id,
        attemptId: randomUUID(),
        decision: { kind: assistantCommercialText(entry.text) ? 'interest' : 'review' },
      };
      await m.update({ metadata: { ...m.metadata, assistantInbound: marker } }, { transaction });
      return marker;
    });
    if (!saved) return { reason: 'assistant_turn_unavailable' };
    async function deliver(c, command, guard) {
      const blocked = (reason) => ({ outcome: 'blocked', reason });
      const key = 'assistant-wa:' + command.attemptId;
      const reservation = await db.sequelize.transaction(async (transaction) => {
        const locked = await db.Conversation.findByPk(c.id, { transaction, lock: transaction.LOCK.UPDATE });
        const existing = await db.Message.findOne({
          where: { conversation_id: c.id, automation_delivery_key: key },
          transaction,
        });
        if (existing)
          return {
            result: {
              outcome: ['sent', 'delivered', 'read'].includes(existing.status) ? 'sent' : 'unconfirmed',
              reason: existing.metadata?.failure_code,
            },
          };
        const denied = await guard.blockReason(transaction);
        if (denied) return { result: blocked(denied) };
        const image = command.selection && (await resolveForTurn(db, locked, command.selection, transaction));
        if (command.selection && !image) return { result: blocked('promotion_image_unavailable') };
        if (!(await resolveRoute(locked, entry.accountId, transaction)))
          return { result: blocked('whatsapp_reply_unavailable') };
        const message = await db.Message.create(
          {
            conversation_id: c.id,
            direction: 'outbound',
            message_type: image ? 'image' : 'text',
            automation_delivery_key: key,
            content: command.text,
            status: 'sending',
            metadata: {
              source: 'automations_v2',
              flow_domain: 'marketing',
              communication_scope: 'marketing',
              execution_id: execution.id,
              phone_number_id: entry.accountId,
              leadAssistantReply: {
                messageId: entry.messageId,
                claimId: claim.id,
                phoneId: entry.accountId,
                templateId: execution.template_version_id,
                version: rule.version,
                expiresAt: entry.expiresAt,
                ...(image ? { selection: command.selection } : {}),
              },
              ...(image
                ? { promotionImage: { key: command.selection.key, url: image.url, label: image.label } }
                : {}),
            },
          },
          { transaction }
        );
        return { message, image };
      });
      if (reservation.result) return reservation.result;
      const { message, image } = reservation;
      let result;
      try {
        const denied = await guard.blockReason();
        const clinicConfig = !denied && (await resolveRoute(c, entry.accountId));
        if (!clinicConfig || Date.parse(entry.expiresAt) <= Date.now())
          throw Object.assign(Error(), { code: denied || 'whatsapp_reply_unavailable' });
        const ack = await send({
          to: c.contact_id,
          clinicConfig,
          body: command.text,
          useTemplate: false,
          ...(image ? { image: { link: image.url } } : {}),
          healthContext: {
            messageId: message.id,
            source: 'lead_assistant',
            replyWindowEndsAt: entry.expiresAt,
          },
        });
        const wamid = ack?.messages?.[0]?.id;
        if (!wamid)
          throw Object.assign(Error(), { code: 'whatsapp_delivery_unknown', delivery_unknown: true });
        await message.update({
          metadata: { ...message.metadata, wamid },
          status: 'sent',
          sent_at: new Date(),
        });
        await db.Conversation.update(
          { last_message_at: message.sent_at },
          {
            where: {
              id: c.id,
              [db.Sequelize.Op.or]: [
                { last_message_at: null },
                { last_message_at: { [db.Sequelize.Op.lt]: message.sent_at } },
              ],
            },
          }
        );
        result = { outcome: 'sent' };
      } catch (error) {
        const code = error.code || 'whatsapp_delivery_unknown';
        await message.update({
          status: 'failed',
          metadata: {
            ...message.metadata,
            failure_code: code,
            outcome: error.delivery_unknown || code === 'whatsapp_delivery_unknown' ? 'unknown' : 'failed',
            reason: code,
            ...(error.delivery_unknown || code === 'whatsapp_delivery_unknown'
              ? { delivery_unknown: true }
              : {}),
          },
        });
        result = { outcome: 'blocked', reason: code };
      }
      refresh(c, message);
      return result;
    }
    const transport = {
      availability: async (c) => ({
        dm: { available: !!(await resolveRoute(c, entry.accountId)), reason: 'whatsapp_reply_unavailable' },
      }),
      reply: deliver,
      replyWithPromotionImage: deliver,
    };
    return require('./leadAssistantTurn.service').attend({
      db,
      social: transport,
      execution,
      entry,
      thread,
      saved,
      rule,
      initial,
      blockReason,
      analyze,
    });
  }
  return { start, run };
}
let singleton;
function current() {
  return (singleton ||= create({
    db: require('../../models'),
    createExecution: require('../lib/automation-runtime-stop').createExecution,
    enqueueJob: require('./jobRequests.service').enqueueUniqueJobRequest,
    analyze: (args) => require('./aiOrchestrator.service').analyzeStructured(args),
  }));
}
module.exports = { create, current, authorizeDelivery };
