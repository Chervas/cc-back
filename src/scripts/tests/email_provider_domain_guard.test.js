'use strict';

// Actual provider module, fake SDK/broker only. No models, sockets, credentials
// or application bootstrap; environment values are wholly fictitious.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../services/emailProvider.service'), 'utf8');
const codes = ['whatsapp_appointment_nonoperational_clinic_held', 'review_communication_scope_unverified'];
function fixture(kind) {
  const state = { sends: 0, guards: 0, accepted: 0, order: [] };
  const fakeSdk = {
    SESv2Client: class { constructor(options) { assert.equal(options.maxAttempts, 1); }
      async send() { state.order.push('provider'); state.sends++; return { MessageId: 'FICTITIOUS_ACCEPTED' }; } },
    SendEmailCommand: class { constructor(input) { this.input = input; state.order.push('command'); } },
  };
  const modules = {
    '@aws-sdk/client-sesv2': fakeSdk,
    crypto: { randomUUID: () => { state.accepted++; return 'FAKE_MOCK_ONLY'; } },
    './emailBroker.service': { createEmailBroker: () => ({ send: async (_payload, options) => {
      state.order.push('admission'); await options.beforeDispatch();
      state.order.push('provider'); state.sends++;
      return { provider: 'ses', providerMessageId: 'FICTITIOUS_ACCEPTED', accepted: true };
    } }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: { env: {} }, AbortController, setTimeout, clearTimeout,
    require: name => { assert(Object.hasOwn(modules, name), 'Unexpected offline dependency: ' + name); return modules[name]; } },
  { filename: 'emailProvider.service.js' });
  const env = { EMAIL_PROVIDER: kind === 'mock' ? 'mock' : 'ses', EMAIL_ENABLED: 'true',
    EMAIL_MARKETING_ENABLED: 'true', EMAIL_RECIPIENT_ALLOWLIST: 'qa@example.invalid',
    EMAIL_AWS_ACCESS_KEY_ID: 'SYNTHETIC_NO_PROVIDER_ACCESS', EMAIL_AWS_SECRET_ACCESS_KEY: 'SYNTHETIC_NO_PROVIDER_ACCESS',
    EMAIL_BROKER_ENABLED: kind === 'broker' ? 'true' : 'false' };
  const message = { to: 'qa@example.invalid', from: 'QA <no-reply@example.invalid>', outboxId: 'FICTITIOUS_OUTBOX',
    deliveryAttempt: 1, stream: 'transactional', templateKey: 'automation.generic',
    subject: 'Offline QA', text: 'No real recipient or provider', html: '' };
  return { state, provider: module.exports, send: (beforeDispatch, overrides = {}, envChanges = {}) =>
    module.exports.sendEmail({ ...message, ...overrides }, { env: { ...env, ...envChanges }, beforeDispatch: beforeDispatch && (async () => {
      state.guards++; state.order.push('guard'); await beforeDispatch();
    }) }) };
}

for (const kind of ['mock', 'direct', 'broker']) {
  test(kind + ' invokes the final asynchronous domain guard before acceptance/transport and preserves no-retry holds', async () => {
    for (const code of codes) {
      const f = fixture(kind), expected = Object.assign(new Error(code), { code, retryable: false, statusCode: 403 });
      await assert.rejects(f.send(async () => { await Promise.resolve(); throw expected; }), error => {
        assert.equal(error, expected); assert.equal(error.code, code); assert.equal(error.retryable, false);
        assert.equal(f.provider.classifyProviderError(error).retryable, false); return true;
      });
      assert.equal(f.state.guards, 1); assert.equal(f.state.sends, 0); assert.equal(f.state.accepted, 0);
    }
  });

  test(kind + ' preserves ordinary authentication/reminder delivery and existing optional callback behavior', async () => {
    for (const templateKey of ['auth.email_verification', 'auth.password_reset', 'clinicaclick_recordatorio_mismo_dia_v1']) {
      const f = fixture(kind), result = await f.send(async () => {}, { templateKey });
      assert.equal(result.accepted, true); assert.equal(f.state.guards, 1);
      assert.equal(f.state.sends + f.state.accepted, 1);
      if (kind !== 'mock') assert(f.state.order.indexOf('guard') < f.state.order.indexOf('provider'));
    }
    const f = fixture(kind); assert.equal((await f.send(null)).accepted, true); assert.equal(f.state.guards, 0);
  });
}

test('broker never converts explicit clinic/scope vetoes to retryable guard-unavailable errors', async () => {
  for (const code of codes) {
    const f = fixture('broker');
    await assert.rejects(f.send(async () => { throw Object.assign(new Error(code), { code, retryable: true }); }),
      error => error.code === code && error.retryable === false);
    assert.equal(f.state.sends, 0);
  }
  const f = fixture('broker');
  await assert.rejects(f.send(async () => { throw Error('PRIVATE_UNEXPECTED_CLASSIFIER_ERROR'); }),
    error => error.code === 'email_delivery_guard_unavailable' && error.retryable === true && !error.message.includes('PRIVATE'));
  assert.equal(f.state.sends, 0);
});

test('globally disabled provider remains closed before guard, acceptance or dispatch', async () => {
  for (const kind of ['mock', 'direct', 'broker']) {
    const f = fixture(kind);
    await assert.rejects(f.send(async () => {}, {}, { EMAIL_ENABLED: 'false' }), { code: 'email_provider_disabled' });
    assert.equal(f.state.guards, 0); assert.equal(f.state.sends + f.state.accepted, 0);
  }
});
