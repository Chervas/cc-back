'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { recoverOptimizationRuns, CHECK_JOB_TYPE, JOB_TYPE } = require('../../services/campaignWorkspaceOptimizationExecution.service');

const due = f => { f.state.now = new Date(+f.row().next_check_at + 1); };
test('recovery is disabled without either gate and never reads a provider from the sweep', async () => {
  const f = fixture(); f.deps.env = {}; assert.equal((await recoverOptimizationRuns(f.deps)).report.disabled, true);
  assert.deepEqual(f.state.calls, { read: 0, mutate: 0, inspect: 0, authorize: 0 });
});
test('an unsubmitted job consumed with a closed gate is recovered only with fresh authorization and evidence', async () => {
  const f = fixture(); await f.enqueue(); f.state.jobs.get(1).status = 'completed';
  f.state.now = new Date(+f.state.now + 60000); f.row().next_check_at = new Date(+f.state.now - 1);
  const result = await recoverOptimizationRuns(f.deps); assert.equal(result.report.apply_queued, 1);
  assert.equal(f.state.jobs.get(2).type, JOB_TYPE); assert.equal(f.state.calls.mutate, 0);
  assert.equal((await f.run(2)).result.state, 'verified'); assert.equal(f.state.calls.mutate, 1);
  assert.equal((await f.run(1)).error_message, 'workspace_optimization_job_mismatch');
});
test('uncertain submitted commands use a distinct read-only job, including after pausing Optimiza', async () => {
  const f = fixture(); await f.enqueue(); f.deps.mutate = async () => { f.state.calls.mutate++; throw Error('timeout'); };
  await f.run(); f.setting.activation.optimization.status = 'paused'; due(f);
  const result = await recoverOptimizationRuns(f.deps); assert.equal(result.report.check_queued, 1);
  assert.equal(f.state.jobs.get(2).type, CHECK_JOB_TYPE);
  f.state.remote = f.change.after; assert.equal((await f.run(2)).result.state, 'observed'); assert.equal(f.state.calls.mutate, 1);
});
test('a read-only job never submits even if its durable submission marker disappears', async () => {
  const f = fixture(); await f.enqueue(); f.state.jobs.get(1).type = CHECK_JOB_TYPE;
  assert.equal((await f.run()).error_message, 'workspace_optimization_job_mismatch'); assert.equal(f.state.calls.mutate, 0);
});
test('live job states and leases are respected instead of guessing a worker has stopped', async () => {
  for (const status of ['pending', 'queued', 'running', 'waiting']) {
    const f = fixture(); await f.enqueue(); due(f); f.state.jobs.get(1).status = status;
    assert.equal((await recoverOptimizationRuns(f.deps)).report.waiting, 1); assert.equal(f.state.jobs.size, 1);
  }
  const f = fixture(); await f.enqueue(); due(f); f.row().lease_token = 'live'; f.row().lease_until = new Date(+f.state.now + 60000);
  f.state.jobs.get(1).status = 'failed'; assert.equal((await recoverOptimizationRuns(f.deps)).report.waiting, 1);
  assert.equal(f.state.jobs.size, 1);
});
test('cancelled, revoked or stale unsubmitted plans are skipped; submitted records remain visible for review', async () => {
  for (const submitted of [false, true]) {
    const f = fixture(); await f.enqueue(); f.row().submitted_at = submitted ? new Date(f.state.now) : null;
    f.state.jobs.get(1).status = 'failed'; f.state.permitted = false; due(f);
    const result = await recoverOptimizationRuns(f.deps);
    assert.equal(result.report[submitted ? 'review_required' : 'skipped'], 1);
    assert.equal(f.row().status, submitted ? 'uncertain' : 'skipped'); assert.equal(f.row().next_check_at, null);
  }
  for (const mutate of [f => { f.state.jobs.get(1).status = 'cancelled'; }, f => { f.state.now = new Date(+f.state.now + 2 * 86400000); }]) {
    const f = fixture(); await f.enqueue(); f.state.jobs.get(1).status = 'failed'; due(f); mutate(f);
    assert.equal((await recoverOptimizationRuns(f.deps)).report.skipped, 1); assert.equal(f.state.calls.mutate, 0);
  }
});
test('recovery attempts are bounded, preserve uncertainty and never repeat the command', async () => {
  const f = fixture(); await f.enqueue(); f.deps.mutate = async () => { f.state.calls.mutate++; throw Error('timeout'); }; await f.run();
  for (let attempt = 1; attempt <= 6; attempt++) {
    due(f); assert.equal((await recoverOptimizationRuns(f.deps)).report.check_queued, 1);
    assert.equal((await f.run(attempt + 1)).result.state, 'uncertain');
  }
  assert.equal(f.row().next_check_at, null); assert.equal(f.row().recovery_attempts, 6);
  assert.equal((await recoverOptimizationRuns(f.deps)).report.scanned, 0); assert.equal(f.state.calls.mutate, 1);
});
test('a missing terminal job can be recovered but an enqueue failure rolls back the binding and attempt counter', async () => {
  const f = fixture(); await f.enqueue(); f.row().job_request_id = null; f.state.jobs.get(1).status = 'completed';
  f.state.now = new Date(+f.state.now + 60000); f.row().next_check_at = new Date(+f.state.now - 1);
  f.state.failEnqueue = true; assert.equal((await recoverOptimizationRuns(f.deps)).report.failed, 1);
  assert.equal(f.row().job_request_id, null); assert.equal(f.row().recovery_attempts, 0);
  f.state.failEnqueue = false; assert.equal((await recoverOptimizationRuns(f.deps)).report.apply_queued, 1);
});
test('foreign namespaces and foreign job bindings cannot be recovered or relabelled as new work', async () => {
  const f = fixture(); await f.enqueue(); f.row().runtime_namespace = 'foreign'; due(f);
  assert.equal((await recoverOptimizationRuns(f.deps)).report.scanned, 0);
  const g = fixture(); await g.enqueue(); due(g); g.state.jobs.get(1).status = 'failed'; g.state.jobs.get(1).payload.run_id = 'foreign';
  assert.equal((await recoverOptimizationRuns(g.deps)).report.failed, 1); assert.equal(g.state.jobs.size, 1);
});
