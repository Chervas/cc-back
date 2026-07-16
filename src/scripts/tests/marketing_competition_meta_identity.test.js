'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const { __testing } = require('../../services/marketingCompetition.service');

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
  await testHistoricalAdsResolvePageBeforeActiveLookup();
  testUnresolvedIdentityIsNotReportedAsZeroActiveAds();
  testResolvedPageWithNoActiveAdsIsAValidZero();
  testLegacyCompletedZeroWithoutPageIsReadAsUnresolved();
  testOptionalProviderFailuresStayPartialWhenPlacesSucceeded();
  console.log('marketing_competition_meta_identity.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
