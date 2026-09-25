'use strict';
const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SESv2Client } = require('@aws-sdk/client-sesv2');
const emailBroker = require('../../services/emailBroker.service');
const provider = require('../../services/emailProvider.service');
const delivery = require('../../services/emailDelivery.service');
const templates = require('../../services/emailTemplates.service');
const related = require('../../services/emailRelatedState.service');
const monitoring = require('../../services/emailMonitoring.service');
const { encryptEmailValue } = require('../../lib/emailSensitiveEnvelope');
const contract = require('../../../services/integrations-broker/src/email-contract');
const { payload, accepted } = require('../../../services/integrations-broker/test/email-fixture.cjs');

function brokerEnv() {
  return { EMAIL_BROKER_ENABLED: 'true', EMAIL_BROKER_ENVIRONMENT: 'staging', EMAIL_BROKER_CONNECTION_REF: 'email:staging',
    EMAIL_BROKER_AUDIENCE: 'clinicaclick:email:staging:v1', EMAIL_BROKER_ORIGIN: 'https://broker.example.test',
    EMAIL_BROKER_KEY_ID: 'qa-key', EMAIL_BROKER_KEY_FILE: '/fictitious/signing.key', EMAIL_BROKER_CA_FILE: '/fictitious/ca.crt' };
}

test('all five email templates keep exactly the same native SES input in broker mode, without reading provider credentials', async t => {
  const direct = { EMAIL_PROVIDER: 'ses', EMAIL_ENABLED: 'true', EMAIL_AWS_ACCESS_KEY_ID: 'FICTITIOUS_KEY',
    EMAIL_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS_SECRET', EMAIL_RECIPIENT_ALLOWLIST: 'qa@example.test' };
  const env = { ...direct, ...brokerEnv() }; let native, current;
  for (const name of ['EMAIL_AWS_ACCESS_KEY_ID', 'EMAIL_AWS_SECRET_ACCESS_KEY', 'EMAIL_AWS_SESSION_TOKEN']) {
    Object.defineProperty(env, name, { get() { assert.fail('local provider credential read'); } });
  }
  t.mock.method(SESv2Client.prototype, 'send', async command => { native = structuredClone(command.input); return { MessageId: 'fictitious-ses' }; });
  t.mock.method(emailBroker, 'createEmailBroker', () => ({ async send(p) { current = p; return accepted(); } }));
  const contexts = {
    'auth.email_verification': { verification_code: '123456' },
    'auth.password_reset': { reset_url: 'https://crm.example.test/reset-password?token=FICTITIOUS' },
    'ops.email_test': { body: 'Fictitious QA message' },
    'ops.system_alert': { message: 'Fictitious service state' },
    'automation.generic': { body_text: 'Fictitious conversation ñ 日本語 👍\n'.repeat(1200) },
  };
  for (const [templateKey, context] of Object.entries(contexts)) {
    const message = { to: 'qa@example.test', from: 'QA <no-reply@example.test>', replyTo: 'reply@example.test',
      outboxId: `em_${randomUUID()}`, deliveryAttempt: 4, stream: 'transactional', templateKey, ...templates.renderTemplate(templateKey, context) };
    await provider.sendEmail(message, { env: direct });
    await provider.sendEmail(message, { env });
    assert.equal(current.attempt, 4); assert.equal(current.recipientPolicy, 'allowlist');
    // Keep transactional payloads compatible with the deployed v2 broker,
    // which requires the marketing-only field to be explicitly null.
    assert.equal(current.identityName, null);
    assert.deepEqual(contract.commandInput(current), native);
  }
  assert.equal(provider.publicConfig(env).brokerEnabled, true);
  assert.equal(provider.publicConfig(env).accessKeyIdConfigured, false);
});

test('broker transport failures never become SES throttles, retries, or direct-key fallbacks', async () => {
  for (const code of ['rate_limited', 'provider_timeout', 'broker_timeout', 'broker_unavailable', 'provider_failed',
    'broker_response_invalid', 'secret_unavailable', 'audit_unavailable', 'outcome_unknown', 'idempotency_conflict']) {
    let calls = 0;
    const client = emailBroker.createEmailBroker({ env: brokerEnv(), readFile: () => Buffer.from('fictitious'),
      clientFactory: () => ({ async execute() { calls++; throw Object.assign(Error(code), { code, $metadata: { httpStatusCode: 429 } }); } }) });
    await assert.rejects(client.send(payload()), error => {
      const classified = provider.classifyProviderError(error);
      assert.equal(classified.code, 'email_provider_broker_unknown_outcome'); assert.equal(classified.retryable, false);
      assert.equal(related.isAmbiguousProviderOutcome(classified.code), true); return true;
    });
    assert.equal(calls, 1);
  }
});

test('stable attempt IDs survive process recreation and only a typed SES rejection permits retry', async () => {
  const p = payload(), commands = [];
  const factory = result => emailBroker.createEmailBroker({ env: brokerEnv(), readFile: () => Buffer.from('fictitious'),
    clientFactory: () => ({ async execute(command) { commands.push(command); return { data: result }; } }) });
  await factory(accepted()).send(p); await factory(accepted()).send(p);
  assert.equal(commands[0].requestId, commands[1].requestId);
  await factory(accepted()).send({ ...p, attempt: 2 }); assert.notEqual(commands[0].requestId, commands[2].requestId);
  await assert.rejects(factory({ accepted: false, code: 'email_ses_throttled', retryable: true }).send(p), { code: 'email_ses_throttled', retryable: true });
  for (const result of [{}, { accepted: true, providerMessageId: 'untyped' },
    { accepted: false, code: 'rate_limited', retryable: true }, { accepted: false, code: 'email_ses_throttled', retryable: false }]) {
    await assert.rejects(factory(result).send(p), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  }
});

test('broker configuration and payload fail closed before transport; enabling mock is not a fallback', async t => {
  for (const patch of [{ EMAIL_BROKER_ENABLED: 'false' }, { EMAIL_BROKER_ENVIRONMENT: 'gateway' },
    { EMAIL_BROKER_CONNECTION_REF: 'email:dev' }, { EMAIL_BROKER_AUDIENCE: 'foreign' }, { EMAIL_AWS_REGION: 'us-east-1' }]) {
    const client = emailBroker.createEmailBroker({ env: { ...brokerEnv(), ...patch }, readFile: () => assert.fail('invalid config read keys'), clientFactory: () => assert.fail('invalid config reached transport') });
    await assert.rejects(client.send(payload()));
  }
  const client = emailBroker.createEmailBroker({ env: brokerEnv(), readFile: () => assert.fail('invalid payload read keys') });
  await assert.rejects(client.send(payload({ attempt: undefined })), { code: 'email_broker_request_invalid' });
  t.mock.method(SESv2Client.prototype, 'send', () => assert.fail('no direct fallback'));
  await assert.rejects(provider.sendEmail({}, { env: { EMAIL_PROVIDER: 'mock', EMAIL_ENABLED: 'true', EMAIL_BROKER_ENABLED: 'true' } }), { code: 'email_broker_configuration_invalid' });
});

test('monitoring distinguishes broker configuration from absent local SES keys without claiming provider health', async t => {
  t.mock.method(db.EmailProviderEvent, 'findOne', async () => null);
  for (const model of [db.EmailMessage, db.EmailProviderEvent]) t.mock.method(model, 'findAll', async () => []);
  for (const model of [db.EmailMessage, db.EmailSuppression]) t.mock.method(model, 'count', async () => 0);
  let config = provider.publicConfig({ EMAIL_PROVIDER: 'ses', EMAIL_ENABLED: 'true', EMAIL_DATA_ENCRYPTION_KEY: 'FICTITIOUS_ENCRYPTION_KEY', ...brokerEnv() });
  t.mock.method(provider, 'publicConfig', () => config);
  let result = await monitoring.getOverview();
  assert.equal(result.provider.brokerConfigured, true);
  assert.equal(result.provider.accessKeyIdConfigured, false);
  assert(!result.alerts.some(alert => ['email_ses_credentials_missing', 'email_broker_configuration_missing'].includes(alert.key)));
  config = { ...config, brokerConfigured: false };
  result = await monitoring.getOverview();
  assert(result.alerts.some(alert => alert.key === 'email_broker_configuration_missing'));
  assert(!result.alerts.some(alert => alert.key === 'email_ses_credentials_missing'));
  config = { ...config, brokerEnabled: false };
  result = await monitoring.getOverview();
  assert(result.alerts.some(alert => alert.key === 'email_ses_credentials_missing'));
  assert(!JSON.stringify(result.provider).includes('FICTITIOUS_ENCRYPTION_KEY'));
});

test('durable outbox forwards claim attempt and retains a reset token on unknown broker outcome, without requeueing', async t => {
  const prior = process.env.EMAIL_DATA_ENCRYPTION_KEY;
  process.env.EMAIL_DATA_ENCRYPTION_KEY = 'FICTITIOUS_EMAIL_DATA_ENCRYPTION_KEY';
  t.after(() => { if (prior === undefined) delete process.env.EMAIL_DATA_ENCRYPTION_KEY; else process.env.EMAIL_DATA_ENCRYPTION_KEY = prior; });
  const publicId = `em_${randomUUID()}`, hash = delivery.hashEmail('qa@example.test'); let sends = 0;
  const message = { id: 123, public_id: publicId, stream: 'transactional', status: 'queued', related_type: 'password_reset_token',
    template_key: 'ops.email_test', template_context: {}, recipient_hash: hash, recipient_domain: 'example.test',
    recipient_email_envelope: encryptEmailValue('qa@example.test', `message:${publicId}:${hash}`),
    async update(patch) { Object.assign(this, patch); return this; } };
  t.mock.method(db.EmailMessage, 'findByPk', async () => message);
  t.mock.method(db.EmailMessage, 'update', async patch => { Object.assign(message, patch); return [1]; });
  t.mock.method(db.EmailSuppression, 'findOne', async () => null);
  t.mock.method(db.PasswordResetToken, 'update', async () => assert.fail('ambiguous send must not revoke the reset token'));
  t.mock.method(provider, 'sendEmail', async value => {
    sends++; assert.equal(value.deliveryAttempt, 3); assert.equal(value.outboxId, publicId);
    throw Object.assign(Error('email_provider_broker_unknown_outcome'), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  });
  const result = await delivery.runEmailSendJob({ email_message_id: 123 }, { attempts: 3 });
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
  assert.equal(message.status, 'failed'); assert.equal(message.rejected_at, null);
  const again = await delivery.runEmailSendJob({ email_message_id: 123 }, { attempts: 4 });
  assert.equal(again.result.already_terminal, true); assert.equal(sends, 1);
});

for (const scenario of ['suppressed', 'delivered']) test('outbox rechecks ' + scenario + ' after admission without sending or degrading a terminal event', async t => {
  const prior = process.env.EMAIL_DATA_ENCRYPTION_KEY;
  process.env.EMAIL_DATA_ENCRYPTION_KEY = 'FICTITIOUS_EMAIL_DATA_ENCRYPTION_KEY';
  t.after(() => { if (prior === undefined) delete process.env.EMAIL_DATA_ENCRYPTION_KEY; else process.env.EMAIL_DATA_ENCRYPTION_KEY = prior; });
  const id = `em_${randomUUID()}`, hash = delivery.hashEmail('qa@example.test'); let checks = 0;
  const message = { id: 124, public_id: id, stream: 'transactional', status: 'queued', template_key: 'ops.email_test',
    template_context: {}, recipient_hash: hash, recipient_domain: 'example.test',
    recipient_email_envelope: encryptEmailValue('qa@example.test', `message:${id}:${hash}`),
    async update(patch) { Object.assign(this, patch); return this; } };
  t.mock.method(db.EmailMessage, 'findByPk', async () => message);
  t.mock.method(db.EmailMessage, 'update', async patch => {
    if (!['queued', 'sending'].includes(message.status)) return [0];
    Object.assign(message, patch); return [1];
  });
  t.mock.method(db.EmailSuppression, 'findOne', async () => ++checks === 1 ? null : { status: 'active' });
  t.mock.method(provider, 'sendEmail', async (_value, options) => {
    if (scenario === 'delivered') { message.status = 'delivered'; message.provider_message_id = 'fictitious-event'; }
    await options.beforeDispatch(); assert.fail('stale outbox reached broker');
  });
  const result = await delivery.runEmailSendJob({ email_message_id: 124 }, { attempts: 1 });
  assert.equal(message.status, scenario); assert.equal(result.status, 'completed');
  assert.equal(result.result.email_status, scenario);
});
