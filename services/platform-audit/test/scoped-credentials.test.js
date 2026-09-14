'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
const vm = require('node:vm'); const path = require('node:path'); const { createRequire } = require('node:module');
const { createServer } = require('../src/credential-broker'); const { ROLES, validateLease, createClient } = require('../src/scoped-credentials');
const { unixAgentForTestServer } = require('./offline-guard.cjs'); const { pack, keyFor } = require('../src/event');
const { fixture } = require('./fixture.cjs');
const source = 'arn:aws:iam::137819318729:role/fictitious-source';
const identity = role => ({ Account: '137819318729', Arn: `arn:aws:sts::137819318729:assumed-role/${role.split('/').at(-1)}/fixture` });
const lease = kind => ({ version: 1, roleArn: ROLES[kind], sourceIdentity: identity(source), credentials: {
  accessKeyId: 'ASIA' + 'F'.repeat(16), secretAccessKey: 'F'.repeat(40), sessionToken: 'FICTITIOUS_ONLY_TOKEN', expiration: new Date(Date.now() + 890000).toISOString() } });
test('Unix credential endpoints bind a role to each socket and reject wrong role, expiry and loose permissions', async t => {
  const root = fs.mkdtempSync('/tmp/cc-audit-credentials-'); fs.chmodSync(root, 0o711); let mode = 'writer'; const seen = [];
  const server = createServer('writer', async kind => { seen.push(kind); return lease(mode); });
  const socketPath = root + '/writer.sock'; await new Promise(resolve => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o660);
  const agent = unixAgentForTestServer(server); t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true }); });
  const get = createClient({ socketPath, brokerUid: process.getuid(), kind: 'writer', sourceRoleArn: source, agent });
  assert.equal((await get()).roleArn, ROLES.writer); assert.deepEqual(seen, ['writer']);
  mode = 'reader'; await assert.rejects(get(), /audit_identity_invalid/);
  fs.chmodSync(socketPath, 0o666); await assert.rejects(get(), /audit_identity_invalid/); assert.equal(seen.length, 2);
  const expired = lease('writer'); expired.credentials.expiration = new Date().toISOString(); assert.throws(() => validateLease(expired, 'writer', source));
  const foreign = lease('writer'); foreign.sourceIdentity = identity('arn:aws:iam::137819318729:role/another-source'); assert.throws(() => validateLease(foreign, 'writer', source));
});
test('credential broker uses IMDSv2 only, validates source first and can assume only the two fixed roles', async () => {
  const filename = path.resolve(__dirname, '../src/credential-broker.js'); const localRequire = createRequire(filename); const calls = []; let foreign = false;
  class GetCallerIdentityCommand {} class AssumeRoleCommand { constructor(input) { this.input = input; } }
  class STSClient {
    constructor(config) { assert.equal(config.endpoint, 'https://sts.eu-west-3.amazonaws.com'); assert.equal(config.maxAttempts, 1); }
    async send(command) { calls.push(command.constructor.name);
      if (command instanceof GetCallerIdentityCommand) return identity(foreign ? 'arn:aws:iam::137819318729:role/foreign' : source);
      assert(Object.values(ROLES).includes(command.input.RoleArn)); assert.equal(command.input.DurationSeconds, 900);
      const c = lease('writer').credentials; return { Credentials: { AccessKeyId: c.accessKeyId, SecretAccessKey: c.secretAccessKey, SessionToken: c.sessionToken, Expiration: new Date(c.expiration) } };
    }
    destroy() {}
  }
  const overrides = { '@aws-sdk/credential-providers': { fromInstanceMetadata: options => { assert.equal(options.ec2MetadataV1Disabled, true); return () => assert.fail('no actual credentials'); } },
    '@aws-sdk/client-sts': { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } };
  const module = { exports: {} }; vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, AbortSignal,
    require: name => overrides[name] || localRequire(name) });
  const provider = module.exports.createLeaseProvider(source);
  await Promise.all([provider.lease('writer'), provider.lease('writer')]); assert.deepEqual(calls, ['GetCallerIdentityCommand', 'AssumeRoleCommand']);
  await assert.rejects(provider.lease('retention')); assert.equal(calls.length, 2);
  foreign = true; await assert.rejects(provider.lease('reader')); assert.equal(calls.at(-1), 'GetCallerIdentityCommand'); provider.close();
});
test('scoped runtime checks the actual target identity before S3 and never asks for instance or SSO credentials', async () => {
  const filename = path.resolve(__dirname, '../src/scoped-runtime.js'); const localRequire = createRequire(filename); let requested; let actual; let puts = 0; let gets = 0;
  const row = pack(fixture()); const { KEY_ARN } = require('../src/s3');
  class GetCallerIdentityCommand {}
  class STSClient { constructor(config) { assert.equal(config.credentials.accessKeyId, lease('writer').credentials.accessKeyId); }
    async send() { return identity(actual); } destroy() {} }
  class S3Client { async send(command) {
    if (command.constructor.name === 'PutObjectCommand') { puts++; return { ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: 'fictitious' }; }
    gets++; assert.equal(command.constructor.name, 'GetObjectCommand'); throw Error('fictitious missing');
  } destroy() {} }
  const overrides = { './scoped-credentials': { ROLES, runtimeClient: (config, kind) => async () => { requested = kind; return lease(kind); } },
    '@aws-sdk/client-sts': { STSClient, GetCallerIdentityCommand }, '@aws-sdk/client-s3': { S3Client } };
  const module = { exports: {} }; vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, AbortSignal,
    require: name => { assert.notEqual(name, '@aws-sdk/credential-providers'); return overrides[name] || localRequire(name); } });
  const input = { version: 1, sourceRoleArn: source, records: [{ body: row.body, digest: row.digest }] }; const config = { brokerSourceRoleArn: source };
  actual = ROLES.reader; await assert.rejects(module.exports.write(input, config)); assert.equal(puts, 0);
  actual = ROLES.writer; assert.equal((await module.exports.write(input, config)).results[0].status, 'delivered'); assert.equal(requested, 'writer');
  const read = { version: 1, audience: 'clinicaclick-audit-reader-v1', requestId: require('node:crypto').randomUUID(), nonce: require('node:crypto').randomUUID(), issuedAt: Date.now(),
    mode: 'reconcile', actorId: 'platform_audit_reconciler', sessionRef: null, refs: [{ key: keyFor(row), digest: row.digest, versionId: null }] };
  await assert.rejects(module.exports.read(read, config)); assert.equal(gets, 0);
  actual = ROLES.reader; await module.exports.read(read, config); assert.equal(requested, 'reader'); assert.equal(gets, 1);
});
