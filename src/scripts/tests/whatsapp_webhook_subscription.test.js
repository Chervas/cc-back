'use strict';

const assert = require('node:assert/strict');
const {
  buildWhatsappRoutingAdditionalData,
  normalizeWhatsappChannelRole,
  resolveWhatsappRouting,
  resolveWhatsappChannelRole,
  selectWhatsappPhoneAsset,
} = require('../../lib/whatsapp-channel-role');

const originalMetaAppSecret = process.env.META_APP_SECRET;
process.env.META_APP_SECRET = 'test-app-secret';

const axios = require('axios');
const whatsappPhonesService = require('../../services/whatsappPhones.service');
const {
  hasWhatsappPrimaryForScope,
  whatsappPhoneScopeWhere,
} = require('../../services/whatsappPhoneAssignment.service');
const db = require('../../../models');

const originalGet = axios.get;

(async () => {
  const connectedWithExpiredCode = whatsappPhonesService.buildRegisteredSnapshot({
    status: 'CONNECTED',
    code_verification_status: 'EXPIRED',
  }, {
    status: 'not_registered',
    requiresPin: true,
    registeredAt: '2026-03-24T10:31:55.841Z',
  });
  assert.equal(connectedWithExpiredCode.status, 'registered');
  assert.equal(connectedWithExpiredCode.requiresPin, false);
  assert.equal(connectedWithExpiredCode.registeredAt, '2026-03-24T10:31:55.841Z');
  assert.equal(connectedWithExpiredCode.phoneStatus, 'CONNECTED');
  assert.equal(connectedWithExpiredCode.codeVerificationStatus, 'EXPIRED');
  assert.equal(Number.isNaN(new Date(connectedWithExpiredCode.lastAttemptAt).getTime()), false);
  assert.equal(normalizeWhatsappChannelRole(' Secondary '), 'secondary');
  assert.equal(normalizeWhatsappChannelRole('unknown'), null);
  assert.equal(resolveWhatsappChannelRole({
    additionalData: { routing: { role: 'secondary' } },
  }), 'secondary');
  const routingData = buildWhatsappRoutingAdditionalData(
    { registration: { status: 'registered' } },
    {
      role: 'secondary',
      purposes: ['review_requests', 'invalid', 'review_requests'],
      unavailableAction: 'fallback_primary',
    }
  );
  assert.equal(routingData.registration.status, 'registered');
  assert.deepEqual(resolveWhatsappRouting({ additionalData: routingData }), {
    role: 'secondary',
    purposes: ['review_requests'],
    unavailableAction: 'fallback_primary',
  });
  assert.deepEqual(resolveWhatsappRouting({}), {
    role: 'primary',
    purposes: [],
    unavailableAction: 'pause',
  });
  assert.deepEqual(
    whatsappPhoneScopeWhere({ assignmentScope: 'clinic', clinicId: 66, groupId: 29 }),
    { assignmentScope: 'clinic', clinicaId: 66 },
  );

  const originalFindAll = db.ClinicMetaAsset.findAll;
  let capturedPrimaryLookup = null;
  db.ClinicMetaAsset.findAll = async (options) => {
    capturedPrimaryLookup = options.where;
    return [{ additionalData: buildWhatsappRoutingAdditionalData({}, { role: 'primary' }) }];
  };
  try {
    assert.equal(await hasWhatsappPrimaryForScope({
      assignmentScope: 'clinic',
      clinicId: 66,
      groupId: 29,
      exceptPhoneNumberId: 'new-secondary',
    }), true);
    assert.equal(capturedPrimaryLookup.assetType, 'whatsapp_phone_number');
    assert.equal(capturedPrimaryLookup.isActive, true);
    assert.ok(capturedPrimaryLookup[db.Sequelize.Op.or].some((scope) =>
      scope.assignmentScope === 'group' && scope.grupoClinicaId === 29
    ));
  } finally {
    db.ClinicMetaAsset.findAll = originalFindAll;
  }

  const clinicPrimary = { id: 1, phoneNumberId: 'primary', waAccessToken: 'token', additionalData: {} };
  const groupPrimary = { id: 2, phoneNumberId: 'group-primary', waAccessToken: 'token', additionalData: {} };
  const clinicSecondary = {
    id: 3,
    phoneNumberId: 'secondary',
    waAccessToken: 'token',
    additionalData: buildWhatsappRoutingAdditionalData({}, {
      role: 'secondary',
      purposes: ['review_requests'],
      unavailableAction: 'pause',
    }),
  };
  assert.equal(selectWhatsappPhoneAsset({
    clinicAssets: [clinicPrimary, clinicSecondary],
    groupAssets: [groupPrimary],
  }).id, clinicPrimary.id);
  assert.equal(selectWhatsappPhoneAsset({
    clinicAssets: [clinicPrimary, clinicSecondary],
    groupAssets: [groupPrimary],
    purpose: 'review_requests',
  }).id, clinicSecondary.id);
  assert.equal(selectWhatsappPhoneAsset({
    clinicAssets: [clinicPrimary, clinicSecondary],
    groupAssets: [groupPrimary],
    purpose: 'lead_first_contact',
  }).id, clinicPrimary.id);
  assert.equal(selectWhatsappPhoneAsset({
    clinicAssets: [],
    groupAssets: [groupPrimary],
  }).id, groupPrimary.id);

  const unavailableSecondary = {
    ...clinicSecondary,
    additionalData: buildWhatsappRoutingAdditionalData({}, {
      role: 'secondary',
      purposes: ['review_requests'],
      unavailableAction: 'fallback_primary',
    }),
  };
  assert.equal(selectWhatsappPhoneAsset({
    clinicAssets: [clinicPrimary, unavailableSecondary],
    purpose: 'review_requests',
    summarizeHealth: () => ({ can_send: false }),
  }).id, clinicPrimary.id);
  const pausedSecondary = {
    ...unavailableSecondary,
    additionalData: buildWhatsappRoutingAdditionalData({}, {
      role: 'secondary',
      purposes: ['review_requests'],
      unavailableAction: 'pause',
    }),
  };
  const unavailableSelection = selectWhatsappPhoneAsset({
    clinicAssets: [clinicPrimary, pausedSecondary],
    purpose: 'review_requests',
    summarizeHealth: () => ({ can_send: false }),
  });
  assert.equal(unavailableSelection.id, pausedSecondary.id);
  assert.equal(unavailableSelection.routing_unavailable, true);

  const requests = [];
  axios.get = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/subscribed_apps')) {
      return {
        data: {
          data: [{
            whatsapp_business_api_data: {
              id: '1807844546609897',
              name: 'ClinicaClick',
            },
          }],
        },
      };
    }
    if (url.endsWith('/1807844546609897/subscriptions')) {
      return {
        data: {
          data: [{
            object: 'whatsapp_business_account',
            active: true,
            callback_url: 'https://autenticacion.clinicaclick.com/whatsapp/webhook',
            fields: ['messages', 'account_update', 'account_review_update'],
          }],
        },
      };
    }
    throw new Error(`unexpected_url:${url}`);
  };

  try {
    const snapshot = await whatsappPhonesService.fetchWebhookSubscriptionStatus({
      wabaId: 'waba-test',
      accessToken: 'waba-access-token',
    });
    assert.equal(snapshot.status, 'subscribed');
    assert.equal(snapshot.waba_subscribed, true);
    assert.equal(snapshot.app_configuration_active, true);
    assert.equal(snapshot.callback_host, 'autenticacion.clinicaclick.com');
    assert.deepEqual(snapshot.missing_fields, []);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer waba-access-token');
    assert.equal(requests[1].options.params.access_token.includes('test-app-secret'), true);

    axios.get = async (url) => {
      if (url.endsWith('/subscribed_apps')) return { data: { data: [] } };
      throw new Error(`unexpected_url:${url}`);
    };
    const missingWaba = await whatsappPhonesService.fetchWebhookSubscriptionStatus({
      wabaId: 'waba-missing',
      accessToken: 'waba-access-token',
    });
    assert.equal(missingWaba.status, 'missing');
    assert.equal(missingWaba.waba_subscribed, false);

    axios.get = async (url) => {
      if (url.endsWith('/subscribed_apps')) {
        const error = new Error('temporary_provider_failure');
        error.response = { status: 503, data: { error: { code: 2, type: 'OAuthException' } } };
        throw error;
      }
      throw new Error(`unexpected_url:${url}`);
    };
    const unknown = await whatsappPhonesService.fetchWebhookSubscriptionStatus({
      wabaId: 'waba-unknown',
      accessToken: 'waba-access-token',
    });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.waba_subscribed, null);
    assert.equal(JSON.stringify(unknown).includes('waba-access-token'), false);

    axios.get = async (url) => {
      if (url.endsWith('/1807844546609897/subscriptions')) {
        return {
          data: {
            data: [{
              object: 'whatsapp_business_account',
              active: true,
              callback_url: 'https://autenticacion.clinicaclick.com/whatsapp/webhook',
              fields: ['messages', 'account_update'],
            }],
          },
        };
      }
      if (url.endsWith('/subscribed_apps')) {
        return {
          data: { data: [{ whatsapp_business_api_data: { id: '1807844546609897' } }] },
        };
      }
      throw new Error(`unexpected_url:${url}`);
    };
    await whatsappPhonesService.fetchAppWebhookConfiguration({ force: true });
    const missingField = await whatsappPhonesService.fetchWebhookSubscriptionStatus({
      wabaId: 'waba-field-missing',
      accessToken: 'waba-access-token',
    });
    assert.equal(missingField.status, 'missing');
    assert.deepEqual(missingField.missing_fields, ['account_review_update']);
    assert.equal(JSON.stringify(missingField).includes('test-app-secret'), false);
  } finally {
    axios.get = originalGet;
    if (originalMetaAppSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = originalMetaAppSecret;
  }

  console.log('whatsapp_webhook_subscription.test.js OK');
  process.exit(0);
})().catch((error) => {
  axios.get = originalGet;
  if (originalMetaAppSecret === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = originalMetaAppSecret;
  console.error(error);
  process.exit(1);
});
