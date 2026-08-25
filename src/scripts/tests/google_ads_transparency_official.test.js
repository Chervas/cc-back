'use strict';

const assert = require('node:assert/strict');

const service = require('../../services/googleAdsTransparencyOfficial.service');

const {
  buildQuery,
  candidateNamesForCompetitor,
  matchScore,
  normalizeAd,
  parseJsonCredential,
  simpleRows,
} = service.__testing;

function testConfigurationRequiresServerCredential() {
  const missing = service.configuration({
    COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED: 'true',
    GOOGLE_CLOUD_PROJECT: 'clinicaclick',
  });
  assert.equal(missing.enabled, true);
  assert.equal(missing.configured, false);
  assert.equal(missing.credentials, null);

  const credential = JSON.stringify({
    client_email: 'competition-reader@clinicaclick.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n',
    project_id: 'clinicaclick',
  });
  const configured = service.configuration({
    COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED: 'true',
    GOOGLE_BIGQUERY_SERVICE_ACCOUNT_JSON: credential,
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.projectId, 'clinicaclick');
  assert.equal(configured.credentials.client_email, 'competition-reader@clinicaclick.iam.gserviceaccount.com');
  assert.match(configured.credentials.private_key, /\nTEST\n/);
}

function testCredentialParserRejectsIncompleteSecrets() {
  assert.equal(parseJsonCredential('{bad-json'), null);
  assert.equal(parseJsonCredential(JSON.stringify({ project_id: 'clinicaclick' })), null);
}

function testOfficialQueryIsBoundedAndBatched() {
  const query = buildQuery();
  assert.match(query, /bigquery-public-data\.google_ads_transparency_center\.creative_stats/);
  assert.match(query, /UNNEST\(@candidate_names\)/);
  assert.match(query, /UNNEST\(@region_codes\)/);
  assert.match(query, /@lookback_days/);
  assert.match(query, /LIMIT @row_limit/);
  assert.match(query, /STRPOS\(NORMALIZE_AND_CASEFOLD\(candidate\), NORMALIZE_AND_CASEFOLD\(COALESCE\(creative\.advertiser_disclosed_name/);
  assert.doesNotMatch(query, /SearchService|SearchCreatives|SearchSuggestions|\/anji\//);
}

function testCandidateResolutionUsesKnownBusinessIdentities() {
  const competitor = {
    name: 'BS Medical Alicante',
    meta_page_name: 'BS Medical',
    meta_ads_search_terms: ['BS Medical Clinic'],
    raw_place_payload: {
      clinicaclick_social_profiles: { instagram_username: 'bsmedical_alicante' },
    },
  };
  const names = candidateNamesForCompetitor(competitor);
  assert.deepEqual(names, ['BS Medical Alicante', 'BS Medical', 'BS Medical Clinic', 'bsmedical_alicante']);
  assert.equal(matchScore(competitor, 'BS Medical Alicante'), 100);
  assert.ok(matchScore(competitor, 'BS Medical Clinic SL') >= 70);
  assert.equal(matchScore(competitor, 'Otra empresa completamente distinta'), 0);
}

function testBigQueryRowsAndAdsAreNormalizedWithoutScraping() {
  const rows = simpleRows({
    schema: { fields: [{ name: 'advertiser_id' }, { name: 'creative_id' }, { name: 'advertiser_disclosed_name' }] },
    rows: [{ f: [{ v: 'AR123' }, { v: 'CR456' }, { v: 'BS Medical' }] }],
  });
  assert.deepEqual(rows, [{ advertiser_id: 'AR123', creative_id: 'CR456', advertiser_disclosed_name: 'BS Medical' }]);

  const ad = normalizeAd({
    advertiser_id: 'AR123',
    creative_id: 'CR456',
    creative_page_url: 'https://adstransparency.google.com/advertiser/AR123/creative/CR456',
    advertiser_disclosed_name: 'BS Medical',
    ad_format_type: 'IMAGE',
    first_shown: '2026-08-01',
    last_shown: '2026-08-24',
    times_shown_lower_bound: '1000',
    times_shown_upper_bound: '5000',
  });
  assert.equal(ad.provider, 'google_ads_transparency');
  assert.equal(ad.advertiser_name, 'BS Medical');
  assert.equal(ad.impressions_lower_bound, 1000);
  assert.equal(ad.impressions_upper_bound, 5000);
  assert.equal(ad.media_source, 'official_dataset_metadata');
}

async function testEmptyBatchNeverCallsProvider() {
  let calls = 0;
  const result = await service.fetchForCompetitors([{ id: 1, name: 'A' }], {
    config: { enabled: true, configured: false, credentials: null, projectId: null },
    http: {
      get: async () => { calls += 1; },
      post: async () => { calls += 1; },
    },
  });
  assert.equal(result.size, 0);
  assert.equal(calls, 0);
}

async function main() {
  testConfigurationRequiresServerCredential();
  testCredentialParserRejectsIncompleteSecrets();
  testOfficialQueryIsBoundedAndBatched();
  testCandidateResolutionUsesKnownBusinessIdentities();
  testBigQueryRowsAndAdsAreNormalizedWithoutScraping();
  await testEmptyBatchNeverCallsProvider();
  console.log('google_ads_transparency_official.test.js: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
