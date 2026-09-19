'use strict';
require('./fixtures/campaign_offline_runtime.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload } = require('../../services/googleConversionUploadBroker.service');
const legacy = require('../../services/googleDataManagerConversion.service');
const C = require('../../../services/integrations-broker/src/google-data-manager-contract');
const { createConfiguredGoogleAdsClient } = require('../../services/googleAdsBroker.service');
const now = Date.parse('2026-09-18T11:00:00.000Z');
const target = { customerId: '5992356722', loginCustomerId: '2863224233', destination: { conversionActionId: '456' } };
const base = { conversionAction: 'customers/5992356722/conversionActions/456', eventName: 'lead', eventSource: 'WEB',
  timestamp: new Date(now).toISOString(), eventId: 'fictitious-event', value: 12.5, currency: 'EUR', advertisingConsent: 'GRANTED',
  adUserData: 'GRANTED', adPersonalization: 'DENIED', clickId: { type: 'gclid', value: 'FICTITIOUS-CLICK' },
  userIdentifiers: [], enhancedPolicyDigest: null };
const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('CRM typed builder preserves 54 legacy bodies across click types, sources and separate Consent Mode signals', () => {
  let cases = 0;
  for (const eventSource of ['WEB', 'OTHER']) for (const type of ['gclid', 'gbraid', 'wbraid']) {
    for (const adUserData of [null, 'GRANTED', 'DENIED']) for (const adPersonalization of [null, 'GRANTED', 'DENIED']) {
      const input = { ...base, eventSource, adUserData, adPersonalization, clickId: { type, value: base.clickId.value } };
      const prior = legacy.buildDataManagerEventRequest({ customerId: target.customerId, loginCustomerId: target.loginCustomerId,
        conversionAction: input.conversionAction, eventSource, eventName: input.eventName, externalId: input.eventId,
        conversionDateTime: input.timestamp, value: input.value, currency: input.currency, [type]: input.clickId.value,
        consentStatus: adUserData, adPersonalizationStatus: adPersonalization });
      assert.deepEqual(C.body(C.OPERATIONS.ingest, buildPayload(input), target, commandId, now), prior); cases++;
    }
  }
  assert.equal(cases, 54);
});

test('only explicitly permitted email and phone hashes are projected; raw identity and extra user fields never enter the broker payload', () => {
  const identifiers = legacy.buildEnhancedConversionUserIdentifiers({ email: 'fictitious@example.invalid', phone: '+34600000000', permittedIdentifiers: ['email', 'phone'] });
  const payload = buildPayload({ ...base, clickId: null, userIdentifiers: identifiers, enhancedPolicyDigest: 'a'.repeat(64),
    userId: 'private-patient', ip: '203.0.113.1', pageUrl: 'https://example.invalid/private' });
  assert.deepEqual(payload.event.userIdentifiers.map(row => row.type), ['email', 'phone']);
  assert(payload.event.userIdentifiers.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  const body = C.body(C.OPERATIONS.ingest, payload, { ...target, destination: { ...target.destination,
    enhancedPolicy: { digest: 'a'.repeat(64), notBefore: '2026-09-18T10:00:00.000Z', expiresAt: '2026-09-19T00:00:00.000Z', permittedIdentifiers: ['email', 'phone'] } } }, commandId, now);
  assert.deepEqual(body.events[0].userData.userIdentifiers, identifiers);
  for (const value of ['fictitious@example.invalid', '+34600000000', 'private-patient', '203.0.113.1', 'https://example.invalid/private']) {
    assert(!JSON.stringify(payload).includes(value)); assert(!JSON.stringify(body).includes(value));
  }
  assert.throws(() => buildPayload({ ...base, userIdentifiers: identifiers, enhancedPolicyDigest: 'a'.repeat(64), adUserData: 'DENIED' }));
});

test('caller conversion identifiers, timestamps and advertising consent must satisfy the closed contract', () => {
  for (const patch of [{ eventId: '../patient' }, { timestamp: 'yesterday' }, { advertisingConsent: 'DENIED' },
    { conversionAction: 'customers/5992356722/conversionActions/0' }, { clickId: null }]) {
    assert.throws(() => buildPayload({ ...base, ...patch }));
  }
  const payload = buildPayload({ ...base, eventId: null });
  assert.equal(C.body(C.OPERATIONS.ingest, payload, target, commandId, now).events[0].transactionId, commandId);
});

test('cached signing transport rejects environment identity or endpoint changes before dispatching another command', () => {
  for (const key of ['GOOGLE_ADS_BROKER_ORIGIN', 'GOOGLE_ADS_BROKER_AUDIENCE', 'GOOGLE_ADS_BROKER_KEY_ID', 'GOOGLE_ADS_BROKER_KEY_FILE', 'GOOGLE_ADS_BROKER_CA_FILE']) {
    const env = { GOOGLE_ADS_BROKER_ORIGIN: 'https://broker.invalid', GOOGLE_ADS_BROKER_AUDIENCE: 'fictitious',
      GOOGLE_ADS_BROKER_KEY_ID: 'fictitious-key', GOOGLE_ADS_BROKER_KEY_FILE: '/fictitious/key', GOOGLE_ADS_BROKER_CA_FILE: '/fictitious/ca' };
    let dispatched = 0, created = 0;
    const client = createConfiguredGoogleAdsClient({ env, readPrivateFile: () => Buffer.from('FICTITIOUS'),
      createClient: () => { created++; return { execute: () => ++dispatched }; } });
    assert.equal(client.execute({}), 1); assert.equal(client.execute({}), 2); assert.equal(created, 1);
    env[key] += '-changed';
    assert.throws(() => client.execute({}), { code: 'broker_configuration_invalid' }); assert.equal(dispatched, 2);
  }
});
