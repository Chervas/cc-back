'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ListObjectsV2Command, GetObjectCommand, GetObjectTaggingCommand, S3Client } = require('@aws-sdk/client-s3');
const { KMSClient } = require('@aws-sdk/client-kms');
const { BrokerStore } = require('./store');
const { createWhatsappInbox } = require('./whatsapp-inbox');
const { createInboxKeyProvider } = require('./whatsapp-inbox-key');
const { BUCKET } = require('./whatsapp-inbox-archive');
const { validateScopes, bindingsFor } = require('./whatsapp-inbox-scopes');
const { restoreArchiveBatch } = require('./whatsapp-inbox-restore');

const ACCOUNT = '137819318729';
const APP = '1807844546609897';
const RECEIPT_KEY = /^v1\/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const KEY_ID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function inventory(s3) {
  const keys = [];
  let token;
  const tokens = new Set();
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'v1/',
      ExpectedBucketOwner: ACCOUNT, ...(token ? { ContinuationToken: token } : {}) }));
    if (!Array.isArray(page.Contents) || typeof page.IsTruncated !== 'boolean') throw Error('inventory_invalid');
    for (const object of page.Contents) {
      if (!RECEIPT_KEY.test(object.Key) || typeof object.ETag !== 'string'
        || !Number.isSafeInteger(object.Size) || object.Size < 1 || object.Size > 5 * 1024 * 1024) {
        throw Error('inventory_invalid');
      }
      keys.push({ key: object.Key, etag: object.ETag });
      if (keys.length > 200000) throw Error('inventory_too_large');
    }
    token = page.IsTruncated ? page.NextContinuationToken : null;
    if (page.IsTruncated && (!token || tokens.has(token))) throw Error('inventory_invalid');
    if (token) tokens.add(token);
  } while (token);
  keys.sort((a, b) => a.key.localeCompare(b.key));
  if (keys.some((item, index) => index && item.key === keys[index - 1].key)) throw Error('inventory_duplicate');
  return { keys, digest: createHash('sha256').update(JSON.stringify(keys)).digest('hex') };
}

async function objectBytes(s3, key, maxBytes, etag) {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key,
    ExpectedBucketOwner: ACCOUNT, ...(etag ? { IfMatch: etag } : {}) }));
  if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength < 1
    || result.ContentLength > maxBytes || !result.VersionId || !result.Body?.transformToByteArray) {
    throw Error('archive_object_invalid');
  }
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  if (bytes.length !== result.ContentLength) {
    bytes.fill(0);
    throw Error('archive_object_invalid');
  }
  return { bytes, versionId: result.VersionId };
}

async function objectTagState(s3, key, versionId) {
  const tags = await s3.send(new GetObjectTaggingCommand({ Bucket: BUCKET, Key: key,
    VersionId: versionId, ExpectedBucketOwner: ACCOUNT }));
  if (!Array.isArray(tags.TagSet)) throw Error('archive_tag_invalid');
  const state = tags.TagSet.filter(tag => tag.Key === 'clinicaclick-state');
  if (state.length > 1 || state.length === 1 && state[0].Value !== 'imported') throw Error('archive_tag_invalid');
  return state.length ? 'imported' : 'not_imported';
}

async function restoreFromArchive({ s3, output, scopes, appId = APP, openCipher }) {
  if (!s3?.send || !path.isAbsolute(output) || fs.existsSync(output)
    || appId !== APP || typeof openCipher !== 'function') throw Error('restore_configuration_invalid');
  const config = validateScopes(scopes);
  const bindings = bindingsFor(config);
  const before = await inventory(s3);
  if (!before.keys.length) throw Error('restore_inventory_empty');
  const partial = output + '.incomplete-' + randomUUID();
  const ciphers = new Map();
  const tagStates = [];
  const context = { tenantRef: 'platform:clinicaclick', connectionRef: 'connection:wa-inbox-restore',
    resourceRef: 'wa-inbox:' + appId, policyVersion: 'wa-inbox-restore-v1', operation: 'whatsapp.webhook.restore' };
  let store;
  let count = 0;
  try {
    const first = await objectBytes(s3, before.keys[0].key, 5 * 1024 * 1024, before.keys[0].etag);
    let firstKeyId;
    try { firstKeyId = JSON.parse(first.bytes.toString('utf8')).keyId; }
    finally { first.bytes.fill(0); }
    if (!KEY_ID.test(firstKeyId)) throw Error('archive_key_invalid');
    const firstCipher = await openCipher(firstKeyId);
    if (firstCipher?.keyId !== firstKeyId) {
      firstCipher?.close?.();
      throw Error('archive_key_invalid');
    }
    ciphers.set(firstKeyId, firstCipher);
    store = new BrokerStore(partial);
    createWhatsappInbox({ store, cipher: ciphers.get(firstKeyId), appId, bindings,
      scopeBindings: config, auditContext: context, archiveEnabled: true });
    for (let offset = 0; offset < before.keys.length; offset += 100) {
      const records = [];
      try {
        for (const entry of before.keys.slice(offset, offset + 100)) {
          const object = await objectBytes(s3, entry.key, 5 * 1024 * 1024, entry.etag);
          let retained = false;
          try {
            const tagState = await objectTagState(s3, entry.key, object.versionId);
            const envelope = JSON.parse(object.bytes.toString('utf8'));
            if (!KEY_ID.test(envelope.keyId) || envelope.receipt !== entry.key.slice(3, -5)) {
              throw Error('archive_key_invalid');
            }
            if (!ciphers.has(envelope.keyId)) {
              const cipher = await openCipher(envelope.keyId);
              if (cipher?.keyId !== envelope.keyId) {
                cipher?.close?.();
                throw Error('archive_key_invalid');
              }
              ciphers.set(envelope.keyId, cipher);
            }
            records.push({ envelope: object.bytes, tagState });
            tagStates.push({ key: entry.key, versionId: object.versionId, tagState });
            retained = true;
          } finally { if (!retained) object.bytes.fill(0); }
        }
        count += restoreArchiveBatch({ store, appId, bindings, ciphers, auditContext: context, records }).restored;
      } finally { for (const item of records) item.envelope.fill(0); }
    }
    const after = await inventory(s3);
    if (before.digest !== after.digest || before.keys.length !== after.keys.length || count !== before.keys.length
      || store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n !== count
      || store.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
      throw Error('restore_inventory_changed');
    }
    for (const item of tagStates) {
      if (await objectTagState(s3, item.key, item.versionId) !== item.tagState) {
        throw Error('restore_inventory_changed');
      }
    }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close(); store = null;
    if (fs.existsSync(partial + '-wal') && fs.statSync(partial + '-wal').size) throw Error('restore_checkpoint_failed');
    fs.linkSync(partial, output); // Fails rather than replacing an existing database.
    fs.unlinkSync(partial);
    return { restored: count, inventoryDigest: before.digest };
  } finally {
    store?.close();
    for (const cipher of ciphers.values()) cipher?.close?.();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) throw Error('usage: whatsapp-inbox-restore-command OUTPUT.sqlite SCOPES.json');
  const [output, scopesFile] = argv;
  if (!path.isAbsolute(scopesFile)) throw Error('restore_configuration_invalid');
  const stat = fs.lstatSync(scopesFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1048576) {
    throw Error('restore_configuration_invalid');
  }
  const scopes = JSON.parse(fs.readFileSync(scopesFile, 'utf8'));
  const s3 = new S3Client({ region: 'eu-west-3' });
  const kms = new KMSClient({ region: 'eu-west-3' });
  const provider = createInboxKeyProvider(kms);
  try {
    const result = await restoreFromArchive({ s3, output, scopes,
      openCipher: async keyId => {
        const manifestObject = await objectBytes(s3, 'meta/' + keyId + '.json', 8192);
        try { return await provider.open(JSON.parse(manifestObject.bytes.toString('utf8')), APP); }
        finally { manifestObject.bytes.fill(0); }
      } });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { s3.destroy(); kms.destroy(); }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: /^[a-z_]+$/.test(error?.message) ? error.message : 'restore_failed' }) + '\n');
  process.exitCode = 1;
});

module.exports = { inventory, objectBytes, restoreFromArchive, main };
