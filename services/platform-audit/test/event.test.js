'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { pack, unpack, keyFor } = require('../src/event');
const { fixture } = require('./fixture.cjs');
test('canonical event binds bytes, digest, ID and UTC partition', () => {
  const row = pack(fixture()); assert.equal(unpack(row).body, row.body);
  assert(keyFor(row).startsWith('app/platform/v1/2026-09-12/'));
  assert.throws(() => unpack({ ...row, body: row.body + ' ' }), /audit_integrity_invalid/);
  assert.throws(() => unpack({ ...row, digest: '0'.repeat(64) }), /audit_integrity_invalid/);
});
test('closed contract rejects sensitive fields, unverified actors, impossible success and free text', () => {
  for (const changes of [{ password: 'SENTINEL_SECRET' }, { actor: { type: 'user', id: 'SENTINEL_SECRET' } },
    { origin: { kind: 'forwarded_header', ip: '127.0.0.1' } }, { reason: 'SENTINEL_HEALTH' },
    { sessionRef: ['a'.repeat(32)] }, { sessionRef: null }, { actor: { type: 'anonymous', id: null } },
    { occurredAt: '2026-02-31T12:00:00.000Z' }, { effectiveActor: { type: 'user', id: '1' } },
    { scope: { type: 'clinic', id: '1' } }, { eventId: [fixture().eventId] }]) {
    assert.throws(() => pack(fixture(changes)), /audit_event_invalid/);
  }
  const row = pack(fixture()); const reordered = Object.fromEntries(Object.entries(row.event).reverse());
  assert.equal(pack(reordered).body, row.body);
});
