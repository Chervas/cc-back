'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const {
  DAY_MS,
  OVERVIEW_CACHE_FRESH_TTL_MS,
  OVERVIEW_CACHE_EXPIRES_TTL_MS,
  buildOverviewCacheIdentity,
  overviewCacheStatus,
  createOverviewCacheCoordinator,
} = require('../../services/marketingReportOverviewCache.service');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sameDate(left, right) {
  if (!left && !right) return true;
  return new Date(left).getTime() === new Date(right).getTime();
}

function createFakeCacheModel(seed = []) {
  const rows = new Map(seed.map((row) => [row.cache_key, clone(row)]));

  function matches(row, where) {
    if (!row || row.cache_key !== where.cache_key) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'generated_at') && !sameDate(row.generated_at, where.generated_at)) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(where, 'refresh_lock_token') && row.refresh_lock_token !== where.refresh_lock_token) {
      return false;
    }
    const leaseClauses = where[Op.or];
    if (Array.isArray(leaseClauses)) {
      const available = leaseClauses.some((clause) => {
        if (Object.prototype.hasOwnProperty.call(clause, 'refresh_locked_until') && clause.refresh_locked_until === null) {
          return row.refresh_locked_until === null || row.refresh_locked_until === undefined;
        }
        const deadline = clause.refresh_locked_until?.[Op.lte];
        return deadline && row.refresh_locked_until && new Date(row.refresh_locked_until) <= new Date(deadline);
      });
      if (!available) return false;
    }
    return true;
  }

  return {
    rows,
    async findOne({ where }) {
      return clone(rows.get(where.cache_key) || null);
    },
    async findOrCreate({ where, defaults }) {
      if (rows.has(where.cache_key)) return [clone(rows.get(where.cache_key)), false];
      rows.set(where.cache_key, clone(defaults));
      return [clone(defaults), true];
    },
    async update(values, { where }) {
      const current = rows.get(where.cache_key);
      if (!matches(current, where)) return [0];
      rows.set(where.cache_key, { ...current, ...clone(values) });
      return [1];
    },
  };
}

function range(overrides = {}) {
  return {
    start: new Date('2026-07-30T00:00:00.000Z'),
    end: new Date('2026-08-28T00:00:00.000Z'),
    startLabel: '2026-07-30',
    endLabel: '2026-08-28',
    previous: {
      start: new Date('2026-06-30T00:00:00.000Z'),
      end: new Date('2026-07-29T00:00:00.000Z'),
      startLabel: '2026-06-30',
      endLabel: '2026-07-29',
    },
    ...overrides,
  };
}

function identity(overrides = {}) {
  return buildOverviewCacheIdentity({
    scope: { scope: 'clinic', clinicIds: [66], isAll: false },
    range: range(),
    ...overrides,
  });
}

function cachedRow(cacheIdentity, generatedAt, overrides = {}) {
  return {
    ...cacheIdentity,
    payload: { success: true, marker: 'stored', lastUpdated: generatedAt.toISOString() },
    generated_at: generatedAt,
    data_cutoff_at: generatedAt,
    fresh_until: new Date(generatedAt.getTime() + OVERVIEW_CACHE_FRESH_TTL_MS),
    expires_at: new Date(generatedAt.getTime() + OVERVIEW_CACHE_EXPIRES_TTL_MS),
    refresh_state: 'idle',
    refresh_lock_token: null,
    refresh_locked_until: null,
    ...overrides,
  };
}

function testIdentityIncludesScopeRangeAndVersion() {
  const base = identity();
  assert.equal(base.cache_key.length, 64);
  assert.equal(base.primary_clinic_id, 66);
  assert.equal(base.group_id, null);
  assert.equal(base.period_start, '2026-07-30');
  assert.equal(base.period_end, '2026-08-28');
  assert.equal(
    identity({ scope: { scope: 'clinic', clinicIds: [66], groupId: 28 } }).cache_key,
    base.cache_key,
    'A clinic cache identity must not change when the administrative group id is present'
  );
  assert.notEqual(base.cache_key, identity({ scope: { scope: 'clinic', clinicIds: [67] } }).cache_key);
  assert.notEqual(base.cache_key, identity({ scope: { scope: 'group', clinicIds: [66], groupId: 28 } }).cache_key);
  assert.notEqual(base.cache_key, identity({ range: range({ end: new Date('2026-08-29T00:00:00.000Z'), endLabel: '2026-08-29' }) }).cache_key);
  assert.notEqual(base.cache_key, identity({ reportVersion: 'marketing-overview-v2' }).cache_key);
}

function testFreshStaleAndExpiredBoundaries() {
  const started = new Date('2026-08-01T08:00:00.000Z');
  const row = cachedRow(identity(), started);
  assert.equal(overviewCacheStatus(row, new Date(started.getTime() + OVERVIEW_CACHE_FRESH_TTL_MS - 1)), 'fresh');
  assert.equal(overviewCacheStatus(row, new Date(started.getTime() + OVERVIEW_CACHE_FRESH_TTL_MS)), 'stale');
  assert.equal(overviewCacheStatus(row, new Date(started.getTime() + OVERVIEW_CACHE_EXPIRES_TTL_MS - 1)), 'stale');
  assert.equal(overviewCacheStatus(row, new Date(started.getTime() + OVERVIEW_CACHE_EXPIRES_TTL_MS)), 'expired');
}

async function testMissGeneratesPersistsAndFreshReadsDoNotRegenerate() {
  const currentTime = new Date('2026-08-29T06:30:00.000Z');
  const cacheIdentity = identity();
  const model = createFakeCacheModel();
  let generated = 0;
  const coordinator = createOverviewCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => 'token-miss',
  });

  const first = await coordinator.readOrGenerate({
    identity: cacheIdentity,
    generate: async () => {
      generated += 1;
      return { success: true, marker: 'generated', lastUpdated: currentTime.toISOString() };
    },
  });
  const second = await coordinator.readOrGenerate({
    identity: cacheIdentity,
    generate: async () => {
      generated += 1;
      return { success: true, marker: 'must-not-run' };
    },
  });

  assert.equal(generated, 1);
  assert.equal(first.marker, 'generated');
  assert.equal(first.cache.status, 'fresh');
  assert.equal(second.marker, 'generated');
  assert.equal(second.cache.status, 'fresh');
  assert.equal(model.rows.size, 1);
}

async function testStaleReturnsImmediatelyAndSchedulesRefresh() {
  const currentTime = new Date('2026-08-29T06:30:00.000Z');
  const cacheIdentity = identity();
  const stale = cachedRow(cacheIdentity, new Date(currentTime.getTime() - DAY_MS - 1000));
  const model = createFakeCacheModel([stale]);
  const scheduled = [];
  let generated = 0;
  const coordinator = createOverviewCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => 'token-stale',
    scheduleRefresh: async (job) => scheduled.push(job),
    logger: { warn() {} },
  });

  const result = await coordinator.readOrGenerate({
    identity: cacheIdentity,
    generate: async () => {
      generated += 1;
      return { success: true, marker: 'must-not-run' };
    },
  });

  assert.equal(result.marker, 'stored');
  assert.equal(result.cache.status, 'stale');
  assert.equal(result.cache.refresh_in_progress, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].identity.cache_key, cacheIdentity.cache_key);
  assert.equal(generated, 0);

  const refreshed = await coordinator.generateAndPersist(cacheIdentity, scheduled[0].token, async () => ({
    success: true,
    marker: 'refreshed',
    lastUpdated: currentTime.toISOString(),
  }));
  assert.equal(refreshed.marker, 'refreshed');
  assert.equal(refreshed.cache.status, 'fresh');
}

async function testForceRefreshBypassesFreshCache() {
  const currentTime = new Date('2026-08-29T06:30:00.000Z');
  const cacheIdentity = identity();
  const fresh = cachedRow(cacheIdentity, new Date(currentTime.getTime() - 60 * 1000));
  const model = createFakeCacheModel([fresh]);
  const coordinator = createOverviewCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => 'token-force',
  });

  const result = await coordinator.readOrGenerate({
    identity: cacheIdentity,
    forceRefresh: true,
    generate: async () => ({ success: true, marker: 'forced', lastUpdated: currentTime.toISOString() }),
  });

  assert.equal(result.marker, 'forced');
  assert.equal(result.cache.status, 'fresh');
}

async function run() {
  testIdentityIncludesScopeRangeAndVersion();
  testFreshStaleAndExpiredBoundaries();
  await testMissGeneratesPersistsAndFreshReadsDoNotRegenerate();
  await testStaleReturnsImmediatelyAndSchedulesRefresh();
  await testForceRefreshBypassesFreshCache();
  console.log('marketing_report_overview_cache.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
