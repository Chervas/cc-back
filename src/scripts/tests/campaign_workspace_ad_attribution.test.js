'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { attachLeadAdvertisingIdentities, resolveNativeGoogleLeadIdentity } = require('../../services/leadAdvertisingIdentity.service');
const { createLeadAdMatcher, evaluateAdComparison } = require('../../services/campaignAdAttribution.service');
const { aggregateReport, reportPeriod } = require('../../services/campaignWorkspaceReport.service');
const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');
const { budgetCampaignAttribution } = require('../../services/campaignEconomicAttribution.service');

const now = new Date('2026-09-10T10:00:00Z');
const period = reportPeriod(7, now);
const ref = { provider: 'google_ads', account_id: '123', campaign_id: '456' };
const campaign = { ...ref, id: externalCampaignIdentityKey(ref), clinicId: 1, assigned: true, currency: 'EUR' };
const proof = { ...ref, version: 1, verified_by: 'google_ads_api', clinic_id: 1, form_id: '600', ad_id: '700', adgroup_id: '800' };
const googleLead = (id = 1, more = {}) => ({ id, clinica_id: 1, source: 'google_ads', channel: 'paid', external_source: 'google_lead_form',
  external_id: crypto.createHash('sha256').update(`native-${id}`).digest('hex'), source_detail: 'leadgen_form:600',
  google_ads_customer_id: '123', google_ads_campaign_id: '456', created_at: '2026-09-08T10:00:00Z', ...more });
const audit = (id = 1, identity = proof) => ({ lead_intake_id: id, identity, native_lead_id: `native-${id}` });
const attach = async (leads, audits) => attachLeadAdvertisingIdentities({ models: { LeadAttributionAudit: { findAll: async () => audits } }, leads });
const ad = (more = {}) => ({ ...ref, id: '700', groupId: '800', title: 'Anuncio', status: 'ENABLED', date: period.end,
  spend: 50, updatedAt: now, segment: ['SEARCH', 'MOBILE'], ...more });
const report = (more = {}) => aggregateReport({ campaigns: [campaign], ads: [ad()], period, now, ...more });

test('batch Google enrichment uses the same native proof as individual resolution without loading form fields', async () => {
  const lead = googleLead(); let calls = 0;
  const models = { LeadAttributionAudit: { findAll: async options => {
    calls++;
    if (calls === 1) assert.deepEqual(options.where.lead_intake_id[Op.in], ['1']);
    assert.ok(!options.attributes.some(attribute => ['raw_payload', 'email', 'phone'].includes(attribute)));
    assert.equal(options.attributes.at(-1)[0].path, 'raw_payload.lead_id');
    return [{ ...audit(), identity: JSON.stringify(proof), native_lead_id: JSON.stringify('native-1') }];
  } } };
  await attachLeadAdvertisingIdentities({ models, leads: [lead] });
  assert.deepEqual(lead.advertising_ad_identity, await resolveNativeGoogleLeadIdentity({ models, lead }));
  assert.equal(lead.advertising_ad_identity.ad_id, '700');
  assert.equal(lead.advertising_identity, undefined);
});

test('missing, mismatched or conflicting native proofs cannot supply an ad identity', async () => {
  const cases = [[], [{ ...audit(), native_lead_id: 'another-lead' }], [audit(1, { ...proof, clinic_id: 2 })],
    [audit(1, { ...proof, account_id: '999' })], [audit(1, { ...proof, campaign_id: '999' })],
    [audit(1, { ...proof, form_id: '999' })], [audit(1, { ...proof, verified_by: 'browser' })],
    [audit(1, { ...proof, ad_id: 700 })], [audit(), audit(1, { ...proof, ad_id: '701' })], [audit(), audit(1, null)]];
  for (const audits of cases) {
    const [lead] = await attach([googleLead()], audits);
    assert.equal(lead.advertising_ad_identity, null);
  }
  const [lead] = await attach([googleLead()], [audit(), audit(), audit(999, { ...proof, ad_id: '999' })]);
  assert.equal(lead.advertising_ad_identity.ad_id, '700');
});

test('verified Google leads, historical appointments and both periods retain their exact ad', async () => {
  const leads = await attach([googleLead(), googleLead(2, { created_at: '2026-09-01T10:00:00Z' }),
    googleLead(3, { created_at: '2026-01-01T10:00:00Z' })], [audit(), audit(2), audit(3)]);
  const appointment = { id_cita: 1, lead_intake_id: 3, clinica_id: 1, created_at: '2026-09-08T11:00:00Z', estado: 'pendiente' };
  const result = report({ leads: [...leads, leads[0]], appointments: [appointment, appointment,
    { ...appointment, id_cita: 2, estado: 'cancelada' }, { ...appointment, id_cita: 3, clinica_id: 2 }],
  ads: [ad(), ad(), ad({ date: period.previousEnd, spend: 30 })] }).rows[0];
  assert.equal(result.ads[0].id, '800~700');
  assert.equal(result.ads[0].current.leads, 1); assert.equal(result.ads[0].previous.leads, 1);
  assert.equal(result.ads[0].current.appointments, 1); assert.equal(result.ads[0].current.spend, 50);
  assert.equal(result.ads[0].currentCpl, 50); assert.equal(result.ads[0].previousCpl, 30);
  assert.equal(result.adAttribution.unattributed.current.leads, 0);
});

test('appointment predating its lead does not become a campaign or ad result', async () => {
  const result = report({ leads: await attach([googleLead()], [audit()]), appointments: [
    { id_cita: 1, lead_intake_id: 1, clinica_id: 1, created_at: '2026-09-07T10:00:00Z', estado: 'pendiente' },
  ] });
  assert.equal(result.current.appointments, 0); assert.equal(result.rows[0].ads[0].current.appointments, 0);
});

test('UTMs, campaign-only proofs and missing ads remain at campaign level without a fabricated CPL', async () => {
  const leads = await attach([googleLead(), googleLead(2, { external_source: 'web', utm_content: '700' })], [audit()]);
  const result = report({ leads }).rows[0];
  assert.equal(result.current.leads, 2); assert.equal(result.ads[0].current.leads, 1);
  assert.equal(result.adAttribution.unattributed.current.leads, 1); assert.equal(result.ads[0].currentCpl, null);
  assert.equal(result.adAttribution.comparison.status, 'incomplete_attribution');
  assert.equal(report({ leads, ads: [] }).rows[0].adAttribution.unattributed.current.leads, 2);
});

test('Google group/ad pairs disambiguate a reused ad ID and preserve metric segments', async () => {
  const leads = await attach([googleLead(), googleLead(2), googleLead(3)], [audit(), audit(2, { ...proof, adgroup_id: '801' }), audit(3, { ...proof, adgroup_id: null })]);
  const result = report({ leads, ads: [ad(), ad({ groupId: '801', spend: 80 }), ad({ segment: ['SEARCH', 'DESKTOP'], spend: 20 })] }).rows[0];
  assert.equal(result.ads.length, 2); assert.equal(result.ads[0].current.spend, 70); assert.equal(result.ads[1].current.spend, 80);
  assert.deepEqual(result.ads.map(row => row.current.leads), [1, 1]); assert.equal(result.adAttribution.unattributed.current.leads, 1);
});

test('verified Meta native forms match their ad without relying on free-form UTMs', () => {
  const meta = { ...campaign, provider: 'meta_ads', id: externalCampaignIdentityKey({ ...ref, provider: 'meta_ads' }) };
  const lead = { ...googleLead(), source: 'meta_ads', advertising_identity: { ...proof, provider: 'meta_ads', verified_by: 'meta_graph', page_id: '900' } };
  const result = report({ campaigns: [meta], ads: [ad({ provider: 'meta_ads' })], leads: [lead] }).rows[0];
  assert.equal(result.ads[0].current.leads, 1);
  const match = createLeadAdMatcher([meta], new Map([[meta.id, [ad(), ad()]]]));
  for (const patch of [{ clinica_id: 2 }, { channel: 'organic' }, { advertising_identity_conflict: true },
    { advertising_identity: { ...lead.advertising_identity, account_id: '999' } }]) assert.equal(match({ ...lead, ...patch }, meta.id), null);
  assert.equal(match(undefined, meta.id), null);
});

test('unassigned inventory does not report zero CRM results', () => {
  const result = report({ campaigns: [{ ...campaign, assigned: false, clinicId: null }] }).rows[0];
  assert.equal(result.ads[0].current.leads, null); assert.equal(result.ads[0].current.appointments, null);
  assert.equal(result.adAttribution.comparison.status, 'unassigned');
});

test('accepted budgets allocate once to an unambiguous ad or stay in the campaign remainder', async () => {
  const leads = await attach([googleLead(), googleLead(2)], [audit(), audit(2, { ...proof, ad_id: '701' })]);
  const budget = { id: 1, clinic_id: 1, patient_id: 10, status: 'partially_accepted', accepted_amount: '25.01', responded_at: '2026-09-09T10:00:00Z' };
  const appointment = { id_cita: 1, paciente_id: 10, lead_intake_id: 1, clinica_id: 1, estado: 'pendiente', created_at: '2026-09-08T12:00:00Z' };
  const ads = [ad(), ad({ id: '701' })];
  for (const ambiguous of [false, true]) {
    const appointments = [appointment, appointment, ...(ambiguous ? [{ ...appointment, id_cita: 2, lead_intake_id: 2 }] : [])];
    const budgetAttribution = budgetCampaignAttribution({ campaigns: [campaign], period, budgets: [budget, budget], appointments, leads, ads });
    assert.equal(budgetAttribution.allocations.length, 1); assert.equal(budgetAttribution.adAllocations.length, ambiguous ? 0 : 1);
    const result = report({ ads, leads, appointments, budgetAttribution }).rows[0];
    assert.equal(result.current.accepted, 25.01); assert.equal(result.ads[0].current.accepted, ambiguous ? 0 : 25.01);
    assert.equal(result.adAttribution.unattributed.current.accepted, ambiguous ? 25.01 : 0);
    assert.equal(result.ads.reduce((sum, ad) => sum + ad.current.accepted, result.adAttribution.unattributed.current.accepted), result.current.accepted);
  }
});

const comparable = () => ({ campaign, adAttribution: { unattributed: { current: { leads: 0 } } }, ads: [1, 2].map(i => ({
  id: String(i), active: true, lastSeenAt: now, metricsUpdatedAt: now, latestMetricDate: period.end,
  current: { leads: 10, spend: i * 50 }, currentCpl: i * 5,
})) });
test('lowest CPL requires sufficient data for every active ad and does not declare a future winner', () => {
  const result = evaluateAdComparison(comparable(), period, now);
  assert.deepEqual(result, { status: 'ready', minimumLeads: 10, bestAdId: '1' });
  for (const patch of [{ current: { leads: 9, spend: 50 } }, { current: { leads: 10, spend: 0 } }, { currentCpl: null }, { currentCpl: undefined }]) {
    const row = comparable(); Object.assign(row.ads[1], patch);
    assert.equal(evaluateAdComparison(row, period, now).bestAdId, null);
  }
});
test('stale, partial, tied, single-ad or unknown-currency comparisons never mark a winner', () => {
  const cases = [row => { row.campaign = { ...campaign, currency: null }; }, row => { row.adAttribution.unattributed.current.leads = 1; },
    row => { row.ads[1].active = false; }, row => { row.ads[1].currentCpl = 5.001; },
    row => { row.ads[0].lastSeenAt = '2026-09-01'; }, row => { row.ads[0].metricsUpdatedAt = '2026-09-01'; },
    row => { row.ads[0].metricsUpdatedAt = '2026-09-12'; }, row => { row.ads[0].latestMetricDate = period.start; }];
  for (const change of cases) { const row = comparable(); change(row); assert.equal(evaluateAdComparison(row, period, now).bestAdId, null); }
});
test('fresh inventory or a refreshed old metric cannot hide stale latest-day metrics', () => {
  for (const ads of [[ad({ updatedAt: '2026-09-01' }), ad({ inventory: true, date: null }), ad({ date: period.start })],
    [ad(), ad({ updatedAt: '2026-09-01', segment: ['SEARCH', 'DESKTOP'] })]]) {
    const row = report({ ads }).rows[0];
    assert.equal(row.ads[0].metricsUpdatedAt, '2026-09-01'); assert.equal(row.ads[0].lastSeenAt, now);
  }
});
