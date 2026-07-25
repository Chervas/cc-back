'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const sharp = require('sharp');
const publicMediaStorage = require('../services/publicMediaStorage.service');

(async () => {
  const logoSource = await sharp({
    create: {
      width: 120,
      height: 48,
      channels: 4,
      background: { r: 79, g: 70, b: 229, alpha: 1 },
    },
  }).png().toBuffer();
  const preparedLogo = await publicMediaStorage.preparePublicMediaPayload({
    purpose: 'invoice_logo',
    contentType: 'image/png',
    buffer: logoSource,
  });
  assert.equal(preparedLogo.contentType, 'image/webp');
  assert.equal(preparedLogo.imageMetadata?.metadata_stripped, true);

  const result = await publicMediaStorage.uploadPublicMedia({
    purpose: 'test_health',
    contentType: 'text/plain',
    content: `clinicaclick public media health ${new Date().toISOString()}\n`,
    encoding: 'text',
    versioned: false,
    invalidate: true
  });

  console.log(JSON.stringify({
    success: true,
    key: result.key,
    url: result.url,
    sizeBytes: result.sizeBytes,
    cacheControl: result.cacheControl,
    invoiceLogo: {
      accepted: true,
      contentType: preparedLogo.contentType,
      metadataStripped: preparedLogo.imageMetadata?.metadata_stripped,
    },
  }, null, 2));
})().catch((err) => {
  console.error(JSON.stringify({
    success: false,
    name: err.name || null,
    message: err.message || 'public_media_upload_failed',
    status: err.$metadata?.httpStatusCode || err.status || null
  }, null, 2));
  process.exitCode = 1;
});
