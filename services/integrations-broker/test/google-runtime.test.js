'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net'); const vm = require('node:vm');
const { randomBytes, generateKeyPairSync } = require('node:crypto'); const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module'); const { fixture } = require('./helpers');
const { allowPort, removePort } = require('./offline-guard.cjs');
const runtime = require('../src/google-main'); const { OPERATIONS, PROVIDER, REVOKE_OPERATION } = require('../src/google-business-profile-contract');
const { SCOPE } = require('../src/google-secrets'); const { drainAudit, eventFor } = require('../src/audit');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { createBusinessProfileBroker } = require('../../../src/services/businessProfileBroker.service');
test('actual TLS runtime connects a managed backend location to fixed fictitious Google operations and drains audit', async t => {
  const f = fixture(t); const cert = path.join(f.dir, 'tls.crt'); const key = path.join(f.dir, 'tls.key'); const cursorKey = path.join(f.dir, 'cursor.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600); fs.writeFileSync(cursorKey, randomBytes(32), { mode: 0o600 });
  const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-google-abcdef';
  const appArn = secretArn.replace('fictitious-google', 'fictitious-app');
  f.policy.connections[0] = { ...f.policy.connections[0], provider: PROVIDER, secretArn, clientSecretArn: appArn };
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: 'gbp:123:456', operations: OPERATIONS };
  const controlKey = generateKeyPairSync('ed25519');
  f.policy.principals.push({ ...f.policy.principals[0], id: 'control:test', keyId: 'qa-control', publicKey: controlKey.publicKey.export({ type: 'spki', format: 'pem' }) });
  f.policy.grants.push({ ...f.policy.grants[0], principalId: 'control:test', operations: [REVOKE_OPERATION] });
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const filename = path.join(f.dir, 'config.json');
  const config = { cohort: 'google-business-profile-read-v1', enabled: true, policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'google.sqlite'), tlsCertFile: cert, tlsKeyFile: key, cursorKeyFile: cursorKey };
  fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const samePrincipal = structuredClone(config); samePrincipal.policy.grants[1].principalId = samePrincipal.policy.grants[0].principalId;
  assert.throws(() => runtime.validateConfig(samePrincipal), { code: 'invalid_request' });
  const sameKey = structuredClone(config); sameKey.policy.principals[1].publicKey = sameKey.policy.principals[0].publicKey;
  assert.throws(() => runtime.validateConfig(sameKey), { code: 'invalid_request' });
  const ACCESS = 'FICTITIOUS_ACCESS_SENTINEL'; let refreshes = 0; let reads = 0; let awsClosed = false; const delivered = [];
  const secrets = { async send(command) {
    const arn = command.input.SecretId; assert([secretArn, appArn].includes(arn));
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: arn, KmsKeyId: runtime.SECRET_KEY };
    const value = arn === secretArn ? { version: 2, provider: PROVIDER, connectionRef: 'connection:test', refreshToken: 'FICTITIOUS_REFRESH', scopes: [SCOPE] }
      : { version: 1, provider: 'google-oauth-client', clientId: 'fictitious.apps.googleusercontent.com', clientSecret: 'FICTITIOUS_CLIENT_SECRET' };
    return { ARN: arn, VersionId: 'fictitious-current', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(value) };
  } };
  const sink = { async write(row) { delivered.push(JSON.parse(row.event)); return { versionId: 'fictitious-s3-version', digest: row.digest }; } };
  let app = await runtime.main(filename, { awsFactory: async () => ({ secrets, sink, close: () => { awsClosed = true; } }), http: async request => {
    if (request.hostname === 'oauth2.googleapis.com') { refreshes++; return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: SCOPE }; }
    reads++; assert.equal(request.hostname, 'mybusinessbusinessinformation.googleapis.com'); assert.equal(request.token.toString(), ACCESS);
    return { name: 'locations/456', title: 'FICTITIOUS_BUSINESS_TITLE', internal: ACCESS };
  } });
  allowPort(app.server.address().port); t.after(async () => { if (app) await app.close(); removePort(port); });
  const transport = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience, keyId: 'qa-key',
    privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const location = { id: 51, clinica_id: 123, google_connection_id: 81, location_id: 'locations/456', is_active: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456' };
  const consumer = createBusinessProfileBroker({ client: transport, enabled: () => true, loadLocation: async () => location,
    loadManagedBinding: async () => ({ external_location_id: '456', connection_ref: 'connection:test', asset_ref: 'gbp:123:456', clinica_id: 123, google_connection_id: 81 }) });
  const context = await consumer.prepare(location, () => { throw Error('TOKEN_LOADER_FORBIDDEN'); }, new Map());
  assert.deepEqual((await consumer.read(location, context, 'details', {})).data, { name: 'locations/456', title: 'FICTITIOUS_BUSINESS_TITLE' });
  await consumer.read(location, context, 'details', {}); assert.equal(refreshes, 1); assert.equal(reads, 2);
  await assert.rejects(transport.execute({ ...f.command(), assetRef: 'gbp:123:999', operation: OPERATIONS[4], payload: {} }), { code: 'scope_denied' });
  const controlTransport = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience, keyId: 'qa-control',
    privateKey: controlKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const revocation = { ...f.command(), assetRef: 'gbp:123:456', operation: REVOKE_OPERATION, payload: {} };
  assert.equal((await controlTransport.execute(revocation)).data.revoked, true);
  assert.equal((await controlTransport.execute(revocation)).replayed, true);
  await assert.rejects(consumer.read(location, context, 'details', {}), { code: 'asset_revoked' });
  assert.equal(refreshes, 1); assert.equal(reads, 2);
  const request = { ...f.command(), assetRef: 'gbp:123:456', operation: OPERATIONS[4] };
  app.broker.block(request.connectionRef, eventFor(request, f.policy.principals[0], f.policy, 'connection.blocked', 'success', 'operator_block'));
  await assert.rejects(consumer.read(location, context, 'details', {}), { code: 'connection_blocked' });
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert(delivered.some(e => e.version === 2 && e.operation === OPERATIONS[4] && e.connectionRef === 'connection:test'));
  const serialized = JSON.stringify(delivered) + JSON.stringify(app.store.db.prepare('SELECT * FROM commands').all());
  for (const sentinel of [ACCESS, 'FICTITIOUS_REFRESH', 'FICTITIOUS_CLIENT_SECRET', 'FICTITIOUS_BUSINESS_TITLE']) assert(!serialized.includes(sentinel));
  await app.close(); app = null; assert(awsClosed);
  const { BrokerStore } = require('../src/store'); const reopened = new BrokerStore(config.stateFile);
  assert.throws(() => reopened.connection('connection:test'), { code: 'connection_blocked' });
  assert.throws(() => reopened.assertAssetActive(revocation), { code: 'asset_revoked' }); reopened.close();
});
test('AWS bootstrap validates source and writer identities before constructing secret/provider clients', async () => {
  const filename = require.resolve('../src/google-main'); const localRequire = createRequire(filename); const code = fs.readFileSync(filename, 'utf8');
  const target = 'arn:aws:sts::137819318729:assumed-role/clinicaclick-audit-prod-writer-role/clinicaclick-integrations-audit';
  for (const scenario of ['source-denied', 'writer-denied', 'accepted']) {
    const constructed = []; const metadata = []; const assumptions = []; let stsCount = 0; let closed = 0;
    class Client { constructor(config) { this.config = config; constructed.push({ kind: this.constructor.name, config }); } destroy() { closed++; } }
    class STSClient extends Client { constructor(c) { super(c); this.index = stsCount++; } async send() {
      return { Account: '137819318729', Arn: this.index === 0 ? scenario === 'source-denied' ? target : runtime.SOURCE : scenario === 'writer-denied' ? runtime.SOURCE : target };
    } }
    class SecretsManagerClient extends Client {} class S3Client extends Client {}
    const dependencies = {
      '@aws-sdk/credential-providers': { fromInstanceMetadata: config => { metadata.push(config); return 'FICTITIOUS_IMDS_PROVIDER'; }, fromTemporaryCredentials: config => { assumptions.push(config); return 'FICTITIOUS_WRITER_PROVIDER'; } },
      '@aws-sdk/client-sts': { STSClient, GetCallerIdentityCommand: class {} }, '@aws-sdk/client-secrets-manager': { SecretsManagerClient },
      '@aws-sdk/client-s3': { S3Client }, '@smithy/node-http-handler': { NodeHttpHandler: class { constructor(config) { this.config = config; } } },
    };
    const module = { exports: {} }; const requireForTest = name => dependencies[name] || localRequire(name);
    vm.runInNewContext(code, { module, exports: module.exports, require: requireForTest, Buffer, AbortSignal,
      process: { versions: { node: '24.21.0' }, env: { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_V1_DISABLED: 'true', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254' } } }, { filename });
    if (scenario === 'accepted') {
      const aws = await module.exports.connectAws(); assert(aws.secrets); aws.close(); assert.equal(constructed.length, 4);
      assert.equal(constructed[2].config.credentials, 'FICTITIOUS_IMDS_PROVIDER'); assert.equal(constructed[3].config.credentials, 'FICTITIOUS_WRITER_PROVIDER');
    } else {
      await assert.rejects(module.exports.connectAws(), { code: 'scope_denied' }); assert.equal(constructed.length, scenario === 'source-denied' ? 1 : 2);
    }
    assert.equal(closed, constructed.length); assert.equal(metadata[0].ec2MetadataV1Disabled, true);
    assert.equal(assumptions.length, scenario === 'source-denied' ? 0 : 1);
    for (const client of constructed) { assert.match(client.config.endpoint, /^https:\/\/(sts|s3|secretsmanager)\.eu-west-3\.amazonaws.com$/); assert.equal(client.config.maxAttempts, 1); }
  }
});
