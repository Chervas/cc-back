'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
const history = require('../../services/googleReviewHistory.service');
const heatmaps = require('../../lib/review-response-heatmaps');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Sequelize = S;
  const qi = sql.getQueryInterface();
  await sql.query(`CREATE TABLE BusinessProfileCacheStates (resource_key CHAR(64) PRIMARY KEY,
    epoch CHAR(36) NOT NULL,observation_ref CHAR(36),pending_count INT NOT NULL DEFAULT 0)`);
  models.BusinessProfileCacheState = require('../../../models/businessprofilecachestate')(sql, S.DataTypes);
  models.ClinicBusinessLocation = sql.define('ClinicBusinessLocation', {
    id: { type: S.DataTypes.INTEGER, primaryKey: true }, clinica_id: S.DataTypes.INTEGER,
    google_connection_id: { type: S.DataTypes.INTEGER, defaultValue: 1 },
    is_active: { type: S.DataTypes.BOOLEAN, defaultValue: true },
    location_id: S.DataTypes.STRING, raw_payload: S.DataTypes.JSON,
  }, { tableName: 'ClinicBusinessLocations', timestamps: false });
  await models.ClinicBusinessLocation.sync();
  models.BusinessProfileReview = require('../../../models/businessprofilereview')(sql, S.DataTypes);
  await models.BusinessProfileReview.sync();
  for (const field of ['first_seen_at', 'last_seen_at', 'google_missing_at']) await qi.removeColumn('BusinessProfileReviews', field);
  await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) PRIMARY KEY)');
  const operator = require('../google-review-observations-schema-release');
  const connection = { query: (query, values = []) => sql.query(query, { replacements: values }) };
  const before = await operator.capture(connection);
  await require('../../../migrations/20261015100000-preserve-google-review-observations').up(operator.boundedInterface(connection), S);
  operator.verify(before, await operator.capture(connection));
  const invalid = await operator.capture(connection);
  invalid.columns.find(c => c.COLUMN_NAME === 'google_missing_at').IS_NULLABLE = 'NO';
  assert.throws(() => operator.verify(before, invalid), /COLUMN_INVALID/);
  await assert.rejects(operator.boundedInterface(connection).addColumn('Pacientes', 'first_seen_at', { type: S.DATE, allowNull: true }), /UNEXPECTED_DDL/);
  await require('../../../migrations/20261015100000-preserve-google-review-observations').up(qi, S);
  await assert.rejects(require('../../../migrations/20261015100000-preserve-google-review-observations').down(), /Preserve/);
  await sql.query(`CREATE TABLE MarketingPatientLists (id INT PRIMARY KEY,clinica_id INT,objective_id VARCHAR(32),criteria JSON)`);
  await sql.query(`CREATE TABLE MarketingPatientListItems (id INT PRIMARY KEY,list_id INT,clinica_id INT)`);
  await sql.query(`CREATE TABLE MarketingPatientContactEvents (id INT AUTO_INCREMENT PRIMARY KEY,list_id INT,item_id INT,
    event_type VARCHAR(64),created_at DATETIME NOT NULL,payload JSON)`);
  await sql.query(`INSERT INTO MarketingPatientLists VALUES
    (1,59,'mass_sends','{"review_request":true}'),(2,66,'mass_sends','{"review_request":true}')`);
  await sql.query('INSERT INTO MarketingPatientListItems VALUES (1,1,59),(2,2,66),(3,1,59)');
  const receipt = (name, item = 1, clinic = 59, location = 11) => sql.query(`INSERT INTO MarketingPatientContactEvents
    (list_id,item_id,event_type,created_at,payload) VALUES (:list,:item,'google_review_matched','2026-10-02 10:00:00',:payload)`, {
    replacements: { list: clinic === 59 ? 1 : 2, item, payload: JSON.stringify({ review_name: name,
      reviewer_name: 'FICTITIOUS ' + name, star_rating: 5, business_location_id: location }) },
  });
  await receipt('accounts/1/locations/2/reviews/lost');
  await receipt('accounts/1/locations/2/reviews/lost');
  await receipt('foreign', 2, 66, 12);
  await receipt('test', 3);
  await sql.query(`INSERT INTO MarketingPatientContactEvents (list_id,item_id,event_type,created_at,payload)
    VALUES (1,3,'mass_campaign_test_sent',NOW(),JSON_OBJECT())`);
  assert.equal(await history.countHistoricalMatches(models, [59]), 1);
  const legacy = await history.listMissingReviews(models, { clinicIds: [59], locationIds: [11] });
  assert.equal(legacy.total, 1); assert.equal(legacy.items[0].google_missing_at, null);
  assert.equal(legacy.items[0].last_seen_at, null); assert.equal(legacy.items[0].detection_source, 'historical_match');
  assert.equal((await history.listMissingReviews(models, { clinicIds: [], locationIds: [11] })).total, 0);
  report.checks.push('historical conversion survives missing cache; duplicate receipts, tests and foreign scopes do not inflate it; unknown historical dates stay null');

  const location = await models.ClinicBusinessLocation.create({ id: 11, clinica_id: 59,
    location_id: 'locations/2', raw_payload: { accountName: 'accounts/1' } });
  let response = { reviews: [], totalReviewCount: 0 }, fail = false, calls = 0;
  const { metaSyncJobs: jobs } = loadBusinessProfileJobs({ models, broker: { managed: () => false },
    legacyHttp: { get: async () => { calls++; if (fail) throw Error('FICTITIOUS_PROVIDER_FAILURE'); return { data: response }; } },
    matching: async () => {},
  });
  const review = await models.BusinessProfileReview.create({ clinica_id: 59, business_location_id: 11,
    review_name: 'accounts/1/locations/2/reviews/lost', reviewer_name: 'FICTITIOUS lost', star_rating: 5,
    comment: 'Preserve historical comment', matched_contact_event_id: 1,
    first_seen_at: new Date('2026-10-01T10:00:00Z'), last_seen_at: new Date('2026-10-02T10:00:00Z') });
  const sync = options => jobs._syncBusinessProfileReviews(location, 'FICTITIOUS_NOT_A_CREDENTIAL', options);
  await sync(); await review.reload();
  assert(review.google_missing_at); assert.equal(review.matched_contact_event_id, 1);
  assert.equal(review.comment, 'Preserve historical comment');
  assert.equal(await history.countHistoricalMatches(models, [59]), 1);
  const missing = await history.listMissingReviews(models, { clinicIds: [59], locationIds: [11] });
  assert.equal(missing.total, 1); assert.equal(missing.items[0].detection_source, 'complete_google_sync');
  assert(missing.items[0].google_missing_at); assert(missing.items[0].last_seen_at);
  const firstMissing = review.google_missing_at.getTime(); await sync(); await review.reload();
  assert.equal(review.google_missing_at.getTime(), firstMissing);
  response = { reviews: [{ name: review.review_name, reviewer: { displayName: review.reviewer_name }, starRating: 'FIVE' }], totalReviewCount: 1 };
  await sync(); await review.reload(); assert.equal(review.google_missing_at, null);
  assert.equal(review.first_seen_at.toISOString(), '2026-10-01T10:00:00.000Z');
  assert(review.last_seen_at > new Date('2026-10-02')); assert.equal(review.matched_contact_event_id, 1);
  assert.equal((await history.listMissingReviews(models, { clinicIds: [59], locationIds: [11] })).total, 0);
  const alias = await models.BusinessProfileReview.create({ clinica_id: 59, business_location_id: 11,
    review_name: 'lost', google_missing_at: new Date(), reviewer_name: 'FICTITIOUS alias' });
  assert.equal((await history.listMissingReviews(models, { clinicIds: [59], locationIds: [11] })).total, 0,
    'an alternate resource-name form cannot label a currently visible review as missing');
  await alias.destroy();
  report.checks.push('complete empty feed archives without deleting or losing attribution; repeated absence keeps first detection; unchanged reappearance clears absence and advances last-seen');

  response = { reviews: [], totalReviewCount: 1, nextPageToken: 'FICTITIOUS_PAGE' };
  await sync({ maxPages: 1 }); await review.reload(); assert.equal(review.google_missing_at, null);
  response = { reviews: [], totalReviewCount: 0 }; await sync({ enqueueOnlyNewReviews: true });
  await review.reload(); assert.equal(review.google_missing_at, null);
  response = { reviews: [], totalReviewCount: 1 }; await sync(); await review.reload(); assert.equal(review.google_missing_at, null);
  fail = true; await assert.rejects(sync(), /FICTITIOUS_PROVIDER_FAILURE/); fail = false;
  await review.reload(); assert.equal(review.google_missing_at, null);
  report.checks.push('partial, incremental, count-inconsistent and failed observations never mark absence');

  await receipt('second');
  const page = await history.listMissingReviews(models, { clinicIds: [59], locationIds: [11], limit: 1, offset: 1 });
  assert.equal(page.total, 1); assert.equal(page.items.length, 0);
  const map = heatmaps.buildReviewResponseHeatmaps([{ season: 'other', weekday: 3, hour: 11, total: 4 },
    { season: 'summer', weekday: 3, hour: 11, total: 2 }, { season: 'winter', weekday: 0, hour: 9, total: 1 }]);
  assert.equal(map.all.total, 7); assert.equal(map.all.series[3].data[11].y, 6);
  assert.equal(map.summer.total, 2); assert.equal(map.winter.total, 1);
  assert.equal(calls > 0, true);
  report.checks.push('paginated history is bounded and scoped; all-year heatmap includes October and adds shared bins without losing seasonal comparisons');
}).catch(error => { console.error(error); process.exitCode = 1; });
