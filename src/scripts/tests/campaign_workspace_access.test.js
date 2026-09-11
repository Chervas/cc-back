'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceHandler } = require('../../controllers/campaignWorkspace.controller');

function harness(overrides = {}) {
  const calls = [];
  const scope = { isValid: true, clinicIds: [1, 2], groupId: 5 };
  const handler = createWorkspaceHandler({ models: {}, resolveScope: async () => scope,
    hasAccess: async input => { calls.push(['access', input]); return true; },
    accessibleClinics: async () => [1], load: async input => { calls.push(['load', input]); return { success: true }; }, ...overrides });
  const response = { code: 200, body: null, headers: {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }, set(name, value) { this.headers[name] = value; return this; } };
  return { calls, response, run: query => handler({ userData: { userId: 7 }, query }, response) };
}
test('workspace checks complete group membership before loading any business data', async () => {
  const h = harness({ hasAccess: async () => false }); await h.run({ scope: 'group:5' });
  assert.equal(h.response.code, 403); assert.equal(h.calls.length, 0);
});
test('workspace rejects malformed scopes and dates before data access', async () => {
  for (const scope of ['', '1x', 'group:5x', '1,-2', '0']) {
    const h = harness(); await h.run({ scope }); assert.equal(h.response.code, 400); assert.equal(h.calls.length, 0);
  }
  const h = harness(); await h.run({ scope: '1', days: '180' }); assert.equal(h.response.code, 400);
});
test('workspace all is intersected with authorized clinics', async () => {
  const h = harness({ resolveScope: async () => ({ isAll: true, isValid: true, clinicIds: [1, 2, 3], groupId: null }) });
  await h.run({ scope: 'all' });
  assert.deepEqual(h.calls.find(([kind]) => kind === 'load')[1].scope.clinicIds, [1]);
});
test('workspace missing session never reaches the scope resolver', async () => {
  let resolved = false;
  const handler = createWorkspaceHandler({ resolveScope: async () => { resolved = true; } });
  const h = harness(); await handler({ query: { scope: '1' } }, h.response);
  assert.equal(h.response.code, 401); assert.equal(resolved, false);
});
test('successful workspace response is not stored in browser or shared HTTP caches', async () => {
  const h = harness(); await h.run({ scope: 'group:5', days: '7' });
  assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
  assert.equal(h.calls.find(([kind]) => kind === 'load')[1].days, 7);
});
test('history inherits authorized aggregate scope and passes pagination without trusting an input actor', async () => {
  const h = harness({ history: true, resolveScope: async () => ({ isAll: true, isValid: true, clinicIds: [1, 2], groupId: null }) });
  await h.run({ scope: 'all', page: '2', campaign_id: 'campaign-1', actorId: 99 });
  const input = h.calls.find(([kind]) => kind === 'load')[1];
  assert.equal(input.actorId, 7); assert.deepEqual(input.scope.clinicIds, [1]);
  assert.deepEqual(input.input, { page: '2', campaignId: 'campaign-1' });
  assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
  const changed = harness({ history: true, load: async () => { throw Object.assign(Error('changed'), { status: 404, code: 'workspace_campaign_not_in_scope' }); } });
  await changed.run({ scope: '1' }); assert.equal(changed.response.code, 404);
});
