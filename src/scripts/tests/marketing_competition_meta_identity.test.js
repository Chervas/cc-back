'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const { __testing } = require('../../services/marketingCompetition.service');

function testAdsLibraryUrlProvidesCanonicalPageIdentity() {
  const url = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ES&is_targeted_country=false&media_type=all&search_type=page&sort_data%5Bdirection%5D=desc&view_all_page_id=1438321663093742';
  assert.equal(__testing.extractMetaPageIdFromUrl(url), '1438321663093742');
  assert.deepEqual(__testing.metaPageIdentityFromPayload({ facebook_url: url }), {
    page_id: '1438321663093742',
    page_url: 'https://www.facebook.com/1438321663093742',
    source: 'ads_library_url',
  });
}

function testVanityDiscoveryNeverErasesAnExplicitPageId() {
  const patch = {};
  __testing.applyDiscoveredMetaIdentityPatch({
    meta_page_id: '1438321663093742',
    meta_page_url: 'https://www.facebook.com/1438321663093742',
  }, patch, {
    facebook_url: 'https://www.facebook.com/NaturalDentHospitalet',
  });

  assert.equal(Object.hasOwn(patch, 'meta_page_id'), false);
  assert.equal(Object.hasOwn(patch, 'meta_page_url'), false);

  const unresolvedPatch = {};
  __testing.applyDiscoveredMetaIdentityPatch({}, unresolvedPatch, {
    facebook_url: 'https://www.facebook.com/NaturalDentHospitalet',
  });
  assert.equal(unresolvedPatch.meta_page_url, 'https://www.facebook.com/NaturalDentHospitalet');
  assert.equal(Object.hasOwn(unresolvedPatch, 'meta_page_id'), false);
}

function testCanonicalBrandFragmentsAreSearchedBeforeTheLongListingName() {
  const dentalStudio = __testing.metaIdentitySearchCandidates({
    name: 'Dental Studio Dra. Lorena Herrero - Clínica Dental',
  });
  assert.equal(dentalStudio[0], 'Dental Studio Dra. Lorena Herrero');

  const drBlade = __testing.metaIdentitySearchCandidates({
    name: 'Clínica Dental Hospitalet Llobregat | Grup Dr. Bladé',
  });
  assert.equal(drBlade[0], 'Grup Dr. Bladé');
  assert.ok(drBlade.indexOf('Grup Dr. Bladé') < 4);
}

function testPublicFacebookMetadataSuppliesTheExactBrandTerm() {
  const metadata = __testing.extractFacebookPublicProfileMetadata(`
    <html><head>
      <meta content="Dental Studio Dra. Lorena Herrero | L&#039;Hospitalet de Llobregat" property="og:title">
      <link href="https://www.facebook.com/dentalstudioes" rel="canonical">
    </head></html>
  `, 'https://www.facebook.com/dentalstudioes');
  assert.deepEqual(metadata, {
    page_id: null,
    page_name: 'Dental Studio Dra. Lorena Herrero',
    page_url: 'https://www.facebook.com/dentalstudioes',
    source: 'facebook_public_profile',
  });
}

async function testBrandFragmentResolvesTheCanonicalAdsLibraryPage() {
  const calls = [];
  const resolved = await __testing.resolveMetaPageFromAdsArchive({
    name: 'Dental Studio Dra. Lorena Herrero - Clínica Dental',
  }, 'test-token', async (params) => {
    calls.push(params.search_terms);
    if (params.search_terms !== 'Dental Studio Dra. Lorena Herrero') return { raw: {}, ads: [] };
    return {
      raw: {},
      ads: [{
        id: 'active-ad',
        page_id: '1673128226297489',
        page_name: 'Dental Studio Dra. Lorena Herrero',
      }],
    };
  });
  assert.deepEqual(calls, ['Dental Studio Dra. Lorena Herrero']);
  assert.equal(resolved.page_id, '1673128226297489');
}

async function testHistoricalAdsResolvePageBeforeActiveLookup() {
  const calls = [];
  const resolved = await __testing.resolveMetaPageFromAdsArchive({
    name: 'Clínica Dental Dra. Sara Páez',
    meta_ads_search_terms: ['@clinicaprovenza'],
    raw_place_payload: {
      clinicaclick_social_profiles: { instagram_username: 'clinicaprovenza' },
    },
  }, 'test-token', async (params, accessToken) => {
    calls.push({ params, accessToken });
    if (!String(params.search_terms).includes('clinicaprovenza')) return { raw: {}, ads: [] };
    return {
      raw: {},
      ads: [{
        id: 'historical-ad',
        page_id: '449497955170438',
        page_name: 'Clínica Provenza',
      }],
    };
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].accessToken, 'test-token');
  assert.equal(calls[1].params.ad_active_status, 'ALL');
  assert.equal(calls[1].params.fields, 'id,page_id,page_name');
  assert.equal(resolved.page_id, '449497955170438');
  assert.equal(resolved.source, 'ads_archive_historical_identity');
}

function testUnresolvedIdentityIsNotReportedAsZeroActiveAds() {
  const outcome = __testing.metaSnapshotOutcome({
    identityResolved: false,
    resolvedPage: null,
    raw: { clinicaclick_resolution: { page: null } },
    ads: [],
  });
  assert.equal(outcome.status, 'identity_unresolved');
  assert.equal(outcome.error_code, 'META_PAGE_IDENTITY_UNRESOLVED');
  assert.deepEqual(outcome.ads, []);
}

function testResolvedPageWithNoActiveAdsIsAValidZero() {
  const outcome = __testing.metaSnapshotOutcome({
    identityResolved: true,
    resolvedPage: { page_id: '449497955170438' },
    raw: {},
    ads: [],
  });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.ads, []);
  assert.equal(outcome.error_code, undefined);
}

function testResolvedPageWithNoApiRowsKeepsItsCanonicalIdentity() {
  const libraryUrl = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ES&search_type=page&view_all_page_id=1438321663093742';
  const payload = __testing.adSnapshotPayload({
    status: 'completed',
    ads_count: 0,
    active_ads: [],
    raw_payload: {
      clinicaclick_resolution: {
        page: {
          page_id: '1438321663093742',
          source: 'ads_library_url',
        },
        page_library_url: libraryUrl,
        api_result_status: 'no_ads_returned',
        fallback_filtered: false,
      },
    },
  });

  assert.equal(payload.ads_status, 'completed');
  assert.equal(payload.identity_status, 'resolved');
  assert.equal(payload.identity_source, 'ads_library_url');
  assert.equal(payload.api_result_status, 'no_ads_returned');
  assert.equal(payload.library_url, libraryUrl);
  assert.equal(payload.error_code, null);
}

function testManualGoogleAdsIdentityCanBeSavedAndCleared() {
  const identity = __testing.googleAdsIdentityFromPayload({
    google_ads_advertiser_url: 'https://adstransparency.google.com/advertiser/AR-CLINICA-123',
  });
  assert.equal(identity.advertiser_id, 'AR-CLINICA-123');
  const stored = __testing.withGoogleAdsIdentityInRawPayload({ source: 'places' }, identity);
  assert.equal(stored.clinicaclick_google_ads.advertiser_id, 'AR-CLINICA-123');

  const clearedIdentity = __testing.googleAdsIdentityFromPayload({
    raw_place_payload: stored,
    google_ads_advertiser_id: null,
    google_ads_advertiser_url: null,
  });
  const cleared = __testing.withGoogleAdsIdentityInRawPayload(stored, clearedIdentity);
  assert.equal(Object.hasOwn(cleared, 'clinicaclick_google_ads'), false);
  assert.equal(cleared.source, 'places');
}

function testLegacyCompletedZeroWithoutPageIsReadAsUnresolved() {
  const payload = __testing.adSnapshotPayload({
    status: 'completed',
    ads_count: 0,
    active_ads: [],
    raw_payload: {
      clinicaclick_resolution: { page: null, fallback_filtered: true },
    },
  });
  assert.equal(payload.ads_status, 'identity_unresolved');
  assert.equal(payload.error_code, 'META_PAGE_IDENTITY_UNRESOLVED');
  assert.equal(payload.active_ads_count, 0);
}

function testOptionalProviderFailuresStayPartialWhenPlacesSucceeded() {
  const outcome = __testing.summarizeCompetitorRefreshOutcome({
    places: { status: 'completed' },
    meta_ads_library: {
      status: 'identity_unresolved',
      error: { message: 'Identidad de Meta pendiente' },
    },
    google_ads_transparency: {
      status: 'unavailable',
      error: { message: 'Límite temporal del proveedor' },
    },
  });
  assert.equal(outcome.status, 'partial_error');
  assert.equal(outcome.error, 'Identidad de Meta pendiente');

  const failed = __testing.summarizeCompetitorRefreshOutcome({
    places: { status: 'unavailable', error: { message: 'Places no disponible' } },
    meta_ads_library: { status: 'unavailable' },
    google_ads_transparency: { status: 'skipped' },
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Places no disponible');
}

async function run() {
  testAdsLibraryUrlProvidesCanonicalPageIdentity();
  testVanityDiscoveryNeverErasesAnExplicitPageId();
  testCanonicalBrandFragmentsAreSearchedBeforeTheLongListingName();
  testPublicFacebookMetadataSuppliesTheExactBrandTerm();
  await testBrandFragmentResolvesTheCanonicalAdsLibraryPage();
  await testHistoricalAdsResolvePageBeforeActiveLookup();
  testUnresolvedIdentityIsNotReportedAsZeroActiveAds();
  testResolvedPageWithNoActiveAdsIsAValidZero();
  testResolvedPageWithNoApiRowsKeepsItsCanonicalIdentity();
  testManualGoogleAdsIdentityCanBeSavedAndCleared();
  testLegacyCompletedZeroWithoutPageIsReadAsUnresolved();
  testOptionalProviderFailuresStayPartialWhenPlacesSucceeded();
  console.log('marketing_competition_meta_identity.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
