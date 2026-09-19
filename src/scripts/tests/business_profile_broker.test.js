'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createBusinessProfileBroker, binding } = require('../../services/businessProfileBroker.service');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
const managed = { id: 51, clinica_id: 71, google_connection_id: 81, location_id: 'locations/456', is_active: true,
  broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456' };
const record = { external_location_id: '456', connection_ref: 'connection:test', asset_ref: 'gbp:123:456', clinica_id: 71, google_connection_id: 81 };
test('persistent managed markers bypass token loader and fail closed on disable, forged context or changed mapping', async () => {
  let enabled = true; let current = { ...managed }; let calls = 0; let tokenReads = 0;
  const service = createBusinessProfileBroker({ client: { async execute(command) { calls++; assert.equal(command.tenantRef, 'clinic:71'); return { data: { name: 'locations/456' } }; } },
    loadLocation: async () => current, loadManagedBinding: async () => record, enabled: () => enabled });
  const loader = async () => { tokenReads++; return { accessToken: 'FICTITIOUS_LEGACY_SENTINEL' }; };
  const context = await service.prepare(managed, loader, new Map()); assert.deepEqual(context, {});
  await service.read(managed, context, 'details', {}); assert.equal(calls, 1); assert.equal(tokenReads, 0);
  await assert.rejects(service.read(managed, {}, 'details', {}), { code: 'broker_binding_invalid' });
  await assert.rejects(service.read(managed, 'FICTITIOUS_LEGACY_SENTINEL', 'details', {}), { code: 'broker_binding_invalid' });
  for (const patch of [{ clinica_id: 72 }, { google_connection_id: 82 }, { is_active: false }, { location_id: 'locations/999' },
    { broker_read_connection_ref: null, broker_read_asset_ref: null }, { broker_read_connection_ref: 'different' }]) {
    current = { ...managed, ...patch }; await assert.rejects(service.read(managed, context, 'details', {}));
  }
  enabled = false; current = managed; await assert.rejects(service.prepare(managed, loader, new Map()), { code: 'broker_cohort_disabled' });
  await assert.rejects(service.read(managed, context, 'details', {}), { code: 'broker_cohort_disabled' }); assert.equal(calls, 1); assert.equal(tokenReads, 0);
});
test('legacy default reuses its existing token cache while malformed managed references cannot downgrade', async () => {
  const service = createBusinessProfileBroker({ client: {}, loadLocation: async () => null, loadManagedBinding: async () => null }); const cache = new Map(); let reads = 0;
  const load = async () => { reads++; return { accessToken: 'FICTITIOUS_LEGACY_SENTINEL' }; };
  const legacy = { ...managed, broker_read_connection_ref: null, broker_read_asset_ref: null };
  assert.equal(await service.prepare(legacy, load, cache), 'FICTITIOUS_LEGACY_SENTINEL'); await service.prepare(legacy, load, cache); assert.equal(reads, 1);
  for (const patch of [{ broker_read_connection_ref: '' }, { broker_read_asset_ref: null }, { broker_read_asset_ref: 'gbp:123:999' }, { broker_read_asset_ref: 'https://example.invalid' }]) {
    await assert.rejects(service.prepare({ ...managed, ...patch }, load, cache));
  }
  assert.equal(reads, 1); assert.equal(binding(managed).assetRef, 'gbp:123:456');
});
test('actual job methods cannot use a supplied legacy token for a managed location', async () => {
  let legacyCalls = 0; const service = createBusinessProfileBroker({ client: {}, loadLocation: async () => managed, loadManagedBinding: async () => record, enabled: () => true });
  const { metaSyncJobs: jobs } = loadBusinessProfileJobs({ broker: { ...service, binding }, models: { BusinessProfileReview: { update: async () => [0] } }, legacyHttp: { get: async () => { legacyCalls++; throw Error('LEGACY_HTTP_FORBIDDEN'); } } });
  for (const method of ['Metrics', 'Reviews', 'Posts', 'Media', 'LocationDetails', 'VoiceOfMerchantState']) {
    await assert.rejects(jobs['_syncBusinessProfile' + method](managed, 'FICTITIOUS_LEGACY_SENTINEL', new Date('2026-09-01'), new Date('2026-09-02')));
  }
  assert.equal(legacyCalls, 0);
});
test('a mapping changed while awaiting the broker prevents the response from entering business caches', async () => {
  let current = { ...managed }; const service = createBusinessProfileBroker({ enabled: () => true, loadLocation: async () => current, loadManagedBinding: async () => record,
    client: { async execute() { current = { ...managed, clinica_id: 999 }; return { data: { name: 'locations/456' } }; } } });
  const context = await service.prepare(managed, () => { throw Error(); }, new Map());
  await assert.rejects(service.read(managed, context, 'details', {}), { code: 'broker_binding_invalid' });
});
test('independent registry stops recreated or unmarked locations even with the cohort disabled', async () => {
  let tokenReads = 0; const service = createBusinessProfileBroker({ enabled: () => false, loadLocation: async () => null, loadManagedBinding: async () => record, client: {} });
  const recreated = { ...managed, id: 99, broker_read_connection_ref: null, broker_read_asset_ref: null };
  await assert.rejects(service.prepare(recreated, async () => { tokenReads++; return { accessToken: 'FICTITIOUS' }; }, new Map()), { code: 'broker_binding_invalid' });
  assert.equal(tokenReads, 0);
});
test('writer adapter requires a durable operation ID, its own client/gate and repeated caller authorization', async () => {
  const { randomUUID } = require('node:crypto');
  const input = { operationId: randomUUID(), reviewId: 'review_1', comment: 'FICTITIOUS_REPLY' };
  let writes = 0, enabled = true, authorized = true, revokeAfter = false, guards = 0;
  const service = createBusinessProfileBroker({ enabled: () => true, writesEnabled: () => enabled,
    client: { execute() { throw Error('READER_KEY_CANNOT_WRITE'); } },
    writerClient: { async execute(command) {
      writes++; assert.equal(command.operation, 'google.business_profile.review.reply.update.v1');
      assert.equal(command.payload.operationId, input.operationId);
      if (revokeAfter) authorized = false;
      return { data: { operationId: input.operationId, kind: 'replyUpdate', state: 'applied', result: { comment: input.comment } } };
    } }, loadLocation: async () => managed, loadManagedBinding: async () => record });
  const context = await service.prepare(managed, () => { throw Error('LEGACY_FORBIDDEN'); }, new Map());
  const beforeExecute = async () => { guards++; if (!authorized) throw Object.assign(Error(), { code: 'scope_denied' }); };
  await assert.rejects(service.write(managed, context, 'replyUpdate', input), { code: 'broker_binding_invalid' });
  await assert.rejects(service.write(managed, {}, 'replyUpdate', input, { beforeExecute }), { code: 'broker_binding_invalid' });
  const { operationId, ...missingId } = input;
  await assert.rejects(service.write(managed, context, 'replyUpdate', missingId, { beforeExecute }), { code: 'invalid_request' });
  enabled = false;
  await assert.rejects(service.write(managed, context, 'replyUpdate', input, { beforeExecute }), { code: 'broker_cohort_disabled' });
  assert.equal(writes, 0); enabled = true;
  assert.equal((await service.write(managed, context, 'replyUpdate', input, { beforeExecute })).data.state, 'applied');
  assert.equal(guards, 2); assert.equal(writes, 1);
  revokeAfter = true;
  await assert.rejects(service.write(managed, context, 'replyUpdate', input, { beforeExecute }), { code: 'scope_denied' });
  assert.equal(guards, 4); assert.equal(writes, 2);
});
test('writer rechecks mapping and revocation after authorization awaits and after the provider returns', async () => {
  const input = { operationId: require('node:crypto').randomUUID() };
  for (const phase of ['authorization', 'provider']) {
    let current = { ...managed }, revoked = false, calls = 0;
    const service = createBusinessProfileBroker({ enabled: () => true, writesEnabled: () => true, client: {},
      writerClient: { async execute() {
        calls++; revoked = true;
        return { data: { operationId: input.operationId, kind: null, state: 'not_found', result: null } };
      } }, loadLocation: async () => current, loadManagedBinding: async () => record, loadRevocation: async () => revoked ? {} : null });
    const context = await service.prepare(managed, () => { throw Error(); }, new Map());
    await assert.rejects(service.write(managed, context, 'status', input, { beforeExecute: async () => {
      if (phase === 'authorization') current = { ...current, google_connection_id: 999 };
    } }), { code: phase === 'authorization' ? 'broker_binding_invalid' : 'asset_revoked' });
    assert.equal(calls, phase === 'authorization' ? 0 : 1);
  }
});
