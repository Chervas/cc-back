'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { optimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const { cents, budgetPeriod } = require('../../services/campaignWorkspaceBudgetSnapshot.service');
const { collectBudgetAccounting, reserveBudgetAccounting } = require('../../services/campaignWorkspaceBudgetAccounting.service');
const { fixture } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { Op } = require('sequelize');
const { recoverOptimizationRuns } = require('../../services/campaignWorkspaceOptimizationExecution.service');

const NOW = new Date('2026-09-11T12:00:00Z');
const sign = body => ({ ...body, fingerprint: digest(body) });
const reference = (provider, account_id, campaign_id) => ({ provider, account_id, campaign_id });
const snapshot = (ref, resources, spent, now) => sign({ schema_version: 1, reference: ref, period: budgetPeriod(now),
  currency: 'EUR', time_zone: 'Europe/Madrid', observed_at: now.toISOString(), spent_cents: spent,
  resources: resources.map(row => ({ ...row, daily_cents: cents(row.amount, row.unit) })) });

function harness() {
  const google = reference('google_ads', '20', '30'); const meta = reference('meta_ads', '21', '31');
  const change = optimizationChange({ reference: google, target: { action: 'adjust_budget', entity: 'campaign_budget', id: '50',
    resource: 'customers/20/campaignBudgets/50', field: 'amount_micros', unit: 'micros' }, before: '10000000', after: '9000000' });
  const setting = { id: 'setting', version: 1, scope_type: 'clinic', scope_id: 1,
    accounts: [google, meta].map(ref => ({ provider: ref.provider, account_id: ref.account_id, include_future: true, campaign_ids: [] })),
    activation: { optimization: { id: 'mandate' } } };
  const state = { now: NOW, campaigns: [google, meta].map(ref => ({ ...ref, assigned: true, clinicId: 1 })),
    resources: { 30: [{ resource: change.target.resource, amount: change.before, unit: 'micros' }], 31: [{ resource: '60', amount: '500', unit: 'minor' }] },
    costs: { 30: 5000, 31: 1000 }, prior: [], reads: [], grants: { 30: 'a'.repeat(64), 31: 'b'.repeat(64) }, locals: [] };
  const models = { CampaignWorkspaceSetting: { findAll: async () => state.locals },
    CampaignWorkspaceOptimizationRun: { findAll: async options => {
      assert.equal(options.where.setting_id, setting.id); assert.match(options.where[Op.or][0]['outcome.budget_accounting.month'], /^2026-\d{2}$/);
      assert.ok(options.transaction); assert.equal(options.lock, 'UPDATE'); return state.prior;
    } } };
  const authorization = { setting, scope: { groupId: null, clinicIds: [1] }, limits: { currency: 'EUR', monthly_limit_cents: 100000 } };
  const run = { id: 'run', setting_id: setting.id, mandate_id: 'mandate', change };
  const deps = { now: () => state.now, loadInventory: async () => ({ campaigns: structuredClone(state.campaigns) }),
    resolveContext: async ({ reference }) => ({ setting: structuredClone(setting), campaign: { clinicId: 1 },
      grant: { fingerprint: state.grants[reference.campaign_id], connection: { id: 7, accessToken: 'private-fixture' } } }),
    ensureToken: async () => ({ accessToken: 'private-fixture' }),
  };
  const read = async ({ reference, now }) => {
    state.reads.push(reference);
    if (state.duringRead) state.duringRead(reference);
    if (state.readError) throw state.readError;
    return snapshot(reference, state.resources[reference.campaign_id] || [], state.costs[reference.campaign_id] || 0, now);
  };
  deps.inspectGoogleBudget = read; deps.inspectMetaBudget = read;
  return { state, run, setting, models, authorization, deps,
    collect: () => collectBudgetAccounting({ models, run, authorization }, deps),
    reserve: accounting => reserveBudgetAccounting({ models, run, authorization, accounting, transaction: { LOCK: { UPDATE: 'UPDATE' } } }, deps) };
}

test('one monthly envelope combines Google, Meta, spend to date and every remaining calendar day', async () => {
  const h = harness(); const accounting = await h.collect(); const ledger = await h.reserve(accounting);
  assert.equal(h.state.reads.length, 2); assert.equal(ledger.reported_spend_cents, 6000);
  assert.equal(ledger.daily_commitment_cents, 1400); assert.equal(ledger.remaining_days, 20);
  assert.equal(ledger.today_reserve_cents, 100); assert.equal(ledger.projected_cents, 34100);
  assert.ok(!JSON.stringify(ledger).includes('private-fixture'));
  h.authorization.limits.monthly_limit_cents = 34100; assert.equal((await h.reserve(accounting)).projected_cents, 34100);
  h.authorization.limits.monthly_limit_cents = 34099; await assert.rejects(h.reserve(accounting), /budget_limit_exceeded/);
});

test('monthly accounting includes selected campaigns even when they are not authorized for adjustments', async () => {
  const h = harness(); h.state.costs[31] = 99000;
  await assert.rejects(h.reserve(await h.collect()), /budget_limit_exceeded/);
  assert.equal(h.state.reads.some(row => row.provider === 'meta_ads'), true);
});

test('unknown ownership, duplicate campaign identities and an empty selection never count as zero expense', async () => {
  for (const mutate of [h => { h.state.campaigns[1].assigned = false; }, h => { h.state.campaigns.push(h.state.campaigns[0]); },
    h => { h.setting.accounts = []; }, h => { h.state.campaigns[1].clinicId = 99; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.collect(), /budget_scope_incomplete/); assert.equal(h.state.reads.length, 0);
  }
});

test('clinic exclusions override group configuration and are rechecked before reserving', async () => {
  const h = harness(); h.authorization.scope.groupId = 10; h.setting.scope_type = 'group'; h.setting.scope_id = 10;
  const proof = await h.collect(); h.state.locals = [{ scope_id: 1, accounts: [] }];
  await assert.rejects(h.reserve(proof), /budget_scope_incomplete/);
});

test('changing scope, grant, resource, month or snapshot while collecting cannot authorize a mutation', async () => {
  for (const mutate of [h => { h.setting.version++; }, h => { h.state.campaigns.pop(); }, h => { h.state.grants[31] = 'c'.repeat(64); },
    h => { h.state.now = new Date(+NOW + 60000); }, h => { h.state.now = new Date('2026-09-30T22:00:00Z'); }]) {
    const h = harness(); const proof = await h.collect(); mutate(h); await assert.rejects(h.reserve(proof), /budget_(scope|stale)/);
  }
  const h = harness(); const proof = await h.collect(); proof.snapshots[0].spent_cents = 0;
  await assert.rejects(h.reserve(proof), /budget_stale/);
  const other = harness(); other.state.resources[30][0].amount = '11000000';
  await assert.rejects(other.reserve(await other.collect()), /budget_resource_changed/);
});

test('a provider rejection aborts collection before another account or credential is attempted', async () => {
  const h = harness(); h.state.readError = { response: { status: 401, data: { error: { code: 190 } } } };
  await assert.rejects(h.collect(), /permissions_required/); assert.equal(h.state.reads.length, 1);
});

test('a rejected Google credential is sanitized and prevents reads or trying a different account', async () => {
  for (const failure of [{ response: { status: 401, data: { secret: 'private-fixture' } } },
    ...['NO_SCOPED_CONNECTION', 'INSUFFICIENT_SCOPE', 'NO_TOKEN', 'TOKEN_EXPIRED', 'REFRESH_FAILED'].map(code => ({ code, message: 'private-fixture' }))]) {
    const h = harness(); h.deps.ensureToken = async () => { throw failure; };
    await assert.rejects(h.collect(), error => error.code === 'workspace_optimization_permissions_required' && !error.response);
    assert.equal(h.state.reads.length, 0);
    const f = fixture(); await f.enqueue(); f.deps.ensureToken = async () => { throw failure; };
    const result = await f.run(); assert.equal(result.result.state, 'skipped');
    assert.equal(result.result.reason, 'workspace_optimization_permissions_required');
    assert.equal(f.state.calls.read, 0); assert.equal(f.state.calls.mutate, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
  }
});

test('snapshots that expire or cross a calendar boundary while waiting for transaction locks cannot be reserved', async () => {
  for (const [start, end] of [
    [NOW, new Date(+NOW + 60000)],
    [new Date('2026-09-11T21:59:59Z'), new Date('2026-09-11T22:00:01Z')],
    [new Date('2026-09-30T21:59:59Z'), new Date('2026-09-30T22:00:01Z')],
  ]) {
    const h = harness(); h.state.now = start; const proof = await h.collect();
    const resolve = h.deps.resolveContext;
    h.deps.resolveContext = async (...args) => { h.state.now = end; return resolve(...args); };
    await assert.rejects(h.reserve(proof), /budget_stale/);
  }
});

test('actor authorization is rechecked between provider calls', async () => {
  const h = harness(); let allowed = true;
  h.deps.revalidate = async () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'workspace_optimization_permissions_required' }); };
  h.state.duringRead = () => { allowed = false; };
  await assert.rejects(h.collect(), /revoked/); assert.equal(h.state.reads.length, 1);
});

test('late cost reporting and a new mandate cannot reset spending already recorded in this month', async () => {
  const h = harness(); const initial = await h.reserve(await h.collect());
  h.state.prior = [{ outcome: { budget_accounting: initial } }];
  h.setting.activation.optimization.id = 'another'; h.run.mandate_id = 'another';
  h.state.costs[30] = 100; h.state.costs[31] = 0;
  assert.equal((await h.reserve(await h.collect())).reported_spend_cents, 6000);
});

test('removing an account retains its prior commitment instead of restoring artificial headroom', async () => {
  const h = harness(); const first = await h.reserve(await h.collect());
  h.state.prior = [{ outcome: { budget_accounting: first } }]; h.state.campaigns.pop(); h.setting.accounts.pop(); h.setting.version++;
  const ledger = await h.reserve(await h.collect());
  assert.equal(ledger.reported_spend_cents, 6000); assert.equal(ledger.daily_commitment_cents, 1400);
  assert.equal(ledger.resources.find(row => row.campaign_key === 'meta_ads:21:31').retained, true);
});

test('a fully inspected paused campaign releases future budget, not spent funds or historical facts', async () => {
  const h = harness(); const first = await h.reserve(await h.collect());
  h.state.prior = [{ outcome: { budget_accounting: first } }]; h.state.resources[31] = [];
  const ledger = await h.reserve(await h.collect());
  assert.equal(ledger.reported_spend_cents, 6000); assert.equal(ledger.daily_commitment_cents, 900);
  assert.equal(first.resources.length, 2);
});

test('later same-day checks preserve the highest commitment of previously reduced resources', async () => {
  const h = harness(); const first = await h.reserve(await h.collect());
  h.state.prior = [{ outcome: { budget_accounting: first } }]; h.state.resources[30][0].amount = '9000000';
  h.run.change = optimizationChange({ ...h.run.change, before: '9000000', after: '8100000' });
  const second = await h.reserve(await h.collect());
  assert.equal(second.today_reserve_cents, 190);
  h.state.now = new Date(+NOW + 86400000);
  assert.equal((await h.reserve(await h.collect())).today_reserve_cents, 90);
});

test('duplicate budget resources and corrupted ledger receipts fail closed', async () => {
  const h = harness(); const first = await h.reserve(await h.collect()); first.reported_spend_cents = 0;
  h.state.prior = [{ outcome: { budget_accounting: first } }]; await assert.rejects(h.reserve(await h.collect()), /ledger_invalid/);
  const duplicate = harness(); duplicate.state.resources[30].push(duplicate.state.resources[30][0]);
  await assert.rejects(duplicate.collect(), /budget_incomplete/);
  const missing = harness(); missing.state.prior = [{ outcome: { reason: 'legacy_receipt_without_budget' } }];
  await assert.rejects(missing.reserve(await missing.collect()), /ledger_invalid/);
});

test('budget reservation requires a transaction and binds exactly one run and change', async () => {
  const h = harness(); const proof = await h.collect();
  await assert.rejects(reserveBudgetAccounting({ models: h.models, run: h.run, authorization: h.authorization, accounting: proof }, h.deps), /accounting_required/);
  h.run.id = 'different-run'; await assert.rejects(h.reserve(proof), /budget_stale/);
});

function budgetExecution(provider) {
  const f = fixture(provider, 'adjust_budget');
  const ref = f.change.reference;
  f.setting.version = 1;
  f.setting.accounts = [{ provider, account_id: ref.account_id, include_future: true, campaign_ids: [] }];
  Object.assign(f.evidence, f.proof());
  const authorize = f.deps.authorize;
  f.deps.authorize = async options => {
    const result = await authorize(options); result.limits.currency = 'EUR'; result.limits.monthly_limit_cents = f.state.limit || 100000;
    return result;
  };
  f.deps.budgetDependencies = { now: () => f.state.now,
    loadInventory: async () => ({ campaigns: [{ ...ref, clinicId: 1, assigned: true }] }),
    resolveContext: async () => ({ setting: f.setting, campaign: { clinicId: 1 },
      grant: { fingerprint: 'a'.repeat(64), connection: { id: 1, accessToken: 'fixture-only' } } }),
    ensureToken: async () => ({ accessToken: 'fixture-only' }),
    inspectGoogleBudget: async () => snapshot(ref, [{ resource: f.change.target.resource, amount: f.state.remote, unit: f.change.target.unit }], 500, f.state.now),
    inspectMetaBudget: async () => snapshot(ref, [{ resource: f.change.target.resource, amount: f.state.remote, unit: f.change.target.unit }], 500, f.state.now),
  };
  return f;
}

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: real executor persists the budget receipt atomically before its simulated mutation`, async () => {
    const f = budgetExecution(provider); await f.enqueue();
    const mutate = f.deps.mutate;
    f.deps.mutate = async (...args) => {
      assert.equal(f.row().status, 'submitted'); assert.ok(f.row().submitted_at);
      assert.equal(f.row().outcome.budget_accounting.month, '2026-09'); return mutate(...args);
    };
    const result = await f.run(); assert.equal(result.result.state, 'verified'); assert.equal(f.state.calls.mutate, 1);
    assert.equal(f.row().outcome.budget_accounting.reported_spend_cents, 500);
    await f.run(); assert.equal(f.state.calls.mutate, 1); assert.ok(f.row().outcome.budget_accounting.fingerprint);
  });

  test(`${provider}: exceeding the envelope blocks the actual executor before submission`, async () => {
    const f = budgetExecution(provider); f.state.limit = 1; await f.enqueue();
    const result = await f.run(); assert.equal(result.result.reason, 'workspace_optimization_budget_limit_exceeded');
    assert.equal(f.state.calls.mutate, 0); assert.equal(f.row().submitted_at, null); assert.equal(f.row().outcome.budget_accounting, undefined);
  });

  test(`${provider}: a lost commit acknowledgement preserves the reservation and never repeats the write`, async () => {
    const f = budgetExecution(provider); await f.enqueue(); f.state.lostCommit = true;
    const first = await f.run(); assert.equal(first.result.state, 'uncertain'); assert.ok(f.row().outcome.budget_accounting);
    assert.equal(f.state.calls.mutate, 0); await f.run(); assert.equal(f.state.calls.mutate, 0); assert.ok(f.row().outcome.budget_accounting);
  });

  test(`${provider}: a denied recovery keeps the monthly reservation and never retries the provider change`, async () => {
    const f = budgetExecution(provider); await f.enqueue();
    f.deps.mutate = async () => { f.state.calls.mutate++; throw Error('timeout'); };
    await f.run(); const receipt = structuredClone(f.row().outcome.budget_accounting);
    assert.ok(receipt); f.state.permitted = false;
    f.state.now = new Date(+f.row().next_check_at + 1);
    const result = await recoverOptimizationRuns(f.deps);
    assert.equal(result.report.review_required, 1); assert.equal(f.row().status, 'uncertain');
    assert.deepEqual(f.row().outcome.budget_accounting, receipt); assert.equal(f.state.calls.mutate, 1);
  });

  test(`${provider}: the executor reads the prior month journal rather than accepting a lower delayed spend`, async () => {
    const f = budgetExecution(provider); await f.enqueue(); await f.run();
    f.state.now = new Date(+f.state.now + 14 * 86400000);
    const next = optimizationChange({ ...f.change, before: f.change.after, after: '903' });
    const read = f.deps.budgetDependencies.inspectGoogleBudget;
    const lowered = async (...args) => { const previous = await read(...args); const { fingerprint, ...body } = previous; return sign({ ...body, spent_cents: 100 }); };
    f.deps.budgetDependencies.inspectGoogleBudget = lowered; f.deps.budgetDependencies.inspectMetaBudget = lowered;
    f.deps.mutate = async () => { f.state.calls.mutate++; f.state.remote = next.after; return { acknowledged: true }; };
    await f.enqueue({ change: next, evidence: f.proof(next, 'next-cycle') });
    const result = await f.run(2); assert.equal(result.result.state, 'verified');
    assert.equal(f.row(2).outcome.budget_accounting.reported_spend_cents, 500);
  });
}
