'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { extractWebAdAttribution, webAdAdvertisingIdentity, WEB_AD_FIELDS } = require('../../lib/web-ad-attribution');
const { resolveWorkspaceWebAdIdentity } = require('../../services/campaignWorkspaceWebAdAttribution.service');
const { attachLeadAdvertisingIdentities, canonicalLeadAdvertisingIdentity } = require('../../services/leadAdvertisingIdentity.service');
const { aggregateReport, reportPeriod } = require('../../services/campaignWorkspaceReport.service');
const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');
const { attributionFromBody, attributionFromUrl } = require('../../services/webLandingSubmission.service');

const now = new Date('2026-09-10T10:00:00Z');
const ref = { provider: 'google_ads', account_id: '1234567890', campaign_id: '456' };
const candidate = { ...ref, ad_id: '700', adgroup_id: '800' };
const body = { attribution: { google_ads_customer_id: ref.account_id, google_ads_campaign_id: ref.campaign_id,
  cc_gads_ad_id: '700', cc_gads_adgroup_id: '800' } };
const proof = { version: 1, verified_by: 'workspace_web_ad_inventory', ...candidate, clinic_id: 1,
  intake_config_id: 10, web_fingerprint: 'a'.repeat(64), verified_at: now.toISOString() };
const meta = { version: 2, verified_by: 'workspace_web_inventory', provider: 'meta_ads', account_id: '123', campaign_id: '456',
  clinic_id: 1, intake_config_id: 10, web_fingerprint: 'a'.repeat(64), campaign_binding: 'b'.repeat(64) };
const campaign = { ...ref, id: externalCampaignIdentityKey(ref), assigned: true, clinicId: 1, currency: 'EUR' };
const fixture = () => {
  const calls = [];
  const inventory = { selectedClinics: [{ id_clinica: 1, estado_clinica: 1 }], campaigns: [{ ...campaign }] };
  const groups = [{ adGroupId: '800' }];
  const models = { GoogleAdsAdInsightsDaily: { findAll: async options => { calls.push(options); return groups; } } };
  const dependencies = { loadInventory: async options => { assert.deepEqual(options.scope.clinicIds, [1]); return inventory; },
    resolveWeb: async () => ({ record: { id: 10, domains: ['landing.example.test'] }, fingerprint: proof.web_fingerprint }) };
  const args = { models, body, clinicId: 1, recordId: 10, source: 'web', externalSource: 'web',
    eventSourceUrl: 'https://landing.example.test/form/', now };
  return { calls, inventory, groups, models, dependencies, args };
};

test('explicit IDs survive URL/nested aliases without guessing from UTMs', () => {
  assert.deepEqual(extractWebAdAttribution(body), candidate);
  assert.deepEqual(extractWebAdAttribution({ page_url: 'https://landing.example.test/?cc_gads_customer_id=123-456-7890&cc_gads_campaign_id=456&cc_gads_ad_id=700&cc_gads_adgroup_id=800' }), candidate);
  assert.deepEqual(extractWebAdAttribution({ attribution: { cc_meta_account_id: 'act_123', cc_meta_campaign_id: '456', cc_meta_ad_id: '700' } }),
    { provider: 'meta_ads', account_id: '123', campaign_id: '456', ad_id: '700', adgroup_id: null });
  assert.equal(extractWebAdAttribution({ utm_campaign: '456', utm_content: '700', ad_id: '700' }), null);
});

test('contradictions, malformed IDs, mixed providers and unresolved macros fail closed', () => {
  const cases = [{ ...body, cc_gads_ad_id: '701' }, { ...body, cc_meta_campaign_id: '456' },
    { ...body, page_url: 'https://landing.example.test/?cc_gads_ad_id=700&cc_gads_ad_id=701' },
    ...[700, ['700'], '0', '0700', '{creative}', '{{ad.id}}', '1e4', '9'.repeat(65)].map(value => ({ ...body, cc_gads_ad_id: value })),
    { attribution: { ...body.attribution, cc_gads_ad_id: null } }];
  for (const input of cases) assert.equal(extractWebAdAttribution(input), null);
});

test('proof requires server provenance, exact clinic, immutable configuration and concrete group/ad', () => {
  assert.deepEqual(webAdAdvertisingIdentity(JSON.stringify(proof), 1), proof);
  for (const patch of [{ clinic_id: 2 }, { verified_by: 'browser' }, { adgroup_id: null }, { web_fingerprint: '' },
    { intake_config_id: 0 }, { verified_at: 'bad' }, { ad_id: 700 }]) assert.equal(webAdAdvertisingIdentity({ ...proof, ...patch }, 1), null);
});

test('Google checks only scoped cached inventory and never invokes an advertising API', async () => {
  const f = fixture();
  assert.deepEqual(await resolveWorkspaceWebAdIdentity(f.args, f.dependencies), proof);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].where.customerId[Op.in].includes(ref.account_id));
  assert.equal(f.calls[0].where.campaignId, '456'); assert.equal(f.calls[0].where.adId, '700');
  assert.deepEqual(f.calls[0].attributes, ['adGroupId']);
});

test('absent metadata, native forms and wrong clinic assignments cannot trigger enrichment', async () => {
  for (const patch of [{ body: {} }, { externalSource: 'google_lead_form' }, { externalSource: 'meta_leadgen' }, { source: 'tiktok_ads' }]) {
    const f = fixture(); f.dependencies.loadInventory = () => assert.fail('unexpected inventory read');
    assert.equal(await resolveWorkspaceWebAdIdentity({ ...f.args, ...patch }, f.dependencies), null);
  }
  for (const patch of [{ assigned: false }, { clinicId: 2 }, { account_id: '9999999999' }, { campaign_id: '999' }]) {
    const f = fixture(); Object.assign(f.inventory.campaigns[0], patch);
    assert.equal(await resolveWorkspaceWebAdIdentity(f.args, f.dependencies), null); assert.equal(f.calls.length, 0);
  }
});

test('URL ownership, HTTPS, web readiness and ambiguous ad groups are mandatory', async () => {
  for (const eventSourceUrl of ['http://landing.example.test/', 'https://other.example.test/', 'https://user@landing.example.test/', 'bad']) {
    const f = fixture(); assert.equal(await resolveWorkspaceWebAdIdentity({ ...f.args, eventSourceUrl }, f.dependencies), null);
  }
  const f = fixture(); f.groups.push({ adGroupId: '801' });
  const noGroup = { attribution: { ...body.attribution, cc_gads_adgroup_id: null } };
  assert.equal(await resolveWorkspaceWebAdIdentity({ ...f.args, body: noGroup }, f.dependencies), null);
  assert.deepEqual(await resolveWorkspaceWebAdIdentity(f.args, f.dependencies), proof);
  f.dependencies.resolveWeb = async () => { throw new Error('workspace_signal_web_scope_changed'); };
  await assert.rejects(resolveWorkspaceWebAdIdentity(f.args, f.dependencies), /scope_changed/);
});

test('Meta requires existing v2 campaign identity and verifies both ad and adset ownership', async () => {
  const f = fixture(); f.inventory.campaigns[0] = { ...campaign, provider: 'meta_ads', account_id: '123' };
  f.args.body = { cc_meta_account_id: '123', cc_meta_campaign_id: '456', cc_meta_ad_id: '700' };
  f.models.SocialAdsEntity = { findAll: async options => {
    f.calls.push(options); assert.ok(options.where.ad_account_id[Op.in].includes('123'));
    if (options.where.level === 'ad') { assert.equal(options.where.entity_id, '700'); return [{ parent_id: '800' }]; }
    assert.equal(options.where.parent_id, '456'); assert.deepEqual(options.where.entity_id[Op.in], ['800']);
    return [{ entity_id: '800' }];
  } };
  assert.equal(await resolveWorkspaceWebAdIdentity(f.args, f.dependencies), null);
  assert.equal(await resolveWorkspaceWebAdIdentity({ ...f.args, metaIdentity: { ...meta, clinic_id: 2 } }, f.dependencies), null);
  assert.equal(await resolveWorkspaceWebAdIdentity({ ...f.args, metaIdentity: { ...meta, web_fingerprint: 'c'.repeat(64) } }, f.dependencies), null);
  assert.deepEqual(await resolveWorkspaceWebAdIdentity({ ...f.args, metaIdentity: meta }, f.dependencies), { ...proof, provider: 'meta_ads', account_id: '123' });
  assert.equal(f.calls.length, 2);
});

const attach = async (leads, rows) => attachLeadAdvertisingIdentities({ leads, models: { LeadAttributionAudit: { findAll: async () => rows } } });
const lead = (id = 1, extra = {}) => ({ id, clinica_id: 1, source: 'web', channel: 'paid', created_at: '2026-09-08T10:00:00Z', ...extra });
test('persisted web attribution supplies campaign and ad results for both periods', async () => {
  const f = fixture(); const identity = await resolveWorkspaceWebAdIdentity(f.args, f.dependencies);
  const leads = await attach([lead(), lead(2, { created_at: '2026-09-01T10:00:00Z' })],
    [1, 2].map(id => ({ lead_intake_id: id, web_ad_identity: identity })));
  const period = reportPeriod(7, now);
  const result = aggregateReport({ campaigns: [campaign], leads, period, now,
    ads: [{ ...ref, id: '700', groupId: '800', status: 'ENABLED', date: period.end, updatedAt: now, spend: 20 }] });
  assert.equal(result.current.leads, 1); assert.equal(result.previous.leads, 1);
  assert.equal(result.rows[0].ads[0].current.leads, 1); assert.equal(result.rows[0].ads[0].previous.leads, 1);
  assert.equal(result.rows[0].adAttribution.unattributed.current.leads, 0);
});

test('repeated audit checks preserve identity; conflicting and forged proofs cannot supply an ad', async () => {
  const audit = value => ({ lead_intake_id: 1, web_ad_identity: value });
  const [same] = await attach([lead()], [audit(proof), audit({ ...proof, verified_at: '2026-09-09T00:00:00Z' })]);
  assert.equal(canonicalLeadAdvertisingIdentity(same).ad_id, '700');
  for (const rows of [[audit(proof), audit({ ...proof, ad_id: '701' })], [audit(proof), audit({ ...proof, clinic_id: 2 })]]) {
    const [value] = await attach([lead()], rows); assert.equal(canonicalLeadAdvertisingIdentity(value), null);
  }
  const [mismatch] = await attach([lead(1, { source: 'google_ads', google_ads_customer_id: ref.account_id, google_ads_campaign_id: '999' })], [audit(proof)]);
  assert.equal(mismatch.advertising_identity_conflict, true); assert.equal(mismatch.advertising_web_ad_identity, null);
});

test('native landing fields preserve valid optional IDs and ignore invalid ad metadata without rejecting contact', () => {
  const input = Object.fromEntries(WEB_AD_FIELDS.map((field, i) => [`_cc_attr_${field}`, String(700 + i)]));
  const attrs = attributionFromBody(input);
  for (const [i, field] of WEB_AD_FIELDS.entries()) assert.equal(attrs[field], String(700 + i));
  const url = new URL('https://landing.example.test/?cc_gads_ad_id=700&cc_gads_adgroup_id=800');
  assert.equal(attributionFromUrl(url).cc_gads_ad_id, '700');
  assert.doesNotThrow(() => attributionFromBody({ _cc_attr_cc_gads_ad_id: '{creative}' }));
  assert.ok(!attributionFromBody({ _cc_attr_cc_gads_ad_id: '{creative}' }).cc_gads_ad_id);
});
