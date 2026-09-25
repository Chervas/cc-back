'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/whatsapp-authorized-profile');

const authorizationId = 'a1234567-1234-4234-8234-123456789abc';
const binding = { connectionRef: 'wa:qa:profile' };
const definition = { authorizationId, phoneId: '401' };

test('authorized profile projects only bounded operational metadata', () => {
  assert.deepEqual(P.project({
    id: '401',
    status: 'CONNECTED',
    code_verification_status: 'VERIFIED',
    quality_rating: 'GREEN',
    is_on_biz_app: false,
    platform_type: 'CLOUD_API',
    display_phone_number: '+34 600 000 401',
    verified_name: 'Synthetic Clinic',
    private_field: 'must-not-escape',
  }), {
    id: '401',
    status: 'CONNECTED',
    codeVerificationStatus: 'VERIFIED',
    qualityRating: 'GREEN',
    isOnBizApp: false,
    platformType: 'CLOUD_API',
    displayPhoneNumber: '+34 600 000 401',
    verifiedName: 'Synthetic Clinic',
  });
  assert.throws(() => P.project({ id: '401', status: 'UNSUPPORTED' }), { code: 'provider_failed' });
  assert.throws(() => P.validate({ authorizationId, phoneId: '401', token: 'forbidden' }), { code: 'invalid_request' });
});

test('authorized profile reads the bound phone and rechecks the registry', async () => {
  const calls = [];
  let assertions = 0;
  let activeChecks = 0;
  const operation = P.operation({
    http: async input => {
      calls.push(input);
      return { id: '401', status: 'CONNECTED', code_verification_status: 'VERIFIED', quality_rating: 'GREEN' };
    },
    secrets: { proof: () => 'a'.repeat(64) },
    registry: {
      authorize: () => true,
      assert: () => { assertions++; return { definition }; },
    },
  });
  const result = await operation.execute({
    payload: { authorizationId, phoneId: '401' },
    binding,
    secret: Buffer.from('EAAB_SYNTHETIC_TOKEN_1234567890'),
    signal: undefined,
    assertActive: () => { activeChecks++; },
  });
  assert.equal(operation.effect, 'read');
  assert.equal(operation.persistResult, false);
  assert.equal(result.id, '401');
  assert.equal(result.status, 'CONNECTED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'profile');
  assert.equal(calls[0].id, '401');
  assert.equal(activeChecks, 2);
  assert.equal(assertions, 2);
});

