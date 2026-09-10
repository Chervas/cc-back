'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessCampaignPreparation, loadWorkspacePreparation } = require('../../services/campaignWorkspacePreparation.service');

const campaign = { id: 'google_ads:123:7', provider: 'google_ads', account_id: '123', campaign_id: '7',
  clinicId: 1, assigned: true, destination: 'web', urls: ['https://example.org/contacto'] };
const readyEvidence = { privacy: { checked: true, ready: true }, reception: { checked: true, ready: true, detail: 'Recibido' } };

test('preparation separates assignment, destination, privacy and real reception', () => {
  assert.equal(assessCampaignPreparation({ ...campaign, assigned: false }, readyEvidence).action, 'assign');
  assert.equal(assessCampaignPreparation({ ...campaign, destination: 'unknown' }, readyEvidence).reason, 'destination_unverified');
  assert.equal(assessCampaignPreparation(campaign).reason, 'web_preparation_required');
  assert.equal(assessCampaignPreparation(campaign, { privacy: readyEvidence.privacy }).reason, 'web_reception_unverified');
  assert.equal(assessCampaignPreparation(campaign, readyEvidence).ready, true);
});
test('OAuth alone cannot mark a native form ready, and native forms do not require a website', () => {
  const native = { ...campaign, destination: 'native' };
  assert.equal(assessCampaignPreparation(native).reason, 'native_reception_unverified');
  assert.equal(assessCampaignPreparation(native, { reception: readyEvidence.reception }).ready, true);
});

function fixture() {
  const account = { provider: 'google_ads', account_id: '123', include_future: true, campaign_ids: ['7'] };
  const state = { setting: { id: 'setting', version: 2, accounts: [account], activation: null },
    evidence: new Map([[campaign.id, readyEvidence]]), campaigns: [campaign],
    clinicConfig: null,
    groupConfig: { assignment_scope: 'group', group_id: 28, config: { campaigns: { active_mode: 'guided_improvement' } } } };
  const models = {
    CampaignWorkspaceSetting: { findOne: async () => state.setting },
    IntakeConfig: { findOne: async ({ where }) => where.group_id === 28 ? state.groupConfig : state.clinicConfig },
    CampaignRequest: { findAll: async () => [] },
    Clinica: { findAll: async () => [{ id_clinica: 1 }] },
  };
  const read = (extra = {}) => loadWorkspacePreparation({ models, scope: { clinicIds: [1] },
    now: new Date('2026-09-10T14:00:00Z'),
    loadInventory: async () => ({ campaigns: state.campaigns, selectedClinics: [{ id_clinica: 1, grupoClinicaId: 28 }], groups: [28] }),
    loadEvidence: async () => state.evidence, ...extra });
  return { state, read };
}
test('real mode inheritance is reused without exposing runtime credentials or expanding authorization', async () => {
  const f = fixture();
  const result = await f.read();
  assert.deepEqual(result.existing, { mode: 'guided_improvement', label: 'Optimiza' });
  assert.equal(result.selectionConfirmed, true); assert.equal(result.configuration.activation, null);
  assert.equal(result.receptionReady, true);
  assert.equal(JSON.stringify(result).includes('mode_contract'), false);
});
test('native evidence receives the same authorized group scope as the preparation request', async () => {
  const f = fixture(); const scope = { groupId: 28, clinicIds: [1] };
  let observed = null;
  await f.read({ scope, loadEvidence: async options => { observed = options.scope; return f.state.evidence; } });
  assert.deepEqual(observed, scope);
});
test('a native workspace can report its active mode without inventing a website config', async () => {
  const f = fixture(); f.state.setting.activation = { schema_version: 2, mode: 'measurement', status: 'active' };
  const result = await f.read({ resolveMode: async () => null });
  assert.deepEqual(result.existing, { mode: 'connect_only', label: 'Medición de interesados (leads)' });
  assert.equal(f.state.clinicConfig, null);
  assert.equal((await f.read()).existing.mode, 'guided_improvement');
});
test('a review revision changes with settings or readiness but not with polling time', async () => {
  const f = fixture(); const first = await f.read();
  assert.equal((await f.read({ now: new Date('2026-09-10T15:00:00Z') })).revision, first.revision);
  f.state.setting.version++; assert.notEqual((await f.read()).revision, first.revision);
  f.state.setting.version--; f.state.evidence.clear();
  assert.notEqual((await f.read()).revision, first.revision); assert.equal((await f.read()).receptionReady, false);
});
test('the preparation respects saved account selections, including an explicitly empty selection', async () => {
  const f = fixture(); f.state.setting.accounts = [];
  const result = await f.read(); assert.deepEqual(result.campaigns, []);
  assert.equal(result.receptionReady, false); assert.equal(result.selectionConfirmed, false);
});
test('unassigned campaigns remain explicit exceptions and cannot count as prepared', async () => {
  const f = fixture(); f.state.campaigns.push({ ...campaign, id: 'google_ads:123:8', campaign_id: '8', assigned: false, clinicId: null });
  const result = await f.read();
  assert.deepEqual(result.counts, { total: 2, assigned: 1, ready: 1, unassigned: 1 });
  assert.equal(result.campaigns[1].ready, false);
});
test('a mapped account is not itself confirmation of the campaign selection', async () => {
  const f = fixture(); f.state.setting = null;
  assert.equal((await f.read()).selectionConfirmed, false);
});
test('a changed runtime invalidates the review without exposing its tokens', async () => {
  const f = fixture(); const first = await f.read();
  f.state.clinicConfig = { assignment_scope: 'clinic', clinic_id: 1, hmac_key: 'private-key', config: { google_ads: { enabled: true } } };
  const second = await f.read();
  assert.notEqual(first.revision, second.revision); assert.equal(JSON.stringify(second).includes('private-key'), false);
});
test('signal readiness participates in the review revision without publishing the private mandate', async () => {
  const f = fixture(); const transaction = { id: 'read-transaction' };
  const review = { enabled: true, ready: true, accounts: [{ provider: 'google_ads', account_id: '123', status: 'ready' }] };
  const options = { transaction, loadSignalReview: async input => {
    assert.equal(input.transaction, transaction); assert.equal(input.setting, f.state.setting);
    assert.deepEqual(input.scope.clinicIds, [1]);
    return { review, authorization: { grant_fingerprint: 'private-grant', destinations: [] } };
  } };
  const first = await f.read(options); assert.deepEqual(first.signals, review);
  assert.doesNotMatch(JSON.stringify(first), /private-grant|grant_fingerprint/);
  const firstRevision = first.revision;
  const changedGrant = await f.read({ ...options, loadSignalReview: async () => ({ review,
    authorization: { grant_fingerprint: 'changed-private-grant', destinations: [] } }) });
  assert.notEqual(changedGrant.revision, firstRevision);
  assert.doesNotMatch(JSON.stringify(changedGrant), /changed-private-grant/);
  review.ready = false; review.accounts[0].status = 'stale';
  assert.notEqual((await f.read(options)).revision, firstRevision);
  assert.equal(f.state.setting.activation, null);
});
