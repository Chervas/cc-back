'use strict';

require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { Op, Sequelize } = require('sequelize');

const NOW = new Date('2026-10-30T12:00:00Z');
const clone = value => value == null ? value : structuredClone(value);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const scopeValue = (row, field) => {
  let value = row.scope_payload;
  if (typeof value === 'string') value = JSON.parse(value);
  return field === '$' ? value : value?.[field.replace(/^scope_payload\.|^\$\./, '')];
};
function compare(actual, expected) {
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    return Reflect.ownKeys(expected).every(op => {
      if (op === Op.in) return expected[op].some(value => compare(actual, value));
      if (op === Op.lte) return actual != null && +new Date(actual) <= +new Date(expected[op]);
      assert.fail('Unimplemented comparator in isolated cache model');
    });
  }
  if (expected instanceof Date) return actual != null && +new Date(actual) === +expected;
  return (actual ?? null) === (expected ?? null);
}
function matches(row, clause) {
  if (clause.attribute) {
    let value;
    if (clause.attribute.path) {
      value = scopeValue(row, clause.attribute.path);
      // Sequelize's MySQL JSON path expression uses JSON_UNQUOTE.
      if (value != null && typeof value !== 'object') value = String(value);
    } else {
      assert.equal(clause.attribute.fn, 'JSON_CONTAINS');
      const [column, candidate, field] = clause.attribute.args;
      assert.equal(column.col, 'scope_payload');
      const array = scopeValue(row, field);
      value = Array.isArray(array) && array.includes(JSON.parse(candidate)) ? 1 : 0;
    }
    return compare(value, clause.logic);
  }
  return Reflect.ownKeys(clause).every(key => {
    if (key === Op.or) return clause[key].some(part => matches(row, part));
    return compare(row[key], clause[key]);
  });
}
function fixture() {
  const rows = new Map(), writes = [], jobs = [];
  const state = { beforeUpdate: null, afterUpdate: null };
  const model = {
    findOne: async ({ where }) => clone(rows.get(where.cache_key) || null),
    findOrCreate: async ({ where, defaults }) => {
      const exists = rows.has(where.cache_key);
      if (!exists) rows.set(where.cache_key, clone(defaults));
      return [clone(rows.get(where.cache_key)), !exists];
    },
    update: async (values, options) => {
      if (state.beforeUpdate) await state.beforeUpdate(values, options);
      writes.push({ values: clone(values), options });
      let affected = 0;
      for (const [key, row] of rows) if (matches(row, options.where)) {
        rows.set(key, { ...row, ...clone(values) }); affected++;
      }
      if (state.afterUpdate) await state.afterUpdate(values, options);
      return [affected];
    },
  };
  const filename = require.resolve('../../services/marketingReportOverviewCache.service');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === '../../models' ? { MarketingReportOverviewCache: model }
    : name === './jobRequests.service' ? { enqueueUniqueJobRequest: async job => { jobs.push(job); } } : original(name);
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  const api = mod.exports;
  let sequence = 0;
  const coordinator = api.createOverviewCacheCoordinator({ model, now: () => NOW,
    randomToken: () => `lease-${++sequence}`, scheduleRefresh: async job => { jobs.push(job); } });
  const identity = (scope = { scope: 'clinic', clinicIds: [1] }, extra = {}) => api.buildOverviewCacheIdentity({ scope,
    range: { startLabel: '2026-10-01', endLabel: '2026-10-30', previous: { startLabel: '2026-09-01', endLabel: '2026-09-30' } }, ...extra });
  const seed = (key, fields) => rows.set(key, { cache_key: key, scope_payload: {},
    payload: { leads: 5, marker: 'old' }, generated_at: NOW, data_cutoff_at: NOW,
    fresh_until: new Date(+NOW + 86400000), expires_at: new Date(+NOW + 172800000),
    refresh_state: 'idle', refresh_lock_token: null, refresh_locked_until: null, ...fields });
  return { api, model, coordinator, rows, writes, state, jobs, identity, seed,
    invalidate: input => api.invalidateOverviewCacheForScope(input) };
}

test('scope invalidation matches clinic/group/all and exact IDs in normalized, legacy and direct arrays across periods and versions', async () => {
  const f = fixture();
  const affected = {
    clinic: { primary_clinic_id: 1 }, group: { group_id: 10 }, all: { scope_type: 'all' },
    aggregate: { scope_payload: { clinic_ids: [2, 1] } }, strings: { scope_payload: { clinic_ids: ['1'] } },
    camel: { scope_payload: { clinicIds: ['1', 2] } }, array: { scope_payload: [2, 1] }, arrayString: { scope_payload: ['1'] },
    payloadGroup: { scope_payload: { group_id: 10 } }, payloadGroupString: { scope_payload: { groupId: '10' } },
    payloadAll: { scope_payload: { all: true } }, camelAll: { scope_payload: { isAll: true } },
    typeAll: { scope_payload: { type: 'all' } }, scopeAll: { scope_payload: { scope: 'all' } },
    payloadClinic: { scope_payload: { clinic_id: '1' } }, camelClinic: { scope_payload: { clinicId: 1 } },
    oldVersion: { primary_clinic_id: 1, report_version: 'old-v1', period_start: '2020-01-01' },
    jsonString: { scope_payload: JSON.stringify({ clinic_ids: [1, 2] }) },
  };
  const unrelated = {
    otherClinic: { primary_clinic_id: 11 }, otherGroup: { group_id: 20 },
    otherArray: { scope_payload: { clinic_ids: [11, 21] } }, otherStrings: { scope_payload: { clinicIds: ['11', '21'] } },
    otherDirect: { scope_payload: [11] }, falseAll: { scope_payload: { all: false, isAll: false } },
    otherPayloadGroup: { scope_payload: { group_id: '101' } }, empty: { scope_payload: {} },
  };
  for (const [key, fields] of Object.entries({ ...affected, ...unrelated })) f.seed(key, fields);
  const before = clone([...f.rows]);
  assert.deepEqual(await f.invalidate({ clinicId: '1', groupId: '10' }), { invalidated: Object.keys(affected).length });
  assert.equal(f.writes.length, 1, 'invalidation is one atomic update, never a read/delete sequence');
  for (const key of Object.keys(affected)) {
    const row = f.rows.get(key);
    assert.equal(f.api.overviewCacheStatus(row, NOW), 'miss');
    assert.equal(row.payload, null); assert.equal(row.generated_at, null);
    assert.equal(row.refresh_locked_until, null); assert.equal(row.refresh_state, 'invalidated');
    assert.match(row.refresh_lock_token, /^[a-f\d-]{36}$/);
  }
  for (const key of Object.keys(unrelated)) assert.deepEqual(f.rows.get(key), before.find(([id]) => id === key)[1]);
  assert.equal(f.rows.size, before.length, 'no physical cache row is deleted');
  const oldToken = f.rows.get('clinic').refresh_lock_token;
  await f.invalidate({ clinicId: 1, groupId: 10 });
  assert.notEqual(f.rows.get('clinic').refresh_lock_token, oldToken, 'repeated invalidations revoke intervening refreshes too');
  assert.equal(f.rows.get('clinic').payload, null);
});

test('helper rejects absent or malformed IDs before writes and supports clinic-only invalidation', async () => {
  const f = fixture();
  for (const args of [{}, { groupId: 10 }, { clinicId: true }, { clinicId: '1 OR 1=1' }, { clinicId: '1x' },
    { clinicId: -1 }, { clinicId: 1.5 }, { clinicId: Number.MAX_SAFE_INTEGER + 1 }, { clinicId: 1, groupId: 0 }]) {
    await assert.rejects(f.invalidate(args), { code: 'overview_cache_scope_invalid' });
  }
  assert.equal(f.writes.length, 0);
  f.seed('clinic', { primary_clinic_id: 1 }); f.seed('all', { scope_type: 'all' }); f.seed('group', { group_id: 10 });
  assert.deepEqual(await f.invalidate({ clinicId: 1 }), { invalidated: 2 });
  assert.equal(f.rows.get('group').payload.marker, 'old');
  await assert.rejects(f.api.invalidateOverviewCacheForScope({ clinicId: 1 }, { model: null }), { code: 'overview_cache_model_unavailable' });
  await assert.rejects(f.api.invalidateOverviewCacheForScope({ clinicId: 1 }, { model: { update: async () => { throw Error('storage_failed'); } } }), /storage_failed/);
});

test('scope predicate generates escaped MySQL JSON expressions with exact scalar/array comparison and no dynamic SQL', async () => {
  const f = fixture(); await f.invalidate({ clinicId: 1, groupId: 10 });
  const sequelize = new Sequelize('offline', 'offline', 'fictional', { dialect: 'mysql', logging: false });
  const query = sequelize.dialect.queryGenerator.updateQuery('MarketingReportOverviewCaches',
    { payload: null }, f.writes[0].options.where, {});
  const [sql, bindings] = sequelize.dialect.Query.formatBindParameters(query.query, query.bind, 'mysql');
  assert.match(sql, /JSON_CONTAINS\(`scope_payload`, '1', '\$\.clinic_ids'\)/);
  assert.match(sql, /JSON_CONTAINS\(`scope_payload`, .*?1.*?, '\$\.clinicIds'\)/);
  assert.match(sql, /json_unquote\(json_extract\(`scope_payload`,.*?all.*?\)\) = 'true'/);
  assert.match(sql, /`primary_clinic_id` = \?/);
  assert.match(sql, /`group_id` = \?/);
  assert.deepEqual(bindings, [null, 1, 'all', 10]);
});

test('an in-flight pre-decision generation cannot overwrite a newer post-decision report or release its lease', async () => {
  const f = fixture(), identity = f.identity(), entered = gate(), finish = gate();
  const old = f.coordinator.readOrGenerate({ identity, generate: async () => { entered.resolve(); await finish.promise; return { leads: 5, marker: 'old' }; } })
    .then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await f.invalidate({ clinicId: 1 });
  assert.equal(f.rows.get(identity.cache_key).payload, null);
  const fresh = await f.coordinator.readOrGenerate({ identity, generate: async () => ({ leads: 4, marker: 'new' }) });
  assert.equal(fresh.leads, 4);
  const current = clone(f.rows.get(identity.cache_key));
  finish.resolve();
  assert.equal((await old).error.code, 'OVERVIEW_CACHE_REFRESH_LEASE_LOST');
  assert.deepEqual(f.rows.get(identity.cache_key), current);
  assert.equal(f.rows.get(identity.cache_key).payload.marker, 'new');
});

test('invalidating after generation but before the persist readback cannot return a resurrected payload', async () => {
  const f = fixture(), identity = f.identity();
  f.state.afterUpdate = async values => {
    if (!values.payload) return;
    f.state.afterUpdate = null;
    await f.invalidate({ clinicId: 1 });
  };
  await assert.rejects(f.coordinator.readOrGenerate({ identity, generate: async () => ({ marker: 'old' }) }),
    { code: 'OVERVIEW_CACHE_REFRESH_LEASE_LOST' });
  assert.equal(f.rows.get(identity.cache_key).payload, null);
  assert.equal(f.rows.get(identity.cache_key).refresh_state, 'invalidated');
});

test('revoked queued jobs are terminally skipped and cannot claim a replacement lease', async () => {
  const f = fixture(), identity = f.identity();
  const lease = await f.coordinator.acquire(identity);
  await f.invalidate({ clinicId: 1 });
  const row = clone(f.rows.get(identity.cache_key));
  const claim = await f.coordinator.claimForRefresh(identity, lease.token);
  assert.equal(claim.obsolete, true); assert.equal(claim.acquired, false);
  let generated = 0;
  await assert.rejects(f.coordinator.generateAndPersist(identity, lease.token, async () => { generated++; return {}; }),
    { code: 'OVERVIEW_CACHE_REFRESH_LEASE_LOST' });
  assert.equal(generated, 1, 'a generation already dispatched with an old token can finish, but cannot persist');
  const result = await f.api.refreshOverviewSnapshots({ cacheKey: identity.cache_key, identity, refreshToken: lease.token,
    prune: false, buildRange: () => ({}), buildOverviewPayload: async () => { generated++; return {}; } });
  assert.equal(result.status, 'completed'); assert.equal(result.reason, 'cache_refresh_superseded');
  assert.equal(result.processed, 0); assert.equal(generated, 1, 'the revoked queued job must not dispatch another generation');
  assert.deepEqual(f.rows.get(identity.cache_key), row);
});

test('a stale observation of an empty cache cannot acquire across invalidation even at the same timestamp', async () => {
  const f = fixture(), identity = f.identity();
  const observed = await f.coordinator.ensure(identity);
  await f.invalidate({ clinicId: 1 });
  assert.equal((await f.coordinator.acquire(identity, observed)).acquired, false);
  const fresh = await f.coordinator.readOrGenerate({ identity, generate: async () => ({ marker: 'fresh' }) });
  assert.equal(fresh.marker, 'fresh');
});

test('cold-cache contention never persists or even generates without a lease', async () => {
  const f = fixture(), identity = f.identity();
  const owner = await f.coordinator.acquire(identity);
  let generated = 0;
  await assert.rejects(f.coordinator.readOrGenerate({ identity, generate: async () => { generated++; return { marker: 'unowned' }; } }),
    { code: 'OVERVIEW_CACHE_REFRESH_BUSY', status: 503 });
  await assert.rejects(f.coordinator.persist(identity, { marker: 'unowned' }), { code: 'OVERVIEW_CACHE_REFRESH_LEASE_REQUIRED' });
  assert.equal(generated, 0); assert.equal(f.rows.get(identity.cache_key).payload, null);
  assert.equal(f.rows.get(identity.cache_key).refresh_lock_token, owner.token);
});

test('invalidation racing stale refresh scheduling forces a new generation instead of returning stale counts', async () => {
  const f = fixture(), identity = f.identity();
  f.seed(identity.cache_key, { ...identity, fresh_until: new Date(+NOW - 1000) });
  const cache = f.api.createOverviewCacheCoordinator({ model: f.model, now: () => NOW,
    scheduleRefresh: async () => f.invalidate({ clinicId: 1 }) });
  let generated = 0;
  const result = await cache.readOrGenerate({ identity, generate: async () => { generated++; return { marker: 'fresh', leads: 4 }; } });
  assert.equal(generated, 1); assert.equal(result.marker, 'fresh');
  assert.equal(f.rows.get(identity.cache_key).payload.leads, 4);
});

test('normal refresh failures release only their own lease and allow retries while completed jobs cannot run again', async () => {
  const f = fixture(), identity = f.identity();
  const first = await f.coordinator.acquire(identity);
  await assert.rejects(f.coordinator.generateAndPersist(identity, first.token, async () => { throw Error('temporary_failure'); }), /temporary_failure/);
  assert.equal(f.rows.get(identity.cache_key).refresh_state, 'failed');
  const retry = await f.coordinator.claimForRefresh(identity, first.token);
  assert.equal(retry.acquired, true);
  assert.equal((await f.coordinator.generateAndPersist(identity, retry.token, async () => ({ marker: 'retried' }))).marker, 'retried');
  assert.equal((await f.coordinator.claimForRefresh(identity, retry.token)).obsolete, true);
});
