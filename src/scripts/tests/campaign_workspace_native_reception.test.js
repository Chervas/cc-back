'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nativeForms, loadNativeFormEvidence } = require('../../services/campaignWorkspaceNativeReception.service');
const { pageFingerprint } = require('../../services/campaignWorkspaceMetaPage.service');

const now = new Date('2026-09-10T15:00:00Z');
const receipt = (form = '50', patch = {}) => ({ lead_intake_id: Number(form), 'leadIntake.clinica_id': 1, received_at: '2026-09-10T12:00:00Z',
  identity: { version: 1, verified_by: 'meta_graph', provider: 'meta_ads', clinic_id: 1,
    account_id: '20', campaign_id: '30', ad_id: '10', page_id: '40', form_id: form }, ...patch });
function harness() {
  const campaign = { id: 'meta_ads:20:30', provider: 'meta_ads', account_id: '20', campaign_id: '30', clinicId: 1,
    assigned: true, destination: 'native', destinationComplete: true, destinationCheckedAt: '2026-09-10T14:00:00Z',
    nativeForms: [{ id: '50', pageId: '40', name: 'Visit', metadataAccessible: true }, { id: '51', pageId: '40', name: 'Contact', metadataAccessible: true }] };
  const state = { campaign, queries: [], audits: [receipt(), receipt('51')],
    pages: [{ metaAssetId: '40', metaAssetName: 'Page', assignmentScope: 'group', grupoClinicaId: 28, metaConnectionId: 7 }],
    accounts: [{ metaAssetId: 'act_20', assignmentScope: 'group', grupoClinicaId: 28, metaConnectionId: 7 }],
    assignments: [{ scopeKey: 'group:28', metaConnectionId: 7 }], connections: [{ id: 7, expiresAt: '2099-01-01' }] };
  const models = { ClinicMetaAsset: { findAll: async ({ where }) => where.assetType === 'facebook_page' ? state.pages : state.accounts },
    MetaConnectionAssignment: { findAll: async () => state.assignments }, MetaConnection: { findAll: async () => state.connections },
    LeadAttributionAudit: { findAll: async query => { state.queries.push(query); return state.audits; } }, LeadIntake: {} };
  return { state, read: () => loadNativeFormEvidence({ models, campaigns: [state.campaign],
    selectedClinics: [{ id_clinica: 1, grupoClinicaId: 28 }], now }) };
}
test('only a versioned exhaustive detector supplies native form IDs; legacy single-form guesses are not proof', () => {
  assert.deepEqual(nativeForms({ kind: 'lead_form', instant_form: { id: '50' } }), []);
  assert.deepEqual(nativeForms({ version: 1, source: 'workspace_meta_graph', forms: [{ form_id: '../me' }] }), []);
});
test('all forms need a real receipt linked to the same clinic, account, campaign, page and form', async () => {
  const h = harness(); const result = (await h.read()).get(h.state.campaign.id);
  assert.equal(result.reception.ready, true); assert.ok(result.forms.every(form => form.state === 'receiving'));
  h.state.audits = [receipt()]; assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
  assert.equal(h.state.queries[0].include[0].required, true);
  assert.deepEqual(h.state.queries[0].include[0].attributes, ['clinica_id']);
  const columns = h.state.queries[0].attributes.map(value => typeof value === 'string' ? value : value[1]);
  assert.deepEqual(columns, ['lead_intake_id', 'identity', 'received_at']);
});
test('expired, revoked, wrong-group or missing page/account authorization cannot appear ready', async () => {
  for (const mutate of [h => { h.state.assignments = []; }, h => { h.state.connections[0].expiresAt = '2020-01-01'; },
    h => { h.state.pages[0].grupoClinicaId = 99; }, h => { h.state.pages = []; }, h => { h.state.accounts = []; }]) {
    const h = harness(); mutate(h); assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
  }
});
test('stale and incomplete destination inventories remain pending even when one form is receiving', async () => {
  for (const patch of [{ destinationCheckedAt: '2026-09-01' }, { destinationCheckedAt: '2099-01-01' },
    { destinationCheckedAt: 'invalid' }, { destinationComplete: false }]) {
    const h = harness(); Object.assign(h.state.campaign, patch); assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
  }
});
test('old, future, unverified or foreign-clinic evidence never promotes native reception', async () => {
  for (const patch of [{ received_at: '2026-09-01T12:00:00Z' }, { received_at: '2099-01-01' },
    { 'leadIntake.clinica_id': 999 }, { identity: { ...receipt().identity, verified_by: 'browser' } },
    { identity: { ...receipt().identity, account_id: '999' } }, { identity: { ...receipt().identity, campaign_id: '999' } }]) {
    const h = harness(); h.state.campaign.nativeForms = [h.state.campaign.nativeForms[0]];
    h.state.audits = [receipt('50', patch)]; assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
  }
});
test('one campaign receipt cannot satisfy a different campaign reusing the same form', async () => {
  const h = harness(); h.state.campaign.campaign_id = '31';
  assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
});
test('conflicting identities on one lead cannot prove reception of two forms', async () => {
  const h = harness(); h.state.audits = [receipt(), receipt('51', { lead_intake_id: 50 })];
  const result = (await h.read()).get(h.state.campaign.id);
  assert.equal(result.reception.ready, false); assert.ok(result.forms.every(form => !form.receivedAt));
});
test('an explicit form permission failure supersedes an older successful receipt', async () => {
  const h = harness(); h.state.campaign.nativeForms[0].metadataAccessible = false;
  const result = (await h.read()).get(h.state.campaign.id);
  assert.equal(result.reception.ready, false); assert.equal(result.forms[0].state, 'access_required');
});
test('native checks never query form evidence for unassigned or non-native campaigns', async () => {
  const h = harness(); h.state.campaign.assigned = false;
  assert.equal((await h.read()).size, 0); assert.equal(h.state.queries.length, 0);
});
test('duplicate effective page connections are not resolved arbitrarily', async () => {
  const h = harness(); h.state.pages.push({ ...h.state.pages[0] });
  assert.equal((await h.read()).get(h.state.campaign.id).reception.ready, false);
});
test('verified setup does not invent a received lead, and missing subscription overrides earlier receipts', async () => {
  const previous = process.env.META_APP_ID; process.env.META_APP_ID = '9';
  try {
    const h = harness(); h.state.pages[0].pageAccessToken = 'private'; h.state.audits = [];
    const page = h.state.pages[0];
    page.additionalData = { campaign_lead_reception: { version: 1, fingerprint: pageFingerprint(page), app_id: '9',
      checked_at: '2026-09-10T14:59:00Z', state: 'verified' } };
    let result = (await h.read()).get(h.state.campaign.id);
    assert.equal(result.reception.ready, false); assert.ok(result.forms.every(form => form.state === 'prepared'));
    assert.ok(result.forms.every(form => form.receivedAt === null)); assert.ok(!JSON.stringify(result).includes('private'));
    h.state.audits = [receipt(), receipt('51')]; page.additionalData.campaign_lead_reception.state = 'subscription_required';
    result = (await h.read()).get(h.state.campaign.id);
    assert.equal(result.reception.ready, false); assert.ok(result.forms.every(form => form.state === 'subscription_required'));
  } finally { if (previous === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = previous; }
});
