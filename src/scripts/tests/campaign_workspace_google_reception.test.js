'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { googleNativeForms, loadGoogleNativeEvidence } = require('../../services/campaignWorkspaceGoogleReception.service');
const { visibleCampaigns } = require('../../services/campaignWorkspaceReport.service');

const now = new Date('2026-09-11T12:00:00Z');
const receipt = (id = '50', patch = {}) => ({ lead_intake_id: Number(id), received_at: '2026-09-11T11:00:00Z',
  'leadIntake.clinica_id': 1, 'leadIntake.google_ads_customer_id': '20', 'leadIntake.google_ads_campaign_id': '30',
  'leadIntake.source_detail': `leadgen_form:${id}`,
  identity: { version: 1, verified_by: 'google_ads_api', provider: 'google_ads', clinic_id: 1, account_id: '20', campaign_id: '30', form_id: id }, ...patch });
function harness() {
  const detection = { version: 1, source: 'workspace_google_ads', status: 'checked', checked_at: now.toISOString(),
    complete: true, access_fingerprint: 'private-grant', kind: 'mixed', urls: ['https://clinic.example/visit'],
    forms: [{ form_id: '50', name: 'First visit', metadata_accessible: true }, { form_id: '51', name: 'Contact', metadata_accessible: true }] };
  const campaign = { id: 'google_ads:20:30', provider: 'google_ads', assigned: true, clinicId: 1, account_id: '20', campaign_id: '30',
    destination: 'mixed', nativeForms: googleNativeForms({ workspace_google: detection }) };
  const state = { detection, campaign, accounts: 0, queries: [], audits: [receipt(), receipt('51')], permitted: true,
    recipient: 1, env: { CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED: 'true' }, settings: [{ id: 'setting', scope_type: 'clinic', scope_id: 1 }] };
  const models = { CampaignWorkspaceSetting: { findAll: async () => state.settings },
    ExternalCampaignInventory: { findAll: async () => [{ customer_id: '20', campaign_id: '30', destination_detection: { workspace_google: state.detection } }] },
    LeadIntake: {}, LeadAttributionAudit: { findAll: async query => { state.queries.push(query); return state.audits; } } };
  const accountContext = async () => { state.accounts++; if (!state.permitted) throw Object.assign(new Error('revoked'), { code: 'google_lead_account_access_required' });
    return { fingerprint: 'private-grant' }; };
  return { state, read: () => loadGoogleNativeEvidence({ models, campaigns: [state.campaign], selectedClinics: [{ id_clinica: 1 }],
    scope: { clinicIds: [1] }, now, env: state.env, accountContext, resolveClinic: async () => ({ id_clinica: state.recipient }) }) };
}
test('Google native forms require the explicit versioned source; legacy guesses are not evidence', () => {
  assert.deepEqual(googleNativeForms({ kind: 'lead_form', forms: [{ form_id: '50' }] }), []);
  assert.deepEqual(googleNativeForms({ workspace_google: { version: 2, source: 'workspace_google_ads', forms: [{ form_id: '50' }] } }), []);
  assert.deepEqual(googleNativeForms({ workspace_google: { version: 1, source: 'workspace_google_ads',
    forms: [null, {}, { form_id: 50 }, { form_id: '0' }, { form_id: '50;SELECT' }] } }), []);
});
test('verified native receipts use current routing and all forms, with no web or contact data', async () => {
  const h = harness(); const result = (await h.read()).get(h.state.campaign.id);
  assert.equal(result.reception.ready, true); assert.equal(result.forms.length, 2);
  assert.equal(h.state.queries[0].include[0].required, true);
  assert.deepEqual(h.state.queries[0].include[0].attributes, ['clinica_id', 'google_ads_customer_id', 'google_ads_campaign_id', 'source_detail']);
  assert.ok(!JSON.stringify(result).match(/private|email|phone|token|raw_payload/));
});
test('no recent lead is prepared rather than broken; neither OAuth nor a partial receipt proves reception', async () => {
  const h = harness(); h.state.audits = [];
  let result = (await h.read()).get(h.state.campaign.id);
  assert.equal(result.reception.ready, false); assert.equal(result.reception.configured, true); assert.equal(result.reception.state, 'pending_confirmation');
  h.state.audits = [receipt()]; result = (await h.read()).get(h.state.campaign.id);
  assert.equal(result.reception.ready, false); assert.deepEqual(result.forms.map(form => form.state), ['receiving', 'prepared']);
});
test('disabled service, expired discovery, another grant and revocation invalidate readiness without erasing receipt history', async () => {
  for (const mutate of [h => { h.state.env = {}; }, h => { h.state.permitted = false; }, h => { h.state.recipient = 2; },
    h => { h.state.detection.checked_at = '2026-09-09'; }, h => { h.state.detection.checked_at = '2099-01-01'; },
    h => { h.state.detection.access_fingerprint = 'another-grant'; }, h => { h.state.detection.complete = false; },
    h => { h.state.detection.status = 'checking'; }]) {
    const h = harness(); mutate(h); const result = (await h.read()).get(h.state.campaign.id);
    assert.equal(result.reception.ready, false); assert.equal(result.reception.configured, false);
    assert.ok(result.forms.every(form => form.receivedAt));
  }
});
test('wrong identities, conflicting audit records and foreign CRM joins never prove a form received', async () => {
  for (const patch of [{ received_at: '2026-08-01' }, { received_at: '2099-01-01' }, { 'leadIntake.clinica_id': 99 },
    { 'leadIntake.google_ads_customer_id': '99' }, { 'leadIntake.google_ads_campaign_id': '99' },
    { 'leadIntake.source_detail': 'leadgen_form:99' }, { identity: { ...receipt().identity, verified_by: 'browser' } }]) {
    const h = harness(); h.state.audits = [receipt('50', patch), receipt('51')];
    assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
  }
  const h = harness(); h.state.audits = [receipt(), receipt('51', { lead_intake_id: 50 })];
  assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
});
test('unassigned and web-only inventory cannot borrow native receipt evidence', async () => {
  const h = harness(); h.state.campaign.nativeForms = [];
  assert.equal((await h.read()).size, 0); assert.equal(h.state.queries.length, 0);
  h.state.campaign.nativeForms = [{ id: '50' }]; h.state.campaign.assigned = false;
  assert.equal((await h.read()).size, 0); assert.equal(h.state.queries.length, 0);
});
test('public inventory retains mixed destinations but never exposes the private detection fingerprint', () => {
  const h = harness();
  const result = visibleCampaigns({ scope: { clinicIds: [1] }, mappings: [{ provider: 'google_ads', accountId: '20', clinicId: 1 }], assignments: [],
    inventory: [{ provider: 'google_ads', customer_id: '20', campaign_id: '30', destination_detection: { kind: 'web', urls: ['https://old.example/'], workspace_google: h.state.detection } }] });
  assert.equal(result[0].destination, 'mixed'); assert.equal(result[0].nativeForms.length, 2);
  assert.deepEqual(result[0].urls, ['https://clinic.example/visit']); assert.ok(!JSON.stringify(result).includes('private'));
});
