'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  METRIC_DEFINITIONS,
  GBP_MEDIA_CATEGORIES,
  resolveDateRange,
  resolvePhotoMutationClinicIds,
  serializeLocation,
  normalizeServiceItem,
  normalizeMediaItem,
  buildGoogleRatingSummary,
  collapseMetricRows,
  metricValueByDate,
  isPublishableBusinessProfileMediaAsset,
  normalizeSpecialHoursPlan,
  buildGoogleSpecialHourPeriods,
  preserveSpecialHoursOutsideRange,
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

function testProvisionalEmptyTailIsNotPresentedAsARealDrop() {
  const today = new Date().toISOString().slice(0, 10);
  const rawTypes = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_DIRECTION_REQUESTS',
    'CALL_CLICKS',
    'WEBSITE_CLICKS',
  ];
  const provisional = rawTypes.map((metric_type, index) => ({
    id: 100 + index,
    business_location_id: 10,
    date: today,
    metric_type,
    metric_subtype: '',
    value: 0,
  }));
  assert.deepEqual(
    collapseMetricRows(provisional),
    [],
    'a complete but empty provider tail is pending, not a measured zero day'
  );

  provisional[0].value = 3;
  assert.equal(
    collapseMetricRows(provisional).length,
    provisional.length,
    'a recent day with any measured activity must remain visible'
  );
}

function testIncompleteProviderTailIsNotPresentedAsARealDrop() {
  const recent = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  const incomplete = [
    { metric_type: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', value: 8 },
    { metric_type: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', value: 31 },
    { metric_type: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', value: 44 },
  ].map((row, index) => ({
    id: 300 + index,
    business_location_id: 10,
    date: recent,
    metric_subtype: '',
    ...row,
  }));
  assert.deepEqual(
    collapseMetricRows(incomplete),
    [],
    'a partially published Performance day must not look like a real clinic-wide drop',
  );
}

function testPersistedLegacyNullCoercionDoesNotReappearAfterTailWindow() {
  const legacyTypes = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_DIRECTION_REQUESTS',
    'CALL_CLICKS',
    'WEBSITE_CLICKS',
    'BUSINESS_BOOKINGS',
    'BUSINESS_CONVERSATIONS',
  ];
  const rows = legacyTypes.map((metric_type, index) => ({
    id: 200 + index,
    business_location_id: 10,
    date: '2026-07-14',
    metric_type,
    metric_subtype: '',
    value: 0,
    created_at: '2026-07-15T03:10:00.000Z',
  }));
  assert.deepEqual(
    collapseMetricRows(rows),
    [],
    'the bounded null-coercion cohort must not reappear when it is older than the provisional tail'
  );

  for (const row of rows) row.created_at = '2026-07-18T03:10:00.000Z';
  assert.equal(
    collapseMetricRows(rows).length,
    rows.length,
    'an explicit historical zero outside the faulty write window remains valid'
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
  assert.equal(service.sourceKind, 'free_form_service');
  assert.equal(service.descriptionSource, 'google_business_profile');
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
  assert.equal(photo.label, 'Foto de portada');
  assert.equal(photo.mediaFormat, 'PHOTO');
  assert.equal(photo.isVideo, false);
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
  const video = normalizeMediaItem({
    mediaFormat: 'VIDEO',
    googleUrl: 'https://example.test/video-preview.jpg',
    thumbnailUrl: 'https://example.test/video-thumbnail.jpg',
    sourceUrl: 'https://example.test/clinic-tour.mp4',
    locationAssociation: { category: 'ADDITIONAL' },
  }, 5);
  assert.equal(video.isVideo, true);
  assert.equal(video.label, 'Vídeo de la clínica');
  assert.equal(video.url, 'https://example.test/video-preview.jpg');
  assert.equal(video.thumbnailUrl, 'https://example.test/video-thumbnail.jpg');
  assert.equal(video.playbackUrl, 'https://example.test/clinic-tour.mp4');
  assert.equal(normalizeMediaItem({
    description: 'additional',
    locationAssociation: { category: 'ADDITIONAL' },
  }, 6).label, 'Foto de la clínica');
  assert.equal(normalizeMediaItem({
    mediaFormat: 'VIDEO',
    description: 'additional',
    locationAssociation: { category: 'ADDITIONAL' },
  }, 7).label, 'Vídeo de la clínica');
  assert.equal(GBP_MEDIA_CATEGORIES.includes('TEAMS'), true);
  assert.equal(GBP_MEDIA_CATEGORIES.includes('LOGO'), true);
  assert.equal(GBP_MEDIA_CATEGORIES.includes('TEAM'), false, 'legacy TEAM must never be published to GBP');
}

function testVerificationStateUsesProviderSignalWithoutGuessing() {
  const base = {
    id: 1,
    location_id: 'locations/1',
    location_name: 'Clínica',
    is_verified: false,
    is_suspended: false,
    raw_payload: {},
  };
  const providerFalseWithoutDiagnostic = serializeLocation({
    ...base,
    raw_payload: { metadata: { hasVoiceOfMerchant: false } },
  });
  assert.equal(providerFalseWithoutDiagnostic.verification.state, 'unknown');
  assert.match(providerFalseWithoutDiagnostic.verification.detail, /no confirma/);

  const pendingVerification = serializeLocation({
    ...base,
    raw_payload: {
      metadata: { hasVoiceOfMerchant: false },
      clinicaclick_voice_of_merchant_state: {
        hasVoiceOfMerchant: false,
        verify: { hasPendingVerification: true },
      },
    },
  });
  assert.equal(pendingVerification.verification.state, 'pending');
  assert.equal(pendingVerification.verification.label, 'Verificación pendiente de completar');
  assert.equal(pendingVerification.verification.action, 'complete_verification');

  const ownershipConflict = serializeLocation({
    ...base,
    raw_payload: {
      clinicaclick_voice_of_merchant_state: {
        hasVoiceOfMerchant: false,
        resolveOwnershipConflict: { conflictingLocations: ['locations/2'] },
      },
    },
  });
  assert.equal(ownershipConflict.verification.state, 'attention');
  assert.equal(ownershipConflict.verification.label, 'Conflicto de propiedad');
  assert.equal(ownershipConflict.verification.action, 'resolve_ownership_conflict');

  const disabledByGuidelines = serializeLocation({
    ...base,
    raw_payload: {
      clinicaclick_voice_of_merchant_state: {
        hasVoiceOfMerchant: false,
        complyWithGuidelines: { recommendationReason: 'BUSINESS_LOCATION_DISABLED' },
      },
    },
  });
  assert.equal(disabledByGuidelines.verification.state, 'attention');
  assert.equal(disabledByGuidelines.verification.label, 'Ficha desactivada');
  assert.equal(disabledByGuidelines.verification.action, 'comply_with_guidelines');

  const providerWinsOverStaleColumn = serializeLocation({
    ...base,
    is_verified: false,
    raw_payload: { metadata: { hasVoiceOfMerchant: true } },
  });
  assert.equal(providerWinsOverStaleColumn.verified, true);
  assert.equal(providerWinsOverStaleColumn.verification.state, 'verified');

  const legacyVerifiedFallback = serializeLocation({ ...base, is_verified: true });
  assert.equal(legacyVerifiedFallback.verified, true);
  assert.equal(legacyVerifiedFallback.verification.state, 'verified');

  const suspendedOverridesVerification = serializeLocation({
    ...base,
    is_verified: true,
    is_suspended: true,
    raw_payload: { metadata: { hasVoiceOfMerchant: true } },
  });
  assert.equal(suspendedOverridesVerification.verified, false);
  assert.equal(suspendedOverridesVerification.verification.state, 'attention');
  assert.match(suspendedOverridesVerification.verification.detail, /suspendida/);

  const unknown = serializeLocation(base);
  assert.equal(unknown.verification.state, 'unknown');
  assert.doesNotMatch(unknown.verification.detail, /pendiente/i);
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
  assert.match(routes, /router\.put\(\s*'\/clinica\/:clinicaId\/special-hours',[\s\S]*requireClinicBusinessProfileWriteAccess/,
    'special-hours writes must use shared-profile write authorization');
  assert.doesNotMatch(routes, /rawPayload:\s*raw/, 'Local status must not expose provider raw payload');
  assert.match(syncJobs, /'serviceItems'/, 'GBP read mask must include service items');
  assert.match(syncJobs, /_syncBusinessProfileMedia/, 'full GBP sync must include media');
  assert.match(syncJobs, /clinicaclick_reviews_synced_at/, 'review-only sync needs its own freshness timestamp');
  assert.match(syncJobs, /metadata\?\.hasVoiceOfMerchant/, 'GBP verification must use the Business Information Voice of Merchant field');
  assert.match(syncJobs, /mybusinessverifications\.googleapis\.com\/v1/, 'full GBP sync must request the canonical Voice of Merchant diagnosis');
  assert.match(syncJobs, /clinicaclick_voice_of_merchant_state/, 'Voice of Merchant diagnosis must be persisted for the UI');
  assert.match(localService, /description\s*&&\s*category\s*!==\s*'COVER'/, 'GBP COVER uploads must omit descriptions');
  assert.match(localService, /purpose:\s*'marketing_image'/, 'GBP uploads must select only marketing media assets');
  assert.match(localService, /owner_type:\s*'google_business_profile_media'/, 'GBP uploads must select only assets owned by the GBP media flow');
  assert.match(localService, /const mustRefresh = !accessToken/, 'missing token/expiry must enter the refresh path');
  assert.match(localService, /google_access_token_refresh_failed/, 'a refresh without a new token must fail closed');
  assert.match(localService, /updateMask:\s*'specialHours'/, 'GBP special hours must patch only the specialHours field');
}

function testDateRange() {
  const range = resolveDateRange('2026-07-01', '2026-07-10', 30);
  assert.equal(range.start, '2026-07-01');
  assert.equal(range.end, '2026-07-10');
  assert.equal(range.previous.start, '2026-06-21');
  assert.equal(range.previous.end, '2026-06-30');
}

function testSpecialHoursPlanNormalization() {
  const plan = normalizeSpecialHoursPlan({
    timeZone: 'Europe/Madrid',
    periods: [
      {
        id: 'summer-closure',
        kind: 'closed',
        label: 'Vacaciones de agosto',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      },
      {
        id: 'christmas-eve',
        kind: 'open',
        label: 'Nochebuena',
        startDate: '2026-12-24',
        endDate: '2026-12-24',
        openTime: '09:00',
        closeTime: '14:00',
      },
    ],
  });
  assert.equal(plan.timeZone, 'Europe/Madrid');
  assert.equal(plan.periods.length, 2);
  const googlePeriods = buildGoogleSpecialHourPeriods(plan);
  assert.equal(googlePeriods.length, 32, 'month closures must expand to one provider period per local date');
  assert.deepEqual(googlePeriods[0], {
    startDate: { year: 2026, month: 8, day: 1 },
    endDate: { year: 2026, month: 8, day: 1 },
    closed: true,
  });
  assert.deepEqual(googlePeriods.at(-1), {
    startDate: { year: 2026, month: 12, day: 24 },
    endDate: { year: 2026, month: 12, day: 24 },
    openTime: { hours: 9 },
    closeTime: { hours: 14 },
  });

  assert.throws(() => normalizeSpecialHoursPlan({
    periods: [
      { kind: 'closed', startDate: '2026-08-01', endDate: '2026-08-02' },
      { kind: 'open', startDate: '2026-08-02', endDate: '2026-08-02', openTime: '10:00', closeTime: '12:00' },
    ],
  }), /business_profile_special_hours_overlap/);
  assert.throws(() => normalizeSpecialHoursPlan({
    periods: [{ kind: 'open', startDate: '2026-08-01', endDate: '2026-08-01', openTime: '14:00', closeTime: '09:00' }],
  }), /business_profile_special_hours_times_invalid/);

  const preserved = preserveSpecialHoursOutsideRange({
    id: 'summer-closure',
    kind: 'closed',
    label: 'Vacaciones',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  }, {
    id: 'special-opening',
    kind: 'open',
    startDate: '2026-08-15',
    endDate: '2026-08-15',
  }, '2026-07-31');
  assert.deepEqual(preserved.map((item) => [item.startDate, item.endDate]), [
    ['2026-08-01', '2026-08-14'],
    ['2026-08-16', '2026-08-31'],
  ], 'an incoming rule must only replace the overlapping dates');
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
  testProvisionalEmptyTailIsNotPresentedAsARealDrop();
  testIncompleteProviderTailIsNotPresentedAsARealDrop();
  testPersistedLegacyNullCoercionDoesNotReappearAfterTailWindow();
  testContentNormalization();
  testVerificationStateUsesProviderSignalWithoutGuessing();
  testRatingTargets();
  testOnlyNonPatientMarketingAssetsCanReachGoogle();
  testSecurityAndSyncContracts();
  testDateRange();
  testSpecialHoursPlanNormalization();
  await testPhotoMutationIncludesEverySharedConsumer();
  console.log('business_profile_local tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
