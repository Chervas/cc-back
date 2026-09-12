'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bidFixture } = require('./fixtures/campaign_workspace_bid.fixture');
const { budgetPolicyFixture } = require('./fixtures/campaign_workspace_budget_policy.fixture');
const { recoverOptimizationRuns, JOB_TYPE } = require('../../services/campaignWorkspaceOptimizationExecution.service');

for (const [name, factory, schema] of [['bid', bidFixture, 3], ['budget', budgetPolicyFixture, 4]]) {
  for (const provider of ['google_ads', 'meta_ads']) {
    test(`${provider} ${name}: a fresh unsubmitted proposal recovers with its exact reviewed command`, async () => {
      const f = factory(provider); assert.equal((await f.evaluate()).result.queued, 1);
      const proof = structuredClone(f.execution.row().evidence); const change = structuredClone(f.execution.row().change);
      assert.equal(proof.schema_version, schema);
      f.execution.state.jobs.get(1).status = 'failed';
      f.state.now = new Date(+f.state.now + 60000); f.execution.row().next_check_at = new Date(+f.state.now - 1);
      const result = await recoverOptimizationRuns(f.execution.deps);
      assert.equal(result.report.apply_queued, 1, JSON.stringify(result)); assert.equal(result.report.skipped, 0);
      assert.equal(f.execution.state.jobs.get(2).type, JOB_TYPE); assert.equal(f.execution.state.calls.mutate, 0);
      assert.equal((await recoverOptimizationRuns(f.execution.deps)).report.apply_queued, 0);
      assert.deepEqual(f.execution.row(2).evidence, proof); assert.deepEqual(f.execution.row(2).change, change);
      const applied = await f.execution.run(2); assert.equal(applied.result?.state, 'verified', JSON.stringify(applied));
      assert.equal(f.execution.state.calls.mutate, 1);
    });

    test(`${provider} ${name}: expired or superseded proposals are still discarded during recovery`, async () => {
      for (const expired of [false, true]) {
        const f = factory(provider); assert.equal((await f.evaluate()).result.queued, 1);
        f.execution.state.jobs.get(1).status = 'failed';
        f.state.now = new Date(+f.state.now + (expired ? 15 * 60000 : 60000));
        f.execution.row().next_check_at = new Date(+f.state.now - 1);
        if (!expired) f.state.setting.version++;
        const result = await recoverOptimizationRuns(f.execution.deps);
        assert.equal(result.report.skipped, 1); assert.equal(result.report.apply_queued, 0);
        assert.equal(f.execution.row().submitted_at, null); assert.equal(f.execution.state.calls.mutate, 0);
      }
    });
  }
}
