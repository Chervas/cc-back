'use strict';

const assert = require('node:assert/strict');

const service = require('../../services/googleAdsTransparencyFast.service');

const {
  advertiserMatchScore,
  candidateDomains,
  candidateTerms,
  normalizeAd,
} = service.__testing;

function testCandidatesStaySmallAndSpecific() {
  const competitor = {
    name: 'BS Medical Alicante',
    website_url: 'https://www.bsmedical.es/tratamientos',
    meta_page_name: 'BS Medical',
    meta_ads_search_terms: ['BS Medical Clinic', 'otra variante que no debe consultarse'],
  };
  assert.deepEqual(candidateDomains(competitor), ['bsmedical.es']);
  assert.deepEqual(candidateTerms(competitor), ['BS Medical Alicante', 'BS Medical']);
  assert.ok(advertiserMatchScore(competitor, 'BS Medical Clinic SL') >= 70);
  assert.equal(advertiserMatchScore(competitor, 'Empresa sin relación'), 0);
}

function testCreativeNormalizationKeepsPublicLinks() {
  const ad = normalizeAd({
    1: 'AR123',
    2: 'CR456',
    4: 1,
    12: 'BS Medical',
    3: { nested: '<img src="https://cdn.example.test/creative.webp">' },
  });
  assert.equal(ad.provider, 'google_ads_transparency');
  assert.equal(ad.advertiser_name, 'BS Medical');
  assert.equal(ad.image_url, 'https://cdn.example.test/creative.webp');
  assert.match(ad.snapshot_url, /AR123\/creative\/CR456/);
}

async function testFastPathIsBoundedAndSequential() {
  const calls = [];
  const http = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('/SearchCreatives') && body?.['3']?.['12']) return { data: { 1: [] } };
      if (url.endsWith('/SearchSuggestions')) {
        return {
          data: {
            1: [{ 1: { 1: 'BS Medical', 2: 'AR123', 3: 'ES' } }],
          },
        };
      }
      return {
        data: {
          1: [{ 1: 'AR123', 2: 'CR456', 4: 4, 12: 'BS Medical' }],
          5: 3,
        },
      };
    },
  };
  const result = await service.fetchForCompetitor({
    id: 1,
    name: 'BS Medical',
    website_url: 'https://bsmedical.es',
  }, { http });
  assert.equal(result.total_ads_count, 3);
  assert.equal(result.ads.length, 1);
  assert.equal(calls.length, 3, 'one domain, one suggestion and one advertiser request');
  assert.match(calls[0].url, /SearchCreatives$/);
  assert.match(calls[1].url, /SearchSuggestions$/);
  assert.match(calls[2].url, /SearchCreatives$/);
}

async function main() {
  testCandidatesStaySmallAndSpecific();
  testCreativeNormalizationKeepsPublicLinks();
  await testFastPathIsBoundedAndSequential();
  console.log('google_ads_transparency_fast.test.js: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
