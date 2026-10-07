'use strict';

const { randomUUID } = require('node:crypto');
const v = require('../lib/appointment-visit-communication');
const r = require('../lib/appointment-visit-runtime-contract');
const { createJobClaim, isJobClaim } = require('./jobClaim.service');
const { createAppointmentVisitCommunicationService } = require('./appointmentVisitCommunications.service');
const JOB_TYPE = 'appointment_visit_dispatch';

// Real SQL attempt ledger over an EXISTING bound Message/JobRequest. It never
// creates a Message/job/execution or calls a provider. Runtime wiring is separate.
function createAppointmentVisitDispatchService({ db, now = () => new Date(), newId = randomUUID, leaseMs = 60000,
  namespace = () => process.env.JOB_RUNTIME_NAMESPACE,
  rolloutEnabled = () => process.env.APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED === 'true',
  foundation = createAppointmentVisitCommunicationService({ db, now, newId }),
  assertExecutionActive = (...args) => require('../lib/automation-runtime-stop').assertExecutionActive(...args),
  preDispatchCheck = null }) {
  for (const name of ['AppointmentVisitDispatch', 'AppointmentVisitCommunication', 'Message', 'Conversation', 'JobRequest', 'FlowExecutionV2']) {
    if (!db?.[name]) throw Error('appointment_visit_dispatch_dependency_missing:' + name);
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) r.fail('lease_invalid');
  const proofs = new WeakMap(), opts = transaction => ({ transaction, hooks: false });
  const time = () => new Date(now()).getTime();
  const transact = (supplied, work) => {
    const execute = transaction => {
      if (transaction?.options?.isolationLevel !== 'READ COMMITTED' || !transaction.LOCK?.UPDATE) r.fail('transaction_invalid');
      return work(transaction);
    };
    return supplied ? execute(supplied) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
  };
  function captureJobClaim({ job, isActive, jobClaim: suppliedClaim = null }) {
    if (!job || job.type !== JOB_TYPE || job.status !== 'running'
      || (suppliedClaim ? !isJobClaim(suppliedClaim) || suppliedClaim.id !== Number(job.id) || suppliedClaim.attempt !== Number(job.attempts)
        : typeof isActive !== 'function')) r.fail('dispatch_job_invalid');
    const token = Object.freeze({ schema: 'appointment-visit-dispatch-claim/1' });
    const jobClaim = suppliedClaim || createJobClaim(job, { isActive, models: db, namespace });
    proofs.set(token, { jobClaim, id: Number(job.id), attempt: Number(job.attempts),
      claimed_at: new Date(Math.floor(new Date(job.last_attempt_at).getTime() / 1000) * 1000), namespace: job.payload?.__runtime_namespace });
    return token;
  }
  function proofFor(token) { const proof = proofs.get(token); if (!proof) r.fail('server_job_claim_required'); return proof; }
  async function rawBoundRows(communication, tx, lock = false) {
    const message = await db.Message.findByPk(communication.message_id, { transaction: tx, ...(lock ? { lock: tx.LOCK.UPDATE } : {}) });
    const conversation = message && await db.Conversation.findByPk(message.conversation_id, { transaction: tx });
    const meta = v.object(message?.metadata);
    if (!message || !conversation || message.direction !== 'outbound' || Number(conversation.clinic_id) !== Number(communication.clinic_id)
      || Number(conversation.patient_id) !== Number(communication.patient_id) || message.automation_delivery_key !== v.deliveryKey(communication)
      || Number(meta.execution_id) !== Number(communication.execution_id) || meta.visit_communication_id !== communication.id) r.fail('dispatch_binding_changed');
    return { message, conversation, meta };
  }
  async function lockCurrent(communicationId, clinicId, claim, tx) {
    const proof = proofFor(claim);
    if (!v.uuid(communicationId) || !v.positiveId(clinicId)) r.fail('scope_invalid');
    const first = await db.AppointmentVisitCommunication.findByPk(communicationId, { transaction: tx });
    if (!first || Number(first.clinic_id) !== clinicId || !first.execution_id || !first.message_id || !first.runtime_stage) r.fail('dispatch_binding_required');
    const initialExecution = await db.FlowExecutionV2.findByPk(first.execution_id, { transaction: tx });
    if (!initialExecution) r.fail('dispatch_binding_required');
    // Actual common guard acquires family -> execution before job -> appointment.
    const execution = await assertExecutionActive(initialExecution, tx, { allowCompleted: true });
    await proof.jobClaim.assert({ transaction: tx });
    const job = await db.JobRequest.findByPk(proof.id, { transaction: tx });
    if (job.type !== JOB_TYPE || job.payload?.visit_communication_id !== communicationId
      || v.qa(job.payload)
      || Number(job.payload?.message_id) !== Number(first.message_id) || Number(job.payload?.execution_id) !== Number(first.execution_id)) r.fail('dispatch_job_scope_changed');
    if (rolloutEnabled() !== true) r.fail('rollout_closed');
    const context = await foundation.inspectCommunicationCurrent({ communicationId, clinicId, transaction: tx });
    r.assertStageExecution({ visit: context.visit, communication: context.communication, execution });
    return { ...context, execution, proof, job };
  }
  async function latestDispatch(communicationId, tx) {
    return db.AppointmentVisitDispatch.findOne({ where: { communication_id: communicationId },
      order: [['attempt_number', 'DESC']], transaction: tx, lock: tx.LOCK.UPDATE });
  }
  const explicitUnknown = message => {
    const meta = v.object(message.metadata); return !!(meta.delivery_unknown || meta.outcome_unknown || meta.wa_response);
  };
  function sameLease(dispatch, proof, message) {
    return dispatch?.status === 'leased' && Number(dispatch.job_request_id) === proof.id && Number(dispatch.job_attempt) === proof.attempt
      && new Date(dispatch.job_claimed_at).getTime() === proof.claimed_at.getTime() && dispatch.runtime_namespace === proof.namespace
      && new Date(dispatch.lease_expires_at).getTime() > time() && message.status === 'sending'
      && message.metadata?.visit_dispatch_token === dispatch.attempt_token && !explicitUnknown(message);
  }
  async function activePersistedLease(dispatch, communication, message, tx) {
    if (dispatch?.status !== 'leased' || new Date(dispatch.lease_expires_at).getTime() <= time()
      || explicitUnknown(message) || message.metadata?.visit_dispatch_token !== dispatch.attempt_token) return false;
    // Read only: do not invert family/job -> appointment/intent/Message locks.
    const job = await db.JobRequest.findByPk(dispatch.job_request_id, { transaction: tx });
    return job?.type === JOB_TYPE && job.status === 'running' && Number(job.attempts) === Number(dispatch.job_attempt)
      && Math.floor(new Date(job.last_attempt_at).getTime() / 1000) === Math.floor(new Date(dispatch.job_claimed_at).getTime() / 1000)
      && job.payload?.__runtime_namespace === dispatch.runtime_namespace
      && job.payload?.visit_communication_id === communication.id
      && Number(job.payload?.message_id) === Number(message.id)
      && Number(job.payload?.execution_id) === Number(communication.execution_id);
  }
  async function recordOutcome(communication, dispatch, message, tx, forceUnknown = false) {
    const outcome = v.messageOutcome(message), status = communication.status;
    if (status === 'accepted' || outcome === 'accepted') {
      if (status !== 'accepted') await communication.update({ status: 'accepted', accepted_at: communication.accepted_at || now() }, opts(tx));
      if (dispatch && dispatch.status !== 'accepted') await dispatch.update({ status: 'accepted', settled_at: dispatch.settled_at || now() }, opts(tx));
      return 'accepted';
    }
    if (status === 'unknown' || forceUnknown || explicitUnknown(message)) {
      if (status !== 'unknown') await communication.update({ status: 'unknown', unknown_at: communication.unknown_at || now() }, opts(tx));
      if (dispatch && dispatch.status !== 'unknown') await dispatch.update({ status: 'unknown', settled_at: dispatch.settled_at || now() }, opts(tx));
      return 'unknown';
    }
    return status;
  }
  async function beginDispatch({ communicationId, clinicId, claim, transaction = null }) {
    return transact(transaction, async tx => {
      const context = await lockCurrent(communicationId, clinicId, claim, tx), communication = context.communication;
      const previous = await latestDispatch(communicationId, tx), { message } = await rawBoundRows(communication, tx, true);
      const settled = await recordOutcome(communication, previous, message, tx,
        message.status === 'sending' && (!previous || previous.status !== 'leased' || new Date(previous.lease_expires_at).getTime() <= time()));
      if (['accepted', 'unknown', 'cancelled'].includes(settled)) return { begun: false, reason: settled, communication, dispatch: previous };
      if (previous?.status === 'leased') {
        if (!sameLease(previous, context.proof, message)) r.fail('dispatch_owned_elsewhere');
        return { begun: false, reused: true, communication, dispatch: previous, delivery_key: v.deliveryKey(communication) };
      }
      if (!['pending', 'failed'].includes(communication.status) || !['pending', 'failed'].includes(message.status)) r.fail('dispatch_not_available');
      const token = newId(), started = now();
      const dispatch = await db.AppointmentVisitDispatch.create({ id: newId(), communication_id: communicationId,
        message_id: Number(message.id), execution_id: Number(communication.execution_id), job_request_id: context.proof.id,
        job_attempt: context.proof.attempt, job_claimed_at: context.proof.claimed_at, runtime_namespace: context.proof.namespace,
        attempt_number: Number(previous?.attempt_number || 0) + 1, attempt_token: token, status: 'leased',
        started_at: started, lease_expires_at: new Date(new Date(started).getTime() + leaseMs) }, opts(tx));
      await communication.update({ status: 'dispatching' }, opts(tx));
      await message.update({ status: 'sending', metadata: { ...v.object(message.metadata), visit_dispatch_token: token } }, opts(tx));
      return { begun: true, communication, dispatch, delivery_key: v.deliveryKey(communication) };
    });
  }
  async function currentAttempt(args, tx) {
    const first = await db.AppointmentVisitDispatch.findByPk(args.dispatchId, { transaction: tx });
    if (!first) r.fail('dispatch_not_found');
    const context = await lockCurrent(first.communication_id, args.clinicId, args.claim, tx);
    const dispatch = await db.AppointmentVisitDispatch.findByPk(first.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    const { message, conversation } = await rawBoundRows(context.communication, tx, true);
    if (args.attemptToken !== dispatch.attempt_token || context.communication.status !== 'dispatching'
      || Number(dispatch.message_id) !== Number(message.id) || !sameLease(dispatch, context.proof, message)
      || v.messageOutcome({ ...message.toJSON(), status: 'pending' }) === 'accepted') r.fail('dispatch_lease_lost');
    return { ...context, dispatch, message, conversation };
  }
  async function assertDispatchAttemptCurrent(args) {
    return transact(args.transaction || null, tx => currentAttempt(args, tx));
  }
  async function preDispatch(args, markNetwork) {
    return transact(args.transaction || null, async tx => {
      const context = await currentAttempt(args, tx);
      if (context.dispatch.network_started_at) r.fail('dispatch_network_already_started');
      try {
        if (typeof preDispatchCheck !== 'function') r.fail('dispatch_authorization_unavailable');
        // Trusted guard dependency, not a caller-provided boolean or send callback.
        const result = await preDispatchCheck(context, { transaction: tx });
        if (result !== undefined) r.fail('dispatch_assertion_contract_invalid');
      } catch (error) {
        // A rolled-back/deadlocked SQL transaction cannot certify a definite
        // pre-network failure. Let the transaction fail; no retry/send here.
        if (error?.name?.startsWith('Sequelize') || error?.original?.code) throw error;
        const outcome = await recordOutcome(context.communication, context.dispatch, context.message, tx);
        if (['accepted', 'unknown'].includes(outcome)) return { allowed: false, reason: outcome, dispatch: context.dispatch };
        const code = typeof error.code === 'string' && /^[a-z][a-z0-9_:-]{0,119}$/.test(error.code) ? error.code : 'pre_dispatch_validation_failed';
        await context.dispatch.update({ status: 'pre_dispatch_failed', settled_at: now(), failure_reason: code }, opts(tx));
        await context.communication.update({ status: 'failed' }, opts(tx));
        await context.message.update({ status: 'failed', metadata: { ...v.object(context.message.metadata),
          visit_pre_dispatch_failed: true, visit_pre_dispatch_failure: code } }, opts(tx));
        return { allowed: false, reason: code, dispatch: context.dispatch };
      }
      if (markNetwork) await context.dispatch.update({ network_started_at: now() }, opts(tx));
      return { allowed: true, dispatch: context.dispatch, message: context.message, delivery_key: v.deliveryKey(context.communication) };
    });
  }
  // Managed consumers prepare outside provider code, then the private broker
  // boundary repeats guards and marks the durable attempt immediately before
  // transport.execute. Existing foundational callers retain the atomic one-shot
  // authorization API; neither variant accepts a caller-shaped send override.
  const prepareDispatch = args => preDispatch(args, false);
  const runPreDispatchCheck = args => preDispatch(args, true);
  async function failBeforeNetwork(args, error) {
    if (error?.name?.startsWith('Sequelize') || error?.original?.code) throw error;
    return transact(args.transaction || null, async tx => {
      const context = await currentAttempt(args, tx);
      if (context.dispatch.network_started_at) r.fail('dispatch_network_already_started');
      const outcome = await recordOutcome(context.communication, context.dispatch, context.message, tx);
      if (['accepted', 'unknown'].includes(outcome)) return { status: outcome };
      const code = typeof error?.code === 'string' && /^[a-zA-Z][a-zA-Z0-9_:-]{0,119}$/.test(error.code) ? error.code : 'pre_dispatch_validation_failed';
      await context.dispatch.update({ status: 'pre_dispatch_failed', settled_at: now(), failure_reason: code }, opts(tx));
      await context.communication.update({ status: 'failed' }, opts(tx));
      await context.message.update({ status: 'failed', metadata: { ...v.object(context.message.metadata),
        visit_pre_dispatch_failed: true, visit_pre_dispatch_failure: code } }, opts(tx));
      return { status: 'failed', reason: code };
    });
  }
  async function reconcileDispatch({ dispatchId, clinicId, transaction = null }) {
    return transact(transaction, async tx => {
      const first = await db.AppointmentVisitDispatch.findByPk(dispatchId, { transaction: tx });
      if (!first) r.fail('dispatch_not_found');
      const communication = await db.AppointmentVisitCommunication.findByPk(first.communication_id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!communication || Number(communication.clinic_id) !== clinicId) r.fail('scope_invalid');
      const dispatch = await db.AppointmentVisitDispatch.findByPk(dispatchId, { transaction: tx, lock: tx.LOCK.UPDATE });
      const { message } = await rawBoundRows(communication, tx, true);
      const active = await activePersistedLease(dispatch, communication, message, tx);
      const status = await recordOutcome(communication, dispatch, message, tx, message.status === 'sending' && !active);
      return { communication, dispatch, status };
    });
  }
  async function cancelIntent({ communicationId, clinicId, reason, transaction = null }) {
    if (typeof reason !== 'string' || !/^[a-z][a-z0-9_:-]{0,119}$/.test(reason)) r.fail('cancellation_reason_invalid');
    return transact(transaction, async tx => {
      const communication = await db.AppointmentVisitCommunication.findByPk(communicationId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!communication || Number(communication.clinic_id) !== clinicId) r.fail('scope_invalid');
      const dispatch = await latestDispatch(communicationId, tx);
      const rows = communication.message_id ? await rawBoundRows(communication, tx, true) : null;
      const active = rows && await activePersistedLease(dispatch, communication, rows.message, tx);
      const status = rows ? await recordOutcome(communication, dispatch, rows.message, tx,
        rows.message.status === 'sending' && (!active || !!dispatch.network_started_at)) : communication.status;
      if (['accepted', 'unknown', 'cancelled'].includes(status)) return { cancelled: false, communication, dispatch };
      await communication.update({ status: 'cancelled', cancelled_at: now(), cancellation_reason: reason }, opts(tx));
      if (dispatch?.status === 'leased') await dispatch.update({ status: 'cancelled', settled_at: now(), failure_reason: reason }, opts(tx));
      if (rows) await rows.message.update({ status: 'failed', metadata: { ...rows.meta, cancelled: true, cancellation_reason: reason } }, opts(tx));
      return { cancelled: true, communication, dispatch };
    });
  }
  return Object.freeze({ captureJobClaim, beginDispatch, assertDispatchAttemptCurrent, prepareDispatch, runPreDispatchCheck, failBeforeNetwork, reconcileDispatch, cancelIntent });
}
module.exports = { JOB_TYPE, createAppointmentVisitDispatchService };
