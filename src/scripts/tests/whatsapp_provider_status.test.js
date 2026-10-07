'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { factualSentAt, mergeStatusMetadata, projectProviderStatus } = require('../../lib/whatsapp-provider-status');
test('send clock requires a factual finite positive integer provider sent timestamp', () => {
  for (const timestamp of [undefined, null, '', 'Infinity', Infinity, 'NaN', NaN, '1e999', '-1', -1, 0, '0', true, {}, '1.5', 1.5, '9007199254740992']) {
    assert.equal(factualSentAt({ status: 'sent', timestamp }), null);
  }
  for (const status of ['accepted', 'delivered', 'read', 'held_for_quality_assessment']) assert.equal(factualSentAt({ status, timestamp: '1791374400' }), null);
  assert.equal(factualSentAt({ status: 'sent', timestamp: '1791374400' }).toISOString(), '2026-10-07T12:00:00.000Z');
});
test('CURRENT status projection fills a late factual clock without regressing delivery or changing failure lane policy', () => {
  const current = { status: 'read', sent_at: null, metadata: { wamid: 'owned', private_binding: { retained: true } } };
  const projected = projectProviderStatus(current, { status: 'sent', timestamp: '1791374400' });
  assert.equal(projected.status, 'read'); assert.equal(projected.sent_at.toISOString(), '2026-10-07T12:00:00.000Z');
  assert.equal(current.sent_at, null); assert.deepEqual(projected.metadata.private_binding, current.metadata.private_binding);
  assert.equal(projectProviderStatus(current, { status: 'delivered', timestamp: '1791374400' }), null);
  assert.equal(projectProviderStatus(current, { status: 'failed', errors: [{ code: 131026 }] }, { recoverFailed: true }), null);
  const failed = { status: 'failed', sent_at: new Date('2026-10-07T12:00:00Z'), metadata: { wa_error: [{ code: 131026 }] } };
  assert.equal(projectProviderStatus(failed, { status: 'delivered', errors: [] }), null);
  const recovered = projectProviderStatus(failed, { status: 'delivered', errors: [] }, { recoverFailed: true });
  assert.equal(recovered.status, 'delivered'); assert.equal(recovered.sent_at, failed.sent_at);
  assert.deepEqual(recovered.metadata.wa_error, failed.metadata.wa_error);
});
test('status metadata merge preserves acceptance/history and does not mutate its input', () => {
  const saved = { provider_acceptance_status: 'held_for_quality_assessment', wamid: 'owned', wa_status_history: [{ status: 'delivered', timestamp: '2' }],
    wa_status_timestamps: { delivered: '2' }, private_binding: { retained: true } }, before = structuredClone(saved);
  const merged = mergeStatusMetadata(saved, { status: 'sent', timestamp: '1' });
  assert.deepEqual(saved, before); assert.equal(merged.wa_status_history.length, 2);
  assert.deepEqual(merged.wa_status_timestamps, { delivered: '2', sent: '1' });
  assert.equal(merged.provider_acceptance_status, 'held_for_quality_assessment'); assert.deepEqual(merged.private_binding, saved.private_binding);
});
