'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { EmailLedger } = require('../src/email-ledger');
const { BrokerStore } = require('../src/store');
const { payload, accepted, throttled } = require('./email-fixture.cjs');
const scope = p => ({ tenantRef: 'platform:staging', connectionRef: 'email:staging', payload: p });

test('outbox fence survives a second SQLite connection and restart without storing email content', t => {
  const f = fixture(t), ledger = new EmailLedger(f.store), p = payload();
  assert.equal(ledger.reserve(scope(p)), null);
  const other = new BrokerStore(f.filename), second = new EmailLedger(other);
  t.after(() => other.close());
  assert.throws(() => second.reserve(scope({ ...p, attempt: 2 })), { code: 'outcome_unknown' });
  ledger.settle(scope(p), accepted());
  assert.deepEqual(second.reserve(scope({ ...p, attempt: 99 })), accepted());
  const persisted = JSON.stringify(f.store.db.prepare('SELECT * FROM email_deliveries').all());
  for (const secret of [p.to, p.text, p.subject, p.html]) assert(!persisted.includes(secret));
  for (const patch of [{ text: 'changed' }, { to: 'other@example.test' }, { from: 'other@example.test' },
    { templateKey: 'auth.password_reset' }, { configurationSet: 'foreign' }]) {
    assert.throws(() => second.reserve(scope({ ...p, ...patch })), { code: 'idempotency_conflict' });
  }
});

test('only a later attempt after an explicit SES throttle can claim another send', t => {
  const f = fixture(t), ledger = new EmailLedger(f.store), p = payload();
  ledger.reserve(scope(p)); ledger.settle(scope(p), throttled());
  assert.deepEqual(ledger.reserve(scope(p)), throttled());
  const next = { ...p, attempt: 2 };
  assert.equal(ledger.reserve(scope(next)), null);
  assert.throws(() => ledger.reserve(scope({ ...p, attempt: 3 })), { code: 'outcome_unknown' });
  ledger.uncertain(scope(next));
  for (const attempt of [1, 2, 3, 100]) assert.throws(() => ledger.reserve(scope({ ...p, attempt })), { code: 'outcome_unknown' });
});

test('a terminal rejection is durable and a pending send remains fenced after process restart', t => {
  const f = fixture(t), ledger = new EmailLedger(f.store), p = payload(), pending = payload();
  ledger.reserve(scope(p));
  const rejected = { accepted: false, code: 'email_ses_message_rejected', retryable: false };
  ledger.settle(scope(p), rejected); ledger.reserve(scope(pending));
  f.store.close();
  const reopened = new BrokerStore(f.filename), restored = new EmailLedger(reopened);
  t.after(() => reopened.close());
  assert.deepEqual(restored.reserve(scope({ ...p, attempt: 10 })), rejected);
  assert.throws(() => restored.reserve(scope({ ...pending, attempt: 10 })), { code: 'outcome_unknown' });
  assert.equal(restored.reserve({ ...scope(p), tenantRef: 'platform:dev' }), null);
});
