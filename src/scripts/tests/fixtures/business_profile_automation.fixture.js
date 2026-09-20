'use strict';
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
module.exports = async ({ sql, models, report, local, consumer, resolved, actor, setBefore, setAfter, writes }) => {
  require('./security_offline_runtime.cjs');
  models.Sequelize = require('sequelize');
  for (const [name, file] of [['AutomationFlowTemplateV2', 'automationflowtemplatev2'], ['FlowExecutionV2', 'flowexecutionv2'],
    ['FlowExecutionLogV2', 'flowexecutionlogv2'], ['JobRequest', 'jobrequest']]) {
    models[name] = require('../../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.FlowExecutionV2.belongsTo(models.AutomationFlowTemplateV2, { foreignKey: 'template_version_id', as: 'templateVersion' });
  const previousEnv = process.env.JOB_RUNTIME_NAMESPACE; process.env.JOB_RUNTIME_NAMESPACE = 'staging';
  const requests = require('../../../services/jobRequests.service');
  assert.equal(requests.getCurrentRuntimeNamespace(), 'staging');
  let enabled = true;
  const savedResolve = local.resolveEffectiveLocations;
  local.resolveEffectiveLocations = async () => ({ ...resolved, locations: [await models.ClinicBusinessLocation.findByPk(51)] });
  const factory = require('../../../services/businessProfileAutomation.service');
  const automation = factory.createBusinessProfileAutomation({ models, local, mutations: consumer, enabled: () => enabled, namespace: () => 'staging' });
  const { executor, engine } = require('./business_profile_flow_runtime.fixture')({ models, local, requests, automation });
  let sequence = 0;
  async function setup() {
    const id = ++sequence;
    const node = { id: 'apply_hours', type: 'action/update_google_special_hours', config: {
      time_zone: 'Europe/Madrid', period: { id: 'auto', label: 'Automático', kind: 'closed', startDate: '2027-02-01', endDate: '2027-02-01' },
      auto_deactivate_after_execution: true }, outputs: { on_success: 'end' } };
    const template = await models.AutomationFlowTemplateV2.create({ public_id: 'qa_hours_' + id, template_key: 'qa_hours_' + id,
      version: 1, name: 'Fictitious hours', trigger_type: 'scheduled_once', trigger_config: { managed_feature: 'google_special_hours' },
      clinic_id: 72, entry_node_id: 'apply_hours', nodes: [node, { id: 'end', type: 'control/end', outputs: {}, config: {} }],
      published_at: new Date(), published_by: actor.userId, created_by: actor.userId });
    const execution = await models.FlowExecutionV2.create({ idempotency_key: 'qa_hours_' + id, template_version_id: template.id,
      status: 'running', current_node_id: 'apply_hours', clinic_id: 72, created_by: actor.userId, trigger_type: 'scheduled_once',
      context: { clinic: { id_clinica: 72 }, communication_language: 'es', outputs: {} } });
    const job = await requests.enqueueJobRequest({ type: 'automations_v2_execute', payload: { execution_id: execution.id }, requestedBy: actor.userId });
    await execution.update({ context: { ...execution.context, __managed_job_request_id: job.id } });
    return { node, template, execution, job, operationId: factory.operationId('staging', execution.id, node.id) };
  }
  async function run(item, runner = executor) {
    const claim = await requests.claimJobById(item.job.id); assert(claim);
    const result = await runner.runJob(claim);
    await item.execution.reload(); await item.template.reload();
    return { result, claim };
  }
  async function retry(item) {
    await item.execution.update({ wait_until: new Date(Date.now() - 1000) });
    await requests.setPending(item.job.id);
  }
  try {
    const first = await setup(), before = writes();
    const complete = await run(first);
    assert.equal(complete.result.status, 'completed', complete.result.error?.stack);
    assert.equal(first.execution.status, 'completed'); assert.equal(first.template.is_active, false);
    assert.equal(writes(), before + 1);
    const row = await models.BusinessProfileMutation.findByPk(first.operationId);
    assert.equal(row.actor_type, 'automation'); assert.equal(row.execution_id, first.execution.id); assert.equal(row.state, 'applied');
    assert(row.local_input.plan.periods.some(period => period.startDate === '2027-03-01'), 'existing nonoverlapping hours survive');
    assert.equal(first.execution.context.outputs.apply_hours.operation_id, first.operationId);
    const events = await models.PlatformAuditEvent.findAll({ where: { correlation_id: first.operationId }, raw: true });
    assert.equal(events.length, 2); assert(events.every(event => JSON.parse(event.body).actor.type === 'job'));
    report.checks.push('actual executor and flow engine publish scheduled hours through typed broker once, preserve other periods, audit original execution/node and atomically accept output/deactivate template');

    const lost = await setup();
    setAfter(() => { setAfter(null); throw Object.assign(Error('FICTITIOUS_ACK_LOST'), { code: 'broker_unavailable' }); });
    assert.equal((await run(lost)).result.status, 'waiting');
    assert.equal(lost.execution.current_node_id, 'apply_hours'); assert.equal(lost.template.is_active, true);
    assert.equal(lost.execution.context.outputs.apply_hours.provider_status, 'outcome_unknown');
    const waitingSnapshot = JSON.stringify(lost.execution.toJSON());
    const logCount = await models.FlowExecutionLogV2.count({ where: { flow_execution_id: lost.execution.id } });
    for (const resumeMode of ['timeout', 'response', 'form_submission', undefined]) {
      await assert.rejects(engine.runExecution(lost.execution.id, { resumeMode }), { code: 'business_profile_receipt_required' });
      await lost.execution.reload(); assert.equal(JSON.stringify(lost.execution.toJSON()), waitingSnapshot);
    }
    assert.equal(await models.FlowExecutionLogV2.count({ where: { flow_execution_id: lost.execution.id } }), logCount);
    report.checks.push('generic timeout/response/form resume and absent mode reject before changing execution, receipt-check counter or logs');
    const immutable = (await models.BusinessProfileMutation.findByPk(lost.operationId)).input_digest, sent = writes();
    await retry(lost);
    assert.equal((await run(lost)).result.status, 'completed'); assert.equal(writes(), sent);
    assert.equal((await models.BusinessProfileMutation.findByPk(lost.operationId)).input_digest, immutable);
    assert.equal(lost.template.is_active, false);
    report.checks.push('lost ACK waits at original node, keeps template active and preserves immutable plan/UUID; new job attempt only queries receipt, then advances once without republishing');

    const takeover = await setup();
    setAfter(async () => { setAfter(null); await models.JobRequest.increment('attempts', { where: { id: takeover.job.id } }); });
    const stale = await run(takeover);
    assert.equal(stale.result.status, 'failed'); assert.equal(stale.result.error?.code, 'job_claim_lost');
    assert.equal(takeover.execution.status, 'running'); assert.equal(takeover.execution.current_node_id, 'apply_hours');
    assert.equal(takeover.template.is_active, true); assert.equal((await models.BusinessProfileMutation.findByPk(takeover.operationId)).state, 'attempted');
    for (const settle of [requests.markCompleted, requests.markWaiting, requests.markFailed]) {
      const settlement = await settle(takeover.job.id, { expectedAttempt: stale.claim.attempts });
      assert.equal(settlement.updated, 0); assert.equal(settlement.conflict, true);
    }
    const repair = await requests.recoverRunningJobAfterSettlementFailure(takeover.job.id, { expectedAttempt: stale.claim.attempts, status: 'waiting' });
    assert.equal(repair.updated, 0); assert.equal(repair.resolved, true);
    assert.equal((await models.JobRequest.findByPk(takeover.job.id)).status, 'running');
    const sentBeforeRecovery = writes(); await retry(takeover);
    assert.equal((await run(takeover)).result.status, 'completed'); assert.equal(writes(), sentBeforeRecovery);
    report.checks.push('superseded claim cannot apply provider receipt, advance/deactivate flow or settle/recover a newer running job attempt; next current claim reconciles original intent');

    const disabled = await setup(), prior = writes(); enabled = false;
    assert.equal((await run(disabled)).result.status, 'failed'); enabled = true;
    assert.equal(writes(), prior); assert.equal(await models.BusinessProfileMutation.findByPk(disabled.operationId), null);
    assert.equal(disabled.execution.current_node_id, 'apply_hours');
    await disabled.template.update({ is_active: false }); await retry(disabled);
    assert.equal((await run(disabled)).result.status, 'failed'); assert.equal(writes(), prior);
    assert.equal(disabled.execution.current_node_id, 'apply_hours');
    report.checks.push('disabled worker and inactive template reject before admission/provider without fabricating node success or reactivating automation');

    const timeout = await setup();
    let releaseProvider, settleHandler;
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    const handlerSettled = new Promise(resolve => { settleHandler = resolve; });
    const slow = require('./business_profile_flow_runtime.fixture')({ models, local, requests, automation,
      timeoutMs: 2000, onExecutionSettled: settleHandler });
    const beforeTimeout = writes();
    setAfter(async () => { setAfter(null); await providerGate; });
    try {
      const expired = await run(timeout, slow.executor);
      assert.equal(expired.result.status, 'failed');
      assert.equal(expired.result.retryable, false);
      assert.match(expired.result.error.message, /tiempo máximo/);
      assert.equal(writes(), beforeTimeout + 1, 'provider accepted before actual executor timeout');
    } finally { releaseProvider(); await handlerSettled; }
    await timeout.execution.reload(); await timeout.template.reload();
    assert.equal(timeout.execution.current_node_id, 'apply_hours'); assert.equal(timeout.template.is_active, true);
    assert.equal((await models.BusinessProfileMutation.findByPk(timeout.operationId)).state, 'attempted');
    const afterTimeout = writes(); await retry(timeout);
    assert.equal((await run(timeout)).result.status, 'completed'); assert.equal(writes(), afterTimeout);
    report.checks.push('real executor Promise.race expires after provider accepted; released late handler cannot accept receipt/advance/deactivate; current retry recovers without another mutation');

    const permission = await setup();
    setAfter(async () => { setAfter(null); await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_clinica: 73 } }); });
    assert.equal((await run(permission)).result.status, 'failed');
    assert.equal(permission.execution.current_node_id, 'apply_hours'); assert.equal(permission.template.is_active, true);
    assert.equal((await models.BusinessProfileMutation.findByPk(permission.operationId)).state, 'attempted');
    const permissionSent = writes();
    await retry(permission); assert.equal((await run(permission)).result.status, 'failed'); assert.equal(writes(), permissionSent);
    await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_clinica: 73 } });
    await retry(permission); assert.equal((await run(permission)).result.status, 'completed'); assert.equal(writes(), permissionSent);
    report.checks.push('permission revoked on a shared clinic after dispatch prevents both cache and node acceptance; forbidden retry does not resend; restored permission reconciles original receipt');

    const edited = await setup(), originalNodes = structuredClone(edited.template.nodes);
    setAfter(async () => { setAfter(null); const changed = structuredClone(originalNodes);
      changed[0].config.period.endDate = '2027-02-02'; await edited.template.update({ nodes: changed }); });
    assert.equal((await run(edited)).result.status, 'failed');
    assert.equal(edited.execution.current_node_id, 'apply_hours'); assert.equal(edited.template.is_active, true);
    const editedSent = writes(); await retry(edited);
    assert.equal((await run(edited)).result.status, 'failed'); assert.equal(writes(), editedSent);
    await edited.template.update({ nodes: originalNodes }); await retry(edited);
    assert.equal((await run(edited)).result.status, 'completed'); assert.equal(writes(), editedSent);
    report.checks.push('template edited in flight cannot accept old receipt or replace original intent with changed dates; identical original template can recover status only');

    const rollback = await setup(); let rejectAcceptance = true;
    models.FlowExecutionLogV2.addHook('beforeUpdate', 'qa_acceptance_rollback', log => {
      if (Number(log.flow_execution_id) === rollback.execution.id && log.status === 'success' && rejectAcceptance) {
        rejectAcceptance = false; throw Error('FICTITIOUS_SQL_ACCEPTANCE_FAILURE');
      }
    });
    try { assert.equal((await run(rollback)).result.status, 'failed'); }
    finally { models.FlowExecutionLogV2.removeHook('beforeUpdate', 'qa_acceptance_rollback'); }
    assert.equal(rollback.execution.current_node_id, 'apply_hours'); assert.equal(rollback.template.is_active, true);
    assert.equal(rollback.execution.context.outputs.apply_hours, undefined);
    assert.equal((await models.BusinessProfileMutation.findByPk(rollback.operationId)).state, 'applied');
    const rollbackSent = writes(); await retry(rollback);
    assert.equal((await run(rollback)).result.status, 'completed'); assert.equal(writes(), rollbackSent);
    report.checks.push('SQL node-acceptance failure rolls back log/output/next-node/deactivation together; already applied immutable receipt is accepted by next attempt without redispatch');

    for (const delayedNode of ['apply_hours', 'end']) {
      const late = await setup(); let releaseSql, settleLate, reached = false;
      const sqlGate = new Promise(resolve => { releaseSql = resolve; });
      const lateSettled = new Promise(resolve => { settleLate = resolve; });
      const delayed = require('./business_profile_flow_runtime.fixture')({ models, local, requests, automation,
        timeoutMs: 2000, onExecutionSettled: settleLate });
      models.FlowExecutionLogV2.addHook('beforeUpdate', 'qa_late_sql', async log => {
        if (Number(log.flow_execution_id) === late.execution.id && log.node_id === delayedNode && log.status === 'success') {
          reached = true; await sqlGate;
        }
      });
      try {
        const expired = await run(late, delayed.executor);
        assert.equal(expired.result.status, 'failed'); assert.equal(expired.result.retryable, false); assert(reached);
      } finally { releaseSql(); await lateSettled; models.FlowExecutionLogV2.removeHook('beforeUpdate', 'qa_late_sql'); }
      await late.execution.reload(); await late.template.reload();
      assert.equal(late.execution.status, 'running'); assert.equal(late.execution.current_node_id, delayedNode);
      assert.equal(late.template.is_active, delayedNode === 'apply_hours');
      assert.equal((await models.BusinessProfileMutation.findByPk(late.operationId)).state, 'applied');
      if (delayedNode === 'apply_hours') assert.equal(late.execution.context.outputs.apply_hours, undefined);
      const lateSent = writes(); await retry(late);
      assert.equal((await run(late)).result.status, 'completed'); assert.equal(writes(), lateSent);
    }
    report.checks.push('timeout during atomic hours acceptance rolls back node and template; timeout at subsequent end node cannot overwrite flow; both recover without repeating accepted provider write');

    const baseline = await setup(), liveResolve = local.resolveEffectiveLocations, baselineSent = writes();
    let cachedPlan;
    local.resolveEffectiveLocations = async () => {
      local.resolveEffectiveLocations = liveResolve;
      const snapshot = await liveResolve(), row = snapshot.locations[0]; cachedPlan = structuredClone(row.raw_payload);
      await models.ClinicBusinessLocation.update({ raw_payload: { ...cachedPlan,
        clinicaclick_special_hours_plan: { ...cachedPlan.clinicaclick_special_hours_plan, changedByOtherWriter: true } } }, { where: { id: 51 } });
      return snapshot;
    };
    try {
      assert.equal((await run(baseline)).result.status, 'failed'); assert.equal(writes(), baselineSent);
      assert.equal(await models.BusinessProfileMutation.findByPk(baseline.operationId), null);
    } finally { local.resolveEffectiveLocations = liveResolve;
      if (cachedPlan) await models.ClinicBusinessLocation.update({ raw_payload: cachedPlan }, { where: { id: 51 } }); }
    report.checks.push('plan changed after snapshot but before admission rejects instead of composing from stale hours or creating a provider intent');

    const invalid = await setup(), acquired = await requests.claimJobById(invalid.job.id);
    const claims = require('../../../services/jobClaim.service');
    let activeClaim = true, claimNamespace = 'staging';
    const owner = claims.createJobClaim(acquired, { models, isActive: () => activeClaim, namespace: () => claimNamespace });
    await owner.assert({ executionId: invalid.execution.id });
    await assert.rejects(owner.assert({ executionId: invalid.execution.id + 1 }), { code: 'job_claim_lost' });
    claimNamespace = 'dev'; await assert.rejects(owner.assert(), { code: 'job_claim_lost' }); claimNamespace = 'staging';
    activeClaim = false; await assert.rejects(owner.assert(), { code: 'job_claim_lost' }); activeClaim = true;
    await requests.markCancelled(invalid.job.id);
    await assert.rejects(owner.assert(), { code: 'job_claim_lost' });
    const invalidSent = writes(); assert.equal((await executor.runJob(acquired)).status, 'failed'); assert.equal(writes(), invalidSent);
    assert.equal(await models.FlowExecutionLogV2.count({ where: { flow_execution_id: invalid.execution.id } }), 0);
    report.checks.push('claim binds live executor, explicit namespace and exact execution; cancelled job cannot start engine, create node log or mutate provider');

    const uncertain = await setup(), uncertainSent = writes();
    setBefore(command => { if (!command.operation.endsWith('.status.v1')) throw Object.assign(Error('FICTITIOUS_NOT_DELIVERED'), { code: 'broker_unavailable' }); });
    try { assert.equal((await run(uncertain)).result.status, 'waiting'); }
    finally { setBefore(null); }
    assert.equal(writes(), uncertainSent);
    const originalDigest = (await models.BusinessProfileMutation.findByPk(uncertain.operationId)).input_digest;
    for (let checks = 2; checks < 8; checks++) {
      await retry(uncertain); assert.equal((await run(uncertain)).result.status, 'waiting');
      assert.equal(uncertain.execution.waiting_meta.receipt_checks, checks);
      const delay = +uncertain.execution.wait_until - Date.now();
      assert(delay <= 3600000 && delay > Math.min(3600000, 60000 * 2 ** Math.min(checks - 1, 6)) - 5000);
    }
    assert.equal(writes(), uncertainSent); assert.equal(uncertain.template.is_active, true);
    assert.equal(uncertain.execution.current_node_id, 'apply_hours');
    assert.equal((await models.BusinessProfileMutation.findByPk(uncertain.operationId)).input_digest, originalDigest);
    report.checks.push('broker not_found stays waiting on original immutable operation; bounded receipt checks back off from one minute to at most hourly, never republish or deactivate template');
    local.resolveEffectiveLocations = async () => { throw Error('FICTITIOUS_MAPPING_READ_OUTAGE'); };
    try {
      await retry(uncertain); assert.equal((await run(uncertain)).result.status, 'failed');
      assert.equal(uncertain.execution.current_node_id, 'apply_hours'); assert.equal(uncertain.template.is_active, true);
      assert.equal(writes(), uncertainSent);
    } finally { local.resolveEffectiveLocations = liveResolve; }
    report.checks.push('mapping lookup outage before discovering an existing intent preserves its node and never selects an error branch or republishes');

    await retry(uncertain);
    const exhausted = (await run(uncertain)).result;
    assert.equal(exhausted.status, 'failed'); assert.equal(exhausted.retryable, false);
    assert.equal(exhausted.error.code, 'business_profile_mutation_review_required');
    assert.equal(uncertain.execution.status, 'waiting'); assert.equal(uncertain.execution.current_node_id, 'apply_hours');
    assert.equal(uncertain.execution.waiting_meta.receipt_checks, 8);
    assert.equal(uncertain.execution.waiting_meta.manual_review_required, true);
    assert.equal(uncertain.execution.wait_until, null); assert.equal(uncertain.template.is_active, true);
    assert.equal(uncertain.execution.context.outputs.apply_hours.manual_review_required, true);
    assert.equal((await models.BusinessProfileMutation.findByPk(uncertain.operationId)).input_digest, originalDigest);
    let furtherCalls = 0; setBefore(() => { furtherCalls++; });
    try {
      await retry(uncertain);
      const held = (await run(uncertain)).result;
      assert.equal(held.status, 'failed'); assert.equal(held.retryable, false);
      for (const resumeMode of ['timeout', 'response', 'retry_current_node']) {
        const heldExecution = await engine.runExecution(uncertain.execution.id, { resumeMode });
        assert.equal(heldExecution.waiting_meta.manual_review_required, true);
      }
      assert.equal(furtherCalls, 0); assert.equal(writes(), uncertainSent);
    } finally { setBefore(null); }
    report.checks.push('eighth unconfirmed outcome holds flow for human review and returns nonretryable job failure; forced claims and generic resumes cannot query again, publish, advance or deactivate');
  } finally {
    local.resolveEffectiveLocations = savedResolve; setBefore(null); setAfter(null);
    if (previousEnv === undefined) delete process.env.JOB_RUNTIME_NAMESPACE; else process.env.JOB_RUNTIME_NAMESPACE = previousEnv;
  }
};
