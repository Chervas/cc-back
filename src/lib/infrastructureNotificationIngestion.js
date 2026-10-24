'use strict';

const P = require('./infrastructureNotificationProtocol');
const uniqueError = error => error?.name === 'SequelizeUniqueConstraintError' || error?.original?.code === 'ER_DUP_ENTRY';
const plain = row => typeof row?.get === 'function' ? row.get({ plain: true }) : row;

function createIngestor({ sequelize, Receipt, State, queueNotification, configuration, now = Date.now }) {
 async function completed(event) {
  const row = plain(await Receipt.findByPk(event.receiptKey));
  if (row) {
   P.need(row.topic_arn === event.topicArn && row.sns_message_id === event.messageId && row.payload_sha256 === event.payloadSha256
    && row.resource_arn === event.resourceArn && P.ACKABLE.has(row.outcome), 'infrastructure_receipt_conflict');
   return { committed: true, duplicate: true, receiptKey: event.receiptKey, outcome: row.outcome };
  }
  if (event.testNonce) {
   const test = plain(await Receipt.findOne({ where: { delivery_test_nonce: event.testNonce } }));
   if (test) {
    P.need(test.outcome === 'TESTED' && test.topic_arn === event.topicArn && test.resource_arn === event.resourceArn, 'infrastructure_test_nonce_conflict');
    return { committed: true, duplicate: true, receiptKey: test.receipt_key, outcome: 'TESTED' };
   }
  }
  return null;
 }
 async function ingest(raw) {
  const event = P.parseEnvelope(raw, now());
  const previous = await completed(event);if (previous) return previous;
  if (event.testNonce) P.authorizeTest(event, configuration, now());
  try {
   // Managed transaction resolves only after COMMIT ACK. Any rejection, including
   // an uncertain commit, returns no SQS acknowledgement. A later durable read
   // can establish that the same receipt/outbox already committed.
   return await sequelize.transaction({ isolationLevel: 'READ COMMITTED', retry: { max: 0 } }, async transaction => {
    const receipt = await Receipt.create({ receipt_key: event.receiptKey, topic_arn: event.topicArn,
     sns_message_id: event.messageId, payload_sha256: event.payloadSha256, resource_arn: event.resourceArn,
     source_kind: event.kind, event_id: event.eventId || null, event_category: event.kind === 'RDS_EVENT' ? event.definition?.category || null : null,
     delivery_test_nonce: event.testNonce, state_changed_at: new Date(event.changedAt), outcome: 'PENDING',
     received_at: new Date(now()), notification_result: null }, { transaction });
    let decision = event.kind === 'RDS_EVENT' ? { outcome: event.definition ? 'QUEUED' : 'IGNORED', notify: Boolean(event.definition) } : { outcome: 'TESTED', notify: true };
    let state;
    if (event.kind === 'CLOUDWATCH_ALARM' && !event.testNonce) {
     await sequelize.query(`INSERT INTO InfrastructureNotificationStates
      (alarm_key,alarm_arn,state,state_changed_at,last_receipt_key,updated_at)
      VALUES (:key,:arn,'UNOBSERVED',NULL,NULL,:now)
      ON DUPLICATE KEY UPDATE alarm_key=alarm_key`, { transaction,
      replacements: { key: event.alarmKey, arn: event.alarmArn, now: new Date(now()) } });
     state = await State.findByPk(event.alarmKey, { transaction, lock: transaction.LOCK.UPDATE });
     P.need(state?.alarm_arn === event.alarmArn, 'infrastructure_state_identity');
     decision = P.transition(state, event);
    }
    const queued = decision.notify ? await queueNotification({ ...P.notification(event), transaction, runtimeNamespace: 'staging' }) : null;
    if (event.testNonce) P.need(queued?.created?.length === 1 && queued.created[0].channel === 'email', 'infrastructure_test_email_not_queued');
    const outcome = decision.notify && !queued?.created?.length ? 'NO_CHANNELS' : decision.outcome;
    if (state && !decision.preserve) await state.update({ state: event.newState, state_changed_at: new Date(event.changedAt),
     last_receipt_key: event.receiptKey, updated_at: new Date(now()) }, { transaction });
    await receipt.update({ outcome, notification_result: queued, processed_at: new Date(now()) }, { transaction });
    return { committed: true, duplicate: false, receiptKey: event.receiptKey, outcome };
   });
  } catch (error) {
   // A competing receipt insert has committed if this separate durable read
   // sees a completed row. Never infer this from a uniqueness error alone.
   if (uniqueError(error)) { const known = await completed(event);if (known) return known; }
   throw error;
  }
 }
 return { ingest };
}
function withDeadline(promise, milliseconds) {
 let timer;
 return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('infrastructure_worker_deadline')), Math.max(1, milliseconds)); })])
  .finally(() => clearTimeout(timer));
}
function createWorker({ ingest, collector, now = Date.now, budgetMs = 20000 }) {
 return async function run() {
  const end = now() + budgetMs;const result = { received: 0, committed: 0, duplicate: 0, acknowledged: 0, rejected: 0, unknownAcknowledgements: 0 };
  const batch = await withDeadline(collector.receive(Math.max(1, end - now())), end - now());
  P.need(batch?.ok === true && batch.operation === 'receive' && batch.queueArn === P.QUEUE_ARN
   && batch.identity?.accountId === P.ACCOUNT && batch.identity.roleArn === P.ROLE
   && Array.isArray(batch.messages) && batch.messages.length <= 10, 'infrastructure_collector_scope');
  result.received = batch.messages.length;
  for (const message of batch.messages) {
   if (now() >= end) break;
   P.need(P.validHandle(message?.receiptHandle) && typeof message.snsEnvelopeRaw === 'string', 'infrastructure_collector_message');
   try {
    const receipt = await withDeadline(ingest(message.snsEnvelopeRaw), end - now());
    P.need(receipt?.committed === true, 'infrastructure_commit_unknown');
    result.committed++;if (receipt.duplicate) result.duplicate++;
    if (now() >= end) break;
    try {
     const ack = await withDeadline(collector.ack(message.receiptHandle, end - now()), end - now());
     P.need(ack?.ok === true && ack.operation === 'ack' && ack.deleted === true, 'infrastructure_ack_unknown');
     result.acknowledged++;
    } catch { result.unknownAcknowledgements++; }
   } catch { result.rejected++; }
  }
  // No envelope, receiptHandle, provider reason, credential or raw error leaves RAM.
  return { status: result.rejected || result.unknownAcknowledgements ? 'failed' : 'completed', ...result,
   retryable: false, deadlineReached: now() >= end, unacknowledged: result.received - result.acknowledged };
 };
}
module.exports = { createIngestor, createWorker, withDeadline };
