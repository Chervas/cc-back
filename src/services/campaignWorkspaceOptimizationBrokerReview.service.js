'use strict';
const { randomUUID } = require('node:crypto');
const C = require('../../services/integrations-broker/src/google-optimization-write-contract');
const { validateSubmission } = require('./campaignWorkspaceOptimizationBrokerExecution.service');
const { readOptimizationValue } = require('./campaignWorkspaceOptimizationCommand.service');
const { receptionAccount, receivingClinic } = require('./googleLeadReception.service');
const { assertGoogleAdsGrantTransport } = require('./googleAdsGrantTransport.service');
const { googleDestinationAccessError } = require('./campaignWorkspaceGoogleDestination.service');
const fail = (code, status = 409) => { throw Object.assign(Error(code), { code, status }); };

// The human confirmation closes uncertainty, not advertising state. Never call
// apply here, and never carry a provider token or a network call inside a SQL lock.
async function reviewBrokerOptimization({ models, scope, actorId, now, revalidate,
  account = receptionAccount, clinic = receivingClinic, runtimeFor = assertGoogleAdsGrantTransport }) {
  let grant, fingerprint, snapshot, submission, run;
  const started = +now(), deadline = started + 30000;
  if (!Number.isFinite(started) || !Number.isFinite(deadline)) fail('workspace_optimization_timeout');
  const time = () => { const at = +now(); if (!Number.isFinite(at) || at < started || at >= deadline) fail('workspace_optimization_timeout'); return at; };
  const current = async transaction => {
    const check = async transaction => {
      time(); const context = await revalidate(transaction);
      if (context.alreadyResolved) fail('workspace_optimization_review_changed');
      const row = context.run; const saved = validateSubmission(row, row.outcome?.broker_submission);
      const identity = C.hash([row.id, row.setting_id, row.mandate_id, row.change, row.evidence, saved,
        context.setting.version, context.campaign.clinicId]);
      if (snapshot && snapshot !== identity) fail('workspace_optimization_review_changed');
      const resolved = await account({ models, settingId: row.setting_id, accountId: row.account_id, now: now(), transaction,
        requireBroker: true, expectedBrokerGrant: grant });
      if (!resolved.brokerGrant || fingerprint && resolved.fingerprint !== fingerprint) fail('workspace_optimization_connection_changed');
      const recipient = await clinic({ models, context: resolved, identity: row.change.reference, transaction });
      if (Number(recipient.id_clinica) !== row.clinic_id || !scope.clinicIds.includes(row.clinic_id)) fail('workspace_optimization_scope_changed');
      const runtime = await runtimeFor(resolved.brokerGrant, { clinicId: row.clinic_id, transaction });
      if (runtime.customerId !== row.account_id
        || await runtime.broker.optimizationAuthority(runtime.account, runtime.brokerContext, { transaction }) !== saved.authority) fail('workspace_optimization_connection_changed');
      if (!await context.permitted()) fail('marketing_scope_forbidden', 403);
      time();
      grant ||= resolved.brokerGrant; fingerprint ||= resolved.fingerprint; snapshot ||= identity;
      submission ||= structuredClone(saved); run ||= { id: row.id, change: structuredClone(row.change) };
      return runtime;
    };
    return transaction ? check(transaction) : models.sequelize.transaction(check);
  };
  let guardError;
  const guard = async () => { try { await current(); return true; } catch (error) { guardError = error; throw error; } };
  const execute = async (family, input) => {
    const runtime = await current();
    const result = await runtime.broker.optimization(runtime.account, runtime.brokerContext, family, input,
      { requestId: randomUUID(), authority: submission.authority, beforeExecute: guard, timeoutMs: Math.max(1, deadline - time()) });
    await current(); return result;
  };
  try {
    await current();
    if (time() < submission.payload.expiresAt + C.REVIEW_DELAY_MS) fail('workspace_optimization_review_pending');
    let receipt = await execute('status', { executionId: run.id });
    if (receipt.state !== 'reviewed') {
      const value = await readOptimizationValue(run.change, { deliveryMode: 'broker', readSection: async (section, timeoutMs) => {
        const runtime = await current();
        const rows = await runtime.broker.read(runtime.account, runtime.brokerContext, 'optimization',
          { campaignId: run.change.reference.campaign_id, section }, { timeoutMs: Math.min(timeoutMs, deadline - time()), beforeExecute: guard });
        await current(); return rows;
      } });
      receipt = await execute('review', { submission: submission.payload, actorId, confirmed: true, observedAt: time(), value });
    }
    if (receipt.state !== 'reviewed' || receipt.executionId !== run.id || receipt.result.resourceName !== run.change.target.resource) fail('workspace_optimization_response_unconfirmed');
    await current();
    return { receipt, assertCurrent: current };
  } catch (error) {
    if (guardError) throw guardError;
    if (error.code === 'optimization_review_pending') fail('workspace_optimization_review_pending');
    const access = googleDestinationAccessError(error);
    if (access === 'workspace_google_service_pending') fail('workspace_optimization_service_pending');
    if (access === 'workspace_google_permissions_required') fail('workspace_optimization_permissions_required', 403);
    if (['broker_timeout', 'provider_timeout'].includes(error.code)) fail('workspace_optimization_timeout');
    if (/^(workspace_|marketing_)/.test(error.code || '')) throw error;
    fail('workspace_optimization_unavailable');
  }
}
module.exports = { reviewBrokerOptimization };
