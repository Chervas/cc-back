'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const {
  GOOGLE_DATA_MANAGER_SCOPE,
  buildDataManagerEventRequest,
  normalizeAndHashEmail,
  normalizeAndHashName,
  normalizePhoneE164,
  retrieveRequestStatus,
  uploadConversionEvent
} = require('../../services/googleDataManagerConversion.service');
const {
  classifyDiagnostics,
  reconcileGoogleDataManagerDiagnostics
} = require('../../services/googleDataManagerDiagnostics.service');
const { missingGoogleScopes } = require('../../services/googleAdsScopedRuntime.service');
const {
  __test: campaignOnboardingTest
} = require('../../controllers/campaignOnboarding.controller');

function testPayloadMappingAndHashing() {
  const payload = buildDataManagerEventRequest({
    customerId: '599-235-6722',
    conversionAction: 'customers/5992356722/conversionActions/7540337982',
    loginCustomerId: '286-322-4233',
    gclid: 'opaque-click-id',
    value: 12.5,
    currency: 'eur',
    conversionDateTime: '2026-07-12 10:30:00+02:00',
    externalId: 'lead-42',
    email: ' Patient.Name+campaign@gmail.com ',
    phone: '600 000 000',
    givenName: '  María-José ',
    familyName: ' O\'Connor ',
    regionCode: 'es',
    postalCode: '08018',
    eventName: 'lead',
    clientId: '123456789.1761581763',
    userId: 'patient-42',
    userProperties: {
      customer_type: 'new',
      customerValueBucket: 'high',
      additional_user_properties: { clinic_scope: '58' }
    },
    ip: '203.0.113.42',
    defaultPhoneCountryCode: '34',
    consentStatus: 'GRANTED'
  });

  assert.deepEqual(payload.destinations, [{
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '5992356722' },
    productDestinationId: '7540337982',
    loginAccount: { accountType: 'GOOGLE_ADS', accountId: '2863224233' }
  }]);
  assert.equal(payload.events[0].eventTimestamp, '2026-07-12T08:30:00.000Z');
  assert.equal(payload.events[0].transactionId, 'lead-42');
  assert.deepEqual(payload.events[0].adIdentifiers, { gclid: 'opaque-click-id' });
  assert.equal(payload.events[0].conversionValue, 12.5);
  assert.equal(payload.events[0].currency, 'EUR');
  assert.equal(payload.events[0].eventSource, 'WEB');
  assert.equal(payload.events[0].eventName, 'lead');
  assert.equal(payload.events[0].clientId, '123456789.1761581763');
  assert.equal(payload.events[0].userId, 'patient-42');
  assert.deepEqual(payload.events[0].consent, { adUserData: 'CONSENT_GRANTED' });
  assert.deepEqual(payload.events[0].userProperties, {
    customerType: 'NEW',
    customerValueBucket: 'HIGH',
    additionalUserProperties: [{ propertyName: 'clinic_scope', value: '58' }]
  });
  assert.equal(payload.encoding, 'HEX');
  assert.equal(payload.validateOnly, false);
  assert.equal(payload.events[0].userData.userIdentifiers.length, 3);
  assert.equal(payload.events[0].userData.userIdentifiers[0].emailAddress, normalizeAndHashEmail('patientname@gmail.com'));
  assert.equal(payload.events[0].userData.userIdentifiers[1].phoneNumber.length, 64);
  assert.deepEqual(payload.events[0].userData.userIdentifiers[2], {
    address: {
      givenName: normalizeAndHashName('maríajosé'),
      familyName: normalizeAndHashName('oconnor'),
      regionCode: 'ES',
      postalCode: '08018'
    }
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('Patient.Name'), false);
  assert.equal(serialized.includes('600 000 000'), false);
  assert.equal(serialized.includes('203.0.113.42'), false, 'No IP is sent in the EEA-safe payload');
  assert.equal(normalizePhoneE164('600 000 000', '34'), '+34600000000');
  assert.equal(normalizePhoneE164('+34600000000', null), '+34600000000');
  assert.equal(normalizePhoneE164('600000000', null), null, 'Local phones require an explicit country code');
}

function testAlternativeClickIdsAndGuards() {
  const gbraid = buildDataManagerEventRequest({
    customerId: '5992356722',
    conversionAction: '7540337982',
    gbraid: 'gbraid-value',
    conversionDateTime: new Date('2026-07-12T08:30:00Z')
  });
  assert.deepEqual(gbraid.events[0].adIdentifiers, { gbraid: 'gbraid-value' });
  assert.equal(Object.prototype.hasOwnProperty.call(gbraid, 'encoding'), false);

  const dryRun = buildDataManagerEventRequest({
    customerId: '5992356722',
    conversionAction: '7540337982',
    email: 'data-manager-validation@clinicaclick.invalid',
    conversionDateTime: new Date(),
    validateOnly: true
  });
  assert.equal(dryRun.validateOnly, true);
  assert.equal(dryRun.events[0].userData.userIdentifiers[0].emailAddress.length, 64);

  const userDataOnly = buildDataManagerEventRequest({
    customerId: '5992356722',
    conversionAction: '7540337982',
    phone: '+34600000000',
    conversionDateTime: new Date('2026-07-12T08:30:00Z')
  });
  assert.equal(Object.prototype.hasOwnProperty.call(userDataOnly.events[0], 'adIdentifiers'), false);
  assert.equal(userDataOnly.events[0].userData.userIdentifiers.length, 1);
  assert.equal(userDataOnly.encoding, 'HEX');

  assert.throws(
    () => buildDataManagerEventRequest({ customerId: '5992356722', conversionAction: '7540337982' }),
    (error) => error.code === 'NO_IDENTIFIERS_PROVIDED'
  );
}

async function testTransportContract() {
  let postCall = null;
  const result = await uploadConversionEvent({
    customerId: '5992356722',
    conversionAction: '7540337982',
    gclid: 'opaque-click-id',
    conversionDateTime: new Date('2026-07-12T08:30:00Z'),
    accessToken: 'scoped-token',
    quotaProjectId: 'clinicaclick-project',
    request: {
      async post(...args) {
        postCall = args;
        return { data: { requestId: 'dm-request-1' } };
      }
    }
  });
  assert.equal(postCall[0], 'https://datamanager.googleapis.com/v1/events:ingest');
  assert.equal(postCall[2].headers.Authorization, 'Bearer scoped-token');
  assert.equal(postCall[2].headers['x-goog-user-project'], 'clinicaclick-project');
  assert.equal(postCall[1].validateOnly, false);
  assert.equal(result.requestId, 'dm-request-1');

  let getCall = null;
  const status = await retrieveRequestStatus({
    accessToken: 'scoped-token',
    requestId: 'dm-request-1',
    quotaProjectId: 'clinicaclick-project',
    request: {
      async get(...args) {
        getCall = args;
        return { data: { requestStatusPerDestination: [] } };
      }
    }
  });
  assert.equal(getCall[0], 'https://datamanager.googleapis.com/v1/requestStatus:retrieve');
  assert.deepEqual(getCall[1].params, { requestId: 'dm-request-1' });
  assert.equal(getCall[1].headers['x-goog-user-project'], 'clinicaclick-project');
  assert.deepEqual(status.requestStatusPerDestination, []);

  await assert.rejects(
    uploadConversionEvent({ customerId: '5992356722', conversionAction: '7540337982', gclid: 'x' }),
    (error) => error.code === 'SCOPED_GOOGLE_DATA_MANAGER_CREDENTIAL_REQUIRED'
  );
}

function testDiagnosticsClassification() {
  assert.deepEqual(classifyDiagnostics({ requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] }).status, 'accepted');
  assert.deepEqual(classifyDiagnostics({ requestStatusPerDestination: [{ requestStatus: 'REQUEST_STATUS_UNKNOWN' }] }).status, 'accepted');
  assert.deepEqual(classifyDiagnostics({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] }).status, 'succeeded');
  assert.deepEqual(classifyDiagnostics({ requestStatusPerDestination: [{ requestStatus: 'FAILED' }] }).status, 'failed');
  assert.deepEqual(classifyDiagnostics({
    requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }, { requestStatus: 'FAILED' }]
  }).status, 'partial_success');
  assert.deepEqual(classifyDiagnostics({
    requestStatusPerDestination: [{ requestStatus: 'PARTIAL_SUCCESS' }]
  }).status, 'partial_success');
}

async function testDiagnosticsReconciliation() {
  const attempt = {
    id: 7,
    status: 'accepted',
    reason: 'provider_processing',
    providerRequestId: 'dm-request-1',
    googleConnectionId: 23,
    responseMetadata: { transport: 'google_data_manager' },
    history: [],
    attemptedAt: new Date('2026-07-12T08:00:00Z'),
    completedAt: null,
    async update(patch) {
      Object.assign(this, patch);
      return this;
    }
  };
  const result = await reconcileGoogleDataManagerDiagnostics({
    attemptModel: { async findAll() { return [attempt]; } },
    connectionModel: { async findByPk() { return { id: 23 }; } },
    ensureAccessToken: async (_connection, options) => {
      assert.deepEqual(options.requiredScopes, [GOOGLE_DATA_MANAGER_SCOPE]);
      return { accessToken: 'dm-token' };
    },
    retrieveStatus: async ({ accessToken, requestId }) => {
      assert.equal(accessToken, 'dm-token');
      assert.equal(requestId, 'dm-request-1');
      return {
        requestStatusPerDestination: [{
          requestStatus: 'SUCCESS',
          destination: {
            operatingAccount: { accountId: '5992356722' },
            productDestinationId: '7540337982'
          },
          eventsIngestionStatus: { recordCount: '1' }
        }]
      };
    },
    now: new Date('2026-07-12T09:00:00Z')
  });
  assert.equal(result.succeeded, 1);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.reason, null);
  assert.equal(attempt.responseMetadata.destinations[0].record_count, 1);
  assert.equal(attempt.completedAt.toISOString(), '2026-07-12T09:00:00.000Z');
}

function testScopeAndProvisioningContracts() {
  assert.deepEqual(missingGoogleScopes(
    'https://www.googleapis.com/auth/adwords',
    [GOOGLE_DATA_MANAGER_SCOPE]
  ), [GOOGLE_DATA_MANAGER_SCOPE]);
  assert.deepEqual(missingGoogleScopes(
    `https://www.googleapis.com/auth/adwords ${GOOGLE_DATA_MANAGER_SCOPE}`,
    [GOOGLE_DATA_MANAGER_SCOPE]
  ), []);

  assert.deepEqual(campaignOnboardingTest.buildClinicaclickManagedMapping([
    { id: 'client-lead', name: 'Formulario de contacto principal' },
    { id: 'cc-lead', name: 'Lead - ClinicaClick' },
    { id: 'cc-contact', name: 'Contact - ClinicaClick' }
  ]), {
    lead: 'cc-lead',
    contact: 'cc-contact',
    schedule: null,
    purchase: null
  });
  assert.deepEqual(campaignOnboardingTest.buildClinicaclickConversionActionCreate('lead', 'eur'), {
    name: 'Lead - ClinicaClick',
    category: 'SUBMIT_LEAD_FORM',
    type: 'UPLOAD_CLICKS',
    status: 'ENABLED',
    primaryForGoal: false,
    valueSettings: {
      defaultValue: 0,
      alwaysUseDefaultValue: false,
      defaultCurrencyCode: 'EUR'
    },
    countingType: 'MANY_PER_CLICK'
  });

  const uploader = fs.readFileSync(
    path.resolve(__dirname, '../../services/googleAdsConversionUpload.service.js'),
    'utf8'
  );
  assert.match(uploader, /uploadConversionEvent/);
  assert.doesNotMatch(uploader, /uploadClickConversion/);
  assert.match(uploader, /status: 'accepted'/);

  const onboarding = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  assert.match(onboarding, /buildClinicaclickManagedMapping/);
  assert.match(onboarding, /current\.clinicaclick_mapping/);
  assert.match(onboarding, /confirm_external_mutation/);
  assert.match(onboarding, /primaryForGoal: false/);
  assert.doesNotMatch(onboarding, /conversionActions:remove/);
}

async function run() {
  testPayloadMappingAndHashing();
  testAlternativeClickIdsAndGuards();
  await testTransportContract();
  testDiagnosticsClassification();
  await testDiagnosticsReconciliation();
  testScopeAndProvisioningContracts();
  console.log('google_data_manager_conversion.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
