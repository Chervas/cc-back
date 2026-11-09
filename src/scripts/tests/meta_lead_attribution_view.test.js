'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Op } = require('sequelize');
const { loadMetaLeadAttribution, nativeMetaProof } = require('../../services/metaLeadAttributionView.service');
const { buildLeadAttributionView, buildMarketingOriginWhere } = require('../../lib/lead-attribution-view');

const lead = overrides => ({ id: 1, clinica_id: 7, external_source: 'meta_leadgen', external_id: '501',
  source: 'meta_ads', channel: 'paid', source_detail: 'leadgen_form:602', ...overrides });
const identity = overrides => ({ version: 1, verified_by: 'meta_graph', provider: 'meta_ads', clinic_id: 7,
  account_id: '700', campaign_id: '710', adset_id: '720', ad_id: '730', page_id: '601', form_id: '602', ...overrides });
const audit = overrides => ({ lead_intake_id: 1, identity: identity(), native_provider: 'meta_leadgen',
  native_lead_id: '501', native_form_id: '602', native_page_id: '601', ...overrides });
const entities = () => [
  { ad_account_id: 'act_700', level: 'campaign', entity_id: '710', parent_id: null, name: 'Campaña de prueba' },
  { ad_account_id: '700', level: 'adset', entity_id: '720', parent_id: '710', name: 'Conjunto de prueba' },
  { ad_account_id: '700', level: 'ad', entity_id: '730', parent_id: '720', name: 'Anuncio de prueba' },
];
function modelsFor(audits = [audit()], inventory = entities()) {
  const calls = [];
  const fail = () => { throw Error('writes/provider calls are forbidden'); };
  return { calls, models: {
    LeadAttributionAudit: { async findAll(options) { calls.push(['audits', options]); return audits; }, create: fail, update: fail },
    SocialAdsEntity: { async findAll(options) { calls.push(['inventory', options]); return inventory; }, create: fail, update: fail },
    sequelize: { query: fail, transaction: fail },
  } };
}

test('native paid identity enriches campaign, adset and ad from the same account in two bulk reads', async () => {
  const { models, calls } = modelsFor([
    { lead_intake_id: 1, identity: null, native_provider: null }, audit(),
  ]);
  const result = await loadMetaLeadAttribution({ models, leads: [lead()] });
  const view = buildLeadAttributionView(lead(), result.get('1'));
  assert.equal(view.marketing_origin, 'meta_ads');
  assert.deepEqual(view.marketing_campaign, {
    provider: 'meta_ads', customer_id: '700', external_id: '710', name: 'Campaña de prueba', resolution: 'external_inventory',
    adset_id: '720', adset_name: 'Conjunto de prueba', ad_id: '730', ad_name: 'Anuncio de prueba', page_id: '601', form_id: '602',
  });
  assert.deepEqual(view.meta_form, { provider: 'meta', page_id: '601', form_id: '602', name: null, organic: false });
  assert.equal(calls.length, 2);
  const attrs = calls[0][1].attributes;
  assert.ok(attrs.every(attr => typeof attr === 'string' ? attr === 'lead_intake_id' : Array.isArray(attr)));
  assert.deepEqual(attrs.filter(Array.isArray).map(attr => attr[1]),
    ['identity', 'native_page_id', 'native_provider', 'native_lead_id', 'native_form_id']);
  assert.deepEqual(calls[1][1].where[Op.or][0], {
    ad_account_id: { [Op.in]: ['700', 'act_700'] }, level: 'campaign', entity_id: '710',
  });
});

test('organic native forms retain Meta provenance without becoming paid campaigns', async () => {
  const value = lead({ source: null, channel: 'organic' });
  const { models, calls } = modelsFor([audit({ identity: null })]);
  const result = await loadMetaLeadAttribution({ models, leads: [value] });
  const view = buildLeadAttributionView(value, result.get('1'));
  assert.equal(view.marketing_origin, 'meta_form');
  assert.equal(view.channel, 'organic');
  assert.equal(view.source, null);
  assert.equal(view.marketing_campaign, null);
  assert.equal(view.meta_form.organic, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(buildMarketingOriginWhere('meta_form', Op), { external_source: 'meta_leadgen', channel: 'organic', source: null });
});

test('missing inventory preserves verified IDs instead of fabricating an internal or UTM campaign', async () => {
  const value = lead({ utm_campaign: 'Untrusted campaign name', campana_id: 99, campana: { nombre: 'Other campaign' } });
  const { models } = modelsFor([audit()], []);
  const result = await loadMetaLeadAttribution({ models, leads: [value] });
  const view = buildLeadAttributionView(value, result.get('1'));
  assert.equal(view.marketing_campaign.external_id, '710');
  assert.equal(view.marketing_campaign.name, null);
  assert.equal(view.marketing_campaign.resolution, 'external_id');
  assert.equal(view.campana_id, 99);
});

for (const [label, change] of [
  ['another clinic', { identity: identity({ clinic_id: 8 }) }],
  ['another native lead', { native_lead_id: '502' }],
  ['another form', { native_form_id: '603' }],
  ['another page', { native_page_id: '604' }],
  ['unverified identity', { identity: identity({ verified_by: 'browser' }) }],
  ['malformed adset', { identity: identity({ adset_id: '../720' }) }],
]) test(`rejects receipt from ${label}`, () => {
  assert.equal(nativeMetaProof(lead(), [audit(change)]), null);
});

test('duplicate identical receipts are accepted, conflicting accounts/campaigns are rejected', () => {
  assert.ok(nativeMetaProof(lead(), [audit(), audit()]));
  assert.equal(nativeMetaProof(lead(), [audit(), audit({ identity: identity({ account_id: '701' }) })]), null);
  assert.equal(nativeMetaProof(lead(), [audit(), audit({ identity: identity({ campaign_id: '711' }) })]), null);
  assert.equal(nativeMetaProof(lead(), [audit(), audit({ identity: identity({ adset_id: '721' }) })]), null);
});

test('JSON-extracted scalar representations keep numeric graph IDs as strings', () => {
  const proof = nativeMetaProof(lead(), [audit({ identity: JSON.stringify(identity()), native_provider: '"meta_leadgen"',
    native_lead_id: '"501"', native_form_id: '"602"', native_page_id: '"601"' })]);
  assert.equal(proof.identity.campaign_id, '710');
  assert.ok(nativeMetaProof(lead(), [audit()]));
});

test('foreign account caches cannot enrich even when entity IDs collide', async () => {
  const { models } = modelsFor([audit()], entities().map(row => ({ ...row, ad_account_id: '999', name: 'Foreign private account' })));
  const value = (await loadMetaLeadAttribution({ models, leads: [lead()] })).get('1');
  assert.equal(value.campaign_name, null);
  assert.equal(value.adset_name, null);
  assert.equal(value.ad_name, null);
  assert.doesNotMatch(JSON.stringify(value), /Foreign/);
});

test('stale/ambiguous cached hierarchy cannot supply names', async () => {
  const rows = entities();
  rows[1].parent_id = '999';
  const { models } = modelsFor([audit()], rows);
  const value = (await loadMetaLeadAttribution({ models, leads: [lead()] })).get('1');
  assert.equal(value.adset_name, null);
  assert.equal(value.ad_name, null);
  const duplicate = modelsFor([audit()], [entities()[0], { ...entities()[0], name: 'Conflicting copy' }]);
  assert.equal((await loadMetaLeadAttribution({ models: duplicate.models, leads: [lead()] })).get('1').campaign_name, null);
});

test('several clinics are bulk-read without exchanging their attribution', async () => {
  const second = lead({ id: 2, clinica_id: 8, external_id: '502' });
  const { models, calls } = modelsFor([audit(), audit({ lead_intake_id: 2, native_lead_id: '502', identity: identity({ clinic_id: 8, account_id: '800' }) })]);
  const result = await loadMetaLeadAttribution({ models, leads: [lead(), second] });
  assert.equal(result.get('1').campaign_name, 'Campaña de prueba');
  assert.equal(result.get('2').campaign_name, null);
  assert.equal(result.get('2').customer_id, '800');
  assert.equal(calls.length, 2);
});

test('non-native leads and conflicting-provider leads do not query Meta attribution', async () => {
  const { models, calls } = modelsFor();
  assert.equal((await loadMetaLeadAttribution({ models, leads: [lead({ external_source: 'web' }), lead({ google_ads_campaign_id: '123' })] })).size, 0);
  assert.equal(calls.length, 0);
});

test('storage failure is not silently turned into a valid attribution', async () => {
  await assert.rejects(loadMetaLeadAttribution({ models: { LeadAttributionAudit: { async findAll() { throw Error('database unavailable'); } } },
    leads: [lead()] }), /database unavailable/);
});

test('production intake enrichment combines Meta and Google inventory without changing stored leads', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/intake.controller.js'), 'utf8');
  const block = source.slice(source.indexOf('const enrichLeadsWithAttributionView ='), source.indexOf('const enrichLeadsForUi ='));
  assert.ok(block.startsWith('const enrichLeadsWithAttributionView ='));
  const fixture = modelsFor();
  const google = { id: 2, source: 'google_ads', google_ads_customer_id: '800', google_ads_campaign_id: '810' };
  let googleQueries = 0;
  const enrich = vm.runInNewContext(`${block}; enrichLeadsWithAttributionView`, {
    db: fixture.models, Op,
    require: module => { assert.equal(module, '../services/metaLeadAttributionView.service'); return { loadMetaLeadAttribution }; },
    toPlain: row => ({ ...row }), cleanString: value => String(value || '').trim() || null,
    buildLeadAttributionView,
    ExternalCampaignInventory: { async findAll() {
      googleQueries++;
      return [{ provider: 'google_ads', customer_id: '800', campaign_id: '810', campaign_name: 'Google fixture' }];
    } },
  });
  const original = [lead(), google];
  const snapshot = JSON.stringify(original);
  const output = await enrich(original);
  assert.equal(output[0].marketing_campaign.name, 'Campaña de prueba');
  assert.equal(output[1].marketing_campaign.name, 'Google fixture');
  assert.equal(googleQueries, 1);
  assert.equal(JSON.stringify(original), snapshot);
});

test('privacy DTO retains only public Meta provenance and drops private answer/contact data', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/intake.controller.js'), 'utf8');
  const block = source.slice(source.indexOf('const leadPrivacySuffix ='), source.indexOf('const protectLeadRowsForRequest ='));
  assert.ok(block.startsWith('const leadPrivacySuffix ='));
  const redact = vm.runInNewContext(`${block}; redactLeadForPrivacy`, {
    crypto: require('node:crypto'), toPlain: row => row,
    parseInteger: value => Number.isSafeInteger(Number(value)) ? Number(value) : null,
    cleanString: value => typeof value === 'string' ? value.trim() || null : null,
    CHANNELS: new Set(['paid']), SOURCES: new Set(['meta_ads']), STATUSES: new Set(['nuevo']),
  });
  const output = JSON.parse(JSON.stringify(redact({ ...lead(), email: 'private@example.test', telefono: '000000000',
    formSubmissionEvents: [{ fields_json: [{ value: 'private medical answer' }] }],
    marketing_campaign: { provider: 'meta_ads', customer_id: '700', external_id: '710', name: 'Public campaign',
      adset_id: '720', adset_name: 'Public adset', ad_id: '730', ad_name: 'Public ad', page_id: '601', form_id: '602',
      private: 'private medical answer' },
    meta_form: { provider: 'meta', page_id: '601', form_id: '602', name: 'Public form', organic: false,
      fields: [{ value: 'private medical answer' }] },
  })));
  assert.equal(output.marketing_campaign.ad_name, 'Public ad');
  assert.equal(output.meta_form.form_id, '602');
  assert.deepEqual(output.formSubmissionEvents, []);
  assert.doesNotMatch(JSON.stringify(output), /private medical answer|private@example|000000000/);
  assert.equal(Object.hasOwn(output.marketing_campaign, 'private'), false);
  assert.equal(Object.hasOwn(output.meta_form, 'fields'), false);
});
