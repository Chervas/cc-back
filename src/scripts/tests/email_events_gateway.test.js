'use strict';
require('./fixtures/email_models.fixture.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../../models');
const emailEvents = require('../../services/emailEvents.service');
const engagement = require('../../lib/marketing-email-engagement');

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

test('campaign engagement tags leave personalized and service links outside tracking', () => {
  const html = '<a href="https://example.test/menu?utm_campaign=noviembre">Menú</a>'
    + '<a href="https://example.test/pacientes/cuenta">Ficha</a>'
    + '<a href="https://example.test/reservar/{{codigo}}">Reserva</a>';
  const links = engagement.staticLinks(html);
  const [tracked] = [...links.values()];
  assert.deepEqual([...links.values()].map(({ url }) => url), ['https://example.test/menu']);
  const rendered = engagement.tagLinks(html, links, []);
  assert.match(rendered, new RegExp(`ses:tags="cc_link:${tracked.id};"`));
  assert.equal((rendered.match(/ses:no-track/g) || []).length, 2);
  assert.match(engagement.tagLinks(html, links, ['https://example.test/menu?utm_campaign=noviembre']),
    /href="https:\/\/example.test\/menu\?utm_campaign=noviembre" ses:no-track/);
  assert.equal(engagement.settings('ordinary', { EMAIL_MARKETING_ENGAGEMENT_CONFIGURATION_SET: 'ordinary' }), null);
  assert.equal(engagement.settings('ordinary', { EMAIL_MARKETING_ENGAGEMENT_CONFIGURATION_SET: 'campaign-engagement' }), 'campaign-engagement');
});

test('authenticated SES engagement records only mapped campaign links without rematerializing deliveries', async () => {
  const link = [...engagement.staticLinks('<a href="https://example.test/menu">Menú</a>').values()][0];
  const message = {
    id: 12, stream: 'marketing', related_type: 'marketing_bulk_send', status: 'delivered',
    metadata: { email_engagement: engagement.VERSION, engagement_links: { [link.id]: link.url } },
    update() { throw Error('An engagement event must leave delivery state alone'); },
  };
  const stored = new Map();
  const restores = [
    patchProperty(db.sequelize, 'transaction', async work => work({ LOCK: { UPDATE: 'UPDATE' } })),
    patchProperty(db.EmailMessage, 'findOne', async () => message),
    patchProperty(db.EmailProviderEvent, 'findOrCreate', async ({ where, defaults }) => {
      if (stored.has(where.provider_event_id)) return [stored.get(where.provider_event_id), false];
      stored.set(where.provider_event_id, defaults);
      return [defaults, true];
    }),
  ];
  try {
    const click = { event_id: 'engagement-click-1', event_type: 'Email Clicked', provider_message_id: 'mock-ses',
      engagementLinkTag: link.id, click: { link: 'https://example.test/email/baja?token=example', ipAddress: '192.0.2.10' } };
    assert.equal((await emailEvents.recordProviderEvent(click)).created, true);
    assert.equal((await emailEvents.recordProviderEvent(click)).created, false);
    assert.equal(stored.get(click.event_id).payload_summary.click_url, link.url);
    assert.doesNotMatch(JSON.stringify([...stored.values()]), /token=example|192\.0\.2\.10/);

    const open = { event_id: 'engagement-open-1', event_type: 'Email Opened', provider_message_id: 'mock-ses' };
    assert.equal((await emailEvents.recordProviderEvent({ ...open, engagementBot: 'Likely' })).created, false);
    assert.equal((await emailEvents.recordProviderEvent(open)).created, true);
    assert.equal((await emailEvents.recordProviderEvent({ ...click, event_id: 'foreign-tag', engagementLinkTag: 'a'.repeat(24) })).created, false);
    message.related_type = 'marketing_bulk_send_test';
    assert.equal((await emailEvents.recordProviderEvent({ ...open, event_id: 'test-open' })).created, false);
    assert.equal(stored.size, 2);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
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
    patchProperty(db.sequelize, 'transaction', async work => work({ LOCK: { UPDATE: 'UPDATE' } })),
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
