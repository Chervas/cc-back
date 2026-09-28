'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { writerFixture } = require('./fixtures/campaign_workspace_optimization_writer.fixture');
const { recoverOptimizationRuns } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const C = require('../../../services/integrations-broker/src/google-optimization-write-contract');
for (const kind of C.KINDS) test(`${kind}: executor preserves policy and original grant through signed broker write and readback`, async t => {
  const f = await writerFixture(t, kind); await f.enqueue();
  const result = await f.run(); assert.equal(result.result?.state, 'verified', JSON.stringify(result));
  assert.equal(f.provider.state.writes, 1); assert.equal(f.row().outcome.acknowledged, true);
  assert.equal(f.row().outcome.broker_submission.payload.executionId, f.row().id);
  assert.equal(f.row().outcome.broker_submission.payload.mandateId, f.row().mandate_id);
  assert.equal(f.row().outcome.broker_submission.payload.evidenceFingerprint, C.hash(f.evidence));
  assert.equal((await f.run()).result.idempotent, true); assert.equal(f.provider.state.writes, 1);
  assert.doesNotMatch(JSON.stringify([result, f.row()]), /accessToken|refreshToken|FICTITIOUS|connection:test/);
  if (kind === 'daily_budget') {
    assert.equal(f.row().outcome.budget_accounting.observations.length, 2);
    assert.ok(f.writerState.commands.some(command => command.operation === 'google.ads.optimization_budget.read.v1' && command.payload.campaignId === '31'));
  }
  if (kind.includes('cpa') || kind.includes('roas')) assert.ok(f.writerState.commands.some(command => command.operation === 'google.ads.optimization_targets.read.v1'));
});
test('missing writer grant, disabled writer, invalid baseline or closed gates stop before submission', async t => {
  const cases = [f => { f.writerState.enabled = false; }, f => { f.provider.policy.grants.pop(); f.provider.reset(); },
    f => { f.provider.state.rows.ad_groups[0].adGroup.cpcBidMicros = '1600000'; },
    f => { f.deps.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'false'; }];
  for (const [index, change] of cases.entries()) await t.test(String(index), async t => {
    const f = await writerFixture(t); await f.enqueue(); change(f); const result = await f.run();
    assert.notEqual(result.result?.state, 'verified'); assert.equal(f.row().submitted_at, null); assert.equal(f.provider.state.writes, 0);
  });
});
test('monthly limit still blocks a budget adjustment despite an explicit daily broker cap', async t => {
  const f = await writerFixture(t, 'daily_budget'); await f.enqueue(); f.source.limits.monthly_limit_cents = 1;
  const result = await f.run(); assert.equal(result.result.reason, 'workspace_optimization_budget_limit_exceeded');
  assert.equal(f.row().submitted_at, null); assert.equal(f.provider.state.writes, 0);
});
test('lost consumer acknowledgement recovers the original broker receipt and never resends', async t => {
  const f = await writerFixture(t); await f.enqueue();
  f.writerState.afterWriter = command => { if (command.operation === C.OPERATIONS.apply) throw Object.assign(Error('lost'), { code: 'broker_timeout' }); };
  assert.equal((await f.run()).result.state, 'uncertain'); const saved = structuredClone(f.row().outcome.broker_submission);
  assert.equal(f.provider.state.writes, 1); f.writerState.afterWriter = null; f.check();
  const result = await f.run(); assert.equal(result.result.state, 'verified'); assert.equal(result.result.recovered, true);
  assert.deepEqual(f.row().outcome.broker_submission, saved); assert.equal(f.provider.state.writes, 1);
  assert.equal(f.writerState.commands.filter(command => command.operation === C.OPERATIONS.apply).length, 1);
});
test('lost SQL commit acknowledgement leaves an immutable unsent attempt, never replayed by recovery', async t => {
  const f = await writerFixture(t); await f.enqueue(); f.state.lostCommit = true;
  assert.equal((await f.run()).result.state, 'uncertain'); assert.ok(f.row().outcome.broker_submission);
  assert.equal(f.provider.state.writes, 0); f.check();
  const result = await f.run(); assert.equal(result.result.state, 'uncertain'); assert.equal(result.result.broker_state, 'not_found');
  assert.equal(f.provider.state.writes, 0);
});
test('uncertain broker outcome remains review-required even when the desired value can be read', async t => {
  const f = await writerFixture(t); await f.enqueue(); const apply = f.provider.state.afterWrite;
  f.provider.state.afterWrite = request => { apply(request); throw Object.assign(Error('lost'), { code: 'provider_timeout' }); };
  assert.equal((await f.run()).result.state, 'uncertain'); f.check();
  const result = await f.run(); assert.equal(result.result.state, 'uncertain'); assert.equal(result.result.broker_state, 'unknown');
  assert.equal(result.result.desired_state_observed, true); assert.equal(f.provider.state.writes, 1);
});
test('ACL, mandate, connection, writer identity or lease changes after send cannot yield success', async t => {
  for (const [name, mutate] of [['acl', f => { f.state.permitted = false; }],
    ['mandate', f => { f.setting.activation.optimization.id = randomUUID(); }],
    ['binding', f => { f.scope.binding.state = 'revoked'; }],
    ['writer', f => { f.writerState.writerIdentity = 'b'.repeat(64); }],
    ['lease', f => { f.row().lease_token = randomUUID(); }]]) await t.test(name, async t => {
    const f = await writerFixture(t); await f.enqueue();
    f.writerState.afterWriter = command => { if (command.operation === C.OPERATIONS.apply) mutate(f); };
    const result = await f.run(); assert.notEqual(result.result?.state, 'verified'); assert.equal(f.provider.state.writes, 1);
    assert.notEqual(f.row().status, 'observed');
  });
});
test('writer authority is rechecked inside the final receipt transaction', async t => {
  const f = await writerFixture(t); await f.enqueue(); const transaction = f.deps.models.sequelize.transaction; let count = 0;
  f.deps.models.sequelize.transaction = fn => transaction(async tx => {
    if (++count === 3) f.writerState.writerIdentity = 'b'.repeat(64); return fn(tx);
  });
  const result = await f.run(); assert.equal(result.result.state, 'uncertain'); assert.equal(f.provider.state.writes, 1);
});
test('recovery keeps the durable broker submission when permission is denied and never rewrites it', async t => {
  const f = await writerFixture(t); await f.enqueue(); f.state.lostCommit = true; await f.run();
  const submission = structuredClone(f.row().outcome.broker_submission); f.row().next_check_at = new Date(+f.state.now - 1);
  f.state.jobs.get(1).status = 'completed'; f.state.permitted = false;
  const result = await recoverOptimizationRuns(f.deps); assert.equal(result.report.review_required, 1);
  assert.deepEqual(f.row().outcome.broker_submission, submission); assert.equal(f.provider.state.writes, 0);
});
test('a submitted broker run cannot load legacy credentials after its transport changes', async t => {
  const f = await writerFixture(t); await f.enqueue(); f.state.lostCommit = true; await f.run();
  const submission = structuredClone(f.row().outcome.broker_submission); let refreshes = 0;
  f.deps.ensureToken = async () => { refreshes++; throw Error('legacy refresh forbidden'); };
  delete f.source.context.grant.brokerGrant; f.check();
  const result = await f.run();
  assert.equal(result.result.reason, 'workspace_optimization_connection_changed');
  assert.equal(result.result.state, 'uncertain'); assert.equal(refreshes, 0);
  assert.deepEqual(f.row().outcome.broker_submission, submission); assert.equal(f.provider.state.writes, 0);
});
