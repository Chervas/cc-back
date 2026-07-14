'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const publicMediaStorage = require('../../services/publicMediaStorage.service');
const publicMediaController = require('../../controllers/publicMedia.controller');

async function makePng() {
  return sharp({
    create: {
      width: 360,
      height: 640,
      channels: 3,
      background: '#455a64',
    },
  })
    .png()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

async function testClinicAccessImageIsNormalizedForWhatsapp() {
  const source = await makePng();
  const prepared = await publicMediaStorage.preparePublicMediaPayload({
    purpose: 'clinic_access_image',
    contentType: 'image/png',
    buffer: source,
  });
  const outputMetadata = await sharp(prepared.buffer).metadata();

  assert.equal(prepared.contentType, 'image/jpeg');
  assert.equal(outputMetadata.format, 'jpeg');
  assert.equal(outputMetadata.width, publicMediaStorage.CLINIC_ACCESS_IMAGE_WIDTH);
  assert.equal(outputMetadata.height, publicMediaStorage.CLINIC_ACCESS_IMAGE_HEIGHT);
  assert.equal(outputMetadata.orientation, undefined);
  assert.equal(prepared.imageMetadata.source_content_type, 'image/png');
  assert.equal(prepared.imageMetadata.transformed, true);
  assert.equal(prepared.imageMetadata.metadata_stripped, true);
  assert.equal(prepared.imageMetadata.whatsapp_compatible, true);
  assert.ok(prepared.buffer.length < publicMediaStorage.MAX_WHATSAPP_IMAGE_BYTES);
}

async function testMagicBytesMustMatchDeclaredMime() {
  const source = await makePng();
  await assert.rejects(
    publicMediaStorage.preparePublicMediaPayload({
      purpose: 'clinic_access_image',
      contentType: 'image/jpeg',
      buffer: source,
    }),
    /public_media_content_type_mismatch/,
  );
  await assert.rejects(
    publicMediaStorage.preparePublicMediaPayload({
      purpose: 'clinic_access_image',
      contentType: 'image/jpeg',
      buffer: Buffer.from('not an image'),
    }),
    /public_media_invalid_image/,
  );
}

async function testSourceSizeIsRejectedBeforeImageDecode() {
  await assert.rejects(
    publicMediaStorage.preparePublicMediaPayload({
      purpose: 'clinic_access_image',
      contentType: 'image/jpeg',
      buffer: Buffer.alloc(publicMediaStorage.MAX_IMAGE_BYTES + 1, 1),
    }),
    (error) => error?.message === 'public_media_file_size_not_allowed' && error?.status === 413,
  );
}

function testControllerRequiresAssertionScopeAndEditCapability() {
  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/publicMedia.controller.js'),
    'utf8',
  );
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/publicMedia.routes.js'),
    'utf8',
  );
  const storageSource = fs.readFileSync(
    path.resolve(__dirname, '../../services/publicMediaStorage.service.js'),
    'utf8',
  );

  assert.match(routeSource, /router\.use\(authMiddleware\)/);
  assert.match(controllerSource, /uploadFeatureForPurpose\(purpose\)/);
  assert.match(controllerSource, /public_media_non_clinical_assertion_required/);
  assert.match(controllerSource, /clinic_access_image_requires_clinic_scope/);
  assert.match(controllerSource, /ownerType = purpose === 'clinic_access_image'/);
  assert.match(controllerSource, /versioned:\s*true/);
  assert.doesNotMatch(controllerSource, /key:\s*req\.body\?\.key/);
  assert.match(controllerSource, /id:\s*asset\?\.id \|\| null/);
  assert.match(controllerSource, /url:\s*upload\.url/);
  assert.match(storageSource, /case 'clinic_access_image':/);
  assert.match(storageSource, /whatsapp\/clinic-access/);
  assert.doesNotMatch(routeSource, /router\.(?:delete|patch)\(/i);
}

function testReviewPhotoKeepsMarketingCapability() {
  assert.equal(
    publicMediaController._private.uploadFeatureForPurpose('clinic_access_image'),
    'clinic.settings.edit',
  );
  assert.equal(
    publicMediaController._private.uploadFeatureForPurpose('review_team_photo'),
    'marketing',
  );
  assert.equal(
    publicMediaController._private.uploadFeatureForPurpose('whatsapp_image'),
    'marketing',
  );

  assert.deepEqual(
    publicMediaController._private.resolveScope({
      body: { scope: 'group:29' },
      query: {},
      headers: { 'x-selected-clinic': '66' },
    }),
    { scopeType: 'group', clinicId: null, groupId: 29 },
    'an explicit group scope must win over the interceptor clinic header',
  );
  assert.throws(
    () => publicMediaController._private.resolveScope({
      body: { scope: 'group:29', clinic_id: 66 },
      query: {},
      headers: {},
    }),
    /public_media_scope_ambiguous/,
    'two explicit scopes must remain invalid',
  );
}

async function run() {
  await testClinicAccessImageIsNormalizedForWhatsapp();
  await testMagicBytesMustMatchDeclaredMime();
  await testSourceSizeIsRejectedBeforeImageDecode();
  testControllerRequiresAssertionScopeAndEditCapability();
  testReviewPhotoKeepsMarketingCapability();
  console.log('public_media_clinic_access.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
