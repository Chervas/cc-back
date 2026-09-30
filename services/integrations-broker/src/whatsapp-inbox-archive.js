'use strict';
const { createHash } = require('node:crypto');
const { PutObjectCommand, HeadObjectCommand, PutObjectTaggingCommand } = require('@aws-sdk/client-s3');
const { BrokerError } = require('./errors');

const BUCKET = 'clinicaclick-whatsapp-inbox-recovery-137819318729-eu-west-3-a';
const ACCOUNT = '137819318729';
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function createInboxArchive({ client, bucket = BUCKET }) {
  if (typeof client?.send !== 'function' || bucket !== BUCKET) throw new BrokerError('invalid_request');
  const writeOnce = async (key, envelope) => {
    if (!Buffer.isBuffer(envelope) || !envelope.length || envelope.length > 5 * 1024 * 1024) {
      throw new BrokerError('invalid_request');
    }
    const hash = createHash('sha256').update(envelope).digest();
    const checksum = hash.toString('base64');
    const metadata = { sha256: hash.toString('hex') };
    try {
      const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: envelope,
        ExpectedBucketOwner: ACCOUNT, IfNoneMatch: '*', ChecksumSHA256: checksum,
        ContentType: 'application/octet-stream', Metadata: metadata }), { abortSignal: AbortSignal.timeout(10000) });
      if (result.ChecksumSHA256 !== checksum) throw new BrokerError('audit_unavailable');
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 412) throw new BrokerError('audit_unavailable');
      try {
        const prior = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key,
          ExpectedBucketOwner: ACCOUNT }), { abortSignal: AbortSignal.timeout(10000) });
        if (prior.Metadata?.sha256 !== metadata.sha256 || prior.ContentLength !== envelope.length) {
          throw new BrokerError('audit_unavailable');
        }
      } catch { throw new BrokerError('audit_unavailable'); }
    }
    return { archived: true };
  };
  return {
    async put(receipt, envelope) {
      if (!UUID.test(receipt)) throw new BrokerError('invalid_request');
      return writeOnce(`v1/${receipt}.json`, envelope);
    },
    async putManifest(manifest, appId) {
      const value = require('./whatsapp-inbox-key').manifest(manifest, appId);
      const envelope = Buffer.from(JSON.stringify(value));
      try { return await writeOnce(`meta/${value.keyId}.json`, envelope); }
      finally { envelope.fill(0); }
    },
    async tagImported(receipt) {
      if (!UUID.test(receipt)) throw new BrokerError('invalid_request');
      try {
        await client.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: `v1/${receipt}.json`,
          ExpectedBucketOwner: ACCOUNT, Tagging: { TagSet: [{ Key: 'clinicaclick-state', Value: 'imported' }] } }),
        { abortSignal: AbortSignal.timeout(10000) });
      } catch { throw new BrokerError('audit_unavailable'); }
      return { tagged: true };
    },
  };
}
function verifyArchiveEnvelope(envelope, cipher, appId) {
  if (!Buffer.isBuffer(envelope) || envelope.length < 1 || envelope.length > 5 * 1024 * 1024
    || typeof cipher?.open !== 'function' || typeof appId !== 'string') throw new BrokerError('invalid_request');
  let record; let raw;
  try {
    record = JSON.parse(envelope.toString('utf8'));
    if (!record || Object.keys(record).sort().join(',') !== 'appId,body,byteCount,digest,keyId,kinds,receipt,receivedAt,scopes,version'
      || record.version !== 1 || record.appId !== appId || !UUID.test(record.receipt)
      || !/^[a-f0-9]{64}$/.test(record.digest) || record.keyId !== cipher.keyId
      || !Number.isSafeInteger(record.receivedAt) || !Number.isSafeInteger(record.byteCount)
      || record.byteCount < 1 || record.byteCount > 3 * 1024 * 1024
      || !Array.isArray(record.scopes) || !Array.isArray(record.kinds)
      || record.scopes.length < 1 || record.kinds.length < 1
      || typeof record.body !== 'string' || record.body.length > 4 * 1024 * 1024 + 100) throw Error();
    const sealed = Buffer.from(record.body, 'base64');
    if (sealed.toString('base64') !== record.body) throw Error();
    const aad = JSON.stringify(['cc-wa-inbox-v1', record.appId, record.receipt, record.keyId,
      record.digest, JSON.stringify(record.scopes), JSON.stringify(record.kinds), record.receivedAt]);
    raw = cipher.open(sealed, aad);
    if (raw.length !== record.byteCount || cipher.digest(appId, raw) !== record.digest) throw Error();
    return { receipt: record.receipt, raw };
  } catch { raw?.fill(0); throw new BrokerError('audit_unavailable'); }
}
module.exports = { BUCKET, createInboxArchive, verifyArchiveEnvelope };
