'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../../services/campaignDestinationGoogleAds.service');

const URL = 'https://example.com/cita/implantes/';

test('Search changes final URLs at ad level and never at campaign level', () => {
  const operations = adapter.buildOperations({
    state: {
      customer_id: '1234567890', campaign_id: '91', family: 'google_search',
      campaign: { resource_name: 'customers/1234567890/campaigns/91', asset_automation_settings: [] },
      entities: [
        { resource_name: 'customers/1234567890/ads/1', final_urls: ['https://old.test/'] },
        { resource_name: 'customers/1234567890/ads/2', final_urls: ['https://old.test/'] },
      ],
    },
    desired: { destination_url: URL, pmax_url_expansion: 'not_applicable' },
  });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].path, 'customers/1234567890/ads:mutate');
  assert.deepEqual(operations[0].data.operations.map((item) => item.update.finalUrls), [[URL], [URL]]);
  assert.ok(operations[0].data.operations.every((item) => item.updateMask === 'final_urls'));
});

test('PMax changes asset groups and persists an explicit URL-expansion decision', () => {
  const operations = adapter.buildOperations({
    state: {
      customer_id: '1234567890', campaign_id: '92', family: 'google_pmax',
      campaign: {
        resource_name: 'customers/1234567890/campaigns/92',
        asset_automation_settings: [{ assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_IN' }],
      },
      entities: [{ resource_name: 'customers/1234567890/assetGroups/7', final_urls: ['https://old.test/'] }],
    },
    desired: { destination_url: URL, pmax_url_expansion: 'disabled' },
  });
  assert.deepEqual(operations.map((item) => item.path), [
    'customers/1234567890/assetGroups:mutate',
    'customers/1234567890/campaigns:mutate',
  ]);
  const settings = operations[1].data.operations[0].update.assetAutomationSettings;
  assert.ok(settings.some((item) => item.assetAutomationType === adapter.EXPANSION_TYPE && item.assetAutomationStatus === 'OPTED_OUT'));
  assert.ok(settings.some((item) => item.assetAutomationType === 'TEXT_ASSET_AUTOMATION' && item.assetAutomationStatus === 'OPTED_IN'));
  assert.throws(
    () => adapter.buildOperations({
      state: {
        customer_id: '1234567890', campaign_id: '92', family: 'google_pmax',
        campaign: { resource_name: 'customers/1234567890/campaigns/92', asset_automation_settings: [] },
        entities: [{ resource_name: 'customers/1234567890/assetGroups/7', final_urls: [] }],
      },
      desired: { destination_url: URL, pmax_url_expansion: 'pending' },
    }),
    (error) => error.code === 'PMAX_URL_EXPANSION_REQUIRED'
  );
});

test('readback requires every entity and the exact PMax expansion state', () => {
  const account = { family: 'google_pmax', pmaxUrlExpansion: 'disabled' };
  const state = {
    family: 'google_pmax',
    entities: [{ final_urls: [URL] }, { final_urls: [URL] }],
    pmax_url_expansion_status: 'OPTED_OUT',
  };
  assert.equal(adapter.verifyState({ state, account, destinationUrl: URL }).verified, true);
  assert.equal(adapter.verifyState({ state: { ...state, pmax_url_expansion_status: 'OPTED_IN' }, account, destinationUrl: URL }).verified, false);
  assert.equal(adapter.verifyState({ state: { ...state, entities: [{ final_urls: [URL, 'https://other.test/'] }] }, account, destinationUrl: URL }).verified, false);
});

test('provider inspection reads Search ads and rejects a family mismatch', async () => {
  const calls = [];
  const dependencies = {
    resolveRuntime: async () => ({ accessToken: 'secret', customerId: '1234567890', loginCustomerId: '9999999999' }),
    request: async (_method, path, options) => {
      calls.push({ path, query: options.data.query });
      return {
        results: [{
          campaign: {
            id: '91', resourceName: 'customers/1234567890/campaigns/91', status: 'ENABLED', advertisingChannelType: 'SEARCH',
          },
          adGroupAd: {
            status: 'ENABLED',
            ad: { id: '3', resourceName: 'customers/1234567890/ads/3', finalUrls: ['https://old.test/'] },
          },
        }],
      };
    },
  };
  const state = await adapter.inspect({
    account: { customerId: '1234567890', campaignId: '91', family: 'google_search' },
    binding: { scopeType: 'clinic', clinicaId: 66 },
  }, dependencies);
  assert.equal(state.entities[0].resource_name, 'customers/1234567890/ads/3');
  assert.match(calls[0].query, /RESPONSIVE_SEARCH_AD/);

  await assert.rejects(
    () => adapter.inspect({
      account: { customerId: '1234567890', campaignId: '91', family: 'google_pmax' },
      binding: { scopeType: 'clinic', clinicaId: 66 },
    }, { ...dependencies, request: async () => ({ results: [{ campaign: { resourceName: 'customers/1234567890/campaigns/91', status: 'ENABLED', advertisingChannelType: 'SEARCH' }, assetGroup: { resourceName: 'customers/1234567890/assetGroups/1', status: 'ENABLED', finalUrls: [] } }] }) }),
    (error) => error.code === 'CAMPAIGN_DESTINATION_PROVIDER_IDENTITY_MISMATCH'
  );
});
