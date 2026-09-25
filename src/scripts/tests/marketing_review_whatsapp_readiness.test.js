'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../services/marketingBulkSends.service');
const whatsappService = require('../../services/whatsapp.service');

const {
  hasWhatsappConfigForClinic,
  isWhatsappRoutingConfigAvailable,
} = service.__testing;

test('review readiness accepts an exact tokenless broker authorization', () => {
  const config = {
    originId: 398,
    phoneNumberId: '1408462885673079',
    wabaId: '1752472712729778',
    clinicId: 56,
    routingUnavailable: false,
    authorizedBroker: {
      assetId: 398,
      phoneId: '1408462885673079',
      wabaId: '1752472712729778',
      clinicId: 56,
      sendEnabled: true,
    },
  };

  assert.equal(Object.hasOwn(config, 'accessToken'), false);
  assert.equal(isWhatsappRoutingConfigAvailable(config), true);
});

test('review readiness remains closed for paused or mismatched broker bindings', () => {
  const base = {
    originId: 398,
    phoneNumberId: '1408462885673079',
    wabaId: '1752472712729778',
    clinicId: 56,
    routingUnavailable: false,
    authorizedBroker: {
      assetId: 398,
      phoneId: '1408462885673079',
      wabaId: '1752472712729778',
      clinicId: 56,
      sendEnabled: true,
    },
  };

  assert.equal(isWhatsappRoutingConfigAvailable({
    ...base,
    authorizedBroker: { ...base.authorizedBroker, sendEnabled: false },
  }), false);
  assert.equal(isWhatsappRoutingConfigAvailable({
    ...base,
    authorizedBroker: { ...base.authorizedBroker, assetId: 399 },
  }), false);
  assert.equal(isWhatsappRoutingConfigAvailable({ ...base, routingUnavailable: true }), false);
});

test('review readiness preserves support for a complete legacy configuration', () => {
  assert.equal(isWhatsappRoutingConfigAvailable({
    originId: 12,
    phoneNumberId: '401',
    wabaId: '501',
    clinicId: 56,
    accessToken: 'SYNTHETIC_LEGACY_TOKEN',
  }), true);
});

test('review readiness resolves the sender selected for review requests', async (t) => {
  const calls = [];
  t.mock.method(whatsappService, 'getClinicConfig', async (clinicId, options) => {
    calls.push({ clinicId, options });
    return {
      originId: 398,
      phoneNumberId: '1408462885673079',
      wabaId: '1752472712729778',
      clinicId: 56,
      routingUnavailable: false,
      authorizedBroker: {
        assetId: 398,
        phoneId: '1408462885673079',
        wabaId: '1752472712729778',
        clinicId: 56,
        sendEnabled: true,
      },
    };
  });

  assert.equal(await hasWhatsappConfigForClinic(56), true);
  assert.deepEqual(calls, [{ clinicId: 56, options: { purpose: 'review_requests' } }]);
});
