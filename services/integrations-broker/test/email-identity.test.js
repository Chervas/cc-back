'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/email-identity-contract');
const L = require('../src/email-limits');
const { binding } = require('./email-fixture.cjs');

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
});
