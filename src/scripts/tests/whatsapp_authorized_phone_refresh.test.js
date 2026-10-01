'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../../services/whatsappAuthorizedPhoneRefresh.service');

test('authorized phone refresh materializes the broker profile without a CRM token', async () => {
  const updates = [];
  const observations = [];
  const asset = {
    id: 398,
    whatsappAuthorizationId: 'a1234567-1234-4234-8234-123456789abc',
    metaAssetName: null,
    waVerifiedName: null,
    quality_rating: null,
    additionalData: {},
    async update(values) { updates.push(values); Object.assign(this, values); },
  };
  const service = createService({
    broker: { profile: async (clinicId, assetId) => {
      assert.equal(clinicId, 56);
      assert.equal(assetId, 398);
      return { id: '401', status: 'CONNECTED', codeVerificationStatus: 'VERIFIED', qualityRating: 'GREEN',
        isOnBizApp: false, platformType: 'CLOUD_API', displayPhoneNumber: '+34 600 000 401', verifiedName: 'Synthetic Clinic' };
    } },
    healthService: {
      summarizeAssetHealth: () => ({ state: 'stale', can_send: true }),
      recordObservationForAsset: async input => { observations.push(input); return { health: { state: 'healthy', can_send: true } }; },
    },
    now: () => new Date('2026-09-25T07:00:00.000Z'),
  });
  const result = await service.refresh({ asset, clinicId: 56 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].metaAssetName, '+34 600 000 401');
  assert.equal(updates[0].waVerifiedName, 'Synthetic Clinic');
  assert.equal(updates[0].additionalData.registration.status, 'registered');
  assert.equal(updates[0].additionalData.authorizedProfileObservedAt, '2026-09-25T07:00:00.000Z');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].source, 'whatsapp_authorized_profile_refresh');
  assert.equal(observations[0].signal.providerStatus, 'CONNECTED');
  assert.deepEqual(result.health, { state: 'healthy', can_send: true });
  assert.equal(Object.hasOwn(updates[0], 'waAccessToken'), false);
});

test('a phone-specific lost access result records a guarded disconnection without changing routing or credentials', async () => {
  const asset = { id:400, phoneNumberId:'401', wabaId:'301',
    whatsappAuthorizationId:'a1234567-1234-4234-8234-123456789abc',
    update: () => assert.fail('Do not overwrite historical registration or credentials') };
  let observed;
  const service = createService({ broker: { profile:async () => { throw Object.assign(Error('bounded'),{code:'whatsapp_authorized_phone_unavailable'}); } },
    healthService: { summarizeAssetHealth: () => ({state:'healthy'}),
      recordObservationForAsset:async input => { observed=input; return {health:{state:'disconnected',can_send:false}}; } },
    now: () => new Date('2026-10-01T12:00:00Z'),
  });
  const result = await service.refresh({asset,clinicId:59});
  assert.deepEqual(result,{profile:null,health:{state:'disconnected',can_send:false}});
  assert.deepEqual(observed.expectedIdentity,{whatsappAuthorizationId:asset.whatsappAuthorizationId,phoneNumberId:'401',wabaId:'301'});
  assert.deepEqual(observed.signal,{phoneUnavailable:true});
  assert.equal(observed.assetId,400);
  assert.equal(observed.source,'whatsapp_authorized_profile_refresh');
});

test('generic provider errors and timeouts never materialize a disconnection', async () => {
  for (const code of ['provider_timeout','provider_failed','whatsapp_provider_100','provider_unauthorized','scope_denied']) {
    const service = createService({ broker:{profile:async () => { throw Object.assign(Error(code),{code}); }},
      healthService:{summarizeAssetHealth:() => ({}),recordObservationForAsset:() => assert.fail('Unconfirmed disconnection')} });
    await assert.rejects(service.refresh({asset:{id:400,whatsappAuthorizationId:'valid'},clinicId:59}),{code});
  }
});

test('an unavailable response for a replaced authorization cannot mark the new connection as disconnected', async () => {
  const service = createService({ broker:{profile:async () => { throw Object.assign(Error('bounded'),{code:'whatsapp_authorized_phone_unavailable'}); }},
    healthService:{summarizeAssetHealth:() => ({}),recordObservationForAsset:async () => null} });
  await assert.rejects(service.refresh({asset:{id:400,whatsappAuthorizationId:'old'},clinicId:59}),{code:'whatsapp_authorized_binding_changed'});
});
