'use strict';

const assert = require('node:assert/strict');
const {
  GOOGLE_PROFILE_ALLOWED_HOSTS,
  GOOGLE_PROFILE_RESOLUTION_FIELD_MASK,
  followGoogleProfileUrl,
  parseGoogleProfileUrlIdentity,
  resolveGoogleLocalProfileUrl,
  selectGoogleProfilePlace,
} = require('../../services/googleLocalProfileUrlResolver.service');

const SOURCE_URL = 'https://share.google/NjK7I57llkX3CbbUD';
const RESOLVED_URL = 'https://www.google.com/search?kgmid=%2Fg%2F11hq_1g535&q=Cl%C3%ADnica+Arcos';

async function testFollowsOnlyGoogleRedirects() {
  assert.equal(GOOGLE_PROFILE_ALLOWED_HOSTS.has('consent.google.com'), true);
  const calls = [];
  const result = await followGoogleProfileUrl(SOURCE_URL, {
    fetchStep: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return { status: 302, location: 'https://www.google.com/search?q=Cl%C3%ADnica+Arcos' };
      }
      return { status: 200, location: null };
    },
  });
  assert.equal(new URL(result).hostname, 'www.google.com');
  assert.equal(new URL(result).searchParams.get('q'), 'Clínica Arcos');
  assert.equal(calls.length, 2);

  await assert.rejects(
    followGoogleProfileUrl(SOURCE_URL, {
      fetchStep: async () => ({ status: 302, location: 'https://attacker.example/profile' }),
    }),
    (error) => error.code === 'GOOGLE_PROFILE_URL_HOST_NOT_ALLOWED',
  );
}

function testParsesGoogleEntityIdentity() {
  const identity = parseGoogleProfileUrlIdentity(RESOLVED_URL);
  assert.equal(identity.query, 'Clínica Arcos');
  assert.equal(identity.google_entity_id, '/g/11hq_1g535');
  assert.equal(identity.place_id, null);
}

async function testResolvesArcosFromRedirectAndPlaces() {
  let request = null;
  const result = await resolveGoogleLocalProfileUrl({
    url: SOURCE_URL,
    clinicName: 'Clínica Arcos',
    websiteUrl: 'https://clinicaarcos.es',
    apiKey: 'test-key',
  }, {
    followUrl: async () => RESOLVED_URL,
    placesPost: async (url, body, config) => {
      request = { url, body, config };
      return {
        data: {
          places: [
            {
              id: 'ChIJ-clinica-arcos-almeria',
              displayName: { text: 'Clínica Arcos' },
              formattedAddress: 'C. José Artés de Arcos, 4, 04004 Almería, España',
              addressComponents: [
                { longText: 'Almería', shortText: 'Almería', types: ['locality'] },
                { longText: 'Almería', shortText: 'AL', types: ['administrative_area_level_2'] },
                { longText: '04004', shortText: '04004', types: ['postal_code'] },
                { longText: 'España', shortText: 'ES', types: ['country'] },
              ],
              location: { latitude: 36.838, longitude: -2.459 },
              primaryType: 'dentist',
              primaryTypeDisplayName: { text: 'Clínica dental' },
              websiteUri: 'https://clinicaarcos.es/',
              googleMapsUri: 'https://maps.google.com/?cid=123',
              businessStatus: 'OPERATIONAL',
            },
            {
              id: 'ChIJ-other-arcos',
              displayName: { text: 'Clínica Arcos' },
              formattedAddress: 'Buenos Aires, Argentina',
              websiteUri: 'https://dentalarcos.com.ar/',
            },
          ],
        },
      };
    },
  });

  assert.match(request.url, /\/places:searchText$/);
  assert.equal(request.body.textQuery, 'Clínica Arcos');
  assert.equal(request.config.headers['X-Goog-FieldMask'], GOOGLE_PROFILE_RESOLUTION_FIELD_MASK);
  assert.equal(result.place_id, 'ChIJ-clinica-arcos-almeria');
  assert.equal(result.name, 'Clínica Arcos');
  assert.equal(result.primary_category, 'Clínica dental');
  assert.equal(result.locality, 'Almería');
  assert.equal(result.administrative_area, 'Almería');
  assert.equal(result.postal_code, '04004');
  assert.equal(result.country, 'ES');
  assert.equal(result.google_entity_id, '/g/11hq_1g535');
  assert.equal(result.source_url, new URL(SOURCE_URL).toString());
}

function testRejectsAmbiguousNameWithoutWebsiteMatch() {
  assert.throws(
    () => selectGoogleProfilePlace([
      { id: 'one', displayName: { text: 'Clínica Arcos' }, formattedAddress: 'Almería' },
      { id: 'two', displayName: { text: 'Clínica Arcos' }, formattedAddress: 'Madrid' },
    ], {
      clinicName: 'Clínica Arcos',
      redirectedQuery: 'Clínica Arcos',
    }),
    (error) => error.code === 'GOOGLE_PROFILE_URL_AMBIGUOUS',
  );
}

async function run() {
  await testFollowsOnlyGoogleRedirects();
  testParsesGoogleEntityIdentity();
  await testResolvesArcosFromRedirectAndPlaces();
  testRejectsAmbiguousNameWithoutWebsiteMatch();
  console.log('google_local_profile_url_resolver.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
