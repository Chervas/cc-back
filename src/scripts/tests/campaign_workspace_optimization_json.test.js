'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { optimizationChange, verifyChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const { validateRun } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const { publicOptimizationProof } = require('../../services/campaignWorkspaceOptimizationPreparation.service');
const { loadOptimizationAuthorizationReview } = require('../../services/campaignWorkspaceOptimizationAuthorization.service');
const { publicRun } = require('../../services/campaignWorkspaceOptimizationHistory.service');
const { fixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');

const reordered = value => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort((a, b) => b.length - a.length || b.localeCompare(a)).map(key => [key, item[key]])) : item));
const rawDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('optimization fingerprints survive reordered JSON keys, not changes to values, types or array order', () => {
  const value = { when: new Date('2026-09-11T12:00:00Z'), nested: { z: 2, a: 1 }, list: [{ z: 'x', a: true }, null] };
  assert.equal(digest(value), digest(reordered(value)));
  assert.notEqual(digest(value), digest({ ...value, list: [...value.list].reverse() }));
  assert.notEqual(digest(value), digest({ ...value, nested: { z: '2', a: 1 } }));
  assert.notEqual(digest(value), digest({ ...value, extra: true }));
});

test('stored execution commands and evidence retain integrity through a JSON round trip', async () => {
  const f = fixture(); await f.enqueue(); const row = reordered(f.row());
  assert.deepEqual(validateRun(row), f.change);
  row.evidence.daily[0].leads++; assert.throws(() => validateRun(row), /plan_changed/);
});

test('historical command fingerprints remain readable without reviving old noncanonical plan keys', async () => {
  const f = fixture(); await f.enqueue(); const row = f.row();
  const { fingerprint, ...body } = optimizationChange(f.change);
  const legacy = { ...body, fingerprint: rawDigest(body) };
  assert.notEqual(fingerprint, legacy.fingerprint);
  assert.equal(verifyChange(reordered(legacy)).fingerprint, legacy.fingerprint);
  row.change = legacy; row.plan_key = rawDigest([row.mandate_id, legacy.fingerprint, row.evidence]);
  const stored = reordered(row);
  assert.throws(() => validateRun(stored), /plan_changed/);
  const campaign = { ...f.change.reference, id: 'campaign', assigned: true, clinicId: 1, name: 'Fixture', currency: 'EUR' };
  assert.equal(publicRun(stored, campaign).status, 'queued');
  assert.throws(() => verifyChange({ ...legacy, after: '900' }), /change_invalid/);
});

test('persisted compatibility proof can be reviewed and authorized with reordered nested fields', async () => {
  const f = fixture(); const now = f.state.now; const reference = f.change.reference;
  const campaign = { ...reference, id: 'campaign', name: 'Fixture', assigned: true, clinicId: 1, paused: false };
  const setting = { id: f.setting.id, version: 1, accounts: [{ provider: reference.provider, account_id: reference.account_id,
    include_future: true, campaign_ids: [] }], preferences: { mode: 'optimize', optimization: { actions: ['adjust_bids'],
    budget_changes: false, monthly_limit_cents: null, max_budget_change_pct: 10 } } };
  const inspection = { schema_version: 1, reference, currency: 'EUR', targets: [{ ...f.change.target, value: '1000' }],
    actions: ['pause_underperforming_ads', 'adjust_bids', 'negative_keywords', 'adjust_budget'].map(action => ({ action, targets: Number(action === 'adjust_bids'), reasons: [] })) };
  inspection.fingerprint = digest([reference, inspection.currency, inspection.targets, inspection.actions]);
  const context = { setting, campaign, reference, fingerprint: 'b'.repeat(64), grant: { fingerprint: 'a'.repeat(64), connection: { id: 1 } },
    latest: { schema_version: 1, fingerprint: 'b'.repeat(64), status: 'checked', run_id: crypto.randomUUID(),
      checked_at: now.toISOString(), expires_at: new Date(+now + 86400000).toISOString(), inspection } };
  const stored = reordered(context); stored.reference = reference;
  assert.equal(publicOptimizationProof(stored, now).status, 'checked');
  const result = await loadOptimizationAuthorizationReview({ models: {}, scope: { clinicIds: [1] }, setting: stored.setting,
    campaigns: [campaign], resolveContext: async () => stored, now });
  assert.equal(result.review.ready, true); assert.equal(result.authorization.campaigns[0].targets.length, 1);
  delete stored.latest.inspection.reference;
  assert.equal(publicOptimizationProof(stored, now).status, 'stale');
});
