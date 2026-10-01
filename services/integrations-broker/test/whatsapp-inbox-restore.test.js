'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { BrokerStore } = require('../src/store');
const { createInboxCipher, createWhatsappInbox } = require('../src/whatsapp-inbox');
const { restoreArchiveBatch } = require('../src/whatsapp-inbox-restore');
const { restoreFromArchive } = require('../src/whatsapp-inbox-restore-command');

const appId = '1807844546609897';
const bindings = [{ wabaId: '301', phoneIds: ['401'] }];
const auditContext = { tenantRef: 'clinic:71', connectionRef: 'connection:wa-inbox-qa',
  resourceRef: 'wa-inbox:' + appId, policyVersion: 'wa-inbox-qa-v1', operation: 'whatsapp.webhook.capture' };
const secret = Buffer.from('FICTITIOUS_APP_SECRET_FOR_INBOX_RESTORE_QA');
function signed(content) {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '301',
    changes: [{ field: 'messages', value: { metadata: { phone_number_id: '401' },
      messages: [{ id: 'wamid.synthetic_' + content, from: '34000000001',
        timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: content } }] } }] }] }));
  return { raw, appSecret: secret,
    signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wa-inbox-restore-'));
  const key = randomBytes(32);
  const cipher = createInboxCipher({ key, keyId: randomUUID() });
  const source = new BrokerStore(path.join(dir, 'source.sqlite'));
  const sourceInbox = createWhatsappInbox({ store: source, cipher, appId, bindings,
    auditContext, archiveEnabled: true });
  const openDestination = name => {
    const store = new BrokerStore(path.join(dir, name + '.sqlite'));
    const inbox = createWhatsappInbox({ store, cipher, appId, bindings,
      auditContext, archiveEnabled: true });
    t.after(() => store.close());
    return { store, inbox };
  };
  t.after(() => { source.close(); cipher.close(); key.fill(0);
    fs.rmSync(dir, { recursive: true, force: true }); });
  return { source, sourceInbox, cipher, openDestination, dir };
}

test('a lost inbox is restored from verified encrypted objects without retrospective automation', async t => {
  const f = fixture(t);
  const archived = new Map();
  const inputs = ['synthetic_held', 'synthetic_imported', 'synthetic_ack_without_tag'].map(signed);
  const receipts = inputs.map(input => f.sourceInbox.accept(input).receipt);
  for (const receipt of receipts) {
    await f.sourceInbox.archive(receipt, { async put(id, envelope) {
      archived.set(id, Buffer.from(envelope));
    } });
  }
  for (const receipt of receipts.slice(1)) {
    const lease = f.sourceInbox.lease(receipt);
    f.sourceInbox.confirm({ receipt, lease: lease.lease, importReceipt: randomUUID() });
    lease.raw.fill(0);
  }
  await f.sourceInbox.tagImported(receipts[1], { async tagImported() {} });

  const target = f.openDestination('replacement');
  const records = receipts.map((receipt, index) => ({ envelope: archived.get(receipt),
    tagState: index === 1 ? 'imported' : 'not_imported' }));
  const args = { store: target.store, appId, bindings,
    ciphers: new Map([[f.cipher.keyId, f.cipher]]), auditContext, records };
  assert.deepEqual(restoreArchiveBatch(args), { restored: 3, replayed: 0 });
  assert.deepEqual(restoreArchiveBatch(args), { restored: 0, replayed: 3 });
  assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 3);
  assert.equal(target.store.backlog().pending, 1);
  assert.equal(target.inbox.accept(inputs[1]).businessProcessed, true);
  assert.equal(target.inbox.accept(inputs[2]).businessProcessed, false);
  assert.equal(target.inbox.health().archive.pending, 0);
  assert.equal(target.inbox.health().archive.untaggedImported, 0);
  for (const receipt of [receipts[0], receipts[2]]) {
    const lease = target.inbox.lease(receipt);
    assert.equal(lease.automaticActionsAllowed, false);
    assert.equal(lease.recoveryWithoutAutomation, true);
    lease.raw.fill(0);
  }
  const sqlite = fs.readFileSync(path.join(f.dir, 'replacement.sqlite'));
  for (const input of inputs) assert(!sqlite.includes(input.raw));
  for (const content of ['synthetic_held', 'synthetic_imported', 'synthetic_ack_without_tag']) {
    assert(!sqlite.includes(Buffer.from(content)));
  }
  assert.throws(() => restoreArchiveBatch({ ...args, store: f.source }), { code: 'scope_denied' });
});

test('a corrupt or foreign archive fails before any receipt is restored', async t => {
  const f = fixture(t);
  const received = f.sourceInbox.accept(signed('synthetic_batch_guard'));
  let envelope;
  await f.sourceInbox.archive(received.receipt, { async put(_id, value) { envelope = Buffer.from(value); } });
  const tampered = JSON.parse(envelope.toString('utf8'));
  tampered.scopes = ['301:999'];
  const target = f.openDestination('rejected');
  const args = { store: target.store, appId, bindings,
    ciphers: new Map([[f.cipher.keyId, f.cipher]]), auditContext };
  assert.throws(() => restoreArchiveBatch({ ...args, records: [
    { envelope, tagState: 'not_imported' },
    { envelope: Buffer.from(JSON.stringify(tampered)), tagState: 'not_imported' },
  ] }), { code: 'audit_unavailable' });
  assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 0);
  assert.throws(() => restoreArchiveBatch({ ...args, records: [
    { envelope, tagState: 'not_imported' },
  ], ciphers: new Map() }), { code: 'audit_unavailable' });
  assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 0);
  assert.throws(() => restoreArchiveBatch({ ...args, records: [
    { envelope, tagState: 'not_imported' },
    { envelope, tagState: 'imported' },
  ] }), { code: 'idempotency_conflict' });
  assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 0);
});

test('offline inventory restores only S3-tagged imports and publishes no partial output', async t => {
  const f = fixture(t);
  const objects = new Map();
  const ids = ['synthetic_inventory_held', 'synthetic_inventory_imported'].map(content =>
    f.sourceInbox.accept(signed(content)).receipt);
  for (const id of ids) await f.sourceInbox.archive(id, { async put(receipt, envelope) {
    objects.set('v1/' + receipt + '.json', Buffer.from(envelope));
  } });
  const importedLease = f.sourceInbox.lease(ids[1]);
  f.sourceInbox.confirm({ receipt: ids[1], lease: importedLease.lease, importReceipt: randomUUID() });
  importedLease.raw.fill(0);
  await f.sourceInbox.tagImported(ids[1], { async tagImported() {} });
  let lists = 0;
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') {
      lists++;
      return { IsTruncated: false, Contents: [...objects].map(([Key, value]) =>
        ({ Key, ETag: '"synthetic-etag"', Size: value.length })) };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      const value = objects.get(command.input.Key);
      assert(value); assert.equal(command.input.IfMatch, '"synthetic-etag"');
      return { ContentLength: value.length, VersionId: 'synthetic-version',
        Body: { transformToByteArray: async () => Uint8Array.from(value) } };
    }
    if (command.constructor.name === 'GetObjectTaggingCommand') {
      assert.equal(command.input.VersionId, 'synthetic-version');
      return { TagSet: [{ Key: 'clinicaclick-state', Value: 'imported' }].filter(() =>
        command.input.Key === 'v1/' + ids[1] + '.json') };
    }
    throw Error('unexpected_command');
  } };
  const output = path.join(f.dir, 'completed.sqlite');
  const result = await restoreFromArchive({ s3, output, appId,
    scopes: [{ wabaId: '301', phoneId: '401', clinicIds: [71] }],
    openCipher: async keyId => { assert.equal(keyId, f.cipher.keyId); return f.cipher; } });
  assert.equal(result.restored, 2);
  assert.equal(lists, 2);
  assert.equal(fs.statSync(output).mode & 0o077, 0);
  const reopened = new BrokerStore(output);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='held' AND restored_at IS NOT NULL").get().n, 1);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported' AND archive_tagged_at IS NOT NULL").get().n, 1);
  reopened.close();
  assert(!fs.readdirSync(f.dir).some(name => name.includes('.incomplete-')));
});

test('a tag change during the offline inventory leaves the final database unpublished', async t => {
  const f = fixture(t);
  const received = f.sourceInbox.accept(signed('synthetic_tag_race'));
  let envelope;
  await f.sourceInbox.archive(received.receipt, { async put(_id, body) { envelope = Buffer.from(body); } });
  let reads = 0;
  const key = 'v1/' + received.receipt + '.json';
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') return {
      IsTruncated: false, Contents: [{ Key: key, ETag: '"synthetic-etag"', Size: envelope.length }],
    };
    if (command.constructor.name === 'GetObjectCommand') return {
      ContentLength: envelope.length, VersionId: 'synthetic-version',
      Body: { transformToByteArray: async () => Uint8Array.from(envelope) },
    };
    if (command.constructor.name === 'GetObjectTaggingCommand') return {
      TagSet: ++reads === 1 ? [] : [{ Key: 'clinicaclick-state', Value: 'imported' }],
    };
    throw Error('unexpected_command');
  } };
  const output = path.join(f.dir, 'must-not-publish.sqlite');
  await assert.rejects(restoreFromArchive({ s3, output, appId,
    scopes: [{ wabaId: '301', phoneId: '401', clinicIds: [71] }],
    openCipher: async () => f.cipher }), /restore_inventory_changed/);
  assert.equal(reads, 2);
  assert.equal(fs.existsSync(output), false);
  assert(!fs.readdirSync(f.dir).some(name => name.startsWith('must-not-publish.sqlite.incomplete-')));
});
