'use strict';

const OPERATIONS = Object.freeze({
  PUT_EMAIL_IMAGE: 'storage.public-media.email-image.put.v1',
});

const MAX_RAW_BYTES = 8 * 1024 * 1024;

module.exports = Object.freeze({
  OPERATIONS,
  PROVIDER: 'aws_s3_public_media',
  REGION: 'eu-west-3',
  MAX_RAW_BYTES,
  MAX_REQUEST_BYTES: 12 * 1024 * 1024,
  MAX_RESPONSE_BYTES: 8192,
  MAX_CONCURRENT_REQUESTS: 2,
  MAX_PENDING_REQUEST_BYTES: 24 * 1024 * 1024,
  MAX_TIMEOUT_MS: 30000,
  MAX_PROVIDER_TIMEOUT_MS: 20000,
  isPublicMediaOperation: operation => Object.values(OPERATIONS).includes(operation),
});
