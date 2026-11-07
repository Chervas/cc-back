'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { saveRegistry } = require('../../services/metaLeadRoutes.service');
function fixture() {
  const state = { allowed: true, metadata: 0, writes: 0, audits: [], settings: { id: 'routes-setting', version: 1,
    preferences: { mode: 'measurement', signals: { enabled: false, events: [] }, optimization: null } } };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = { MetaMarketingBrokerBinding: { findAll: async ({ where }) => { state.metadata++; return [{ mapping_id: where.asset_ref.startsWith('meta-facebook_page:') ? 10 : 11 }]; } },
    CampaignWorkspaceSetting: { findOne: async () => state.settings, update: async (patch, options) => {
      assert.equal(options.transaction, transaction); assert.equal(options.where.version, state.settings.version);
      state.writes++; Object.assign(state.settings, patch); return [1];
    } }, Clinica: { findByPk: async id => ({ id_clinica: id, grupoClinicaId: 29, estado_clinica: true }) },
    CampaignWorkspaceEvent: { create: async (event, options) => { assert.equal(options.transaction, transaction); state.audits.push(event); } },
    sequelize: { transaction: async work => work(transaction) } };
  const reader = { preparePair: async () => ({}), assertPair: async (_pair, options) => assert.equal(options.transaction, transaction) };
  const scope = { groupId: 29, clinicIds: [66, 72] };
  const value = [{ pageAssetRef: 'meta-facebook_page:401', adAccountAssetRef: 'meta-ad_account:301', recipientClinicId: 66 }];
  const run = (changes = {}) => saveRegistry({ models, reader, scope, actorId: 1, expectedVersion: 1, value,
    authorize: async () => state.allowed, ...changes });
  return { state, run, value };
}
test('explicit routing uses a version CAS, active scoped bindings and one authenticated audit while preserving preferences', async () => {
  const f = fixture(), old = structuredClone(f.state.settings.preferences);
  assert.deepEqual(await f.run(), { changed: true, version: 2 });
  assert.deepEqual(f.state.settings.preferences, { ...old, meta_lead_routes: f.value });
  assert.equal(f.state.writes, 1); assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].actor_user_id, 1); assert.equal(f.state.audits[0].event_type, 'meta_lead_routes_saved');
  assert.deepEqual(await f.run({ expectedVersion: 2 }), { changed: false, version: 2 });
  assert.equal(f.state.writes, 1);
});
test('unauthorized, stale or foreign routing does not write and cannot select a clinic from provider payload', async () => {
  const f = fixture(); f.state.allowed = false;
  await assert.rejects(f.run(), /meta_lead_route_forbidden/); assert.equal(f.state.metadata, 0);
  f.state.allowed = true;
  await assert.rejects(f.run({ expectedVersion: 2 }), /version_conflict/);
  await assert.rejects(f.run({ value: [{ ...f.value[0], recipientClinicId: 99 }] }), /route_invalid/);
  await assert.rejects(f.run({ value: [{ ...f.value[0], inferred: true }] }), /route_invalid/);
  await assert.rejects(f.run({ value: [f.value[0], f.value[0]] }), /route_invalid/);
  assert.equal(f.state.writes, 0); assert.equal(f.state.audits.length, 0);
});
