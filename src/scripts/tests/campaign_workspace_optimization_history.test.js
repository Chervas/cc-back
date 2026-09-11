'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { fixture: executionFixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { publicRun, loadOptimizationHistory, resolveOptimizationReview, loadOptimizationIncidentEvidence, revision } = require('../../services/campaignWorkspaceOptimizationHistory.service');

function matches(row, where) {
  return Reflect.ownKeys(where).every(key => key === Op.or ? where[key].some(part => matches(row, part))
    : typeof where[key] === 'object' ? where[key][Op.in].includes(row[key]) : row[key] === where[key]);
}
function fixture() {
  const e = executionFixture(); const now = e.state.now;
  const setting = { id: e.setting.id, version: 4, accounts: ['preserved'], activation: { signals: { enabled: true } } };
  const campaign = { ...e.change.reference, id: 'campaign-1', clinicId: 1, name: 'Campaign A', assigned: true };
  const row = { id: crypto.randomUUID(), setting_id: setting.id, ...e.change.reference, clinic_id: 1, runtime_namespace: 'isolated-test',
    change: e.change, status: 'uncertain', plan_key: 'private-plan', job_request_id: 1, lease_token: null, submitted_at: now,
    updated_at: now, created_at: now, next_check_at: now, resolution: null, evidence: { confidential: 'not-public' } };
  const state = { rows: [row], setting, jobs: [{ id: 1, status: 'completed' }], campaigns: [campaign], events: [], permitted: true,
    readable: true, readCalls: 0, failAudit: false, clinics: [{ id_clinica: 1, estado_clinica: 1 }], queries: [] };
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const wrap = object => object && ({ ...object, update: async (patch, options) => {
    assert.equal(options.transaction, tx); Object.assign(object, patch);
  } });
  const models = {
    sequelize: { transaction: async fn => { const snapshot = structuredClone(state); try { return await fn(tx); }
      catch (error) { Object.assign(state, snapshot); throw error; } } },
    CampaignWorkspaceSetting: { findOne: async () => wrap(state.setting) },
    CampaignWorkspaceOptimizationRun: {
      findAndCountAll: async options => {
        state.queries.push(options); const selected = state.rows.filter(row => matches(row, options.where));
        return { count: selected.length, rows: selected.slice(options.offset, options.offset + options.limit) };
      },
      findByPk: async (id, options) => { assert.equal(options.lock, 'UPDATE'); return wrap(state.rows.find(row => row.id === id)); },
      findAll: async options => state.rows.filter(row => matches(row, options.where)),
    },
    JobRequest: { findAll: async options => state.jobs.filter(row => matches(row, options.where)), findByPk: async id => state.jobs.find(row => row.id === id) },
    UsuarioClinica: { findAll: async options => { assert.equal(options.lock, 'UPDATE'); return state.clinics; } },
    Clinica: { findByPk: async () => state.clinics[0], findAll: async () => state.clinics },
    GrupoClinica: { findByPk: async () => ({ id_grupo: 2 }) },
    CampaignWorkspaceEvent: { create: async (event, options) => { assert.equal(options.transaction, tx); if (state.failAudit) throw Error('audit_failed'); state.events.push(event); } },
  };
  const options = { models, scope: { groupId: null, clinicIds: [1] }, actorId: 7, namespace: 'isolated-test',
    loadInventory: async () => ({ campaigns: state.campaigns }), hasAccess: async ({ access, membershipModel }) => {
      if (membershipModel) await membershipModel.findAll({});
      if (access === 'read') { state.readCalls++; return state.readable; } return state.permitted;
    } };
  return { state, row, campaign, options,
    load: extra => loadOptimizationHistory({ ...options, now, ...extra }),
    resolve: extra => resolveOptimizationReview({ ...options, runId: row.id, input: { confirmed: true, expected_revision: revision(row) }, now: () => now, ...extra }),
  };
}

test('history is paginated on the server, prioritizes incidents and exposes no private execution data', async () => {
  const f = fixture(); for (let i = 1; i < 23; i++) f.state.rows.push({ ...f.row, id: crypto.randomUUID() });
  const result = await f.load({ input: { page: 2 } });
  assert.equal(result.total, 23); assert.equal(result.rows.length, 3); assert.equal(result.pageSize, 10);
  assert.equal(f.state.queries[0].offset, 20); assert.match(f.state.queries[0].order[0][0].val, /uncertain/);
  assert.equal(result.rows[0].canResolve, true); assert.equal(result.rows[0].before, '0,001 (moneda de la cuenta)');
  assert.doesNotMatch(JSON.stringify(result), /private-plan|not-public|setting_id|job_request_id|lease_token|customers\/|evidence/);
  assert.equal(f.state.readCalls, 2);
});
test('history and Health isolate clinic, account, campaign assignment and runtime namespace', async () => {
  const f = fixture();
  for (const patch of [{ clinic_id: 2 }, { campaign_id: 'other' }, { account_id: 'other' }, { runtime_namespace: 'staging' }]) {
    f.state.rows.push({ ...f.row, ...patch, id: crypto.randomUUID() });
  }
  assert.equal((await f.load()).total, 1);
  const evidence = await loadOptimizationIncidentEvidence({ ...f.options, campaigns: f.state.campaigns });
  assert.equal(evidence.size, 1); assert.equal(evidence.get('campaign-1').length, 1);
  f.campaign.assigned = false; assert.equal((await f.load()).total, 0);
  await assert.rejects(f.load({ input: { campaignId: 'campaign-1' } }), /workspace_campaign_not_in_scope/);
});
test('readers and global aggregates can inspect history without closing reviews', async () => {
  const f = fixture(); f.state.permitted = false;
  assert.equal((await f.load()).rows[0].canResolve, false);
  f.state.permitted = true;
  assert.equal((await f.load({ scope: { groupId: null, clinicIds: [1, 2] } })).rows[0].canResolve, false);
  assert.equal((await f.load({ scope: { groupId: null, clinicIds: [1], isAll: true } })).rows[0].canResolve, false);
  for (const page of [-1, 0.5, 'bad', 10001]) await assert.rejects(f.load({ input: { page } }), /invalid_optimization_history_query/);
  await assert.rejects(f.load({ input: { campaignId: ['campaign-1'] } }), /invalid_optimization_history_query/);
  f.state.readable = false; await assert.rejects(f.load(), /marketing_scope_forbidden/);
  let checks = 0;
  await assert.rejects(f.load({ hasAccess: async ({ access }) => access !== 'read' || ++checks === 1 }), /marketing_scope_forbidden/);
});
test('manual review is scoped, confirmed, versioned, audited and idempotent without changing reception or signals', async () => {
  const f = fixture(); const before = JSON.stringify(f.state.setting); const originalRevision = revision(f.row);
  assert.deepEqual(await f.resolve(), { success: true, changed: true });
  assert.equal(f.row.status, 'resolved'); assert.equal(f.row.next_check_at, null);
  assert.equal(f.state.setting.version, 5); assert.equal(f.state.events.length, 1);
  assert.equal(f.state.events[0].changes.provider_mutation, false); assert.equal(f.state.events[0].actor_user_id, 7);
  const previous = JSON.parse(before); assert.deepEqual(f.state.setting.accounts, previous.accounts); assert.deepEqual(f.state.setting.activation, previous.activation);
  assert.deepEqual(await f.resolve({ input: { confirmed: true, expected_revision: originalRevision } }), { success: true, changed: false });
  assert.equal(f.state.events.length, 1);
  const dto = (await f.load()).rows[0]; assert.equal(dto.canResolve, false); assert.match(dto.detail, /No se aplicaron cambios/);
});
test('resolution rejects changed revisions, foreign owners, changed scope and revoked permissions', async () => {
  for (const [mutate, code] of [
    [f => { f.row.setting_id = 'other'; }, 'workspace_optimization_run_not_found'],
    [f => { f.row.runtime_namespace = 'staging'; }, 'workspace_optimization_run_not_found'],
    [f => { f.campaign.clinicId = 2; }, 'workspace_campaign_not_in_scope'],
    [f => { f.state.clinics[0].estado_clinica = 0; }, 'workspace_scope_changed'],
    [f => { f.state.permitted = false; }, 'marketing_scope_forbidden'],
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(f.resolve(), new RegExp(code)); assert.equal(f.state.events.length, 0);
  }
  const f = fixture(); const old = revision(f.row); f.row.updated_at = new Date(+f.row.updated_at + 1000);
  await assert.rejects(f.resolve({ input: { confirmed: true, expected_revision: old } }), /workspace_optimization_review_changed/);
  let checks = 0;
  await assert.rejects(f.resolve({ hasAccess: async () => ++checks === 1 }), /marketing_scope_forbidden/);
  assert.equal(f.state.rows[0].status, 'uncertain'); assert.equal(f.state.events.length, 0);
});
test('running jobs, leases and unsubmitted commands cannot be dismissed as reviewed', async () => {
  for (const mutate of [f => { f.row.submitted_at = null; }, f => { f.row.status = 'queued'; },
    f => { f.row.lease_token = 'lease'; f.row.lease_until = new Date(+f.row.updated_at + 60000); },
    ...['pending', 'queued', 'running', 'waiting'].map(status => f => { f.state.jobs[0].status = status; })]) {
    const f = fixture(); mutate(f); assert.equal((await f.load()).rows[0].canResolve, false);
    await assert.rejects(f.resolve(), /workspace_optimization_review_busy/); assert.equal(f.state.events.length, 0);
  }
});
test('resolution strictly accepts confirmation only and rolls back both record and version if auditing fails', async () => {
  for (const patch of [{ confirmed: false }, { expected_revision: 'bad' }, { provider_mutation: true }]) {
    const f = fixture(); await assert.rejects(f.resolve({ input: { confirmed: true, expected_revision: revision(f.row), ...patch } }), /invalid_optimization_resolution/);
  }
  const f = fixture(); f.state.failAudit = true; await assert.rejects(f.resolve(), /audit_failed/);
  assert.equal(f.state.rows[0].status, 'uncertain'); assert.equal(f.state.setting.version, 4); assert.equal(f.state.events.length, 0);
});
test('observed state is not falsely labelled as an adjustment confirmed by the provider', () => {
  const f = fixture(); f.row.status = 'observed';
  assert.match(publicRun(f.row, f.campaign).detail, /no demuestra/);
});
test('known euro amounts are readable without rounding away micro bids or inventing currency', () => {
  const f = fixture(); f.campaign.currency = 'EUR';
  assert.match(publicRun(f.row, f.campaign).before, /0,001.*€/);
  f.campaign.currency = null; assert.match(publicRun(f.row, f.campaign).before, /moneda de la cuenta/);
});
