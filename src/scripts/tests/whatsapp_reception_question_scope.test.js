'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('./fixtures/campaign_offline_runtime.cjs');
const health = require('../../lib/whatsappInboxHealth');
const now = Date.parse('2030-01-02T10:00:00Z'), question = now - 3600000;
const conversation = { id: 7, clinic_id: 72, channel: 'whatsapp', contact_id: '19995550101' };
const bindings = [{ clinicId: 72, phoneId: '201' }];
const query = async () => [[]];
function snapshot(newestAt = question - 120001) {
  return { version: 1, observedAt: now, recoveryHold: false, clinics: [{ clinicId: 72,
    oldestPendingAt: null, blockingReview: 2, unscopedBlockingReview: 2, blockingContactKeys: [],
    reviewSummary: [{ category: 'user_identity_unresolved', count: 2, oldestAt: newestAt - 60000, newestAt, errorCodes: [] }] }] };
}
const scoped = (s, questionNotBefore = question) => health.forConversation(s, conversation, bindings, query, { now, questionNotBefore });
test('only old identity-only events cease blocking a later verified-phone question; monitoring retains them', async () => {
  const s = snapshot(), before = structuredClone(s);
  const state = await scoped(s);
  assert.equal(state.healthy, true); assert.equal(state.readyForTimeout, true);
  assert.equal(health.state(s, 72, now).readyForTimeout, false);
  assert.deepEqual(s, before);
});
test('recent identity events and the exact two-minute clock boundary still hold silence', async () => {
  for (const newest of [question - 120000, question - 1, question, now]) {
    assert.equal((await scoped(snapshot(newest))).readyForTimeout, false);
  }
});
test('missing, future, unordered, mixed or malformed evidence cannot open silence', async () => {
  for (const cutoff of [null, undefined, now + 1, -1, NaN, String(question)]) {
    assert.equal((await scoped(snapshot(), cutoff === undefined ? null : cutoff)).readyForTimeout, false);
  }
  for (const mutate of [s => s.recoveryHold = true, s => s.observedAt = now - 90001,
    s => s.clinics[0].oldestPendingAt = now - 1,
    s => s.clinics[0].reviewSummary[0].oldestAt = null,
    s => s.clinics[0].reviewSummary[0].newestAt = null,
    s => s.clinics[0].reviewSummary[0].oldestAt = question,
    s => s.clinics[0].reviewSummary[0].category = 'incoming_messages',
    s => s.clinics[0].reviewSummary[0].count = 1,
    s => { s.clinics[0].blockingReview++; s.clinics[0].unscopedBlockingReview++;
      s.clinics[0].reviewSummary.push({ category: 'unknown', count: 1, oldestAt: 1, newestAt: 2, errorCodes: [] }); }]) {
    const s = snapshot(); mutate(s); assert.notEqual((await scoped(s)).readyForTimeout, true);
  }
});
test('the affected contact remains blocked even when the unidentified events are older', async () => {
  const s = snapshot(); const key = require('node:crypto').createHash('sha256')
    .update(JSON.stringify([72, '201', conversation.contact_id])).digest('hex');
  Object.assign(s.clinics[0], { blockingReview: 3, blockingContactKeys: [key] });
  s.clinics[0].reviewSummary.push({ category: 'incoming_messages', count: 1, oldestAt: question, newestAt: question, errorCodes: [] });
  assert.equal((await scoped(s)).readyForTimeout, false);
});
test('the question boundary is the earliest persisted scoped outbound, not a planned send or retry', async () => {
  const execution = { id: 10, clinic_id: 72, context: { outputs: { first: { conversation_id: 7, message_id: 11,
    effective_send_at: new Date(now + 3600000).toISOString() }, later: { conversation_id: 7, message_id: 12 } } } };
  const row = id => ({ id, direction: 'outbound', conversation_id: 7, status: 'delivered',
    createdAt: new Date(id === 11 ? question : question + 60000), metadata: { execution_id: 10 } });
  assert.equal(await health.questionNotBefore(execution, conversation, async id => row(id), { now }), question);
  for (const mutate of [r => r.conversation_id = 8, r => r.metadata.execution_id = 9,
    r => r.direction = 'inbound', r => r.status = 'pending', r => r.createdAt = new Date(now + 1),
    r => r.createdAt = '2030-01-02 09:00:00', r => r.createdAt = null]) {
    assert.equal(await health.questionNotBefore(execution, conversation, async id => { const r = row(id); mutate(r); return r; }, { now }), null);
  }
  assert.equal(await health.questionNotBefore(execution, conversation, async () => { throw Error('TESTONLY DB unavailable'); }, { now }), null);
  assert.equal(await health.questionNotBefore({ ...execution, context: { outputs: {} } }, conversation, async id => row(id), { now }), null);
  assert.equal(await health.questionNotBefore({ ...execution, clinic_id: 35 }, conversation, async id => row(id), { now }), null);
});
