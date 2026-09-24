'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/email-identity-contract');
const { createEmailIdentityHttp } = require('../src/email-identity-http');
const L = require('../src/email-limits');
const { binding, credentials } = require('./email-fixture.cjs');

test('identity management accepts only normalized domains and a marketing-enabled SES binding', () => {
  assert.deepEqual(contract.validate({ identityName: 'clinic.example', timeoutMs: 15000 }), {
    identityName: 'clinic.example',
    timeoutMs: 15000,
  });
  for (const identityName of ['Clinic.example', 'https://clinic.example', 'clinic', 'clinic.example/path']) {
    assert.throws(() => contract.validate({ identityName, timeoutMs: 15000 }), { code: 'invalid_request' });
  }
  const request = { assetRef: 'email:identity-management' };
  assert.doesNotThrow(() => contract.authorize({ request, binding: binding() }));
  const disabled = binding();
  disabled.email.templates = disabled.email.templates.filter(template => template !== 'marketing.campaign');
  assert.throws(() => contract.authorize({ request, binding: disabled }), { code: 'scope_denied' });
  assert.equal(L.isEmailOperation(L.OPERATIONS.IDENTITY_ENSURE), true);
});

test('identity projection exposes only verification material needed for DNS setup', () => {
  assert.deepEqual(contract.project({
    identityName: 'clinic.example',
    verificationStatus: 'SUCCESS',
    verifiedForSending: true,
    dkimStatus: 'SUCCESS',
    dkimTokens: ['token_one', 'token_two'],
    mailFromDomain: 'bounce.clinic.example',
    mailFromStatus: 'SUCCESS',
    privateProviderField: 'must-not-leak',
  }), {
    identityName: 'clinic.example',
    verificationStatus: 'success',
    verifiedForSending: true,
    dkimStatus: 'success',
    dkimTokens: ['token_one', 'token_two'],
    mailFromDomain: 'bounce.clinic.example',
    mailFromStatus: 'success',
  });
  assert.throws(() => contract.project({
    identityName: 'clinic.example',
    verificationStatus: 'SUCCESS',
    dkimStatus: 'SUCCESS',
    mailFromStatus: 'unexpected-provider-state',
  }), { code: 'provider_failed' });
});

test('ensuring an identity configures a scoped custom MAIL FROM before projecting DNS state', async () => {
  const commands = [];
  const http = createEmailIdentityHttp({ clientFactory: () => ({
    async send(command) {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'GetEmailIdentityCommand') {
        return {
          VerificationStatus: 'SUCCESS',
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS', Tokens: ['token_one'] },
          MailFromAttributes: { MailFromDomain: 'bounce.clinic.example', MailFromDomainStatus: 'SUCCESS' },
        };
      }
      return {};
    },
    destroy() {},
  }) });
  const result = await http({
    action: 'ensure',
    payload: { identityName: 'clinic.example', timeoutMs: 15000 },
    token: Buffer.from(JSON.stringify(credentials)),
  });
  assert.deepEqual(commands.map(command => command.name), [
    'CreateEmailIdentityCommand',
    'PutEmailIdentityMailFromAttributesCommand',
    'GetEmailIdentityCommand',
  ]);
  assert.deepEqual(commands[1].input, {
    EmailIdentity: 'clinic.example',
    MailFromDomain: 'bounce.clinic.example',
    BehaviorOnMxFailure: 'REJECT_MESSAGE',
  });
  assert.equal(result.mailFromStatus, 'success');
});
