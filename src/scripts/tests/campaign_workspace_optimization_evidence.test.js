'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { collectOptimizationEvidence, MAX_LEADS } = require('../../services/campaignWorkspaceOptimizationEvidence.service');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');

const { fixture } = require('./fixtures/campaign_workspace_optimization_evidence.fixture');

test('closed gates inspect neither credentials, models nor provider transports', async () => {
  const inaccessible = new Proxy({}, { get() { assert.fail('closed gate accessed dependency'); } });
  assert.deepEqual(await collectOptimizationEvidence({}, { env: {}, models: inaccessible }),
    { collected: false, reason: 'workspace_optimization_disabled' });
});

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: real mandate validator, search/Graph reader and CRM identity matcher create private aggregate evidence`, async () => {
    const f = fixture(provider); const result = await f.run();
    assert.equal(result.collected, true, result.reason);
    const evidence = result.evidence; const { fingerprint, ...body } = evidence;
    assert.equal(fingerprint, digest(body)); assert.equal(evidence.clinic_id, 1); assert.deepEqual(evidence.reference, f.input.reference);
    assert.equal(evidence.attribution.complete, true); assert.equal(evidence.attribution.unattributed_leads, 0);
    assert.equal(evidence.attribution.ad_daily.reduce((sum, row) => sum + row.leads, 0), 24);
    assert.equal(evidence.attribution.basis, 'crm_created_at'); assert.equal(evidence.performance.ad_daily.length, 56);
    assert.ok(f.state.checks > f.state.calls.length * 2);
    const query = f.state.leadQueries[0];
    assert.equal(query.where.clinica_id, 1); assert.equal(query.limit, MAX_LEADS + 1);
    assert.equal(query.where.created_at[Op.gte].toISOString(), '2026-08-11T22:00:00.000Z');
    assert.equal(query.where.created_at[Op.lt].toISOString(), '2026-09-08T22:00:00.000Z');
    assert.ok(!query.attributes.some(field => /email|nombre|telefono|payload/i.test(field)));
    assert.doesNotMatch(JSON.stringify(evidence), /fixture-only|accessToken|external_id|native_lead_id|lead_intake_id|raw_payload|patient|phone|email/);
    assert.equal(f.state.tokenChecks, provider === 'google_ads' ? 1 : 0);
  });

  test(`${provider}: paused mandate, invalid grant, scope exclusion and managed ownership stop before provider reads`, async () => {
    for (const mutate of [s => { s.setting.activation.optimization.status = 'paused'; }, s => { s.permitted = false; },
      s => { s.setting.accounts = []; }, s => { s.grant.fingerprint = 'b'.repeat(64); },
      s => { s.grant.connection.id = 9; }, s => { s.ownership = false; }, s => { s.reception = false; },
      s => { s.workspaceCampaign.destinationCheck = { status: 'failed', error: 'workspace_meta_permissions_required' }; }]) {
      const f = fixture(provider); mutate(f.state); const result = await f.run();
      assert.equal(result.collected, false); assert.equal(f.state.calls.length, 0); assert.equal(f.state.leadQueries.length, 0);
    }
  });

  test(`${provider}: permission, mandate, grant and gate changes between pages discard results without a next request`, async () => {
    for (const mutate of [f => { f.state.permitted = false; }, f => { f.state.setting.activation.optimization.status = 'paused'; },
      f => { f.state.setting.version++; }, f => { f.state.grant.connection.id = 9; },
      f => { f.deps.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'false'; }]) {
      const f = fixture(provider); f.state.beforeRead = () => mutate(f);
      const result = await f.run(); assert.equal(result.collected, false); assert.equal(f.state.calls.length, 1);
      assert.equal(f.state.leadQueries.length, 0); assert.equal(result.evidence, undefined);
    }
  });

  test(`${provider}: a formerly working receiver becoming unhealthy discards the completed provider snapshot`, async () => {
    const f = fixture(provider); let count = 0;
    f.state.onReception = () => { if (++count === 2) f.state.reception = false; };
    const result = await f.run(); assert.equal(result.reason, 'workspace_optimization_reception_unverified');
    assert.equal(result.evidence, undefined); assert.equal(f.state.leadQueries.length, 1);
  });

  test(`${provider}: attribution gaps remain gaps, including unknown paid leads and tampered identity proofs`, async () => {
    for (const mutate of [s => { s.auditRows.shift(); }, s => { s.auditRows[0].identity.ad_id = '999'; },
      s => { s.leads.push({ id: 99, clinica_id: 1, source: 'web', channel: 'paid', created_at: s.leads[0].created_at }); }]) {
      const f = fixture(provider); mutate(f.state); const result = await f.run();
      assert.equal(result.collected, true, result.reason); assert.equal(result.evidence.attribution.complete, false);
      assert.equal(result.evidence.attribution.unattributed_leads, 1);
    }
  });

  test(`${provider}: invalid, cross-clinic, duplicate or truncated CRM records never produce complete evidence`, async () => {
    for (const mutate of [s => { s.leads[0].clinica_id = 99; }, s => { s.leads[0].created_at = 'bad'; },
      s => { s.leads[0].created_at = '2026-09-11T00:00:00Z'; }, s => { s.leads.push(structuredClone(s.leads[0])); },
      s => { s.leads = Array.from({ length: MAX_LEADS + 1 }, () => s.leads[0]); }]) {
      const f = fixture(provider); mutate(f.state); const result = await f.run();
      assert.equal(result.reason, 'workspace_optimization_attribution_incomplete'); assert.equal(result.evidence, undefined);
    }
  });

  test(`${provider}: provider errors are sanitized and a rejected credential is never replaced or retried`, async () => {
    const f = fixture(provider);
    f.state.beforeRead = () => { throw { message: 'private-token fixture@example.test', response: { status: 401, data: { error: { code: 190 } } } }; };
    const result = await f.run(); assert.deepEqual(result, { collected: false, reason: 'workspace_optimization_permissions_required' });
    assert.equal(f.state.calls.length, 1); assert.equal(f.state.tokenChecks, provider === 'google_ads' ? 1 : 0);
  });
}

test('changing permission during Google token preparation stops before any ads query', async () => {
  const f = fixture(); f.state.onToken = () => { f.state.permitted = false; };
  assert.equal((await f.run()).reason, 'workspace_optimization_permissions_required'); assert.equal(f.state.calls.length, 0);
});

test('Google paginated requests recheck permission even within the same GAQL query', async () => {
  const f = fixture(); let calls = 0;
  f.deps.googleRequest = async () => {
    calls++; f.state.permitted = false;
    return { results: [], nextPageToken: 'never-fetch-page-two' };
  };
  assert.equal((await f.run()).reason, 'workspace_optimization_permissions_required'); assert.equal(calls, 1);
});

test('timeout and gate changes during authorization do not proceed to credential preparation', async () => {
  for (const mutate of [f => { f.state.now = new Date(+f.state.now + 60000); },
    f => { f.deps.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false'; }]) {
    const f = fixture(); f.state.onContext = () => mutate(f);
    assert.equal((await f.run()).collected, false); assert.equal(f.state.calls.length, 0); assert.equal(f.state.tokenChecks, 0);
  }
});

test('collection never invokes a mutation, queue, optimization run or journal writer', async () => {
  const f = fixture('meta_ads');
  f.deps.models.sequelize = { transaction: () => assert.fail('collector must not open a write transaction') };
  for (const name of ['CampaignWorkspaceOptimizationRun', 'JobRequest', 'CampaignWorkspaceEvent']) {
    f.deps.models[name] = new Proxy({}, { get() { assert.fail(`collector touched ${name}`); } });
  }
  const result = await f.run(); assert.equal(result.collected, true, result.reason);
});

test('a group collection stops when its clinic excludes the campaign after the first provider page', async () => {
  const f = fixture('meta_ads');
  f.state.setting.scope_type = 'group'; f.state.setting.scope_id = 10;
  f.state.setting.activation.optimization.authorization.clinic_ids = [1, 2];
  let local = null;
  f.deps.models.CampaignWorkspaceSetting.findOne = async input => {
    assert.deepEqual(input.where, { scope_type: 'clinic', scope_id: 1 }); return local;
  };
  f.state.beforeRead = () => { local = { accounts: [] }; };
  assert.equal((await f.run()).reason, 'workspace_optimization_campaign_not_authorized');
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.leadQueries.length, 0);
});
