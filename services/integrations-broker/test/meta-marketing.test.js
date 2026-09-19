'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, TOKEN, APP } = require('./meta-marketing-fixture.cjs');
const C = require('../src/meta-marketing-contract');
const { BrokerStore } = require('../src/store'), { Broker } = require('../src/broker');
const { createMetaMarketingOperations } = require('../src/meta-marketing-operations');

test('signed scoped metadata reads use vault-only credentials, fixed asset projections and fresh verification without persisting names', async t => {
  const f = fixture(t);
  const status = await f.execute(f.command({ operation: C.STATUS }));
  assert.equal(status.data.credentialValid, true); assert.equal(status.data.assetAccessVerified, false);
  assert.deepEqual(status.data.requiredScopes, ['ads_read']); assert.equal(f.state.http.length, 1);
  for (const asset of f.binding.metaMarketing.assets) {
    const result = await f.execute(f.command({ assetRef: asset.assetRef }));
    assert.equal(result.data.kind, asset.kind); assert.equal(result.data.assetRef, asset.assetRef);
    assert(!JSON.stringify(result).includes(TOKEN)); assert(!JSON.stringify(result).includes(APP));
    assert(!Object.hasOwn(result.data, 'access_token'));
  }
  assert.deepEqual(f.state.http.map(row => row.action), ['inspect', 'inspect', 'ad_account', 'inspect', 'facebook_page', 'inspect', 'instagram_parent', 'instagram_business']);
  assert.equal(f.state.aws.length, 24); // describe/read both pins, describe both again, per operation.
  const commands = f.store.db.prepare('SELECT * FROM commands').all(); assert.equal(commands.length, 4); assert(commands.every(row => row.result === null));
  const serialized = JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  for (const secret of [TOKEN, APP, 'FICTITIOUS_ACCOUNT', 'FICTITIOUS_PAGE', 'fictitious_instagram']) assert(!serialized.includes(secret));
});
test('foreign clinic/asset/connection, control misuse, mutations and open payloads fail before AWS or provider calls', async t => {
  const f = fixture(t);
  for (const change of [{ tenantRef: 'clinic:71' }, { assetRef: 'meta-ad_account:999' }, { connectionRef: 'connection:foreign' },
    { operation: C.REVOKE }, { operation: 'meta.whatsapp.text.send.v1' }, { payload: { fields: 'access_token' } },
    { payload: { url: 'https://example.invalid' } }, { payload: { token: TOKEN } }]) await assert.rejects(f.execute(f.command(change)));
  await assert.rejects(f.execute(f.command(), true)); assert.equal(f.state.aws.length + f.state.http.length, 0);
});
test('malformed, foreign and changed secrets never reach Meta or silently select another version', async t => {
  for (const mutate of [f => f.values.get(f.binding.secretArn).subjectId = '999', f => f.values.get(f.binding.secretArn).provider = 'meta_whatsapp',
    f => f.values.get(f.binding.secretArn).scopes.push('ads_management'), f => f.values.get(f.binding.clientSecretArn).appId = '999',
    f => f.values.get(f.binding.secretArn).expiresAt = Date.now() - 1, f => f.pins.set(f.binding.secretArn, 'x'.repeat(32)),
    f => f.state.awsHook = value => ({ ...value, KmsKeyId: 'foreign' })]) {
    const f = fixture(t); mutate(f); await assert.rejects(f.execute()); assert.equal(f.state.http.length, 0);
  }
});
test('live app/subject/scopes/expiry and granular target evidence are checked; invalid credentials durably block', async t => {
  for (const [mutate, code] of [
    [d => d.app_id = '999', 'oauth_identity_mismatch'], [d => d.user_id = '999', 'oauth_identity_mismatch'],
    [d => d.type = 'PAGE', 'oauth_identity_mismatch'], [d => d.scopes.push('ads_management'), 'oauth_credentials_incomplete'],
    [d => delete d.data_access_expires_at, 'oauth_credentials_incomplete'], [d => d.granular_scopes[0].target_ids = ['999'], 'scope_denied'],
    [d => d.is_valid = false, 'credential_revoked'], [d => d.expires_at = 1, 'credential_revoked'],
  ]) {
    const f = fixture(t); f.state.inspect = () => { const result = f.inspect(); mutate(result.data); return result; };
    await assert.rejects(f.execute(), { code }); assert.equal(f.state.http.length, 1);
    if (code === 'credential_revoked') {
      const prior = f.state.aws.length; await assert.rejects(f.execute(), { code: 'connection_blocked' }); assert.equal(f.state.aws.length, prior);
    }
  }
});
test('absent granular targets are not invented; status only attests identity, asset read must still match the explicit binding', async t => {
  const f = fixture(t); f.state.inspect = () => { const result = f.inspect(); delete result.data.granular_scopes; return result; };
  assert.equal((await f.execute(f.command({ operation: C.STATUS }))).data.assetAccessVerified, false);
  f.state.asset = () => ({ id: 'act_999', account_id: '999', name: 'Foreign', account_status: 1, currency: 'EUR', timezone_name: 'Europe/Madrid' });
  await assert.rejects(f.execute(), { code: 'provider_failed' });
});
test('rejected application authentication during inspection does not falsely revoke the user; asset credential rejection does', async t => {
  const { BrokerError } = require('../src/errors'), f = fixture(t);
  f.state.httpHook = () => { throw new BrokerError('credential_revoked'); };
  await assert.rejects(f.execute(), { code: 'secret_unavailable' });
  assert.equal(f.store.connection(f.binding.connectionRef).state, 'active');
  f.state.httpHook = req => { if (req.action === 'ad_account') throw new BrokerError('credential_revoked'); };
  await assert.rejects(f.execute(), { code: 'credential_revoked' });
  await assert.rejects(f.execute(), { code: 'connection_blocked' });
});
test('Instagram requires the approved linked page before reading the profile; no arbitrary account discovery', async t => {
  const f = fixture(t); f.state.asset = () => ({ id: '401', instagram_business_account: { id: '999' } });
  await assert.rejects(f.execute(f.command({ assetRef: 'meta-instagram_business:501' })), { code: 'scope_denied' });
  assert.deepEqual(f.state.http.map(row => row.action), ['inspect', 'instagram_parent']);
});
test('Instagram keeps the existing username label when the optional profile name is absent', async t => {
  const f = fixture(t);
  f.state.asset = req => req.action === 'instagram_parent' ? { id: '401', instagram_business_account: { id: '501' } }
    : { id: '501', name: '', username: 'fictitious_username' };
  assert.equal((await f.execute(f.command({ assetRef: 'meta-instagram_business:501' }))).data.name, 'fictitious_username');
});
test('provider-controlled output and failures cannot return credential or application secrets', async t => {
  for (const secret of [TOKEN, APP]) {
    const f = fixture(t); f.state.asset = () => ({ id: '401', name: 'x' + secret });
    await assert.rejects(f.execute(f.command({ assetRef: 'meta-facebook_page:401' })), e => {
      assert.equal(e.code, 'provider_failed'); assert(!e.stack.includes(secret)); return true;
    });
  }
  const f = fixture(t); f.state.httpHook = () => { throw Error(TOKEN + APP); };
  await assert.rejects(f.execute(), e => !e.stack.includes(TOKEN) && !e.stack.includes(APP));
});
test('pin replacement during I/O and local expiry discard successful provider results', async t => {
  const f = fixture(t); f.state.httpHook = req => { if (req.action === 'ad_account') f.pins.set(f.binding.secretArn, 'x'.repeat(32)); };
  await assert.rejects(f.execute(), { code: 'secret_version_changed' });
  assert(f.store.db.prepare('SELECT * FROM commands').all().every(row => row.result === null));
  const g = fixture(t); g.state.httpHook = req => { if (req.action === 'ad_account') g.broker.policy.connections[0].expiresAt = Date.now() - 1; };
  await assert.rejects(g.execute(), { code: 'connection_blocked' });
});
test('independent control revokes during a read and survives a new store/broker without revoking sibling assets', async t => {
  const f = fixture(t); let release, entered;
  const ready = new Promise(resolve => entered = resolve);
  f.state.httpHook = async req => { if (req.action === 'ad_account') { entered(); await new Promise(resolve => release = resolve); } };
  const work = f.execute(); const failed = assert.rejects(work); await ready;
  await f.execute(f.command({ operation: C.REVOKE }), true); release(); await failed;
  assert.equal((await f.execute(f.command({ assetRef: 'meta-facebook_page:401' }))).data.id, '401');
  const reopened = new BrokerStore(f.filename);
  try {
    const broker = new Broker({ store: reopened, policy: f.policy, secrets: f.secrets, operations: createMetaMarketingOperations({ http: f.http, secrets: f.secrets }) });
    const prior = f.state.aws.length; await assert.rejects(f.execute(f.command(), false, broker), { code: 'asset_revoked' }); assert.equal(f.state.aws.length, prior);
  } finally { reopened.close(); }
});
test('read response cache is absent and audit capacity fails closed before credentials', async t => {
  const f = fixture(t), command = f.command(); await f.execute(command);
  const before = f.state.aws.length; await assert.rejects(f.execute(command), { code: 'outcome_unknown' }); assert.equal(f.state.aws.length, before);
  f.broker.policy.maxBacklog = 2; await assert.rejects(f.execute(f.command()), { code: 'audit_unavailable' }); assert.equal(f.state.aws.length, before);
});
