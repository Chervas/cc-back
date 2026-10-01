'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { scopeOf } = require('../../../services/integrations-broker/src/whatsapp-inbox');
const { splitLease } = require('../../lib/whatsappInboxScopes');
const { normalize } = require('../../lib/whatsappInboxImport');

const scope = { assetId: 81, wabaId: '101', phoneId: '201', clinicIds: [71] };
const config = { version: 1, scopes: [scope] };
const bindings = [{ wabaId: '101', phoneIds: ['201'] }];
const at = String(Math.floor(Date.now() / 1000));
const message = (type, extra = {}) => ({
  id: `wamid.synthetic_${type}`, from: '19995550101', timestamp: at, type, ...extra,
});
const change = (field, value) => ({ field, value });
const phoneValue = value => ({ messaging_product: 'whatsapp', metadata: { phone_number_id: '201' }, ...value });
const packet = (...changes) => Buffer.from(JSON.stringify({
  object: 'whatsapp_business_account', entry: [{ id: '101', changes }],
}));
const lease = raw => ({ receipt: randomUUID(), lease: randomUUID(), raw,
  automaticActionsAllowed: false, scopeBindings: [scope] });

test('known phone events have one scoped child and no account fallback', () => {
  const cases = [
    ['text', change('messages', phoneValue({ messages: [message('text', { text: { body: 'Synthetic reply' } })] }))],
    ['button', change('messages', phoneValue({ messages: [message('button', { button: { text: 'Synthetic choice' } })] }))],
    ['interactive', change('messages', phoneValue({ messages: [message('interactive', { interactive: { button_reply: { title: 'Synthetic choice' } } })] }))],
    ['image', change('messages', phoneValue({ messages: [message('image', { image: { id: '301', mime_type: 'image/jpeg' } })] }))],
    ['reaction', change('messages', phoneValue({ messages: [message('reaction', { reaction: { message_id: 'wamid.synthetic_old', emoji: '1' } })] }))],
    ['sent', change('messages', phoneValue({ statuses: [{ id: 'wamid.synthetic_outbound', status: 'sent' }] }))],
    ['delivered', change('messages', phoneValue({ statuses: [{ id: 'wamid.synthetic_outbound', status: 'delivered' }] }))],
    ['read', change('messages', phoneValue({ statuses: [{ id: 'wamid.synthetic_outbound', status: 'read' }] }))],
    ['failed', change('messages', phoneValue({ statuses: [{ id: 'wamid.synthetic_outbound', status: 'failed' }] }))],
    ['echo', change('smb_message_echoes', phoneValue({ message_echoes: [{ ...message('text', { text: { body: 'Synthetic echo' } }), to: '19995550101' }] }))],
    ['history', change('history', phoneValue({ history: [{ threads: [{ id: '19995550101', messages: [message('text', { text: { body: 'Synthetic history' } })] }] }] }))],
  ];
  for (const [name, item] of cases) {
    const raw = packet(item);
    assert.deepEqual(scopeOf(raw, bindings).scopes, ['101:201'], name);
    const parts = splitLease(lease(raw), config);
    assert.equal(parts.length, 1, name);
    const imported = normalize(Buffer.from(JSON.stringify(parts[0].packet)),
      { clinicId: 71, wabaId: '101', phoneId: '201' });
    assert.equal(imported.messages.length + imported.statuses.length, 1, name);
  }
});

test('account events are retained, and a mixed batch cannot partially import a patient reply', () => {
  const accountCases = [
    change('message_template_status_update', { message_template_id: '301', event: 'APPROVED' }),
    change('template_category_update', { message_template_id: '301', new_category: 'MARKETING' }),
    change('message_template_quality_update', { message_template_id: '301', new_quality_score: 'YELLOW' }),
    change('business_capability_update', { max_daily_conversation_per_phone: 1000 }),
    change('account_alerts', { alert_type: 'synthetic' }),
    change('phone_number_name_update', { phone_number_id: '201', status: 'synthetic' }),
  ];
  for (const item of accountCases) {
    const raw = packet(item);
    assert.deepEqual(scopeOf(raw, bindings).scopes, ['101:account'], item.field);
    assert.throws(() => splitLease(lease(raw), config), error => error.inboxReason === 'review_required', item.field);
    const mixed = packet(change('messages', phoneValue({ messages: [message('text', { text: { body: 'Synthetic reply' } })] })), item);
    assert.deepEqual(scopeOf(mixed, bindings).scopes, ['101:201', '101:account'], item.field);
    assert.throws(() => splitLease(lease(mixed), config), error => error.inboxReason === 'review_required', item.field);
  }
});

test('unsupported phone events and foreign provider scope are not acknowledged as clinical imports', () => {
  for (const type of ['edit', 'revoke']) {
    const raw = packet(change('messages', phoneValue({ messages: [message(type)] })));
    const [part] = splitLease(lease(raw), config);
    assert.throws(() => normalize(Buffer.from(JSON.stringify(part.packet)),
      { clinicId: 71, wabaId: '101', phoneId: '201' }), error => error.inboxReason === 'unsupported_event');
  }
  const played = packet(change('messages', phoneValue({ statuses: [{ id: 'wamid.synthetic_outbound', status: 'played' }] })));
  const [playedPart] = splitLease(lease(played), config);
  assert.throws(() => normalize(Buffer.from(JSON.stringify(playedPart.packet)),
    { clinicId: 71, wabaId: '101', phoneId: '201' }), error => error.inboxReason === 'unsupported_event');
  const stateSync = packet(change('smb_app_state_sync', phoneValue({ state_sync: [] })));
  assert.deepEqual(scopeOf(stateSync, bindings).scopes, ['101:201']);
  assert.throws(() => splitLease(lease(stateSync), config), error => error.inboxReason === 'review_required');
  assert.throws(() => scopeOf(packet(change('messages', {
    ...phoneValue({ messages: [message('text', { text: { body: 'Synthetic reply' } })] }),
    metadata: { phone_number_id: '999' },
  })), bindings), error => error.code === 'scope_denied');
  const foreign = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{
    id: '999', changes: [change('account_alerts', { alert_type: 'synthetic' })],
  }] }));
  assert.throws(() => scopeOf(foreign, bindings), error => error.code === 'scope_denied');
});
