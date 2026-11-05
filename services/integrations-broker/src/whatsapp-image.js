'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = Math.ceil(MAX_BYTES / 3) * 4 + 32768;
function decode(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)
    || Object.keys(image).some(k => !['base64','mime_type','sha256','caption'].includes(k))
    || !['image/jpeg','image/png'].includes(image.mime_type)
    || typeof image.base64 !== 'string' || image.base64.length > Math.ceil(MAX_BYTES / 3) * 4
    || image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)
    || !/^[a-f0-9]{64}$/.test(image.sha256)
    || image.caption !== undefined && (typeof image.caption !== 'string' || [...image.caption].length > 1024)) fail('invalid_request');
  const buffer = Buffer.from(image.base64, 'base64');
  const type = buffer.subarray(0,3).equals(Buffer.from([255,216,255])) ? 'image/jpeg'
    : buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : null;
  if (!buffer.length || buffer.length > MAX_BYTES || type !== image.mime_type
    || buffer.toString('base64') !== image.base64 || createHash('sha256').update(buffer).digest('hex') !== image.sha256) {
    buffer.fill(0); fail('invalid_request');
  }
  return buffer;
}
function validate(image) { const buffer = decode(image); buffer.fill(0); return image; }
module.exports = { MAX_BYTES, MAX_REQUEST_BYTES, decode, validate,
  MAX_CONCURRENT_REQUESTS: 32, MAX_PENDING_REQUEST_BYTES: 2 * MAX_REQUEST_BYTES,
  MAX_TIMEOUT_MS: 30000 };
