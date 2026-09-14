'use strict';
// Explicit operational canary: synthetic data only, no Meta/Secrets Manager,
// listeners, clinical DB, queues, subscription changes or automatic retries.
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { KMSClient } = require('@aws-sdk/client-kms');
const { S3Client } = require('@aws-sdk/client-s3');
const { fromInstanceMetadata, fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { createInboxKeyProvider } = require('./whatsapp-inbox-key');
const { createWhatsappInbox } = require('./whatsapp-inbox'); const { BrokerStore } = require('./store');
const { drainAudit, createS3AuditSink } = require('./audit');
const ACCOUNT = '137819318729'; const REGION = 'eu-west-3';
const SOURCE = `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-integrations-prod-ec2-role/i-0cf40cfe823f160fa`;
const ROOT = '/var/lib/clinicaclick-whatsapp-canary';
function durable(filename, body) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(body) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
async function run(args) {
  if (args.length !== 3 || args[0] !== '--synthetic-only' || !['prepare','resume'].includes(args[1])
    || !/^[a-z0-9-]{1,80}$/.test(args[2]) || process.getuid() !== 0 || process.versions.node.split('.')[0] !== '24'
    || process.env.AWS_CONFIG_FILE !== '/dev/null' || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null'
    || process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true') throw Error('invalid_canary_invocation');
  const directory = path.join(ROOT, args[2]); let stage = 'identity'; let store; let cipher; const clients = [];
  const config = (credentials, service) => ({ region: REGION, credentials, maxAttempts: 1,
    endpoint: `https://${service}.${REGION}.amazonaws.com`,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true }) });
  const client = value => { clients.push(value); return value; };
  try {
    const credentials = fromInstanceMetadata({ timeout: 1500, maxRetries: 0, ec2MetadataV1Disabled: true });
    const identity = await client(new STSClient(config(credentials, 'sts'))).send(new GetCallerIdentityCommand({}));
    assert.equal(identity.Account, ACCOUNT); assert.equal(identity.Arn, SOURCE);
    stage = 'private_state';
    if (args[1] === 'prepare') { fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); fs.mkdirSync(directory, { mode: 0o700 }); }
    assert.equal(fs.realpathSync(directory), directory); assert.equal(fs.statSync(directory).mode & 0o077, 0);
    const provider = createInboxKeyProvider(client(new KMSClient(config(credentials, 'kms'))));
    const manifestFile = path.join(directory, 'key.json');
    if (args[1] === 'prepare') { stage = 'kms_generate'; durable(manifestFile, await provider.prepare('101')); }
    stage = 'kms_decrypt'; cipher = await provider.open(JSON.parse(fs.readFileSync(manifestFile)), '101');
    store = new BrokerStore(path.join(directory, 'inbox.sqlite'));
    const inbox = createWhatsappInbox({ store, cipher, appId: '101', bindings: [{ wabaId: '301', phoneIds: ['401'] }],
      auditContext: { tenantRef: 'qa:whatsapp-inbox', resourceRef: 'qa:whatsapp-inbox-101',
        connectionRef: 'qa:whatsapp-inbox', policyVersion: 'qa-whatsapp-inbox-v1', operation: 'whatsapp.webhook.capture' } });
    const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '301', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '401' }, messages: [{ id: 'synthetic-message', from: '34000000001', text: { body: 'SYNTHETIC_WHATSAPP_INBOX_CANARY' } }] } }] }] }));
    const appSecret = Buffer.from('SYNTHETIC_APP_SECRET_FOR_AWS_CANARY');
    const packet = { raw, appSecret, signature: 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') };
    stage = 'persist'; const result = inbox.accept(packet);
    if (args[1] === 'prepare') {
      assert.equal(result.replayed, false); assert.equal(result.businessProcessed, false);
      durable(path.join(directory, 'receipt.json'), { receipt: result.receipt });
    } else {
      assert.equal(result.receipt, JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'))).receipt);
      assert.equal(result.replayed, true); assert.equal(result.businessProcessed, false);
      stage = 'import_lease'; const lease = inbox.lease(result.receipt);
      try { assert(lease.raw.equals(raw)); assert.equal(lease.automaticActionsAllowed, false); }
      finally { lease.raw.fill(0); }
      inbox.confirm({ receipt: result.receipt, lease: lease.lease, importReceipt: randomUUID() });
      assert.equal(inbox.accept(packet).businessProcessed, true);
    }
    raw.fill(0); appSecret.fill(0);
    stage = 'writer_identity';
    const writer = fromTemporaryCredentials({ masterCredentials: credentials, params: {
      RoleArn: `arn:aws:iam::${ACCOUNT}:role/clinicaclick-audit-prod-writer-role`,
      RoleSessionName: 'clinicaclick-wa-inbox-canary', DurationSeconds: 900 }, clientConfig: config(credentials, 'sts') });
    const writerIdentity = await client(new STSClient(config(writer, 'sts'))).send(new GetCallerIdentityCommand({}));
    assert.equal(writerIdentity.Arn, `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-audit-prod-writer-role/clinicaclick-wa-inbox-canary`);
    const sink = createS3AuditSink({ client: client(new S3Client(config(writer, 's3'))),
      bucket: 'clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu', expectedBucketOwner: ACCOUNT,
      keyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a` });
    stage = 'audit_delivery'; const delivery = await drainAudit(store, sink, { limit: 2 });
    assert.equal(delivery.failed, 0); assert.equal(delivery.pending, 0); assert(delivery.delivered > 0);
    durable(path.join(directory, args[1] + '-result.json'), { status: 'synthetic_canary_passed', phase: args[1],
      at: new Date().toISOString(), receipt: result.receipt, delivery, account: ACCOUNT });
    return { status: 'synthetic_canary_passed', phase: args[1], account: ACCOUNT,
      encryptedStorage: true, restartVerified: args[1] === 'resume', auditDelivered: delivery.delivered,
      pendingAudit: delivery.pending, metaCalled: false, clinicalData: false, operationalListener: false };
  } catch (error) {
    const category = ['AccessDeniedException','AccessDenied','UnrecognizedClientException'].includes(error.name) ? 'access_denied' : 'step_failed';
    throw Error(`WHATSAPP_INBOX_CANARY_FAILED stage=${stage} reason=${category}; preserve partial files; no automatic retry`);
  } finally { cipher?.close(); store?.close(); clients.forEach(c => c.destroy()); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(/^WHATSAPP_INBOX_CANARY_FAILED/.test(error.message) ? error.message + '\n' : 'WHATSAPP_INBOX_CANARY_FAILED stage=validation\n'); process.exitCode = 1;
});
module.exports = { run };
