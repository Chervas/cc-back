'use strict';

require('dotenv').config();

const publicMediaStorage = require('../services/publicMediaStorage.service');

(async () => {
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
    cacheControl: result.cacheControl
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
