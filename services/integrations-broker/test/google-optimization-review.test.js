'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { setup } = require('./google-optimization-writes-fixture.cjs');
const C = require('../src/google-optimization-write-contract');
const { fail } = require('../src/errors');
const review = (f, submission, extra = {}) => f.command('review', { submission, actorId: 7,
  observedAt: f.state.at, value: submission.after, confirmed: true, ...extra });
const later = (f, submission) => { f.state.at = submission.expiresAt + C.REVIEW_DELAY_MS + 1; };
async function unknown(f, submission) {
  f.state.afterWrite = () => fail('provider_timeout');
  await assert.rejects(f.execute(f.command('apply', submission)), { code: 'provider_timeout' });
  f.state.afterWrite = null; later(f, submission);
}
test('manual review seals an unknown execution without secrets or provider work and keeps its cooldown', async t => {
  const f = setup(t); const input = f.input(); await unknown(f, input);
  const counts = [f.state.sdk.length, f.state.calls.length];
  const result = (await f.execute(review(f, input))).data;
  assert.equal(result.state, 'reviewed'); assert.equal(result.result.previousState, 'unknown'); assert.equal(result.result.reviewedBy, 7);
  assert.deepEqual([f.state.sdk.length, f.state.calls.length], counts);
  assert.equal(f.getStore().db.prepare('SELECT count(*) n FROM google_optimization_locks').get().n, 0);
  assert.equal(f.getStore().db.prepare('SELECT state FROM google_optimization_mutations').get().state, 'attempted');
  assert.deepEqual(await f.status(input.executionId), result);
  await assert.rejects(f.execute(f.command('apply', input)), { code: 'optimization_reviewed' });
  await assert.rejects(f.execute(f.command('apply', f.input())), { code: 'optimization_cooldown' }); assert.equal(f.state.writes, 1);
  assert.ok(f.getStore().backlog().pending > 0);
});
test('a lost SQL acknowledgement can close an unsent execution and tombstones prevent any late apply', async t => {
  const f = setup(t); const input = f.input('manual_cpc'); later(f, input);
  const result = (await f.execute(review(f, input))).data; assert.equal(result.result.previousState, 'not_found');
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
  assert.equal(f.getStore().db.prepare('SELECT count(*) n FROM google_optimization_mutations').get().n, 0);
  await assert.rejects(f.execute(f.command('apply', input)), { code: 'optimization_reviewed' });
  f.reopen(); assert.deepEqual(await f.status(input.executionId), result);
  const duplicate = (await f.execute(review(f, input, { actorId: 8 }))).data;
  assert.deepEqual(duplicate, result); assert.equal(duplicate.result.reviewedBy, 7);
});
test('review does not rewrite an applied receipt or claim a second provider mutation', async t => {
  const f = setup(t); const input = f.input(); await f.execute(f.command('apply', input)); later(f, input);
  const result = (await f.execute(review(f, input, { value: 'ENABLED' }))).data;
  assert.equal(result.result.previousState, 'applied'); assert.equal(result.result.value, 'ENABLED');
  assert.equal(f.getStore().db.prepare('SELECT state FROM google_optimization_mutations').get().state, 'applied'); assert.equal(f.state.writes, 1);
});
test('review requires explicit grant, confirmation, original payload, fresh observation and elapsed expiry', async t => {
  for (const mode of ['early', 'future', 'stale', 'confirmation', 'field', 'changed', 'grant', 'apply-grant']) await t.test(mode, async t => {
    const f = setup(t); const input = f.input(); await unknown(f, input);
    const command = review(f, input);
    if (mode === 'early') f.state.at = input.expiresAt + C.REVIEW_DELAY_MS - 1;
    if (mode === 'future') command.payload.observedAt++;
    if (mode === 'stale') f.state.at += C.TTL_MS;
    if (mode === 'confirmation') command.payload.confirmed = false;
    if (mode === 'field') command.payload.token = 'PRIVATE';
    if (mode === 'changed') command.payload.submission = { ...input, baselineAdId: '62' };
    if (mode === 'grant' || mode === 'apply-grant') {
      f.policy.grants.at(-1).operations = f.policy.grants.at(-1).operations.filter(op => op !== C.OPERATIONS[mode === 'grant' ? 'review' : 'apply']); f.reset();
    }
    const counts = [f.state.sdk.length, f.state.calls.length]; await assert.rejects(f.execute(command));
    assert.deepEqual([f.state.sdk.length, f.state.calls.length], counts);
    assert.equal(f.getStore().db.prepare('SELECT count(*) n FROM google_optimization_reviews').get().n, 0);
    assert.equal(f.getStore().db.prepare('SELECT count(*) n FROM google_optimization_locks').get().n, 1);
  });
});
test('a still-running or abandoned started transport is not dismissed using elapsed time alone', async t => {
  const f = setup(t); const input = f.input(); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.state.afterWrite = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.execute(f.command('apply', input)); await entered; later(f, input);
  await assert.rejects(f.execute(review(f, input)), { code: 'optimization_review_pending' });
  assert.equal(f.getStore().db.prepare('SELECT count(*) n FROM google_optimization_reviews').get().n, 0);
  release(); await pending;
});
test('revocation and changed scope prevent reading or reusing a manual receipt after restart', async t => {
  const f = setup(t); const input = f.input(); await unknown(f, input); await f.execute(review(f, input)); f.reopen();
  f.binding.googleSubject = 'different-subject'; f.reset();
  await assert.rejects(f.status(input.executionId), { code: 'scope_denied' });
  await assert.rejects(f.execute(review(f, input)), { code: 'scope_denied' });
});
test('review receipt, lock release and audit commit atomically, with retry safe after an audit failure', async t => {
  const f = setup(t); const input = f.input(); await unknown(f, input);
  const store = f.getStore(); const append = store.appendAudit;
  store.appendAudit = function (event) { if (event.reason === 'optimization_manually_reviewed') throw Error('fictitious-audit-failure'); return append.call(this, event); };
  await assert.rejects(f.execute(review(f, input)));
  assert.equal(store.db.prepare('SELECT count(*) n FROM google_optimization_reviews').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM google_optimization_locks').get().n, 1);
  store.appendAudit = append;
  assert.equal((await f.execute(review(f, input))).data.state, 'reviewed'); assert.equal(f.state.writes, 1);
});
test('concurrent reviews record one immutable reviewer', async t => {
  const f = setup(t); const input = f.input(); await unknown(f, input);
  const peer = f.fork();
  const results = await Promise.allSettled([f.execute(review(f, input)), peer.execute(review(f, input, { actorId: 8 }))]);
  assert.equal(f.getStore().db.prepare('SELECT count(*) n FROM google_optimization_reviews').get().n, 1);
  assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(f.state.writes, 1);
  const stored = await f.status(input.executionId);
  for (const result of results.filter(result => result.status === 'fulfilled')) assert.deepEqual(result.value.data, stored);
});
test('revoked apply permission rejects a cached review receipt before transport replay', async t => {
  const f = setup(t); const input = f.input(); await unknown(f, input);
  const command = review(f, input); await f.execute(command);
  const counts = [f.state.sdk.length, f.state.calls.length];
  f.policy.grants.at(-1).operations = f.policy.grants.at(-1).operations.filter(op => op !== C.OPERATIONS.apply); f.reset();
  await assert.rejects(f.execute(command), { code: 'scope_denied' });
  await assert.rejects(f.status(input.executionId), { code: 'scope_denied' });
  assert.deepEqual([f.state.sdk.length, f.state.calls.length], counts);
});
