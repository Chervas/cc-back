'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
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
