'use strict';
const { randomUUID } = require('node:crypto');
const { pack } = require('../src/event');
function fixture(overrides = {}) {
  return { version: 1, eventId: randomUUID(), occurredAt: '2026-09-12T12:00:00.000Z', correlationId: randomUUID(),
    action: 'auth.sign_in', stage: 'completed', outcome: 'success', reason: 'credentials_verified',
    actor: { type: 'user', id: '123' }, effectiveActor: null, sessionRef: randomUUID(),
    scope: { type: 'platform', id: null }, resource: { type: 'session', id: null }, capturePolicy: 'auth-durable-v1',
    authorizationPolicyVersion: null, origin: { kind: 'direct_peer', ip: '127.0.0.1' }, ...overrides };
}
function memoryRepository() {
  const rows = new Map();
  return { rows, health: async () => ({ pending: rows.size, reconcile: 0, oldestAgeSeconds: 0 }),
    append: async value => { const row = pack(value); const previous = rows.get(value.eventId);
      if (previous && previous.digest !== row.digest) throw Error('audit_event_conflict');
      rows.set(value.eventId, row); return row; } };
}
module.exports = { fixture, memoryRepository };
