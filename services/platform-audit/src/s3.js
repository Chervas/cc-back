'use strict';
const { unpack, keyFor, receiptFor, fail } = require('./event');
const ACCOUNT = '137819318729';
const BUCKET = 'clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu';
const KEY_ARN = 'arn:aws:kms:eu-west-3:137819318729:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a';
// Factories accept already isolated clients. No default credentials, SDK bootstrap, reader escalation or generic bucket input.
function createWriter(client, { signal } = {}) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  return {
    async write(row) {
      unpack(row); const key = keyFor(row); const checksum = Buffer.from(row.digest, 'hex').toString('base64');
      let result;
      try {
        result = await client.send(new PutObjectCommand({ Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT, Key: key,
          Body: row.body, ContentType: 'application/json', IfNoneMatch: '*', ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: KEY_ARN, BucketKeyEnabled: false, ChecksumSHA256: checksum }), { abortSignal: signal });
      } catch (error) {
        fail(error?.$metadata?.httpStatusCode === 412 || error?.name === 'PreconditionFailed'
          ? 'audit_reconciliation_required' : 'audit_unavailable');
      }
      if (result.ChecksumSHA256 !== checksum || result.ServerSideEncryption !== 'aws:kms'
        || result.SSEKMSKeyId !== KEY_ARN) fail('audit_reconciliation_required');
      try { return receiptFor(row, { key, digest: row.digest, versionId: result.VersionId }); }
      catch { fail('audit_reconciliation_required'); }
    },
  };
}
function createReconciler(readerClient) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  return {
    async write(row) {
      unpack(row); const key = keyFor(row);
      let result;
      try { result = await readerClient.send(new GetObjectCommand({ Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT,
        Key: key, ChecksumMode: 'ENABLED' })); }
      catch { fail('audit_unavailable'); }
      const checksum = Buffer.from(row.digest, 'hex').toString('base64');
      let body = Buffer.alloc(0);
      try {
        if (result.ContentLength !== Buffer.byteLength(row.body) || result.ChecksumSHA256 !== checksum
          || result.ServerSideEncryption !== 'aws:kms' || result.SSEKMSKeyId !== KEY_ARN) fail('audit_integrity_invalid');
        for await (const chunk of result.Body) {
          const part = Buffer.from(chunk); if (body.length + part.length > 4096) fail('audit_integrity_invalid');
          body = Buffer.concat([body, part]);
        }
        if (!body.equals(Buffer.from(row.body))) fail('audit_integrity_invalid');
        return receiptFor(row, { key, digest: row.digest, versionId: result.VersionId });
      } catch (error) { fail(error?.code === 'audit_integrity_invalid' ? error.code : 'audit_unavailable'); }
      finally { result.Body?.destroy?.(); }
    },
  };
}
module.exports = { createWriter, createReconciler, ACCOUNT, BUCKET, KEY_ARN };
