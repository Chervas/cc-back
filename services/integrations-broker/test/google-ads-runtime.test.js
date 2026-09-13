'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { randomBytes } = require('node:crypto'); const { execFileSync } = require('node:child_process');
const { adsFixture, row, ASSET, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const { allowPort, removePort } = require('./offline-guard.cjs');
const runtime = require('../src/google-main'); const contract = require('../src/google-ads-contract');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { drainAudit } = require('../src/audit');
test('actual Ads HTTPS runtime serves typed pages, audits and retains disconnection across restarts', async t => {
  const f = adsFixture(t); const cert = path.join(f.dir, 'ads.crt'); const key = path.join(f.dir, 'ads.key'); const cursorKey = path.join(f.dir, 'ads.cursor');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  for (const file of [cert, key]) fs.chmodSync(file, 0o600); fs.writeFileSync(cursorKey, randomBytes(32), { mode: 0o600 });
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = { enabled: true, cohort: 'google-ads-read-v1', policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'ads.sqlite'), tlsCertFile: cert, tlsKeyFile: key, cursorKeyFile: cursorKey };
  const file = path.join(f.dir, 'ads.json'); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const delivered = []; const sink = { write: async value => { delivered.push(JSON.parse(value.event)); return { versionId: 'fictitious-s3-version', digest: value.digest }; } };
  const deps = { awsFactory: async () => ({ secrets: f.sdk, sink, close: () => {} }), http: f.http };
  let app = await runtime.main(file, deps); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const clientFor = (keyId, privateKey) => createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, keyId,
    audience: f.policy.audience, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const client = clientFor('qa-key', f.keys.privateKey); const control = clientFor('control-key', f.control.privateKey);
  f.state.response = { results: Array.from({ length: 300 }, (_, i) => row(i + 1)), ignored: ACCESS };
  const first = await client.execute(f.command('campaigns'));
  assert.equal(first.data.results.length, 250); assert.ok(first.data.nextPageToken);
  const second = await client.execute(f.command('campaigns', { pageToken: first.data.nextPageToken }));
  assert.equal(second.data.results.length, 50); assert.equal(second.data.nextPageToken, null); assert.equal(f.state.calls.length, 1);
  const before = f.state.sdk.length;
  await assert.rejects(client.execute(f.command('campaigns', { pageToken: null }, { tenantRef: 'clinic:999' })), { code: 'scope_denied' });
  await assert.rejects(client.execute(f.command('campaigns', {}, { operation: contract.REVOKE_OPERATION })), { code: 'scope_denied' });
  assert.equal(f.state.sdk.length, before);
  const revoke = f.command('campaigns', {}, { operation: contract.REVOKE_OPERATION });
  assert.deepEqual((await control.execute(revoke)).data, { revoked: true });
  await assert.rejects(client.execute(f.command('campaigns', { pageToken: first.data.nextPageToken })), { code: 'asset_revoked' });
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert.ok(delivered.some(event => event.operation === contract.REVOKE_OPERATION && event.action === 'asset.revoked'));
  const saved = JSON.stringify(delivered) + JSON.stringify(app.store.db.prepare('SELECT * FROM commands').all());
  for (const secret of [ACCESS, DEVELOPER, 'FICTITIOUS_REFRESH', 'FICTITIOUS_CLIENT_SECRET', 'FICTITIOUS_CAMPAIGN']) assert.ok(!saved.includes(secret));
  await app.close(); app = null; app = await runtime.main(file, deps);
  assert.equal((await control.execute(revoke)).replayed, true);
  await assert.rejects(client.execute(f.command('campaigns')), { code: 'asset_revoked' });
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.sdk.length, before);
});
