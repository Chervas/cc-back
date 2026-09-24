'use strict';

const { createHash } = require('node:crypto');
const { schema } = require('./contracts');
const { fail } = require('./errors');
const L = require('./public-media-limits');

const MAX_BASE64_LENGTH = Math.ceil(L.MAX_RAW_BYTES / 3) * 4;
const validateShape = schema({
  scopeType: { enum: ['clinic', 'group', 'catalog'] },
  scopeId: { type: 'integer', minimum: 1, maximum: 2147483647 },
  purpose: { const: 'marketing_image' },
  contentType: { enum: ['image/jpeg', 'image/png', 'image/webp'] },
  dataBase64: { type: 'string', minLength: 4, maxLength: MAX_BASE64_LENGTH, pattern: '^[A-Za-z0-9+/]+={0,2}$' },
  sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
});

function signatureMatches(contentType, buffer) {
  if (contentType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (contentType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function scope(payload) {
  return `${payload.scopeType}:${payload.scopeId}`;
}

function asset(payload) {
  return `public-media:${scope(payload)}`;
}

function validate(value) {
  const payload = validateShape(value);
  const buffer = Buffer.from(payload.dataBase64, 'base64');
  if (!buffer.length || buffer.length > L.MAX_RAW_BYTES
    || buffer.toString('base64') !== payload.dataBase64
    || createHash('sha256').update(buffer).digest('hex') !== payload.sha256
    || !signatureMatches(payload.contentType, buffer)) fail('invalid_request');
  return payload;
}

function authorize({ request }) {
  const payload = validate(request.payload);
  if (request.tenantRef !== scope(payload) || request.assetRef !== asset(payload)) fail('scope_denied');
}

function extension(contentType) {
  return contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'webp';
}

function project(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^marketing\/email\/(?:clinic|group|catalog)-[1-9][0-9]*\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(value.key)
    || !/^https:\/\/media\.clinicaclick\.com\//.test(value.url)
    || !['image/jpeg', 'image/png', 'image/webp'].includes(value.contentType)
    || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > L.MAX_RAW_BYTES
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || value.etag !== null && typeof value.etag !== 'string') fail('provider_failed');
  return {
    key: value.key,
    url: value.url,
    contentType: value.contentType,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    etag: value.etag,
    cacheControl: 'public, max-age=31536000, immutable',
  };
}

module.exports = { MAX_BASE64_LENGTH, asset, authorize, extension, project, scope, signatureMatches, validate };
