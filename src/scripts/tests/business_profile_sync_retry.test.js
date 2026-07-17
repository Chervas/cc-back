'use strict';

const assert = require('assert/strict');
const { Op } = require('sequelize');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
const db = require('../../../models');
const {
  MetaSyncJobs,
  metaSyncJobs,
  __test,
} = require('../../jobs/sync.jobs');
const jobExecutor = require('../../services/jobExecutor.service');

const NOW_MS = new Date('2026-07-15T12:00:00.000Z').getTime();
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};

function buildConnection(overrides = {}) {
  const updates = [];
  const connection = {
    accessToken: 'still-valid',
    refreshToken: 'refresh-token',
    expiresAt: new Date(NOW_MS + 60 * 60 * 1000),
    async update(patch) {
      updates.push(patch);
      Object.assign(this, patch);
    },
    ...overrides,
  };
  return { connection, updates };
}

function testBusinessProfileMetricMissingValueIsNotZero() {
  assert.equal(__test.googleBusinessMetricPointValue({ value: { value: '0' } }), 0);
  assert.equal(__test.googleBusinessMetricPointValue({ value: { value: '12' } }), 12);
  assert.equal(__test.googleBusinessMetricPointValue({ value: {} }), null);
  assert.equal(__test.googleBusinessMetricPointValue({}), null);
  assert.equal(__test.googleBusinessMetricPointValue({ value: 'invalid' }), null);
}

async function testAccessTokenRefreshContract() {
  {
    const { connection, updates } = buildConnection();
    let posts = 0;
    const token = await __test.ensureGoogleConnectionAccessToken(connection, {
      nowMs: NOW_MS,
      env: GOOGLE_ENV,
      httpClient: { post: async () => { posts += 1; } },
    });
    assert.equal(token, 'still-valid');
    assert.equal(posts, 0);
    assert.equal(updates.length, 0);
  }

  for (const [label, overrides] of [
    ['missing access token', { accessToken: null }],
    ['missing expiry', { expiresAt: null }],
    ['expired access token', { expiresAt: new Date(NOW_MS - 1000) }],
  ]) {
    const { connection, updates } = buildConnection(overrides);
    let request = null;
    const token = await __test.ensureGoogleConnectionAccessToken(connection, {
      nowMs: NOW_MS,
      env: GOOGLE_ENV,
      httpClient: {
        post: async (url, body, config) => {
          request = { url, body, config };
          return { data: { access_token: `renewed-${label}`, expires_in: 1800 } };
        },
      },
    });
    assert.equal(token, `renewed-${label}`);
    assert.match(request.url, /oauth2\.googleapis\.com\/token$/);
    assert.match(request.body, /grant_type=refresh_token/);
    assert.match(request.body, /refresh_token=refresh-token/);
    assert.equal(request.config.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].accessToken, `renewed-${label}`);
    assert.equal(updates[0].expiresAt.toISOString(), new Date(NOW_MS + 1800 * 1000).toISOString());
  }

  await assert.rejects(
    () => __test.ensureGoogleConnectionAccessToken(
      buildConnection({ accessToken: null, refreshToken: null }).connection,
      { nowMs: NOW_MS, env: GOOGLE_ENV, httpClient: { post: async () => ({}) } }
    ),
    /no tiene refreshToken/
  );

  await assert.rejects(
    () => __test.ensureGoogleConnectionAccessToken(
      buildConnection({ expiresAt: new Date(NOW_MS - 1000) }).connection,
      {
        nowMs: NOW_MS,
        env: GOOGLE_ENV,
        httpClient: { post: async () => ({ data: { expires_in: 3600 } }) },
      }
    ),
    /no devolvió un access_token válido/
  );
}

function buildLocation(id) {
  const updates = [];
  return {
    id,
    location_id: `locations/${id}`,
    clinica_id: 66,
    google_connection_id: 9,
    updates,
    async update(patch) {
      updates.push(patch);
      Object.assign(this, patch);
    },
  };
}

async function withBusinessProfilePersistence(locations, callback) {
  const originalFindAll = db.ClinicBusinessLocation.findAll;
  const originalCreate = db.SyncLog.create;
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const syncLogUpdates = [];
  db.ClinicBusinessLocation.findAll = async () => locations;
  db.SyncLog.create = async () => ({
    id: 701,
    update: async (patch) => syncLogUpdates.push(patch),
  });
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
  try {
    await callback(syncLogUpdates);
  } finally {
    db.ClinicBusinessLocation.findAll = originalFindAll;
    db.SyncLog.create = originalCreate;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
}

async function assertDurableJobFailure(jobType, result) {
  const method = jobType === 'business_profile_recent'
    ? 'executeBusinessProfileSync'
    : 'executeBusinessProfileReviewsSync';
  const original = metaSyncJobs[method];
  metaSyncJobs[method] = async () => result;
  try {
    const normalized = await jobExecutor.runJob({ id: 999, type: jobType, payload: {} });
    assert.equal(normalized.status, 'failed');
    assert.equal(normalized.retryable, true);
    assert.equal(normalized.syncLogId, 701);
    assert.equal(normalized.result.report.failedLocations, 1);
    assert.match(normalized.error.message, /1 de 2 ubicaciones/);
  } finally {
    metaSyncJobs[method] = original;
  }
}

async function testBusinessProfileSyncRetriesWhenOneLocationFails() {
  const locations = [buildLocation(1), buildLocation(2)];
  await withBusinessProfilePersistence(locations, async (syncLogUpdates) => {
    const jobs = new MetaSyncJobs();
    jobs.config.local.betweenLocationsSleepMs = 0;
    jobs._ensureGoogleAccessToken = async () => ({ accessToken: 'token' });
    jobs._syncBusinessProfileLocationDetails = async () => ({});
    jobs._syncBusinessProfileVoiceOfMerchantState = async () => ({ hasVoiceOfMerchant: true });
    jobs._syncBusinessProfileMetrics = async (location) => {
      if (location.id === 2) throw new Error('metrics provider unavailable');
      return 3;
    };
    jobs._syncBusinessProfileReviews = async () => 1;
    jobs._syncBusinessProfilePosts = async () => 2;
    jobs._syncBusinessProfileMedia = async () => 4;
    jobs._mergeBusinessProfileLocation = async () => {};

    const result = await jobs.executeBusinessProfileSync();
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, true);
    assert.equal(result.syncLogId, 701);
    assert.equal(result.processed, 1);
    assert.equal(result.report.failedLocations, 1);
    assert.equal(result.report.errors.length, 1);
    assert.match(result.error_message, /1 de 2 ubicaciones/);
    assert.deepEqual(locations[1].updates, [{ sync_status: 'error' }]);
    assert.equal(syncLogUpdates.at(-1).status, 'failed');
    assert.equal(syncLogUpdates.at(-1).records_processed, 1);
    assert.equal(syncLogUpdates.at(-1).status_report, result.report);
    assert.equal(syncLogUpdates.at(-1).error_message, result.error_message);
    await assertDurableJobFailure('business_profile_recent', result);
  });
}

async function testBusinessProfileSyncRetriesOnPartialLocation() {
  const locations = [buildLocation(1), buildLocation(2)];
  await withBusinessProfilePersistence(locations, async (syncLogUpdates) => {
    const jobs = new MetaSyncJobs();
    jobs.config.local.betweenLocationsSleepMs = 0;
    jobs._ensureGoogleAccessToken = async () => ({ accessToken: 'token' });
    jobs._syncBusinessProfileVoiceOfMerchantState = async () => ({ hasVoiceOfMerchant: true });
    jobs._syncBusinessProfileLocationDetails = async (location) => {
      if (location.id === 2) throw new Error('details provider unavailable');
      return {};
    };
    jobs._syncBusinessProfileMetrics = async () => 3;
    jobs._syncBusinessProfileReviews = async () => 1;
    jobs._syncBusinessProfilePosts = async () => 2;
    jobs._syncBusinessProfileMedia = async () => 4;
    jobs._mergeBusinessProfileLocation = async () => {};

    const result = await jobs.executeBusinessProfileSync();
    assert.equal(result.status, 'failed');
    assert.equal(result.processed, 2);
    assert.equal(result.report.failedLocations, 1);
    assert.equal(result.report.errors[0].section, 'details');
    assert.equal(syncLogUpdates.at(-1).status, 'failed');
  });
}

async function testBusinessProfileReviewsSyncRetriesWhenOneLocationFails() {
  const locations = [buildLocation(1), buildLocation(2)];
  await withBusinessProfilePersistence(locations, async (syncLogUpdates) => {
    const jobs = new MetaSyncJobs();
    const locationMerges = [];
    jobs.config.local.betweenLocationsSleepMs = 0;
    jobs._ensureGoogleAccessToken = async () => ({ accessToken: 'token' });
    jobs._syncBusinessProfileReviews = async (location) => {
      if (location.id === 2) throw new Error('reviews provider unavailable');
      return 5;
    };
    jobs._mergeBusinessProfileLocation = async (location, rawPatch, columnPatch = {}) => {
      locationMerges.push({ locationId: location.id, rawPatch, columnPatch });
    };

    const result = await jobs.executeBusinessProfileReviewsSync();
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, true);
    assert.equal(result.syncLogId, 701);
    assert.equal(result.processed, 1);
    assert.equal(result.report.failedLocations, 1);
    assert.equal(result.report.errors.length, 1);
    assert.match(result.error_message, /1 de 2 ubicaciones/);
    assert.equal(syncLogUpdates.at(-1).status, 'failed');
    assert.equal(syncLogUpdates.at(-1).status_report, result.report);
    assert.equal(locations[0].updates.length, 0);
    assert.equal(locations[1].updates.length, 0);
    assert.equal(locationMerges.length, 2);
    assert.equal(locationMerges[0].rawPatch.clinicaclick_reviews_sync_status, 'completed');
    assert.equal(locationMerges[1].rawPatch.clinicaclick_reviews_sync_status, 'error');
    assert.deepEqual(locationMerges[0].columnPatch, {});
    assert.deepEqual(locationMerges[1].columnPatch, {});
    await assertDurableJobFailure('business_profile_reviews_recent', result);
  });
}

async function testOldReviewsStopBeingNewWithoutProviderChanges() {
  const originalUpdate = db.BusinessProfileReview.update;
  let received = null;
  db.BusinessProfileReview.update = async (values, options) => {
    received = { values, options };
    return [3];
  };
  try {
    const jobs = new MetaSyncJobs();
    const now = new Date('2026-07-15T12:00:00.000Z');
    const affected = await jobs._expireOldBusinessProfileReviews({ id: 77 }, now);
    assert.equal(affected, 3);
    assert.deepEqual(received.values, { is_new: false });
    assert.equal(received.options.where.business_location_id, 77);
    assert.equal(received.options.where.is_new, true);
    assert.equal(
      received.options.where.create_time[Op.lt].toISOString(),
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );
  } finally {
    db.BusinessProfileReview.update = originalUpdate;
  }
}

async function testTargetedBackfillPropagatesEveryInternalFailure() {
  const jobs = new MetaSyncJobs();
  const calls = [];
  jobs.executeBusinessProfileBackfill = async ({ clinicId, locationIds }) => {
    calls.push({ clinicId: Number(clinicId), locationIds });
    if (Number(clinicId) === 65) {
      return {
        status: 'completed',
        processed: 1,
        syncLogId: 500,
        report: { locations: 1, processed: 1, errors: [] },
      };
    }
    if (Number(clinicId) === 66) {
      return {
        status: 'failed',
        retryable: true,
        processed: 1,
        syncLogId: 501,
        report: {
          locations: 2,
          processed: 1,
          metricRows: 3,
          errors: [{ clinicaId: 66, locationId: 'locations/b', message: 'provider error' }],
        },
      };
    }
    if (Number(clinicId) === 67) {
      return {
        status: 'completed',
        processed: 0,
        syncLogId: 502,
        report: {
          locations: 1,
          processed: 0,
          errors: [{ clinicaId: 67, locationId: 'locations/c', message: 'legacy partial' }],
        },
      };
    }
    return {
      status: 'completed',
      retryable: true,
      processed: 0,
      syncLogId: 503,
      report: { locations: 1, processed: 0, errors: [] },
    };
  };

  const mappings = [
    { clinicId: 65, locationId: 'locations/ok' },
    { clinicId: 66, locationId: 'locations/a' },
    { clinicId: 66, locationId: 'locations/b' },
    { clinicId: 67, locationId: 'locations/c' },
    { clinicId: 68, locationId: 'locations/d' },
  ];
  const result = await jobs.executeBusinessProfileBackfillForLocations(mappings);
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(result.syncLogId, 501);
  assert.equal(result.processed, 2);
  assert.match(result.error_message, /3 mappings terminaron con errores/);
  assert.deepEqual(result.report.syncLogIds, [500, 501, 502, 503]);
  assert.deepEqual(result.report.failedSyncLogIds, [501, 502, 503]);
  assert.deepEqual(result.report.failedMappings, [
    { clinicId: 66, locationId: 'locations/b' },
    { clinicId: 67, locationId: 'locations/c' },
    { clinicId: 68, locationId: 'locations/d' },
  ]);
  assert.deepEqual(calls, [
    { clinicId: 65, locationIds: ['locations/ok'] },
    { clinicId: 66, locationIds: ['locations/a', 'locations/b'] },
    { clinicId: 67, locationIds: ['locations/c'] },
    { clinicId: 68, locationIds: ['locations/d'] },
  ]);

  const original = metaSyncJobs.executeBusinessProfileBackfillForLocations;
  metaSyncJobs.executeBusinessProfileBackfillForLocations = async () => result;
  try {
    const normalized = await jobExecutor.runJob({
      id: 1000,
      type: 'business_profile_backfill_locations',
      payload: { mappings },
    });
    assert.equal(normalized.status, 'failed');
    assert.equal(normalized.retryable, true);
    assert.equal(normalized.syncLogId, 501);
    assert.equal(normalized.result.report.failedMappings.length, 3);
  } finally {
    metaSyncJobs.executeBusinessProfileBackfillForLocations = original;
  }
}

async function run() {
  testBusinessProfileMetricMissingValueIsNotZero();
  await testAccessTokenRefreshContract();
  await testBusinessProfileSyncRetriesWhenOneLocationFails();
  await testBusinessProfileSyncRetriesOnPartialLocation();
  await testBusinessProfileReviewsSyncRetriesWhenOneLocationFails();
  await testOldReviewsStopBeingNewWithoutProviderChanges();
  await testTargetedBackfillPropagatesEveryInternalFailure();
  console.log('business_profile_sync_retry.test.js: OK');
}

async function closeTestResources() {
  if (db.sequelize && typeof db.sequelize.close === 'function') {
    await db.sequelize.close();
  }
}

run()
  .then(async () => {
    await closeTestResources();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try {
      await closeTestResources();
    } catch (closeError) {
      console.error(closeError);
    }
    process.exit(1);
  });
