'use strict';

const assert = require('node:assert/strict');
const axios = require('axios');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.COMPETITION_PLACES_CACHE_TTL_MS = '0';

const db = require('../../../models');
const { __testing } = require('../../services/marketingCompetition.service');

const EXPECTED_SUGGESTION_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.googleMapsUri',
  'places.businessStatus',
];

const FORBIDDEN_SUGGESTION_FIELDS = [
  'places.rating',
  'places.userRatingCount',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.photos',
];

async function testSuggestionSearchUsesLightweightSingleRequest() {
  const originalPost = axios.post;
  const originalGet = axios.get;
  const postCalls = [];
  const getCalls = [];
  const providerPlaces = Array.from({ length: 4 }, (_, index) => ({
    id: `place-${index + 1}`,
    displayName: { text: `Competidor ${index + 1}` },
    formattedAddress: `Calle ${index + 1}, Barcelona`,
    location: { latitude: 41.4 + index / 100, longitude: 2.1 + index / 100 },
    primaryType: 'dentist',
    photos: [{ name: `places/place-${index + 1}/photos/photo-${index + 1}` }],
  })).concat([{
    id: 'place-far',
    displayName: { text: 'Competidor lejano' },
    formattedAddress: 'Oviedo',
    location: { latitude: 43.36, longitude: -5.85 },
    primaryType: 'dentist',
  }]);

  axios.post = async (url, body, config) => {
    postCalls.push({ url, body, config });
    return { data: { places: providerPlaces } };
  };
  axios.get = async (url, config) => {
    getCalls.push({ url, config });
    throw new Error(`Unexpected GET request: ${url}`);
  };

  try {
    const result = await __testing.searchCompetitionSuggestions(
      'clínica dental en Barcelona',
      7,
      { latitude: 41.4, longitude: 2.1 }
    );

    assert.deepEqual(result, providerPlaces.slice(0, 4));
    assert.equal(postCalls.length, 1, 'discovery must use one Places text search');
    assert.equal(getCalls.length, 0, 'discovery must not resolve one photo per result');

    const request = postCalls[0];
    assert.match(request.url, /\/places:searchText$/);
    assert.equal(request.body.textQuery, 'clínica dental en Barcelona');
    assert.equal(request.body.pageSize, 7, 'the requested limit must be sent as pageSize');
    assert.ok(request.body.locationRestriction?.rectangle, 'suggestions must use a strict Text Search viewport');
    const rectangle = request.body.locationRestriction.rectangle;
    assert.ok(rectangle.low.latitude < 41.4 && rectangle.high.latitude > 41.4);
    assert.ok(rectangle.low.longitude < 2.1 && rectangle.high.longitude > 2.1);
    assert.ok(
      __testing.distanceMetersBetween(
        { latitude: 41.4, longitude: 2.1 },
        { latitude: 41.8, longitude: 2.1 }
      ) > 25000,
      'distance filter must reject a far result even if the provider returned it'
    );

    const fieldMask = request.config?.headers?.['X-Goog-FieldMask'];
    assert.equal(fieldMask, __testing.COMPETITION_SUGGESTION_FIELD_MASK);
    assert.deepEqual(fieldMask.split(','), EXPECTED_SUGGESTION_FIELDS);
    for (const forbiddenField of FORBIDDEN_SUGGESTION_FIELDS) {
      assert.equal(
        fieldMask.split(',').includes(forbiddenField),
        false,
        `discovery field mask must not request ${forbiddenField}`
      );
    }

    const photoRequests = [
      ...postCalls.map((call) => call.url),
      ...getCalls.map((call) => call.url),
    ].filter((url) => /\/photos\/|\/media(?:\?|$)/.test(String(url)));
    assert.deepEqual(photoRequests, []);
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
  }
}

async function run() {
  try {
    await testSuggestionSearchUsesLightweightSingleRequest();
    console.log('marketing_competition_suggestions_efficiency.test.js OK');
  } finally {
    await db.sequelize.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
