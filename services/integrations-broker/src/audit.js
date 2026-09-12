'use strict';

const { randomUUID } = require('node:crypto');
const { audit } = require('./contracts');
const { fail } = require('./errors');
function eventFor(request, principal, policy, action, result, reason, now = Date.now()) {
  return audit({ version: 1, eventId: randomUUID(), occurredAt: new Date(now).toISOString(),
    actorType: 'service', actorId: principal.id, tenantRef: request.tenantRef,
    action, resourceRef: request.assetRef, result, reason,
    correlationId: request.requestId, policyVersion: policy.version });
}
async function drainAudit(store, sink, { limit = 100, now = () => Date.now() } = {}) {
  let delivered = 0; let failed = 0;
  for (let i = 0; i < Math.min(1000, limit); i++) {
    const row = store.claim(now());
    if (!row) break;
    try {
      const receipt = await sink.write(row);
      store.acknowledge(row, receipt, now());
      delivered++;
    } catch { store.retry(row, now()); failed++; }
  }
  return { delivered, failed, ...store.backlog() };
}
function createS3AuditSink({ client, bucket, keyArn }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^arn:aws:kms:eu-west-3:\d{12}:key\/[a-f0-9-]+$/.test(keyArn)) fail('invalid_request');
  return {
    async write(row) {
      const event = audit(JSON.parse(row.event));
      const checksum = Buffer.from(row.digest, 'hex').toString('base64');
      const response = await client.send(new PutObjectCommand({
        Bucket: bucket, Key: `app/v1/${event.occurredAt.slice(0, 10)}/${event.eventId}-${row.digest}.json`,
        Body: row.event, ContentType: 'application/json', ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: keyArn, BucketKeyEnabled: false,
        IfNoneMatch: '*', ChecksumSHA256: checksum,
      }));
      // A lost response/412 is unconfirmed, never silently acknowledged by a writer that cannot read.
      if (!response.VersionId || response.ChecksumSHA256 !== checksum) fail('audit_unavailable');
      return { versionId: response.VersionId, digest: row.digest };
    },
  };
}
module.exports = { eventFor, drainAudit, createS3AuditSink };
