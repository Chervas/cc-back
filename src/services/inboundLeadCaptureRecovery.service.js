'use strict';

const config = require('./inboundLeadCaptureConfig.service');

const MAX_ATTEMPTS = 3;
const CLASSIFIER_ERRORS = new Set([
  'inbound_capture_classifier_invalid',
  'inbound_capture_classifier_unavailable',
]);
const DATABASE_ERRORS = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'SequelizeConnectionAcquireTimeoutError',
  'SequelizeConnectionTimedOutError',
]);

// Only this published three-node template can finish by projecting a receipt.
// Extending the graph with another action must never make that action replayable.
function captureNode(execution, template = execution?.templateVersion) {
  const data = execution?.context?.trigger?.data;
  if (
    !data ||
    execution.context.__simulation ||
    !config.CHANNELS.includes(data.channel) ||
    !Number.isSafeInteger(data.message_id) ||
    data.message_id < 1 ||
    !Number.isSafeInteger(data.conversation_id) ||
    data.conversation_id < 1 ||
    !/^[1-9]\d*$/.test(String(data.claim_id)) ||
    !Number.isSafeInteger(execution.clinic_id) ||
    execution.clinic_id < 1 ||
    execution.trigger_type !== 'mensaje_recibido' ||
    execution.trigger_entity_type !== 'message' ||
    execution.trigger_entity_id !== data.message_id ||
    execution.idempotency_key !== `inbound_capture:${execution.clinic_id}:${data.message_id}` ||
    !template?.published_at ||
    template.id !== execution.template_version_id ||
    template.clinic_id !== execution.clinic_id ||
    (template.group_id || null) !== (execution.group_id || null) ||
    template.trigger_config?.managed_feature !== 'inbound_lead_capture' ||
    template.trigger_config.channel !== data.channel ||
    template.template_key !== config.key(execution.clinic_id, data.channel)
  )
    return null;
  const nodes = template.nodes;
  if (!Array.isArray(nodes) || nodes.length !== 3) return null;
  const trigger = nodes.find((node) => node.id === template.entry_node_id);
  const capture = nodes.find((node) => node.id === trigger?.outputs?.on_success);
  const end = nodes.find((node) => node.id === capture?.outputs?.on_success);
  if (
    trigger?.type !== 'trigger/message_received' ||
    capture?.type !== 'action/inbound_lead_capture' ||
    end?.type !== 'control/end' ||
    Object.keys(trigger.outputs).length !== 1 ||
    Object.keys(capture.outputs).length !== 1 ||
    Object.keys(end.outputs || {}).length
  )
    return null;
  return capture;
}

function retry(error, previous) {
  if (error.retryable === false) return null;
  const codes = [error.original?.code, error.parent?.code, error.code, error.name];
  const code =
    codes.find((value) => CLASSIFIER_ERRORS.has(value)) ||
    (codes.some((value) => DATABASE_ERRORS.has(value)) ? 'inbound_capture_database_unavailable' : null);
  if (!code) return null;
  const attempt = (Number.isInteger(previous?.attempt) ? previous.attempt : 0) + 1;
  return { code, attempt, max_attempts: MAX_ATTEMPTS, will_retry: attempt < MAX_ATTEMPTS };
}

async function readCommitted(db, execution, transaction) {
  const data = execution.context.trigger.data;
  const opts = { transaction, raw: true };
  const message = await db.Message.findOne({
    where: { id: data.message_id, direction: 'inbound', conversation_id: data.conversation_id },
    attributes: ['metadata'],
    ...opts,
  });
  const record = message?.metadata?.inboundLeadCapture;
  if (record?.key !== execution.idempotency_key || record.executionId !== execution.id || !record.reason)
    return null;
  const thread = await db.Conversation.findOne({
    where: { id: data.conversation_id, clinic_id: execution.clinic_id },
    attributes: ['channel', 'social_account_id'],
    ...opts,
  });
  if (
    !thread ||
    !(data.channel === 'whatsapp'
      ? thread.channel === 'whatsapp'
      : ['instagram', 'messenger'].includes(thread.channel))
  )
    return null;
  const claim = await db.AutomationInboundMessageClaim.findOne({
    where: {
      id: data.claim_id,
      clinic_id: execution.clinic_id,
      message_id: data.message_id,
      conversation_id: data.conversation_id,
      channel: thread.channel,
    },
    attributes: ['provider_message_id'],
    ...opts,
  });
  if (!claim?.provider_message_id) return null;
  if (thread.channel === 'whatsapp') {
    if (claim.provider_message_id !== message.metadata.wamid) return null;
  } else {
    const receipt = await db.SocialInboxReceipt.findOne({
      where: {
        key: claim.provider_message_id,
        message_id: data.message_id,
        state: { [db.Sequelize.Op.in]: ['notify', 'persisted'] },
      },
      attributes: ['route', 'event'],
      ...opts,
    });
    if (
      receipt?.route?.clinicId !== execution.clinic_id ||
      receipt.route.accountId !== thread.social_account_id ||
      receipt.event?.eventId !== message.metadata.providerId ||
      receipt.event?.channel !== thread.channel
    )
      return null;
  }
  if (
    record.leadId &&
    !(await db.LeadIntake.findOne({
      where: { id: record.leadId, clinica_id: execution.clinic_id },
      attributes: ['id'],
      ...opts,
    }))
  )
    return null;
  return record;
}

// The capture action committed the lead and its message receipt in one transaction.
// After a crash only record that known outcome. A cancelled run stays cancelled.
async function reconcile(db, execution, template, jobClaim) {
  const node = captureNode(execution, template);
  if (!node) return null;
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async (transaction) => {
    const current = await db.FlowExecutionV2.findByPk(execution.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!current || !captureNode(current, template)) return null;
    const cancelled = current.status === 'cancelled' && current.last_error === 'automation_deactivated';
    if (!['running', 'waiting'].includes(current.status) && !cancelled) return null;
    await jobClaim?.assert({ executionId: current.id, transaction });
    const record = await readCommitted(db, current, transaction);
    if (!record) return null;
    const previous = current.context.outputs?.[node.id];
    if (
      cancelled &&
      previous?.reconciled === true &&
      previous.key === record.key &&
      previous.executionId === current.id
    )
      return null;
    const now = new Date();
    const context = {
      ...current.context,
      outputs: {
        ...current.context.outputs,
        [node.id]: { ...record, status: 'success', reconciled: true, at: now.toISOString() },
      },
    };
    const last = await db.FlowExecutionLogV2.findOne({
      where: { flow_execution_id: current.id, node_id: node.id },
      order: [['id', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const logData = {
      status: 'success',
      finished_at: now,
      error_message: null,
      audit_snapshot: {
        kind: 'success',
        reconciled: true,
        node_output_after: context.outputs[node.id],
        next_node_id: node.outputs.on_success,
      },
    };
    let log = last;
    if (!last || last.status === 'error') {
      log = await db.FlowExecutionLogV2.create(
        { ...logData, flow_execution_id: current.id, node_id: node.id, node_type: node.type, started_at: now },
        { transaction },
      );
    } else if (last.status === 'running') {
      await last.update(logData, { transaction });
    }
    await current.update(
      {
        context,
        ...(cancelled
          ? {}
          : {
              status: 'completed',
              current_node_id: null,
              last_error: null,
              waiting_meta: null,
              wait_until: null,
            }),
      },
      { transaction },
    );
    return { execution: current, log };
  });
}

function refreshMessage(execution) {
  const { message_id, conversation_id } = execution.context.trigger.data;
  require('./socket.service').emit('message:refresh', { id: message_id, conversation_id }, [
    `clinic:${execution.clinic_id}`,
  ]);
}

module.exports = { captureNode, retry, reconcile, refreshMessage };
