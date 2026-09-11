'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { googleCampaignReference, inspectGoogleDestinations, googleDestinationContext, refreshGoogleDestinations } = require('../../services/campaignWorkspaceGoogleDestination.service');
const { GOOGLE_ADS_SCOPE } = require('../../services/googleAdsScopedRuntime.service');

const now = new Date('2026-09-11T12:00:00Z');
const reference = { account_id: '20', campaign_id: '30' };
const row = patch => ({ customer: { id: '20' }, campaign: { id: '30' }, ...patch });
const form = id => row({ asset: { id, name: `Form ${id}`, leadFormAsset: { headline: 'Contact' } } });
function discovery() {
  const data = { campaign: [row({ campaign: { id: '30', advertisingChannelType: 'SEARCH' } })],
    ad_group: [row({ adGroup: { id: '40' } })], campaign_asset: [form('50')], customer_asset: [], ad_group_asset: [],
    asset_group: [], asset_group_asset: [], ad_group_ad: [row({ adGroup: { id: '40' }, adGroupAd: { ad: { id: '60', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://clinic.example/visit'] } } })] };
  const calls = [];
  const read = async input => { calls.push(input); return structuredClone(data[input.query.match(/FROM (\w+)/)[1]]); };
  return { data, calls, read, run: () => inspectGoogleDestinations({ reference, accessToken: 'private', read, now }) };
}
test('strict Google references reject ownership, tokens, numeric coercion and injected IDs', () => {
  assert.equal(googleCampaignReference(reference).provider, 'google_ads');
  for (const patch of [{ account_id: 20 }, { campaign_id: '30 OR 1=1' }, { clinic_id: 1 }, { token: 'secret' }, { revision: 'bad' }]) {
    assert.throws(() => googleCampaignReference({ ...reference, ...patch }), /invalid_google_destination/);
  }
});
test('Google configuration discovery includes web and native paths without reading submissions or changing ads', async () => {
  const h = discovery(); const result = await h.run();
  assert.equal(result.kind, 'mixed'); assert.equal(result.complete, true);
  assert.deepEqual(result.forms.map(value => value.form_id), ['50']); assert.deepEqual(result.urls, ['https://clinic.example/visit']);
  assert.ok(h.calls.every(call => call.query.startsWith('SELECT') && /LIMIT 2001$/.test(call.query) && call.timeoutMs <= 50000));
  assert.ok(!JSON.stringify(h.calls.map(call => call.query)).match(/submission|webhook|delivery_method|phone|email/));
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('specific form links override inherited ones while other groups retain their inherited coverage', async () => {
  const h = discovery(); h.data.customer_asset = [form('49')];
  h.data.ad_group_asset = [row({ ...form('51'), adGroup: { id: '40' } })];
  let result = await h.run(); assert.deepEqual(result.forms.map(value => value.form_id), ['51']);
  h.data.ad_group.push(row({ adGroup: { id: '41' } }));
  result = await h.run(); assert.deepEqual(result.forms.map(value => value.form_id), ['50', '51']);
  h.data.campaign_asset = [];
  result = await h.run(); assert.deepEqual(result.forms.map(value => value.form_id), ['49', '51']);
});
test('PMax includes asset group desktop and mobile URLs and does not claim exhaustive dynamic destinations', async () => {
  const h = discovery(); h.data.campaign[0].campaign.advertisingChannelType = 'PERFORMANCE_MAX';
  h.data.ad_group_ad = []; h.data.ad_group = [];
  h.data.asset_group = [row({ assetGroup: { id: '80', campaign: 'customers/20/campaigns/30',
    finalUrls: ['https://clinic.example/visit'], finalMobileUrls: ['https://clinic.example/mobile'] } })];
  let result = await h.run(); assert.equal(result.complete, false); assert.ok(result.unknown_reasons.includes('dynamic_web_destinations'));
  assert.equal(result.urls.length, 2);
  h.data.campaign[0].campaign.urlExpansionOptOut = true;
  result = await h.run(); assert.equal(result.complete, true);
});
test('foreign identities, partial responses and malformed form metadata fail the whole check', async () => {
  for (const mutate of [h => { h.data.campaign_asset[0].customer.id = '99'; },
    h => { h.data.ad_group_ad[0].campaign.id = '99'; }, h => { h.data.campaign_asset[0].asset.leadFormAsset = {}; },
    h => { h.data.ad_group = Array(2001).fill(row({ adGroup: { id: '40' } })); }]) {
    const h = discovery(); mutate(h); await assert.rejects(h.run(), /workspace_google_/);
  }
});
test('unsafe URLs, calls and missing ads remain incomplete instead of proving form coverage', async () => {
  for (const url of ['javascript:alert(1)', 'https://user:password@clinic.example/']) {
    const h = discovery(); h.data.ad_group_ad[0].adGroupAd.ad.finalUrls = [url];
    const result = await h.run(); assert.equal(result.complete, false); assert.deepEqual(result.urls, []);
  }
  const h = discovery(); h.data.ad_group_ad[0].adGroupAd.ad.type = 'CALL_AD';
  assert.equal((await h.run()).complete, false);
  h.data.ad_group_ad = []; assert.ok((await h.run()).unknown_reasons.includes('no_ads'));
});

function runtime() {
  const h = discovery();
  const setting = { id: 'setting', scope_type: 'clinic', scope_id: 1, accounts: [{ provider: 'google_ads', account_id: '20', include_future: true, campaign_ids: [] }] };
  const clinic = { id_clinica: 1, estado_clinica: true };
  const campaign = { ...reference, provider: 'google_ads', id: 'google_ads:20:30', assigned: true, clinicId: 1 };
  const state = { setting, assignments: [{ id: 1, scopeKey: 'clinic:1', status: 'active', googleConnectionId: 7 }],
    cached: { id: 1, destination_detection: { legacy_urls: true } }, writes: [], permitted: true, beforeRead: null };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = { sequelize: { transaction: async fn => fn(transaction) }, Clinica: { findByPk: async () => clinic },
    CampaignWorkspaceSetting: { findOne: async () => state.setting, findByPk: async () => state.setting, findAll: async () => [state.setting] },
    ClinicGoogleAdsAccount: { findAll: async () => [{ id: 1, customerId: '20', assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 7 }] },
    GoogleConnectionAssignment: { findAll: async () => state.assignments },
    GoogleConnection: { findByPk: async () => ({ id: 7, accessToken: 'private', expiresAt: '2099-01-01', scopes: GOOGLE_ADS_SCOPE }) },
    ExternalCampaignAssignment: { findAll: async () => [] },
    ExternalCampaignInventory: { findAll: async () => [state.cached], update: async (value, options) => {
      assert.equal(options.transaction, transaction); state.writes.push(value); state.cached = { ...state.cached, ...value };
    } },
  };
  const dependencies = { models, scope: { clinicIds: [1] }, actorId: 7, loadInventory: async () => ({ campaigns: [campaign] }),
    hasAccess: async () => state.permitted, now: () => now, ensureToken: async () => ({ accessToken: 'private' }),
    read: async input => { state.beforeRead?.(); return h.read(input); } };
  const context = () => googleDestinationContext({ ...dependencies, reference: googleCampaignReference(reference), now });
  return { ...h, state, dependencies, context,
    run: async revision => refreshGoogleDestinations({ ...dependencies, input: { ...reference, revision: revision || (await context()).revision } }) };
}
test('refresh writes only versioned destination metadata and preserves other caches', async () => {
  const h = runtime(); await h.run();
  assert.equal(h.state.writes.length, 2);
  assert.equal(h.state.cached.destination_detection.legacy_urls, true);
  assert.equal(h.state.cached.destination_detection.workspace_google.status, 'checked');
  assert.ok(h.state.cached.destination_detection.workspace_google.access_fingerprint);
  assert.ok(!JSON.stringify(h.state.writes).includes('private'));
});
test('revoked write access, stale revision and unselected accounts cannot start provider IO', async () => {
  for (const mutate of [h => { h.state.permitted = false; }, h => { h.state.setting.accounts = []; }]) {
    const h = runtime(); mutate(h); await assert.rejects(h.run()); assert.equal(h.calls.length, 0); assert.equal(h.state.writes.length, 0);
  }
  const h = runtime(); await assert.rejects(h.run('a'.repeat(64)), /conflict/); assert.equal(h.calls.length, 0);
});
test('scope changes during a query cannot commit a successful destination proof', async () => {
  for (const mutate of [h => { h.state.permitted = false; }, h => { h.state.assignments = []; }]) {
    const h = runtime(); h.state.beforeRead = () => mutate(h); await assert.rejects(h.run());
    assert.equal(h.state.writes.length, 1); assert.equal(h.state.cached.destination_detection.workspace_google.complete, false);
  }
});
test('provider failures replace old green metadata with a sanitized failed check', async () => {
  const h = runtime(); h.dependencies.read = async () => { throw Object.assign(new Error('private token'), { status: 403 }); };
  await h.run(); const detection = h.state.cached.destination_detection.workspace_google;
  assert.equal(detection.status, 'failed'); assert.equal(detection.complete, false); assert.equal(detection.forms.length, 0);
  assert.ok(!JSON.stringify(detection).includes('private'));
});
