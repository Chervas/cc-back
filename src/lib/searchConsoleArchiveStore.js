'use strict';

// Explicitly injected S3 transport; import/factory creation never loads env,
// credentials, models, an SDK client, or an account-wide storage listing.
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const VERSION = 'clinicaclick-sc-archive-parts/1';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_PART_BYTES = 4 * 1024 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const sha = data => createHash('sha256').update(data).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const need = (test, code) => { if (!test) fail(code); };
const version = value => typeof value === 'string' && value.length <= 1024
  && value.length > 0 && value !== 'null' && !/[\x00-\x20]/.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function createSearchConsoleArchiveStore({ transport, bucket, prefix, expectedBucketOwner, kmsKeyId,
  partBytes = DEFAULT_PART_BYTES, maxTotalBytes = 1024 * 1024 * 1024, maxParts = 256 } = {}) {
  need(transport && typeof transport.putObject === 'function' && typeof transport.getObject === 'function', 'sc_archive_store_transport_required');
  need(typeof bucket === 'string' && /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    && !bucket.includes('..'), 'sc_archive_store_configuration_invalid');
  need(typeof prefix === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,150}\/$/.test(prefix)
    && !prefix.includes('//') && !prefix.includes('..'), 'sc_archive_store_configuration_invalid');
  need(typeof expectedBucketOwner === 'string' && /^\d{12}$/.test(expectedBucketOwner)
    && typeof kmsKeyId === 'string' && new RegExp('^arn:aws:kms:[a-z0-9-]+:' + expectedBucketOwner + ':key/[a-f0-9-]{36}$').test(kmsKeyId), 'sc_archive_store_configuration_invalid');
  need(Number.isSafeInteger(partBytes) && partBytes >= 1024 && partBytes <= MAX_PART_BYTES
    && Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 && maxTotalBytes <= 1024 * 1024 * 1024
    && Number.isSafeInteger(maxParts) && maxParts >= 1 && maxParts <= 4096, 'sc_archive_store_limits_invalid');

  const objectKey = key => {
    need(typeof key === 'string' && /^search-console\/v1\/[a-f0-9]{64}\/20\d{2}-(0[1-9]|1[0-2])\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.ndjson$/.test(key), 'sc_archive_store_key_invalid');
    return prefix + key;
  };
  async function putObject(Key, Body, ContentType) {
    const ChecksumSHA256 = createHash('sha256').update(Body).digest('base64');
    let result;
    try {
      result = await transport.putObject({ Bucket: bucket, Key, Body, ContentLength: Body.length,
        ContentType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId,
        ExpectedBucketOwner: expectedBucketOwner, ChecksumSHA256, IfNoneMatch: '*' });
    } catch { fail('sc_archive_store_put_failed'); }
    need(version(result?.VersionId) && result?.ServerSideEncryption === 'aws:kms'
      && result?.SSEKMSKeyId === kmsKeyId && result?.ChecksumSHA256 === ChecksumSHA256, 'sc_archive_store_write_unverified');
    return { key: Key, versionId: result.VersionId, bytes: Body.length, sha256: sha(Body) };
  }
  async function getObject(reference, byteLimit) {
    need(version(reference?.versionId), 'sc_archive_store_receipt_invalid');
    let result;
    try { result = await transport.getObject({ Bucket: bucket, Key: reference.key, VersionId: reference.versionId,
      ExpectedBucketOwner: expectedBucketOwner, ChecksumMode: 'ENABLED' }); }
    catch { fail('sc_archive_store_read_failed'); }
    const close = () => result?.Body?.destroy?.();
    try {
      need(result?.VersionId === reference.versionId && result?.ServerSideEncryption === 'aws:kms'
        && result?.SSEKMSKeyId === kmsKeyId && result?.ContentLength === reference.bytes
        && reference.bytes <= byteLimit, 'sc_archive_store_read_unverified');
      need(Buffer.isBuffer(result.Body) || result.Body instanceof Uint8Array
        || typeof result.Body?.[Symbol.asyncIterator] === 'function', 'sc_archive_store_body_invalid');
      return { result, close };
    } catch (error) { close(); throw error; }
  }
  async function collect(reference, limit) {
    const { result, close } = await getObject(reference, limit);
    const parts = []; let size = 0;
    try {
      const body = Buffer.isBuffer(result.Body) || result.Body instanceof Uint8Array ? [result.Body] : result.Body;
      for await (const chunk of body) {
        need(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array, 'sc_archive_store_body_invalid');
        size += chunk.byteLength;
        need(size <= reference.bytes && size <= limit, 'sc_archive_store_read_bound');
        parts.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(parts);
      need(size === reference.bytes && sha(data) === reference.sha256, 'sc_archive_store_digest_mismatch');
      return data;
    } catch (error) {
      if (error?.code?.startsWith('sc_archive_store_')) throw error;
      fail('sc_archive_store_read_failed');
    } finally { close(); }
  }

  async function put({ key, body, contentType } = {}) {
    const rootKey = objectKey(key);
    need(contentType === 'application/x-ndjson' && typeof body?.[Symbol.asyncIterator] === 'function', 'sc_archive_store_input_invalid');
    const parts = [], digest = createHash('sha256'); let pending = Buffer.alloc(0), bytes = 0;
    async function write(data) {
      need(parts.length < maxParts, 'sc_archive_store_part_bound');
      parts.push(await putObject(rootKey + '/part-' + String(parts.length).padStart(6, '0'), data, 'application/octet-stream'));
    }
    try {
      for await (const chunk of body) {
        need(typeof chunk === 'string' || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array, 'sc_archive_store_input_invalid');
        const data = Buffer.from(chunk);
        need(data.length <= MAX_PART_BYTES, 'sc_archive_store_input_bound');
        bytes += data.length; need(bytes <= maxTotalBytes, 'sc_archive_store_total_bound'); digest.update(data);
        let at = 0;
        while (at < data.length) {
          const length = Math.min(partBytes - pending.length, data.length - at);
          pending = Buffer.concat([pending, data.subarray(at, at + length)]); at += length;
          if (pending.length === partBytes) { await write(pending); pending = Buffer.alloc(0); }
        }
      }
      if (pending.length) await write(pending);
    } catch (error) {
      // Already written immutable objects are retained, never removed by a
      // catch-all cleanup. No manifest/receipt is published for partial writes.
      if (error?.code?.startsWith('sc_archive_store_')) throw error;
      fail('sc_archive_store_source_failed');
    }
    need(bytes > 0, 'sc_archive_store_input_invalid');
    const manifest = { schema: VERSION, logicalKey: key, bytes, sha256: digest.digest('hex'), parts };
    const encoded = Buffer.from(JSON.stringify(manifest));
    need(encoded.length <= MAX_MANIFEST_BYTES, 'sc_archive_store_manifest_bound');
    const published = await putObject(rootKey + '/manifest.json', encoded, 'application/json');
    return Object.freeze({ schema: VERSION, logicalKey: key, manifest: published, bytes, sha256: manifest.sha256 });
  }

  async function read(receipt) {
    need(exact(receipt, ['schema', 'logicalKey', 'manifest', 'bytes', 'sha256']) && receipt.schema === VERSION,
      'sc_archive_store_receipt_invalid');
    const rootKey = objectKey(receipt.logicalKey);
    need(exact(receipt.manifest, ['key', 'versionId', 'bytes', 'sha256']) && receipt.manifest.key === rootKey + '/manifest.json'
      && Number.isSafeInteger(receipt.manifest.bytes) && receipt.manifest.bytes > 0
      && /^[a-f0-9]{64}$/.test(receipt.manifest.sha256), 'sc_archive_store_receipt_invalid');
    need(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= maxTotalBytes
      && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256), 'sc_archive_store_receipt_invalid');
    // Capture trusted fields once; a caller cannot mutate its receipt while a
    // network await is in progress and retarget a later object read.
    const pinned = JSON.parse(JSON.stringify(receipt));
    const data = await collect(pinned.manifest, MAX_MANIFEST_BYTES);
    let manifest; try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { fail('sc_archive_store_manifest_invalid'); }
    need(exact(manifest, ['schema', 'logicalKey', 'bytes', 'sha256', 'parts']) && manifest.schema === VERSION
      && manifest.logicalKey === pinned.logicalKey && manifest.bytes === pinned.bytes && manifest.sha256 === pinned.sha256
      && Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length <= maxParts, 'sc_archive_store_manifest_invalid');
    let sum = 0;
    for (const [i, part] of manifest.parts.entries()) {
      need(exact(part, ['key', 'versionId', 'bytes', 'sha256']) && part.key === rootKey + '/part-' + String(i).padStart(6, '0')
        && version(part.versionId) && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= partBytes
        && typeof part.sha256 === 'string' && /^[a-f0-9]{64}$/.test(part.sha256), 'sc_archive_store_manifest_invalid');
      sum += part.bytes;
    }
    need(sum === pinned.bytes, 'sc_archive_store_manifest_invalid');
    return (async function* () {
      const digest = createHash('sha256');
      for (const part of manifest.parts) {
        const chunk = await collect(part, partBytes); digest.update(chunk);
        // Object size and consumer chunk size are different contracts. Keep
        // the verifier's 1MiB input bound even with the default 4MiB objects.
        for (let at = 0; at < chunk.length; at += 1024 * 1024) yield chunk.subarray(at, at + 1024 * 1024);
      }
      need(digest.digest('hex') === pinned.sha256, 'sc_archive_store_digest_mismatch');
    })();
  }
  return Object.freeze({ independent: true, put, read });
}

// No SDK client or credentials are constructed here. A future operator supplies
// its approved, account/region-specific client after storage qualification.
function s3ArchiveTransport(client) {
  need(client && typeof client.send === 'function', 'sc_archive_store_transport_required');
  const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  return {
    putObject: input => {
      need(input?.IfNoneMatch === '*', 'sc_archive_store_precondition_required');
      const command = new PutObjectCommand(input);
      // The installed/pinned SDK 3.600.0 predates PutObject.IfNoneMatch and
      // otherwise drops this field during serialization. Add the standard HTTP
      // precondition before signing, on this command alone, without mutating a
      // shared client or changing the dependency lock.
      command.middlewareStack.add(next => async args => {
        need(args.request?.headers, 'sc_archive_store_precondition_required');
        args.request.headers['if-none-match'] = '*';
        return next(args);
      }, { step: 'build', name: 'scArchiveNoOverwrite' });
      return client.send(command);
    },
    getObject: input => client.send(new GetObjectCommand(input)),
  };
}
module.exports = { createSearchConsoleArchiveStore, s3ArchiveTransport };
