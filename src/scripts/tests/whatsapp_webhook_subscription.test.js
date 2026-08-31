'use strict';

const assert = require('node:assert/strict');

const originalMetaAppSecret = process.env.META_APP_SECRET;
process.env.META_APP_SECRET = 'test-app-secret';

const axios = require('axios');
const whatsappPhonesService = require('../../services/whatsappPhones.service');

const originalGet = axios.get;

(async () => {
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
