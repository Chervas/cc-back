'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('node:net').Socket.prototype.connect = () => { throw Error('OFFLINE_NETWORK_FORBIDDEN'); };
global.fetch = () => { throw Error('OFFLINE_PROVIDER_FORBIDDEN'); };
const { Op } = require('sequelize');
const destination = require('../../services/campaignWorkspaceMetaDestination.service');
const { createMetaMarketingBrokerScope } = require('../../services/metaMarketingBrokerScope.service');
const { createMetaMarketingLeadReader } = require('../../services/metaMarketingLeadReader.service');
const { loadRoute } = require('../../services/metaLeadRoutes.service');
const L = require('../../../services/integrations-broker/src/meta-marketing-leads-contract');

const ENROLLMENT = '11111111-1111-4111-8111-111111111111';
const FLOW = '22222222-2222-4222-8222-222222222222';
const ROUTES = [
  { pageAssetRef: 'meta-facebook_page:162719417401326', adAccountAssetRef: 'meta-ad_account:5651594564879938', recipientClinicId: 72 },
  { pageAssetRef: 'meta-facebook_page:100586185397014', adAccountAssetRef: 'meta-ad_account:3133071486929859', recipientClinicId: 66 },
];

function fixture() {
  const state = { routes: structuredClone(ROUTES), denied: false, prepared: [], asserted: [], calls: [], caches: new Map(), transactions: 0 };
  const resources = [
    [391, 'ad_account', '5651594564879938'], [401, 'ad_account', '3133071486929859'],
    [402, 'facebook_page', '162719417401326'], [403, 'facebook_page', '100586185397014'],
  ];
  const mappings = resources.map(([id, assetType, metaAssetId]) => ({ id, assetType, metaAssetId,
    metaConnectionId: 172, assignmentScope: 'group', clinicaId: null, grupoClinicaId: 29, isActive: true, credentials_absent: 1 }));
  const bindings = mappings.map(row => ({ mapping_id: row.id, enrollment_id: ENROLLMENT,
    asset_ref: `meta-${row.assetType}:${row.metaAssetId}`, meta_connection_id: 172, meta_user_id: '201', app_id: '101',
    connection_ref: 'meta:fixture', scope_key: 'group:29', tenant_clinic_id: 66, parent_page_id: null, state: 'active' }));
  const clinics = [{ id_clinica: 66, grupoClinicaId: 29, estado_clinica: 1 }, { id_clinica: 72, grupoClinicaId: 29, estado_clinica: 1 }];
  const setting = () => ({ id: 'setting', version: 1, scope_type: 'group', scope_id: 29,
    accounts: ROUTES.map(row => ({ provider: 'meta_ads', account_id: row.adAccountAssetRef.split(':')[1], include_future: true, campaign_ids: [] })),
    preferences: state.routes === undefined ? {} : { meta_lead_routes: structuredClone(state.routes) } });
  const campaigns = ROUTES.map((route, index) => ({ id: `meta_ads:${route.adAccountAssetRef.split(':')[1]}:${700 + index}`,
    provider: 'meta_ads', account_id: route.adAccountAssetRef.split(':')[1], campaign_id: String(700 + index),
    clinicId: route.recipientClinicId, assigned: true, status: 'PAUSED', name: 'Fictitious campaign', accountName: 'Fictitious account' }));
  const models = {
    GrupoClinica: { findByPk: async () => ({ id_grupo: 29 }) },
    Clinica: { findAll: async () => clinics, findByPk: async id => clinics.find(row => row.id_clinica === Number(id)) },
    CampaignWorkspaceSetting: { findOne: async () => setting() },
    ClinicMetaAsset: { findAll: async ({ where }) => mappings.filter(row => row.assetType === 'ad_account'
      && where.metaAssetId[Op.in].includes(row.metaAssetId)) },
    MetaMarketingBrokerBinding: { findAll: async ({ where }) => {
      if (where.mapping_id) return bindings.filter(row => row.mapping_id === where.mapping_id);
      return bindings.filter(row => row.asset_ref.startsWith('meta-facebook_page:')
        && ['enrollment_id', 'scope_key', 'connection_ref', 'meta_connection_id', 'state'].every(key => row[key] === where[key]));
    } },
    ExternalCampaignInventory: {
      findAll: async ({ where }) => { const row = state.caches.get(where.campaign_id); return row ? [structuredClone(row)] : []; },
      create: async value => { state.caches.set(value.campaign_id, { id: Number(value.campaign_id), ...structuredClone(value) }); },
      update: async (value, { where }) => {
        const entry = [...state.caches].find(([, row]) => row.id === where.id); assert(entry);
        state.caches.set(entry[0], { ...entry[1], ...structuredClone(value) });
      },
    },
    sequelize: { transaction: async fn => { state.transactions++; state.beforeTransaction?.(state.transactions); return fn({ LOCK: { UPDATE: 'UPDATE' } }); } },
  };
  const scope = createMetaMarketingBrokerScope({
    enabled: () => true,
    loadMapping: async id => mappings.find(row => row.id === id),
    loadBindings: async (ref, id) => bindings.filter(row => ref ? row.asset_ref === ref : row.mapping_id === id),
    loadRevocations: async () => state.denied ? [{ tuple_hash: 'revoked' }] : [],
    loadMappings: async requested => mappings.filter(row => `meta-${row.assetType}:${row.metaAssetId}` === requested.assetRef),
    loadClinics: async () => clinics,
    loadShared: async () => [], loadPrimaryGroups: async () => [], loadGrants: async () => { assert.fail('recovery proof required'); },
    loadConnection: async () => ({ id: 172, metaUserId: '201', broker_app_id: '101', credentials_external: 1, credentials_absent: 1 }),
    blocked: async () => true,
    inspectEnrollment: async () => ({ enrollmentId: ENROLLMENT, flowId: FLOW, mappingIds: resources.map(row => row[0]), clinicIds: [66, 72], digest: 'enrollment-v1',
      recovery: { enrollmentId: ENROLLMENT, flowId: FLOW, canonicalConnectionId: 172, appId: '101', subjectId: '201', scopeKey: 'group:29',
        mappingIds: resources.map(row => row[0]), clinicIds: [66, 72] } }),
  });
  const transactionStates = async (pageId, accountId) => ({
    page: pageId === null ? null : await scope.assertContext(await scope.prepare(pageId)),
    account: await scope.assertContext(await scope.prepare(accountId)),
  });
  const usage = { usagePct: 0, nextAllowedAt: 0, pauseUntil: 0 };
  const reader = createMetaMarketingLeadReader({ scope, enabled: () => true, transactionStates,
    loadRoute: (page, account, transaction) => loadRoute({ models, page, account, transaction }),
    client: { execute: async command => {
      state.calls.push(structuredClone(command)); state.beforeRead?.();
      const route = ROUTES.find(row => row.pageAssetRef === command.assetRef);
      assert.equal(command.payload.adAccountAssetRef, route.adAccountAssetRef, 'never contact a Page through another account');
      if (command.operation === L.OPERATIONS.destinations) return { requestId: command.requestId, data: {
        results: [{ id: '801', account_id: route.adAccountAssetRef.split(':')[1], campaign_id: command.payload.campaignId,
          adset_id: '802', effective_status: 'PAUSED', creative: { id: '803', page_id: route.pageAssetRef.split(':')[1], lead_gen_form_id: '804' } }], nextCursor: null, usage } };
      assert.equal(command.operation, L.OPERATIONS.form);
      return { requestId: command.requestId, data: { form: { id: command.payload.formId, page_id: route.pageAssetRef.split(':')[1], name: 'Fictitious form', status: 'ACTIVE' }, usage } };
    } },
  });
  const realPrepare = reader.preparePair, realAssert = reader.assertPair;
  reader.preparePair = async (...args) => { state.prepared.push(args.slice(0, 2)); state.beforePrepare?.(); return realPrepare(...args); };
  reader.assertPair = async (pair, options) => { const result = await realAssert(pair, options); state.asserted.push([result.page.id, result.account.id]); return result; };
  const loadInventory = async () => ({ campaigns, selectedClinics: clinics });
  const context = index => destination.metaCampaignContext({ models, scope: { groupId: 29, clinicIds: [66, 72] },
    reference: campaigns[index], loadInventory, reader });
  const run = (index, overrides = {}) => destination.refreshMetaCampaignDestinations({ models, scope: { groupId: 29, clinicIds: [66, 72] },
    input: { account_id: campaigns[index].account_id, campaign_id: campaigns[index].campaign_id,
      revision: destination.revision(state.caches.get(campaigns[index].campaign_id)?.destination_detection) }, loadInventory, reader, ...overrides });
  return { state, models, reader, campaigns, context, run };
}

test('two accounts and two Pages in one enrollment refresh only their administrative pair using the real context and reader factories', async () => {
  const h = fixture();
  await h.run(0); await h.run(1);
  assert.deepEqual(h.state.prepared, [[402, 391], [403, 401]]);
  assert.equal(h.state.calls.length, 4);
  for (let index = 0; index < 2; index++) {
    const detection = h.state.caches.get(h.campaigns[index].campaign_id).destination_detection;
    assert.equal(detection.complete, true); assert.equal(detection.kind, 'lead_form');
    assert.equal(detection.forms[0].page_id, ROUTES[index].pageAssetRef.split(':')[1]);
    assert.equal(detection.forms[0].metadata_accessible, true);
    assert.equal(detection.forms[0].leads_accessible, undefined);
  }
});

test('the real reader still rejects the cross-account Page; a filter does not weaken pair authority', async () => {
  const h = fixture();
  await assert.rejects(h.reader.preparePair(403, 391), /meta_lead_route_invalid/);
  assert.equal(h.state.calls.length, 0);
  h.state.denied = true;
  await assert.rejects(h.run(0));
  assert.equal(h.state.calls.length, 0);
});

test('an explicit empty registry, foreign Page, or no matching account triggers zero Page preparation/RPC and never verifies Lead readiness', async () => {
  for (const routes of [[], [ROUTES[1]], [{ ...ROUTES[0], pageAssetRef: 'meta-facebook_page:999' }]]) {
    const h = fixture(); h.state.routes = structuredClone(routes);
    await assert.rejects(h.run(0), /workspace_meta_page_connection_required/);
    assert.deepEqual(h.state.prepared, []); assert.deepEqual(h.state.calls, []);
    const detection = h.state.caches.get('700').destination_detection;
    assert.equal(detection.complete, false); assert.equal(detection.check_status, 'failed');
  }
});

test('the existing registry parser rejects malformed/duplicate routes before any Page preparation or provider call', async () => {
  for (const routes of [null, [{ ...ROUTES[0], extra: true }], [ROUTES[0], ROUTES[0]]]) {
    const h = fixture(); h.state.routes = routes;
    await assert.rejects(h.run(0));
    assert.deepEqual(h.state.prepared, []); assert.deepEqual(h.state.calls, []);
    assert.equal(h.state.caches.get('700').destination_detection.complete, false);
  }
});

test('an eligible registered pair denial propagates without falling back to another Page', async () => {
  const h = fixture(), context = await h.context(0);
  h.state.beforePrepare = () => { h.state.denied = true; };
  await assert.rejects(destination.campaignPagePairs({ models: h.models, context }));
  assert.deepEqual(h.state.prepared, [[402, 391]]);
  assert.equal(h.state.calls.length, 0);
});

test('an absent registry preserves the previous scoped Page selection and does not create a global Lead-route gate', async () => {
  const h = fixture(); h.state.routes = undefined;
  const context = await h.context(0), pairs = await destination.campaignPagePairs({ models: h.models, context });
  assert.equal(pairs.length, 2);
  assert.deepEqual(h.state.prepared, [[402, 391], [403, 391]]);
  assert.equal(h.state.calls.length, 0);
  const web = destination.detectDestinations([{ id: '1', creative: { link_url: 'https://example.test/landing' } }], true);
  assert.equal(web.kind, 'web'); assert.equal(web.complete, true); assert.deepEqual(web.forms, []);
});

test('the existing cache revision and administrative registry fences reject changes before a stale result can commit', async () => {
  const stale = fixture();
  await assert.rejects(stale.run(0, { input: { account_id: '5651594564879938', campaign_id: '700', revision: 'f'.repeat(64) } }), /workspace_meta_check_conflict/);
  assert.equal(stale.state.calls.length, 0); assert.equal(stale.state.caches.size, 0);
  const changed = fixture(); changed.state.beforeRead = () => { changed.state.routes = [{ ...ROUTES[0], recipientClinicId: 66 }, ROUTES[1]]; };
  await assert.rejects(changed.run(0), /workspace_meta_check_conflict/);
  assert.equal(changed.state.caches.get('700').destination_detection.complete, false);
});
