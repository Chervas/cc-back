'use strict';
const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const templates = require('../../services/emailTemplates.service');
const delivery = require('../../services/emailDelivery.service');
const provider = require('../../services/emailProvider.service');
const dispatch = require('../../services/marketingEmailDispatch.service');
const marketingEmail = require('../../services/marketingEmail.service');
const migration = require('../../../migrations/20260923120000-create-marketing-email-system');

test('marketing email migration creates globally owned domains and expands the stored sender header', async () => {
  const calls = [];
  const queryInterface = {
    async createTable(name, columns) { calls.push(['createTable', name, columns]); },
    async addIndex(table, fields, options) { calls.push(['addIndex', table, fields, options]); },
    async addColumn(table, column, definition) { calls.push(['addColumn', table, column, definition]); },
    async changeColumn(table, column, definition) { calls.push(['changeColumn', table, column, definition]); },
  };
  await migration.up(queryInterface, Sequelize);
  const ownerIndex = calls.find(call => call[0] === 'addIndex' && call[3]?.name === 'uq_email_sending_domain_owner');
  assert.deepEqual(ownerIndex?.[2], ['domain']);
  assert.equal(ownerIndex?.[3]?.unique, true);
  const senderHeader = calls.find(call => call[0] === 'changeColumn' && call[1] === 'EmailMessages' && call[2] === 'from_email');
  assert.equal(senderHeader?.[3]?.type?.options?.length, 512);
});

test('marketing renderer always adds one visible unsubscribe action and Clinicaclick attribution', () => {
  const rendered = templates.renderMarketingCampaign({
    subject: 'Novedades de la clínica',
    body_html: '<!doctype html><html><body><p>Hola {{nombre}}</p></body></html>',
    body_text: 'Hola {{nombre}}',
    unsubscribe_url: 'https://crm.example.test/email/baja?token=fictitious',
  });
  assert.equal((rendered.html.match(/Dejar de recibir estas comunicaciones/g) || []).length, 1);
  assert.equal((rendered.html.match(/Enviado con Clinicaclick/g) || []).length, 1);
  assert.match(rendered.text, /https:\/\/crm\.example\.test\/email\/baja/);
  assert.deepEqual(templates.missingTemplateVariables({ nombre: 'Ana' }, rendered.subject, rendered.html), []);
  assert.deepEqual(templates.missingTemplateVariables({}, rendered.html), ['nombre']);
});

test('contact variables are HTML-escaped while plain text remains readable', () => {
  const context = { nombre: '<img src=x onerror=alert(1)> Ana' };
  assert.equal(templates.replaceVars('<p>{{nombre}}</p>', context, { html: true }), '<p>&lt;img src=x onerror=alert(1)&gt; Ana</p>');
  assert.equal(templates.replaceVars('Hola {{nombre}}', context), 'Hola <img src=x onerror=alert(1)> Ana');
});

test('marketing outbox refuses a message without explicit consent or unsubscribe URL before touching storage', async () => {
  await assert.rejects(delivery.queueEmail({
    stream: 'marketing',
    templateKey: 'marketing.campaign',
    recipientEmail: 'qa@example.test',
    marketingConsent: true,
    templateContext: { body_html: '<p>QA</p>' },
  }), { code: 'email_marketing_consent_and_unsubscribe_required' });
});

test('real SES marketing cannot bypass the broker with local AWS credentials', async () => {
  await assert.rejects(provider.sendEmail({ stream: 'marketing' }, { env: {
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
    EMAIL_MARKETING_ENABLED: 'true',
    EMAIL_BROKER_ENABLED: 'false',
    EMAIL_AWS_ACCESS_KEY_ID: 'AKIAFICTITIOUS1234567',
    EMAIL_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS_EMAIL_SECRET_0123456789',
  } }), { code: 'email_marketing_broker_required', retryable: false });
});

test('campaign dispatch fails closed before reading recipients when the marketing provider is unavailable', async t => {
  t.mock.method(provider, 'publicConfig', () => ({
    provider: 'ses',
    enabled: true,
    marketingEnabled: true,
    brokerEnabled: false,
    brokerConfigured: false,
  }));
  t.mock.method(db.MarketingPatientListItem, 'count', async () => {
    assert.fail('recipient storage must not be read while the provider is unavailable');
  });
  await assert.rejects(dispatch.assertReady({
    id: 12,
    scope_type: 'clinic',
    clinica_id: 21,
  }), { code: 'marketing_email_provider_not_ready', status: 503 });
});

test('email suppression lookup includes the owning group as well as clinic and global scope', async t => {
  let capturedWhere = null;
  t.mock.method(db.EmailSuppression, 'findOne', async options => {
    capturedWhere = options.where;
    return null;
  });
  await delivery.findActiveSuppression({
    emailHash: 'a'.repeat(64),
    stream: 'marketing',
    clinicaId: 21,
    groupId: 8,
  });
  assert.deepEqual(capturedWhere.scope[Object.getOwnPropertySymbols(capturedWhere.scope)[0]], [
    'global',
    'clinic:21',
    'group:8',
  ]);
});

test('a SES domain already owned by another scope is rejected before provider access', async t => {
  t.mock.method(db.EmailSendingDomain, 'findOne', async () => ({ domain: 'clinic.example', scope_key: 'clinic:22' }));
  await assert.rejects(marketingEmail.addDomain({ scope: 'clinic', clinicIds: [21] }, {
    domain: 'clinic.example',
  }, 1), { code: 'email_domain_owned_by_another_scope', status: 409 });
});

test('SES DNS setup keeps the clinic root SPF untouched and gates senders on custom MAIL FROM', () => {
  const records = marketingEmail.dnsRecords('clinic.example', {
    dkimTokens: ['token_one'],
    mailFromDomain: 'bounce.clinic.example',
  });
  assert.deepEqual(records.filter(record => record.purpose === 'SPF'), [{
    type: 'TXT',
    name: 'bounce.clinic.example',
    value: 'v=spf1 include:amazonses.com ~all',
    purpose: 'SPF',
  }]);
  assert.deepEqual(records.filter(record => record.purpose === 'MAIL FROM'), [{
    type: 'MX',
    name: 'bounce.clinic.example',
    value: '10 feedback-smtp.eu-west-3.amazonses.com',
    purpose: 'MAIL FROM',
  }]);
  assert.equal(marketingEmail.serializeSender({
    status: 'active',
    verification_status: 'verified',
    domain: {
      verification_status: 'verified',
      dkim_status: 'verified',
      spf_status: 'verified',
      mail_from_status: 'pending',
    },
  }).ready, false);
});

test('a paused campaign holds already queued email jobs before rendering or provider access', async t => {
  const message = {
    id: 91,
    status: 'queued',
    related_type: 'marketing_bulk_send',
    metadata: { list_id: 12 },
  };
  t.mock.method(db.EmailMessage, 'findByPk', async () => message);
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => ({ id: 12, email_dispatch: { status: 'paused' } }));
  const result = await delivery.runEmailSendJob({ email_message_id: 91 }, { attempts: 1 });
  assert.equal(result.status, 'waiting');
  assert.equal(result.result.paused, true);
  assert.ok(result.nextRunAt instanceof Date);
});

test('email delivery materialization is idempotent and closes an email-only campaign once', async t => {
  let eventCount = 0;
  const state = { status: 'queued', email_message_id: 71, provider_message_id: null };
  const item = {
    id: 7,
    list_id: 3,
    paciente_id: 5,
    email: 'qa@example.test',
    status: 'ready',
    selected: true,
    channel_status: { email: state },
    get() { return { ...this, channel_status: this.channel_status }; },
    async update(patch) { Object.assign(this, patch); },
  };
  const list = {
    id: 3,
    criteria: { channels: ['email'] },
    email_dispatch: { status: 'awaiting_delivery' },
    async update(patch) { Object.assign(this, patch); },
  };
  t.mock.method(db.MarketingPatientListItem, 'findOne', async () => item);
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => [item]);
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(db.MarketingPatientContactEvent, 'create', async () => { eventCount += 1; });
  const message = { id: 71, status: 'sent', related_type: 'marketing_bulk_send', metadata: { list_id: 3, item_id: 7 }, provider_message_id: 'provider-71', sent_at: new Date() };
  assert.equal((await dispatch.materializeEmailMessage(message)).applied, true);
  assert.equal((await dispatch.materializeEmailMessage(message)).applied, false);
  assert.equal(eventCount, 1);
  assert.equal(list.status, 'completed');
  assert.equal(list.email_dispatch.status, 'completed');
});
