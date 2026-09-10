'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JOB_TYPE, pageFingerprint, pageProof, pageCommand, requestPageReception, getPageReceptionJob,
  runPageReceptionJob, assertPageMutation } = require('../../services/campaignWorkspaceMetaPage.service');
const { revision } = require('../../services/campaignWorkspaceMetaDestination.service');

function harness() {
  const state = { scope: { isValid: true, clinicIds: [1] }, allowed: true, proofWrites: [], graph: [], posts: [],
    page: { id: 8, metaAssetId: '40', metaConnectionId: 7, assignmentScope: 'clinic', clinicaId: 1,
      pageAccessToken: 'private-page-token', additionalData: { unrelated: 'preserved' } },
    campaign: { id: 'meta_ads:20:30', provider: 'meta_ads', account_id: '20', campaign_id: '30', assigned: true, clinicId: 1,
      nativeForms: [{ id: '50', pageId: '40' }] },
    assignments: [{ scopeKey: 'clinic:1', metaConnectionId: 7 }], apps: [{ id: '9', subscribed_fields: ['messages', 'feed'] }],
    leadAccess: true, connection: { id: 7, accessToken: 'private-token', expiresAt: '2099-01-01' }, setting: null };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 1, estado_clinica: 1, grupoClinicaId: null }) },
    CampaignWorkspaceSetting: { findOne: async () => state.setting },
    ClinicMetaAsset: { findAll: async ({ where }) => where.assetType === 'facebook_page' ? state.pages || [structuredClone(state.page)]
      : [{ metaConnectionId: 7, assignmentScope: 'clinic', clinicaId: 1 }],
    update: async (values, options) => { assert.equal(options.transaction, transaction); state.proofWrites.push(values); Object.assign(state.page, values); } },
    MetaConnectionAssignment: { findAll: async () => state.assignments }, MetaConnection: { findByPk: async () => state.connection },
    ExternalCampaignInventory: { findAll: async () => [] }, JobRequest: { findByPk: async () => state.job },
    GroupAssetClinicAssignment: { findAll: async () => [] },
    sequelize: { transaction: async fn => fn(transaction) },
  };
  const loadInventory = async () => ({ campaigns: [state.campaign], selectedClinics: [{ id_clinica: 1, estado_clinica: 1 }] });
  const command = { account_id: '20', campaign_id: '30', page_id: '40', revision: revision(null), action: 'check' };
  const payload = () => ({ ...command, scope: '1', asset_id: 8, fingerprint: pageFingerprint(state.page) });
  const job = { id: 3, requested_by: 1 };
  const options = { models, loadInventory, applicationId: '9', resolveScope: async () => state.scope, hasAccess: async () => state.allowed,
    read: async (path, config) => {
      state.graph.push({ path, config }); state.onRead?.(path);
      if (state.error) throw state.error;
      return { data: path === '40' ? { id: '40', has_lead_access: state.leadAccess }
        : { data: state.apps, ...(state.partial ? { paging: { next: 'untrusted' } } : {}) } };
    },
    subscribe: async (page, fields, config) => {
      state.posts.push({ page, fields, config });
      if (!state.unconfirmed) state.apps = [{ id: '9', subscribed_fields: fields }];
    },
  };
  return { state, models, options, command, payload, job, loadInventory, transaction,
    run: (patch = {}) => runPageReceptionJob({ ...payload(), ...patch }, job, options) };
}

test('page enable is explicit and rejects arbitrary ownership, endpoints, tokens and confirmation coercion', () => {
  const h = harness(); assert.equal(pageCommand(h.command).action, 'check');
  assert.equal(pageCommand({ ...h.command, action: 'enable', confirmed: true }).action, 'enable');
  for (const patch of [{ token: 'private' }, { actorId: 2 }, { scope: '9' }, { page_id: '../me' }, { revision: 'old' },
    { action: 'enable' }, { action: 'enable', confirmed: 'true' }, { action: 'check', confirmed: true }]) {
    assert.throws(() => pageCommand({ ...h.command, ...patch }), /invalid_meta_page_command/);
  }
});
test('checking an existing page reads only access and subscriptions and preserves unrelated asset metadata', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.status, 'completed'); assert.equal(result.reception, 'subscription_required'); assert.equal(h.state.posts.length, 0);
  assert.deepEqual(h.state.graph.map(row => row.path), ['40', '40/subscribed_apps']);
  assert.ok(h.state.graph.every(row => row.config.maxRetries === 0 && row.config.timeout <= 10000));
  assert.equal(h.state.page.additionalData.unrelated, 'preserved');
  assert.equal(h.state.page.additionalData.campaign_lead_reception.job_id, 3);
  assert.ok(!JSON.stringify(h.state.proofWrites).includes('private'));
});
test('enabling keeps Messenger and social subscriptions, verifies leadgen and never edits ads or conversions', async () => {
  const h = harness(); const result = await h.run({ action: 'enable', confirmed: true });
  assert.equal(result.status, 'completed'); assert.equal(result.reception, 'verified');
  assert.deepEqual(h.state.posts.map(row => [row.page, row.fields]), [['40', ['messages', 'feed', 'leadgen']]]);
  assert.equal(h.state.graph.length, 4);
  await h.run({ action: 'enable', confirmed: true });
  assert.equal(h.state.posts.length, 1, 'a retry sees the existing subscription instead of replacing it');
});
test('a successful subscription POST is insufficient without a confirming GET', async () => {
  const h = harness(); h.state.unconfirmed = true;
  const result = await h.run({ action: 'enable', confirmed: true });
  assert.equal(result.status, 'failed'); assert.equal(result.error_message, 'workspace_meta_subscription_unconfirmed');
  assert.equal(result.retryable, true); assert.equal(h.state.proofWrites.length, 0);
});
test('missing lead access is a persisted pending state, not a successful setup or a subscription write', async () => {
  const h = harness(); h.state.leadAccess = false;
  const result = await h.run({ action: 'enable', confirmed: true });
  assert.equal(result.reception, 'access_required'); assert.equal(h.state.posts.length, 0);
});
test('incomplete or missing subscription fields cannot erase pre-existing subscriptions', async () => {
  for (const change of [h => { h.state.partial = true; }, h => { h.state.apps[0].subscribed_fields = undefined; }]) {
    const h = harness(); change(h); const result = await h.run({ action: 'enable', confirmed: true });
    assert.equal(result.status, 'failed'); assert.equal(h.state.posts.length, 0); assert.equal(h.state.proofWrites.length, 0);
  }
});
test('revoked users, OAuth assignments, excluded campaigns, expired tokens and foreign pages cause no Graph IO', async () => {
  for (const change of [h => { h.state.allowed = false; }, h => { h.state.assignments = []; },
    h => { h.state.setting = { accounts: [] }; }, h => { h.state.connection.expiresAt = '2020-01-01'; },
    h => { h.state.campaign.nativeForms = [{ id: '50', pageId: '99' }]; }, h => { h.state.pages = []; }]) {
    const h = harness(); change(h); const result = await h.run();
    assert.equal(result.status, 'failed'); assert.equal(h.state.graph.length, 0); assert.equal(h.state.posts.length, 0);
  }
});
test('access revocation or credential rotation during inspection prevents the subscription write', async () => {
  for (const change of [h => { h.state.allowed = false; }, h => { h.state.page.pageAccessToken = 'rotated'; }]) {
    const h = harness(); h.state.onRead = path => { if (path.endsWith('subscribed_apps')) change(h); };
    const result = await h.run({ action: 'enable', confirmed: true });
    assert.equal(result.status, 'failed'); assert.equal(h.state.posts.length, 0); assert.equal(h.state.proofWrites.length, 0);
  }
});
test('a clinic-only workspace cannot change an inherited group page subscription', async () => {
  const h = harness(); h.state.page.assignmentScope = 'group'; h.state.page.grupoClinicaId = 28;
  h.state.assignments.push({ scopeKey: 'group:28', metaConnectionId: 7 });
  const result = await h.run({ action: 'enable', confirmed: true });
  assert.equal(result.error_message, 'workspace_meta_page_group_required'); assert.equal(h.state.graph.length, 0);
});
test('provider failures expose safe codes and a permission failure supersedes a previous proof', async () => {
  const h = harness(); h.state.error = { response: { data: { error: { code: 190, message: 'private-contact' } } }, config: { token: 'private' } };
  const result = await h.run();
  assert.equal(result.error_message, 'workspace_meta_permissions_required'); assert.equal(result.retryable, false);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(h.state.page.additionalData.campaign_lead_reception.state, 'access_required');
});
test('proof is scoped to the credential, app and 24h window, without exposing a token', async () => {
  const h = harness(); await h.run(); const now = new Date();
  assert.equal(pageProof(h.state.page, now, '9').state, 'subscription_required');
  assert.equal(pageProof(h.state.page, new Date(+now + 86400001), '9'), null);
  assert.equal(pageProof(h.state.page, new Date(+now - 86400000), '9'), null);
  assert.equal(pageProof(h.state.page, now, '10'), null);
  h.state.page.pageAccessToken = 'rotated'; assert.equal(pageProof(h.state.page, now, '9'), null);
});
test('queue intent uses the authenticated actor and same transaction; no credentials or provider IO in the request', async () => {
  const h = harness(); const previous = process.env.META_APP_ID; process.env.META_APP_ID = '9';
  try {
    const result = await requestPageReception({ models: h.models, scope: h.state.scope, actorId: 1,
      input: h.command, loadInventory: h.loadInventory, enqueue: async (data, options) => {
        assert.equal(data.requestedBy, 1); assert.equal(data.type, JOB_TYPE); assert.equal(data.maxAttempts, 3);
        assert.equal(options.transaction, h.transaction); assert.equal(data.payload.asset_id, 8);
        assert.ok(!JSON.stringify(data).includes('private'));
        return { job: { id: 3, status: 'pending', payload: data.payload }, created: true };
      } });
    assert.equal(result.job.status, 'pending'); assert.equal(h.state.graph.length, 0);
    assert.deepEqual(Object.keys(result.job).sort(), ['action', 'error', 'id', 'status']);
  } finally { if (previous === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = previous; }
});
test('job status cannot leak another campaign or clinic and contains no payload or contacts', async () => {
  const h = harness(); h.state.job = { id: 3, type: JOB_TYPE, status: 'running', payload: h.payload(), requested_by: 1 };
  const args = { models: h.models, scope: h.state.scope, input: h.command, jobId: 3, loadInventory: h.loadInventory };
  const result = await getPageReceptionJob(args); assert.equal(result.job.status, 'running'); assert.equal(result.job.payload, undefined);
  h.state.job.payload.campaign_id = '99'; await assert.rejects(getPageReceptionJob(args), /job_not_found/);
});
test('shared page subscriptions retain the existing all-clinic mutation guard', async () => {
  const h = harness(); h.models.GroupAssetClinicAssignment.findAll = async () => [{ clinicaId: 99 }];
  const authorize = async ({ clinicIds }) => { assert.deepEqual(clinicIds, [1, 99]); return false; };
  await assert.rejects(assertPageMutation({ models: h.models, page: h.state.page, actorId: 1, hasAccess: authorize }), /shared_access_required/);
  h.options.hasAccess = async ({ clinicIds }) => !clinicIds.includes(99);
  const result = await h.run({ action: 'enable', confirmed: true });
  assert.equal(result.status, 'failed'); assert.equal(h.state.graph.length, 0);
});
