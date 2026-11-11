'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { Op } = require('sequelize');
const root = path.resolve(__dirname, '../../..');
function evaluate(file, imports) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), { module, exports: module.exports, require: name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error('Unexpected dependency in isolated dashboard test: ' + name);
  }, Date, Map, Set, Reflect, Number, JSON, console }, { filename: file });
  return module.exports;
}
const source = (id, owner, active = true) => ({ id, clinica_id: owner, google_connection_id: 81,
  location_id: 'locations/90071992547409931' + id, location_name: 'FICTITIOUS_SOURCE_' + id, is_active: active,
  broker_read_connection_ref: 'connection:fictitious', broker_read_asset_ref: 'gbp:90071992547409931231:90071992547409931' + id,
  raw_payload: { metadata: { mapsUri: 'https://example.invalid/profile/' + id } } });
const review = (id, mapping, owner, patient = null) => ({ id, business_location_id: mapping, clinica_id: owner,
  review_name: 'locations/fictitious/reviews/' + id, reviewer_name: 'FICTITIOUS_REVIEWER_' + id, star_rating: 5,
  comment: 'FICTITIOUS_PUBLIC_REVIEW', create_time: '2030-01-01T12:00:00Z', has_reply: false, google_missing_at: null,
  matched_paciente_id: patient, match_confidence: patient ? 0.99 : null });
function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    const value = where[key];
    if (key === Op.or) return value.some(clause => matches(row, clause));
    if (key === Op.and) return value.every(clause => matches(row, clause));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (Object.hasOwn(value, Op.in)) return value[Op.in].includes(row[key]);
      if (Object.hasOwn(value, Op.between)) return true;
      throw new Error('Unexpected predicate in fixture');
    }
    return row[key] === value;
  });
}
function fixture() {
  const calls = [];
  const state = {
    clinics: [{ id_clinica: 101, grupoClinicaId: 7, nombre_clinica: 'FICTITIOUS_TARGET' },
      { id_clinica: 102, grupoClinicaId: 7, nombre_clinica: 'FICTITIOUS_SHARED_OWNER' },
      { id_clinica: 103, grupoClinicaId: null, nombre_clinica: 'FICTITIOUS_UNGROUPED' }],
    groups: [{ id_grupo: 7, business_profile_assignment_mode: 'clinic', business_profile_primary_location_id: null }],
    assignments: [], locations: [source(11, 101, false), source(12, 101), source(20, 102), source(30, 999)],
    reviews: [review(501, 11, 101, 77), review(502, 12, 101, 77), review(503, 20, 102, 88), review(504, 30, 999, 99)],
    patients: [{ id_paciente: 77, nombre: 'FICTITIOUS_LOCAL', apellidos: 'PATIENT' },
      { id_paciente: 88, nombre: 'FICTITIOUS_OTHER_OWNER', apellidos: 'PATIENT' }], fail: null,
  };
  const models = { Sequelize: { Op } };
  for (const [name, key] of [['Clinica', 'clinics'], ['GrupoClinica', 'groups'], ['GroupAssetClinicAssignment', 'assignments'],
    ['ClinicBusinessLocation', 'locations'], ['BusinessProfileReview', 'reviews'], ['Paciente', 'patients']]) {
    models[name] = { async findAll(options = {}) {
      calls.push({ name, operation: 'findAll', options });
      if (state.fail === name) throw Error('FICTITIOUS_DATABASE_UNAVAILABLE');
      return state[key].filter(row => matches(row, options.where)).slice(0, options.limit || Infinity).map(row => ({ ...row }));
    }, async count(options = {}) {
      calls.push({ name, operation: 'count', options });
      return state[key].filter(row => matches(row, options.where)).length;
    } };
  }
  models.LeadIntake = { count: async () => 6 };
  models.PatientConsentDocument = { count: async () => 4 };
  models.CitaPaciente = { count: async () => 2 };
  const canonical = evaluate('src/services/effectiveMarketingAssets.service.js', {
    sequelize: { Op }, '../../models': models, '../lib/metaClient': { metaGet() { throw Error('No provider traffic'); } },
    './scopeConnectionResolver.service': {},
  });
  const time = {
    DEFAULT_TIME_ZONE: 'UTC', resolveClinicTimeZone: () => 'UTC',
    addLocalDays: (date, days) => { const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); },
    localDateTimeToUtc: (date, clock) => new Date(date + 'T' + clock + 'Z'),
  };
  const dashboard = evaluate('src/services/panelesDashboard.service.js', {
    '../../models': models, '../lib/personal-schedule-recurring': { normalizeDateOnly: value => value },
    '../lib/role-helpers': { isGlobalAdmin: () => false }, '../lib/access-policy': {}, './clinicOpeningHours.service': time,
    './personalPresence.service': {}, './personalScheduleSharing.service': {}, './whatsappPaymentStatus.service': {},
    './effectiveMarketingAssets.service': canonical,
  }).__testing;
  return { state, calls, models, canonical, dashboard,
    clinicMap: new Map(state.clinics.map(clinic => [clinic.id_clinica, clinic])),
    metadataCalls: () => calls.filter(row => ['Clinica', 'GrupoClinica', 'GroupAssetClinicAssignment'].includes(row.name)
      || row.name === 'ClinicBusinessLocation' && row.options.attributes.includes('google_connection_id')) };
}
test('dashboard counters and actionable review cards exclude retired history without deleting it', async () => {
  const f = fixture(), sources = await f.dashboard.resolveDashboardReviewSources([101]);
  assert.deepEqual([...sources.locationIds], [12]);
  const counts = await f.dashboard.countTasks({ clinicIds: [101], clinicMap: f.clinicMap, todayDate: '2030-01-01', reviewSources: sources });
  const cards = await f.dashboard.loadUnansweredReviewCards({ clinicIds: [101], clinicMap: f.clinicMap, reviewSources: sources });
  await sources.validate();
  assert.equal(counts.pendingReviews, 1); assert.equal(counts.leadsPending, 6); assert.equal(counts.pendingConsents, 4); assert.equal(counts.unconfirmedToday, 2);
  assert.deepEqual(cards.map(row => row.reviewId), [502]); assert.equal(cards[0].businessLocationId, 12);
  assert.equal(cards[0].queryParams.clinica_id, 101); assert.equal(cards[0].matchedPatientId, 77);
  assert.equal(cards[0].matchedPatientName, 'FICTITIOUS_LOCAL PATIENT');
  assert.equal(f.state.reviews.find(row => row.id === 501).business_location_id, 11);
  assert.equal(f.state.locations.find(row => row.id === 11).is_active, false);
  assert.equal(f.metadataCalls().length, 8);
});
test('an active empty new profile does not produce a card or pending counter from the previous profile', async () => {
  const f = fixture(); f.state.reviews = [review(501, 11, 101)];
  const sources = await f.dashboard.resolveDashboardReviewSources([101]);
  const count = await f.dashboard.countTasks({ clinicIds: [101], clinicMap: f.clinicMap, todayDate: '2030-01-01', reviewSources: sources });
  const cards = await f.dashboard.loadUnansweredReviewCards({ clinicIds: [101], clinicMap: f.clinicMap, reviewSources: sources });
  await sources.validate(); assert.equal(count.pendingReviews, 0); assert.equal(cards.length, 0); assert.equal(f.state.reviews.length, 1);
});
test('an explicit shared profile remains actionable through an authorized consuming clinic without patient enrichment from its owner', async () => {
  const f = fixture(); f.state.assignments = [{ id: 1, assetType: 'google.business_profile', assetId: 20, clinicaId: 101, grupoClinicaId: 7 }];
  const sources = await f.dashboard.resolveDashboardReviewSources([101]);
  const count = await f.dashboard.countTasks({ clinicIds: [101], clinicMap: f.clinicMap, todayDate: '2030-01-01', reviewSources: sources });
  const cards = await f.dashboard.loadUnansweredReviewCards({ clinicIds: [101], clinicMap: f.clinicMap, reviewSources: sources });
  await sources.validate(); assert.equal(count.pendingReviews, 2);
  const shared = cards.find(row => row.reviewId === 503); assert.ok(shared); assert.equal(shared.sourceClinicId, 102);
  assert.equal(shared.clinicId, 101); assert.equal(shared.queryParams.clinica_id, 101);
  assert.equal(shared.matchedPatientId, null); assert.equal(shared.matchedPatientName, null); assert.equal(shared.matchConfidence, null);
  const patientRead = f.calls.find(row => row.name === 'Paciente'); assert.equal(patientRead.options.where.id_paciente, 77);
});
test('shared profiles deduplicate across selected consumers and never include an assignment from another group', async () => {
  const f = fixture(); f.state.assignments = [
    { id: 1, assetType: 'google.business_profile', assetId: 20, clinicaId: 101, grupoClinicaId: 7 },
    { id: 2, assetType: 'google.business_profile', assetId: 30, clinicaId: 101, grupoClinicaId: 8 },
  ];
  const sources = await f.dashboard.resolveDashboardReviewSources([101, 102]);
  assert.deepEqual([...sources.locationIds], [12, 20]);
  const count = await f.dashboard.countTasks({ clinicIds: [101, 102], clinicMap: f.clinicMap, todayDate: '2030-01-01', reviewSources: sources });
  assert.equal(count.pendingReviews, 2);
  const cards = await f.dashboard.loadUnansweredReviewCards({ clinicIds: [101, 102], clinicMap: f.clinicMap, reviewSources: sources });
  assert.equal(cards.filter(row => row.reviewId === 503).length, 1); assert.equal(cards.find(row => row.reviewId === 503).clinicId, 102);
  await sources.validate();
});
test('group primary policy is resolved by the canonical selector and retired primaries cannot contribute', async () => {
  const f = fixture(); f.state.groups[0].business_profile_assignment_mode = 'group'; f.state.groups[0].business_profile_primary_location_id = 20;
  let sources = await f.dashboard.resolveDashboardReviewSources([101]); assert.ok(sources.locationIds.includes(20));
  f.state.locations.find(row => row.id === 20).is_active = false;
  await assert.rejects(sources.validate(), { code: 'dashboard_google_reviews_source_changed', status: 409 });
  sources = await f.dashboard.resolveDashboardReviewSources([101]); assert.equal(sources.locationIds.includes(20), false);
});
test('a reviews-only alias does not replace the general profile used by the dashboard action', async () => {
  const f = fixture(); f.state.clinics[0].configuracion = { reviews: { google_business_profile_alias: { business_location_id: 20, clinic_id: 102 } } };
  const sources = await f.dashboard.resolveDashboardReviewSources([101]); assert.deepEqual([...sources.locationIds], [12]);
  const cards = await f.dashboard.loadUnansweredReviewCards({ clinicIds: [101], clinicMap: f.clinicMap, reviewSources: sources });
  assert.deepEqual(cards.map(row => row.reviewId), [502]); assert.equal(f.state.clinics[0].configuracion.reviews.google_business_profile_alias.business_location_id, 20);
});
test('association or assignment changes while review data is in flight invalidate the response instead of returning old cards', async () => {
  for (const change of ['mapping', 'assignment', 'membership']) {
    const f = fixture(); f.state.assignments = [{ id: 1, assetType: 'google.business_profile', assetId: 20, clinicaId: 101, grupoClinicaId: 7 }];
    const sources = await f.dashboard.resolveDashboardReviewSources([101]);
    await f.dashboard.loadUnansweredReviewCards({ clinicIds: [101], clinicMap: f.clinicMap, reviewSources: sources });
    if (change === 'mapping') f.state.locations.find(row => row.id === 12).is_active = false;
    else if (change === 'assignment') f.state.assignments = [];
    else f.state.clinics[0].grupoClinicaId = null;
    await assert.rejects(sources.validate(), { code: 'dashboard_google_reviews_source_changed', status: 409 });
  }
});
test('missing or unavailable source metadata is not converted into a zero counter', async () => {
  const f = fixture(); f.state.fail = 'ClinicBusinessLocation';
  await assert.rejects(f.dashboard.countTasks({ clinicIds: [101], clinicMap: f.clinicMap, todayDate: '2030-01-01' }), /DATABASE_UNAVAILABLE/);
  assert.equal(f.calls.some(row => row.name === 'BusinessProfileReview'), false);
  f.state.fail = null; f.state.clinics = f.state.clinics.filter(row => row.id_clinica !== 101);
  await assert.rejects(f.dashboard.resolveDashboardReviewSources([101]), { code: 'dashboard_google_reviews_source_changed' });
});
test('an empty allowed clinic scope never expands into an unscoped review query', async () => {
  const f = fixture(); const sources = await f.dashboard.resolveDashboardReviewSources([]);
  assert.equal(sources.locationIds.length, 0); await sources.validate();
  const cards = await f.dashboard.loadUnansweredReviewCards({ clinicIds: [], clinicMap: f.clinicMap, reviewSources: sources });
  assert.equal(cards.length, 0); assert.equal(f.calls.length, 0);
});
test('fifty clinics use one shared GBP-only metadata capture and one final check, independent of clinic count', async () => {
  const f = fixture(); f.state.clinics = []; f.state.locations = []; f.state.reviews = [];
  for (let id = 200; id < 250; id++) { f.state.clinics.push({ id_clinica: id, grupoClinicaId: 7 }); f.state.locations.push(source(id + 1000, id)); }
  const ids = f.state.clinics.map(row => row.id_clinica);
  const sources = await f.dashboard.resolveDashboardReviewSources(ids); assert.equal(sources.locationIds.length, 50);
  assert.equal(f.metadataCalls().length, 4);
  await sources.validate(); assert.equal(f.metadataCalls().length, 8);
  assert.equal(f.calls.some(row => !['Clinica', 'GrupoClinica', 'GroupAssetClinicAssignment', 'ClinicBusinessLocation'].includes(row.name)), false);
});
