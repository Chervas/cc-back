'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { playbackScopes } = require('../../lib/whatsappInboxScopes');

const scope = { assetId: 81, wabaId: '101', phoneId: '201', clinicIds: [71,72] };
const config = { version: 1, scopes: [scope] };
const now = Date.UTC(2026,9,1);
function packet() {
  return { receipt: randomUUID(), lease: randomUUID(), automaticActionsAllowed: false,
    scopeBindings: [{ wabaId: scope.wabaId, phoneId: scope.phoneId, clinicIds: [...scope.clinicIds] }],
    raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: scope.wabaId,
      changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: scope.phoneId },
        statuses: [{ id: 'wamid.synthetic', status: 'played', timestamp: String(now / 1000) }] } }] }] })) };
}
function change(work) {
  const lease = packet(); const body = JSON.parse(lease.raw); work(body.entry[0].changes[0].value);
  lease.raw = Buffer.from(JSON.stringify(body)); return lease;
}
test('only pure played batches use the passive ledger and the receiving number keeps its complete group scope', () => {
  assert.deepEqual(playbackScopes(packet(),config,now), [{ scope, count: 1 }]);
  for (const lease of [
    change(value => { value.statuses[0].status = 'read'; }),
    change(value => { value.messages = [{ type: 'text', text: { body: 'FICTITIOUS_REPLY' } }]; }),
    change(value => { value.messages = []; }),
  ]) assert.equal(playbackScopes(lease,config,now), null);
});
test('malformed, foreign, truncated and oversized played packets remain held', () => {
  const truncated = packet(); truncated.scopeBindings[0].clinicIds = [71];
  for (const lease of [truncated,
    change(value => { value.metadata.phone_number_id = '999'; }),
    change(value => { value.statuses[0].id = 'invalid'; }),
    change(value => { value.statuses[0].timestamp = String(now / 1000 + 301); }),
    change(value => { value.statuses = Array(2001).fill(value.statuses[0]); }),
    change(value => { value.history = []; }),
  ]) assert.throws(() => playbackScopes(lease,config,now), error => error.inboxReason === 'review_required');
});
