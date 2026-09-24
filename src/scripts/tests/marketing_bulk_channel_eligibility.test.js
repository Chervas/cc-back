'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __testing } = require('../../services/marketingBulkSends.service');

test('email-only campaigns deduplicate by email even when a phone is present', () => {
  const key = __testing.buildItemDedupeKeyForChannels({
    channels: ['email'],
    name: 'Ana',
    phoneDigits: '34600000000',
    email: 'ANA@example.com',
  });

  assert.equal(key, 'email:ana@example.com');
});

test('changing a draft recipient from WhatsApp to email recalculates required fields', () => {
  const patch = __testing.buildItemChannelEligibilityPatch({
    name: 'Ana',
    phone: '+34600000000',
    email: null,
    status: 'ready',
    dispatch_status: null,
    sent_at: null,
  }, ['email']);

  assert.deepEqual(patch, {
    status: 'excluded_missing_required',
    reason: 'Faltan campos: email',
    exclusion_reason: 'missing_required',
    selected: false,
  });
});

test('a recipient excluded for missing phone becomes ready for an email-only campaign', () => {
  const patch = __testing.buildItemChannelEligibilityPatch({
    name: 'Ana',
    phone: null,
    email: 'ana@example.com',
    status: 'excluded_missing_required',
    dispatch_status: null,
    sent_at: null,
  }, ['email']);

  assert.deepEqual(patch, {
    status: 'ready',
    reason: 'Contacto listo para los destinos seleccionados',
    exclusion_reason: null,
    selected: true,
  });
});

test('channel changes never reopen opt-outs or already dispatched recipients', () => {
  assert.equal(__testing.buildItemChannelEligibilityPatch({
    name: 'Ana',
    email: 'ana@example.com',
    status: 'excluded_opt_out',
  }, ['email']), null);

  assert.equal(__testing.buildItemChannelEligibilityPatch({
    name: 'Ana',
    phone: '+34600000000',
    status: 'ready',
    dispatch_status: 'sent',
  }, ['whatsapp']), null);
});
