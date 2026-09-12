'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { evidenceSnapshot, enqueueOptimizationAdjustment, recoverOptimizationRuns, CHECK_JOB_TYPE } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const { publicRun } = require('../../services/campaignWorkspaceOptimizationHistory.service');

const legacy = (f, rule) => ({ schema_version: 1, rule, observed_at: f.state.now.toISOString(),
  window_start: '2026-09-01', window_end: '2026-09-10',
  metrics: { clicks: 120, leads: 2, cost_cents: 10000, baseline_clicks: 120, baseline_leads: 10, baseline_cost_cents: 10000 } });

for (const provider of ['google_ads', 'meta_ads']) {
  for (const [action, rule] of [['adjust_bids', 'bid_efficiency'], ['adjust_budget', 'budget_efficiency']]) {
    async function persisted(submitted = false) {
      const f = fixture(provider, action); await f.enqueue(); const row = f.row();
      row.evidence = legacy(f, rule); row.plan_key = digest([row.mandate_id, row.change.fingerprint, row.evidence]);
      row.status = submitted ? 'uncertain' : 'queued'; row.submitted_at = submitted ? new Date(f.state.now) : null;
      f.state.credentials = 0; f.deps.ensureToken = async () => { f.state.credentials++; return { accessToken: 'fixture-only' }; };
      f.deps.mutate = async () => assert.fail('legacy proposals cannot write');
      return f;
    }

    test(`${provider} ${action}: legacy metrics cannot create a new job even with rollout enabled`, async () => {
      const f = fixture(provider, action); const evidence = legacy(f, rule);
      const deps = { ...f.deps, get models() { assert.fail('reject before opening storage'); } };
      await assert.rejects(enqueueOptimizationAdjustment({ settingId: f.setting.id, mandateId: f.setting.activation.optimization.id,
        change: f.change, evidence }, deps), /workspace_optimization_current_policy_required/);
      assert.throws(() => evidenceSnapshot(evidence, f.state.now, action, f.change), /current_policy_required/);
      assert.equal(f.state.jobs.size, 0); assert.equal(f.state.calls.read, 0);
    });

    test(`${provider} ${action}: a queued historical job is skipped before credential or provider access`, async () => {
      const f = await persisted(); const identity = digest([f.row().change, f.row().evidence, f.row().plan_key]);
      const result = await f.run(); assert.equal(result.error_message, 'workspace_optimization_current_policy_required');
      assert.equal(result.retryable, false); assert.equal(f.row().status, 'skipped'); assert.equal(f.row().submitted_at, null);
      assert.equal(f.state.credentials, 0); assert.equal(f.state.calls.read, 0); assert.equal(f.state.calls.inspect, 0);
      assert.equal(digest([f.row().change, f.row().evidence, f.row().plan_key]), identity);
      const visible = publicRun(f.row(), { ...f.source.context.campaign, name: 'Campana de prueba', currency: 'EUR' });
      assert.match(visible.detail, /propuesta antigua necesita una nueva evaluación/);
      assert.equal(visible.canResolve, false); assert.doesNotMatch(JSON.stringify(visible), /fixture-only|metrics|source_fingerprint/);
    });

    test(`${provider} ${action}: recovery never upgrades or renews old unsubmitted evidence`, async () => {
      const f = await persisted(); const before = structuredClone(f.row().evidence);
      f.state.jobs.get(1).status = 'failed'; f.state.now = new Date(+f.row().next_check_at + 1);
      assert.equal((await recoverOptimizationRuns(f.deps)).report.skipped, 1);
      assert.equal(f.state.jobs.size, 1); assert.equal(f.row().next_check_at, null);
      assert.deepEqual(f.row().evidence, before); assert.equal(f.state.credentials, 0); assert.equal(f.state.calls.read, 0);
    });

    test(`${provider} ${action}: submitted legacy evidence remains read-only, including after pausing`, async () => {
      for (const applied of [false, true]) {
        const f = await persisted(true); const key = f.row().plan_key;
        f.setting.activation.optimization.status = 'paused'; f.state.jobs.get(1).status = 'failed';
        f.state.now = new Date(+f.row().next_check_at + 1);
        assert.equal((await recoverOptimizationRuns(f.deps)).report.check_queued, 1);
        assert.equal(f.state.jobs.get(2).type, CHECK_JOB_TYPE); f.state.remote = applied ? f.change.after : f.change.before;
        const result = await f.run(2); assert.equal(result.result.state, applied ? 'observed' : 'uncertain');
        assert.equal(result.result.provider_mutation, false); assert.equal(f.state.calls.read, 1);
        assert.equal(f.row(2).plan_key, key); assert.equal(f.row(2).evidence.schema_version, 1);
      }
    });
  }
}
