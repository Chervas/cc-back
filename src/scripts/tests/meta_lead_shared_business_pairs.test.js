'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('./fixtures/campaign_offline_runtime.cjs');
const { Op } = require('sequelize');
const { brokerPairsForPage } = require('../../services/metaLeadReception.service');
function fixture(registry) {
  const calls = [], bindings = [
    { mapping_id: 10, asset_ref: 'meta-facebook_page:401' }, { mapping_id: 11, asset_ref: 'meta-ad_account:301' },
    { mapping_id: 12, asset_ref: 'meta-facebook_page:402' }, { mapping_id: 13, asset_ref: 'meta-ad_account:302' },
  ];
  const models = { ClinicMetaAsset: { findAll: async ({ where }) => [
    { id: 10, metaAssetId: '401', metaConnectionId: 172 }, { id: 12, metaAssetId: '402', metaConnectionId: 172 },
  ].filter(row => where.metaAssetId[Op.in].includes(row.metaAssetId)) },
  MetaMarketingBrokerBinding: { findAll: async ({ where }) => where.mapping_id
    ? [{ mapping_id: where.mapping_id, enrollment_id: 'FICTITIOUS_SHARED_BS', scope_key: 'group:29', connection_ref: 'meta:fixture' }]
    : bindings },
  CampaignWorkspaceSetting: { findOne: async ({ where }) => {
    assert.deepEqual(where, { scope_type: 'group', scope_id: 29 });
    return { preferences: registry === undefined ? {} : { meta_lead_routes: registry } };
  } } };
  const reader = { preparePair: async (page, account) => { calls.push([page, account]); return { page, account }; }, assertPair: async () => ({}) };
  return { models, reader, calls };
}
const routes = [
  { pageAssetRef: 'meta-facebook_page:401', adAccountAssetRef: 'meta-ad_account:301', recipientClinicId: 72 },
  { pageAssetRef: 'meta-facebook_page:402', adAccountAssetRef: 'meta-ad_account:302', recipientClinicId: 66 },
];
test('two BS pages and two ad accounts share a grant but retain the two explicit page/account pairs', async () => {
  const f = fixture(routes);
  assert.equal((await brokerPairsForPage(f.models, '401', f.reader))[0].accountAssetId, 11);
  assert.equal((await brokerPairsForPage(f.models, '402', f.reader))[0].accountAssetId, 13);
  assert.deepEqual(f.calls, [[10, 11], [12, 13]]);
});
test('absent, empty or foreign registry never guesses one of two accounts', async () => {
  for (const registry of [undefined, [], [{ ...routes[0], adAccountAssetRef: 'meta-ad_account:999' }]]) {
    const f = fixture(registry);
    await assert.rejects(brokerPairsForPage(f.models, '401', f.reader), /meta_lead_account_access_required/);
    assert.equal(f.calls.length, 0);
  }
});
test('a page without an explicit route stays closed even if another page in that group has one', async () => {
  const f = fixture([routes[0]]);
  await assert.rejects(brokerPairsForPage(f.models, '402', f.reader), /meta_lead_account_access_required/);
  assert.equal(f.calls.length, 0);
});
test('ambiguous duplicate page routes are rejected before pair preparation', async () => {
  const f = fixture([routes[0], { ...routes[1], pageAssetRef: routes[0].pageAssetRef }]);
  await assert.rejects(brokerPairsForPage(f.models, '401', f.reader), /meta_lead_route_invalid/);
  assert.equal(f.calls.length, 0);
});
