'use strict';
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { ACCOUNT, BUCKET, KEY_ARN } = require('./s3');
const { unpack, keyFor } = require('./event');
const { inputFor, resultFor, fail, safe } = require('./reader-protocol');
const { sourceRole, identityFor, WRITER_ROLE } = require('./batch');
const READER_ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-audit-prod-reader-role`;
function roles(readerSourceRoleArn, writerSourceRoleArn) {
  sourceRole(readerSourceRoleArn); sourceRole(writerSourceRoleArn);
  if (readerSourceRoleArn === writerSourceRoleArn || [WRITER_ROLE, READER_ROLE].includes(readerSourceRoleArn)
    || writerSourceRoleArn === READER_ROLE) fail('audit_reader_denied');
}
async function readBatch(input, client, signal) {
  inputFor(input); const results = new Array(input.refs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, input.refs.length) }, async () => {
    for (;;) {
      const i = next++; if (i >= input.refs.length) return; const ref = input.refs[i]; let result;
      try {
        result = await client.send(new GetObjectCommand({ Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT, Key: ref.key,
          ...(input.mode === 'confirmed' ? { VersionId: ref.versionId } : {}), ChecksumMode: 'ENABLED' }), { abortSignal: signal });
        if (!Number.isInteger(result.ContentLength) || result.ContentLength < 1 || result.ContentLength > 4096
          || result.ContentType !== 'application/json' || result.ChecksumSHA256 !== Buffer.from(ref.digest, 'hex').toString('base64')
          || result.ServerSideEncryption !== 'aws:kms' || result.SSEKMSKeyId !== KEY_ARN
          || input.mode === 'confirmed' && result.VersionId !== ref.versionId) fail('audit_integrity_invalid');
        const chunks = []; let size = 0;
        for await (const chunk of result.Body) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4096) fail('audit_integrity_invalid'); chunks.push(bytes); }
        if (size !== result.ContentLength) fail('audit_integrity_invalid');
        const body = Buffer.concat(chunks).toString('utf8'); const row = { body, digest: ref.digest };
        unpack(row); if (keyFor(row) !== ref.key) fail('audit_integrity_invalid');
        results[i] = { status: 'verified', receipt: { key: ref.key, digest: ref.digest, versionId: result.VersionId },
          ...(input.mode === 'confirmed' ? { body } : {}) };
      } catch (error) { results[i] = { status: 'error', key: ref.key, digest: ref.digest, error: safe(error) }; }
      finally { result?.Body?.destroy?.(); }
    }
  }));
  return resultFor(input, { version: 1, requestId: input.requestId, mode: input.mode, results });
}
async function isolatedRead(input, settings, api) {
  inputFor(input); roles(settings.readerSourceRoleArn, settings.writerSourceRoleArn);
  identityFor(await api.sourceIdentity(), settings.readerSourceRoleArn);
  const target = await api.assumeReader();
  try { identityFor(await target.identity(), READER_ROLE); return await readBatch(input, target.client, target.signal); }
  finally { target.close(); }
}
module.exports = { READER_ROLE, roles, readBatch, isolatedRead };
