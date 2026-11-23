'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createService } = require('../../services/whatsappPhoneActivation.service');
const { safe } = require('../../services/whatsappOnboardingGateway.service');
const { createWhatsappOnboardingBrokerClient } = require('../../lib/whatsappOnboardingBrokerClient');
const A = require('../../../services/integrations-broker/src/whatsapp-activation-contract');

const now = new Date('2026-11-22T17:20:00.000Z');
const coexistence = {
  phoneId: '401', displayPhoneNumber: '+34000000000', verifiedName: 'Fixture',
  status: 'CONNECTED', codeVerificationStatus: 'VERIFIED', qualityRating: 'GREEN',
  platformType: 'CLOUD_API', isOnBizApp: true,
};
const cloudOnly = { ...coexistence, isOnBizApp: false };

function fixture({ mode = 'coexistence', scopeType = 'clinic' } = {}) {
  const context = {
    requestId: randomUUID(), mode, scope: { type: scopeType, id: 123 },
    clinicIds: scopeType === 'clinic' ? [123] : [123, 124], channelRole: 'primary',
  };
  const actor = { requestId: context.requestId, userId: 7, sessionRef: randomUUID(), sessionExpiresAt: +now / 1000 + 1800 };
  const state = { profile: coexistence, activationProfile: coexistence, remoteActive: false,
    reads: 0, activations: 0, transactions: 0, catalogs: [], audits: [], templates: [] };
  const assets = new Map();
  const activations = new Map();
  function model(values) {
    return { ...values, async update(patch) { Object.assign(this, patch); return this; } };
  }
  const sequelize = {
    connectionManager: { async getConnection() { return { query(sql, cb) { cb(null, [{ held: 1 }]); } }; },
      async releaseConnection() {} },
    async transaction(work) { state.transactions++; return work({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const models = {
    sequelize,
    ClinicMetaAsset: {
      async findByPk(id) { return assets.get(id); },
      async findAll() { return [...assets.values()]; },
      async create(values) { const row = model({ id: 9, ...values }); assets.set(row.id, row); return row; },
    },
    WhatsappPhoneActivation: {
      async findByPk(id) { return activations.get(id); },
      async findAll() { return [...activations.values()]; },
      async create(values) { const row = model(values); activations.set(row.authorization_id, row); return row; },
    },
  };
  function remote(profile, active, assetId = null) {
    return { flowId: context.requestId, scopeKey: context.scope.type + ':' + context.scope.id, clinicIds: context.clinicIds,
      connectionRef: A.connectionRef(context.requestId), phoneId: '401', wabaId: '501', channelRole: 'primary', state: active ? 'active' : 'prepared',
      profile, assetId, observedAt: +now, activatedAt: active ? +now : null };
  }
  const service = createService({
    models, now: () => now, guard() {}, enabled: () => true,
    states: { async resume() { return structuredClone(context); } },
    broker: {
      async profile() { state.reads++; return remote(state.profile, state.remoteActive, state.remoteActive ? 9 : null); },
      async activate(_context, assetId) { state.activations++; return remote(state.activationProfile, true, assetId); },
    },
    audit: { async health() { return { pending: 0, oldestAgeSeconds: 0 }; },
      async append(event) { state.audits.push(event); } },
    publish: catalog => state.catalogs.push(catalog),
    async enqueueTemplates({ activation }) { state.templates.push(activation); },
  });
  return { service, context, actor, state, assets, activations };
}

test('explicit clinic and group coexistence never persist or activate without the exact Business App profile', async () => {
  for (const scopeType of ['clinic', 'group']) {
    for (const profile of [cloudOnly, { ...coexistence, isOnBizApp: null },
      { ...coexistence, platformType: 'ON_PREMISE' }, { ...coexistence, platformType: null }, null]) {
      const f = fixture({ scopeType });
      f.state.profile = profile;
      await assert.rejects(f.service.complete(f.actor), { code: 'whatsapp_coexistence_profile_unverified', status: 409 });
      assert.deepEqual(safe({ code: 'whatsapp_coexistence_profile_unverified' }),
        { code: 'whatsapp_coexistence_profile_unverified', status: 409, outcomeUnknown: false });
      assert.equal(f.state.reads, 1);
      assert.equal(f.state.activations + f.state.transactions + f.state.catalogs.length + f.state.audits.length + f.state.templates.length, 0);
    }
  }
});

test('an incompatible profile returned from activation cannot publish the prepared receipt as active', async () => {
  const f = fixture();
  f.state.activationProfile = cloudOnly;
  await assert.rejects(f.service.complete(f.actor), { code: 'whatsapp_coexistence_profile_unverified' });
  assert.equal(f.state.activations, 1);
  assert.equal(f.assets.get(9).isActive, false);
  assert.equal(f.activations.get(f.context.requestId).state, 'prepared');
  assert.equal(f.state.catalogs[0].connections[0].sendEnabled, false);
  assert.equal(f.state.templates.length, 0);
});

test('a previously active authorization and its assignments survive an incompatible refresh without writes', async () => {
  const f = fixture();
  await f.service.complete(f.actor);
  const asset = f.assets.get(9);
  asset.additionalData.routing = { allowed: [123], defer: true };
  const before = JSON.stringify(asset);
  const activationBefore = JSON.stringify(f.activations.get(f.context.requestId));
  const snapshot = { transactions:f.state.transactions, activations:f.state.activations, catalogs:f.state.catalogs.length };
  f.state.remoteActive = true;
  f.state.profile = { ...coexistence, isOnBizApp: null };
  await assert.rejects(f.service.complete(f.actor), { code: 'whatsapp_coexistence_profile_unverified' });
  assert.equal(JSON.stringify(asset), before);
  assert.equal(JSON.stringify(f.activations.get(f.context.requestId)), activationBefore);
  assert.deepEqual({ transactions:f.state.transactions, activations:f.state.activations, catalogs:f.state.catalogs.length }, snapshot);
  f.state.profile = coexistence;
  assert.equal((await f.service.complete(f.actor)).assetId, asset.id);
  assert.deepEqual(asset.additionalData.routing, { allowed: [123], defer: true });
  assert.equal(f.state.activations, 1);
});

test('valid coexistence, historical mode-NULL and explicit Cloud continue through ordinary completion', async () => {
  for (const mode of ['coexistence', null, 'cloud_api']) {
    const f = fixture({ mode });
    if (mode !== 'coexistence') f.state.profile = f.state.activationProfile = cloudOnly;
    const result = await f.service.complete(f.actor);
    assert.equal(result.connected, true);
    assert.equal(f.assets.get(result.assetId).additionalData.whatsappConnectionMode, mode || 'cloud_api');
    assert.equal(f.activations.get(f.context.requestId).state, 'active');
    assert.equal(f.state.templates.length, 1);
  }
});

test('only the pinned gateway sends the server-bound coexistence mode on profile and activation', async () => {
  const f = fixture();
  const binding = { connectionRef:'wa-test-fictitious', scopeKey:'clinic:123', clinicIds:[123], appId:'101', configId:'102',
    redirectUri:'https://example.invalid/callback', scopes:['whatsapp_business_management','whatsapp_business_messaging'] };
  const row = { ...f.context, status:'claimed', expiresAt:now.toISOString(),
    scopeDigest:'a'.repeat(64), clinicSetDigest:require('node:crypto').createHash('sha256').update('[123]').digest('hex') };
  const observed = [];
  function client(pin) {
    return createWhatsappOnboardingBrokerClient({ guard() {}, loadBinding: async () => binding,
      activationModePinEnabled:pin, client:{ async execute(command) {
        observed.push(command);
        return {requestId:command.requestId,replayed:false,data:{ flowId:row.requestId,connectionRef:A.connectionRef(row.requestId),
          scopeKey:binding.scopeKey,clinicIds:binding.clinicIds,phoneId:coexistence.phoneId,wabaId:'501',channelRole:'primary',
          assetId:command.operation === A.ACTIVATE ? 9 : null, state:'prepared',profile:coexistence,observedAt:+now,activatedAt:null }};
      } } });
  }
  await client(false).profile(row);
  await client(true).profile(row);
  await client(true).activate(row,9);
  await client(true).activationStatus(row);
  const { mode, ...legacy } = row;
  await client(true).profile(legacy);
  await client(true).profile({ ...row, mode:'cloud_api' });
  assert.deepEqual(observed.map(command => command.payload.mode), [undefined,mode,mode,undefined,undefined,undefined]);
  assert(observed.every(command => command.tenantRef === 'clinic:123' && command.assetRef === 'wa-enroll:clinic:123'));
});
