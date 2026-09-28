'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto'); const { setup } = require('./google-optimization-writes-fixture.cjs');
const { fail } = require('../src/errors'); const C = require('../src/google-optimization-write-contract');
const runtime = require('../src/google-main'); const { CUSTOMER, ACCESS } = require('./google-ads-fixture.cjs');

for (const kind of C.KINDS) test(`${kind}: one existing field, durable acknowledgement, secretless status and no duplicate write`, async t => {
  const f = setup(t); f.target(kind); const input = f.input(kind); const command = f.command('apply', input);
  const result = await f.execute(command); assert.equal(result.data.state, 'applied'); assert.equal(f.state.writes, 1);
  assert.equal(result.data.result.acknowledged, true);
  assert.equal((await f.execute(command)).replayed, true);
  assert.deepEqual((await f.execute(f.command('apply', input))).data, result.data);
  const secrets = f.state.sdk.length; assert.deepEqual(await f.status(input.executionId), result.data); assert.equal(f.state.sdk.length, secrets);
  f.reopen(); assert.deepEqual(await f.status(input.executionId), result.data); assert.equal(f.state.writes, 1);
  const write = f.state.calls.find(call => call.path.endsWith(':mutate'));
  assert.equal(write.json.operations.length, 1); assert.deepEqual(Object.keys(write.json.operations[0]).sort(), ['update', 'updateMask']);
  assert.doesNotMatch(JSON.stringify(write), /conversionActions|biddingStrategy|campaignCriteria|recommendations:apply|create|remove/);
  assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_optimization_locks').get().n, 0);
  const durable = JSON.stringify(['google_optimization_mutations', 'commands', 'audit_outbox'].map(name => f.getStore().db.prepare('SELECT * FROM ' + name).all()));
  assert.doesNotMatch(durable, /FICTITIOUS_ADS|FICTITIOUS_REFRESH|FICTITIOUS_CLIENT/); assert.match(durable, /optimization_provider_acknowledged/);
});
test('rejects injected HTTP, fields, owners, unsigned actions, excessive changes and missing baselines before secrets', async t => {
  const f = setup(t);
  for (const patch of [{ query: 'SELECT *' }, { accessToken: ACCESS }, { customerId: CUSTOMER }, { path: 'campaigns:mutate' },
    { kind: 'create_campaign' }, { campaignId: '30 OR 1=1' }, { baselineAdId: null }, { baselineAdId: '60' }, { after: 'ACTIVE' }]) {
    await assert.rejects(f.execute(f.command('apply', { ...f.input(), ...patch })), { code: 'invalid_request' });
  }
  for (const patch of [{ after: '1650001' }, { after: '1500001' }, { after: '0' }, { before: '1.5' }, { before: '9007199254740992' }]) {
    await assert.rejects(f.execute(f.command('apply', { ...f.input('manual_cpc'), ...patch })), { code: 'invalid_request' });
  }
  await assert.rejects(f.execute(f.command('apply', f.input()), { keyId: 'qa-key', privateKey: f.keys.privateKey }), { code: 'invalid_signature' });
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
});
test('campaign allowlist, absolute caps and explicit budget-increase opt-in are enforced before secrets', async t => {
  const f = setup(t);
  await assert.rejects(f.execute(f.command('apply', { ...f.input(), campaignId: '31' })), { code: 'scope_denied' });
  await assert.rejects(f.execute(f.command('apply', { ...f.input('daily_budget'), after: '21000000' })), { code: 'scope_denied' });
  f.binding.googleAdsOptimization.accounts[0].campaigns[0].maxBidMicros = '1400000'; f.reset();
  await assert.rejects(f.execute(f.command('apply', f.input('manual_cpc'))), { code: 'scope_denied' });
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.writes, 0);
  f.binding.googleAdsOptimization.accounts[0].campaigns[0].allowBudgetIncrease = true; f.reset();
  await f.execute(f.command('apply', { ...f.input('daily_budget'), after: '21000000' })); assert.equal(f.state.writes, 1);
});
test('numeric ROAS serialization preserves approved decimals and rejects lossy precision before secrets', async t => {
  const f = setup(t); f.target('target_roas');
  await assert.rejects(f.execute(f.command('apply', { ...f.input('target_roas'), before: '9007199254740990.1', after: '8907199254740990.1' })), { code: 'invalid_request' });
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.writes, 0);
  await f.execute(f.command('apply', { ...f.input('target_roas'), before: '4.000000', after: '3.800000' }));
  const sent = f.state.calls.find(call => call.path.endsWith(':mutate'));
  assert.equal(sent.json.operations[0].update.targetRoas.targetRoas, 3.8);
});
test('missing/changed provider baselines, restricted replacement ads and shared budgets never reach mutation', async t => {
  const cases = [ ['pause_ad', f => { f.state.rows.ads.pop(); }], ['pause_ad', f => { f.state.rows.ads[1].adGroupAd.primaryStatus = 'LIMITED'; }],
    ['pause_ad', f => { delete f.state.rows.ads[1].adGroupAd.policySummary.approvalStatus; }],
    ['pause_ad', f => { f.state.rows.campaign[0].customer.timeZone = 'UTC'; }],
    ['manual_cpc', f => { f.state.rows.ad_groups[0].adGroup.cpcBidMicros = '1550000'; }],
    ['manual_cpc', f => { f.state.rows.campaign[0].campaign.biddingStrategyType = 'TARGET_CPA'; }],
    ['daily_budget', f => { f.state.rows.campaign[0].campaignBudget.explicitlyShared = true; }],
    ['daily_budget', f => { f.state.rows.campaign[0].campaignBudget.referenceCount = '2'; }],
    ['target_cpa', f => { f.state.rows.campaign[0].campaign.advertisingChannelType = 'SEARCH'; f.state.rows.ad_groups[0].adGroup.targetCpaMicros = '21000000'; }] ];
  for (const [index, [kind, mutate]] of cases.entries()) await t.test(String(index), async t => {
    const f = setup(t); f.target(kind); mutate(f);
    await assert.rejects(f.execute(f.command('apply', f.input(kind)))); assert.equal(f.state.writes, 0);
    assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_optimization_mutations').get().n, 0);
  });
});
test('timeout and lost acknowledgement retain campaign lock across reopen and fresh execution IDs', async t => {
  const f = setup(t); const input = f.input(); f.state.afterWrite = () => fail('provider_timeout');
  await assert.rejects(f.execute(f.command('apply', input)), { code: 'provider_timeout' }); assert.equal(f.state.writes, 1);
  f.reopen(); f.state.afterWrite = null;
  assert.equal((await f.status(input.executionId)).state, 'unknown');
  await assert.rejects(f.execute(f.command('apply', input)), { code: 'outcome_unknown' });
  await assert.rejects(f.execute(f.command('apply', f.input())), { code: 'optimization_busy' }); assert.equal(f.state.writes, 1);
});
test('invalid acknowledgements and revocation after submission stay unknown without a second mutation', async t => {
  for (const mode of ['missing', 'wrong_resource', 'extra_field', 'partial_failure', 'revoked']) await t.test(mode, async t => {
    const f = setup(t); const input = f.input();
    const resourceName = C.mutation(input, CUSTOMER).resourceName;
    f.state.response = { missing: { results: [] }, wrong_resource: { results: [{ resourceName: resourceName + '1' }] },
      extra_field: { results: [{ resourceName, accessToken: ACCESS }] },
      partial_failure: { results: [{ resourceName }], partialFailureError: {} } }[mode];
    if (mode === 'revoked') f.state.afterWrite = () => f.getStore().db.prepare("UPDATE connections SET state='revoked',revision=revision+1 WHERE ref=?").run('connection:test');
    await assert.rejects(f.execute(f.command('apply', input)), { code: mode === 'revoked' ? 'connection_blocked' : 'provider_failed' });
    const row = f.getStore().db.prepare('SELECT state,result_json FROM google_optimization_mutations WHERE id=?').get(input.executionId);
    assert.equal(row.state, 'attempted'); assert.equal(row.result_json, null);
    assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_optimization_locks').get().n, 1);
    if (mode !== 'revoked') {
      assert.equal((await f.status(input.executionId)).state, 'unknown');
      await assert.rejects(f.execute(f.command('apply', input)), { code: 'outcome_unknown' });
    }
    assert.equal(f.state.writes, 1);
  });
});
test('metadata drift on final preflight read, duplicate pages and cursor loops never reach mutation', async t => {
  for (const mode of ['drift', 'duplicate', 'cursor_loop']) await t.test(mode, async t => {
    const f = setup(t); let pages = 0;
    f.state.readResponse = request => {
      if (/FROM campaign /.test(request.json.query)) {
        const rows = structuredClone(f.state.rows.campaign);
        if (mode === 'drift' && ++pages > 1) rows[0].campaign.status = 'PAUSED';
        return { results: rows };
      }
      const rows = structuredClone(f.state.rows.ads);
      if (mode === 'duplicate') rows.push(rows[0]);
      if (mode === 'cursor_loop') {
        // Distinct rows on the second page isolate the cursor-loop protection.
        if (++pages > 1) rows.forEach(row => { row.adGroupAd.ad.id = '1' + row.adGroupAd.ad.id; });
        return { results: rows, nextPageToken: 'fictitious-page' };
      }
      return { results: rows };
    };
    await assert.rejects(f.execute(f.command('apply', f.input())), { code: mode === 'drift' ? 'optimization_conflict' : 'provider_failed' });
    assert.equal(f.state.writes, 0);
    assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_optimization_mutations').get().n, 0);
  });
});
test('audit failure cannot record success or release the durable no-repeat lock', async t => {
  const f = setup(t); const input = f.input(); const store = f.getStore(); const append = store.appendAudit;
  store.appendAudit = function (event) { if (event.reason === 'optimization_provider_acknowledged') throw Error('fictitious-audit-failure'); return append.call(this, event); };
  await assert.rejects(f.execute(f.command('apply', input))); store.appendAudit = append;
  assert.equal((await f.status(input.executionId)).state, 'unknown'); assert.equal(f.state.writes, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM google_optimization_locks').get().n, 1);
});
test('rebinds, rekeying, changed payload and foreign tenant cannot reuse or expose a receipt', async t => {
  const f = setup(t); const input = f.input(); await f.execute(f.command('apply', input));
  await assert.rejects(f.execute(f.command('apply', { ...input, evidenceFingerprint: 'b'.repeat(64) })), { code: 'idempotency_conflict' });
  await assert.rejects(f.execute(f.command('status', { executionId: input.executionId }, { tenantRef: 'clinic:999' })), { code: 'scope_denied' });
  const original = structuredClone(f.binding);
  for (const change of [binding => { binding.googleSubject = 'different-subject'; },
    binding => { binding.secretArn += 'a'; }, binding => { binding.clientSecretArn += 'a'; },
    binding => { binding.developerSecretArn += 'a'; },
    binding => { binding.googleAdsAccounts[0].loginCustomerId = null; },
    binding => { binding.googleAdsOptimization.accounts[0].campaigns[0].maxBidMicros = '90000000'; }]) {
    Object.assign(f.binding, structuredClone(original)); change(f.binding); f.reset();
    await assert.rejects(f.status(input.executionId), { code: 'scope_denied' });
  }
  Object.assign(f.binding, original); const replacement = generateKeyPairSync('ed25519');
  f.principal.publicKey = replacement.publicKey.export({ type: 'spki', format: 'pem' }); f.reset();
  await assert.rejects(f.execute(f.command('status', { executionId: input.executionId }), { privateKey: replacement.privateKey }), { code: 'scope_denied' });
  assert.equal(f.state.writes, 1);
});
test('new request and execution IDs cannot bypass group or campaign cooldown', async t => {
  for (const kind of ['pause_ad', 'manual_cpc', 'daily_budget', 'target_roas']) await t.test(kind, async t => {
    const f = setup(t); f.target(kind); await f.execute(f.command('apply', f.input(kind)));
    await assert.rejects(f.execute(f.command('apply', f.input(kind))), { code: 'optimization_cooldown' });
    assert.equal(f.state.writes, 1);
  });
});
test('two broker instances with independent SQLite connections cannot both reserve the same campaign', async t => {
  const f = setup(t); const peer = f.fork(); let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const observed = new Promise(resolve => { started = resolve; });
  f.state.afterWrite = async () => { started(); await gate; };
  const first = f.execute(f.command('apply', f.input())); await observed;
  try { await assert.rejects(peer.execute(f.command('apply', f.input())), { code: 'optimization_busy' }); }
  finally { release(); }
  await first; assert.equal(f.state.writes, 1);
});
test('expiry, clock rollback and revocation before the durable boundary prevent writes', async t => {
  for (const mode of ['expired', 'future', 'rollback', 'revoked']) await t.test(mode, async t => {
    const f = setup(t); const input = f.input();
    if (mode === 'expired') input.expiresAt = f.state.at;
    if (mode === 'future') input.expiresAt += 1;
    if (mode === 'rollback') f.state.onRead = () => { f.state.at--; };
    if (mode === 'revoked') f.state.onRead = () => f.getStore().db.prepare("UPDATE connections SET state='revoked',revision=revision+1 WHERE ref=?").run('connection:test');
    await assert.rejects(f.execute(f.command('apply', input)), { code: mode === 'revoked' ? 'connection_blocked' : 'optimization_expired' });
    assert.equal(f.state.writes, 0);
  });
});
test('configuration requires a separate explicit cohort and writer identity/key, never a read-only upgrade', t => {
  const f = setup(t); const config = { enabled: true, cohort: C.COHORT, policy: f.policy, listenAddress: '127.0.0.1', port: 9443,
    stateFile: '/tmp/fictitious/state.sqlite', cursorKeyFile: '/tmp/fictitious/cursor', tlsKeyFile: '/tmp/fictitious/key', tlsCertFile: '/tmp/fictitious/cert' };
  assert.equal(runtime.validateConfig(config), config);
  for (const mutate of [c => { c.cohort = 'google-ads-read-v1'; }, c => { c.cohort = 'google-ads-conversions-v1'; },
    c => { c.policy.grants.at(-1).principalId = 'api:test'; }, c => { c.policy.principals.at(-1).publicKey = c.policy.principals[0].publicKey; },
    c => { delete c.policy.connections[0].googleAdsOptimization; },
    c => { c.policy.connections[0].googleAdsOptimization.accounts[0].campaigns[0].kinds = ['negative_keywords']; }]) {
    const bad = structuredClone(config); mutate(bad); assert.throws(() => runtime.validateConfig(bad), { code: 'invalid_request' });
  }
});
