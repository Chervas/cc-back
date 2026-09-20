'use strict';
const C = require('../../services/integrations-broker/src/google-business-profile-write-contract');
const { mutationScope } = require('./businessProfileMutationScope.service');
const receiptWait = require('../lib/businessProfileReceiptWait');
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const fail = (code = 'business_profile_automation_required') => {
  throw Object.assign(Error(code), { code, preserveFlowState: true });
};
function operationId(namespace, executionId, nodeId) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(namespace) || !positive(executionId) || !/^[A-Za-z0-9_-]{1,32}$/.test(nodeId)) fail();
  // One immutable intent for this node occurrence. Neither retries, job claims
  // nor date/plan changes produce another provider mutation ID.
  const hex = C.hash({ domain: 'gbp-hours-execution-v1', namespace, executionId: Number(executionId), nodeId });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const templateDigest = template => C.hash({ id: Number(template.id), version: template.version,
  clinicId: template.clinic_id, groupId: template.group_id, entry: template.entry_node_id,
  nodes: template.nodes, trigger: template.trigger_config, publishedAt: new Date(template.published_at).toISOString() });
function createBusinessProfileAutomation({ models, local, mutations, namespace = () => process.env.JOB_RUNTIME_NAMESPACE,
  enabled = () => process.env.JOBS_WORKER_ENABLED === 'true', now = Date.now }) {
  const db = () => typeof models === 'function' ? models() : models;
  return { async run({ node, runtime, clinicId }) {
    try {
    const resolved = await local.resolveEffectiveLocations(clinicId), location = resolved?.locations?.[0];
    if (!location) fail('business_profile_location_not_configured');
    const brokerContext = await mutations.prepare(location).catch(error => {
      // A binding/gate failure can precede receipt recovery for an existing
      // intent. It must not send the flow down on_fail or clear that node.
      error.preserveFlowState = true; throw error;
    });
    if (!mutations.managed(location, brokerContext)) return null;
    const executionId = Number(runtime?.execution?.id), nodeId = node?.id, runtimeNamespace = namespace();
    const id = operationId(runtimeNamespace, executionId, nodeId);
    const actor = { type: 'automation', userId: Number(runtime?.execution?.created_by), executionId, nodeId };
    if (!positive(actor.userId) || !positive(runtime?.log?.id) || typeof runtime?.jobClaim?.assert !== 'function') fail();
    const template = await db().AutomationFlowTemplateV2.findByPk(runtime.execution.template_version_id, { logging: false });
    if (!template?.published_at) fail();
    const captured = { templateId: Number(template.id), templateDigest: templateDigest(template), nodeDigest: C.hash(node) };
    const initialPlan = C.hash(location.raw_payload?.clinicaclick_special_hours_plan || null);
    const opts = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), logging: false });
    const ownedIntent = async transaction => {
      const row = await db().BusinessProfileMutation.findByPk(id, opts(transaction));
      if (row && (row.actor_type !== 'automation' || Number(row.actor_user_id) !== actor.userId
        || Number(row.execution_id) !== executionId || row.node_id !== nodeId || row.runtime_namespace !== runtimeNamespace
        || Number(row.requested_clinic_id) !== Number(clinicId) || Number(row.mapping_id) !== Number(location.id)
        || row.kind !== 'hours' || C.hash(row.local_input?.automation || null) !== C.hash(captured))) fail('business_profile_mutation_conflict');
      return row;
    };
    const guard = async ({ transaction, baseline = true } = {}) => {
      if (!enabled() || namespace() !== runtimeNamespace) fail();
      // Same lock order for admission and node acceptance. No provider work in SQL.
      const currentTemplate = await db().AutomationFlowTemplateV2.findByPk(captured.templateId, opts(transaction));
      const execution = await db().FlowExecutionV2.findByPk(executionId, opts(transaction));
      await runtime.jobClaim.assert({ transaction, executionId });
      if (!currentTemplate?.is_active || currentTemplate.engine_version !== 'v2' || !currentTemplate.published_at
        || templateDigest(currentTemplate) !== captured.templateDigest
        || !(currentTemplate.nodes || []).some(item => item.id === nodeId && C.hash(item) === captured.nodeDigest)
        || !execution || execution.status !== 'running' || execution.engine_version !== 'v2'
        || execution.current_node_id !== nodeId || Number(execution.created_by) !== actor.userId
        || Number(execution.template_version_id) !== captured.templateId || Number(execution.clinic_id) !== Number(clinicId)
        || currentTemplate.clinic_id != null && Number(currentTemplate.clinic_id) !== Number(clinicId)
        || execution.context?.__managed_job_request_id != null && Number(execution.context.__managed_job_request_id) !== runtime.jobClaim.id) fail();
      const intent = await ownedIntent(transaction);
      if (baseline && !intent) {
        const current = await db().ClinicBusinessLocation.findByPk(location.id, opts(transaction));
        if (!current || C.hash(current.raw_payload?.clinicaclick_special_hours_plan || null) !== initialPlan) fail('business_profile_mutation_conflict');
      }
      return { execution, template: currentTemplate, intent };
    };
    const verifyAutomation = async options => { await guard(options); return true; };
    let result, errorCode = null;
    try {
      await guard();
      const prior = await ownedIntent();
      result = prior
        ? await mutations.recover({ clinicId, operationId: id, actor, verifyAutomation })
        : await local.applyScheduledSpecialHoursPeriod(clinicId, { operationId: id,
          period: node.config.period, timeZone: node.config.time_zone || node.config.timeZone || 'Europe/Madrid' },
        { resolved, actor, verifyAutomation, automation: captured });
    } catch (error) {
      try { await runtime.jobClaim.assert({ executionId }); }
      catch (claimError) { claimError.preserveFlowState = true; throw claimError; }
      const prior = await ownedIntent();
      if (!prior) { error.preserveFlowState = true; throw error; }
      // An admitted intent is never sent again, regardless of which acknowledgement
      // was lost. A later claim queries the original receipt and original plan.
      errorCode = require('./businessProfileMutationJournal.service').safe(error);
      result = { success: false, mutation: { operationId: id, state: 'unknown' } };
    }
    if (result?.mutation?.operationId !== id) fail('business_profile_mutation_conflict');
    await db().sequelize.transaction(async transaction => {
      const current = await guard({ transaction, baseline: false });
      await mutationScope({ models: db(), clinicId: Number(clinicId), mappingId: Number(location.id), userId: actor.userId, transaction });
      const log = await db().FlowExecutionLogV2.findByPk(runtime.log.id, opts(transaction));
      if (!log || Number(log.flow_execution_id) !== executionId || log.node_id !== nodeId || log.status !== 'running') fail();
      const applied = result.success === true && result.mutation.state === 'applied' && current.intent?.state === 'applied';
      const at = new Date(now()), previous = current.execution.context || {}, outputs = previous.outputs || {};
      const pending = applied ? null : receiptWait.nextReceiptWait({ previous: current.execution.waiting_meta,
        operationId: id, createdAt: current.intent?.created_at, now: at.getTime() });
      const review = pending?.review === true;
      const waitUntil = pending?.waitUntil || null;
      const waitingMeta = applied ? null : { resume_mode: 'retry_current_node', reason: receiptWait.PENDING_REASON,
        operation_id: id, receipt_checks: pending.checks, manual_review_required: review, last_error: errorCode };
      const output = { status: applied ? 'success' : 'waiting', provider_status: applied ? 'synced' : 'outcome_unknown',
        operation_id: id, clinic_id: Number(clinicId), at: at.toISOString(),
        ...(applied ? { synced_at: current.intent.applied_at, time_zone: current.intent.local_input.plan.timeZone }
          : { error_code: errorCode, manual_review_required: review }) };
      const next = applied ? (typeof node.outputs?.on_success === 'string' ? node.outputs.on_success.trim() || null : null) : nodeId;
      await runtime.jobClaim.assert({ transaction, executionId });
      await log.update({ status: 'success', finished_at: at, audit_snapshot: {
        kind: applied ? 'success' : 'waiting', next_node_id: applied ? next : undefined,
        wait_until: waitUntil?.toISOString() || null, waiting_meta: waitingMeta,
        node_output_before: outputs[nodeId] || null, node_output_after: output,
      } }, { transaction });
      await current.execution.update({ status: applied ? (next ? 'running' : 'completed') : 'waiting',
        current_node_id: next, context: { ...previous, outputs: { ...outputs, [nodeId]: output } },
        wait_until: waitUntil, waiting_meta: waitingMeta,
        last_error: applied ? null : review ? receiptWait.REVIEW_ERROR : errorCode }, { transaction });
      if (applied && node.config.auto_deactivate_after_execution === true) await current.template.update({
        is_active: false, trigger_config: { ...(current.template.trigger_config || {}), last_executed_at: at.toISOString() },
      }, { transaction });
      if (!enabled() || namespace() !== runtimeNamespace) fail();
      await runtime.jobClaim.assert({ transaction, executionId });
    }).catch(error => { error.preserveFlowState = true; throw error; });
    return { kind: 'persisted', operationId: id };
    } catch (error) {
      // Any read can fail before we discover an existing admitted intent. Keep
      // the node for reconciliation; a database/binding outage is not proof
      // that its external action failed and must not select on_fail.
      error.preserveFlowState = true; throw error;
    }
  } };
}
module.exports = { createBusinessProfileAutomation, operationId,
  run: args => createBusinessProfileAutomation({ models: () => require('../../models'),
    local: require('./businessProfileLocal.service'), mutations: require('./businessProfileMutations.service') }).run(args) };
