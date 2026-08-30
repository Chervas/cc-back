'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../../models');
const emailEvents = require('../../services/emailEvents.service');

function patchProperty(object, key, value) {
  const previous = object[key];
  object[key] = value;
  return () => { object[key] = previous; };
}

test('gateway normalizeSesEvent acepta EventBridge SES y sanea resumen', () => {
  const event = emailEvents.normalizeSesEvent({
    version: '0',
    id: 'aws-event-gateway-1',
    source: 'aws.ses',
    'detail-type': 'Email Delivered',
    time: '2026-08-30T07:30:00Z',
    detail: {
      mail: {
        messageId: 'ses-message-gateway-1',
        timestamp: '2026-08-30T07:30:00Z',
        destination: ['persona@example.test'],
      },
      delivery: {
        processingTimeMillis: 321,
        smtpResponse: '250 OK persona@example.test +34 600 111 222',
      },
    },
  });

  assert.equal(event.provider, 'ses');
  assert.equal(event.providerEventId, 'aws-event-gateway-1');
  assert.equal(event.providerMessageId, 'ses-message-gateway-1');
  assert.equal(event.eventType, 'delivery');
  assert.equal(event.summary.destination_count, 1);
  assert.doesNotMatch(JSON.stringify(event.summary), /persona@example\.test/i);
  assert.doesNotMatch(JSON.stringify(event.summary), /600 111 222/);
});

test('gateway recordProviderEvent concilia rebote y crea supresion sin destinatario raw', async () => {
  const message = {
    id: 505,
    provider_message_id: 'ses-message-gateway-2',
    stream: 'transactional',
    clinica_id: 66,
    recipient_hash: 'recipient-hash',
    recipient_domain: 'example.test',
    event_count: 0,
    status: 'sent',
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  let suppressionRequest = null;
  const restores = [
    patchProperty(db.EmailMessage, 'findOne', async () => message),
    patchProperty(db.EmailProviderEvent, 'findOrCreate', async ({ defaults }) => ([
      { id: 606, ...defaults },
      true,
    ])),
    patchProperty(db.EmailSuppression, 'findOrCreate', async (request) => {
      suppressionRequest = request;
      return [{ id: 707, ...request.where, ...request.defaults }, true];
    }),
  ];
  try {
    const result = await emailEvents.recordProviderEvent({
      event_id: 'aws-event-gateway-2',
      event_type: 'Email Bounced',
      provider_message_id: 'ses-message-gateway-2',
      occurred_at: '2026-08-30T07:31:00Z',
      bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
    });
    assert.equal(result.created, true);
    assert.equal(result.suppression_id, 707);
    assert.equal(message.status, 'bounced');
    assert.equal(suppressionRequest.where.scope, 'clinic:66');
    assert.doesNotMatch(JSON.stringify(result), /persona@example\.test/i);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});
