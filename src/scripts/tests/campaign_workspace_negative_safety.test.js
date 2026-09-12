'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { optimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const { evidenceSnapshot, enqueueOptimizationAdjustment, recoverOptimizationRuns, CHECK_JOB_TYPE } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const { publicRun } = require('../../services/campaignWorkspaceOptimizationHistory.service');

function legacyNegative(f) {
  return { change: optimizationChange({ reference: f.change.reference,
    target: { action: 'negative_keywords', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', field: 'keyword', match_type: 'EXACT' },
    before: false, after: 'implantes dentales' }),
  evidence: { schema_version: 1, rule: 'search_without_results', observed_at: f.state.now.toISOString(),
    window_start: '2026-09-01', window_end: '2026-09-10', metrics: { clicks: 120, cost_cents: 10000, leads: 0 } } };
}

// Represent a previously persisted command, without opening a path for the current producer to create one.
async function persistedLegacy(submitted = false) {
  const f = fixture(); await f.enqueue(); const legacy = legacyNegative(f); const row = f.row();
  Object.assign(row, legacy, { resource_key: digest([legacy.change.reference.provider, legacy.change.reference.account_id, legacy.change.target.resource]),
    plan_key: digest([row.mandate_id, legacy.change.fingerprint, legacy.evidence]),
    submitted_at: submitted ? new Date(f.state.now) : null, status: submitted ? 'uncertain' : 'queued' });
  f.state.remote = false;
  const authorize = f.deps.authorize;
  f.deps.authorize = async (...args) => { const context = await authorize(...args); context.entry.targets = [legacy.change.target]; return context; };
  f.deps.ensureToken = async () => { f.state.tokenChecks = (f.state.tokenChecks || 0) + 1; return { accessToken: 'fixture-only' }; };
  f.deps.mutate = async () => assert.fail('a legacy negative must never be sent');
  return f;
}

test('zero-result evidence cannot create exclusions, even with both feature gates open', async () => {
  const f = fixture(); const legacy = legacyNegative(f);
  const deps = { ...f.deps, get models() { assert.fail('invalid evidence must not initialise storage'); } };
  await assert.rejects(enqueueOptimizationAdjustment({ settingId: f.setting.id, mandateId: f.setting.activation.optimization.id, ...legacy }, deps), /search_relevance_required/);
  for (const action of [undefined, 'negative_keywords', 'adjust_bids']) {
    assert.throws(() => evidenceSnapshot(legacy.evidence, f.state.now, action), /search_relevance_required/);
  }
  assert.equal(f.state.jobs.size, 0); assert.equal(f.state.calls.read, 0); assert.equal(f.state.calls.mutate, 0);
});

test('a queued legacy exclusion is skipped before credentials or provider I/O and remains inspectable', async () => {
  const f = await persistedLegacy(); const original = structuredClone({ change: f.row().change, evidence: f.row().evidence, plan_key: f.row().plan_key });
  const result = await f.run();
  assert.equal(result.error_message, 'workspace_optimization_search_relevance_required'); assert.equal(result.retryable, false);
  assert.equal(f.row().status, 'skipped'); assert.equal(f.row().submitted_at, null);
  assert.equal(f.state.calls.read, 0); assert.equal(f.state.tokenChecks || 0, 0);
  assert.deepEqual({ change: f.row().change, evidence: f.row().evidence, plan_key: f.row().plan_key }, original);
  const visible = publicRun(f.row(), { ...f.row().change.reference, id: 'campaign-1', name: 'Campana de prueba', clinicId: 1, assigned: true });
  assert.match(visible.detail, /No tener conversiones no basta/); assert.equal(visible.canResolve, false);
  assert.doesNotMatch(JSON.stringify(visible), /search_without_results|metrics|fixture-only|resource_key|plan_key/);
});

test('recovery does not revive unsubmitted exclusions or alter their historical proof', async () => {
  const f = await persistedLegacy(); const proof = structuredClone(f.row().evidence); f.state.jobs.get(1).status = 'completed';
  f.state.now = new Date(+f.row().next_check_at + 1);
  assert.equal((await recoverOptimizationRuns(f.deps)).report.skipped, 1);
  assert.equal(f.state.jobs.size, 1); assert.equal(f.row().next_check_at, null); assert.deepEqual(f.row().evidence, proof);
  assert.equal(f.state.tokenChecks || 0, 0); assert.equal(f.state.calls.read, 0);
});

test('an already-submitted exclusion can only be observed, never replayed or falsely attributed', async () => {
  for (const present of [false, true]) {
    const f = await persistedLegacy(true); f.state.remote = present;
    const result = await f.run(); assert.equal(result.result.state, present ? 'observed' : 'uncertain');
    assert.equal(result.result.provider_mutation, false); assert.equal(f.state.calls.read, 1); assert.ok(f.row().submitted_at);
    assert.equal(f.state.calls.mutate, 0);
  }
});

test('submitted exclusion recovery stays read-only after pausing, and rejected permissions never try another credential', async () => {
  const f = await persistedLegacy(true); f.setting.activation.optimization.status = 'paused'; f.state.jobs.get(1).status = 'completed';
  f.state.now = new Date(+f.row().next_check_at + 1);
  assert.equal((await recoverOptimizationRuns(f.deps)).report.check_queued, 1);
  assert.equal(f.state.jobs.get(2).type, CHECK_JOB_TYPE); f.state.remote = true;
  assert.equal((await f.run(2)).result.state, 'observed'); assert.equal(f.state.calls.mutate, 0);
  const g = await persistedLegacy(true); g.state.permitted = false;
  assert.equal((await g.run()).error_message, 'workspace_optimization_permissions_required');
  assert.equal(g.state.calls.read, 0); assert.equal(g.state.tokenChecks || 0, 0); assert.equal(g.row().status, 'uncertain');
});
