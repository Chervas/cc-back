'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { eventKey, digest } = require('./socialInboxEvents');
const { isRevokedMessage } = require('../lib/automation-conversation-context');
const routes = require('./socialInboxRoute.service');
const config = require('./inboundLeadCaptureConfig.service');
const campaigns = require('./marketingWhatsappReplyLead.service');
const decisions = require('./inboundLeadCaptureDecision.service');
const classifierErrors = new Set(['inbound_capture_classifier_invalid', 'inbound_capture_classifier_unavailable']);
const { phone, parseContact, inboundProfileLabel } = require('../lib/whatsapp-contact-identity');
const {
  classifyInterest,
  explicitOptOut,
} = require('./socialLeadInterestClassification.service');
const { enqueueInboundExecution } = require('./leadAssistantExecution.service');

function whatsappEntry(claim, message, thread) {
  const meta = message.metadata || {};
  const accountId = require('./whatsappServiceWindow.service').extractWhatsappPhoneNumberId(meta);
  const wabaId = meta.waba_id || meta.wabaId;
  const at = new Date(meta.passive_recovery ? message.sent_at : meta.provider_sent_at).getTime();
  if (
    claim.channel !== 'whatsapp' ||
    thread.channel !== 'whatsapp' ||
    !/^wamid\.[A-Za-z0-9+/=_:.-]{1,500}$/.test(meta.wamid || '') ||
    meta.wamid !== claim.provider_message_id ||
    !/^\d+$/.test(accountId || '') ||
    (wabaId && !/^\d+$/.test(wabaId)) ||
    meta.historical ||
    meta.source === 'history' ||
    meta.echo ||
    meta.is_echo ||
    isRevokedMessage(message) ||
    meta.recovery_without_automation ||
    meta.automatic_actions_allowed === false ||
    (meta.passive_recovery && !meta.fresh_inbound_authorization_id) ||
    !Number.isFinite(at) ||
    at > Date.now() ||
    message.message_type !== 'text' ||
    (meta.provider_type && meta.provider_type !== 'text') ||
    !message.content ||
    !(phone(thread.contact_id) || parseContact(thread.contact_id))
  )
    return null;
  return {
    channel: 'whatsapp',
    type: 'dm',
    source: 'new',
    echo: false,
    senderId: thread.contact_id,
    alias: inboundProfileLabel(meta, thread.contact_id),
    accountId,
    wabaId,
    ad:
      meta.referral?.source_type === 'ad' && (meta.referral.source_id || meta.referral.ctwa_clid)
        ? { id: meta.referral.source_id || null }
        : null,
    at,
    eventId: meta.wamid,
    text: message.content,
  };
}
function family(channel) {
  return channel === 'whatsapp' ? 'whatsapp' : 'social';
}
function claimKey(clinicId, messageId) {
  return `inbound_capture:${clinicId}:${messageId}`;
}
function create({
  db,
  readSocial,
  classify = classifyInterest,
  createExecution,
  enqueueJob,
  publishLead,
  restrictions,
  notifyConversation,
  resolveRoute = routes.resolveRoute,
}) {
  async function verified(claim, message, thread, transaction) {
    if (
      !claim ||
      !message ||
      !thread ||
      message.direction !== 'inbound' ||
      message.conversation_id !== thread.id ||
      claim.message_id !== message.id ||
      claim.conversation_id !== thread.id ||
      claim.clinic_id !== thread.clinic_id ||
      claim.channel !== thread.channel
    )
      return null;
    if (thread.channel === 'whatsapp') return whatsappEntry(claim, message, thread);
    if (
      !['instagram', 'messenger'].includes(thread.channel) ||
      !/^[a-f0-9]{64}$/.test(claim.provider_message_id || '')
    )
      return null;
    const entry = await readSocial(claim.provider_message_id, thread.clinic_id, transaction);
    if (
      !entry ||
      entry.source !== 'new' ||
      entry.echo !== false ||
      !['dm', 'comment'].includes(entry.type) ||
      (entry.channel === 'messenger' && entry.type !== 'dm') ||
      entry.messageId !== message.id ||
      entry.conversationId !== thread.id ||
      entry.senderId !== thread.contact_id ||
      entry.channel !== thread.channel ||
      entry.accountId !== thread.social_account_id ||
      message.metadata?.providerId !== entry.eventId ||
      eventKey(entry) !== claim.provider_message_id
    )
      return null;
    const receipt = await db.SocialInboxReceipt.findByPk(claim.provider_message_id, {
      attributes: ['route'],
      transaction,
    });
    const route = await resolveRoute(db, entry, transaction);
    return route?.clinicId === thread.clinic_id && routes.sameRoute(receipt?.route, route) ? entry : null;
  }
  async function enqueue({ claim, message, conversation }) {
    const clinicId = conversation.clinic_id,
      channel = family(conversation.channel);
    const flow = await config.current(db, clinicId, channel);
    if (!flow?.is_active) return { pending: false };
    const entry = await verified(claim, message, conversation);
    if (!entry || !config.effective(flow, new Date(entry.at).getTime())) return { pending: false };
    const key = claimKey(clinicId, message.id);
    const marker = message.metadata?.inboundLeadCapture;
    if (marker?.key === key)
      return {
        pending: false,
        execution_id: marker.executionId,
        lead_id: marker.leadId,
        origin: marker.origin,
        campaign_id: marker.campaignId,
      };
    const started = await enqueueInboundExecution({
      db,
      createExecution,
      enqueueJob,
      flow,
      clinicId,
      messageId: message.id,
      idempotencyKey: key,
      entryNodeId: flow.entry_node_id,
      origin: 'inbound_lead_capture',
      context: {
        trigger: {
          type: 'mensaje_recibido',
          data: { claim_id: claim.id, conversation_id: conversation.id, message_id: message.id, channel },
        },
        outputs: {},
      },
    });
    if (!started.execution_id) return { pending: false, reason: started.reason };
    const execution = await db.FlowExecutionV2.findByPk(started.execution_id, { attributes: ['status'] });
    const pending = ['running', 'waiting'].includes(execution?.status);
    if (pending) return { pending: true, execution_id: started.execution_id };
    const fresh = await db.Message.findByPk(message.id, { attributes: ['metadata'] });
    const result = fresh?.metadata?.inboundLeadCapture;
    return {
      pending: false,
      execution_id: started.execution_id,
      lead_id: result?.leadId,
      origin: result?.origin,
      campaign_id: result?.campaignId,
      reason: result?.reason || execution?.status,
    };
  }
  async function identify(execution, transaction) {
    const data = execution?.context?.trigger?.data,
      clinicId = execution?.clinic_id;
    if (
      !data ||
      !config.CHANNELS.includes(data.channel) ||
      execution.idempotency_key !== claimKey(clinicId, data.message_id) ||
      execution.trigger_type !== 'mensaje_recibido' ||
      execution.trigger_entity_id !== data.message_id
    )
      return null;
    const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
    // The same lock used when publishing the clinical policy serializes a disable with the final write.
    if (transaction) await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica'], ...options });
    const flow = await config.current(db, clinicId, data.channel, transaction);
    if (
      !flow?.is_active ||
      flow.id !== execution.template_version_id ||
      (flow.group_id || null) !== (execution.group_id || null) ||
      flow.trigger_config.channel !== data.channel
    )
      return null;
    const thread = await db.Conversation.findByPk(data.conversation_id, options);
    const message = await db.Message.findByPk(data.message_id, options);
    const claim = await db.AutomationInboundMessageClaim.findByPk(data.claim_id, { transaction });
    if (!thread || thread.clinic_id !== clinicId || family(thread.channel) !== data.channel) return null;
    const entry = await verified(claim, message, thread, transaction);
    if (!entry || !config.effective(flow, new Date(entry.at).getTime())) return null;
    return { entry, thread, message, flow };
  }
  async function optedOut({ entry, thread }, transaction) {
    const whatsapp = entry.channel === 'whatsapp',
      contactPhone = whatsapp ? phone(thread.contact_id) : null;
    if (restrictions && (thread.patient_id || contactPhone)) {
      const active = await restrictions(
        { clinicIds: [thread.clinic_id], patientId: thread.patient_id, phone: contactPhone },
        transaction,
      );
      if (active.marketing_opt_out || (whatsapp && active.whatsapp_channel_opt_out)) return true;
    }
    return !!(await db.Message.findOne({
      where: {
        conversation_id: thread.id,
        [db.Sequelize.Op.or]: [
          { 'metadata.socialContactOptOut': true },
          { 'metadata.inboundLeadCapture.decision.kind': 'opt_out' },
          { 'metadata.socialLead.decision.kind': 'opt_out' },
        ],
      },
      attributes: ['id'],
      transaction,
    }));
  }
  async function run(execution) {
    const input = await identify(execution);
    if (!input) return { reason: 'capture_not_eligible' };
    const { entry } = input,
      key = execution.idempotency_key;
    const prior = input.message.metadata?.inboundLeadCapture;
    if (prior?.key === key) return prior;
    // A retry must never pay for a second interpretation or act on two conflicting decisions.
    // Reserve just this message and release the database connection before inference.
    const token = randomUUID();
    const reserved = await db.sequelize.transaction(async (transaction) => {
      const message = await db.Message.findByPk(input.message.id, { transaction, lock: transaction.LOCK.UPDATE });
      const record = message.metadata?.inboundLeadCapture;
      if (record?.key === key && record.reason) return { record };
      const reservation = message.metadata?.inboundLeadCaptureClassification;
      if (reservation?.key === key && reservation.templateId === execution.template_version_id) {
        if (reservation.decision) return { decision: reservation.decision };
        if (Date.parse(reservation.until) > Date.now()) return { waiting: reservation.until };
        // The original caller may already have dispatched inference before it crashed.
        // Do not infer again when its result is unknowable.
        if (!classifierErrors.has(reservation.failureCode))
          return { decision: { kind: 'review', privateRequested: false, reason: 'classifier_result_unknown' } };
      }
      const until = new Date(Date.now() + 120000).toISOString();
      await message.update(
        {
          metadata: {
            ...message.metadata,
            inboundLeadCaptureClassification: {
              key,
              templateId: execution.template_version_id,
              executionId: execution.id,
              token,
              until,
            },
          },
        },
        { transaction },
      );
      return {};
    });
    if (reserved.record) return reserved.record;
    if (reserved.waiting) return { pending: true, waitUntil: reserved.waiting };
    let decision = reserved.decision;
    if (!decision) {
      decision = decisions.simpleDecision(entry, explicitOptOut(entry.text) || await optedOut(input));
      if (!decision) {
        try {
          decision = await decisions.classifyDecision(entry, {
            clinicId: execution.clinic_id,
            groupId: execution.group_id,
            reportFailure: true,
            beforeDispatch: async () => {
              const active = await identify(execution);
              return !!active && !(await optedOut(active));
            },
          }, classify);
        } catch (error) {
          const failureCode = classifierErrors.has(error?.code) ? error.code : 'inbound_capture_classifier_unavailable';
          await db.sequelize.transaction(async transaction => {
            const message = await db.Message.findByPk(input.message.id, {transaction, lock: transaction.LOCK.UPDATE});
            const current = message.metadata?.inboundLeadCaptureClassification;
            if (current?.token === token && !current.decision)
              await message.update({metadata: {...message.metadata, inboundLeadCaptureClassification:
                {key, templateId: execution.template_version_id, executionId: execution.id, failureCode}}}, {transaction});
          });
          throw Object.assign(Error(failureCode), {code: failureCode});
        }
      }
      await db.sequelize.transaction(async (transaction) => {
        const message = await db.Message.findByPk(input.message.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const reservation = message.metadata?.inboundLeadCaptureClassification;
        if (reservation?.token === token)
          await message.update(
            { metadata: { ...message.metadata, inboundLeadCaptureClassification: { ...reservation, decision } } },
            { transaction },
          );
      });
    }
    return db.sequelize.transaction(async (transaction) => {
      const checked = await identify(execution, transaction);
      if (!checked) return { reason: 'capture_not_eligible' };
      const { thread, message, flow } = checked,
        clinicId = thread.clinic_id;
      const prior = message.metadata?.inboundLeadCapture;
      if (prior?.key === key) return prior;
      const whatsapp = entry.channel === 'whatsapp';
      const binding = { clinicId, phoneId: entry.accountId, wabaId: entry.wabaId };
      const campaign = whatsapp
        ? await campaigns.resolveCampaignReply({ db, message, conversation: thread, binding, transaction })
        : null;
      if (campaign?.commercial && !campaign.excluded && decisions.eligibleChoice(decision, entry.text, campaign.offerText)
          && await campaigns.hasSelectionContext({ db, message, campaign, transaction }))
        decision = decisions.selectedDecision();
      const record = {
        key,
        executionId: execution.id,
        decision,
        origin: campaign?.commercial ? 'whatsapp_campaign' : whatsapp ? 'whatsapp' : entry.channel,
        campaignId: campaign?.campaignId || null,
        leadId: null,
      };
      const directPhone = whatsapp ? phone(thread.contact_id) : null;
      let reason = decision.reason || (decision.kind === 'review' ? 'intent_ambiguous' : decision.kind);
      if (
        ['interest', 'intent_ambiguous'].includes(reason) && campaign &&
        (campaign.excluded ||
          (!campaign.legacyEnabled &&
            campaign.policy !== 'enabled' &&
            campaign.sentAt < Date.parse(flow.trigger_config.effective_from)))
      )
        reason = campaign.reason || 'campaign_excluded';
      if (reason === 'interest' && (await optedOut(checked, transaction))) reason = 'marketing_opt_out';
      if (reason === 'interest') {
        let lead,
          created = false;
        if (campaign) {
          const result = await campaigns.attributeCampaignInfoReply({
            db,
            message,
            conversation: thread,
            binding,
            transaction,
            match: campaign,
            captureFrom: Date.parse(flow.trigger_config.effective_from),
            verifiedInterest: true,
          });
          lead = result?.lead;
          created = !!lead && !result.duplicate;
        } else if (thread.lead_id) {
          lead = await db.LeadIntake.findOne({
            where: { id: thread.lead_id, clinica_id: clinicId, archived_at: null },
            transaction,
          });
        } else {
          const source = whatsapp ? 'quickchat_whatsapp' : 'quickchat_social';
          [lead, created] = await db.LeadIntake.findOrCreate({
            where: {
              external_source: source,
              external_id: digest(source, clinicId, entry.channel, entry.accountId, entry.senderId),
            },
            defaults: {
              clinica_id: clinicId,
              grupo_clinica_id: flow.group_id,
              channel: entry.ad ? 'paid' : 'unknown',
              status_lead: 'nuevo',
              es_paciente: !!thread.patient_id,
              ...(entry.ad ? { source: 'meta_ads' } : whatsapp ? { source: 'whatsapp' } : {}),
              source_detail: whatsapp ? 'whatsapp_dm' : `${entry.channel}_${entry.type}`,
              nombre: (entry.alias || thread.social_alias)?.slice(0, 128) || null,
              telefono: directPhone,
              phone_hash: directPhone ? createHash('sha256').update(directPhone).digest('hex') : null,
            },
            transaction,
          });
          if (lead.archived_at || lead.clinica_id !== clinicId) lead = null;
          if (lead) await thread.update({ lead_id: lead.id }, { transaction });
          if (lead && created)
            await db.LeadAttributionAudit.create(
              {
                lead_intake_id: lead.id,
                raw_payload: { message_id: message.id },
                attribution_steps: {
                  inbound_capture: {
                    channel: entry.channel,
                    kind: entry.type,
                    conversation_id: thread.id,
                    execution_id: execution.id,
                  },
                },
              },
              { transaction },
            );
        }
        record.leadId = lead?.id || null;
        if (!lead) reason = 'lead_link_requires_review';
        else record.outcome = created ? 'created' : 'linked';
        if (created && publishLead) transaction.afterCommit(() => publishLead({ lead }));
      }
      record.reason = reason;
      if (!record.outcome) record.outcome = ['intent_ambiguous', 'mixed_appointment_interest', 'lead_link_requires_review',
        'attribution_ambiguous', 'classifier_result_unknown'].includes(reason) ? 'review' : 'discarded';
      const metadata = { ...message.metadata, inboundLeadCapture: record };
      delete metadata.inboundLeadCaptureClassification;
      await message.update({ metadata }, { transaction });
      if (notifyConversation) transaction.afterCommit(() =>
        notifyConversation(clinicId, {id: message.id, conversation_id: thread.id}));
      return record;
    });
  }
  return { enqueue, run };
}
let instance;
function current() {
  return (instance ||= create({
    db: require('../../models'),
    readSocial: (...args) =>
      require('./socialInbox.service')
        .service()
        .readEntry(...args),
    createExecution: require('../lib/automation-runtime-stop').createExecution,
    enqueueJob: require('./jobRequests.service').enqueueUniqueJobRequest,
    notifyConversation: (clinicId, packet) =>
      require('./socket.service').emit('message:refresh', packet, [`clinic:${clinicId}`]),
    restrictions: require('./marketingOptOut.service').getActiveContactRestrictionsForPatient,
    publishLead: require('./leadCreatedRealtime.service').publishLeadCreated,
  }));
}
module.exports = {
  create,
  enqueueWhatsapp: (args) => current().enqueue(args),
  enqueueSocial: (args) => current().enqueue(args),
  run: (e) => current().run(e),
};
