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
    broker: { profile: async (clinicId, assetId, options) => {
      assert.equal(clinicId, 56);
      assert.equal(assetId, 398);
      assert.deepEqual(options, { includeProfilePicture: true });
      return { id: '401', status: 'CONNECTED', codeVerificationStatus: 'VERIFIED', qualityRating: 'GREEN',
        isOnBizApp: false, platformType: 'CLOUD_API', displayPhoneNumber: '+34 600 000 401', verifiedName: 'Synthetic Clinic',
        profilePictureUrl: 'https://pps.whatsapp.net/v/photo.jpg' };
    } },
    healthService: {
      summarizeAssetHealth: () => ({ state: 'stale', can_send: true }),
      recordObservationForAsset: async input => { observations.push(input); return { health: { state: 'healthy', can_send: true } }; },
    },
    now: () => new Date('2026-09-25T07:00:00.000Z'),
  });
  const result = await service.refresh({ asset, clinicId: 56 });
  assert.equal(updates.length, 0, 'The health transaction owns the guarded profile write');
  assert.equal(observations[0].profilePatch.displayPhoneNumber, '+34 600 000 401');
  assert.equal(observations[0].profilePatch.verifiedName, 'Synthetic Clinic');
  assert.equal(observations[0].profilePatch.profilePictureUrl, 'https://pps.whatsapp.net/v/photo.jpg');
  assert.equal(observations[0].profilePatch.registration.status, 'registered');
  assert.equal(observations[0].profilePatch.authorizedProfileObservedAt, '2026-09-25T07:00:00.000Z');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].source, 'whatsapp_authorized_profile_refresh');
  assert.equal(observations[0].signal.providerStatus, 'CONNECTED');
  assert.deepEqual(result.health, { state: 'healthy', can_send: true });
  assert.equal(Object.hasOwn(observations[0].profilePatch, 'waAccessToken'), false);
});

test('a static protected binding without a local signup receipt can refresh with a null identity guard', async () => {
  let observed;
  const service = createService({ broker: { profile: async () => ({ id:'401',status:'CONNECTED',qualityRating:'GREEN' }) },
    healthService: { summarizeAssetHealth: () => ({}), recordObservationForAsset: async input => {
      observed = input; return { health: { state:'healthy' } };
    } } });
  await service.refresh({ asset: { id:393,phoneNumberId:'401',wabaId:'301',whatsappAuthorizationId:null },clinicId:66 });
  assert.deepEqual(observed.expectedIdentity,{whatsappAuthorizationId:null,phoneNumberId:'401',wabaId:'301'});
});

test('a successful but superseded profile cannot overwrite a renewed authorization', async () => {
  const service = createService({broker:{profile:async () => ({id:'401',status:'CONNECTED'})},
    healthService:{summarizeAssetHealth:() => ({}),recordObservationForAsset:async () => null}});
  await assert.rejects(service.refresh({asset:{id:400,whatsappAuthorizationId:'old'},clinicId:59}),{code:'whatsapp_authorized_binding_changed'});
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
test('manual refresh reports broker throttling with Retry-After, never a payment or connection failure', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../controllers/whatsapp.controller'), 'utf8');
  const start = source.indexOf('exports.refreshPhoneStatus =');
  const end = source.indexOf('\nexports.', start + 1);
  assert(start >= 0 && end > start);
  const asset = { id: 10, clinicaId: 4, assignmentScope: 'clinic' };
  const context = {
    exports: {},
    MetaConnection: {},
    ClinicMetaAsset: { findOne: async () => asset },
    Clinica: { findByPk: async () => ({ id_clinica: 4 }) },
    getUserClinics: async () => ({ clinicIds: [4], isAggregateAllowed: false }),
    getUserGroupIds: async () => [],
    assertWhatsappTemplateClinicAccess: async () => {},
    require: name => {
      if (name === '../lib/whatsappAuthorizedBrokerClient') return { binding: async () => ({ assetId: 10 }) };
      if (name === '../lib/whatsappManualDisconnect') return { current: () => null };
      throw Error('unexpected_dependency');
    },
    whatsappAuthorizedPhoneRefreshService: {
      refresh: async () => { throw Object.assign(Error('broker_wait'), { code: 'rate_limited' }); },
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const result = {};
  const res = {
    set(name, value) { result[name] = value; },
    status(value) { result.status = value; return this; },
    json(value) { result.body = value; },
  };
  await context.exports.refreshPhoneStatus({ userData: { userId: 20 },
    params: { phoneNumberId: '222222' }, body: { clinic_id: 4 } }, res);
  assert.equal(result.status, 429);
  assert.equal(result['Retry-After'], '60');
  assert.equal(result.body.error, 'whatsapp_refresh_rate_limited');
  assert.match(result.body.message, /último estado conocido/);
  assert.equal(result.body.health, undefined);
});
