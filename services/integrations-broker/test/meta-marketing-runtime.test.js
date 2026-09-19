'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { fixture, TOKEN, APP } = require('./meta-marketing-fixture.cjs');
const { allowPort, removePort } = require('./offline-guard.cjs');
const runtime = require('../src/meta-marketing-main'), C = require('../src/meta-marketing-contract');
const { drainAudit } = require('../src/audit');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');

test('dedicated runtime rejects cross-environment credentials, mixed provider/write authority and missing independent revocation before AWS', async t => {
  const f = fixture(t); runtime.validateConfig(f.config); let aws = 0;
  const cases = [c => c.enabled = false, c => c.cohort = 'meta-whatsapp', c => c.environment = 'prod',
    c => c.policy.principals[1].publicKey = c.policy.principals[0].publicKey,
    c => c.policy.connections[0].secretArn = c.policy.connections[0].secretArn.replace('/staging/', '/dev/'),
    c => c.policy.connections[0].clientSecretArn = c.policy.connections[0].secretArn,
    c => c.policy.connections[0].provider = 'meta_whatsapp', c => c.policy.connections[0].googleSubject = 'foreign',
    c => c.policy.connections[0].metaMarketing.scopes.push('ads_management'),
    c => c.policy.connections[0].metaMarketing.assets[2].parentPageId = null,
    c => c.policy.connections[0].metaMarketing.assets.push(c.policy.connections[0].metaMarketing.assets[0]),
    c => c.policy.connections[0].expiresAt = null, c => c.policy.grants[0].operations.push(C.REVOKE),
    c => c.policy.grants[1].operations.push(C.ASSET), c => c.policy.grants[1].tenantRef = 'clinic:71',
    c => c.policy.grants[0].operations.push('meta.whatsapp.text.send.v1'), c => c.policy.principals[0].id = 'dev:meta-marketing'];
  const filename = path.join(f.dir, 'bad.json');
  for (const mutate of cases) {
    const config = structuredClone(f.config); mutate(config); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(runtime.main(filename, { awsFactory: async () => { aws++; throw Error('FORBIDDEN_AWS'); } }));
  }
  assert.equal(aws, 0);
  const dev = structuredClone(f.config); dev.environment = 'dev';
  dev.policy.principals.forEach(p => p.id = p.id.replace('staging:', 'dev:'));
  dev.policy.grants.forEach(g => g.principalId = g.principalId.replace('staging:', 'dev:'));
  dev.policy.connections.forEach(c => { c.secretArn = c.secretArn.replace('/staging/', '/dev/'); c.clientSecretArn = c.clientSecretArn.replace('/staging/', '/dev/'); });
  runtime.validateConfig(dev);
});
test('actual signed TLS runtime reads all asset types, audits and drains, limits concurrency, persists scoped revoke across restart', async t => {
  const f = fixture(t), config = f.config;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', config.tlsKeyFile, '-out', config.tlsCertFile,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(config.tlsKeyFile, 0o600); fs.chmodSync(config.tlsCertFile, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); config.port = probe.address().port;
  await new Promise(resolve => probe.close(resolve)); allowPort(config.port);
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const events = []; let closes = 0;
  const awsFactory = async () => ({ secrets: f.aws, sink: { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'qa-version', digest: row.digest }; } }, close() { closes++; } });
  let app = await runtime.main(filename, { awsFactory, http: f.http });
  t.after(async () => { if (app) await app.close(); removePort(config.port); });
  const client = control => createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${config.port}`, audience: config.policy.audience,
    keyId: control ? 'qa-control' : 'qa-read', privateKey: (control ? f.controlKeys : f.keys).privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(config.tlsCertFile) });
  const reader = client(false), controller = client(true);
  assert.equal((await reader.execute(f.command({ operation: C.STATUS }))).data.assetAccessVerified, false);
  for (const asset of f.binding.metaMarketing.assets) assert.equal((await reader.execute(f.command({ assetRef: asset.assetRef }))).data.assetRef, asset.assetRef);
  const before = f.state.aws.length; await assert.rejects(reader.execute(f.command({ tenantRef: 'clinic:71' }))); assert.equal(f.state.aws.length, before);
  let release; let entered = 0, notify; const ready = new Promise(resolve => notify = resolve), hold = new Promise(resolve => release = resolve);
  f.state.httpHook = async req => { if (req.action === 'inspect') { entered++; if (entered === 4) notify(); await hold; } };
  const burst = Promise.allSettled(Array.from({ length: 4 }, () => reader.execute(f.command()))); await ready;
  const peak = f.state.aws.length; await assert.rejects(reader.execute(f.command()), { code: 'rate_limited' }); assert.equal(f.state.aws.length, peak);
  assert.equal((await controller.execute(f.command({ operation: C.REVOKE }))).data.revoked, true);
  release(); assert((await burst).every(result => result.status === 'rejected')); f.state.httpHook = null;
  await assert.rejects(reader.execute(f.command()), { code: 'asset_revoked' });
  await drainAudit(app.store, (await awsFactory()).sink); assert.equal(app.store.backlog().pending, 0);
  assert(events.some(e => e.action === 'integration.completed')); assert(events.some(e => e.action === 'asset.revoked'));
  for (const secret of [TOKEN, APP, 'FICTITIOUS_ACCOUNT']) assert(!JSON.stringify(events).includes(secret));
  await app.close(); app = null;
  app = await runtime.main(filename, { awsFactory, http: f.http });
  await assert.rejects(reader.execute(f.command()), { code: 'asset_revoked' });
  assert.equal((await reader.execute(f.command({ assetRef: 'meta-facebook_page:401' }))).data.id, '401');
  await app.close(); app = null; assert.equal(closes, 2);
});
