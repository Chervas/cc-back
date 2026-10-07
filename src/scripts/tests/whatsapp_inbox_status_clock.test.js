'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalize } = require('../../lib/whatsappInboxImport');
const scope = { clinicId: 71, wabaId: '101', phoneId: '201' }, now = Date.parse('2026-10-07T12:00:00Z');
const raw = status => Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '101', changes: [
  { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '201' }, statuses: [{ id: 'wamid.OWNED_clock', ...status }] } },
] }] }));
test('inbox retains exact valid provider seconds, never substitutes receipt time, and rejects malformed clocks', () => {
  for (const status of ['sent', 'delivered', 'read', 'failed']) {
    assert.equal(normalize(raw({ status, timestamp: '1791374400' }), scope, now).statuses[0].timestamp, '1791374400');
    assert.equal(normalize(raw({ status }), scope, now).statuses[0].timestamp, undefined); // sent missing is held at NEW import boundary.
    for (const timestamp of [null, '', 'Infinity', Infinity, NaN, 'NaN', 1791374400, true, {}, '-1', '0', '1.5', '9007199254740992', '946684799', '1791374701']) {
      assert.throws(() => normalize(raw({ status, timestamp }), scope, now), error => error.inboxReason === 'review_required' && error.reviewDetail === 'invalid_status_timestamp');
    }
  }
});
