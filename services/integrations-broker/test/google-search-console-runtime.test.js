'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const net = require('node:net'); const { randomBytes, generateKeyPairSync } = require('node:crypto'); const { execFileSync } = require('node:child_process');
const { fixture } = require('./helpers'); const { allowPort, removePort } = require('./offline-guard.cjs');
const runtime = require('../src/google-main'); const contract = require('../src/google-search-console-contract'); const { drainAudit, eventFor } = require('../src/audit');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { createSearchConsoleBroker } = require('../../../src/services/searchConsoleBroker.service');
test('actual SC TLS runtime and backend adapter preserve scoped revocation and connection blocks after restart', async t => {
  const f = fixture(t); const cert = path.join(f.dir, 'tls.crt'); const key = path.join(f.dir, 'tls.key'); const cursorKey = path.join(f.dir, 'cursor.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600); fs.writeFileSync(cursorKey, randomBytes(32), { mode: 0o600 });
  const site = contract.site('https://example.invalid/'); const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-sc-abcdef';
  const appArn = secretArn.replace('fictitious-sc', 'fictitious-client');
  f.policy.connections[0] = { ...f.policy.connections[0], provider: contract.PROVIDER, secretArn, clientSecretArn: appArn,
    googleSubject: 'fictitious-subject', searchConsoleSites: [{ siteUrl: site.siteUrl, assetRef: site.assetRef }] };
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: site.assetRef, operations: contract.OPERATIONS };
  const controlKey = generateKeyPairSync('ed25519');
  f.policy.principals.push({ ...f.policy.principals[0], id: 'control:test', keyId: 'qa-control', publicKey: controlKey.publicKey.export({ type: 'spki', format: 'pem' }) });
  f.policy.grants.push({ ...f.policy.grants[0], principalId: 'control:test', operations: [contract.REVOKE_OPERATION] });
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = { cohort: 'google-search-console-read-v1', enabled: true, policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'sc.sqlite'), tlsCertFile: cert, tlsKeyFile: key, cursorKeyFile: cursorKey };
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const ACCESS = 'FICTITIOUS_SC_ACCESS_SENTINEL'; const delivered = []; let refreshes = 0; let reads = 0; let descriptions = 0; let closed = 0;
  const secrets = { async send(command) {
    const arn = command.input.SecretId; assert([secretArn, appArn].includes(arn));
    if (command.constructor.name === 'DescribeSecretCommand') { descriptions++; return { ARN: arn, KmsKeyId: runtime.SECRET_KEY }; }
    assert.equal(command.constructor.name, 'GetSecretValueCommand');
    const value = arn === secretArn ? { version: 3, provider: contract.PROVIDER, connectionRef: 'connection:test', googleUserId: 'fictitious-subject',
      clientId: 'fictitious-client', refreshToken: 'FICTITIOUS_REFRESH', scopes: [contract.SCOPES[0]] }
      : { version: 1, provider: 'google-oauth-client', clientId: 'fictitious-client', clientSecret: 'FICTITIOUS_CLIENT_SECRET' };
    return { ARN: arn, VersionId: 'fictitious-current', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(value) };
  } };
  const sink = { async write(row) { delivered.push(JSON.parse(row.event)); return { versionId: 'fictitious-s3', digest: row.digest }; } };
  const dependencies = { awsFactory: async () => ({ secrets, sink, close: () => { closed++; } }), http: async request => {
    if (request.hostname === 'oauth2.googleapis.com') { refreshes++; return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: contract.SCOPES[0] }; }
    reads++; assert.equal(request.hostname, 'www.googleapis.com'); assert.equal(request.token.toString(), ACCESS);
    if (!request.json) {
      assert.equal(request.path, '/webmasters/v3/sites/https%3A%2F%2Fexample.invalid%2F');
      return { siteUrl: site.siteUrl, permissionLevel: 'siteOwner', ignored: ACCESS };
    }
    return { rows: Array.from({ length: request.json.startRow ? 1 : 500 }, (_, i) => ({ keys: [request.json.startDate, 'FICTITIOUS_QUERY_' + (request.json.startRow + i), 'https://example.invalid/page'],
      clicks: 2, impressions: 4, ctr: 0.5, position: 1, privateToken: ACCESS })), rawToken: ACCESS };
  } };
  let app = await runtime.main(filename, dependencies); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const client = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience, keyId: 'qa-key',
    privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const mapping = { id: 91, clinicaId: 123, googleConnectionId: 81, siteUrl: site.siteUrl, isActive: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: site.assetRef };
  const consumer = createSearchConsoleBroker({ client, enabled: () => true, loadMapping: async () => mapping,
    loadBindings: async () => [{ site_hash: site.siteHash, site_url: site.siteUrl, mapping_id: 91, clinica_id: 123, google_connection_id: 81,
      google_user_id: 'fictitious-subject', connection_ref: 'connection:test', asset_ref: site.assetRef, state: 'active' }],
    loadConnection: async () => ({ id: 81, googleUserId: 'fictitious-subject', credentials_external: 1 }) });
  const context = await consumer.prepare(mapping); assert.deepEqual(context, {});
  const data = (await consumer.read(mapping, context, 'queries', { startDate: '2026-09-01', endDate: '2026-09-02' })).data;
  assert.equal(data.rows.length, 501); assert.equal(data.rowLimitReached, false); assert.equal(refreshes, 1); assert.equal(reads, 2);
  assert(!JSON.stringify(data).includes(ACCESS)); assert.equal(descriptions, 4);
  const before = descriptions;
  await assert.rejects(client.execute({ operation: contract.OPERATIONS[0], tenantRef: 'clinic:999', connectionRef: 'connection:test', assetRef: site.assetRef,
    payload: { startDate: '2026-09-01', endDate: '2026-09-02' } }), { code: 'scope_denied' }); assert.equal(descriptions, before);
  const discovered = await consumer.read(mapping, context, 'discovery', {}, { beforeExecute: async () => ({ timeoutMs: 1000 }) });
  assert.deepEqual(discovered.data, { siteUrl: site.siteUrl, permissionLevel: 'siteOwner' }); assert.equal(reads, 3); assert.equal(descriptions, 6);
  const control = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience, keyId: 'qa-control',
    privateKey: controlKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const revocation = f.command({ operation: contract.REVOKE_OPERATION, assetRef: site.assetRef });
  await assert.rejects(client.execute(revocation), { code: 'scope_denied' });
  assert.deepEqual((await control.execute(revocation)).data, { revoked: true });
  assert.equal((await control.execute(revocation)).replayed, true);
  await assert.rejects(consumer.read(mapping, context, 'discovery', {}), { code: 'asset_revoked' });
  assert.equal(descriptions, 6); assert.equal(refreshes, 1); assert.equal(reads, 3);
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert(delivered.some(e => e.version === 2 && e.operation === contract.OPERATIONS[1] && e.resourceRef === site.assetRef));
  assert.equal(delivered.filter(e => e.action === 'asset.revoked' && e.operation === contract.REVOKE_OPERATION && e.actorId === 'control:test').length, 1);
  const durable = JSON.stringify(delivered) + JSON.stringify(app.store.db.prepare('SELECT * FROM commands').all());
  for (const sentinel of [ACCESS, 'FICTITIOUS_REFRESH', 'FICTITIOUS_CLIENT_SECRET', 'FICTITIOUS_QUERY_', 'https://example.invalid/page']) assert(!durable.includes(sentinel));
  await app.close(); app = null; app = await runtime.main(filename, dependencies);
  assert.equal((await control.execute(revocation)).replayed, true);
  await assert.rejects(consumer.read(mapping, context, 'queries', { startDate: '2026-09-01', endDate: '2026-09-02' }), { code: 'asset_revoked' });
  await assert.rejects(consumer.read(mapping, context, 'discovery', {}), { code: 'asset_revoked' });
  assert.equal(descriptions, 6); assert.equal(reads, 3);
  app.broker.block('connection:test', eventFor({ ...f.command(), assetRef: site.assetRef, operation: contract.OPERATIONS[0] }, f.policy.principals[0], f.policy,
    'connection.blocked', 'success', 'operator_block'));
  await app.close(); app = null; assert.equal(closed, 2);
  app = await runtime.main(filename, dependencies);
  await assert.rejects(consumer.read(mapping, context, 'queries', { startDate: '2026-09-01', endDate: '2026-09-02' }), { code: 'connection_blocked' });
  await assert.rejects(consumer.read(mapping, context, 'discovery', {}), { code: 'connection_blocked' });
  assert.equal(reads, 3); assert.equal(refreshes, 1); await app.close(); app = null; assert.equal(closed, 3);
});
