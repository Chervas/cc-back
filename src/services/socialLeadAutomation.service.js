'use strict';

const { randomUUID } = require('node:crypto');
const { digest, eventKey } = require('./socialInboxEvents');
const routes = require('./socialInboxRoute.service');
const { explicitOptOut, assistantCommercialText } = require('./socialLeadInterestClassification.service');

const { acceptsOrigin } = require('./leadAssistantOrigin.service');

const source = 'quickchat_social';
const allowed = new Set(['instagram_dm', 'instagram_comment', 'messenger_dm']);
const inputKey = (entry) => [entry.channel, entry.type].join('_');
const owned = (entry, conversation) =>
  entry.source === 'new' &&
  entry.echo === false &&
  allowed.has(inputKey(entry)) &&
  entry.channel === conversation.channel &&
  entry.accountId === conversation.social_account_id &&
  entry.senderId === conversation.contact_id;

function create({
  db,
  social,
  dispatch,
  createExecution,
  enqueueJob,
  classify,
  publishLead,
  notifyConversation,
  checkPatientRestrictions,
  analyzeAssistant = args => require('./aiOrchestrator.service').analyzeStructured(args),
  resolve = routes.resolveRoute,
}) {
  async function plan(conversation, entry, transaction) {
    const clinicId = conversation.clinic_id;
    const flow = await db.AutomationFlowTemplateV2.findOne({
      where: {
        clinic_id: clinicId,
        template_key: 'lead_auto_reply_system__clinic_' + clinicId,
        published_at: { [db.Sequelize.Op.ne]: null },
      },
      order: [
        ['version', 'DESC'],
        ['id', 'DESC'],
      ],
      transaction,
    });
    const config = flow?.trigger_config;
    const rule = config?.social_entries?.[inputKey(entry)];
    if (
      !flow?.is_active ||
      flow.is_system ||
      config?.managed_feature !== 'lead_auto_reply' ||
      !config.configured ||
      !rule ||
      !allowed.has(inputKey(entry)) ||
      new Date(flow.published_at).getTime() > Date.parse(entry.at)
    )
      return null;
    if (
      rule.action !== 'notify' &&
      !(rule.action === 'assistant' && entry.channel === 'instagram' && Number.isSafeInteger(rule.version) && rule.version > 0 &&
        ['leads','all'].includes(rule.audience)) &&
      !(
        rule.action === 'message' &&
        entry.channel === 'instagram' &&
        typeof rule.text === 'string' &&
        rule.text.trim() &&
        rule.text.length <= 1000
      )
    )
      return null;
    if (rule.action === 'assistant' && !await acceptsOrigin(db, rule, conversation, entry, transaction, flow.id)) return null;
    return { flow, rule };
  }

  async function enqueue({ entry, receiptKey, conversation, message, transaction }) {
    if (!owned(entry, conversation) || receiptKey !== eventKey(entry)) return;
    if (explicitOptOut(entry.text)) {
      await message.update({ metadata: { ...message.metadata, socialContactOptOut: true } }, { transaction });
    }
    const eligible = await plan(conversation, { ...entry, messageId: message.id }, transaction);
    if (!eligible) return;
    return dispatch(
      {
        inboundMessage: message,
        conversation,
        clinicId: conversation.clinic_id,
        channel: entry.channel,
        providerMessageId: receiptKey,
        socialTemplateId: eligible.flow.id,
      },
      { transaction },
    );
  }

  async function start({ claim, message, conversation }) {
    const key = claim.provider_message_id;
    const entry = await social.readEntry(key, conversation.clinic_id);
    if (
      !entry ||
      !owned(entry, conversation) ||
      entry.messageId !== message.id ||
      entry.conversationId !== conversation.id ||
      key !== eventKey(entry)
    )
      return { reason: 'unverified_social_entry' };
    const eligible = await plan(conversation, entry);
    if (!eligible || eligible.flow.id !== claim.metadata?.social_template_id)
      return { reason: 'social_entry_disabled' };
    const { flow } = eligible;
    const idempotencyKey = 'social_lead:' + key;
    return require('./leadAssistantExecution.service').enqueueInboundExecution({db,createExecution,enqueueJob,
      flow, clinicId:conversation.clinic_id, messageId:message.id, idempotencyKey, entryNodeId:flow.entry_node_id,
      origin:'social_lead_interest', context:{
            trigger: {
              type: 'mensaje_recibido',
              data: {
                event_kind: 'social',
                social_receipt_key: key,
                clinic_id: conversation.clinic_id,
                conversation_id: conversation.id,
                message_id: message.id,
              },
            },
            conversation: { id: conversation.id, channel: entry.channel },
            outputs: {},
          } });
  }

  async function run(execution, assistantNode = false) {
    const data = execution?.context?.trigger?.data;
    const key = data?.social_receipt_key;
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      execution.idempotency_key !== 'social_lead:' + key ||
      execution.trigger_type !== 'mensaje_recibido' ||
      execution.trigger_entity_id !== data.message_id ||
      execution.clinic_id !== data.clinic_id
    )
      throw Error('social_lead_execution_scope');
    const clinicId = execution.clinic_id;
    const entry = await social.readEntry(key, clinicId);
    if (!entry) return { reason: 'social_entry_unavailable' };
    if (
      entry.messageId !== data.message_id ||
      entry.conversationId !== data.conversation_id ||
      eventKey(entry) !== key
    )
      throw Error('social_lead_entry_scope');
    const thread = await db.Conversation.findByPk(data.conversation_id);
    if (!thread || thread.clinic_id !== clinicId || !owned(entry, thread))
      throw Error('social_lead_thread_scope');
    const current = async (transaction) => {
      const eligible = await plan(thread, entry, transaction);
      if (!eligible || eligible.flow.id !== execution.template_version_id) return null;
      const running = await db.FlowExecutionV2.findOne({
        where: {
          id: execution.id,
          clinic_id: clinicId,
          template_version_id: eligible.flow.id,
          idempotency_key: 'social_lead:' + key,
          status: 'running',
        },
        attributes: ['id'],
        transaction,
      });
      if (!running) return null;
      const present = await social.readEntry(key, clinicId, transaction);
      if (!present || !owned(present, thread) || present.messageId !== entry.messageId || present.conversationId !== thread.id) {
        return null;
      }
      const receipt = await db.SocialInboxReceipt.findByPk(key, { attributes: ['route'], transaction });
      const route = await resolve(db, entry, transaction);
      return route?.clinicId === clinicId && routes.sameRoute(receipt?.route, route) ? eligible : null;
    };
    const selected = await current();
    if (!selected) return { reason: 'social_entry_disabled' };
    if (selected.rule.action === 'assistant' && !assistantNode) return {invoke_assistant:true};
    if (assistantNode && selected.rule.action !== 'assistant') return {reason:'assistant_rule_unavailable'};
    const initial = await db.Message.findByPk(entry.messageId);
    if (!initial || initial.conversation_id !== thread.id || initial.direction !== 'inbound')
      throw Error('social_lead_message_scope');
    let decision = initial.metadata?.socialLead?.decision;
    if (!decision && assistantNode && entry.type==='dm') {
      const calendar=require('./leadAssistantCalendar.service');
      if ((assistantCommercialText(entry.text) && calendar.bookingRequest(entry.text)) ||
        (await db.LeadAssistantSession.count({where:{conversation_id:thread.id,state:'active',template_id:execution.template_version_id}}) &&
          !explicitOptOut(entry.text))) decision={kind:'interest',privateRequested:true};
    }
    if (!decision && assistantNode && entry.type === 'dm' && assistantCommercialText(entry.text) &&
        /(?:foto|imagen|cartel|creatividad)\s+(?:de (?:la |esta |esa |la oferta )?(?:promo(?:ción)?|oferta)|de\s+[a-z]{1,8}\d+-\d+)/i.test(entry.text)) {
      decision = {kind:'interest',privateRequested:true};
    }
    if (!decision) {
      decision = await classify(entry, {
        clinicId,
        groupId: execution.group_id,
        beforeDispatch: async () => {
          if (!(await current())) throw Error('social_entry_disabled');
        },
      });
    }
    const saved = await db.sequelize.transaction(async (transaction) => {
      const eligible = await current(transaction);
      if (!eligible) return { reason: 'social_entry_disabled' };
      const lock = { transaction, lock: transaction.LOCK.UPDATE };
      const c = await db.Conversation.findByPk(thread.id, lock);
      const m = await db.Message.findByPk(entry.messageId, lock);
      if (
        !owned(entry, c) ||
        c.clinic_id !== clinicId ||
        m.conversation_id !== c.id ||
        m.metadata?.providerId !== entry.eventId
      )
        throw Error('social_lead_message_changed');
      const existing = m.metadata?.socialLead;
      if (existing) {
        if (existing.key !== key || existing.executionId !== execution.id)
          throw Error('social_lead_claim_conflict');
        return existing;
      }
      const record = { key, executionId: execution.id, decision, attemptId: randomUUID() };
      if (decision.kind === 'interest') {
        let lead;
        let created = false;
        if (c.lead_id) {
          lead = await db.LeadIntake.findByPk(c.lead_id, lock);
        } else {
          [lead, created] = await db.LeadIntake.findOrCreate({
            where: {
              external_source: source,
              external_id: digest(source, clinicId, entry.channel, entry.accountId, entry.senderId),
            },
            defaults: {
              clinica_id: clinicId,
              grupo_clinica_id: eligible.flow.group_id || null,
              channel: entry.ad ? 'paid' : 'unknown',
              ...(entry.ad ? { source: 'meta_ads' } : {}),
              source_detail: inputKey(entry),
              status_lead: 'nuevo',
              nombre: (entry.alias || c.social_alias)?.slice(0, 128) || null,
              es_paciente: !!c.patient_id,
            },
            transaction,
          });
        }
        if (!lead || lead.clinica_id !== clinicId || lead.archived_at)
          record.reason = 'lead_link_requires_review';
        else {
          record.leadId = lead.id;
          if (!c.lead_id) {
            await c.update({ lead_id: lead.id }, { transaction });
            transaction.afterCommit(() => notifyConversation(clinicId, { id: m.id, conversation_id: c.id }));
          }
          if (created) {
            await db.LeadAttributionAudit.create(
              {
                lead_intake_id: lead.id,
                raw_payload: { receipt_key: key },
                attribution_steps: {
                  social_interest: {
                    channel: entry.channel,
                    source: entry.type,
                    conversation_id: c.id,
                    message_id: m.id,
                    post_id: entry.postId || null,
                  },
                },
              },
              { transaction },
            );
            transaction.afterCommit(() => publishLead({ lead }));
          }
        }
      }
      await m.update({ metadata: { ...m.metadata, socialLead: record } }, { transaction });
      return record;
    });
    if (saved.reason === 'social_entry_disabled') return { reason: saved.reason };
    const output = { lead_id: saved.leadId || null, reason: saved.reason || saved.decision.kind };
    if (assistantNode && (saved.reason || saved.decision.kind === 'opt_out' || (await require('./leadAssistantBooking.service').excludedPatient(db,selected.rule,thread,entry.messageId)))) return output;
    if (saved.decision.kind === 'ignore') return output;
    if (!assistantNode && (saved.reason || saved.decision.kind !== 'interest')) return { ...output, attention: true };
    const active = await current();
    if (!active) return { ...output, reason: 'social_entry_disabled' };
    if (active.rule.action === 'notify' || (!saved.decision.privateRequested && !(assistantNode && entry.type === 'dm')))
      return { ...output, attention: true };
    async function blockReason(transaction) {
      if (!(await current(transaction))) return 'automation_inactive';
      const c = await db.Conversation.findByPk(thread.id, { transaction });
      if (!c || c.clinic_id !== clinicId || !owned(entry, c) || ((!assistantNode || saved.leadId) && c.lead_id !== saved.leadId) ||
          (assistantNode && await require('./leadAssistantBooking.service').excludedPatient(db,active.rule,c,entry.messageId,transaction)))
        return 'account_changed';
      if (
        c.patient_id &&
        (await checkPatientRestrictions({ clinicIds: [clinicId], patientId: c.patient_id }, transaction))
          .marketing_opt_out
      )
        return 'marketing_opt_out';
      const superseded = await db.Message.findOne({
        where: {
          conversation_id: c.id,
          [db.Sequelize.Op.or]: [
            { 'metadata.socialContactOptOut': true },
            { 'metadata.socialLead.decision.kind': 'opt_out' },
            { direction: 'inbound', id: { [db.Sequelize.Op.gt]: entry.messageId } },
          ],
        },
        attributes: ['metadata'],
        transaction,
      });
      if (superseded)
        return superseded.metadata?.socialContactOptOut || superseded.metadata?.socialLead?.decision?.kind === 'opt_out'
          ? 'marketing_opt_out'
          : 'newer_inbound';
      if (assistantNode) {
        const jsonText = path => db.sequelize.fn('COALESCE', db.sequelize.fn('JSON_UNQUOTE',
          db.sequelize.fn('JSON_EXTRACT', db.sequelize.col('metadata'), db.sequelize.literal(db.sequelize.escape(path)))), '');
        const otherReply = await db.Message.findOne({where:{
          conversation_id:c.id, direction:'outbound', id:{[db.Sequelize.Op.gt]:entry.messageId},
          status:{[db.Sequelize.Op.ne]:'failed'}, [db.Sequelize.Op.or]:[
            db.sequelize.where(jsonText('$.execution_id'),{[db.Sequelize.Op.ne]:String(execution.id)}),
            db.sequelize.where(jsonText('$.source'),{[db.Sequelize.Op.ne]:'automations_v2'}),
          ],
        }, attributes:['id'],transaction});
        return otherReply ? 'already_replied' : null;
      }
      const prior = await db.Message.findOne({
        where: {
          conversation_id: c.id,
          direction: 'outbound',
          id: { [db.Sequelize.Op.gt]: entry.messageId },
          status: { [db.Sequelize.Op.ne]: 'failed' },
        },
        attributes: ['metadata'],
        order: [['id', 'DESC']],
        transaction,
      });
      return prior && prior.metadata?.socialAttempt !== saved.attemptId ? 'already_replied' : null;
    }
    if (assistantNode) {
      const result = await require('./leadAssistantTurn.service').attend({
        db, social, execution, entry, thread, saved, rule:active.rule, initial, blockReason, analyze:analyzeAssistant,
      });
      return { ...output, ...result };
    }
    const commentId = entry.type === 'comment' ? entry.messageId : null;
    const available = await social.availability(thread, commentId ? [initial] : []);
    const gate = commentId ? available.comments[commentId] : available.dm;
    // A replay reconciles the existing attempt even when the private reply has already been reserved.
    if (
      !gate?.available &&
      !(await db.SocialInboxReceipt.findByPk(digest('attempt', saved.attemptId), { attributes: ['key'] }))
    ) {
      return { ...output, reason: gate?.reason || 'reply_unavailable', attention: true };
    }
    const result = await social.reply(
      thread,
      {
        actorId: execution.created_by,
        text: active.rule.text,
        attemptId: saved.attemptId,
        commentMessageId: commentId,
      },
      { executionId: execution.id, blockReason },
    );
    return {
      ...output,
      outcome: result.outcome,
      reason: result.reason || 'interest',
      attention: result.outcome !== 'sent',
    };
  }

  return { enqueue, start, run };
}

let singleton;
function service() {
  return (singleton ||= create({
    db: require('../../models'),
    social: require('./socialInbox.service').service(),
    dispatch: (...args) => require('./automationInboundMessage.service').enqueueInboundDispatch(...args),
    createExecution: require('../lib/automation-runtime-stop').createExecution,
    enqueueJob: require('./jobRequests.service').enqueueUniqueJobRequest,
    classify: (...args) => require('./socialLeadInterestClassification.service').classifyInterest(...args),
    publishLead: require('./leadCreatedRealtime.service').publishLeadCreated,
    notifyConversation: (clinicId, packet) =>
      require('./socket.service').emit('message:refresh', packet, [`clinic:${clinicId}`]),
    checkPatientRestrictions: require('./marketingOptOut.service').getActiveContactRestrictionsForPatient,
  }));
}
module.exports = {
  create,
  enqueue: (e) => service().enqueue(e),
  start: (e) => service().start(e),
  run: (e, assistantNode) => service().run(e, assistantNode),
};
