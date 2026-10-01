'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createHmac, randomUUID, X509Certificate } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { S3Client, PutObjectCommand, HeadObjectCommand, PutObjectTaggingCommand } = require('@aws-sdk/client-s3');
const { fromInstanceMetadata } = require('@aws-sdk/credential-providers');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { connectInboxAws } = require('./whatsapp-inbox-main');
const { createInboxKeyProvider } = require('./whatsapp-inbox-key');
const { createWhatsappInbox } = require('./whatsapp-inbox');
const { createInboxArchive, BUCKET } = require('./whatsapp-inbox-archive');
const { createInboxServer } = require('./whatsapp-inbox-server');
const { BrokerStore } = require('./store');
const { drainAudit } = require('./audit');
const { bindingsFor } = require('./whatsapp-inbox-scopes');
const { createInboxClient } = require('../../../src/lib/whatsappInboxClient');
const { createGatewayHandler } = require('../../../src/lib/whatsappInboxGateway');

const ACCOUNT = '137819318729';
const ROOT = '/var/lib/clinicaclick-whatsapp-network-canary';
const TOTAL = 200;
const PHONES = 100;
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];

// Only the test's synthetic objects may leave its SQLite. Never create foreign
// receipt envelopes under production v1/, where recovery inventories scan.
function isolatedArchiveClient(client, runId) {
  if (!/^[a-z0-9-]{1,80}$/.test(runId) || typeof client?.send !== 'function') throw Error('qa_archive_invalid');
  const classes = new Map([[PutObjectCommand, 'put'], [HeadObjectCommand, 'head'], [PutObjectTaggingCommand, 'tag']]);
  const metrics = { put: [], head: [], tag: [] };
  return { metrics, async send(command, options) {
    const kind = classes.get(command?.constructor);
    const key = command?.input?.Key;
    if (!kind || command.input.Bucket !== BUCKET || command.input.ExpectedBucketOwner !== ACCOUNT
      || typeof key !== 'string' || !key.startsWith('v1/') || !key.endsWith('.json')
      || !UUID.test(key.slice(3, -5))) throw Error('qa_archive_invalid');
    const input = { ...command.input, Key: `meta/qa-network/${runId}/${key}` };
    const started = performance.now();
    const result = await client.send(new command.constructor(input), options);
    metrics[kind].push(performance.now() - started);
    return result;
  } };
}

function certificates(directory) {
  const run = args => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '7', '-subj', '/CN=CC_SYNTHETIC_NETWORK_CA']);
  const identities = {};
  for (const name of ['server', 'gateway', 'staging']) {
    fs.writeFileSync(path.join(directory, name + '.ext'), name === 'server'
      ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth' : 'extendedKeyUsage=clientAuth', { mode: 0o600 });
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=CC_SYNTHETIC_' + name]);
    run(['x509', '-req', '-in', name + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', name + '.crt', '-days', '7', '-extfile', name + '.ext']);
    identities[name] = { key: fs.readFileSync(path.join(directory, name + '.key')), cert: fs.readFileSync(path.join(directory, name + '.crt')) };
  }
  return { identities, ca: fs.readFileSync(path.join(directory, 'ca.crt')) };
}

async function run(args) {
  if (args.length !== 2 || args[0] !== '--synthetic-only' || !/^[a-z0-9-]{1,80}$/.test(args[1])
    || process.getuid() !== 0 || process.versions.node.split('.')[0] !== '24'
    || process.env.AWS_CONFIG_FILE !== '/dev/null' || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null'
    || process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true'
    || process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT !== 'http://169.254.169.254') throw Error('qa_invocation_invalid');
  const runId = args[1];
  const directory = path.join(ROOT, runId);
  let stage = 'identity';
  let aws, s3, sts, cipher, store, server, bridge, gateway, consumer, crypto;
  let worker, working, workerError;
  let stopped = false;
  const deadline = performance.now() + 240000;
  let clockOffset = 0;
  let success = false;
  const secret = Buffer.from('SYNTHETIC_ONLY_NO_META_APP_SECRET');
  const accepted = new Map();
  const acceptanceMs = [], importMs = [];
  try {
    const credentials = fromInstanceMetadata({ timeout: 1500, maxRetries: 0, ec2MetadataV1Disabled: true });
    const configuration = { region: 'eu-west-3', credentials, maxAttempts: 1,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 10000, throwOnRequestTimeout: true }) };
    sts = new STSClient({ ...configuration, endpoint: 'https://sts.eu-west-3.amazonaws.com' });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    assert.equal(identity.Account, ACCOUNT);
    assert.equal(identity.Arn, `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-integrations-prod-ec2-role/i-0cf40cfe823f160fa`);
    stage = 'private_state';
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    assert.equal(fs.realpathSync(directory), directory);
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    aws = await connectInboxAws();
    const keys = createInboxKeyProvider(aws.kms);
    const manifest = await keys.prepare('101');
    fs.writeFileSync(path.join(directory, 'key.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    cipher = await keys.open(manifest, '101');
    store = new BrokerStore(path.join(directory, 'inbox.sqlite'));
    store.db.exec('CREATE TABLE qa_import_commits (receipt TEXT PRIMARY KEY, import_receipt TEXT NOT NULL, digest TEXT NOT NULL)');
    const scopes = Array.from({ length: PHONES }, (_, i) => ({ wabaId: String(300000 + i), phoneId: String(400000 + i), clinicIds: [1000000 + i] }));
    const inbox = createWhatsappInbox({ store, cipher, appId: '101', archiveEnabled: true,
      scopeBindings: scopes, bindings: bindingsFor(scopes), now: () => Date.now() + clockOffset,
      auditContext: { tenantRef: 'clinic:1000000', connectionRef: 'connection:synthetic-network-canary',
        resourceRef: 'wa-inbox:101', policyVersion: 'synthetic-network-canary-v1', operation: 'whatsapp.webhook.capture' } });
    s3 = new S3Client({ ...configuration, endpoint: 'https://s3.eu-west-3.amazonaws.com', followRegionRedirects: false });
    const transport = isolatedArchiveClient(s3, runId);
    const archive = createInboxArchive({ client: transport });
    crypto = certificates(directory);
    server = createInboxServer({ inbox, archive, ...crypto.identities.server, ca: crypto.ca,
      withApplicationSecret: work => work(secret), consumerEnabled: true,
      now: () => Date.now() + clockOffset,
      principals: ['gateway', 'staging'].map(name => ({ id: name + ':whatsapp-inbox', maxPerMinute: 600,
        certificateSha256: new X509Certificate(crypto.identities[name].cert).fingerprint256.replaceAll(':', '').toLowerCase() })) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://127.0.0.1:' + server.address().port;
    gateway = createInboxClient({ origin, ca: crypto.ca, ...crypto.identities.gateway });
    consumer = createInboxClient({ origin, ca: crypto.ca, ...crypto.identities.staging });
    bridge = http.createServer(createGatewayHandler(gateway));
    await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
    const send = raw => new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: bridge.address().port, path: '/api/whatsapp/webhook',
        method: 'POST', agent: false, headers: { 'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.setTimeout(15000, () => request.destroy(Error('qa_request_timeout')));
      request.on('error', reject); request.end(raw);
    });
    const pump = async () => {
      if (stopped || performance.now() >= deadline) throw Error('qa_deadline');
      const delivery = await drainAudit(store, aws.sink, { limit: 20 });
      assert.equal(delivery.failed, 0);
      await Promise.all(inbox.untaggedImported(5).map(receipt => inbox.tagImported(receipt, archive)));
    };
    worker = setInterval(() => { if (!working && !workerError) working = pump().catch(error => { workerError = error; }).finally(() => { working = null; }); }, 1000);
    let imported = 0, producerFinished = false;
    const consume = async () => {
      while (!producerFinished || imported < TOTAL) {
        if (stopped || performance.now() >= deadline) throw Error('qa_deadline');
        if (workerError) throw workerError;
        const listed = await consumer.request('GET', '/pending');
        assert.equal(listed.status, 200);
        for (const item of listed.data.receipts) {
          const leased = await consumer.request('POST', '/lease', { receipt: item.receipt });
          assert.equal(leased.status, 200);
          const raw = Buffer.from(leased.data.rawBase64, 'base64');
          let digest;
          try {
            assert(raw.includes(Buffer.from('pruebas nocturnas carlos ignorar SYNTHETIC')));
            assert.equal(leased.data.automaticActionsAllowed, false);
            digest = cipher.digest('101', raw);
            assert(accepted.has(digest));
          } finally { raw.fill(0); }
          const importReceipt = randomUUID();
          store.db.prepare('INSERT INTO qa_import_commits VALUES (?,?,?)').run(item.receipt, importReceipt, digest);
          const ack = await consumer.request('POST', '/confirm', { receipt: item.receipt, lease: leased.data.lease, importReceipt });
          assert.equal(ack.status, 200);
          assert.equal(ack.data.businessProcessed, true);
          importMs.push(performance.now() - accepted.get(digest));
          imported++;
        }
        await sleep(2000);
      }
    };
    stage = 'network_load';
    const began = performance.now();
    const consuming = consume();
    consuming.catch(error => { workerError = error; });
    for (let i = 0; i < TOTAL; i++) {
      if (performance.now() >= deadline) throw Error('qa_deadline');
      if (workerError) throw workerError;
      const scope = scopes[i % PHONES];
      const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: scope.wabaId,
        changes: [{ field: 'messages', value: { metadata: { phone_number_id: scope.phoneId },
          messages: [{ id: 'wamid.synthetic-' + runId + '-' + i, from: '34000000001', type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'pruebas nocturnas carlos ignorar SYNTHETIC ' + i } }] } }] }] }));
      try {
        const started = performance.now();
        accepted.set(cipher.digest('101', raw), started);
        assert.equal(await send(raw), 200);
        acceptanceMs.push(performance.now() - started);
      } finally { raw.fill(0); }
      await sleep(Math.max(0, began + (i + 1) * 500 - performance.now()));
    }
    producerFinished = true;
    await consuming;
    stage = 'drain_and_retention';
    clearInterval(worker); worker = null; await working;
    if (workerError) throw workerError;
    while (inbox.untaggedImported(5).length || store.backlog().pending) {
      await pump();
      await sleep(250);
    }
    assert.equal(imported, TOTAL);
    assert.equal(inbox.health().archive.pending, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM qa_import_commits').get().n, TOTAL);
    clockOffset += 25 * 3600000;
    let released = 0;
    while (released < TOTAL) {
      const result = inbox.maintain(100);
      if (!result.released) break;
      released += result.released;
    }
    assert.equal(released, TOTAL);
    assert(importMs.every(Number.isFinite));
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 0);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const report = { at: new Date().toISOString(), status: 'synthetic_network_canary_passed',
      receipts: TOTAL, simulatedPhones: PHONES, gatewayRatePerSecond: 2,
      elapsedSeconds: (performance.now() - began) / 1000,
      acceptanceMs: { p50: percentile(acceptanceMs, 0.5), p95: percentile(acceptanceMs, 0.95), p99: percentile(acceptanceMs, 0.99) },
      custodyToSyntheticCommitMs: { p50: percentile(importMs, 0.5), p95: percentile(importMs, 0.95), p99: percentile(importMs, 0.99) },
      s3: Object.fromEntries(Object.entries(transport.metrics).map(([key, values]) => [key, { count: values.length, p95: values.length ? percentile(values, 0.95) : null }])),
      imported, released, auditPending: store.backlog().pending,
      archivePrefix: 'meta/qa-network/' + runId + '/', loopbackMtls: true, realS3: true,
      syntheticImportOnly: true, realCrmImported: false, metaCalled: false, whatsappSent: false };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    success = true;
    return report;
  } catch {
    throw Error('WHATSAPP_NETWORK_CANARY_FAILED stage=' + stage + '; private state preserved, no automatic retry');
  } finally {
    stopped = true;
    clearInterval(worker); await working?.catch(() => {});
    gateway?.close(); consumer?.close();
    for (const listener of [bridge, server]) if (listener) {
      listener.closeAllConnections?.();
      await new Promise(resolve => listener.close(resolve));
    }
    cipher?.close(); store?.close(); s3?.destroy(); sts?.destroy(); aws?.close(); secret.fill(0);
    if (crypto) for (const identity of Object.values(crypto.identities)) identity.key.fill(0);
    if (success) for (const filename of fs.readdirSync(directory)) {
      if (!['result.json', 'key.json'].includes(filename)) fs.unlinkSync(path.join(directory, filename));
    }
  }
}

if (require.main === module) run(process.argv.slice(2)).then(report => process.stdout.write(JSON.stringify(report) + '\n')).catch(error => {
  process.stderr.write(/^WHATSAPP_NETWORK_CANARY_FAILED/.test(error.message) ? error.message + '\n' : 'WHATSAPP_NETWORK_CANARY_FAILED stage=validation\n');
  process.exitCode = 1;
});
module.exports = { run, isolatedArchiveClient };
