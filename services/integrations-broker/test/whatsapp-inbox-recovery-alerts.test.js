'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { S3Client } = require('@aws-sdk/client-s3');
const { BrokerStore } = require('../src/store');
const { createInboxCipher, createWhatsappInbox } = require('../src/whatsapp-inbox');
const { createInboxArchive } = require('../src/whatsapp-inbox-archive');
const { createWhatsappInboxHandler } = require('../src/whatsapp-inbox-http');
const { collect } = require('../../../src/lib/whatsappReceptionAlerts');
const network = require('./offline-guard.cjs');

test('S3 transport failure produces a retryable webhook and a CRM alert, then recovers once without releasing an untagged receipt', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wa-recovery-alert-'));
  fs.chmodSync(directory, 0o700);
  const key = randomBytes(32);
  const appSecret = Buffer.from('FICTITIOUS_RECOVERY_ALERT_APP_SECRET');
  const store = new BrokerStore(path.join(directory, 'inbox.sqlite'));
  const cipher = createInboxCipher({ key, keyId: 'synthetic-alert-key' });
  let now = Date.now();
  const inbox = createWhatsappInbox({ store, cipher, appId: '101', archiveEnabled: true,
    bindings: [{ wabaId: '301', phoneIds: ['401'] }], now: () => now,
    auditContext: { tenantRef: 'clinic:71', connectionRef: 'connection:wa-inbox-qa',
      resourceRef: 'wa-inbox:101', policyVersion: 'wa-inbox-qa-v1', operation: 'whatsapp.webhook.capture' } });
  let available = false;
  let tagAvailable = false;
  let copies = 0;
  const storage = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const payload = Buffer.concat(chunks);
      assert(!payload.includes(Buffer.from('FICTITIOUS_PATIENT_RESPONSE')));
      const tagging = request.url.includes('tagging');
      if (!(tagging ? tagAvailable : available)) {
        response.writeHead(503, { 'content-type': 'application/xml' });
        response.end('<Error><Code>ServiceUnavailable</Code></Error>');
      } else {
        if (!tagging) copies++;
        response.writeHead(200, tagging ? {} : { 'x-amz-checksum-sha256': request.headers['x-amz-checksum-sha256'] });
        response.end();
      }
      payload.fill(0);
    });
  });
  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
  network.allowPort(storage.address().port);
  const s3 = new S3Client({ endpoint: 'http://127.0.0.1:' + storage.address().port,
    region: 'eu-west-3', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'FICTITIOUS_ACCESS_KEY', secretAccessKey: 'FICTITIOUS_SECRET_KEY' } });
  const archive = createInboxArchive({ client: s3 });
  const receiver = http.createServer(createWhatsappInboxHandler({ inbox, archive,
    withApplicationSecret: work => work(appSecret) }));
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  network.allowPort(receiver.address().port);
  t.after(async () => {
    s3.destroy();
    for (const server of [receiver, storage]) {
      network.removePort(server.address().port);
      await new Promise(resolve => server.close(resolve));
    }
    cipher.close(); store.close(); key.fill(0); appSecret.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '301',
    changes: [{ field: 'messages', value: { metadata: { phone_number_id: '401' },
      messages: [{ id: 'wamid.synthetic', from: '34000000001', type: 'text',
        timestamp: String(Math.floor(now / 1000)), text: { body: 'FICTITIOUS_PATIENT_RESPONSE' } }] } }] }] }));
  t.after(() => raw.fill(0));
  const send = () => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: receiver.address().port,
      method: 'POST', agent: false, headers: { 'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(raw);
  });
  const alerts = () => {
    const current = inbox.health();
    return collect({ snapshot: { version: 1, observedAt: current.observedAt, clinics: [],
      capacity: current.capacity, archive: current.archive }, bindings: [], now,
    query: async () => { throw Error('unexpected_clinical_query'); } });
  };

  assert.equal(await send(), 503);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 1);
  assert.deepEqual(await alerts(), []);
  now += 121000;
  const failure = await alerts();
  assert.equal(failure.length, 1);
  assert.equal(failure[0].eventKey, 'whatsapp.inbox_archive_delayed');
  assert.equal(failure[0].metadata.failed_archive, 1);
  assert.doesNotMatch(JSON.stringify(failure), /FICTITIOUS_PATIENT_RESPONSE|34000000001|wamid/);

  available = true;
  assert.equal(await send(), 200);
  assert.equal(await send(), 200);
  assert.equal(copies, 1);
  assert.deepEqual(await alerts(), []);
  const row = store.db.prepare('SELECT receipt FROM whatsapp_inbox').get();
  const lease = inbox.lease(row.receipt);
  lease.raw.fill(0);
  inbox.confirm({ receipt: row.receipt, lease: lease.lease, importReceipt: randomUUID() });
  await assert.rejects(inbox.tagImported(row.receipt, archive), { code: 'audit_unavailable' });
  now += 25 * 3600000;
  assert.equal(inbox.maintain().released, 0);
  assert.equal((await alerts())[0].metadata.failed_tag, 1);
  tagAvailable = true;
  await inbox.tagImported(row.receipt, archive);
  assert.equal(inbox.maintain().released, 1);
  assert.deepEqual(await alerts(), []);
  assert.equal(await send(), 200);
  assert.equal(copies, 1);
});
