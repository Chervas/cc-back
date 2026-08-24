'use strict';

const assert = require('node:assert/strict');
const axios = require('axios');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.COMPETITION_PLACES_CACHE_TTL_MS = '0';
process.env.COMPETITION_GOOGLE_PLACES_COMPETITOR_USE_ALLOWED = 'true';
process.env.COMPETITION_GOOGLE_PLACES_COMPETITOR_STORAGE_ALLOWED = 'true';

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

async function testSuggestionCenterFallsBackToOwnPlaceDetails() {
  const originalGet = axios.get;
  const getCalls = [];
  axios.get = async (url, config) => {
    getCalls.push({ url, config });
    return {
      data: {
        id: 'own-hospitalet-place',
        displayName: { text: 'Propdental Hospitalet' },
        location: { latitude: 41.3661, longitude: 2.1162 },
      },
    };
  };

  try {
    const center = await __testing.resolveCompetitionSuggestionCenter({
      nombre_clinica: 'Propdental Hospitalet',
      business_place_id: 'own-hospitalet-place',
      business_latitude: null,
      business_longitude: null,
    });

    assert.deepEqual(center, { latitude: 41.3661, longitude: 2.1162 });
    assert.equal(getCalls.length, 1);
    assert.match(getCalls[0].url, /\/places\/own-hospitalet-place$/);
  } finally {
    axios.get = originalGet;
  }
}

function testAutomaticQueryUsesBusinessProfileLocality() {
  assert.equal(
    __testing.inferCompetitionQuery({
      configuracion: { disciplinas: ['dental'] },
      ciudad: '',
      provincia: '',
      codigo_postal: '',
      direccion: '',
      business_locality: "L'Hospitalet de Llobregat",
      business_administrative_area: 'Catalunya',
      business_postal_code: '08901',
    }),
    "clínica dental en L'Hospitalet de Llobregat, Catalunya, 08901",
  );
}

function testBusinessProfileCategoryWinsOverSecondaryClinicDiscipline() {
  const clinic = {
    business_primary_category: 'Clínica de cirugía plástica',
    business_location_name: 'BS Medical - Cirugía y Medicina Estética',
    ciudad: 'Alicante',
    configuracion: { disciplinas: ['estetica', 'nutricion', 'cirugia_digestiva'] },
  };
  assert.deepEqual(__testing.rankingTermsForClinic(clinic), [
    'clínica estética en Alicante',
    'medicina estética en Alicante',
    'cirugía plástica en Alicante',
  ]);
  const relevance = __testing.competitorRelevanceForClinic({
    name: 'SEA Clinic | Medicina estética y Cirugía Plástica Alicante',
    google: { primary_category: 'Clínica estética' },
  }, clinic);
  assert.equal(relevance.status, 'match');
  assert.match(relevance.label, /medicina estética\/cirugía plástica/);
  assert.doesNotMatch(relevance.label, /digestiva|hepatobiliar/);
}

function testDefaultHeatmapSearchUsesNaturalNearMeLanguage() {
  const clinic = {
    business_primary_category: 'Clínica de cirugía plástica',
    business_location_name: 'BS Medical - Cirugía y Medicina Estética',
    ciudad: 'Alicante (Alacant)',
    configuracion: { disciplinas: ['estetica'] },
  };

  expectNaturalHeatmapSearch(clinic, 'clínica estética cerca de mí', 'clínica estética');
}

function testLocalizedNearMeLabelsNeverReachTheProvider() {
  const clinic = { ciudad: 'Alicante (Alacant)', provincia: 'Alicante' };
  assert.equal(__testing.heatmapSearchTermForClinic('aesthetic clinic near me', clinic), 'aesthetic clinic');
  assert.equal(__testing.heatmapSearchTermForClinic('clínica estètica a prop meu', clinic), 'clínica estètica');
}

function testHistoricalSavedHeatmapSearchExposesItsCurrentEffectiveTerm() {
  const clinic = {
    ciudad: 'Alicante (Alacant)',
    provincia: 'Alicante',
  };
  const mapped = __testing.mapSavedHeatmapSearchForClinic({
    id: 91,
    search_term: 'medicina estética en Alicante (Alacant)',
    effective_term: 'medicina estética en Alicante (Alacant)',
    zoom_km: 3,
  }, clinic);

  assert.equal(mapped.term, 'medicina estética en Alicante (Alacant)');
  assert.equal(mapped.effective_term, 'medicina estética');
  assert.equal(mapped.zoom_km, 3);
}

function expectNaturalHeatmapSearch(clinic, expectedDisplay, expectedProviderTerm) {
  const displayTerm = __testing.defaultLocalHeatmapTermForClinic(clinic);
  assert.equal(displayTerm, expectedDisplay);
  assert.equal(__testing.heatmapSearchTermForClinic(displayTerm, clinic), expectedProviderTerm);
}

async function testManualGoogleUrlGeneratesPersistedClinicIdentity() {
  const persisted = [];
  const resolved = await __testing.ensureClinicLocalProfileUrlIdentity({
    id_clinica: 78,
    nombre_clinica: 'Clínica Arcos',
    url_web: 'https://clinicaarcos.es',
    url_ficha_local: 'https://share.google/NjK7I57llkX3CbbUD',
    ciudad: '',
    provincia: '',
    codigo_postal: '',
    direccion: '',
    configuracion: { disciplinas: ['dental'] },
    business_place_id: null,
  }, {
    resolveProfile: async () => ({
      source: 'google_profile_url',
      source_url: 'https://share.google/NjK7I57llkX3CbbUD',
      resolved_url: 'https://www.google.com/search?q=Cl%C3%ADnica+Arcos',
      google_entity_id: '/g/11hq_1g535',
      place_id: 'ChIJ-clinica-arcos-almeria',
      name: 'Clínica Arcos',
      maps_url: 'https://maps.google.com/?cid=123',
      primary_category: 'Clínica dental',
      address: 'C. José Artés de Arcos, 4, 04004 Almería, España',
      locality: 'Almería',
      administrative_area: 'Almería',
      postal_code: '04004',
      country: 'ES',
      latitude: 36.838,
      longitude: -2.459,
    }),
    persistResolution: async (...args) => {
      persisted.push(args);
      return {
        ciudad: 'Almería',
        provincia: 'Almería',
        codigo_postal: '04004',
        direccion: 'C. José Artés de Arcos, 4, 04004 Almería, España',
        configuracion: { disciplinas: ['dental'] },
      };
    },
  });

  assert.equal(persisted.length, 1);
  assert.equal(resolved.business_place_id, 'ChIJ-clinica-arcos-almeria');
  assert.equal(resolved.business_locality, 'Almería');
  assert.equal(resolved.business_primary_category, 'Clínica dental');
  assert.deepEqual(__testing.rankingTermsForClinic(resolved), [
    'clínica dental en Almería',
    'dentista en Almería',
    'implantes dentales en Almería',
  ]);
}

async function run() {
  try {
    await testSuggestionSearchUsesLightweightSingleRequest();
    await testSuggestionCenterFallsBackToOwnPlaceDetails();
    testAutomaticQueryUsesBusinessProfileLocality();
    testBusinessProfileCategoryWinsOverSecondaryClinicDiscipline();
    testDefaultHeatmapSearchUsesNaturalNearMeLanguage();
    testLocalizedNearMeLabelsNeverReachTheProvider();
    testHistoricalSavedHeatmapSearchExposesItsCurrentEffectiveTerm();
    await testManualGoogleUrlGeneratesPersistedClinicIdentity();
    console.log('marketing_competition_suggestions_efficiency.test.js OK');
  } finally {
    await db.sequelize.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
