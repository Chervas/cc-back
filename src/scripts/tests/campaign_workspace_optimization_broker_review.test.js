'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { writerFixture } = require('./fixtures/campaign_workspace_optimization_writer.fixture');
const { resolveOptimizationReview, revision, publicRun } = require('../../services/campaignWorkspaceOptimizationHistory.service');
const { resolveGoogleAdsGrantTransport } = require('../../services/googleAdsGrantTransport.service');
const C = require('../../../services/integrations-broker/src/google-optimization-write-contract');

async function fixture(t, mode = 'unknown') {
  const f = await writerFixture(t); await f.enqueue();
  if (mode === 'unknown') {
    const apply = f.provider.state.afterWrite;
    f.provider.state.afterWrite = request => { apply(request); throw Object.assign(Error('lost'), { code: 'provider_timeout' }); };
  } else f.state.lostCommit = true;
  assert.equal((await f.run()).result.state, 'uncertain'); f.provider.state.afterWrite = null;
  f.state.now = new Date(f.row().outcome.broker_submission.payload.expiresAt + C.REVIEW_DELAY_MS + 1); f.provider.state.at = +f.state.now;
  const models = f.deps.models; const local = { events: [], failAudit: false, lostClose: false, beforeCommit: null };
  const transaction = models.sequelize.transaction;
  models.sequelize.transaction = async fn => {
    const savedSetting = structuredClone(f.setting), savedEvents = structuredClone(local.events);
    let committed = false;
    try {
      const result = await transaction(async tx => { const result = await fn(tx); await local.beforeCommit?.(); return result; });
      committed = true;
      if (local.lostClose && f.row().status === 'resolved') { local.lostClose = false; throw Error('fictitious-commit-acknowledgement-lost'); }
      return result;
    } catch (error) { if (!committed) { Object.assign(f.setting, savedSetting); local.events = savedEvents; } throw error; }
  };
  models.CampaignWorkspaceSetting.findOne = async () => ({ ...structuredClone(f.setting), update: async patch => Object.assign(f.setting, structuredClone(patch)) });
  models.CampaignWorkspaceSetting.findAll = async () => [structuredClone(f.setting)];
  models.Clinica = { findByPk: async () => ({ ...f.scope.state.clinics[0], estado_clinica: 1 }) };
  models.UsuarioClinica = { findAll: async () => [] };
  models.CampaignWorkspaceEvent = { create: async event => { if (local.failAudit) throw Error('fictitious-audit-failure'); local.events.push(event); } };
  models.ClinicGoogleAdsAccount = { findAll: async () => [structuredClone(f.scope.mapping)] };
  models.GoogleConnectionAssignment = { findAll: async () => f.scope.state.grants.map(row => ({ ...row, scopeKey: 'group:5', connectedAt: '2026-09-01T00:00:00Z' })) };
  models.ExternalCampaignAssignment = { findAll: async () => [{ status: 'active', clinica_id: 1 }] };
  const options = { models, scope: { groupId: null, clinicIds: [1] }, actorId: 7, runId: f.row().id,
    input: { confirmed: true, expected_revision: revision(f.row()) }, namespace: 'isolated-test', now: () => f.state.now,
    env: { GOOGLE_ADS_OPTIMIZATION_BROKER_ENABLED: 'true' },
    hasAccess: async () => f.state.permitted,
    loadInventory: async () => ({ campaigns: [structuredClone(f.source.context.campaign)] }),
  };
  return { ...f, local, options, review: extra => resolveOptimizationReview({ ...options, ...extra }) };
}

for (const mode of ['unknown', 'unsent']) test(`${mode}: real CRM resolution seals broker state and audits local closure without provider mutation`, async t => {
  const f = await fixture(t, mode); const writes = f.provider.state.writes;
  const result = await f.review(); assert.deepEqual(result, { success: true, changed: true });
  assert.equal(f.row().status, 'resolved'); assert.equal(f.row().resolution.broker_review.state, 'reviewed');
  assert.equal(f.row().resolution.broker_review.result.previousState, mode === 'unknown' ? 'unknown' : 'not_found');
  assert.equal(f.provider.state.writes, writes); assert.equal(f.local.events.length, 1);
  assert.equal(f.local.events[0].changes.provider_mutation, false); assert.equal(f.setting.version, 2);
  const publicResult = publicRun(f.row(), f.source.context.campaign);
  assert.doesNotMatch(JSON.stringify(publicResult), /broker_review|broker_submission|resourceName|FICTITIOUS/);
  assert.deepEqual(await f.review(), { success: true, changed: false }); assert.equal(f.local.events.length, 1);
});
test('lost broker acknowledgement and failed local audit can retry review without replaying apply', async t => {
  for (const mode of ['ack', 'audit', 'sql-ack']) await t.test(mode, async t => {
    const f = await fixture(t); const writes = f.provider.state.writes;
    if (mode === 'ack') f.writerState.afterWriter = command => { if (command.operation === C.OPERATIONS.review) throw Object.assign(Error('lost'), { code: 'broker_timeout' }); };
    if (mode === 'audit') f.local.failAudit = true;
    if (mode === 'sql-ack') f.local.lostClose = true;
    await assert.rejects(f.review()); assert.equal(f.provider.state.writes, writes);
    assert.equal(f.row().status, mode === 'sql-ack' ? 'resolved' : 'uncertain');
    f.writerState.afterWriter = null; f.local.failAudit = false;
    await f.review(); assert.equal(f.row().status, 'resolved'); assert.equal(f.local.events.length, 1);
    assert.equal(f.provider.state.writes, writes);
    assert.equal(f.writerState.commands.filter(row => row.operation === C.OPERATIONS.review).length, 1);
  });
});
test('permission, binding, assignment, lease and writer changes stop local closure before or after the broker receipt', async t => {
  for (const phase of ['before', 'after']) for (const [name, change] of [
    ['permission', f => { f.state.permitted = false; }],
    ['binding', f => { f.scope.binding.state = 'revoked'; }],
    ['assignment', f => { f.source.context.campaign.clinicId = 2; }],
    ['lease', f => { f.row().lease_token = 'other'; f.row().lease_until = new Date(+f.state.now + 60000); }],
    ['writer', f => { f.writerState.writerIdentity = 'c'.repeat(64); }],
  ]) await t.test(`${phase}-${name}`, async t => {
    const f = await fixture(t);
    if (phase === 'before') change(f);
    else f.writerState.afterWriter = command => { if (command.operation === C.OPERATIONS.review) change(f); };
    await assert.rejects(f.review()); assert.equal(f.row().status, 'uncertain'); assert.equal(f.local.events.length, 0);
    assert.equal(f.provider.state.writes, 1);
  });
});
test('review uses current human permission even when the advertising mandate is paused', async t => {
  const f = await fixture(t); f.setting.activation.optimization.status = 'paused';
  assert.equal((await f.review()).success, true); assert.equal(f.row().status, 'resolved'); assert.equal(f.provider.state.writes, 1);
});
test('late broker recovery of a reviewed attempt never labels it as an applied advertising adjustment', async t => {
  const f = await fixture(t); f.local.failAudit = true; await assert.rejects(f.review()); f.local.failAudit = false;
  f.check(); const result = await f.run();
  assert.equal(result.result.state, 'uncertain'); assert.equal(result.result.broker_state, 'reviewed'); assert.equal(f.provider.state.writes, 1);
});
test('broker-only transport resolution never loads legacy credentials when mapping markers disappear', async t => {
  const f = await fixture(t); f.scope.mapping.broker_read_connection_ref = null; f.scope.mapping.broker_read_asset_ref = null;
  f.scope.state.bindings = [];
  await assert.rejects(resolveGoogleAdsGrantTransport({ models: f.deps.models, accounts: [f.scope.mapping], requiredScopes: [], requireBroker: true }), { code: 'broker_binding_invalid' });
  await assert.rejects(f.review()); assert.equal(f.local.events.length, 0); assert.equal(f.provider.state.writes, 1);
});
