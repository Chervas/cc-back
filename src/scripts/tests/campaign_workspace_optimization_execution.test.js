'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, error } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { evidenceSnapshot, enqueueOptimizationAdjustment, runOptimizationAdjustmentJob, LEASE_MS } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const { optimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { BACKGROUND_INTEGRATION_JOB_TYPES, SCHEDULED_JOB_DEFINITIONS } = require('../../config/scheduledJobCatalog');

test('optimization commands share the provider integration lane but do not create a scheduled trigger', () => {
  assert.ok(BACKGROUND_INTEGRATION_JOB_TYPES.includes('campaign_workspace_optimization_apply'));
  assert.ok(Object.values(SCHEDULED_JOB_DEFINITIONS).every(row => row.type !== 'campaign_workspace_optimization_apply'));
});

test('closed rollout gates touch neither storage nor a provider', async () => {
  const deps = { env: {}, models: new Proxy({}, { get() { throw Error('Unexpected storage'); } }) };
  assert.equal((await enqueueOptimizationAdjustment({}, deps)).queued, false);
  assert.equal((await runOptimizationAdjustmentJob({}, {}, deps)).result.skipped, true);
});
test('evidence is fresh, calendar-valid, complete and bound to the action', () => {
  const f = fixture(); assert.deepEqual(evidenceSnapshot(f.evidence, f.state.now, 'adjust_bids'), f.evidence);
  for (const patch of [{ window_start: '2026-99-99' }, { window_start: '2026-02-30' }, { window_end: '2026-09-30' },
    { observed_at: '2026-09-09' }, { metrics: { clicks: 100 } }, { rule: 'budget_efficiency' }, { patient: 'private' }]) {
    assert.throws(() => evidenceSnapshot({ ...f.evidence, ...patch }, f.state.now, 'adjust_bids'));
  }
});
test('producer atomically stores a command and ID-only job, and deduplicates beyond job completion', async () => {
  const f = fixture(); const first = await f.enqueue(); const again = await f.enqueue();
  assert.equal(first.created, true); assert.equal(again.created, false); assert.equal(first.runId, again.runId);
  assert.equal(f.state.runs.size, 1); assert.equal(f.state.jobs.size, 1);
  assert.doesNotMatch(JSON.stringify(f.state.jobs.get(1).payload), /before|after|metrics|fixture-only/);
  await f.run(); assert.equal((await f.enqueue()).queued, false);
  const g = fixture(); g.state.failEnqueue = true; await assert.rejects(g.enqueue());
  assert.equal(g.state.runs.size, 0); assert.equal(g.state.jobs.size, 0);
});
test('Google and Meta record submission before sending once and verify by fresh readback', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = fixture(provider); await f.enqueue(); const mutate = f.deps.mutate;
    f.deps.mutate = async (...args) => {
      assert.equal(f.row().status, 'submitted'); assert.ok(f.row().submitted_at); return mutate(...args);
    };
    const result = await f.run(); assert.equal(result.result.state, 'verified'); assert.equal(f.state.calls.mutate, 1);
    assert.equal(f.state.calls.read, 2); assert.equal(f.row().lease_token, null);
    assert.equal((await f.run()).result.idempotent, true); assert.equal(f.state.calls.mutate, 1);
  }
});
test('desired state already present is observed without advertising mutation', async () => {
  const f = fixture(); await f.enqueue(); f.state.remote = f.change.after;
  assert.equal((await f.run()).result.state, 'observed'); assert.equal(f.state.calls.mutate, 0); assert.equal(f.row().submitted_at, null);
});
test('timeouts and malformed acknowledgements never replay submitted writes', async () => {
  for (const applied of [true, false]) {
    const f = fixture(); await f.enqueue();
    f.deps.mutate = async () => { f.state.calls.mutate++; if (applied) f.state.remote = f.change.after; throw Error('private provider detail'); };
    const result = await f.run(); assert.equal(result.result.state, applied ? 'observed' : 'uncertain');
    assert.doesNotMatch(JSON.stringify([result, f.row()]), /private provider detail/);
    await f.run(); assert.equal(f.state.calls.mutate, 1);
    if (!applied) { f.state.remote = f.change.after; assert.equal((await f.run()).result.state, 'observed'); }
  }
});
test('lost commit acknowledgement cannot erase a submission marker or trigger another write', async () => {
  const f = fixture(); await f.enqueue(); f.state.lostCommit = true;
  const result = await f.run(); assert.equal(result.result.state, 'uncertain'); assert.ok(f.row().submitted_at);
  assert.equal(f.state.calls.mutate, 0); await f.run(); assert.equal(f.state.calls.mutate, 0);
});
test('revocation and mandate replacement cancel queued jobs without touching advertising', async () => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.setting.activation.optimization.status = 'paused'; },
    f => { f.setting.activation.optimization.id = crypto.randomUUID(); }, f => { f.state.now = new Date('2026-09-13T12:00:00Z'); }]) {
    const f = fixture(); await f.enqueue(); mutate(f); const result = await f.run();
    assert.equal(result.retryable, false); assert.equal(f.row().status, 'skipped'); assert.equal(f.state.calls.mutate, 0);
  }
});
test('permission loss after preflight or after HTTP cannot be shown as a verified change', async () => {
  for (const phase of ['inspect', 'mutate']) {
    const f = fixture(); await f.enqueue(); const original = f.deps[phase];
    f.deps[phase] = async (...args) => { const value = await original(...args); f.state.permitted = false; return value; };
    assert.equal((await f.run()).result.state, phase === 'inspect' ? 'skipped' : 'uncertain');
    assert.equal(f.state.calls.mutate, phase === 'inspect' ? 0 : 1);
  }
});
test('namespace, job ownership and command integrity are enforced before provider reads', async () => {
  for (const mutate of [f => { f.deps.namespace = 'another-runtime'; }, f => { f.state.jobs.get(1).origin = 'other'; },
    f => { f.row().change.after = '800'; }, f => { f.row().job_request_id = 999; }]) {
    const f = fixture(); await f.enqueue(); mutate(f); const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(f.state.calls.read, 0); assert.equal(f.state.calls.mutate, 0);
  }
});
test('preflight outages release the lease for a retry, unlike irreversible submissions', async () => {
  const f = fixture(); await f.enqueue(); f.deps.inspect = async () => { throw Error('private outage'); };
  const result = await f.run(); assert.equal(result.retryable, true); assert.equal(f.row().status, 'queued');
  assert.equal(f.row().lease_token, null); assert.equal(f.row().submitted_at, null); assert.equal(f.state.calls.mutate, 0);
});
test('expired leases cannot submit and stale workers cannot overwrite newer receipts', async () => {
  const f = fixture(); await f.enqueue(); f.deps.inspect = async () => { f.state.now = new Date(+f.state.now + LEASE_MS + 1); };
  assert.equal((await f.run()).result.state, 'skipped'); assert.equal(f.state.calls.mutate, 0);
  const g = fixture(); await g.enqueue();
  g.deps.inspect = async () => { g.row().lease_token = crypto.randomUUID(); g.row().status = 'leased'; };
  const result = await g.run(); assert.equal(result.retryable, true); assert.equal(g.row().status, 'leased'); assert.equal(g.state.calls.mutate, 0);
});
test('plan replacement during preflight cannot submit a different immutable command', async () => {
  const f = fixture(); await f.enqueue();
  f.deps.inspect = async () => {
    const change = optimizationChange({ ...f.change, after: '950' }); f.row().change = change;
    f.row().plan_key = digest([f.row().mandate_id, change.fingerprint, f.row().evidence]);
  };
  const result = await f.run(); assert.equal(result.result.reason, 'workspace_optimization_plan_changed'); assert.equal(f.state.calls.mutate, 0);
});
test('account serialization prevents two simultaneous jobs from preflighting the same live account', async () => {
  const f = fixture(); await f.enqueue(); await f.enqueue({ evidence: { ...f.evidence, observed_at: '2026-09-11T11:59:00Z' } });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  f.deps.inspect = async () => { entered(); await blocked; };
  const first = f.run(1); await started;
  try { const second = await f.run(2); assert.equal(second.error_message, 'workspace_optimization_account_busy'); assert.equal(second.retryable, true); }
  finally { release(); }
  assert.equal((await first).result.state, 'verified'); assert.equal(f.state.calls.mutate, 1);
  assert.equal((await f.run(2)).error_message, 'workspace_optimization_cooldown'); assert.equal(f.row(2).status, 'skipped');
});
test('unresolved submitted operations block other resources and budgets require global accounting', async () => {
  const f = fixture(); await f.enqueue(); f.row().status = 'uncertain'; f.row().submitted_at = new Date(+f.state.now - 3600000);
  const change = optimizationChange({ ...f.change, target: { ...f.change.target, id: '51', resource: 'customers/20/adGroups/51' } });
  const authorize = f.deps.authorize;
  f.deps.authorize = async (...args) => { const context = await authorize(...args); context.entry.targets.push(change.target); return context; };
  await f.enqueue({ change });
  assert.equal((await f.run(2)).error_message, 'workspace_optimization_account_busy');
  for (const provider of ['google_ads', 'meta_ads']) {
    const g = fixture(provider, 'adjust_budget'); await g.enqueue();
    assert.equal((await g.run()).result.reason, 'workspace_optimization_budget_accounting_required'); assert.equal(g.state.calls.mutate, 0);
  }
});
test('a new mandate cannot bypass the resource cooldown after a verified adjustment', async () => {
  const f = fixture(); await f.enqueue(); await f.run();
  f.setting.activation.optimization.id = crypto.randomUUID(); await f.enqueue();
  assert.equal((await f.run(2)).error_message, 'workspace_optimization_cooldown'); assert.equal(f.state.calls.mutate, 1);
});
test('losing a receipt write after HTTP cannot turn a submitted operation into a fresh command', async () => {
  const f = fixture(); await f.enqueue(); let failed = false;
  const transaction = f.deps.models.sequelize.transaction;
  f.deps.models.sequelize.transaction = async fn => transaction(async tx => {
    const result = await fn(tx);
    if (!failed && result?.result?.state === 'verified') { failed = true; throw Error('receipt write failed'); }
    return result;
  });
  const result = await f.run(); assert.equal(result.result.state, 'uncertain'); assert.equal(f.state.calls.mutate, 1);
  assert.equal((await f.run()).result.state, 'observed'); assert.equal(f.state.calls.mutate, 1);
});
test('a changed journal command cannot be declared verified after provider I/O', async () => {
  const f = fixture(); await f.enqueue(); const mutate = f.deps.mutate;
  f.deps.mutate = async (...args) => {
    const result = await mutate(...args);
    const change = optimizationChange({ ...f.change, after: '950' }); f.row().change = change;
    f.row().plan_key = digest([f.row().mandate_id, change.fingerprint, f.row().evidence]); return result;
  };
  const result = await f.run(); assert.equal(result.result.state, 'uncertain');
  assert.equal(result.result.reason, 'workspace_optimization_plan_changed'); assert.equal(f.state.calls.mutate, 1);
});
