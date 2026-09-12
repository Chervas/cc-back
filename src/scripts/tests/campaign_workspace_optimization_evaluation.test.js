'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { qualifiedFixture } = require('./fixtures/campaign_workspace_optimization_evidence.fixture');
const { fixture: executionFixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { DISPATCH_TYPE, JOB_TYPE, ORIGIN, PAGE_SIZE, enqueueOptimizationEvaluations, runOptimizationEvaluation } = require('../../services/campaignWorkspaceOptimizationEvaluation.service');
const { POLICY } = require('../../services/campaignWorkspaceAdPausePolicy.service');
const { recoverOptimizationRuns } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const { digest, inspectGoogleOptimization } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const NOW = new Date('2026-09-11T12:00:00Z');
const uuid = index => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;

function pipeline(provider = 'google_ads') {
  const f = qualifiedFixture(provider); const execution = executionFixture(provider);
  const models = { ...execution.deps.models, ...f.deps.models, JobRequest: { ...execution.deps.models.JobRequest,
    findOne: async query => { f.state.failureQuery = query; return f.state.failedJob || null; } },
  CampaignWorkspaceEvent: { findOne: async () => f.state.repairEvent || null } };
  const before = provider === 'google_ads' ? 'ENABLED' : 'ACTIVE'; execution.state.remote = before;
  f.state.inspection = { reference: f.input.reference, currency: 'EUR', targets: ['60', '61'].map(id => ({
    action: 'pause_underperforming_ads', entity: 'ad', id, group_id: '50', field: 'status', value: before,
    resource: provider === 'google_ads' ? `customers/20/adGroupAds/50~${id}` : id,
  })) };
  Object.assign(execution.deps, { models, now: f.deps.now, authorize: f.deps.resolveAuthorization, hasAccess: f.deps.hasAccess,
    ensureToken: f.deps.ensureToken, inspect: undefined,
    providerDependencies: { inspectGoogle: async () => f.state.inspection, inspectMeta: async () => f.state.inspection },
    receptionDependencies: { loadInventory: f.deps.loadInventory, loadReception: f.deps.loadReception },
    mutate: async () => { execution.state.calls.mutate++; execution.state.remote = 'PAUSED'; return { acknowledged: true }; },
  });
  const deps = { models, env: f.deps.env, now: f.deps.now, namespace: execution.deps.namespace,
    collectionDependencies: f.deps, executionDependencies: execution.deps };
  const payload = { schema_version: 1, setting_id: f.input.settingId, mandate_id: f.input.mandateId, reference: f.input.reference,
    cycle_at: f.state.now.toISOString(), __runtime_namespace: deps.namespace };
  const job = { id: 900, type: JOB_TYPE, origin: ORIGIN, requested_by: null, payload };
  return { ...f, execution, deps, payload, job, evaluate: () => runOptimizationEvaluation(payload, job, deps) };
}

function useGooglePreflight(f) {
  f.execution.deps.providerDependencies.inspectGoogle = options => inspectGoogleOptimization({ ...options,
    read: async ({ query }) => {
      if (query.includes('FROM ad_group_ad')) return structuredClone(f.state.inventory);
      if (/FROM ad_group\b/.test(query)) return [{ customer: { id: '20' }, campaign: { id: '30' },
        adGroup: { id: '50', status: 'ENABLED' } }];
      return structuredClone(f.state.googleMeta);
    } });
}

test('Google collector and executor never leave a rejected or unverified ad as the pause alternative', async () => {
  for (const patch of [{ primaryStatus: 'NOT_ELIGIBLE' }, { primaryStatus: 'PENDING' }, { primaryStatus: 'LIMITED' },
    { primaryStatus: undefined }, { policySummary: { approvalStatus: 'DISAPPROVED' } },
    { policySummary: { approvalStatus: 'APPROVED_LIMITED' } }, { policySummary: {} }]) {
    const before = pipeline(); Object.assign(before.state.inventory[1].adGroupAd, patch);
    const evaluation = await before.evaluate(); assert.equal(evaluation.result.queued, 0, JSON.stringify(patch));
    assert.equal(before.execution.state.runs.size, 0); assert.equal(before.execution.state.calls.mutate, 0);
    for (const index of [0, 1]) {
      const after = pipeline(); assert.equal((await after.evaluate()).result.queued, 1);
      Object.assign(after.state.inventory[index].adGroupAd, patch); useGooglePreflight(after);
      const result = await after.execution.run();
      assert.equal(result.result.state, 'skipped', JSON.stringify(result));
      assert.equal(result.result.reason, 'workspace_optimization_resource_changed');
      assert.equal(after.execution.row().submitted_at, null); assert.equal(after.execution.state.calls.mutate, 0);
    }
  }
});

test('Google current unrestricted approval allows the complete pause pipeline with real preflight', async () => {
  const f = pipeline(); useGooglePreflight(f); assert.equal((await f.evaluate()).result.queued, 1);
  const result = await f.execution.run(); assert.equal(result.result.state, 'verified', JSON.stringify(result));
  assert.equal(f.execution.state.calls.mutate, 1);
});

test('Google cannot substitute a different approved ad for the rejected baseline in a queued pause', async () => {
  const f = pipeline(); assert.equal((await f.evaluate()).result.queued, 1);
  const third = structuredClone(f.state.inventory[1]); third.adGroupAd.ad.id = '62';
  f.state.inventory.push(third); f.state.inventory[1].adGroupAd.policySummary.approvalStatus = 'DISAPPROVED';
  useGooglePreflight(f); const result = await f.execution.run();
  assert.equal(result.result.state, 'skipped'); assert.equal(result.result.reason, 'workspace_optimization_baseline_changed');
  assert.equal(f.execution.row().submitted_at, null); assert.equal(f.execution.state.calls.mutate, 0);
});

test('disabled evaluation and dispatcher do not access storage or providers', async () => {
  const unreachable = new Proxy({}, { get() { assert.fail('disabled evaluation used dependency'); } });
  assert.equal((await enqueueOptimizationEvaluations({}, { env: {}, models: unreachable })).disabled, true);
  assert.equal((await runOptimizationEvaluation(null, null, { env: {}, models: unreachable })).disabled, true);
});

test('nightly dispatcher pages all active mandates, preserving the root cycle and ID-only work', async () => {
  const template = pipeline().state.setting;
  const settings = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => ({ ...structuredClone(template), id: uuid(i + 1) }));
  const pending = [{}]; const requests = []; const queries = [];
  const deps = { env: pipeline().deps.env, namespace: 'isolated-test', now: () => NOW,
    models: { CampaignWorkspaceSetting: { findAll: async query => { queries.push(query);
      return settings.filter(row => !query.where.id || row.id > query.where.id[Op.gt]).slice(0, query.limit);
    } } }, enqueue: async request => { requests.push(request); if (request.type === DISPATCH_TYPE) pending.push(request.payload); return { created: true }; } };
  while (pending.length) assert.equal((await enqueueOptimizationEvaluations(pending.shift(), deps)).status, 'completed');
  const children = requests.filter(request => request.type === JOB_TYPE);
  assert.equal(children.length, settings.length); assert.equal(queries.length, 3);
  assert.ok(queries.every(query => query.where['activation.optimization.status'] === 'active'));
  assert.ok(children.every(child => child.payload.cycle_at === NOW.toISOString() && child.origin === ORIGIN && child.maxAttempts === 3));
  assert.doesNotMatch(JSON.stringify(children), /accessToken|metrics|before|after|patient/);
  assert.deepEqual(Object.keys(children[0].payload).sort(), ['__runtime_namespace', 'action', 'cycle_at', 'mandate_id', 'reference', 'schema_version', 'setting_id']);
  assert.equal(children[0].payload.schema_version, 2); assert.equal(children[0].payload.action, 'pause_underperforming_ads');
});

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: an unsubmitted schema-2 pause recovers once while its evidence is still fresh`, async () => {
    const f = pipeline(provider); assert.equal((await f.evaluate()).result.queued, 1);
    const original = structuredClone(f.execution.row().evidence);
    f.execution.state.jobs.get(1).status = 'failed';
    f.state.now = new Date(+f.state.now + 60000); f.execution.row().next_check_at = new Date(+f.state.now - 1);
    assert.equal((await recoverOptimizationRuns(f.execution.deps)).report.apply_queued, 1);
    assert.equal((await recoverOptimizationRuns(f.execution.deps)).report.apply_queued, 0);
    assert.deepEqual(f.execution.row(2).evidence, original); assert.equal(f.execution.state.calls.mutate, 0);
    assert.equal((await f.execution.run(2)).result.state, 'verified'); assert.equal(f.execution.state.calls.mutate, 1);
  });

  test(`${provider}: real collector, rule, durable producer and executor complete one authorized simulated pause`, async () => {
    const f = pipeline(provider); const result = await f.evaluate();
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.result.queued, 1);
    assert.equal(f.execution.state.runs.size, 1); assert.equal(f.execution.state.jobs.size, 1);
    assert.equal(f.execution.row().evidence.schema_version, 2);
    assert.equal(f.execution.row().evidence.baseline_ad_id, '61'); assert.equal(f.execution.row().status, 'queued');
    assert.doesNotMatch(JSON.stringify(f.execution.state.jobs.get(1).payload), /metrics|before|after|accessToken/);
    assert.equal(f.execution.state.calls.mutate, 0);
    const applied = await f.execution.run(); assert.equal(applied.result?.state, 'verified', JSON.stringify(applied));
    assert.equal(f.execution.state.calls.mutate, 1); assert.ok(f.execution.row().submitted_at);
    assert.equal((await f.execution.run()).result.idempotent, true); assert.equal(f.execution.state.calls.mutate, 1);
  });

  test(`${provider}: repeated evaluation recollects but cannot enqueue a second group change in the same cycle`, async () => {
    const f = pipeline(provider); assert.equal((await f.evaluate()).result.queued, 1);
    f.state.now = new Date(+f.state.now + 1000);
    const result = await f.evaluate(); assert.equal(result.result.queued, 0); assert.equal(result.result.duplicates, 1);
    assert.equal(f.execution.state.runs.size, 1); assert.equal(f.execution.state.jobs.size, 1);
    await f.execution.run(); f.state.now = new Date(+f.state.now + 1000);
    assert.equal((await f.evaluate()).result.duplicates, 1); assert.equal(f.execution.state.calls.mutate, 1);
  });

  test(`${provider}: stale evidence, changed source and missing baseline stop before any provider mutation`, async () => {
    for (const mutate of [f => { f.state.now = new Date(+f.state.now + POLICY.evidence_ttl_ms); },
      f => { f.state.setting.version++; }, f => { f.state.inspection.targets = f.state.inspection.targets.filter(row => row.id !== '61'); },
      f => { f.state.reception = false; }]) {
      const f = pipeline(provider); await f.evaluate(); mutate(f);
      const result = await f.execution.run(); assert.equal(f.execution.row().status, 'skipped', JSON.stringify(result));
      assert.equal(f.execution.row().submitted_at, null); assert.equal(f.execution.state.calls.mutate, 0);
    }
  });

  test(`${provider}: a prior pause in the same group blocks a different ad, not just the same resource`, async () => {
    const f = pipeline(provider); await f.evaluate();
    const previous = structuredClone(f.execution.row()); previous.id = uuid(98); previous.status = 'verified';
    previous.resource_key = digest('a-different-ad-resource'); previous.submitted_at = new Date(+f.state.now - 3600000);
    previous.change.target.id = '59'; previous.change.target.group_id = '50'; f.execution.state.runs.set(previous.id, previous);
    const result = await f.execution.run(); assert.equal(result.error_message, 'workspace_optimization_cooldown');
    assert.equal(f.execution.state.calls.mutate, 0);
  });
}

test('permission failure is terminal and later cycles stop before credentials until an explicit successful check', async () => {
  const f = pipeline('meta_ads');
  f.state.beforeRead = () => { throw { response: { status: 401, data: { error: { code: 190 } } } }; };
  assert.deepEqual(await f.evaluate(), { status: 'failed', retryable: false, error_message: 'workspace_optimization_permissions_required' });
  assert.equal(f.state.calls.length, 1); f.state.beforeRead = null;
  f.state.failedJob = { updated_at: f.state.now.toISOString() }; f.state.calls = [];
  const skipped = await f.evaluate(); assert.equal(skipped.result.reason, 'workspace_optimization_connection_review_required');
  assert.equal(f.state.calls.length, 0);
  f.state.now = new Date(+f.state.now + 1000);
  f.state.repairEvent = { changes: { schema_version: 1, status: 'checked', error: null, checked_at: f.state.now.toISOString(),
    expires_at: new Date(+f.state.now + 86400000).toISOString() } };
  assert.equal((await f.evaluate()).result.queued, 1);
});

test('invalid job identity, namespace, caller and payload cannot trigger collection', async () => {
  for (const mutate of [f => { f.job.origin = 'user'; }, f => { f.job.requested_by = 7; }, f => { f.job.id = null; },
    f => { f.payload.__runtime_namespace = 'another-runtime'; }, f => { f.payload.cycle_at = '2026-09-09T00:00:00.000Z'; },
    f => { f.payload.reference.campaign_id = 'invalid'; }, f => { f.payload.raw_token = 'untrusted'; }]) {
    const f = pipeline(); mutate(f); const result = await f.evaluate();
    assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.equal(f.state.calls.length, 0);
  }
});

test('dispatcher retries use the original durable root timestamp, never a new cycle', async () => {
  const f = pipeline(); const requests = []; const created = new Date(+NOW - 3600000);
  f.deps.models.JobRequest.findByPk = async id => { assert.equal(id, 900); return { created_at: created }; };
  f.deps.models.CampaignWorkspaceSetting.findAll = async () => [f.state.setting];
  const deps = { ...f.deps, jobRequestId: 900, enqueue: async request => { requests.push(request); return { created: requests.length === 1 }; } };
  assert.equal((await enqueueOptimizationEvaluations({}, deps)).queued, 1);
  f.state.now = new Date(+f.state.now + 1000);
  assert.equal((await enqueueOptimizationEvaluations({}, deps)).duplicates, 1);
  assert.equal(requests[0].dedupeScope, requests[1].dedupeScope); assert.equal(requests[0].payload.cycle_at, created.toISOString());
});

test('closing the gate after collection or inside enqueue does not report a successful proposal', async () => {
  for (const insideEnqueue of [false, true]) {
    const f = pipeline();
    if (insideEnqueue) f.deps.enqueueAdjustment = async (...args) => {
      f.deps.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'false';
      return require('../../services/campaignWorkspaceOptimizationExecution.service').enqueueOptimizationAdjustment(...args);
    };
    else f.deps.collect = async (...args) => {
      const result = await require('../../services/campaignWorkspaceOptimizationEvidence.service').collectOptimizationEvidence(...args);
      f.deps.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'false'; return result;
    };
    const result = await f.evaluate();
    assert.equal(result.disabled, true); assert.equal(result.result.queued, 0);
    assert.equal(f.execution.state.runs.size, 0); assert.equal(f.execution.state.calls.mutate, 0);
  }
});

test('evidence expiring during inspection or reception checks cannot be submitted', async () => {
  for (const step of ['inspect', 'reception']) {
    const f = pipeline(); await f.evaluate();
    if (step === 'inspect') f.execution.deps.providerDependencies.inspectGoogle = async () => {
      f.state.now = new Date(+f.state.now + POLICY.evidence_ttl_ms); return f.state.inspection;
    };
    else f.execution.deps.receptionDependencies.loadReception = async (...args) => {
      f.state.now = new Date(+f.state.now + POLICY.evidence_ttl_ms); return f.deps.collectionDependencies.loadReception(...args);
    };
    await f.execution.run();
    assert.equal(f.execution.row().status, 'skipped'); assert.equal(f.execution.row().submitted_at, null);
    assert.equal(f.execution.state.calls.mutate, 0);
  }
});

test('legacy pause evidence cannot start a new write, but a submitted receipt remains recoverable without replay', async () => {
  for (const submitted of [false, true]) {
    const f = pipeline(); await f.evaluate(); const row = f.execution.row();
    // Synthetic historical receipt: no persisted customer record is rewritten or re-signed.
    row.evidence = { schema_version: 1, rule: 'ad_underperformance', observed_at: f.state.now.toISOString(),
      window_start: row.evidence.window_start, window_end: row.evidence.window_end, metrics: row.evidence.metrics };
    row.plan_key = digest([row.mandate_id, row.change.fingerprint, row.evidence]);
    if (submitted) {
      row.submitted_at = f.state.now; row.status = 'uncertain'; f.execution.state.remote = 'PAUSED';
      f.execution.state.jobs.get(1).type = 'campaign_workspace_optimization_check';
    }
    const result = await f.execution.run();
    assert.equal(f.execution.row().status, submitted ? 'observed' : 'skipped', JSON.stringify(result));
    assert.equal(f.execution.state.calls.mutate, 0);
    assert.equal(f.execution.state.calls.read, submitted ? 1 : 0);
  }
});
