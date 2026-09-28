'use strict';
const { randomUUID } = require('node:crypto');
const C = require('../../services/integrations-broker/src/google-optimization-write-contract');
const { verifyChange } = require('./campaignWorkspaceOptimizationCommand.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
function payloadFor(run, expiresAt) {
  const change = verifyChange(run.change); const target = change.target;
  const kinds = { status: 'pause_ad', cpc_bid_micros: 'manual_cpc', amount_micros: 'daily_budget',
    'target_cpa.target_cpa_micros': 'target_cpa', 'maximize_conversions.target_cpa_micros': 'maximize_conversions_cpa',
    'target_roas.target_roas': 'target_roas', 'maximize_conversion_value.target_roas': 'maximize_conversion_value_roas' };
  if (change.reference.provider !== 'google_ads' || !Object.hasOwn(kinds, target.field)) fail('workspace_optimization_service_pending');
  const payload = { executionId: run.id, mandateId: run.mandate_id, evidenceFingerprint: C.hash(run.evidence), expiresAt,
    campaignId: change.reference.campaign_id, kind: kinds[target.field], resourceId: target.id,
    adGroupId: target.action === 'pause_underperforming_ads' ? target.group_id : null,
    baselineAdId: target.action === 'pause_underperforming_ads' ? run.evidence.baseline_ad_id : null,
    before: change.before, after: change.after };
  C.validate('apply', payload);
  if (C.mutation(payload, change.reference.account_id).resourceName !== target.resource) fail('workspace_optimization_plan_changed');
  return payload;
}
function validateSubmission(run, value) {
  if (!value || Object.keys(value).sort().join(',') !== 'authority,payload,schema_version' || value.schema_version !== 1
    || typeof value.authority !== 'string' || !/^[a-f0-9]{64}$/.test(value.authority)
    || C.hash(payloadFor(run, value.payload?.expiresAt)) !== C.hash(value.payload)) fail('workspace_optimization_plan_changed');
  return value;
}
// The returned capability is bound to one run and its live opaque read grant.
// Serialized metadata alone cannot create it or bypass the caller's ACL/lease checks.
function createOptimizationBrokerExecution({ run, current, loadRun, now }) {
  let authority, prepared;
  const assert = async (submission, transaction = null, submitted = false) => {
    validateSubmission(run, submission);
    const runtime = await current(transaction);
    if (typeof runtime.broker.optimizationAuthority !== 'function') fail('workspace_optimization_service_pending');
    const freshAuthority = await runtime.broker.optimizationAuthority(runtime.account, runtime.brokerContext, { transaction });
    if (freshAuthority !== submission.authority || authority && authority !== freshAuthority) fail('workspace_optimization_connection_changed');
    if (submitted) {
      const row = await loadRun(transaction); validateSubmission(row, row?.outcome?.broker_submission);
      if (!row.submitted_at || C.hash(row.outcome.broker_submission) !== C.hash(submission)) fail('workspace_optimization_plan_changed');
    }
    return runtime;
  };
  const execute = async (family, submission, submitted) => {
    let guardError;
    const check = async () => {
      try { return await assert(submission, null, submitted); }
      catch (error) { guardError = error; throw error; }
    };
    try {
      const runtime = await check();
      const result = await runtime.broker.optimization(runtime.account, runtime.brokerContext, family,
        family === 'apply' ? submission.payload : { executionId: run.id }, {
          requestId: family === 'apply' ? run.id : randomUUID(), authority: submission.authority,
          beforeExecute: async () => { await check(); return true; }, timeoutMs: 30000,
        });
      await check();
      if (result.state === 'applied' && result.result.resourceName !== run.change.target.resource) fail('workspace_optimization_response_unconfirmed');
      return result;
    } catch (error) { throw guardError || error; }
  };
  return {
    async ready() {
      const runtime = await current();
      if (typeof runtime.broker.optimizationAuthority !== 'function') fail('workspace_optimization_service_pending');
      authority = await runtime.broker.optimizationAuthority(runtime.account, runtime.brokerContext);
      const probe = { schema_version: 1, authority, payload: payloadFor(run, +now() + C.TTL_MS) };
      const receipt = await execute('status', probe, false);
      if (receipt.state !== 'not_found') fail('workspace_optimization_manual_review_required');
    },
    async prepare() {
      if (!authority) fail('workspace_optimization_service_pending');
      const submission = { schema_version: 1, authority, payload: payloadFor(run, +now() + C.TTL_MS) };
      await assert(submission); prepared = structuredClone(submission); return submission;
    },
    assert,
    async apply(change) {
      if (C.hash(verifyChange(change)) !== C.hash(verifyChange(run.change))) fail('workspace_optimization_plan_changed');
      const row = await loadRun(); const submission = validateSubmission(row, row?.outcome?.broker_submission);
      if (!prepared || C.hash(submission) !== C.hash(prepared)) fail('workspace_optimization_plan_changed');
      const result = await execute('apply', submission, true);
      return { acknowledged: true, resource_name: result.result.resourceName };
    },
    async status() {
      const row = await loadRun(); return execute('status', validateSubmission(row, row?.outcome?.broker_submission), true);
    },
  };
}
module.exports = { createOptimizationBrokerExecution, payloadFor, validateSubmission };
