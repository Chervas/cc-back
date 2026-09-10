'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceConfigurationHandlers } = require('../../controllers/campaignWorkspace.controller');

function harness(options = {}) {
  const calls = [];
  const models = { CampaignWorkspaceSetting: { findOne: async input => { calls.push(['settings', input]); return null; } } };
  const handlers = createWorkspaceConfigurationHandlers({ models,
    resolveScope: async () => ({ isValid: true, clinicIds: [1, 2], groupId: 5 }),
    hasAccess: async value => { calls.push(['access', value]); return true; },
    loadInventory: async () => { calls.push(['inventory']); return { campaigns: [], accounts: [] }; },
    save: async value => { calls.push(['save', value]); return { success: true }; }, ...options });
  const res = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; },
    set(key, value) { this.headers[key] = value; return this; }, json(value) { this.body = value; return this; } };
  return { calls, res, run: (method, input = {}) => handlers[method]({ userData: { userId: 7 }, query: { scope: 'group:5' }, body: { expected_version: 0, accounts: [] }, ...input }, res) };
}

test('configuration queries and commands require an authenticated session', async () => {
  for (const method of ['get', 'put', 'preparation', 'activate', 'assign', 'metaPreparation', 'refreshMeta', 'requestMetaPage', 'metaPageJob']) {
    const h = harness(); await h.run(method, { userData: null });
    assert.equal(h.res.statusCode, 401); assert.equal(h.calls.length, 0);
  }
});
test('page reception commands require full write scope, status only needs read scope', async () => {
  const forbidden = harness({ hasAccess: async input => input.access === 'read', requestMetaPage: () => assert.fail('forbidden command') });
  await forbidden.run('requestMetaPage'); assert.equal(forbidden.res.statusCode, 403);
  const allowed = harness({ requestMetaPage: async input => {
    assert.equal(input.actorId, 7); assert.deepEqual(input.scope.clinicIds, [1, 2]); return { success: true, job: { id: 1 } };
  } });
  await allowed.run('requestMetaPage'); assert.equal(allowed.res.statusCode, 202);
  const status = harness({ hasAccess: async input => input.access === 'read', metaPageJob: async input => {
    assert.equal(input.jobId, 1); assert.deepEqual(input.scope.clinicIds, [1, 2]); return { success: true };
  } });
  await status.run('metaPageJob', { query: { scope: 'group:5', account_id: '20', campaign_id: '30' }, params: { jobId: '1' } });
  assert.equal(status.res.statusCode, 200);
});
test('Meta checks require full-scope write access; opening the dialog only reads cached proof', async () => {
  const forbidden = harness({ hasAccess: async input => input.access === 'read', refreshMeta: () => assert.fail('forbidden check') });
  await forbidden.run('refreshMeta'); assert.equal(forbidden.res.statusCode, 403);
  const cached = harness({
    metaContext: async ({ reference }) => { assert.equal(reference.campaign_id, '30'); return { campaign: { id: 'meta_ads:20:30' }, revision: 'cached', connection: { accessToken: 'private' } }; },
    nativeEvidence: async () => new Map(),
  });
  await cached.run('metaPreparation', { query: { scope: 'group:5', account_id: '20', campaign_id: '30' } });
  assert.equal(cached.res.statusCode, 200); assert.equal(cached.res.body.revision, 'cached');
  assert.equal(JSON.stringify(cached.res.body).includes('private'), false);
  assert.equal(cached.res.headers['Cache-Control'], 'private, no-store');
});
test('ambiguous aggregates cannot become writable workspaces', async () => {
  for (const scope of ['all', '1,2', 'group:0', '1x', '']) {
    const h = harness(); await h.run('put', { query: { scope } });
    assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  }
});
test('every member of a group needs write access before any command', async () => {
  const seen = [];
  const h = harness({ hasAccess: async input => { seen.push(input); return input.access !== 'write'; } });
  await h.run('put');
  assert.equal(h.res.statusCode, 403); assert.equal(h.calls.length, 0);
  assert.deepEqual(seen[0], { userId: 7, clinicIds: [1, 2], access: 'write' });
});
test('a read-only user can inspect settings, but receives no write capability', async () => {
  const h = harness({ hasAccess: async input => input.access === 'read' });
  await h.run('get');
  assert.equal(h.res.statusCode, 200); assert.equal(h.res.body.canWrite, false);
  assert.equal(h.res.body.configuration.version, 0);
  assert.deepEqual(h.res.body.scope, { clinicIds: [1, 2], groupId: 5 });
  assert.equal(h.res.headers['Cache-Control'], 'private, no-store');
});
test('version conflicts are a client error and never return a successful configuration', async () => {
  const h = harness({ save: async () => { throw Object.assign(new Error('workspace_version_conflict'), { status: 409 }); } });
  await h.run('put');
  assert.equal(h.res.statusCode, 409); assert.equal(h.res.body.success, false);
  assert.equal(h.res.body.error, 'workspace_version_conflict');
});
test('save uses the authenticated actor and resolved scope, never body-supplied ownership', async () => {
  const h = harness(); await h.run('put', { body: { actorId: 999, scope: '9' } });
  const command = h.calls.find(([type]) => type === 'save')[1];
  assert.equal(command.actorId, 7); assert.deepEqual(command.scope.clinicIds, [1, 2]);
});
test('preparation is read-only and protected by the full resolved scope', async () => {
  const reads = [];
  const h = harness({ prepare: async input => { reads.push(input); return { success: true, receptionReady: false }; } });
  await h.run('preparation'); assert.equal(h.res.statusCode, 200);
  assert.deepEqual(reads[0].scope.clinicIds, [1, 2]); assert.equal(h.res.headers['Cache-Control'], 'private, no-store');
});
test('activation requires every group member to be writable before invoking the command', async () => {
  const h = harness({ hasAccess: async input => input.access === 'read', activate: () => assert.fail('forbidden command') });
  await h.run('activate'); assert.equal(h.res.statusCode, 403);
});
test('campaign assignment requires full-group write access and authenticated ownership', async () => {
  const forbidden = harness({ hasAccess: async () => false, assign: () => assert.fail('forbidden command') });
  await forbidden.run('assign'); assert.equal(forbidden.res.statusCode, 403);
  const allowed = harness({ assign: async input => {
    assert.equal(input.actorId, 7); assert.deepEqual(input.scope.clinicIds, [1, 2]);
    throw Object.assign(new Error('changed'), { httpStatus: 409, code: 'workspace_assignment_already_reviewed' });
  } });
  await allowed.run('assign', { body: { actorId: 999, scope: '9' } });
  assert.equal(allowed.res.statusCode, 409); assert.equal(allowed.res.body.error, 'workspace_assignment_already_reviewed');
});
test('activation uses authenticated ownership and returns deployment/readiness conflicts as conflicts', async () => {
  const h = harness({ activate: async input => {
    assert.equal(input.actorId, 7); assert.deepEqual(input.scope.clinicIds, [1, 2]);
    throw Object.assign(new Error('pending'), { status: 409, code: 'workspace_reception_pending' });
  } });
  await h.run('activate', { body: { actorId: 999, scope: '9' } });
  assert.equal(h.res.statusCode, 409); assert.equal(h.res.body.error, 'workspace_reception_pending');
});
