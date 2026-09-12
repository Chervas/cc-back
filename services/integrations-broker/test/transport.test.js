'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { allowPort, removePort } = require('./offline-guard.cjs');
const { fixture } = require('./helpers');

test('backend consumer reaches TLS broker with signed request and no provider secret', async t => {
  const f = fixture(t); const cert = path.join(f.dir, 'tls.crt'); const key = path.join(f.dir, 'tls.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = createServer(f.broker, { cert: fs.readFileSync(cert), key: fs.readFileSync(key) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; allowPort(port);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); removePort(port); });
  const client = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience,
    keyId: 'qa-key', privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const response = await client.execute(f.command()); assert.deepEqual(response.data, { fixture: true, status: 'available' });
  await assert.rejects(client.execute(f.command({ tenantRef: 'clinic:foreign' })), { code: 'scope_denied' });
  const untrusted = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience,
    keyId: 'qa-key', privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  await assert.rejects(untrusted.execute(f.command()), { code: 'broker_unavailable' });
});
