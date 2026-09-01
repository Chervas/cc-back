'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const automationsV2ResumeService = require('./automationsV2Resume.service');
const marketingOptOutService = require('./marketingOptOut.service');
const marketingBulkSendsService = require('./marketingBulkSends.service');
const conversationAutomationState = require('./conversationAutomationState.service');
const { resolveClinicOpenState } = require('./clinicOpeningHours.service');
const { getIO } = require('./socket.service');

const { Op } = db.Sequelize;
const BUFFER_DELAY_MS = 90 * 1000;
const BUFFER_MAX_MS = 5 * 60 * 1000;
const DISPATCH_LEASE_MS = 5 * 60 * 1000;
const RUNTIME_MESSAGE_RECEIVED_CHANNELS = new Set(['whatsapp']);
const ACTIVE_APPOINTMENT_STATUSES = [
  'pendiente',
  'info_enviada',
  'info_confirmada',
  'recordatorio_enviado',
  'recordatorio_confirmado',
  'cambio_solicitado',
];

function cleanString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDate(value, fallback = null) {
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizeChannel(value) {
  const channel = cleanString(value)?.toLowerCase();
  return ['whatsapp', 'instagram'].includes(channel) ? channel : null;
}

function normalizeMessageReceivedTriggerConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const channelScope = cleanString(source.channel_scope)?.toLowerCase() === 'selected'
    ? 'selected'
    : 'all_connected';
  const channels = Array.from(new Set(
    (Array.isArray(source.channels) ? source.channels : [])
      .map(normalizeChannel)
      .filter(Boolean)
  ));
  return {
    channel_scope: channelScope,
    channels: channelScope === 'selected' ? channels : [],
    timing: cleanString(source.timing)?.toLowerCase() === 'clinic_closed'
      ? 'clinic_closed'
      : 'always',
    only_unclaimed: true,
    response_buffer_seconds: 90,
  };
}

function triggerConfigMatches({ config, channel, clinicOpenState }) {
  const normalized = normalizeMessageReceivedTriggerConfig(config);
  const normalizedChannel = normalizeChannel(channel);
  if (!normalizedChannel || !RUNTIME_MESSAGE_RECEIVED_CHANNELS.has(normalizedChannel)) return false;
  if (normalized.channel_scope === 'selected' && !normalized.channels.includes(normalizedChannel)) {
    return false;
  }
  if (normalized.timing === 'clinic_closed') {
    return clinicOpenState?.has_schedule === true && clinicOpenState?.open_now === false;
  }
  return true;
}

function buildClaimKey({ channel, providerMessageId, messageId }) {
  const normalizedChannel = normalizeChannel(channel) || 'unknown';
  const providerId = cleanString(providerMessageId);
  const localId = positiveInt(messageId);
  if (providerId) return `${normalizedChannel}:provider:${providerId}`.slice(0, 255);
  if (!localId) throw new Error('inbound_message_claim_identifier_required');
  return `${normalizedChannel}:message:${localId}`;
}

function computeBatchDeadline({ firstMessageAt, latestMessageAt }) {
  const now = new Date();
  const first = parseDate(firstMessageAt, now);
  const latest = parseDate(latestMessageAt, now);
  const slidingDeadline = latest.getTime() + BUFFER_DELAY_MS;
  const absoluteDeadline = first.getTime() + BUFFER_MAX_MS;
  return new Date(Math.min(slidingDeadline, absoluteDeadline));
}

function claimMetadata(claim) {
  return claim?.metadata && typeof claim.metadata === 'object' && !Array.isArray(claim.metadata)
    ? claim.metadata
    : {};
}

async function updateClaim(claim, patch = {}, metadataPatch = {}, options = {}) {
  const metadata = { ...claimMetadata(claim), ...metadataPatch };
  return claim.update(
    { ...patch, metadata },
    options.transaction ? { transaction: options.transaction } : undefined,
  );
}

async function findClaimAfterConflict({ claimKey, messageId }, transaction = null) {
  return db.AutomationInboundMessageClaim.findOne({
    where: {
      [Op.or]: [
        { claim_key: claimKey },
        ...(positiveInt(messageId) ? [{ message_id: positiveInt(messageId) }] : []),
      ],
    },
    ...(transaction ? { transaction } : {}),
  });
}

async function acquireInboundClaim({ message, conversation, clinicId, channel, providerMessageId }, transaction) {
  const messageId = positiveInt(message?.id);
  const conversationId = positiveInt(conversation?.id || message?.conversation_id);
  const normalizedClinicId = positiveInt(clinicId || conversation?.clinic_id);
  const normalizedChannel = normalizeChannel(channel || conversation?.channel);
  if (!messageId || !conversationId || !normalizedClinicId || !normalizedChannel) {
    throw new Error('inbound_message_claim_context_invalid');
  }
  const claimKey = buildClaimKey({
    channel: normalizedChannel,
    providerMessageId,
    messageId,
  });

  try {
    const [claim, created] = await db.AutomationInboundMessageClaim.findOrCreate({
      where: { claim_key: claimKey },
      defaults: {
        claim_key: claimKey,
        message_id: messageId,
        conversation_id: conversationId,
        clinic_id: normalizedClinicId,
        channel: normalizedChannel,
        provider_message_id: cleanString(providerMessageId),
        owner_type: 'dispatching',
        status: 'claimed',
        claimed_at: new Date(),
        metadata: {},
      },
      transaction,
    });
    return { claim, created, claimKey };
  } catch (error) {
    if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
    const claim = await findClaimAfterConflict({ claimKey, messageId }, transaction);
    if (!claim) throw error;
    return { claim, created: false, claimKey };
  }
}

function triggerDispatchJobAfterCommit(jobId) {
  const normalizedJobId = positiveInt(jobId);
  if (!normalizedJobId) return;
  require('./jobScheduler.service').triggerImmediate(normalizedJobId).catch(() => {});
}

async function enqueueInboundDispatch(
  { inboundMessage, conversation, clinicId, channel, providerMessageId },
  options = {},
) {
  const externalTransaction = options.transaction || null;
  const message = inboundMessage?.id
    ? inboundMessage
    : await db.Message.findByPk(positiveInt(inboundMessage), externalTransaction
      ? { transaction: externalTransaction }
      : undefined);
  if (!message) throw new Error('inbound_message_not_found');
  const resolvedConversation = conversation?.id
    ? conversation
    : await db.Conversation.findByPk(
        positiveInt(conversation || message.conversation_id),
        externalTransaction ? { transaction: externalTransaction } : undefined,
      );
  if (!resolvedConversation) throw new Error('inbound_conversation_not_found');
  if (cleanString(message.direction)?.toLowerCase() !== 'inbound') {
    throw new Error('automation_inbound_dispatch_requires_inbound_message');
  }

  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  let outcome = null;
  const enqueueWithinTransaction = async (transaction) => {
    const acquired = await acquireInboundClaim({
      message,
      conversation: resolvedConversation,
      clinicId,
      channel,
      providerMessageId: providerMessageId || metadata.wamid,
    }, transaction);

    if (
      !acquired.created
      && ['queued', 'processing', 'completed'].includes(cleanString(acquired.claim.status))
    ) {
      outcome = {
        claim: acquired.claim,
        job: null,
        created: false,
        already_processed: acquired.claim.status === 'completed',
        already_dispatched: true,
      };
      return;
    }

    const { job, created } = await jobRequestsService.enqueueUniqueJobRequest({
      type: 'automation_inbound_dispatch',
      priority: 'critical',
      status: 'pending',
      origin: 'inbound_message_outbox',
      maxAttempts: 5,
      dedupeScope: `automation-inbound:${acquired.claimKey}`,
      payload: {
        claim_id: positiveInt(acquired.claim.id),
        message_id: positiveInt(acquired.claim.message_id),
        conversation_id: positiveInt(acquired.claim.conversation_id),
        clinic_id: positiveInt(acquired.claim.clinic_id),
        channel: normalizeChannel(acquired.claim.channel),
      },
    }, { transaction });

    await updateClaim(acquired.claim, {
      owner_type: 'dispatching',
      owner_reference_id: job.id,
      status: 'queued',
      processed_at: null,
    }, { dispatch_job_id: job.id }, { transaction });
    outcome = { claim: acquired.claim, job, created, already_processed: false };
  };

  if (externalTransaction) {
    await enqueueWithinTransaction(externalTransaction);
    if (outcome?.job?.id && typeof externalTransaction.afterCommit === 'function') {
      externalTransaction.afterCommit(() => triggerDispatchJobAfterCommit(outcome.job.id));
    }
    return outcome;
  }

  await db.sequelize.transaction(enqueueWithinTransaction);
  triggerDispatchJobAfterCommit(outcome?.job?.id);
  return outcome;
}

function dispatchAttemptKey(jobRequest) {
  const jobId = positiveInt(jobRequest?.id);
  const attempt = Number(jobRequest?.attempts);
  if (!jobId) return null;
  return `${jobId}:${Number.isInteger(attempt) && attempt > 0 ? attempt : 1}`;
}

async function beginInboundDispatchAttempt(claimId, jobRequest) {
  const attemptKey = dispatchAttemptKey(jobRequest);
  const now = new Date();
  let outcome = null;

  await db.sequelize.transaction(async (transaction) => {
    const claim = await db.AutomationInboundMessageClaim.findByPk(claimId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!claim) {
      outcome = { claim: null, acquired: false, reason: 'claim_not_found' };
      return;
    }
    if (claim.status === 'completed' && claim.processed_at) {
      outcome = { claim, acquired: false, reason: 'already_completed' };
      return;
    }
    if (claim.status === 'queued' && cleanString(claim.owner_type) !== 'dispatching') {
      outcome = { claim, acquired: false, reason: 'already_dispatched' };
      return;
    }

    const metadata = claimMetadata(claim);
    const leaseUntil = parseDate(metadata.processing_lease_until, null);
    if (
      claim.status === 'processing'
      && leaseUntil
      && leaseUntil.getTime() > now.getTime()
    ) {
      outcome = { claim, acquired: false, reason: 'processing', retryAt: leaseUntil };
      return;
    }

    const nextLeaseUntil = new Date(now.getTime() + DISPATCH_LEASE_MS);
    await updateClaim(claim, {
      status: 'processing',
      processed_at: null,
    }, {
      processing_attempt: attemptKey,
      processing_job_id: positiveInt(jobRequest?.id),
      processing_started_at: now.toISOString(),
      processing_lease_until: nextLeaseUntil.toISOString(),
      failure_code: null,
    }, { transaction });
    outcome = { claim, acquired: true, attemptKey, leaseUntil: nextLeaseUntil };
  });

  return outcome;
}

async function failInboundDispatchAttempt(claimId, attemptKey, error, jobRequest) {
  await db.sequelize.transaction(async (transaction) => {
    const claim = await db.AutomationInboundMessageClaim.findByPk(claimId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!claim || claim.status === 'completed') return;
    const metadata = claimMetadata(claim);
    if (attemptKey && metadata.processing_attempt !== attemptKey) return;
    await updateClaim(claim, {
      status: 'failed',
      processed_at: null,
    }, {
      failure_code: cleanString(error?.code) || cleanString(error?.name) || 'inbound_dispatch_failed',
      failed_job_id: positiveInt(jobRequest?.id),
      processing_lease_until: null,
    }, { transaction });
  });
}

async function loadClinicScope(clinicId) {
  const clinic = await db.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId', 'configuracion'],
    raw: true,
  });
  return {
    clinic,
    clinicId: positiveInt(clinicId),
    groupId: positiveInt(clinic?.grupoClinicaId),
  };
}

async function findEffectiveMessageReceivedTemplate({ clinicId, channel, clinicOpenState = null }) {
  const scope = await loadClinicScope(clinicId);
  if (!scope.clinicId) return null;
  const openState = clinicOpenState || await resolveClinicOpenState({ clinicId: scope.clinicId });
  const rows = await db.AutomationFlowTemplateV2.findAll({
    where: {
      trigger_type: 'message_received',
      published_at: { [Op.ne]: null },
      [Op.or]: [
        { clinic_id: scope.clinicId },
        ...(scope.groupId ? [{ group_id: scope.groupId }] : []),
        { is_system: true },
      ],
    },
    order: [['published_at', 'DESC'], ['version', 'DESC'], ['id', 'DESC']],
  });

  const scoped = rows
    .filter((row) => {
      const config = row.trigger_config && typeof row.trigger_config === 'object'
        ? row.trigger_config
        : {};
      if (row.is_system && config.runtime_fallback_enabled !== true) return false;
      return true;
    })
    .map((row) => {
      const rowClinicId = positiveInt(row.clinic_id);
      const rowGroupId = positiveInt(row.group_id);
      const score = rowClinicId === scope.clinicId
        ? 100
        : (rowGroupId && rowGroupId === scope.groupId ? 50 : (row.is_system ? 10 : 0));
      return { row, score };
    })
    .sort((a, b) => b.score - a.score
      || Number(b.row.version || 0) - Number(a.row.version || 0)
      || Number(b.row.id || 0) - Number(a.row.id || 0));

  const highestScope = scoped[0]?.score || null;
  const eligible = highestScope === null
    ? []
    : scoped.filter(({ row, score }) => (
        score === highestScope
        && row.is_active === true
        && triggerConfigMatches({
          config: row.trigger_config,
          channel,
          clinicOpenState: openState,
        })
      ));

  return eligible[0]
    ? { template: eligible[0].row, clinicOpenState: openState, scope }
    : null;
}

async function queueGenericMessageBatch({ claim, message, conversation, channel }) {
  const resolved = await findEffectiveMessageReceivedTemplate({
    clinicId: positiveInt(claim.clinic_id),
    channel,
  });
  if (!resolved) {
    await updateClaim(claim, {
      owner_type: 'unclaimed',
      owner_reference_id: null,
      status: 'completed',
      processed_at: new Date(),
    }, {
      reason: 'no_active_message_received_automation',
      processing_lease_until: null,
    });
    return { queued: false, reason: 'no_active_message_received_automation' };
  }

  let scheduled = null;
  await db.sequelize.transaction(async (transaction) => {
    await db.Conversation.findByPk(conversation.id, {
      attributes: ['id'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let state = await db.ConversationAutomationState.findOne({
      where: { conversation_id: conversation.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingJob = state?.job_request_id
      ? await db.JobRequest.findByPk(state.job_request_id, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    const canExtend = state?.status === 'active'
      && state?.stage === 'collecting'
      && existingJob
      && ['pending', 'queued', 'waiting'].includes(existingJob.status)
      && positiveInt(existingJob.payload?.template_version_id) === positiveInt(resolved.template.id);
    const messageAt = parseDate(message.sent_at || message.createdAt, new Date());
    const firstMessageAt = canExtend
      ? parseDate(state.first_message_at, messageAt)
      : messageAt;
    const deadlineAt = computeBatchDeadline({ firstMessageAt, latestMessageAt: messageAt });
    let job = existingJob;

    if (canExtend) {
      await job.update({
        status: 'waiting',
        next_run_at: deadlineAt,
        payload: {
          ...(job.payload || {}),
          latest_message_id: positiveInt(message.id),
          clinic_open_state: resolved.clinicOpenState?.open_now === true ? 'open' : 'closed',
        },
        error_message: null,
      }, { transaction });
    } else {
      job = await jobRequestsService.enqueueJobRequest({
        type: 'automation_message_received_fire',
        priority: 'critical',
        status: 'waiting',
        origin: 'message_received_buffer',
        maxAttempts: 5,
        nextRunAt: deadlineAt,
        payload: {
          clinic_id: positiveInt(claim.clinic_id),
          conversation_id: positiveInt(conversation.id),
          channel: normalizeChannel(channel),
          template_version_id: positiveInt(resolved.template.id),
          first_message_id: positiveInt(message.id),
          latest_message_id: positiveInt(message.id),
          clinic_open_state: resolved.clinicOpenState?.open_now === true ? 'open' : 'closed',
        },
      }, { transaction });
    }

    await updateClaim(claim, {
      owner_type: 'message_received',
      owner_reference_id: job.id,
      status: 'queued',
      processed_at: null,
    }, {
      template_version_id: resolved.template.id,
      processing_lease_until: null,
    }, { transaction });

    state = await conversationAutomationState.setState({
      clinicId: claim.clinic_id,
      conversationId: conversation.id,
      stage: 'collecting',
      status: 'active',
      sourceMessageId: message.id,
      firstMessageAt,
      deadlineAt,
      jobRequestId: job.id,
      executionId: null,
      appointmentId: null,
      appointmentStatus: null,
      intent: null,
      possibleUrgency: false,
      needsResponse: false,
      manualActionRequired: false,
      failureCode: null,
      completedAt: null,
    }, { transaction, emit: false });
    scheduled = { job, state, extended: canExtend, template: resolved.template };
  });

  conversationAutomationState.emitState(scheduled.state);
  return {
    queued: true,
    extended: scheduled.extended,
    job_request_id: scheduled.job.id,
    template_version_id: scheduled.template.id,
  };
}

async function markClaimCompleted(claim, ownerType, ownerReferenceId = null, metadata = {}) {
  await updateClaim(claim, {
    owner_type: ownerType,
    owner_reference_id: positiveInt(ownerReferenceId),
    status: 'completed',
    processed_at: new Date(),
  }, { ...metadata, processing_lease_until: null });
}

async function runInboundDispatchJob(payload = {}, jobRequest = null) {
  const claimId = positiveInt(payload.claim_id);
  const messageId = positiveInt(payload.message_id);
  if (!claimId || !messageId) throw new Error('automation_inbound_dispatch_ids_required');
  const attempt = await beginInboundDispatchAttempt(claimId, jobRequest);
  if (!attempt?.claim) {
    return { status: 'completed', result: { skipped: true, reason: 'claim_not_found' } };
  }
  if (!attempt.acquired && ['already_completed', 'already_dispatched'].includes(attempt.reason)) {
    return { status: 'completed', result: { claim_id: attempt.claim.id, deduplicated: true } };
  }
  if (!attempt.acquired && attempt.reason === 'processing') {
    return {
      status: 'waiting',
      nextAllowedAt: attempt.retryAt,
      result: { claim_id: attempt.claim.id, deferred: true, reason: 'dispatch_claim_leased' },
    };
  }
  const claim = attempt.claim;

  const message = await db.Message.findByPk(messageId);
  const conversation = message
    ? await db.Conversation.findByPk(message.conversation_id)
    : null;
  if (
    !message
    || !conversation
    || cleanString(message.direction)?.toLowerCase() !== 'inbound'
    || positiveInt(claim.message_id) !== positiveInt(message.id)
    || positiveInt(claim.conversation_id) !== positiveInt(conversation.id)
    || (positiveInt(payload.conversation_id) && positiveInt(payload.conversation_id) !== positiveInt(claim.conversation_id))
    || (positiveInt(payload.clinic_id) && positiveInt(payload.clinic_id) !== positiveInt(claim.clinic_id))
    || (normalizeChannel(payload.channel) && normalizeChannel(payload.channel) !== normalizeChannel(claim.channel))
    || positiveInt(conversation.clinic_id) !== positiveInt(claim.clinic_id)
  ) {
    await failInboundDispatchAttempt(
      claimId,
      attempt.attemptKey,
      new Error('inbound_context_not_found'),
      jobRequest,
    );
    throw new Error('automation_inbound_dispatch_context_not_found');
  }

  try {
    const clinicId = positiveInt(conversation.clinic_id || claim.clinic_id);
    const channel = normalizeChannel(conversation.channel || claim.channel);
    const resumeResult = await automationsV2ResumeService.enqueueInboundResponseResume({
      clinicId,
      conversationId: conversation.id,
      patientId: conversation.patient_id,
      leadId: conversation.lead_id,
      messageText: message.content,
      inboundMessageId: message.id,
      channel,
    });
    if (Array.isArray(resumeResult?.errors) && resumeResult.errors.length) {
      throw new Error('waiting_execution_dispatch_failed');
    }

    const optOutResult = await marketingOptOutService.applyInboundOptOutIfNeeded({
      clinicId,
      conversation,
      inboundMessage: message,
      rawText: message.content,
      patientId: conversation.patient_id,
    });
    if (optOutResult?.applied) {
      await message.update({
        metadata: {
          ...(message.metadata || {}),
          marketing_opt_out: optOutResult,
        },
      });
    }

    if (Number(resumeResult?.matched || 0) > 0) {
      await markClaimCompleted(claim, 'wait_response', resumeResult.execution_ids?.[0], {
        matched_executions: resumeResult.execution_ids || [],
      });
      return {
        status: 'completed',
        result: { claim_id: claim.id, owner: 'wait_response', matched: resumeResult.matched },
      };
    }
    if (optOutResult?.applied) {
      await markClaimCompleted(claim, 'marketing_opt_out', optOutResult.record_id, {
        intent: cleanString(optOutResult.intent),
      });
      return { status: 'completed', result: { claim_id: claim.id, owner: 'marketing_opt_out' } };
    }
    const bulkResult = await marketingBulkSendsService.materializeInboundReply({
      conversation,
      inboundMessage: message,
    });
    if (bulkResult?.applied && bulkResult.classification_delegated_to !== 'automations_v2') {
      await markClaimCompleted(claim, 'marketing_bulk_reply', bulkResult.item_id, {
        list_id: positiveInt(bulkResult.list_id),
      });
      return { status: 'completed', result: { claim_id: claim.id, owner: 'marketing_bulk_reply' } };
    }

    const generic = await queueGenericMessageBatch({ claim, message, conversation, channel });
    return {
      status: 'completed',
      result: {
        claim_id: claim.id,
        owner: generic.queued ? 'message_received' : 'unclaimed',
        queued: generic.queued,
        job_request_id: generic.job_request_id || null,
      },
    };
  } catch (error) {
    await failInboundDispatchAttempt(claimId, attempt.attemptKey, error, jobRequest).catch(() => null);
    throw error;
  }
}

async function findUpcomingAppointment(conversation, now = new Date()) {
  const patientId = positiveInt(conversation?.patient_id);
  const leadId = positiveInt(conversation?.lead_id);
  if (!patientId && !leadId) return { appointment: null, candidateCount: 0 };
  const targetClauses = [
    ...(patientId ? [{ paciente_id: patientId }] : []),
    ...(leadId ? [{ lead_intake_id: leadId }] : []),
  ];
  const rows = await db.CitaPaciente.findAll({
    where: {
      clinica_id: positiveInt(conversation.clinic_id),
      estado: { [Op.in]: ACTIVE_APPOINTMENT_STATUSES },
      fin: { [Op.gte]: now },
      [Op.or]: targetClauses,
    },
    attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'estado', 'inicio', 'fin'],
    order: [['inicio', 'ASC'], ['id_cita', 'ASC']],
    limit: 2,
    raw: true,
  });
  return {
    appointment: rows.length === 1 ? rows[0] : null,
    candidateCount: rows.length,
  };
}

async function reassignBufferedClaimsToWaitingExecution({ claims, conversation, clinicId, channel }) {
  if (!Array.isArray(claims) || !claims.length) {
    return { reassigned: [], remaining: [] };
  }
  const messageIds = claims.map((claim) => positiveInt(claim.message_id)).filter(Boolean);
  const messages = await db.Message.findAll({
    where: {
      id: { [Op.in]: messageIds },
      conversation_id: positiveInt(conversation?.id),
      direction: 'inbound',
    },
    order: [['sent_at', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']],
  });
  if (messages.length !== messageIds.length) {
    throw new Error('message_received_recheck_scope_mismatch');
  }
  const claimByMessageId = new Map(
    claims.map((claim) => [positiveInt(claim.message_id), claim]),
  );
  const reassigned = [];
  const remaining = [];

  for (const message of messages) {
    const claim = claimByMessageId.get(positiveInt(message.id));
    const resumeResult = await automationsV2ResumeService.enqueueInboundResponseResume({
      clinicId,
      conversationId: conversation.id,
      patientId: conversation.patient_id,
      leadId: conversation.lead_id,
      messageText: message.content,
      inboundMessageId: message.id,
      channel,
    });
    if (Array.isArray(resumeResult?.errors) && resumeResult.errors.length) {
      throw new Error('waiting_execution_recheck_failed');
    }
    if (Number(resumeResult?.matched || 0) > 0) {
      await markClaimCompleted(claim, 'wait_response', resumeResult.execution_ids?.[0], {
        matched_executions: resumeResult.execution_ids || [],
        ownership_rechecked_before_generic_fire: true,
      });
      reassigned.push(claim);
    } else {
      remaining.push(claim);
    }
  }
  return { reassigned, remaining };
}

function emitExecutionCreated(execution) {
  const io = getIO();
  if (!io || !execution) return;
  const payload = {
    execution_id: execution.id,
    template_version_id: execution.template_version_id,
    status: execution.status,
    current_node_id: execution.current_node_id,
    clinic_id: positiveInt(execution.clinic_id),
    group_id: positiveInt(execution.group_id),
    trigger_type: execution.trigger_type,
    trigger_entity_type: execution.trigger_entity_type,
    trigger_entity_id: execution.trigger_entity_id,
    created_at: execution.created_at,
  };
  if (payload.clinic_id) io.to(`clinic:${payload.clinic_id}`).emit('flow_execution:created', payload);
  else io.emit('flow_execution:created', payload);
}

async function runMessageReceivedFireJob(payload = {}, jobRequest = null) {
  const jobRequestId = positiveInt(jobRequest?.id);
  const clinicId = positiveInt(payload.clinic_id);
  const conversationId = positiveInt(payload.conversation_id);
  const templateVersionId = positiveInt(payload.template_version_id);
  if (!jobRequestId || !clinicId || !conversationId || !templateVersionId) {
    throw new Error('automation_message_received_fire_ids_required');
  }

  const idempotencyKey = `message_received:job:${jobRequestId}`;
  let [conversation, template, claims, existingExecution] = await Promise.all([
    db.Conversation.findByPk(conversationId),
    db.AutomationFlowTemplateV2.findByPk(templateVersionId),
    db.AutomationInboundMessageClaim.findAll({
      where: {
        owner_type: 'message_received',
        owner_reference_id: jobRequestId,
        status: 'queued',
        clinic_id: clinicId,
        conversation_id: conversationId,
      },
      order: [['message_id', 'ASC']],
    }),
    db.FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } }),
  ]);
  if (!conversation || !template || (!claims.length && !existingExecution)) {
    if (conversation) {
      await conversationAutomationState.completeState({ clinicId, conversationId }, {
        expectedJobRequestId: jobRequestId,
      });
    }
    return { status: 'completed', result: { skipped: true, reason: 'batch_context_not_found' } };
  }
  if (
    existingExecution
    && (
      positiveInt(existingExecution.template_version_id) !== templateVersionId
      || positiveInt(existingExecution.clinic_id) !== clinicId
      || cleanString(existingExecution.trigger_entity_type) !== 'conversation'
      || positiveInt(existingExecution.trigger_entity_id) !== conversationId
    )
  ) {
    throw new Error('message_received_execution_scope_mismatch');
  }
  if (!existingExecution && claims.length) {
    const ownership = await reassignBufferedClaimsToWaitingExecution({
      claims,
      conversation,
      clinicId,
      channel: normalizeChannel(payload.channel || conversation.channel),
    });
    claims = ownership.remaining;
    if (!claims.length) {
      return {
        status: 'completed',
        result: {
          skipped: true,
          reason: 'claimed_by_waiting_execution_after_buffer',
          reassigned_messages: ownership.reassigned.length,
        },
      };
    }
  }
  if (
    !existingExecution
    && (
      template.is_active !== true
      || !template.published_at
      || cleanString(template.trigger_type) !== 'message_received'
    )
  ) {
    await Promise.all(claims.map((claim) => markClaimCompleted(claim, 'unclaimed', null, {
      reason: 'message_received_automation_disabled_before_fire',
    })));
    await conversationAutomationState.completeState({ clinicId, conversationId }, {
      expectedJobRequestId: jobRequestId,
    });
    return { status: 'completed', result: { skipped: true, reason: 'template_not_active' } };
  }

  let appointmentResolution = {
    appointment: existingExecution?.context?.appointment || null,
    candidateCount: Number(existingExecution?.context?.trigger?.data?.appointment_candidate_count || 0),
  };
  let execution = existingExecution;
  let created = false;
  if (!execution) {
    appointmentResolution = await findUpcomingAppointment(conversation);
    const appointment = appointmentResolution.appointment;
    const firstClaim = claims[0];
    const lastClaim = claims[claims.length - 1];
    const context = {
      trigger: {
        type: 'message_received',
        data: {
          clinic_id: clinicId,
          conversation_id: conversationId,
          channel: normalizeChannel(payload.channel || conversation.channel),
          inbound_message_ids: claims.map((claim) => positiveInt(claim.message_id)).filter(Boolean),
          first_inbound_message_id: positiveInt(firstClaim.message_id),
          latest_inbound_message_id: positiveInt(lastClaim.message_id),
          clinic_open_state: cleanString(payload.clinic_open_state),
          appointment_id: positiveInt(appointment?.id_cita),
          appointment_candidate_count: appointmentResolution.candidateCount,
          batch_job_id: jobRequestId,
        },
      },
      conversation: { id: conversationId },
      patient: conversation.patient_id ? { id: positiveInt(conversation.patient_id) } : null,
      lead: conversation.lead_id ? { id: positiveInt(conversation.lead_id) } : null,
      appointment: appointment ? {
        id: positiveInt(appointment.id_cita),
        estado: cleanString(appointment.estado),
      } : null,
      outputs: {},
      __simulation: false,
    };
    try {
      execution = await db.FlowExecutionV2.create({
        idempotency_key: idempotencyKey,
        template_version_id: template.id,
        engine_version: template.engine_version || 'v2',
        status: 'running',
        context,
        current_node_id: template.entry_node_id,
        trigger_type: 'message_received',
        trigger_entity_type: 'conversation',
        trigger_entity_id: conversationId,
        clinic_id: clinicId,
        group_id: positiveInt(template.group_id),
        created_by: positiveInt(template.created_by) || 1,
      });
      created = true;
    } catch (error) {
      if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
      execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
      if (!execution) throw error;
    }
  }

  const terminalExecution = ['completed', 'failed', 'dead_letter', 'cancelled'].includes(
    cleanString(execution.status),
  );
  if (claims.length) {
    await Promise.all(claims.map((claim) => markClaimCompleted(claim, 'message_received', execution.id, {
      batch_job_id: jobRequestId,
      execution_id: execution.id,
    })));
  }
  if (terminalExecution) {
    await conversationAutomationState.completeState({ clinicId, conversationId }, {
      expectedExecutionId: execution.id,
    });
    return {
      status: 'completed',
      result: {
        execution_id: execution.id,
        execution_status: execution.status,
        deduplicated: true,
      },
    };
  }

  const { job } = await jobRequestsService.enqueueUniqueJobRequest({
    type: 'automations_v2_execute',
    priority: 'critical',
    origin: 'message_received_trigger',
    dedupeScope: `flow_execution:${execution.id}`,
    payload: { execution_id: execution.id },
  });
  const appointment = appointmentResolution.appointment;
  const executionTriggerData = execution?.context?.trigger?.data || {};
  const sourceMessageId = positiveInt(executionTriggerData.latest_inbound_message_id)
    || positiveInt(claims[claims.length - 1]?.message_id);
  const statePatch = {
    clinicId,
    conversationId,
    stage: 'analyzing',
    status: 'active',
    sourceMessageId,
    deadlineAt: null,
    executionId: execution.id,
    jobRequestId: job.id,
    appointmentId: appointment?.id_cita || appointment?.id || null,
    appointmentStatus: appointment?.estado || null,
    manualActionRequired: false,
  };
  let state = await conversationAutomationState.updateOwnedState(statePatch, {
    expectedJobRequestId: jobRequestId,
  });
  if (!state) {
    state = await conversationAutomationState.updateOwnedState(statePatch, {
      expectedExecutionId: execution.id,
    });
  }
  if (created) emitExecutionCreated(execution);
  require('./jobScheduler.service').triggerImmediate(job.id).catch(() => {});

  return {
    status: 'completed',
    result: {
      execution_id: execution.id,
      template_version_id: execution.template_version_id,
      inbound_messages: Number(execution?.context?.trigger?.data?.inbound_message_ids?.length || claims.length),
      appointment_candidate_count: appointmentResolution.candidateCount,
      state: state?.stage || null,
      deduplicated: !created,
    },
  };
}

module.exports = {
  ACTIVE_APPOINTMENT_STATUSES,
  BUFFER_DELAY_MS,
  BUFFER_MAX_MS,
  DISPATCH_LEASE_MS,
  RUNTIME_MESSAGE_RECEIVED_CHANNELS,
  acquireInboundClaim,
  beginInboundDispatchAttempt,
  buildClaimKey,
  computeBatchDeadline,
  enqueueInboundDispatch,
  findEffectiveMessageReceivedTemplate,
  findUpcomingAppointment,
  normalizeMessageReceivedTriggerConfig,
  queueGenericMessageBatch,
  reassignBufferedClaimsToWaitingExecution,
  runInboundDispatchJob,
  runMessageReceivedFireJob,
  triggerConfigMatches,
};
