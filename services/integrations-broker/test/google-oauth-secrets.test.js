'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { oauthSecretsFixture } = require('./google-oauth-fixture.cjs');
test('OAuth writes a canonical candidate to its exact secret without replacing the current version', async () => {
  const f = oauthSecretsFixture(); const app = await f.secrets.application(f.binding); assert.equal(app.clientId, f.app.clientId);
  const baseline = await f.secrets.baseline(f.binding, app.clientId); assert.equal(baseline.version, 'baseline'); assert.equal(baseline.reusable, null);
  const encoded = f.secrets.encode(f.binding, app.clientId, f.value); const version = randomUUID();
  await f.secrets.stage(f.binding, version, encoded.body); await f.secrets.stage(f.binding, version, encoded.body);
  assert.equal(f.state.records.get(f.binding.secretArn).size, 2); assert(f.state.records.get(f.binding.secretArn).get('baseline').stages.has('AWSCURRENT'));
  const result = await f.secrets.candidate(f.binding, version, encoded.digest); assert.equal(result.value.googleUserId, f.binding.oauth.subject);
  assert(!f.state.calls.some(call => call.kind === 'CreateSecretCommand')); assert(!f.state.calls.some(call => call.kind === 'UpdateSecretVersionStageCommand'));
});
test('lost stage and promotion acknowledgements reconcile by immutable version and digest', async () => {
  const f = oauthSecretsFixture(); const encoded = f.secrets.encode(f.binding, f.app.clientId, f.value); const version = randomUUID();
  f.state.lostStage = true; await assert.rejects(f.secrets.stage(f.binding, version, encoded.body), { code: 'secret_unavailable' });
  assert.equal((await f.secrets.candidate(f.binding, version, encoded.digest)).version, version);
  f.state.lostActivate = true; await assert.rejects(f.secrets.activate(f.binding, version, 'baseline', encoded.digest), { code: 'secret_unavailable' });
  const result = await f.secrets.activate(f.binding, version, 'baseline', encoded.digest); assert.deepEqual(result, { version, digest: encoded.digest });
  assert.equal(f.state.calls.filter(c => c.kind === 'UpdateSecretVersionStageCommand').length, 1);
  const refreshed = await f.secrets.baseline(f.binding, f.app.clientId); assert.equal(refreshed.reusable.refreshToken, f.value.refreshToken);
});
test('identity, OAuth client, scopes, KMS, foreign ARN and candidate corruption fail closed', async () => {
  const f = oauthSecretsFixture();
  for (const patch of [{ googleUserId: 'other' }, { clientId: 'other' }, { scopes: ['openid'] }, { secret: 'FICTITIOUS_SECRET' }]) {
    assert.throws(() => f.secrets.encode(f.binding, f.app.clientId, { ...f.value, ...patch }), { code: 'secret_unavailable' });
  }
  await assert.rejects(f.secrets.stage(f.binding, randomUUID(), '{}'), { code: 'invalid_request' }); assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.secrets.application({ ...f.binding, clientSecretArn: f.binding.clientSecretArn.replace('137819318729','999999999999') }), { code: 'secret_unavailable' }); assert.equal(f.state.calls.length, 0);
  f.state.kms = 'foreign'; await assert.rejects(f.secrets.application(f.binding), { code: 'secret_unavailable' }); assert.equal(f.state.calls.length, 1);
  f.state.kms = f.config.kmsKeyArn; const encoded = f.secrets.encode(f.binding, f.app.clientId, f.value); const version = randomUUID(); await f.secrets.stage(f.binding, version, encoded.body);
  await assert.rejects(f.secrets.candidate(f.binding, version, '0'.repeat(64)), { code: 'secret_unavailable' });
});
test('concurrent replacement of AWSCURRENT cannot be overwritten by a stale activation', async () => {
  const f = oauthSecretsFixture(); const encoded = f.secrets.encode(f.binding, f.app.clientId, f.value); const version = randomUUID(); await f.secrets.stage(f.binding, version, encoded.body);
  const versions = f.state.records.get(f.binding.secretArn); versions.get('baseline').stages.clear(); versions.set('newer', { body: encoded.body, stages: new Set(['AWSCURRENT']) });
  await assert.rejects(f.secrets.activate(f.binding, version, 'baseline', encoded.digest), { code: 'secret_version_changed' });
  assert.equal(f.state.calls.filter(c => c.kind === 'UpdateSecretVersionStageCommand').length, 0);
});
