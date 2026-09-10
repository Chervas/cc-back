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
  for (const method of ['get', 'put']) {
    const h = harness(); await h.run(method, { userData: null });
    assert.equal(h.res.statusCode, 401); assert.equal(h.calls.length, 0);
  }
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
