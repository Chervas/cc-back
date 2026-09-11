'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { selectedByWorkspace, workspaceAccounts, loadWorkspaceInventory } = require('../../services/campaignWorkspace.service');

const campaign = { provider: 'google_ads', account_id: '123', campaign_id: '42', clinicId: null };
const inventory = { selectedClinics: [{ id_clinica: 1, grupoClinicaId: 5 }, { id_clinica: 2, grupoClinicaId: 5 }],
  authorizedGroups: [5], google: [{ customerId: '123', assignmentScope: 'group', grupoClinicaId: 5 }], meta: [] };
const account = { provider: 'google_ads', account_id: '123', include_future: false, campaign_ids: ['42'] };

test('an unassigned campaign keeps its group selection even in a CSV aggregate', () => {
  const settings = [{ scope_type: 'group', scope_id: 5, accounts: [] }];
  assert.equal(selectedByWorkspace(campaign, inventory, settings, { clinicIds: [1, 2] }), false);
  assert.equal(selectedByWorkspace(campaign, inventory, [{ ...settings[0], accounts: [account] }], { clinicIds: [1, 2] }), true);
});
test('clinic settings override group selection without changing the group workspace', () => {
  const settings = [{ scope_type: 'group', scope_id: 5, accounts: [account] }, { scope_type: 'clinic', scope_id: 1, accounts: [] }];
  assert.equal(selectedByWorkspace({ ...campaign, clinicId: 1 }, inventory, settings, { clinicIds: [1] }), false);
  assert.equal(selectedByWorkspace(campaign, inventory, settings, { groupId: 5, clinicIds: [1, 2] }), true);
});
test('existing accounts remain visible before workspace configuration is explicitly saved', () => {
  assert.equal(selectedByWorkspace(campaign, inventory, [], { clinicIds: [1, 2] }), true);
});
test('public account summaries deduplicate mappings and never return tokens or connection identifiers', () => {
  const google = [{ customerId: '123', descriptiveName: 'Cuenta', googleConnectionId: 7, accessToken: 'secret', currencyCode: 'EUR' }];
  const result = workspaceAccounts([...google, ...google], [{ metaAssetId: 'act_456', metaAssetName: 'Meta', pageAccessToken: 'secret' }]);
  assert.equal(result.length, 2); assert.equal(result[1].id, '456'); assert.equal(result[1].currency, null);
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('Connection'), false);
});
test('a formatted owner outside scope produces an account notice, never campaign metadata or implicit clinic ownership', async () => {
  const local = { id: 1, customerId: '1234567890', descriptiveName: 'Connected account', assignmentScope: 'clinic', clinicaId: 1 };
  const outside = { id: 2, customerId: '123-456-7890', descriptiveName: 'Private other owner', assignmentScope: 'clinic', clinicaId: 3 };
  let ownerQuery = null;
  const models = {
    Clinica: { findAll: async () => [{ id_clinica: 1, estado_clinica: 1 }] },
    ClinicGoogleAdsAccount: { findAll: async options => {
      if (options.where[Op.or]) return [local];
      ownerQuery = options; return [local, outside].filter(row => options.where.customerId[Op.in].includes(row.customerId));
    } },
    ClinicMetaAsset: { findAll: () => assert.fail('a Google account review must not read Meta accounts') },
    GoogleAdsAdInventory: { findAll: async () => [{ customerId: '1234567890', campaignId: '42', campaignName: 'Private current name',
      campaignStatus: 'ENABLED', observedAt: '2026-09-11T02:00:00Z' }] },
    ExternalCampaignAssignment: { findAll: async () => [] },
    ExternalCampaignInventory: { findAll: async () => [{ provider: 'google_ads', customer_id: '1234567890', campaign_id: '42',
      campaign_name: 'Private campaign', destination_detection: { urls: ['https://private.example/'] } }] },
  };
  const result = await loadWorkspaceInventory({ models, scope: { clinicIds: [1] }, accountReference: { provider: 'google_ads', account_id: '1234567890' } });
  assert.ok(ownerQuery.where.customerId[Op.in].includes('123-456-7890'));
  assert.equal(result.accounts[0].sharedOutsideScope, true); assert.deepEqual(result.campaigns, []);
  assert.doesNotMatch(JSON.stringify({ accounts: result.accounts, campaigns: result.campaigns }), /Private|private.example/);
});

test('a Meta destination cache preserves the newer nightly entity status instead of freezing an active campaign', async () => {
  const models = {
    Clinica: { findAll: async () => [{ id_clinica: 1, estado_clinica: 1 }] },
    ClinicGoogleAdsAccount: { findAll: async () => [] },
    ClinicMetaAsset: { findAll: async () => [{ id: 1, metaAssetId: 'act_456', assignmentScope: 'clinic', clinicaId: 1 }] },
    ExternalCampaignAssignment: { findAll: async () => [] },
    ExternalCampaignInventory: { findAll: async () => [{ provider: 'meta_ads', customer_id: '456', campaign_id: '42',
      campaign_name: 'Old name', status: 'ACTIVE', last_seen_at: '2026-09-09T02:00:00Z',
      destination_detection: { kind: 'web', urls: ['https://example.org/'] } }] },
    SocialAdsEntity: { findAll: async () => [{ ad_account_id: 'act_456', entity_id: '42', name: 'Current name',
      status: 'PAUSED', updated_at: '2026-09-10T02:00:00Z' }] },
  };
  const result = await loadWorkspaceInventory({ models, scope: { clinicIds: [1] } });
  assert.equal(result.campaigns.length, 1); assert.equal(result.campaigns[0].paused, true);
  assert.equal(result.campaigns[0].name, 'Current name'); assert.equal(result.campaigns[0].destination, 'web');
});

test('newer Google ad observations update parent state, preserve destinations and respect future-campaign selection', async () => {
  for (const newer of [true, false]) {
    const models = {
      Clinica: { findAll: async () => [{ id_clinica: 1, estado_clinica: 1 }] },
      ClinicGoogleAdsAccount: { findAll: async () => [{ id: 1, customerId: '123', assignmentScope: 'clinic', clinicaId: 1 }] },
      ClinicMetaAsset: { findAll: async () => [] }, ExternalCampaignAssignment: { findAll: async () => [] },
      ExternalCampaignInventory: { findAll: async () => [{ provider: 'google_ads', customer_id: '123', campaign_id: '42',
        campaign_name: 'Old name', status: 'PAUSED', last_seen_at: '2026-09-10T02:00:00Z',
        destination_detection: { kind: 'web', urls: ['https://example.org/'] } }] },
      GoogleAdsAdInventory: { findAll: async options => {
        assert.equal(options.where.present, true); assert.ok(options.where.customerId[Op.in].includes('123'));
        return [{ customerId: '123', campaignId: '42', campaignName: 'Current name', campaignStatus: 'ENABLED',
          observedAt: newer ? '2026-09-11T02:00:00Z' : '2026-09-09T02:00:00Z' },
        { customerId: '123', campaignId: '43', campaignName: 'New campaign', campaignStatus: 'ENABLED', observedAt: '2026-09-11T02:00:00Z' }];
      } },
    };
    const scope = { clinicIds: [1] }; const result = await loadWorkspaceInventory({ models, scope });
    const parent = result.campaigns.find(row => row.campaign_id === '42');
    assert.equal(parent.name, newer ? 'Current name' : 'Old name'); assert.equal(parent.paused, !newer);
    assert.equal(parent.destination, 'web'); assert.equal(result.campaigns.length, 2);
    const added = result.campaigns.find(row => row.campaign_id === '43');
    const settings = [{ scope_type: 'clinic', scope_id: 1, accounts: [account] }];
    assert.equal(selectedByWorkspace(added, result, settings, scope), false);
    settings[0].accounts[0] = { ...account, include_future: true };
    assert.equal(selectedByWorkspace(added, result, settings, scope), true);
  }
});
