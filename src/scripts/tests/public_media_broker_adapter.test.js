'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const brokerPath = require.resolve('../../services/publicMediaBroker.service');
const storagePath = require.resolve('../../services/publicMediaStorage.service');

function freshStorage({ enabled, upload }) {
  const broker = require(brokerPath);
  broker.enabled = enabled;
  broker.uploadEmailImage = upload;
  delete require.cache[storagePath];
  return require(storagePath);
}

test('marketing images use the authorized broker result without constructing an AWS client in CRM', async () => {
  const buffer = Buffer.from('89504e470d0a1a0a464943544954494f5553', 'hex');
  let input;
  const storage = freshStorage({ enabled: () => true, upload: async value => {
    input = value;
    return { key: 'marketing/email/clinic-1/2026/09/12345678-1234-4234-9234-1234567890ab.png',
      url: 'https://media.clinicaclick.com/marketing/email/clinic-1/2026/09/12345678-1234-4234-9234-1234567890ab.png',
      contentType: 'image/png', sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
      etag: '"fictitious"', cacheControl: 'public, max-age=31536000, immutable' };
  } });
  const result = await storage.uploadPublicMedia({ purpose: 'marketing_image', clinicId: 1, contentType: 'image/png',
    preparedPayload: { purpose: 'marketing_image', contentType: 'image/png', buffer, imageMetadata: { metadata_stripped: true } } });
  assert.equal(input.clinicId, 1); assert.equal(input.purpose, 'marketing_image'); assert.deepEqual(input.buffer, buffer);
  assert.equal(result.bucket, 'clinicaclick-public-media-eu-west-3');
  assert.equal(result.url, 'https://media.clinicaclick.com/' + result.key);
  assert.deepEqual(result.imageMetadata, { metadata_stripped: true });
});

test('required broker fails closed instead of falling back to ambient AWS credentials', async () => {
  const previous = process.env.PUBLIC_MEDIA_BROKER_REQUIRED;
  process.env.PUBLIC_MEDIA_BROKER_REQUIRED = 'true';
  try {
    const storage = freshStorage({ enabled: () => false, upload: async () => { throw new Error('must_not_run'); } });
    const buffer = Buffer.from('89504e470d0a1a0a464943544954494f5553', 'hex');
    await assert.rejects(storage.uploadPublicMedia({ purpose: 'marketing_image', clinicId: 1, contentType: 'image/png',
      preparedPayload: { purpose: 'marketing_image', contentType: 'image/png', buffer } }),
    error => error?.message === 'public_media_broker_required' && error?.status === 503);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_MEDIA_BROKER_REQUIRED;
    else process.env.PUBLIC_MEDIA_BROKER_REQUIRED = previous;
  }
});

test('catalog images keep a dedicated broker scope instead of inheriting a clinic', async () => {
  const broker = require(brokerPath);
  assert.deepEqual(broker.__testing.scope({ scope: 'catalog' }), { type: 'catalog', id: 1 });
  assert.throws(
    () => broker.__testing.scope({ scope: 'catalog', clinicId: 1 }),
    /public_media_scope_ambiguous/,
  );
});
