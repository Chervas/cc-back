'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { execFileSync } = require('node:child_process'); const { fixture } = require('./whatsapp-fixture.cjs'); const { allowPort, removePort } = require('./offline-guard.cjs');
const runtime = require('../src/whatsapp-main'); const C = require('../src/whatsapp-contract'); const { drainAudit } = require('../src/audit');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { createWhatsappBrokerClient } = require('../../../src/lib/whatsappBrokerClient');
test('WhatsApp runtime rejects mixed authority, credentials and environment before AWS construction', async t => {
  const f = fixture(t); runtime.validateConfig(f.config);
  const cases = [
    c => { c.enabled = false; }, c => { c.cohort = 'meta-social'; }, c => { c.policy.principals[0].id = 'dev:whatsapp'; c.policy.grants[0].principalId = 'dev:whatsapp'; },
    c => { c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; },
    c => { c.policy.connections[0].whatsapp.readerSubjectId = c.policy.connections[0].whatsapp.subjectId; },
    c => { c.policy.connections[0].templateReaderSecretArn = c.policy.connections[0].secretArn; },
    c => { c.policy.connections[0].secretArn = c.policy.connections[0].secretArn.replace('/prod/', '/dev/'); },
    c => { c.policy.grants[0].operations.push(C.REVOKE); }, c => { c.policy.grants[1].operations.push(C.TEXT); },
    c => { c.policy.grants[1].tenantRef = 'clinic:999'; }, c => { c.policy.connections[0].expiresAt = null; },
    c => { c.policy.connections[0].whatsapp.templates.push(c.policy.connections[0].whatsapp.templates[0]); },
  ];
  const file = path.join(f.dir, 'bad.json'); let aws = 0;
  for (const mutate of cases) { const config = structuredClone(f.config); mutate(config); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(runtime.main(file, { awsFactory: async () => { aws++; throw Error('FORBIDDEN_AWS'); } }), { code: 'invalid_request' }); }
  assert.equal(aws, 0);
});
test('actual TLS consumer to WhatsApp broker uses fake AWS/Meta, durable receipt, revocation and audit', async t => {
  const f = fixture(t); const config = { ...f.config, stateFile: path.join(f.dir, 'runtime.sqlite') };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', config.tlsKeyFile, '-out', config.tlsCertFile,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(config.tlsKeyFile, 0o600); fs.chmodSync(config.tlsCertFile, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); config.port = probe.address().port;
  await new Promise(resolve => probe.close(resolve)); const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  let sends = 0; let closed = 0; const events = [];
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'qa-version', digest: row.digest }; } };
  let app = await runtime.main(filename, { awsFactory: async () => ({ secrets: f.aws, sink, close() { closed++; } }), http: async req => {
    assert.equal(req.action, 'send'); sends++; return { messaging_product: 'whatsapp', messages: [{ id: 'wamid.FICTITIOUS_TLS' }] };
  } });
  allowPort(config.port); t.after(async () => { if (app) await app.close(); removePort(config.port); });
  const transport = (control = false) => createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${config.port}`, audience: f.policy.audience,
    keyId: control ? 'qa-control' : 'qa-send', privateKey: (control ? f.controlKeys : f.keys).privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(config.tlsCertFile) });
  const binding = { connectionRef: f.binding.connectionRef, phoneId: '401', clinicId: 123, assetId: 456, revision: 1, active: true };
  const client = createWhatsappBrokerClient({ client: transport(), loadBinding: async () => binding,
    environment: () => ({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' }) });
  const intent = { messageId: '123', clinicId: 123, assetId: 456, operation: C.TEXT, payload: { to: '34000000123', body: 'FICTITIOUS_TLS_BODY', previewUrl: false } };
  assert.equal((await client.send(intent)).replayed, false); assert.equal((await client.send(intent)).replayed, true); assert.equal(sends, 1);
  const revocation = f.command({ operation: C.REVOKE, payload: {} }); assert.equal((await transport(true).execute(revocation)).data.revoked, true);
  await assert.rejects(client.send({ ...intent, messageId: '124' }), { code: 'whatsapp_delivery_unknown' }); assert.equal(sends, 1);
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert(events.some(e => e.operation === C.TEXT && e.action === 'integration.completed')); assert(events.some(e => e.action === 'asset.revoked'));
  assert(!JSON.stringify(events).includes('FICTITIOUS_TLS_BODY'));
  await app.close(); app = null; assert.equal(closed, 1);
});
