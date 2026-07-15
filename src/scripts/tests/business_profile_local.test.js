'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  METRIC_DEFINITIONS,
  GBP_MEDIA_CATEGORIES,
  resolveDateRange,
  resolvePhotoMutationClinicIds,
  normalizeServiceItem,
  normalizeMediaItem,
  buildGoogleRatingSummary,
  collapseMetricRows,
  metricValueByDate,
  isPublishableBusinessProfileMediaAsset,
} = require('../../services/businessProfileLocal.service');

function testMetricDeduplicationAndTotals() {
  const rows = [
    { id: 1, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_TOTAL', metric_subtype: '', value: 100, updated_at: '2026-07-01T10:00:00Z' },
    { id: 2, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_TOTAL', metric_subtype: '', value: 110, updated_at: '2026-07-01T11:00:00Z' },
    { id: 3, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', metric_subtype: '', value: 40 },
    { id: 4, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', metric_subtype: '', value: 50 },
  ];
  assert.equal(collapseMetricRows(rows).length, 3, 'duplicate provider rows must collapse to the latest value');
  assert.deepEqual(
    metricValueByDate(rows, METRIC_DEFINITIONS.profile_views),
    [{ date: '2026-07-01', value: 110 }],
    'TOTAL must win over its components instead of being double counted'
  );
}

function testMetricTotalsAcrossLocations() {
  const rows = [
    { id: 1, business_location_id: 10, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_TOTAL', metric_subtype: '', value: 100 },
    { id: 2, business_location_id: 10, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', metric_subtype: '', value: 40 },
    { id: 3, business_location_id: 11, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', metric_subtype: '', value: 30 },
    { id: 4, business_location_id: 11, date: '2026-07-01', metric_type: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', metric_subtype: '', value: 20 },
    { id: 5, business_location_id: 10, date: '2026-07-02', metric_type: 'BUSINESS_IMPRESSIONS_TOTAL', metric_subtype: '', value: 80 },
    { id: 6, business_location_id: 11, date: '2026-07-02', metric_type: 'BUSINESS_IMPRESSIONS_TOTAL', metric_subtype: '', value: 70 },
  ];

  assert.equal(
    collapseMetricRows(rows).length,
    6,
    'equal metrics from different business locations must remain independent'
  );
  assert.deepEqual(
    metricValueByDate(rows, METRIC_DEFINITIONS.profile_views),
    [
      { date: '2026-07-01', value: 150 },
      { date: '2026-07-02', value: 150 },
    ],
    'TOTAL/fallback selection must happen per location before locations are summed by date'
  );
}

function testContentNormalization() {
  const service = normalizeServiceItem({
    freeFormServiceItem: {
      category: 'categories/gcid:dental_clinic',
      label: { displayName: 'Implantes dentales', description: 'Valoración y tratamiento implantológico.' },
    },
    price: { units: '45', currencyCode: 'EUR' },
  }, 0);
  assert.equal(service.name, 'Implantes dentales');
  assert.equal(service.category, 'dental clinic');
  assert.equal(service.status, 'publicado');
  assert.match(service.priceFrom, /45/);

  const photo = normalizeMediaItem({
    name: 'accounts/1/locations/2/media/3',
    googleUrl: 'https://example.test/photo.jpg',
    locationAssociation: { category: 'COVER' },
    dimensions: { widthPixels: 1200, heightPixels: 630 },
    attribution: {
      profileName: 'Paciente que compartió la foto',
      profilePhotoUrl: 'https://example.test/avatar.jpg',
      profileUrl: 'https://example.test/profile',
      takedownUrl: 'https://example.test/report',
    },
  }, 0);
  assert.equal(photo.type, 'portada');
  assert.equal(photo.widthPixels, 1200);
  assert.deepEqual(photo.attribution, {
    profileName: 'Paciente que compartió la foto',
    profilePhotoUrl: 'https://example.test/avatar.jpg',
    profileUrl: 'https://example.test/profile',
    takedownUrl: 'https://example.test/report',
  });

  assert.equal(normalizeMediaItem({ locationAssociation: { category: 'TEAMS' } }, 1).type, 'equipo');
  assert.equal(normalizeMediaItem({ locationAssociation: { category: 'TEAM' } }, 2).type, 'equipo');
  assert.equal(normalizeMediaItem({ locationAssociation: { category: 'LOGO' } }, 3).type, 'logo');
  assert.equal(normalizeMediaItem({ locationAssociation: { category: 'PROFILE' } }, 4).type, 'logo');
  assert.equal(GBP_MEDIA_CATEGORIES.includes('TEAMS'), true);
  assert.equal(GBP_MEDIA_CATEGORIES.includes('LOGO'), true);
  assert.equal(GBP_MEDIA_CATEGORIES.includes('TEAM'), false, 'legacy TEAM must never be published to GBP');
}

function testRatingTargets() {
  const summary = buildGoogleRatingSummary({
    total_reviews: 10,
    rating_sum: 46,
    five_star_reviews: 7,
  });
  assert.equal(summary.average_rating, 4.6);
  assert.ok(summary.needed_five_star_reviews_for_5 > 0);
  assert.ok(summary.rating_targets.length > 0);
}

function testOnlyNonPatientMarketingAssetsCanReachGoogle() {
  const safe = {
    clinica_id: 66,
    scope_type: 'clinic',
    status: 'active',
    sensitivity: 'public',
    purpose: 'marketing_image',
    owner_type: 'google_business_profile_media',
    content_type: 'image/webp',
    metadata: { non_clinical_asserted: true },
  };
  assert.equal(isPublishableBusinessProfileMediaAsset(safe, 66), true);
  assert.equal(isPublishableBusinessProfileMediaAsset({ ...safe, metadata: {} }, 66), false);
  assert.equal(isPublishableBusinessProfileMediaAsset({ ...safe, purpose: 'whatsapp_image' }, 66), false);
  assert.equal(isPublishableBusinessProfileMediaAsset({ ...safe, owner_type: 'review_request' }, 66), false);
  assert.equal(isPublishableBusinessProfileMediaAsset({
    ...safe,
    metadata: { patient_data_in_public_media: true, patient_name_present: true },
  }, 66), false);
  assert.equal(isPublishableBusinessProfileMediaAsset(safe, 67), false);
}

function testSecurityAndSyncContracts() {
  const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/local.routes.js'), 'utf8');
  const syncJobs = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  const localService = fs.readFileSync(path.resolve(__dirname, '../../services/businessProfileLocal.service.js'), 'utf8');
  assert.match(routes, /router\.use\(authMiddleware\)/, 'all Local routes must require authentication');
  assert.match(routes, /hasMarketingClinicScopeAccess/, 'Local routes must enforce clinic marketing scope');
  assert.match(routes, /resolvePhotoMutationClinicIds/, 'GBP writes must authorize every clinic affected by a shared location');
  assert.match(routes, /business_profile_asset_in_use/, 'shared GBP writes must fail closed when another consumer is not writable');
  assert.doesNotMatch(routes, /rawPayload:\s*raw/, 'Local status must not expose provider raw payload');
  assert.match(syncJobs, /'serviceItems'/, 'GBP read mask must include service items');
  assert.match(syncJobs, /_syncBusinessProfileMedia/, 'full GBP sync must include media');
  assert.match(syncJobs, /clinicaclick_reviews_synced_at/, 'review-only sync needs its own freshness timestamp');
  assert.match(syncJobs, /metadata\?\.hasVoiceOfMerchant/, 'GBP verification must use the Business Information Voice of Merchant field');
  assert.match(localService, /description\s*&&\s*category\s*!==\s*'COVER'/, 'GBP COVER uploads must omit descriptions');
  assert.match(localService, /purpose:\s*'marketing_image'/, 'GBP uploads must select only marketing media assets');
  assert.match(localService, /owner_type:\s*'google_business_profile_media'/, 'GBP uploads must select only assets owned by the GBP media flow');
  assert.match(localService, /const mustRefresh = !accessToken/, 'missing token/expiry must enter the refresh path');
  assert.match(localService, /google_access_token_refresh_failed/, 'a refresh without a new token must fail closed');
}

function testDateRange() {
  const range = resolveDateRange('2026-07-01', '2026-07-10', 30);
  assert.equal(range.start, '2026-07-01');
  assert.equal(range.end, '2026-07-10');
  assert.equal(range.previous.start, '2026-06-21');
  assert.equal(range.previous.end, '2026-06-30');
}

async function testPhotoMutationIncludesEverySharedConsumer() {
  const shared = await resolvePhotoMutationClinicIds({
    clinicId: 67,
    primaryLocationId: 10,
    locations: [{ id: 10, clinica_id: 66 }],
    assets: [{ mapping_id: 10, assignment_origin: 'shared' }],
    inventory: { scope: { group_id: 7 } },
  }, {
    GroupAssetClinicAssignment: {
      findAll: async () => [{ clinicaId: 67 }, { clinicaId: 68 }],
    },
    Clinica: { findAll: async () => { throw new Error('group lookup must not run for a shared-only asset'); } },
  });
  assert.deepEqual(shared, [66, 67, 68]);

  const group = await resolvePhotoMutationClinicIds({
    clinicId: 67,
    primaryLocationId: 10,
    locations: [{ id: 10, clinica_id: 66 }],
    assets: [{ mapping_id: 10, assignment_origin: 'group' }],
    inventory: { scope: { group_id: 7 } },
  }, {
    GroupAssetClinicAssignment: { findAll: async () => [] },
    Clinica: { findAll: async () => [{ id_clinica: 66 }, { id_clinica: 67 }, { id_clinica: 69 }] },
  });
  assert.deepEqual(group, [66, 67, 69]);
}

async function run() {
  testMetricDeduplicationAndTotals();
  testMetricTotalsAcrossLocations();
  testContentNormalization();
  testRatingTargets();
  testOnlyNonPatientMarketingAssetsCanReachGoogle();
  testSecurityAndSyncContracts();
  testDateRange();
  await testPhotoMutationIncludesEverySharedConsumer();
  console.log('business_profile_local tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
