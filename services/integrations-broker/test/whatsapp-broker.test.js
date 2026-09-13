'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { fixture, SEND_TOKEN, READ_TOKEN, APP_SECRET } = require('./whatsapp-fixture.cjs');
const C = require('../src/whatsapp-contract'); const { BrokerError } = require('../src/errors');
const { BrokerStore } = require('../src/store'); const { eventFor, drainAudit } = require('../src/audit');
const accepted = () => ({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.FICTITIOUS_ACCEPTED' }], contacts: [{ wa_id: 'FICTITIOUS_PRIVATE_RECIPIENT' }] });
test('WhatsApp scope, operation and template admission reject before AWS access', async t => {
  const f = fixture(t); let sends = 0; const broker = f.makeBroker(async () => { sends++; return accepted(); });
  const cases = [
    [{ tenantRef: 'clinic:999' }, 'scope_denied'], [{ assetRef: 'wa-phone:999' }, 'scope_denied'],
    [{ operation: 'meta.whatsapp.template.create.v1' }, 'scope_denied'],
    [{ payload: { to: '34000000123', body: 'test', previewUrl: false, accessToken: SEND_TOKEN } }, 'invalid_request'],
    [{ operation: C.TEMPLATE, payload: { to: '34000000123', templateKey: 'unapproved', parameters: [] } }, 'operation_denied'],
    [{ operation: C.TEMPLATE, payload: { to: '34000000123', templateKey: 'appointment', parameters: [] } }, 'operation_denied'],
  ];
  for (const [input, code] of cases) await assert.rejects(f.execute(broker, f.command(input)), { code });
  await assert.rejects(f.execute(broker, f.command(), true), { code: 'scope_denied' });
  assert.equal(sends, 0); assert.equal(f.calls.length, 0);
});
test('accepted text persists only the receipt, replays across restart and rejects changed intent', async t => {
  const f = fixture(t); let sends = 0;
  const http = async req => { sends++; assert.equal(req.action, 'send'); assert.equal(req.id, '401'); assert.equal(req.token.toString(), SEND_TOKEN);
    assert.deepEqual(req.json, { messaging_product: 'whatsapp', recipient_type: 'individual', type: 'text', to: '34000000123',
      text: { body: 'FICTITIOUS_MESSAGE_BODY', preview_url: false } }); return accepted(); };
  const broker = f.makeBroker(http); const intent = f.command(); const first = await f.execute(broker, intent);
  assert.deepEqual(first.data, { messageId: 'wamid.FICTITIOUS_ACCEPTED' }); assert.equal(first.replayed, false);
  const reopened = new BrokerStore(f.filename); t.after(() => reopened.close()); const restarted = f.makeBroker(http, reopened);
  assert.equal((await f.execute(restarted, intent)).replayed, true); assert.equal(sends, 1);
  await assert.rejects(f.execute(restarted, { ...intent, payload: { ...intent.payload, body: 'changed' } }), { code: 'idempotency_conflict' });
  const events = []; await drainAudit(f.store, { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'qa-v1', digest: row.digest }; } });
  const stored = JSON.stringify(events) + JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());
  for (const sentinel of [SEND_TOKEN, READ_TOKEN, APP_SECRET, 'FICTITIOUS_MESSAGE_BODY', '34000000123', 'FICTITIOUS_PRIVATE_RECIPIENT']) assert(!stored.includes(sentinel));
  assert.equal(f.store.backlog().pending, 0); assert.equal(sends, 1);
});
test('lost provider response is durable unknown: retries and restart never repeat the POST', async t => {
  const f = fixture(t); let sends = 0; const http = async () => { sends++; throw new BrokerError('provider_timeout'); };
  const broker = f.makeBroker(http); const intent = f.command();
  await assert.rejects(f.execute(broker, intent), { code: 'provider_timeout' });
  const reopened = new BrokerStore(f.filename); t.after(() => reopened.close());
  await assert.rejects(f.execute(f.makeBroker(http, reopened), intent), { code: 'outcome_unknown' }); assert.equal(sends, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM commands').get().state, 'unknown');
});
test('template sends use a separate reader and a locally pinned approved identity and content', async t => {
  const f = fixture(t); const calls = [];
  const broker = f.makeBroker(async req => { calls.push(req.action);
    if (req.action === 'template') { assert.equal(req.id, '901'); assert.equal(req.token.toString(), READ_TOKEN); return structuredClone(f.rawTemplate); }
    assert.equal(req.token.toString(), SEND_TOKEN); assert.equal(req.id, '401');
    assert.deepEqual(req.json.template, { name: 'qa_appointment', language: { code: 'es' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'FICTITIOUS_PATIENT' }] }] }); return accepted();
  });
  await f.execute(broker, f.command({ operation: C.TEMPLATE, payload: { to: '34000000123', templateKey: 'appointment', parameters: ['FICTITIOUS_PATIENT'] } }));
  assert.deepEqual(calls, ['template', 'send']);
});
for (const change of ['content', 'status', 'id', 'name', 'language', 'buttons']) test('changed template ' + change + ' prevents POST', async t => {
  const f = fixture(t); let sends = 0; const raw = structuredClone(f.rawTemplate);
  if (change === 'content') raw.components[0].text += ' changed';
  else if (change === 'buttons') raw.components.push({ type: 'BUTTONS', buttons: [] });
  else raw[change] = 'changed';
  const broker = f.makeBroker(async req => { if (req.action === 'template') return raw; sends++; return accepted(); });
  await assert.rejects(f.execute(broker, f.command({ operation: C.TEMPLATE, payload: { to: '34000000123', templateKey: 'appointment', parameters: ['QA'] } })),
    err => ['operation_denied', 'provider_failed'].includes(err.code));
  assert.equal(sends, 0);
});
for (const block of ['asset', 'connection']) test('external durable ' + block + ' block during template lookup prevents POST and survives restart', async t => {
  const f = fixture(t); let sends = 0; const otherStore = new BrokerStore(f.filename); t.after(() => otherStore.close());
  const other = f.makeBroker(async () => { throw Error('PROVIDER_FORBIDDEN'); }, otherStore);
  const broker = f.makeBroker(async req => {
    if (req.action !== 'template') { sends++; return accepted(); }
    if (block === 'asset') await f.execute(other, f.command({ operation: C.REVOKE, payload: {} }), true);
    else otherStore.block(f.binding.connectionRef, eventFor(f.command(), f.policy.principals[1], f.policy, 'connection.blocked', 'success', 'operator_block'));
    return f.rawTemplate;
  });
  const intent = f.command({ operation: C.TEMPLATE, payload: { to: '34000000123', templateKey: 'appointment', parameters: ['QA'] } });
  const code = block === 'asset' ? 'asset_revoked' : 'connection_blocked';
  await assert.rejects(f.execute(broker, intent), { code });
  await assert.rejects(f.execute(f.makeBroker(async () => { sends++; }, otherStore), f.command()), { code }); assert.equal(sends, 0);
});
test('revoked provider credential blocks the whole connection and never tries a replacement', async t => {
  const f = fixture(t); let sends = 0; const broker = f.makeBroker(async () => { sends++; throw new BrokerError('credential_revoked'); });
  await assert.rejects(f.execute(broker, f.command()), { code: 'credential_revoked' }); const reads = f.calls.length;
  await assert.rejects(f.execute(broker, f.command()), { code: 'connection_blocked' }); assert.equal(sends, 1); assert.equal(f.calls.length, reads);
});
test('a concurrent duplicate is never sent and a completed receipt can subsequently be recovered', async t => {
  const f = fixture(t); let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; }); let sends = 0;
  const broker = f.makeBroker(async () => { sends++; entered(); await wait; return accepted(); }); const intent = f.command();
  const first = f.execute(broker, intent); await ready;
  await assert.rejects(f.execute(broker, intent), { code: 'outcome_unknown' }); release(); await first;
  assert.equal((await f.execute(broker, intent)).replayed, true); assert.equal(sends, 1);
});
test('full audit backlog prevents secret loading and provider writes', async t => {
  const f = fixture(t); f.policy.maxBacklog = 2; let sends = 0; const broker = f.makeBroker(async () => { sends++; return accepted(); });
  for (let i = 0; i < 2; i++) f.store.appendAudit(eventFor(f.command(), f.policy.principals[0], f.policy, 'integration.denied', 'denied', 'scope_denied'));
  await assert.rejects(f.execute(broker, f.command()), { code: 'audit_unavailable' }); assert.equal(sends, 0); assert.equal(f.calls.length, 0);
});
