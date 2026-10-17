'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const sharp = require('sharp');
const storage = require('../../services/publicMediaStorage.service');

async function logoPng() {
  return sharp({ create: {
    width: 256, height: 96, channels: 4,
    background: { r: 15, g: 45, b: 75, alpha: 0.5 },
  } }).png().withMetadata({ orientation: 6 }).toBuffer();
}

function loadModule(relativePath, dependencies, extras = {}) {
  const filename = path.resolve(__dirname, relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, URL, Date,
    process: { env: {} }, console: { error() {} },
    require: (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
    ...extras,
  }, { filename });
  return module.exports;
}

// Run the actual controller, image pipeline, object-key generator and response
// assembly. Only SQL/ACL/S3 boundaries are substituted; no CRM rows or remote
// objects are created by this regression.
function endpoint({ permitted = true, clinicExists = true } = {}) {
  const calls = { acl: [], clinics: [], assets: [], puts: [], groups: [] };
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class S3Client {
    async send(command) {
      calls.puts.push(command.input);
      return { ETag: 'test-etag' };
    }
  }
  const isolatedStorage = loadModule('../../services/publicMediaStorage.service.js', {
    '@aws-sdk/client-s3': { PutObjectCommand, S3Client },
    '@aws-sdk/client-cloudfront': {},
    '@aws-sdk/client-sts': {},
    './publicMediaBroker.service': { enabled: () => false },
  });
  const controller = loadModule('../../controllers/publicMedia.controller.js', {
    sequelize: { fn: () => null, col: () => null, Op: { in: Symbol('in') } },
    '../../models': {
      Clinica: {
        async findByPk(id) {
          calls.clinics.push(id);
          return clinicExists ? { id_clinica: id } : null;
        },
      },
      GrupoClinica: {
        async findByPk(id) { calls.groups.push(id); throw new Error('group lookup forbidden'); },
      },
      PublicMediaAsset: {
        async create(record) { calls.assets.push(record); return { id: 123 }; },
        async findOne() { return { asset_count: 1, size_bytes: 200 }; },
      },
    },
    '../services/publicMediaStorage.service': isolatedStorage,
    '../lib/marketingWebFeatureFlags': { assertWebScopeEnabled() {} },
    '../lib/access-policy': {
      async assertUserCanAccessFeature(input) {
        calls.acl.push(input);
        if (!permitted) throw Object.assign(new Error('access_policy_forbidden'), { status: 403 });
      },
      async getAccessibleClinicIdsForFeature() { throw new Error('group ACL forbidden'); },
    },
    '../lib/role-helpers': { isGlobalAdmin: () => false },
  });
  return {
    calls,
    controller,
    async upload(body, headers = { 'x-selected-clinic': '72' }) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
      };
      await controller.upload({ body, headers, query: {}, userData: { userId: 42 } }, res);
      return res;
    },
  };
}

async function requestBody(extra = {}) {
  return {
    purpose: 'tablet_logo', clinic_id: 72, content_type: 'image/png',
    data_url: `data:image/png;base64,${(await logoPng()).toString('base64')}`,
    non_clinical_asserted: true,
    ...extra,
  };
}

test('tablet logo uses decoded WebP pixels, strips metadata and preserves transparency', async () => {
  const source = await logoPng();
  const output = await storage.preparePublicMediaPayload({
    purpose: 'tablet_logo', contentType: 'image/png', buffer: source,
  });
  const metadata = await sharp(output.buffer).metadata();
  assert.equal(output.purpose, 'tablet_logo');
  assert.equal(output.contentType, 'image/webp');
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.width, 96);
  assert.equal(metadata.height, 256);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.equal(output.imageMetadata.metadata_stripped, true);
  assert.equal(output.imageMetadata.content_disarm, 'sharp_reencode_v1');
});

test('tablet logo rejects invalid bytes, MIME mismatch, SVG and oversized source', async () => {
  for (const [contentType, buffer, error] of [
    ['image/png', Buffer.from('not an image'), 'public_media_invalid_image'],
    ['image/jpeg', await logoPng(), 'public_media_content_type_mismatch'],
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'public_media_only_images_allowed'],
    ['image/png', Buffer.alloc(storage.MAX_IMAGE_BYTES + 1), 'public_media_file_size_not_allowed'],
  ]) {
    await assert.rejects(storage.preparePublicMediaPayload({ purpose: 'tablet_logo', contentType, buffer }),
      (failure) => failure.message === error);
  }
});

test('real upload path requires settings edit and forces clinic-owned, versioned tablet asset', async () => {
  const { upload, calls } = endpoint();
  const res = await upload(await requestBody({
    owner_type: 'clinic_access_guidance', owner_id: '66',
    file_name: 'patient-sensitive-name.png', key: 'logos/clinicas/overwrite.png', invalidate: true,
  }));
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  assert.equal(calls.acl.length, 1);
  assert.equal(calls.acl[0].actorId, 42);
  assert.equal(calls.acl[0].clinicId, 72);
  assert.equal(calls.acl[0].featureKey, 'clinic.settings.edit');
  assert.equal(calls.puts.length, 1);
  assert.match(calls.puts[0].Key, /^logos\/clinicas\/clinic-72\/\d{4}\/\d{2}\/[a-f0-9-]+\.webp$/);
  assert.equal(calls.puts[0].ContentType, 'image/webp');
  assert.equal(calls.puts[0].CacheControl, storage.VERSIONED_CACHE_CONTROL);
  assert.equal(calls.assets[0].owner_type, 'tablet_branding');
  assert.equal(calls.assets[0].owner_id, '72');
  assert.equal(calls.assets[0].purpose, 'tablet_logo');
  assert.equal(calls.assets[0].clinica_id, 72);
  assert.equal(calls.assets[0].grupo_clinica_id, null);
  assert.equal(calls.assets[0].metadata.original_filename, null);
  assert.equal(calls.assets[0].metadata.image.metadata_stripped, true);
  assert.equal(calls.assets[0].metadata.content_disarm, 'sharp_reencode_v1');
  const url = new URL(res.payload.asset.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'media.clinicaclick.com');
  assert.equal(url.username, '');
  assert.equal(res.payload.asset.clinic_id, 72);
  assert.equal(res.payload.asset.group_id, null);
  assert.equal(res.payload.asset.scope_type, 'clinic');
  assert.equal(res.payload.asset.purpose, 'tablet_logo');
  assert.equal(res.payload.asset.content_type, 'image/webp');
  assert.equal(res.payload.asset.id, 123);
  // No clinic update method is provided. Uploading creates an asset only and
  // therefore cannot change the avatar shown in /clinicas or saved settings.
  assert.deepEqual(calls.clinics, [72]);
});

test('tablet upload respects explicit clinic over current sidebar fallback', async () => {
  const { upload, calls } = endpoint();
  const res = await upload(await requestBody({ clinic_id: 66 }), { 'x-selected-clinic': '72' });
  assert.equal(res.statusCode, 201);
  assert.equal(calls.acl[0].clinicId, 66);
  assert.equal(calls.assets[0].owner_id, '66');
  assert.match(calls.puts[0].Key, /^logos\/clinicas\/clinic-66\//);
});

test('tablet upload supports sidebar clinic when request has no explicit clinic', async () => {
  const { upload, calls } = endpoint();
  const body = await requestBody();
  delete body.clinic_id;
  const res = await upload(body);
  assert.equal(res.statusCode, 201);
  assert.equal(calls.assets[0].clinica_id, 72);
});

test('group, catalog, absent and ambiguous scopes fail without uploading or borrowing clinic', async () => {
  for (const [body, headers, error] of [
    [{ purpose: 'tablet_logo', scope: 'group:29' }, { 'x-selected-clinic': '72' }, 'tablet_logo_requires_clinic_scope'],
    [{ purpose: 'tablet_logo', scope: 'catalog' }, { 'x-selected-clinic': '72' }, 'tablet_logo_requires_clinic_scope'],
    [{ purpose: 'tablet_logo' }, {}, 'public_media_scope_required'],
    [{ purpose: 'tablet_logo', clinic_id: 72, scope: 'group:29' }, {}, 'public_media_scope_ambiguous'],
  ]) {
    const { upload, calls } = endpoint();
    const res = await upload(body, headers);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, error);
    assert.equal(calls.puts.length, 0);
    assert.equal(calls.assets.length, 0);
    assert.equal(calls.groups.length, 0);
    assert.equal(calls.acl.length, 0);
  }
});

test('tablet logo fails closed on missing clinic, denied ACL or missing nonclinical assertion', async () => {
  for (const [options, body, status, error] of [
    [{ clinicExists: false }, await requestBody(), 404, 'public_media_clinic_not_found'],
    [{ permitted: false }, await requestBody(), 403, 'access_policy_forbidden'],
    [{}, await requestBody({ non_clinical_asserted: false }), 400, 'public_media_non_clinical_assertion_required'],
  ]) {
    const { upload, calls } = endpoint(options);
    const res = await upload(body);
    assert.equal(res.statusCode, status);
    assert.equal(res.payload.error, error);
    assert.equal(calls.puts.length, 0);
    assert.equal(calls.assets.length, 0);
  }
});

test('adding tablet settings upload does not grant marketing clinic-logo permission', () => {
  const { controller } = endpoint();
  assert.equal(controller._private.uploadFeatureForPurpose('tablet_logo'), 'clinic.settings.edit');
  assert.equal(controller._private.uploadFeatureForPurpose('invoice_logo'), 'clinic.settings.edit');
  assert.equal(controller._private.uploadFeatureForPurpose('clinic_logo'), 'marketing');
  assert.equal(controller._private.uploadFeatureForPurpose('review_team_photo'), 'marketing');
});
