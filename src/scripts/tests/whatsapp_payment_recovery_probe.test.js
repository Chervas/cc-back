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
test('unknown payment on a healthy managed sender permits an explicit configuration test without a fictitious prior failure', () => {
  const f = fixture(); f.asset.whatsappAuthorizationId = '11111111-1111-4111-8111-111111111111';
  f.asset.additionalData.payment = {}; f.health = { state: 'healthy', can_send: true, provider_status: 'CONNECTED' };
  assert.equal(availability(f).allowed, true);
  f.asset.additionalData.payment.last_probe_at = '2030-01-02T09:59:00Z';
  assert.equal(availability(f).reason, 'payment_probe_cooldown');
  f.now = new Date('2030-01-02T10:29:00Z'); assert.equal(availability(f).allowed, true);
  f.health.can_send = false; assert.equal(availability(f).allowed, false);
  f.health.can_send = true; f.asset.additionalData.whatsappManualDisconnect = { state: 'pending' };
  assert.equal(availability(f).allowed, false);
  delete f.asset.additionalData.whatsappManualDisconnect; delete f.asset.whatsappAuthorizationId;
  assert.equal(availability(f).reason, 'payment_probe_configuration_unsupported');
});
