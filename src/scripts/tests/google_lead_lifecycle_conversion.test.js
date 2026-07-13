'use strict';

const assert = require('node:assert/strict');
const db = require('../../../models');
const {
  buildLifecycleConversionPayload,
  maybeUploadLeadLifecycleConversion,
} = require('../../services/googleLeadLifecycleConversion.service');
const {
  maybeUploadGoogleConversion,
} = require('../../services/googleAdsConversionUpload.service');

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
      },
    };
    this.rows.set(values.dedupeKey, row);
    return row;
  }
}

function leadFixture(overrides = {}) {
  return {
    id: 42,
    clinica_id: 56,
    grupo_clinica_id: 5,
    gclid: 'opaque-click-id',
    gbraid: null,
    wbraid: null,
    ga_client_id: '123.456',
    google_ads_customer_id: '5992356722',
    google_ads_campaign_id: '987654321',
    nombre: 'Paciente Prueba',
    email: 'patient@example.com',
    telefono: '+34600000000',
    consentimiento_canal: { marketing: true, ad_user_data: 'granted' },
    ...overrides,
  };
}

function testPayloadKeepsRichAttribution() {
  const payload = buildLifecycleConversionPayload({
    lead: leadFixture(),
    eventName: 'schedule',
    eventId: 'appointment-99',
    value: 0,
    occurredAt: new Date('2026-07-12T10:00:00Z'),
  });
  assert.equal(payload.customData.gclid, 'opaque-click-id');
  assert.equal(payload.customData.client_id, '123.456');
  assert.equal(payload.customData.customer_id, '5992356722');
  assert.equal(payload.customData.campaign_id, '987654321');
  assert.equal(payload.userData.email, 'patient@example.com');
  assert.equal(payload.eventName, 'schedule');
  assert.equal(payload.customData.value, 0, 'An explicit zero value must be preserved');
}

function testPayloadOmitsMissingValueAndPreservesRealPurchaseValue() {
  const configuredWeightPayload = buildLifecycleConversionPayload({
    lead: leadFixture(),
    eventName: 'qualified_lead',
    eventId: 'lead-42-qualified',
  });
  assert.equal(Object.hasOwn(configuredWeightPayload.customData, 'value'), false);

  const purchasePayload = buildLifecycleConversionPayload({
    lead: leadFixture(),
    eventName: 'purchase',
    eventId: 'appointment-99-treatment-completed',
    value: 1250.5,
  });
  assert.equal(purchasePayload.customData.value, 1250.5);
}

async function testScheduleUsesGroupConfigAndConsent() {
  let uploadInput = null;
  const result = await maybeUploadLeadLifecycleConversion({
    lead: leadFixture(),
    eventName: 'schedule',
    eventId: 'appointment-99',
    dependencies: {
      IntakeConfig: {
        async findOne({ where }) {
          if (where.group_id === 5) {
            return {
              id: 24,
              assignment_scope: 'group',
              group_id: 5,
              config: {
                features: { consent_mode_enabled: true },
                google_ads: {
                  enabled: true,
                  events: { schedule: { enabled: true, value: 40, currency: 'EUR' } },
                },
              },
            };
          }
          return null;
        },
      },
      maybeUploadGoogleConversion: async (input) => {
        uploadInput = input;
        return { sent: true };
      },
    },
  });
  assert.equal(result.sent, true);
  assert.equal(uploadInput.eventName, 'schedule');
  assert.equal(uploadInput.assignmentScope, 'group');
  assert.equal(uploadInput.allowUpload, true);
  assert.equal(Object.hasOwn(uploadInput.customData, 'value'), false);
  assert.equal(uploadInput.googleAdsConfig.events.schedule.value, 40);
}

async function testConfiguredLifecycleWeightsReachUploader() {
  const auditModel = new FakeAuditModel();
  const uploaded = [];
  const configRecord = {
    id: 24,
    assignment_scope: 'group',
    group_id: 5,
    config: {
      features: { consent_mode_enabled: true },
      google_ads: {
        enabled: true,
        events: {
          qualified_lead: {
            enabled: true,
            customer_id: '5992356722',
            conversion_action_id: '123456789',
            value: 10,
            currency: 'EUR',
          },
          schedule: {
            enabled: true,
            customer_id: '5992356722',
            conversion_action_id: '987654321',
            value: 40,
            currency: 'EUR',
          },
        },
      },
    },
  };
  const dependencies = {
    IntakeConfig: { findOne: async () => configRecord },
    maybeUploadGoogleConversion: (input) => maybeUploadGoogleConversion({
      ...input,
      dependencies: {
        auditModel,
        resolveRuntime: async () => ({
          accessToken: 'scoped-token',
          loginCustomerId: '2863224233',
          connection: { id: 23 },
          assignment: { id: 4 },
          connectionSource: 'scope_assignment_group',
        }),
        uploadConversion: async (payload) => {
          uploaded.push(payload);
          return { requestId: `request-${uploaded.length}` };
        },
      },
    }),
  };

  await maybeUploadLeadLifecycleConversion({
    lead: leadFixture(),
    eventName: 'qualified_lead',
    eventId: 'lead-42-qualified',
    dependencies,
  });
  await maybeUploadLeadLifecycleConversion({
    lead: leadFixture(),
    eventName: 'schedule',
    eventId: 'appointment-99',
    dependencies,
  });

  assert.deepEqual(uploaded.map(({ eventName, value, currency }) => ({ eventName, value, currency })), [
    { eventName: 'qualified_lead', value: 10, currency: 'EUR' },
    { eventName: 'schedule', value: 40, currency: 'EUR' },
  ]);
}

async function testDeniedMarketingFailsClosed() {
  let allowUpload = null;
  await maybeUploadLeadLifecycleConversion({
    lead: leadFixture({ consentimiento_canal: { marketing: false, ad_user_data: 'denied' } }),
    eventName: 'schedule',
    eventId: 'appointment-100',
    dependencies: {
      IntakeConfig: {
        async findOne() {
          return {
            id: 24,
            assignment_scope: 'group',
            group_id: 5,
            config: {
              features: { consent_mode_enabled: true },
              google_ads: { enabled: true },
            },
          };
        },
      },
      maybeUploadGoogleConversion: async (input) => {
        allowUpload = input.allowUpload;
        return { sent: false };
      },
    },
  });
  assert.equal(allowUpload, false);
}

async function captureLifecycleUpload({ consent, consentModeEnabled }) {
  let uploadInput = null;
  await maybeUploadLeadLifecycleConversion({
    lead: leadFixture({ consentimiento_canal: consent }),
    eventName: 'schedule',
    eventId: `appointment-consent-${consentModeEnabled ? 'on' : 'off'}-${JSON.stringify(consent)}`,
    dependencies: {
      IntakeConfig: {
        async findOne() {
          return {
            id: 24,
            assignment_scope: 'group',
            group_id: 5,
            config: {
              features: { consent_mode_enabled: consentModeEnabled },
              google_ads: { enabled: true },
            },
          };
        },
      },
      maybeUploadGoogleConversion: async (input) => {
        uploadInput = input;
        return { sent: input.allowUpload };
      },
    },
  });
  return uploadInput;
}

async function testLifecycleConsentPurposeAndModeGuards() {
  const legacyAnalytics = await captureLifecycleUpload({
    consent: { analytics: true },
    consentModeEnabled: true,
  });
  assert.equal(legacyAnalytics.allowUpload, false);
  assert.equal(legacyAnalytics.consentModeEnabled, true);

  const contactOnly = await captureLifecycleUpload({
    consent: { contact: true, phone: true, whatsapp: true },
    consentModeEnabled: true,
  });
  assert.equal(contactOnly.allowUpload, false);

  const absent = await captureLifecycleUpload({ consent: null, consentModeEnabled: true });
  assert.equal(absent.allowUpload, false);

  const marketing = await captureLifecycleUpload({
    consent: { marketing: true },
    consentModeEnabled: true,
  });
  assert.equal(marketing.allowUpload, true);

  const adUserData = await captureLifecycleUpload({
    consent: { ad_user_data: 'granted' },
    consentModeEnabled: true,
  });
  assert.equal(adUserData.allowUpload, true);

  const legacyModeOff = await captureLifecycleUpload({
    consent: { analytics: true },
    consentModeEnabled: false,
  });
  assert.equal(legacyModeOff.allowUpload, true);
  assert.equal(legacyModeOff.consentModeEnabled, false);
}

async function run() {
  testPayloadKeepsRichAttribution();
  testPayloadOmitsMissingValueAndPreservesRealPurchaseValue();
  await testScheduleUsesGroupConfigAndConsent();
  await testConfiguredLifecycleWeightsReachUploader();
  await testDeniedMarketingFailsClosed();
  await testLifecycleConsentPurposeAndModeGuards();
  console.log('google_lead_lifecycle_conversion.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => db.sequelize.close());
