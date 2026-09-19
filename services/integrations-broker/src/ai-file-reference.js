'use strict';
const crypto = require('node:crypto');
const PREFIX = '/api/ai-file-transfers/v1/';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TTL_MS = 300000;
const PURPOSES = ['accounting_ocr', 'whatsapp_audio'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
function exact(value, keys) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin) fail('invalid_request');
    return value;
  } catch { fail('invalid_request'); }
}
function upload(value) {
  if (!exact(value, ['useCase', 'requestId', 'mimeType', 'fileName', 'sizeBytes', 'sha256'])
    || !PURPOSES.includes(value.useCase) || !UUID.test(value.requestId)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_FILE_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.fileName !== 'string' || value.fileName.length < 1 || value.fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(value.fileName)
    || typeof value.mimeType !== 'string'
    || !(value.useCase === 'accounting_ocr' ? /^(application\/pdf|image\/(png|jpeg|jpg|webp|gif))$/ : /^(audio|video)\/[a-z0-9.+-]{1,64}$/).test(value.mimeType)) fail('invalid_request');
  return value;
}
function tokenHash(token) {
  if (typeof token !== 'string' || !TOKEN.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) fail('not_found');
  return crypto.createHash('sha256').update(token).digest('hex');
}
function reference(value, { expectedOrigin, environment, requestId, useCase, now = Date.now() }) {
  if (!exact(value, ['version', 'environment', 'requestId', 'useCase', 'url', 'expiresAt', 'mimeType', 'fileName', 'sizeBytes', 'sha256'])
    || value.version !== 1 || value.environment !== environment || value.requestId !== requestId || value.useCase !== useCase
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + MAX_TTL_MS
    || typeof value.url !== 'string') fail('invalid_request');
  upload(Object.fromEntries(['useCase', 'requestId', 'mimeType', 'fileName', 'sizeBytes', 'sha256'].map(k => [k, value[k]])));
  const base = origin(expectedOrigin);
  if (!value.url.startsWith(base + PREFIX)) fail('invalid_request');
  tokenHash(value.url.slice((base + PREFIX).length));
  return value;
}
module.exports = { PREFIX, MAX_FILE_BYTES, MAX_TTL_MS, PURPOSES, UUID, TOKEN, fail, exact, origin, upload, tokenHash, reference };
