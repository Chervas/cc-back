'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { pack, unpack, keyFor, receiptFor } = require('../src/event');
const { criteriaFor } = require('../src/view-contract');
const { refFor } = require('../src/reader-protocol');
const fixture = () => ({ version: 15, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-13T18:00:00.123Z',
  action: 'integration.whatsapp.authorization_state', stage: 'completed', outcome: 'success', reason: 'state_issued',
  actor: { type: 'user', id: '501' }, scope: { type: 'group', id: '9' }, sessionRef: randomUUID(), requestRef: randomUUID(),
  capturePolicy: 'whatsapp-onboarding-v1' });
test('WhatsApp authorization transitions roundtrip with versioned external receipts and action filter', () => {
  for (const reason of ['state_issued', 'state_claimed', 'state_cancelled']) {
    const v = { ...fixture(), reason }; const p = pack(v); assert.deepEqual(unpack(p).event, v);
    const receipt = { key: keyFor(p), digest: p.digest, versionId: 'FICTITIOUS_VERSION' };
    assert.match(receipt.key, /^app\/platform\/v15\//); assert.deepEqual(receiptFor(p, receipt), receipt);
    assert.deepEqual(refFor(receipt, 'confirmed'), receipt);
    assert.equal(refFor({ ...receipt, versionId: null }, 'reconcile').key, receipt.key);
    assert.throws(() => refFor({ ...receipt, key: receipt.key.replace('/v15/', '/v17/') }, 'confirmed'));
    assert.equal(criteriaFor({ from: '2026-09-13', to: '2026-09-13', action: v.action, userId: '501' }).action, v.action);
  }
});
test('WhatsApp authorization audit rejects secrets, extra fields, invalid actor/scope and misleading outcomes', () => {
  const variants = [{ code: 'FICTITIOUS_CODE' }, { state: 'FICTITIOUS_STATE' }, { token: 'FICTITIOUS_TOKEN' },
    { version: 14 }, { reason: 'connected' }, { outcome: 'error' }, { stage: 'attempted' }, { capturePolicy: 'legacy' },
    { actor: { type: 'job', id: '501' } }, { actor: { type: 'user', id: '0' } },
    { scope: { type: 'platform', id: null } }, { scope: { type: 'clinic', id: '2147483648' } },
    { requestRef: 'invalid' }, { sessionRef: null }, { occurredAt: '2026-02-30T18:00:00.123Z' }];
  for (const changes of variants) assert.throws(() => pack({ ...fixture(), ...changes }), { code: 'audit_event_invalid' });
});
