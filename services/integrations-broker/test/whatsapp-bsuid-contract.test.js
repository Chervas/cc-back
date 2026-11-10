'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../src/whatsapp-authorized-contract');
test('BSUID sends use the official recipient field, never a phone-shaped fallback or both addresses', () => {
    const message = { messaging_product: 'whatsapp', recipient_type: 'individual', recipient: 'ES.Fictitious123', type: 'text', text: { body: 'Fictitious response' } };
    assert.equal(C.validateMessage(message), message);
    for (const recipient of ['es.Fictitious123', 'ES.ENT.example', 'ES.', '34000000123', 'ES.' + 'A'.repeat(129), '<script>'])
        assert.throws(() => C.validateMessage({ ...message, recipient }), { code: 'invalid_request' });
    assert.throws(() => C.validateMessage({ ...message, to: '34000000123' }), { code: 'invalid_request' });
    assert.throws(() => C.validateMessage({ ...message, to: undefined }), { code: 'invalid_request' });
    const { recipient, ...byPhone } = message;
    assert.equal(C.validateMessage({ ...byPhone, to: '34000000123' }).to, '34000000123');
    assert.throws(() => C.validateMessage({ ...byPhone, to: 'ES.Fictitious123' }), { code: 'invalid_request' });
});
