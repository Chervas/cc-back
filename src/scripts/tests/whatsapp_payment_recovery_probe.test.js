'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { availability } = require('../../lib/whatsapp-payment-recovery-probe');
function fixture() {
  return { now: new Date('2030-01-02T10:00:00Z'), asset: { isActive: true, additionalData: { payment: {
    status: 'missing_payment_method', last_error_code: 131042, last_detected_at: '2030-01-02T09:00:00Z' } } },
  health: { state: 'blocked', reason_code: 'meta_error_131042_payment_missing', provider_status: 'CONNECTED' } };
}
test('only the known payment block on a connected active number offers a probe', () => {
  assert.equal(availability(fixture()).allowed, true);
  for (const patch of [{ state: 'healthy' }, { reason_code: 'security_block' }, { provider_status: 'DISCONNECTED' }]) {
    const f = fixture(); Object.assign(f.health, patch); assert.equal(availability(f).allowed, false);
  }
  for (const patch of [{ isActive: false }, { additionalData: { routing_disabled: true } },
    { additionalData: { whatsappArchive: { archivedAt: '2030-01-01' } } }]) {
    const f = fixture(); Object.assign(f.asset, patch); assert.equal(availability(f).allowed, false);
  }
});
test('five-minute minimum and thirty-minute cooldown remain authoritative, with exact boundaries', () => {
  const f = fixture(); f.asset.additionalData.payment.last_detected_at = '2030-01-02T09:55:01Z';
  assert.equal(availability(f).allowed, false); assert.equal(availability(f).retry_after_seconds, 1);
  f.now = new Date('2030-01-02T10:00:01Z'); assert.equal(availability(f).allowed, true);
  f.asset.additionalData.payment.last_probe_at = '2030-01-02T09:45:01Z';
  assert.equal(availability(f).reason, 'payment_probe_cooldown'); assert.equal(availability(f).retry_after_seconds, 900);
  f.now = new Date('2030-01-02T10:15:01Z'); assert.equal(availability(f).allowed, true);
  f.asset.additionalData.payment.last_detected_at = 'invalid'; assert.equal(availability(f).allowed, false);
});
