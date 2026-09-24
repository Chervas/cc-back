'use strict';

const { PutObjectCommand } = require('@aws-sdk/client-s3');
const C = require('./public-media-contract');
const L = require('./public-media-limits');

function createPublicMediaOperations({ client, bucket, baseUrl = 'https://media.clinicaclick.com', expectedBucketOwner, now = () => new Date() }) {
  if (!client?.send || bucket !== 'clinicaclick-public-media-eu-west-3'
    || baseUrl !== 'https://media.clinicaclick.com' || !/^\d{12}$/.test(expectedBucketOwner)) throw new Error('invalid_public_media_configuration');
  return {
    [L.OPERATIONS.PUT_EMAIL_IMAGE]: {
      provider: L.PROVIDER,
      secretless: true,
      validate: C.validate,
      authorize: C.authorize,
      async execute({ requestId, payload, signal, assertActive }) {
        const input = C.validate(payload);
        const body = Buffer.from(input.dataBase64, 'base64');
        const date = now();
        const yyyy = String(date.getUTCFullYear());
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const key = `marketing/email/${input.scopeType}-${input.scopeId}/${yyyy}/${mm}/${requestId}.${C.extension(input.contentType)}`;
        assertActive();
        const response = await client.send(new PutObjectCommand({
          Bucket: bucket,
          ExpectedBucketOwner: expectedBucketOwner,
          Key: key,
          Body: body,
          ContentType: input.contentType,
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: {
            purpose: input.purpose,
            sensitivity: 'public',
            sha256: input.sha256,
            scope: C.scope(input),
          },
          IfNoneMatch: '*',
        }), { abortSignal: signal });
        assertActive();
        return {
          key,
          url: `${baseUrl}/${key}`,
          contentType: input.contentType,
          sizeBytes: body.length,
          sha256: input.sha256,
          etag: response.ETag || null,
        };
      },
      project: C.project,
      completionAudit: () => ['integration.completed', 'success', 'public_media_image_stored'],
    },
  };
}

module.exports = { createPublicMediaOperations };
