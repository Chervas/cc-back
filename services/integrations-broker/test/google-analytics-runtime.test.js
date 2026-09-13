'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const net = require('node:net'); const { randomBytes } = require('node:crypto'); const { execFileSync } = require('node:child_process');
const { fixture } = require('./helpers'); const { analyticsReport } = require('./analytics-helpers'); const { allowPort, removePort } = require('./offline-guard.cjs');
const runtime = require('../src/google-main'); const contract = require('../src/google-analytics-contract'); const { eventFor, drainAudit } = require('../src/audit');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { createAnalyticsBroker } = require('../../../src/services/analyticsBroker.service');
test('actual GA TLS runtime, signed client and adapter exchange metrics only and retain a block across restart', async t => {
  const f = fixture(t); const cert = path.join(f.dir, 'tls.crt'); const key = path.join(f.dir, 'tls.key'); const cursorKey = path.join(f.dir, 'cursor.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  for (const file of [cert, key]) fs.chmodSync(file, 0o600); fs.writeFileSync(cursorKey, randomBytes(32), { mode: 0o600 });
  const resource = contract.property('properties/123');
  const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-ga-abcdef';
  const appArn = secretArn.replace('fictitious-ga', 'fictitious-app');
  f.policy.connections[0] = { ...f.policy.connections[0], provider: contract.PROVIDER, secretArn, clientSecretArn: appArn,
    googleSubject: 'fictitious-subject', analyticsProperties: [resource] };
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: resource.assetRef, operations: contract.OPERATIONS };
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = { cohort: 'google-analytics-read-v1', enabled: true, policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'ga.sqlite'), tlsCertFile: cert, tlsKeyFile: key, cursorKeyFile: cursorKey };
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const ACCESS = 'FICTITIOUS_GA_ACCESS'; const events = []; let reads = 0; let refreshes = 0; let metadataCalls = 0; let closes = 0;
  const secrets = { async send(command) {
    const arn = command.input.SecretId; assert([secretArn, appArn].includes(arn)); metadataCalls++;
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: arn, KmsKeyId: runtime.SECRET_KEY };
    assert.equal(command.constructor.name, 'GetSecretValueCommand');
    const value = arn === secretArn ? { version: 3, provider: contract.PROVIDER, connectionRef: 'connection:test', googleUserId: 'fictitious-subject',
      clientId: 'fictitious-client', refreshToken: 'FICTITIOUS_REFRESH', scopes: [contract.SCOPES[0]] }
      : { version: 1, provider: 'google-oauth-client', clientId: 'fictitious-client', clientSecret: 'FICTITIOUS_CLIENT' };
    return { ARN: arn, VersionId: 'fictitious-current', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(value) };
  } };
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'fictitious-s3', digest: row.digest }; } };
  const dependencies = { awsFactory: async () => ({ secrets, sink, close: () => { closes++; } }), http: async request => {
    if (request.hostname === 'oauth2.googleapis.com') { refreshes++; return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: contract.SCOPES[0] }; }
    reads++; assert.equal(request.hostname, 'analyticsdata.googleapis.com'); assert.equal(request.path, '/v1beta/properties/123:runReport');
    assert.equal(request.token.toString(), ACCESS);
    return { ...analyticsReport('city', { offset: Number(request.json.offset), count: request.json.offset === '0' ? 500 : 1, total: 501 }), ignoredToken: ACCESS };
  } };
  let app = await runtime.main(filename, dependencies); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const client = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience, keyId: 'qa-key',
    privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const mapping = { id: 91, clinicaId: 123, googleConnectionId: 81, propertyName: resource.propertyName, isActive: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: resource.assetRef };
  const consumer = createAnalyticsBroker({ client, enabled: () => true, loadMapping: async () => mapping,
    loadBindings: async () => [{ property_name: resource.propertyName, mapping_id: 91, clinica_id: 123, google_connection_id: 81,
      google_user_id: 'fictitious-subject', connection_ref: 'connection:test', asset_ref: resource.assetRef, state: 'active' }],
    loadConnection: async () => ({ id: 81, googleUserId: 'fictitious-subject', credentials_external: 1 }) });
  const context = await consumer.prepare(mapping); const range = { startDate: '2026-09-01', endDate: '2026-09-02' };
  const data = await consumer.read(mapping, context, 'city', range); assert.equal(data.rows.length, 501); assert.equal(data.rowCount, 501);
  assert.equal(refreshes, 1); assert.equal(reads, 2); assert.equal(metadataCalls, 8); assert(!JSON.stringify(data).includes(ACCESS));
  await assert.rejects(client.execute({ operation: contract.OPERATIONS[0], tenantRef: 'clinic:999', connectionRef: 'connection:test', assetRef: resource.assetRef,
    payload: { ...range, pageToken: null } }), { code: 'scope_denied' }); assert.equal(metadataCalls, 8);
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert(events.some(e => e.version === 2 && e.operation === 'google.analytics.city.read.v1' && e.resourceRef === 'ga4:123'));
  const durable = JSON.stringify(events) + JSON.stringify(app.store.db.prepare('SELECT * FROM commands').all());
  for (const token of [ACCESS, 'FICTITIOUS_REFRESH', 'FICTITIOUS_CLIENT', 'FICTITIOUS_DIMENSION_']) assert(!durable.includes(token));
  app.broker.block('connection:test', eventFor({ ...f.command(), assetRef: resource.assetRef, operation: contract.OPERATIONS[0] }, f.policy.principals[0], f.policy,
    'connection.blocked', 'success', 'operator_block'));
  await app.close(); app = null; app = await runtime.main(filename, dependencies);
  await assert.rejects(consumer.read(mapping, context, 'city', range), { code: 'connection_blocked' });
  assert.equal(reads, 2); assert.equal(refreshes, 1); await app.close(); app = null; assert.equal(closes, 2);
});
