'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { pack, unpack, keyFor } = require('../src/event'); const { FEATURE_KEYS, ROLE_CODES, PERMISSION_ACTIONS } = require('../src/access-policy-contract');
const { criteriaFor } = require('../src/view-contract');
function fixture() { return { version: 4, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-12T20:00:00.000Z',
  action: 'permission.override.change', stage: 'completed', outcome: 'success', reason: 'override_changed', actor: { type: 'user', id: '501' }, sessionRef: randomUUID(),
  scope: { type: 'clinic', id: '71' }, featureKey: 'patients.sensitive.view', roleCode: 'doctor', requestedEffect: 'deny', previousEffect: 'allow',
  resultCount: 1, scopeClinicCount: 1, authorizationBasis: 'scope_owner', authorizationPolicyVersion: 'a'.repeat(64), capturePolicy: 'permissions-durable-v1' }; }
test('permission events retain exact transition, scope and decision version with canonical bytes and a distinct partition', () => {
  const event = fixture(); const row = pack(event); assert.deepEqual(unpack(row).event, event); assert(keyFor(row).startsWith('app/platform/v4/'));
  assert.equal(pack(JSON.parse(JSON.stringify(event))).digest, row.digest);
  for (const action of PERMISSION_ACTIONS) assert.equal(criteriaFor({ from: '2026-09-12', to: '2026-09-12', action, userId: null }).action, action);
  assert(FEATURE_KEYS.includes(event.featureKey)); assert(ROLE_CODES.includes(event.roleCode));
});
test('closed permission schema rejects content, fake outcomes, non-owner mutations and unknown policy vocabulary', () => {
  const event = fixture();
  for (const change of [{ actor: { type: 'user', id: '501', email: 'SENTINEL' } }, { jwt: 'SENTINEL' }, { featureKey: 'SENTINEL' },
    { previousEffect: 'administrator' }, { roleCode: 'administrator' }, { authorizationBasis: 'authenticated' },
    { authorizationPolicyVersion: 'SENTINEL' }, { previousEffect: null }, { reason: 'override_unchanged' }, { scope: { type: 'platform', id: null } },
    { resultCount: 500 }, { scopeClinicCount: 0 }]) assert.throws(() => pack({ ...event, ...change }));
  const attempted = { ...event, stage: 'attempted', outcome: 'unknown', reason: 'request_received', previousEffect: null,
    resultCount: null, scopeClinicCount: null, authorizationBasis: 'not_evaluated' };
  assert(pack(attempted)); assert.throws(() => pack({ ...attempted, resultCount: 1 }));
  assert(pack({ ...attempted, stage: 'completed', outcome: 'denied', reason: 'access_denied', resultCount: 0, scopeClinicCount: 0, authorizationBasis: 'scope_denied' }));
});
