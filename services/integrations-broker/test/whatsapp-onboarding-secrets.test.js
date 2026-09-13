'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { fixture, TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs');
for (const [name, modify] of [
  ['foreign ARN', (f, c, r) => { if (c.constructor.name === 'DescribeSecretCommand') r.ARN = 'arn:foreign'; }],
  ['foreign KMS', (f, c, r) => { if (c.constructor.name === 'DescribeSecretCommand') r.KmsKeyId = 'arn:foreign'; }],
  ['deleted secret', (f, c, r) => { if (c.constructor.name === 'DescribeSecretCommand') r.DeletedDate = new Date(); }],
  ['empty slot', (f, c, r) => { if (c.constructor.name === 'DescribeSecretCommand' && c.input.SecretId === f.binding.secretArn) r.VersionIdsToStages = {}; }],
  ['slot rotation', (f, c, r) => { if (c.constructor.name === 'DescribeSecretCommand' && c.input.SecretId === f.binding.secretArn) r.VersionIdsToStages = { changed: ['AWSCURRENT'] }; }],
  ['app rotation', (f, c, r) => { if (c.constructor.name === 'DescribeSecretCommand' && c.input.SecretId === f.binding.clientSecretArn) r.VersionIdsToStages = { changed: ['AWSCURRENT'] }; }],
  ['wrong returned version', (f, c, r) => { if (c.constructor.name === 'GetSecretValueCommand') r.VersionId = 'z'.repeat(32); }],
  ['legacy credential in slot', (f, c, r) => { if (c.constructor.name === 'GetSecretValueCommand') r.SecretString = JSON.stringify({ accessToken: TOKEN }); }],
  ['foreign slot scope', (f, c, r) => { if (c.constructor.name === 'GetSecretValueCommand' && c.input.SecretId === f.binding.secretArn) { const v = JSON.parse(r.SecretString); v.scopeKey = 'clinic:999'; r.SecretString = JSON.stringify(v); } }],
  ['version capacity', (f, c, r) => { if (c.constructor.name === 'ListSecretVersionIdsCommand') r.Versions = Array.from({ length: 90 }, () => ({ VersionId: randomUUID() })); }],
  ['unbounded version listing', (f, c, r) => { if (c.constructor.name === 'ListSecretVersionIdsCommand') r.NextToken = 'more'; }],
]) test('Onboarding refuses ' + name + ' before exchanging or writing a credential', async t => {
  const f = fixture(t); const flow = await f.begin(); f.state.afterAws = (c, r) => { modify(f, c, r); return r; };
  await assert.rejects(f.finish(flow), e => !e.stack.includes(TOKEN) && !e.stack.includes(APP)); assert.equal(f.state.codes, 0); assert.equal(f.state.puts, 0);
});
test('Candidate reconciliation verifies exact version, body, scope and application pin; no read exposes secret bytes', async t => {
  const f = fixture(t); const flow = await f.begin(); f.state.losePut = true; await assert.rejects(f.finish(flow));
  const r = f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId);
  const version = f.records.get(f.binding.secretArn).get(flow.flowId); const original = version.body;
  for (const modify of [v => { v.accessToken = 'FICTITIOUS_DIFFERENT_TOKEN'; }, v => { v.scopeKey = 'clinic:999'; }, v => { v.subjectId = '999'; }]) {
    const v = JSON.parse(original); modify(v); version.body = JSON.stringify(v);
    await assert.rejects(f.status(flow), { code: 'secret_unavailable' });
  }
  version.body = original; version.stages = []; // A newer attempt may move AWSPENDING; the version remains authoritative.
  const confirmed = await f.secrets.candidate(f.binding, r, r.secret_digest); assert.equal(confirmed.versionId, flow.flowId); assert(!JSON.stringify(confirmed).includes(TOKEN));
  f.state.afterAws = (c, response) => { if (c.constructor.name === 'DescribeSecretCommand' && c.input.SecretId === f.binding.clientSecretArn) response.VersionIdsToStages = { changed: ['AWSCURRENT'] }; return response; };
  await assert.rejects(f.status(flow), { code: 'secret_version_changed' });
  f.state.afterAws = null; assert.equal((await f.status(flow)).data.status, 'staged'); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
});
test('App rotation during candidate read prevents confirmation after a lost write response', async t => {
  const f = fixture(t); const flow = await f.begin(); f.state.losePut = true; await assert.rejects(f.finish(flow));
  const app = f.records.get(f.binding.clientSecretArn).get(f.binding.whatsappOnboarding.appVersionId);
  f.state.afterAws = (command, response) => {
    if (command.constructor.name === 'GetSecretValueCommand' && command.input.VersionId === flow.flowId) app.stages = ['AWSPREVIOUS'];
    return response;
  };
  await assert.rejects(f.status(flow), { code: 'secret_version_changed' });
  assert.equal(f.current.store.db.prepare('SELECT state FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId).state, 'staging');
  f.state.afterAws = null; app.stages = ['AWSCURRENT'];
  assert.equal((await f.status(flow)).data.status, 'staged'); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
});
test('AWS acknowledgement cannot promote a candidate or hide a changed initial slot', async t => {
  const f = fixture(t); const flow = await f.begin();
  f.state.afterAws = (c, r) => { if (c.constructor.name === 'PutSecretValueCommand') r.VersionStages.push('AWSCURRENT'); return r; };
  await assert.rejects(f.finish(flow), { code: 'secret_unavailable' });
  assert.deepEqual(f.records.get(f.binding.secretArn).get(f.binding.whatsappOnboarding.slotVersionId).stages, ['AWSCURRENT']);
  const candidate = f.records.get(f.binding.secretArn).get(flow.flowId); candidate.stages = ['AWSCURRENT'];
  await assert.rejects(f.status(flow), { code: 'secret_version_changed' });
});
test('Application buffers are private copies, erased on failure/cancellation and never returned by the wrapper', async t => {
  const f = fixture(t); let held;
  await assert.rejects(f.secrets.withApplication(f.binding, async secret => { held = secret; secret.fill(0); return { leak: APP }; }), { code: 'secret_unavailable' });
  assert(held.every(v => v === 0)); const controller = new AbortController();
  await assert.rejects(f.secrets.withApplication(f.binding, async secret => { held = secret; controller.abort(); assert(secret.every(v => v === 0)); return {}; }, controller.signal), { code: 'provider_timeout' });
  assert(held.every(v => v === 0));
});
