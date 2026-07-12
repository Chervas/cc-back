'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const { buildBaseUrls } = require('../../lib/googleAdsClient');
const {
  assertSuccessfulUploadResponse,
  createConversionActions,
  uploadClickConversion
} = require('../../services/googleAdsConversion.service');
const {
  buildConversionActionResource,
  getGoogleAdsEventConfigs,
  hasRequestedActionOverride,
  maybeUploadGoogleConversion,
  normalizeGoogleConsent,
  prepareAuditRow,
  requestedTargetMismatchesConfig,
  resolveUserDataPolicy,
  selectConfiguredEventConfigs
} = require('../../services/googleAdsConversionUpload.service');
const {
  resolveScopedGoogleAdsRuntime
} = require('../../services/googleAdsScopedRuntime.service');
const {
  mergeGoogleAdsConfig,
  normalizeGoogleAdsConfig,
  resolveEffectiveTrackingConfig
} = require('../../services/effectiveMarketingAssets.service');

class FakeAuditModel {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }

  async findOne({ where }) {
    return this.rows.get(where.dedupeKey) || null;
  }

  async create(values) {
    const row = {
      id: this.nextId++,
      ...values,
      async update(patch) {
        Object.assign(this, patch);
        return this;
      }
    };
    this.rows.set(values.dedupeKey, row);
    return row;
  }
}

const scopedConfig = {
  enabled: true,
  customer_id: '599-235-6722',
  config_source: 'group',
  events: {
    lead: {
      enabled: true,
      conversion_action_id: '7540337982',
      currency: 'EUR'
    }
  }
};

const multiDestinationConfig = {
  enabled: true,
  currency: 'EUR',
  config_source: 'group',
  events: {
    lead: {
      enabled: true,
      destinations: [
        {
          key: 'propdental_parallel_185',
          enabled: true,
          customer_id: '185-121-5478',
          conversion_action_id: '7680195320',
          campaign_ids: ['1111111111'],
          currency: 'EUR'
        },
        {
          key: 'propdental_main_599',
          enabled: true,
          customer_id: '599-235-6722',
          conversion_action_id: '7540337982',
          campaign_ids: ['2222222222'],
          currency: 'EUR'
        }
      ]
    }
  }
};

function baseUploadInput(overrides = {}) {
  return {
    googleAdsConfig: scopedConfig,
    eventName: 'Lead',
    customData: { gclid: 'secret-click-id' },
    userData: { email: 'patient@example.com', phone: '+34600000000' },
    consent: { ad_user_data: 'granted' },
    eventId: 'lead-42',
    clinicId: 58,
    groupId: 5,
    assignmentScope: 'group',
    ...overrides
  };
}

async function testScopedRuntime() {
  let resolverInput = null;
  let accountQuery = null;
  const connection = { id: 23, scopes: 'https://www.googleapis.com/auth/adwords' };
  const account = {
    loginCustomerId: '286-322-4233',
    managerCustomerId: null
  };
  const runtime = await resolveScopedGoogleAdsRuntime({
    userId: 1,
    clinicId: 58,
    groupId: 5,
    assignmentScope: 'group',
    customerId: '599-235-6722',
    resolver: async (input) => {
      resolverInput = input;
      return {
        connection,
        assignment: { id: 4 },
        source: 'scope_assignment_group',
        scope: { clinicId: null, groupId: 5, assignmentScope: 'group' }
      };
    },
    accountModel: {
      async findOne(query) {
        accountQuery = query;
        return account;
      }
    },
    ensureAccessToken: async (resolvedConnection) => {
      assert.equal(resolvedConnection, connection);
      return { accessToken: 'scoped-access-token' };
    }
  });

  assert.equal(resolverInput.allowLegacyUserFallback, false);
  assert.equal(accountQuery.where.googleConnectionId, 23);
  assert.equal(accountQuery.where.customerId, '5992356722');
  assert.equal(runtime.accessToken, 'scoped-access-token');
  assert.equal(runtime.loginCustomerId, '2863224233');
  assert.equal(runtime.connectionSource, 'scope_assignment_group');
}

async function testConcurrentAuditClaimIsFailClosed() {
  const concurrentRow = { id: 91, status: 'pending', attemptedAt: new Date() };
  let findCalls = 0;
  const result = await prepareAuditRow({
    auditModel: {
      async findOne() {
        findCalls += 1;
        return findCalls === 1 ? null : concurrentRow;
      },
      async create() {
        const error = new Error('duplicate');
        error.name = 'SequelizeUniqueConstraintError';
        throw error;
      }
    },
    values: { dedupeKey: 'same-dedupe-key' },
    status: 'pending'
  });
  assert.equal(result.row, concurrentRow);
  assert.equal(result.inProgress, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.collision, true);
}

async function testLowLevelUploadRequiresScopedToken() {
  await assert.rejects(
    uploadClickConversion({ customerId: '5992356722' }),
    (error) => error.code === 'SCOPED_GOOGLE_CREDENTIAL_REQUIRED'
  );

  let captured = null;
  const result = await uploadClickConversion({
    customerId: '5992356722',
    conversionAction: 'customers/5992356722/conversionActions/7540337982',
    gclid: 'raw-click-id',
    conversionDateTime: '2026-07-11 00:00:00+00:00',
    accessToken: 'scoped-token',
    loginCustomerId: '2863224233',
    request: async (...args) => {
      captured = args;
      return { results: [{ gclidDateTimePair: {} }] };
    }
  });
  assert.equal(captured[0], 'POST');
  assert.equal(captured[1], 'customers/5992356722:uploadClickConversions');
  assert.equal(captured[2].accessToken, 'scoped-token');
  assert.equal(captured[2].loginCustomerId, '2863224233');
  assert.equal(captured[2].singleAttempt, true);
  assert.equal(captured[2].timeoutMs, 10000);
  assert.equal(captured[2].data.validateOnly, false);
  assert.equal(result.results.length, 1);

  assert.throws(
    () => assertSuccessfulUploadResponse({ partialFailureError: { message: 'Rejected' } }),
    (error) => error.code === 'GOOGLE_ADS_PARTIAL_FAILURE'
  );
}

async function testConversionActionCreationRequiresScopedToken() {
  await assert.rejects(
    createConversionActions({ customerId: '5992356722', actions: [] }),
    (error) => error.code === 'SCOPED_GOOGLE_CREDENTIAL_REQUIRED'
  );
  let captured = null;
  await createConversionActions({
    customerId: '5992356722',
    actions: [{ name: 'Lead - test' }],
    accessToken: 'scoped-token',
    loginCustomerId: '2863224233',
    validateOnly: true,
    request: async (...args) => {
      captured = args;
      return { results: [] };
    }
  });
  assert.equal(captured[1], 'customers/5992356722/conversionActions:mutate');
  assert.equal(captured[2].accessToken, 'scoped-token');
  assert.equal(captured[2].loginCustomerId, '2863224233');
  assert.equal(captured[2].singleAttempt, true);
  assert.equal(captured[2].timeoutMs, 10000);
  assert.equal(captured[2].data.validateOnly, true);
}

async function testAuditedUploadAndIdempotency() {
  const auditModel = new FakeAuditModel();
  let runtimeCalls = 0;
  let uploadCalls = 0;
  let uploadPayload = null;
  const dependencies = {
    auditModel,
    resolveRuntime: async (input) => {
      runtimeCalls += 1;
      assert.deepEqual(input, {
        clinicId: 58,
        groupId: 5,
        assignmentScope: 'group',
        customerId: '5992356722',
        requiredScopes: ['https://www.googleapis.com/auth/datamanager']
      });
      return {
        accessToken: 'scoped-token',
        loginCustomerId: '2863224233',
        connection: { id: 23 },
        assignment: { id: 4 },
        connectionSource: 'scope_assignment_group'
      };
    },
    uploadConversion: async (payload) => {
      uploadCalls += 1;
      uploadPayload = payload;
      return { requestId: 'request-1' };
    }
  };

  const first = await maybeUploadGoogleConversion({
    ...baseUploadInput(),
    dependencies
  });
  assert.equal(first.sent, true);
  assert.equal(first.accepted, true);
  assert.equal(runtimeCalls, 1);
  assert.equal(uploadCalls, 1);
  assert.equal(uploadPayload.accessToken, 'scoped-token');
  assert.equal(uploadPayload.loginCustomerId, '2863224233');
  assert.equal(uploadPayload.customerId, '5992356722');
  assert.equal(uploadPayload.gclid, 'secret-click-id');
  assert.equal(uploadPayload.eventName, 'lead');
  assert.equal(uploadPayload.email, undefined);
  assert.equal(uploadPayload.phone, undefined);
  assert.equal(uploadPayload.clientId, undefined);
  assert.equal(uploadPayload.userId, undefined);
  assert.equal(uploadPayload.conversionAction, 'customers/5992356722/conversionActions/7540337982');

  const row = Array.from(auditModel.rows.values())[0];
  assert.equal(row.status, 'accepted');
  assert.equal(row.googleConnectionId, 23);
  assert.equal(row.googleConnectionAssignmentId, 4);
  assert.equal(row.consentStatus, 'GRANTED');
  assert.equal(row.providerRequestId, 'request-1');
  assert.equal(row.clickIdHash.length, 64);
  assert.notEqual(row.clickIdHash, 'secret-click-id');
  assert.equal(row.requestMetadata.user_data_policy, 'blocked_healthcare');
  assert.equal(row.requestMetadata.user_data_sent, false);
  assert.equal(JSON.stringify(row).includes('patient@example.com'), false);

  const duplicate = await maybeUploadGoogleConversion({
    ...baseUploadInput(),
    dependencies
  });
  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.reason, 'duplicate_already_accepted');
  assert.equal(uploadCalls, 1, 'A provider-accepted event must never be uploaded twice');
  assert.equal(runtimeCalls, 1, 'A duplicate must not refresh or resolve OAuth again');
}

async function testHealthcareUserDataIsBlocked() {
  const auditModel = new FakeAuditModel();
  let runtimeCalls = 0;
  let uploadCalls = 0;
  const input = {
    ...baseUploadInput({
      googleAdsConfig: { ...scopedConfig, user_data_enabled: true },
      customData: { client_id: '123456789.1761581763' },
      userData: {
        email: 'patient@example.com',
        phone: '+34600000000',
        givenName: 'Ana',
        familyName: 'García',
        regionCode: 'ES',
        postalCode: '08018',
        userId: 'patient-42'
      },
      eventId: 'lead-user-data-only-42'
    }),
    dependencies: {
      auditModel,
      resolveRuntime: async () => { runtimeCalls += 1; },
      uploadConversion: async () => { uploadCalls += 1; }
    }
  };

  assert.deepEqual(resolveUserDataPolicy({ user_data_enabled: true }, {}), {
    enabled: false,
    requested: true,
    reason: 'blocked_healthcare'
  });
  const blocked = await maybeUploadGoogleConversion(input);
  assert.equal(blocked.sent, false);
  assert.equal(blocked.reason, 'no_permitted_identifiers');
  assert.equal(runtimeCalls, 0);
  assert.equal(uploadCalls, 0);
  const row = Array.from(auditModel.rows.values())[0];
  assert.equal(row.status, 'skipped');
  assert.equal(row.clickIdType, null);
  assert.equal(row.clickIdHash, null);
  assert.equal(row.requestMetadata.user_identifier_count, 0);
  assert.equal(row.requestMetadata.has_address, false);
  assert.equal(row.requestMetadata.user_data_policy, 'blocked_healthcare');
  assert.equal(row.requestMetadata.user_data_requested, true);
  assert.equal(row.requestMetadata.user_data_sent, false);
  assert.equal(JSON.stringify(row).includes('patient@example.com'), false);
}

async function testConsentAndTargetGuards() {
  const deniedAudit = new FakeAuditModel();
  let called = false;
  const denied = await maybeUploadGoogleConversion({
    ...baseUploadInput({ consent: { ad_user_data: 'denied' }, allowUpload: false }),
    dependencies: {
      auditModel: deniedAudit,
      resolveRuntime: async () => { called = true; },
      uploadConversion: async () => { called = true; }
    }
  });
  assert.equal(denied.reason, 'consent_not_granted');
  assert.equal(called, false);
  assert.equal(Array.from(deniedAudit.rows.values())[0].status, 'skipped');

  const mismatchAudit = new FakeAuditModel();
  const mismatch = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      customData: { gclid: 'secret-click-id', customer_id: '1112223333' }
    }),
    dependencies: {
      auditModel: mismatchAudit,
      resolveRuntime: async () => { throw new Error('must not resolve'); },
      uploadConversion: async () => { throw new Error('must not upload'); }
    }
  });
  assert.equal(mismatch.reason, 'request_customer_not_configured');
  assert.equal(mismatchAudit.rows.size, 0);

  const overrideAudit = new FakeAuditModel();
  const override = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      customData: {
        gclid: 'secret-click-id',
        conversion_action_id: '7540337982'
      }
    }),
    dependencies: {
      auditModel: overrideAudit,
      resolveRuntime: async () => { throw new Error('must not resolve'); },
      uploadConversion: async () => { throw new Error('must not upload'); }
    }
  });
  assert.equal(override.reason, 'request_target_override_not_allowed');
  assert.equal(overrideAudit.rows.size, 1);
}

function testAdvertisingConsentNormalizationKeepsPurposesSeparate() {
  assert.equal(normalizeGoogleConsent({ analytics: true }), null);
  assert.equal(normalizeGoogleConsent({ ad_storage: 'granted' }), null);
  assert.equal(normalizeGoogleConsent({ analytics: 'granted', contact: true, phone: true }), null);
  assert.equal(normalizeGoogleConsent({ value: 'granted' }), null);
  assert.equal(normalizeGoogleConsent({ marketing: true, analytics: false }), 'GRANTED');
  assert.equal(normalizeGoogleConsent({ marketing: false, analytics: true }), 'DENIED');
  assert.equal(normalizeGoogleConsent({ ad_user_data: 'granted' }), 'GRANTED');
  assert.equal(normalizeGoogleConsent({ adUserData: 'denied', marketing: true }), 'DENIED');
  assert.equal(normalizeGoogleConsent('granted'), 'GRANTED');
}

async function testConsentModeRequiresPerVisitorAdvertisingConsent() {
  let caseIndex = 0;
  const runCase = async ({
    label,
    consent,
    consentModeEnabled,
    expectedSent,
    expectedStatus,
    googleAdsConfig = scopedConfig
  }) => {
    caseIndex += 1;
    const auditModel = new FakeAuditModel();
    let runtimeCalls = 0;
    let uploadCalls = 0;
    const result = await maybeUploadGoogleConversion({
      ...baseUploadInput({
        cfgRecord: {
          id: 90 + caseIndex,
          clinic_id: 58,
          group_id: 5,
          assignment_scope: 'group',
          config: { features: { consent_mode_enabled: consentModeEnabled } }
        },
        googleAdsConfig,
        consent,
        consentModeEnabled,
        eventId: `lead-consent-case-${caseIndex}`
      }),
      dependencies: {
        auditModel,
        resolveRuntime: async () => {
          runtimeCalls += 1;
          return {
            accessToken: 'scoped-token',
            loginCustomerId: '2863224233',
            connection: { id: 23 },
            assignment: { id: 4 },
            connectionSource: 'scope_assignment_group'
          };
        },
        uploadConversion: async () => {
          uploadCalls += 1;
          return { requestId: `request-consent-${caseIndex}` };
        }
      }
    });

    assert.equal(result.sent, expectedSent, label);
    assert.equal(runtimeCalls, expectedSent ? 1 : 0, `${label}: runtime`);
    assert.equal(uploadCalls, expectedSent ? 1 : 0, `${label}: upload`);
    const audit = Array.from(auditModel.rows.values())[0];
    assert.equal(audit.consentStatus, expectedStatus, `${label}: audit consent`);
    if (!expectedSent) assert.equal(result.reason, 'consent_not_granted', `${label}: reason`);
  };

  await runCase({
    label: 'Consent Mode on must ignore legacy analytics consent',
    consent: { analytics: true },
    consentModeEnabled: true,
    expectedSent: false,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode on requires marketing or ad_user_data instead of ad_storage alone',
    consent: { ad_storage: 'granted' },
    consentModeEnabled: true,
    expectedSent: false,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode on requires a named advertising purpose',
    consent: 'granted',
    consentModeEnabled: true,
    expectedSent: false,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode on must keep contact permission separate',
    consent: { contact: true, phone: true, whatsapp: true },
    consentModeEnabled: true,
    expectedSent: false,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode on must fail closed when consent is absent',
    consent: null,
    consentModeEnabled: true,
    expectedSent: false,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode on accepts explicit marketing permission',
    consent: { marketing: true },
    consentModeEnabled: true,
    expectedSent: true,
    expectedStatus: 'GRANTED'
  });
  await runCase({
    label: 'Consent Mode on accepts explicit ad_user_data permission',
    consent: { ad_user_data: 'granted' },
    consentModeEnabled: true,
    expectedSent: true,
    expectedStatus: 'GRANTED'
  });
  await runCase({
    label: 'Any explicit advertising denial wins over a grant',
    consent: { marketing: true, ad_user_data: 'denied' },
    consentModeEnabled: true,
    expectedSent: false,
    expectedStatus: 'DENIED'
  });
  await runCase({
    label: 'Static legacy consent cannot replace visitor consent',
    consent: null,
    consentModeEnabled: true,
    googleAdsConfig: { ...scopedConfig, consent: 'granted' },
    expectedSent: false,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode off preserves legacy analytics-only uploads',
    consent: { analytics: true },
    consentModeEnabled: false,
    expectedSent: true,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode off preserves uploads without consent payload',
    consent: null,
    consentModeEnabled: false,
    expectedSent: true,
    expectedStatus: 'UNSPECIFIED'
  });
  await runCase({
    label: 'Consent Mode off preserves scalar legacy advertising consent',
    consent: 'granted',
    consentModeEnabled: false,
    expectedSent: true,
    expectedStatus: 'GRANTED'
  });
  await runCase({
    label: 'Explicit marketing denial is respected with Consent Mode off',
    consent: { marketing: false },
    consentModeEnabled: false,
    expectedSent: false,
    expectedStatus: 'DENIED'
  });
}

async function testFailedUploadIsAudited() {
  const auditModel = new FakeAuditModel();
  const providerError = new Error('Provider rejected secret-click-id for patient@example.com');
  providerError.code = 'PROVIDER_REJECTED';
  await assert.rejects(
    maybeUploadGoogleConversion({
      ...baseUploadInput(),
      dependencies: {
        auditModel,
        resolveRuntime: async () => ({
          accessToken: 'scoped-token',
          loginCustomerId: null,
          connection: { id: 23 },
          assignment: { id: 4 },
          connectionSource: 'scope_assignment_group'
        }),
        uploadConversion: async () => { throw providerError; }
      }
    }),
    (error) => error === providerError
  );
  const row = Array.from(auditModel.rows.values())[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.reason, 'provider_error');
  assert.equal(row.lastErrorCode, 'PROVIDER_REJECTED');
  assert.equal(row.lastErrorMessage.includes('secret-click-id'), false);
  assert.equal(row.lastErrorMessage.includes('patient@example.com'), false);
}

function createMultiDestinationDependencies({ auditModel, failCustomers = new Set() }) {
  const runtimeInputs = [];
  const uploadPayloads = [];
  return {
    runtimeInputs,
    uploadPayloads,
    dependencies: {
      auditModel,
      resolveRuntime: async (input) => {
        runtimeInputs.push(input);
        return {
          accessToken: `scoped-token-${input.customerId}`,
          loginCustomerId: '2863224233',
          connection: { id: 23 },
          assignment: { id: input.customerId === '1851215478' ? 41 : 42 },
          connectionSource: 'scope_assignment_group'
        };
      },
      uploadConversion: async (payload) => {
        uploadPayloads.push(payload);
        if (failCustomers.has(payload.customerId)) {
          const error = new Error(`Provider rejected ${payload.gclid} for ${payload.email}`);
          error.code = `REJECTED_${payload.customerId}`;
          throw error;
        }
        return { requestId: `request-${payload.customerId}` };
      }
    }
  };
}

async function testMultiDestinationSuccessAndDedupe() {
  const configs = getGoogleAdsEventConfigs(multiDestinationConfig, 'Lead');
  assert.equal(configs.length, 2);
  assert.deepEqual(configs.map((item) => item.customer_id), ['1851215478', '5992356722']);
  assert.deepEqual(configs.map((item) => item.destination_key), [
    'propdental_parallel_185',
    'propdental_main_599'
  ]);
  const equivalentTargets = getGoogleAdsEventConfigs({
    enabled: true,
    events: {
      lead: {
        destinations: [
          {
            key: 'resource_form',
            customer_id: '5992356722',
            conversion_action: 'customers/5992356722/conversionActions/7540337982'
          },
          {
            key: 'id_form',
            customer_id: '5992356722',
            conversion_action_id: '7540337982'
          }
        ]
      }
    }
  }, 'lead');
  assert.equal(equivalentTargets.length, 1, 'Equivalent action representations must not create two uploads');
  assert.equal(selectConfiguredEventConfigs(configs, {}).reason, 'ambiguous_destination');
  assert.deepEqual(
    selectConfiguredEventConfigs(configs, { customer_id: '185-121-5478' }).configs.map((item) => item.customer_id),
    ['1851215478']
  );

  const auditModel = new FakeAuditModel();
  const harness = createMultiDestinationDependencies({ auditModel });
  const first = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      customData: { gclid: 'secret-click-id', customer_id: '185-121-5478' }
    }),
    dependencies: harness.dependencies
  });

  assert.equal(first.sent, true);
  assert.equal(first.partial, false);
  assert.equal(first.destination_count, 1);
  assert.equal(first.sent_count, 1);
  assert.equal(first.failed_count, 0);
  assert.equal(first.skipped_count, 0);
  assert.deepEqual(harness.runtimeInputs.map((item) => item.customerId), ['1851215478']);
  assert.deepEqual(harness.uploadPayloads.map((item) => item.customerId), ['1851215478']);
  assert.deepEqual(harness.uploadPayloads.map((item) => item.accessToken), ['scoped-token-1851215478']);

  const rows = Array.from(auditModel.rows.values());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((row) => row.destinationKey), ['propdental_parallel_185']);
  assert.deepEqual(rows.map((row) => row.status), ['accepted']);

  const duplicate = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      customData: { gclid: 'secret-click-id', customer_id: '185-121-5478' }
    }),
    dependencies: harness.dependencies
  });
  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.sent_count, 0);
  assert.equal(duplicate.skipped_count, 1);
  assert.deepEqual(duplicate.destinations.map((item) => item.reason), ['duplicate_already_accepted']);
  assert.equal(harness.runtimeInputs.length, 1, 'Dedupe must be checked before resolving the selected account again');
  assert.equal(harness.uploadPayloads.length, 1, 'The selected target must upload at most once');
}

async function testMultiDestinationCampaignSelector() {
  const auditModel = new FakeAuditModel();
  const harness = createMultiDestinationDependencies({ auditModel });
  const result = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      eventId: 'lead-campaign-selected-42',
      customData: { gclid: 'secret-click-id', campaign_id: '2222222222' }
    }),
    dependencies: harness.dependencies
  });

  assert.equal(result.sent, true);
  assert.equal(result.accepted, true);
  assert.equal(result.partial, false);
  assert.equal(result.sent_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(result.customer_id, '5992356722');
  assert.deepEqual(harness.uploadPayloads.map((item) => item.customerId), ['5992356722']);

  const rows = Array.from(auditModel.rows.values());
  assert.deepEqual(rows.map((row) => row.status), ['accepted']);
  assert.equal(rows[0].destinationKey, 'propdental_main_599');
}

async function testSelectedDestinationProviderFailure() {
  const auditModel = new FakeAuditModel();
  const harness = createMultiDestinationDependencies({
    auditModel,
    failCustomers: new Set(['1851215478'])
  });
  await assert.rejects(
    maybeUploadGoogleConversion({
      ...baseUploadInput({
        googleAdsConfig: multiDestinationConfig,
        eventId: 'lead-selected-failed-42',
        customData: { gclid: 'secret-click-id', customer_id: '1851215478' }
      }),
      dependencies: harness.dependencies
    }),
    (error) => {
      assert.equal(error.code, 'REJECTED_1851215478');
      return true;
    }
  );
  const [row] = Array.from(auditModel.rows.values());
  assert.equal(row.status, 'failed');
  assert.equal(row.destinationKey, 'propdental_parallel_185');
  assert.equal(row.lastErrorMessage.includes('secret-click-id'), false);
  assert.equal(row.lastErrorMessage.includes('patient@example.com'), false);
}

async function testAmbiguousAndUnknownDestinationAreFailClosed() {
  const auditModel = new FakeAuditModel();
  const harness = createMultiDestinationDependencies({ auditModel });
  const ambiguous = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      eventId: 'lead-ambiguous-42'
    }),
    dependencies: harness.dependencies
  });
  assert.equal(ambiguous.sent, false);
  assert.equal(ambiguous.accepted, false);
  assert.equal(ambiguous.reason, 'ambiguous_destination');
  assert.equal(ambiguous.destination_count, 0);
  assert.equal(ambiguous.configured_destination_count, 2);

  const unknown = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      eventId: 'lead-unknown-customer-42',
      customData: { gclid: 'secret-click-id', customer_id: '1112223333' }
    }),
    dependencies: harness.dependencies
  });
  assert.equal(unknown.reason, 'request_customer_not_configured');
  assert.deepEqual(unknown.destination_selector, { customer_id: '1112223333' });
  assert.equal(harness.runtimeInputs.length, 0);
  assert.equal(harness.uploadPayloads.length, 0);
  assert.equal(auditModel.rows.size, 0);
}

async function testGlobalKillSwitchAndExplicitEmptyDestinations() {
  const disabledAudit = new FakeAuditModel();
  let disabledCalls = 0;
  const disabled = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: { ...multiDestinationConfig, enabled: false },
      eventId: 'lead-globally-disabled-42',
      customData: { gclid: 'secret-click-id', customer_id: '1851215478' }
    }),
    dependencies: {
      auditModel: disabledAudit,
      resolveRuntime: async () => { disabledCalls += 1; },
      uploadConversion: async () => { disabledCalls += 1; }
    }
  });
  assert.equal(disabled.sent, false);
  assert.equal(disabled.accepted, false);
  assert.deepEqual(disabled.destinations.map((item) => item.reason), ['google_ads_disabled']);
  assert.equal(disabledCalls, 0);
  assert.equal(disabledAudit.rows.size, 1);

  const explicitEmpty = {
    enabled: true,
    customer_id: '1851215478',
    conversion_action_id: '7680195320',
    events: { lead: { enabled: true, destinations: [] } }
  };
  const emptyAudit = new FakeAuditModel();
  let emptyCalls = 0;
  const empty = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: explicitEmpty,
      eventId: 'lead-explicit-empty-42'
    }),
    dependencies: {
      auditModel: emptyAudit,
      resolveRuntime: async () => { emptyCalls += 1; },
      uploadConversion: async () => { emptyCalls += 1; }
    }
  });
  assert.equal(empty.sent, false);
  assert.equal(empty.accepted, false);
  assert.equal(empty.reason, 'no_configured_destination');
  assert.equal(empty.destination_count, 0);
  assert.equal(emptyCalls, 0);
  assert.equal(emptyAudit.rows.size, 0);
}

async function testUnsupportedEventsNeverFallbackToLead() {
  const auditModel = new FakeAuditModel();
  let calls = 0;
  const result = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      eventName: 'ViewContent',
      eventId: 'page-view-42'
    }),
    dependencies: {
      auditModel,
      resolveRuntime: async () => { calls += 1; },
      uploadConversion: async () => { calls += 1; }
    }
  });
  assert.equal(result.sent, false);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unsupported_conversion_event');
  assert.equal(result.destination_count, 0);
  assert.equal(calls, 0);
  assert.equal(auditModel.rows.size, 0);
}

async function testAuditPersistenceFailureIsNotProviderFailure() {
  const auditModel = new FakeAuditModel();
  const originalCreate = auditModel.create.bind(auditModel);
  auditModel.create = async (values) => {
    const row = await originalCreate(values);
    const originalUpdate = row.update.bind(row);
    row.update = async (patch) => {
      if (patch.status === 'accepted') {
        const error = new Error('database unavailable');
        error.code = 'ER_DB_DOWN';
        throw error;
      }
      return originalUpdate(patch);
    };
    return row;
  };
  let uploadCalls = 0;
  await assert.rejects(
    maybeUploadGoogleConversion({
      ...baseUploadInput({ eventId: 'lead-audit-failure-42' }),
      dependencies: {
        auditModel,
        resolveRuntime: async () => ({
          accessToken: 'scoped-token',
          loginCustomerId: null,
          connection: { id: 23 },
          assignment: { id: 4 },
          connectionSource: 'scope_assignment_group'
        }),
        uploadConversion: async () => {
          uploadCalls += 1;
          return { requestId: 'accepted-before-audit-failure' };
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'GOOGLE_ADS_AUDIT_FAILED_AFTER_ACCEPTANCE');
      assert.equal(error.conversionAccepted, true);
      assert.equal(error.isGoogleAdsProviderError, undefined);
      assert.equal(error.conversionResult.accepted, true);
      assert.equal(error.conversionResult.failed_count, 0);
      assert.equal(error.conversionResult.processing_error_count, 1);
      assert.equal(error.conversionResult.destinations[0].reason, 'audit_persistence_error');
      return true;
    }
  );
  assert.equal(uploadCalls, 1);
  const row = Array.from(auditModel.rows.values())[0];
  assert.equal(row.status, 'pending', 'An accepted upload must never be rewritten as provider failed');
}

async function testMultiDestinationGuardsAreAppliedPerDestination() {
  const overrideAudit = new FakeAuditModel();
  let overrideCalls = 0;
  const override = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      eventId: 'lead-browser-override-42',
      customData: {
        gclid: 'secret-click-id',
        customer_id: '1851215478',
        conversion_action_id: '7680195320'
      }
    }),
    dependencies: {
      auditModel: overrideAudit,
      resolveRuntime: async () => { overrideCalls += 1; },
      uploadConversion: async () => { overrideCalls += 1; }
    }
  });
  assert.equal(override.sent, false);
  assert.equal(override.skipped_count, 1);
  assert.deepEqual(override.destinations.map((item) => item.reason), ['request_target_override_not_allowed']);
  assert.equal(overrideCalls, 0);
  assert.equal(overrideAudit.rows.size, 1);

  const deniedAudit = new FakeAuditModel();
  let deniedCalls = 0;
  const denied = await maybeUploadGoogleConversion({
    ...baseUploadInput({
      googleAdsConfig: multiDestinationConfig,
      eventId: 'lead-denied-42',
      customData: { gclid: 'secret-click-id', customer_id: '1851215478' },
      consent: { ad_user_data: 'denied' },
      allowUpload: false
    }),
    dependencies: {
      auditModel: deniedAudit,
      resolveRuntime: async () => { deniedCalls += 1; },
      uploadConversion: async () => { deniedCalls += 1; }
    }
  });
  assert.equal(denied.sent, false);
  assert.equal(denied.skipped_count, 1);
  assert.deepEqual(denied.destinations.map((item) => item.reason), ['consent_not_granted']);
  assert.equal(deniedCalls, 0);
  assert.equal(deniedAudit.rows.size, 1);
}

function testMultiDestinationConfigInheritance() {
  const normalized = normalizeGoogleAdsConfig(multiDestinationConfig);
  assert.deepEqual(
    normalized.events.lead.destinations.map((item) => item.customer_id),
    ['1851215478', '5992356722']
  );

  const inherited = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic' }, {
    groupRecord: { config: { google_ads: multiDestinationConfig } },
    clinicRecord: { config: { meta_ads: { enabled: true } } }
  });
  assert.deepEqual(
    inherited.google_ads.events.lead.destinations.map((item) => item.key),
    ['propdental_parallel_185', 'propdental_main_599']
  );

  const partialOverride = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic' }, {
    groupRecord: { config: { google_ads: multiDestinationConfig } },
    clinicRecord: { config: { google_ads: { events: { lead: { currency: 'USD' } } } } }
  });
  assert.equal(partialOverride.google_ads.events.lead.currency, 'USD');
  assert.equal(partialOverride.google_ads.events.lead.destinations.length, 2);

  const explicitOverride = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic' }, {
    groupRecord: { config: { google_ads: multiDestinationConfig } },
    clinicRecord: {
      config: {
        google_ads: {
          events: {
            lead: {
              destinations: [{
                key: 'clinic_only',
                customer_id: '111-222-3333',
                conversion_action_id: '1234567890'
              }]
            }
          }
        }
      }
    }
  });
  assert.deepEqual(explicitOverride.google_ads.events.lead.destinations.map((item) => item.key), ['clinic_only']);
  assert.equal(explicitOverride.google_ads.events.lead.destinations[0].customer_id, '1112223333');

  const explicitEmpty = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic' }, {
    groupRecord: { config: { google_ads: multiDestinationConfig } },
    clinicRecord: { config: { google_ads: { events: { lead: { destinations: [] } } } } }
  });
  assert.deepEqual(explicitEmpty.google_ads.events.lead.destinations, []);

  const legacyNormalized = normalizeGoogleAdsConfig(scopedConfig);
  assert.equal(
    Object.prototype.hasOwnProperty.call(legacyNormalized.events.lead, 'destinations'),
    false,
    'Normalizing legacy config must not turn an absent destination list into an explicit empty list'
  );
}

function testPropertyAwareGoogleAdsMerge() {
  const base = {
    ...multiDestinationConfig,
    enabled: false,
    currency: 'GBP',
    customer_id: '1851215478',
    conversion_action_id: '7680195320',
    send_to: 'AW-185/legacy',
    events: {
      lead: {
        ...multiDestinationConfig.events.lead,
        enabled: false,
        conversion_action_id: '7680195320',
        send_to: 'AW-185/lead',
        currency: 'GBP'
      }
    }
  };
  const partial = mergeGoogleAdsConfig(base, {
    events: { lead: { currency: 'USD' } }
  });
  assert.equal(partial.enabled, false);
  assert.equal(partial.customer_id, '1851215478');
  assert.equal(partial.conversion_action_id, '7680195320');
  assert.equal(partial.send_to, 'AW-185/legacy');
  assert.equal(partial.currency, 'GBP');
  assert.equal(partial.events.lead.enabled, false);
  assert.equal(partial.events.lead.conversion_action_id, '7680195320');
  assert.equal(partial.events.lead.send_to, 'AW-185/lead');
  assert.equal(partial.events.lead.currency, 'USD');
  assert.equal(partial.events.lead.destinations.length, 2);

  const cleared = mergeGoogleAdsConfig(base, {
    customer_id: null,
    conversion_action_id: null,
    send_to: null,
    events: {
      lead: {
        conversion_action_id: null,
        send_to: null,
        destinations: []
      }
    }
  });
  assert.equal(cleared.customer_id, null);
  assert.equal(cleared.conversion_action_id, null);
  assert.equal(cleared.send_to, null);
  assert.equal(cleared.events.lead.conversion_action_id, null);
  assert.equal(cleared.events.lead.send_to, null);
  assert.deepEqual(cleared.events.lead.destinations, []);
  assert.equal(cleared.enabled, false, 'An omitted global switch must remain disabled');
  assert.equal(cleared.events.lead.enabled, false, 'An omitted event switch must remain disabled');
}

function testStaticSafetyContracts() {
  const conversionService = fs.readFileSync(
    path.resolve(__dirname, '../../services/googleAdsConversion.service.js'),
    'utf8'
  );
  assert.doesNotMatch(conversionService, /GOOGLE_ADS_REFRESH_TOKEN/);
  assert.doesNotMatch(conversionService, /DEFAULT_CUSTOMER_ID/);

  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  const start = controller.indexOf('exports.listGoogleAdsConversionActions');
  const end = controller.indexOf('exports.startCampaignOnboarding', start);
  const endpoints = controller.slice(start, end);
  assert.match(endpoints, /resolveScopedGoogleAdsRuntime/);
  assert.doesNotMatch(endpoints, /GoogleConnection\.findOne/);
  assert.match(endpoints, /const createMissing = req\.body\?\.create_missing === true/);
  assert.match(endpoints, /confirm_external_mutation/);
}

function testMutationUsesCanonicalEndpointFirst() {
  const firstBase = buildBaseUrls()[0];
  if (!process.env.GOOGLE_ADS_API_BASE_URL) {
    assert.doesNotMatch(firstBase, /\/googleads\/v\d+$/);
  }
}

function testConfiguredActionCannotCrossCustomer() {
  assert.equal(buildConversionActionResource({
    customerId: '5992356722',
    conversionAction: 'customers/1112223333/conversionActions/99'
  }), null);
  assert.equal(requestedTargetMismatchesConfig(
    { send_to: 'AW-123/lead-label' },
    { customer_id: '5992356722', send_to: 'AW-123/lead-label' },
    'customers/5992356722/conversionActions/7540337982'
  ), false);
  assert.equal(hasRequestedActionOverride({ customer_id: '5992356722' }), false);
  assert.equal(hasRequestedActionOverride({ conversion_action_id: '7540337982' }), true);
}

async function run() {
  await testScopedRuntime();
  await testConcurrentAuditClaimIsFailClosed();
  await testLowLevelUploadRequiresScopedToken();
  await testConversionActionCreationRequiresScopedToken();
  await testAuditedUploadAndIdempotency();
  await testHealthcareUserDataIsBlocked();
  await testConsentAndTargetGuards();
  testAdvertisingConsentNormalizationKeepsPurposesSeparate();
  await testConsentModeRequiresPerVisitorAdvertisingConsent();
  await testFailedUploadIsAudited();
  await testMultiDestinationSuccessAndDedupe();
  await testMultiDestinationCampaignSelector();
  await testSelectedDestinationProviderFailure();
  await testAmbiguousAndUnknownDestinationAreFailClosed();
  await testGlobalKillSwitchAndExplicitEmptyDestinations();
  await testUnsupportedEventsNeverFallbackToLead();
  await testAuditPersistenceFailureIsNotProviderFailure();
  await testMultiDestinationGuardsAreAppliedPerDestination();
  testMultiDestinationConfigInheritance();
  testPropertyAwareGoogleAdsMerge();
  testStaticSafetyContracts();
  testMutationUsesCanonicalEndpointFirst();
  testConfiguredActionCannotCrossCustomer();
  console.log('google_ads_conversion_tracking.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
