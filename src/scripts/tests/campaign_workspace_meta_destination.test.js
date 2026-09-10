'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { campaignReference, creativeDestinations, detectDestinations, graphList, revision, refreshMetaCampaignDestinations } = require('../../services/campaignWorkspaceMetaDestination.service');

const now = new Date('2026-09-10T15:00:00Z');
const ad = (id = '10', patch = {}) => ({ id, account_id: '20', campaign_id: '30', effective_status: 'ACTIVE',
  creative: { object_story_spec: { page_id: '40', link_data: { link: 'https://clinic.example',
    call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '50', link: 'https://clinic.example/privacy' } } } } }, ...patch });

test('Meta preparation only accepts exact provider IDs and a cache revision, never browser ownership or tokens', () => {
  const input = { account_id: '20', campaign_id: '30', revision: revision(null) };
  assert.equal(campaignReference(input, true).provider, 'meta_ads');
  for (const patch of [{ account_id: 'act_20' }, { campaign_id: '../me' }, { actorId: 3 }, { token: 'private' }, { campaign_id: 30 }, { revision: null }]) {
    assert.throws(() => campaignReference({ ...input, ...patch }, true), /invalid_meta_preparation/);
  }
});
test('a native CTA website link is not classified as a second reception destination', () => {
  const result = creativeDestinations(ad());
  assert.deepEqual(result.forms, [{ form_id: '50', page_id: '40', ad_ids: ['10'] }]);
  assert.deepEqual(result.urls, []);
});
test('video, template and carousel CTA form references are detected and deduplicated across ads', () => {
  for (const block of ['video_data', 'template_data']) {
    assert.equal(creativeDestinations(ad('10', { creative: { object_story_spec: { page_id: '40', [block]: {
      call_to_action: { value: { lead_gen_form_id: '50' } },
    } } } })).forms[0].form_id, '50');
  }
  const result = detectDestinations([ad(), ad('11')], true, now);
  assert.equal(result.kind, 'lead_form'); assert.deepEqual(result.forms[0].ad_ids, ['10', '11']);
});
test('every ad matters: mixed, unknown, missing, or incompletely paginated creatives never become fully prepared', () => {
  const web = ad('11', { creative: { link_url: 'https://clinic.example/landing' } });
  assert.equal(detectDestinations([ad(), web], true, now).kind, 'mixed');
  assert.equal(detectDestinations([ad(), ad('11', { creative: {} })], true, now).complete, false);
  assert.equal(detectDestinations([ad()], false, now).kind, 'unknown');
  assert.equal(detectDestinations([], true, now).complete, false);
});
test('dynamic website URLs are all retained but credentials, internal Meta destinations and calls are not treated as forms', () => {
  const result = creativeDestinations(ad('1', { creative: { call_to_action_type: 'MAKE_AN_APPOINTMENT',
    asset_feed_spec: { link_urls: [{ website_url: 'https://a.example/' }, { website_url: 'https://b.example/' }] } } }));
  assert.deepEqual(result.urls, ['https://a.example/', 'https://b.example/']); assert.equal(result.known, true);
  for (const link_url of ['javascript:alert(1)', 'https://user:secret@example.org', 'https://wa.me/123', '//example.org']) {
    assert.equal(creativeDestinations(ad('1', { creative: { link_url } })).known, false);
  }
  assert.equal(creativeDestinations(ad('1', { creative: { call_to_action_type: 'CALL_NOW', link_url: 'https://a.example/' } })).known, false);
});
test('paging uses opaque cursors on the authorized endpoint, never next URLs; repeated and missing cursors are incomplete', async () => {
  const calls = [];
  const result = await graphList('30/ads', 'id', 'private', async (path, options) => {
    calls.push({ path, options }); return calls.length === 1
      ? { data: { data: [ad()], paging: { next: 'https://evil.example/?access_token=steal', cursors: { after: 'opaque' } } } }
      : { data: { data: [ad('11')] } };
  });
  assert.equal(result.rows.length, 2); assert.equal(result.complete, true);
  assert.ok(calls.every(call => call.path === '30/ads')); assert.equal(calls[1].options.params.after, 'opaque');
  for (const cursors of [undefined, { after: 'repeat' }]) {
    const partial = await graphList('30/ads', 'id', 'private', async () => ({ data: { data: [], paging: { next: 'next', cursors } } }));
    assert.equal(partial.complete, false);
  }
});

function harness() {
  const campaign = { id: 'meta_ads:20:30', provider: 'meta_ads', account_id: '20', campaign_id: '30', clinicId: 1,
    assigned: true, name: 'Campaign', accountName: 'Account', status: 'ACTIVE', lastSeenAt: now };
  const state = { campaigns: [campaign], setting: null, cached: null, writes: [], calls: [], assignments: [{ scopeKey: 'clinic:1', metaConnectionId: 7 }],
    connection: { id: 7, accessToken: 'private-token', expiresAt: '2099-01-01' }, graphRows: [ad()], beforeTransaction: null };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 1 }) },
    CampaignWorkspaceSetting: { findOne: async () => state.setting },
    ClinicMetaAsset: { findAll: async () => [{ assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7 }] },
    MetaConnectionAssignment: { findAll: async () => state.assignments },
    MetaConnection: { findByPk: async () => state.connection },
    ExternalCampaignInventory: { findAll: async () => state.cached ? [state.cached] : [],
      create: async (value, options) => { assert.equal(options.transaction, transaction); state.writes.push(value); },
      update: async (value, options) => { assert.equal(options.transaction, transaction); state.writes.push(value); } },
    sequelize: { transaction: async fn => { state.beforeTransaction?.(); return fn(transaction); } },
  };
  const loadInventory = async () => ({ campaigns: state.campaigns, selectedClinics: [{ id_clinica: 1, estado_clinica: 1 }] });
  const read = async (path, options) => {
    state.calls.push({ path, options });
    if (state.graphError) throw state.graphError;
    return path === '30/ads' ? { data: { data: state.graphRows } }
      : { data: { id: '50', page_id: '40', name: 'First visit', status: 'ACTIVE', ...state.form } };
  };
  return { state, run: () => refreshMetaCampaignDestinations({ models, scope: { clinicIds: [1] },
    input: { account_id: '20', campaign_id: '30', revision: revision(state.cached?.destination_detection) }, loadInventory, now, read }) };
}
test('a scoped check persists only destination metadata, with no asset, subscription, signal or advertising mutation', async () => {
  const h = harness(); await h.run();
  assert.equal(h.state.writes.length, 1); const detection = h.state.writes[0].destination_detection;
  assert.equal(detection.kind, 'lead_form'); assert.equal(detection.forms[0].name, 'First visit');
  assert.ok(!JSON.stringify(h.state.writes).includes('private-token'));
  assert.ok(h.state.calls.every(call => !/leads|subscribed_apps/.test(call.path)));
  assert.ok(h.state.calls.every(call => call.options.maxRetries === 0 && call.options.timeout <= 10000));
});
test('unknown, unassigned, excluded and unauthorized campaigns cannot trigger provider queries', async () => {
  for (const mutate of [h => { h.state.campaigns = []; }, h => { h.state.campaigns[0].assigned = false; },
    h => { h.state.setting = { accounts: [] }; }, h => { h.state.assignments = []; },
    h => { h.state.connection.expiresAt = '2020-01-01'; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.run()); assert.equal(h.state.calls.length, 0); assert.equal(h.state.writes.length, 0);
  }
});
test('a scope revocation or cache edit during provider IO cannot be committed', async () => {
  for (const mutate of [h => { h.state.assignments = []; }, h => { h.state.cached = { id: 1, destination_detection: { changed: true } }; },
    h => { h.state.setting = { accounts: [] }; }]) {
    const h = harness(); h.state.beforeTransaction = () => mutate(h);
    await assert.rejects(h.run()); assert.equal(h.state.writes.length, 0);
  }
});
test('provider identities are checked against the chosen account and campaign, including forms and conflicting duplicates', async () => {
  for (const patch of [{ account_id: '999' }, { campaign_id: '999' }, { id: 10 }]) {
    const h = harness(); h.state.graphRows = [ad('10', patch)];
    await assert.rejects(h.run(), /identity_mismatch/); assert.equal(h.state.writes.length, 0);
  }
  const h = harness(); h.state.form = { page_id: '999' };
  await assert.rejects(h.run(), /identity_mismatch/);
  const duplicate = harness(); duplicate.state.graphRows = [ad(), ad('10', { creative: {} })];
  await assert.rejects(duplicate.run(), /identity_mismatch/);
});
test('permission and rate-limit errors are sanitized and do not overwrite a previous cache', async () => {
  for (const code of [190, 4, 500]) {
    const h = harness(); h.state.graphError = { response: { data: { error: { code, message: 'private-contact' } } }, config: { token: 'private-token' } };
    await assert.rejects(h.run(), error => { assert.equal(error.status, 409); assert.ok(!JSON.stringify(error).includes('private')); return true; });
    assert.equal(h.state.writes.length, 0);
  }
});
test('partial form metadata is not advertised as a proven permission to retrieve leads', async () => {
  const h = harness(); h.state.form = { name: null };
  await h.run();
  const form = h.state.writes[0].destination_detection.forms[0];
  assert.equal(form.metadata_accessible, true); assert.equal(form.leads_accessible, undefined);
});
