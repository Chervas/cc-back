'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomBytes, randomUUID } = require('node:crypto');
const { setup } = require('./google-oauth-broker-fixture.cjs'); const { validateConfig } = require('../src/google-main');
const { operationsFor, bindingFor } = require('../src/google-oauth-contract');
for (const provider of ['google_search_console', 'google_analytics', 'google_ads']) {
  test(provider + ' policy admits only its typed OAuth grants with a third independent principal and key', t => {
    const f = setup(t, provider); const config = { cohort: f.cohort, enabled: true, policy: f.policy, listenAddress: '127.0.0.1', port: 10443,
      stateFile: f.filename, tlsCertFile: f.dir + '/tls.crt', tlsKeyFile: f.dir + '/tls.key', cursorKeyFile: f.dir + '/cursor.key' };
    validateConfig(config);
    for (const mutate of [c => { c.policy.principals[1].publicKey = c.policy.principals[2].publicKey; },
      c => { c.policy.principals[0].enabled = false; c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; },
      c => { c.policy.grants[1].principalId = 'revoke:qa'; }, c => { c.policy.grants[1].principalId = 'api:test'; },
      c => { c.policy.connections[0].oauth.subject = 'foreign-subject'; },
      c => { c.policy.connections[0].oauth.scopes.push(provider === 'google_ads' ? 'https://www.googleapis.com/auth/datamanager' : 'https://www.googleapis.com/auth/adwords'); },
      c => { c.policy.connections[0].oauth.scopes.push('https://www.googleapis.com/auth/business.manage'); },
      c => { c.policy.connections[0].oauth.scopes.push(provider === 'google_analytics' ? 'https://www.googleapis.com/auth/webmasters.readonly' : 'https://www.googleapis.com/auth/analytics.readonly'); },
      c => { c.policy.grants[1].operations = Object.values(operationsFor('google_business_profile')); },
      c => { delete c.policy.connections[0].oauth; }, c => { c.policy.connections[0].oauth.redirectUri += '?token=FICTITIOUS'; }]) {
      const bad = structuredClone(config); mutate(bad); assert.throws(() => validateConfig(bad), { code: 'invalid_request' });
    }
    const readerOnly = structuredClone(config); readerOnly.policy.grants = [readerOnly.policy.grants[0]];
    delete readerOnly.policy.connections[0].oauth; validateConfig(readerOnly);
    const foreign = structuredClone(config); foreign.policy.grants[1].assetRef = provider === 'google_analytics' ? 'ga4:999' : provider === 'google_ads' ? 'ads:1111111111' : 'sc:' + 'f'.repeat(64);
    assert.throws(() => validateConfig(foreign), { code: 'scope_denied' });
    assert.equal(f.state.calls.length, 0);
  });
  test(provider + ' v3 baseline without identity scopes anchors CAS but cannot supply a fallback refresh', async t => {
    const f = setup(t, provider); const baseline = await f.oauthSecrets.baseline(f.binding, f.app.clientId);
    assert.deepEqual(baseline, { version: 'baseline', reusable: null });
    const started = await f.begin(); assert.equal(started.url.searchParams.get('prompt'), 'consent');
    const requested = started.url.searchParams.get('scope').split(' ');
    assert.deepEqual(requested, f.binding.oauth.scopes); assert.equal(requested.length, 4);
    f.state.omitRefresh = true; await assert.rejects(f.finish(started), { code: 'oauth_credentials_incomplete' });
    assert.equal(f.state.calls.filter(c => c.kind === 'PutSecretValueCommand').length, 0);
    const original = f.state.records.get(f.binding.secretArn).get('baseline');
    for (const mutation of [{ version: 2 }, { provider: 'google_business_profile' }, { googleUserId: 'other' }, { clientId: 'other' }]) {
      original.body = JSON.stringify({ ...f.baseline, ...mutation });
      await assert.rejects(f.oauthSecrets.baseline(f.binding, f.app.clientId), { code: 'secret_unavailable' });
    }
    original.body = JSON.stringify(f.baseline);
    assert.throws(() => f.oauthSecrets.encode(f.binding, f.app.clientId, { ...f.value, provider: 'google_business_profile' }), { code: 'secret_unavailable' });
    assert.throws(() => bindingFor({ ...f.binding, provider: 'meta' }), { code: 'invalid_request' });
  });
  test(provider + ' signed OAuth rejects other vertical names, arbitrary payload and reader/revoker credentials before dispatch', async t => {
    const f = setup(t, provider); const ops = operationsFor(provider); const state = randomBytes(32).toString('base64url');
    for (const role of ['read', 'revoke']) await assert.rejects(f.execute(ops.begin, { state }, {}, role), { code: 'scope_denied' });
    await assert.rejects(f.execute(operationsFor('google_business_profile').begin, { state }), { code: 'scope_denied' });
    await assert.rejects(f.execute(ops.begin, { state, scopes: ['adwords'] }), { code: 'invalid_request' });
    await assert.rejects(f.execute(ops.finish, { flowId: randomUUID(), state, code: 'FICTITIOUS', redirectUri: 'https://evil.invalid' }), { code: 'invalid_request' });
    assert.equal(f.state.calls.length + f.state.codes + f.state.reads, 0);
  });
  test(provider + ' revocation during secret activation survives new credentials, confirmation and restart', async t => {
    const f = setup(t, provider); const flow = await f.begin(); await f.finish(flow);
    f.state.beforeActivate = () => f.execute(f.contract.REVOKE_OPERATION, {}, {}, 'revoke');
    const result = await f.activate(flow); assert.equal(result.data.status, 'active'); assert.equal(result.data.accessBlocked, true);
    assert.equal(f.state.calls.filter(c => c.kind === 'UpdateSecretVersionStageCommand').length, 1);
    f.reopen(); assert.equal((await f.status(flow)).data.accessBlocked, true);
    await assert.rejects(f.execute(f.readOperation, {}, {}, 'read'), { code: 'asset_revoked' });
    assert.equal(f.state.reads + f.state.refreshes, 0);
  });
  test(provider + ' activating a new credential invalidates a read started with the old cached token', async t => {
    const f = setup(t, provider); const first = await f.begin(); await f.finish(first); await f.activate(first);
    let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
    f.state.beforeRead = () => new Promise(resolve => { entered(); release = resolve; });
    const reading = f.execute(f.readOperation, {}, {}, 'read'); const rejected = assert.rejects(reading, { code: 'connection_blocked' });
    await ready; const next = await f.begin(); await f.finish(next); await f.activate(next); release(); await rejected;
    f.state.beforeRead = null; assert.deepEqual((await f.execute(f.readOperation, {}, {}, 'read')).data, f.readResult);
    assert.equal(f.state.codes, 2); assert.equal(f.state.refreshes, 2);
  });
}
