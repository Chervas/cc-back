'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./fixtures/propdental_ad_repair.fixture');
const { CUSTOMER, AUTHORIZATION, ACCOUNT_QUERY, authorize, hasAdsScope, assertAccount, periodAt,
  reconcileSearch, repair, createReadOnlyRequest, saveJson } = require('../repair_propdental_ad_cache');
const { readAdPages } = require('../../services/googleAdCache.service');

test('operator requires the exact account-specific authorization and rejects extra arguments', () => {
  assert.doesNotThrow(() => authorize([AUTHORIZATION]));
  for (const args of [[], ['--apply'], [AUTHORIZATION, '--migrate'], [AUTHORIZATION.replace(CUSTOMER, '5992356722')]]) {
    assert.throws(() => authorize(args), /AUTHORIZATION_REQUIRED/);
  }
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../repair_propdental_ad_cache.js')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim(), 'EXPLICIT_AD_CACHE_WRITE_AUTHORIZATION_REQUIRED');
});

test('repair is fixed to the approved group mapping, never PROPDENTAL normal', () => {
  const { account } = fixture(); assertAccount(account);
  for (const change of [{ id: 12 }, { customerId: '5992356722' }, { assignmentScope: 'clinic' }, { grupoClinicaId: 6 }, { isActive: false }, { isActive: 'false' }]) {
    assert.throws(() => assertAccount({ ...account, ...change }), /ACCOUNT_SCOPE_CHANGED/);
  }
});

test('Google scope parsing recognizes exact tokens without substring matches', () => {
  const scope = 'https://www.googleapis.com/auth/adwords';
  for (const value of [scope, `openid ${scope}`, JSON.stringify([scope]), [scope]]) assert.equal(hasAdsScope(value), true);
  for (const value of [null, `${scope}.other`, JSON.stringify({ scope }), 'openid']) assert.equal(hasAdsScope(value), false);
});

test('repair dates are sixty closed Madrid calendar days including clock changes', () => {
  assert.deepEqual(periodAt(new Date('2026-09-12T00:00:00Z')), { start: '2026-07-14', end: '2026-09-11', timeZone: 'Europe/Madrid' });
  assert.deepEqual(periodAt(new Date('2026-10-25T23:30:00Z')), { start: '2026-08-27', end: '2026-10-25', timeZone: 'Europe/Madrid' });
  assert.equal(periodAt(new Date('2026-03-28T23:30:00Z')).end, '2026-03-28');
});

function transport(overrides = {}) {
  const f = fixture(); const calls = []; const requests = [];
  const request = createReadOnlyRequest({ accessToken: 'fixture-access', developerToken: 'fixture-developer', loginCustomerId: '1111111111',
    expiresAt: new Date(+f.now + 3600000), now: () => f.now, period: f.period, guard: async () => {}, requests,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200,
      headers: new Map([['request-id', 'fixture-request']]), json: async () => ({ results: f.responseFor(JSON.parse(options.body).query) }) }; }, ...overrides });
  return { ...f, calls, requests, request };
}

test('transport only permits the fixed v24 Search reads and never follows redirects', async () => {
  const f = transport(); const route = `customers/${CUSTOMER}/googleAds:search`;
  for (const query of [ACCOUNT_QUERY, f.queries.inventory, ...f.queries.metrics, f.queries.campaigns]) {
    await f.request('POST', route, { data: { query } });
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every(call => call.url === `https://googleads.googleapis.com/v24/${route}` && call.options.redirect === 'error'));
  assert.doesNotMatch(JSON.stringify(f.requests), /fixture-access|fixture-developer|authorization|query|finalUrls/);
  for (const [method, target, data] of [
    ['GET', route, { query: ACCOUNT_QUERY }], ['POST', route.replace(CUSTOMER, '5992356722'), { query: ACCOUNT_QUERY }],
    ['POST', `customers/${CUSTOMER}/campaigns:mutate`, {}], ['POST', route, { query: 'SELECT user_list.id FROM user_list' }],
    ['POST', route, { query: ACCOUNT_QUERY, operations: [] }],
  ]) await assert.rejects(f.request(method, target, { data }), /NON_APPROVED_GOOGLE_READ/);
  assert.equal(f.calls.length, 5);
});

test('expired token and changed guards stop before HTTP with no refresh fallback', async () => {
  for (const changes of [{ expiresAt: '2020-01-01' }, { expiresAt: null }, { guard: async () => { throw Error('revoked'); } }]) {
    const f = transport(changes);
    await assert.rejects(f.request('POST', `customers/${CUSTOMER}/googleAds:search`, { data: { query: ACCOUNT_QUERY } }), /EXPIRED|revoked/);
    assert.equal(f.calls.length, 0);
  }
});

test('provider error, partial data and page loops never count as a complete capture', async () => {
  let calls = 0;
  for (const response of [{ ok: false, status: 401, body: {} }, { ok: true, status: 200, body: { partialFailureError: {} } },
    { ok: true, status: 200, body: { results: [], nextPageToken: 'same' } }]) {
    const f = transport({ fetchImpl: async () => { calls++; return { ...response, headers: new Map(), json: async () => response.body }; } });
    await assert.rejects(readAdPages({ account: f.account, query: ACCOUNT_QUERY, request: f.request }), /REJECTED|INCOMPLETE|incomplete_pages/);
  }
  assert.equal(calls, 4);
});

test('request limit stops further provider reads', async () => {
  const f = transport({ requests: Array.from({ length: 24 }, () => ({})) });
  await assert.rejects(f.request('POST', `customers/${CUSTOMER}/googleAds:search`, { data: { query: ACCOUNT_QUERY } }), /REQUEST_LIMIT/);
  assert.equal(f.calls.length, 0);
});

test('Search reconciliation compares each day and excludes PMax from ad_group_ad coverage', () => {
  const f = fixture();
  assert.deepEqual(reconcileSearch(f), { checkedDays: 2, campaignCostMicros: '6000000', adCostMicros: '6000000', toleranceMicrosPerDay: '10000' });
  const rows = structuredClone(f.campaignRows); rows[0].metrics.costMicros = '1100000'; rows[1].metrics.costMicros = '4900000';
  assert.throws(() => reconcileSearch({ ...f, campaignRows: rows }), /DAILY_SPEND_MISMATCH/);
  assert.throws(() => reconcileSearch({ ...f, campaignRows: [] }), /INCOMPLETE/);
  assert.throws(() => reconcileSearch({ ...f, campaignRows: [...f.campaignRows, f.campaignRows[0]] }), /DUPLICATE/);
  assert.throws(() => reconcileSearch({ ...f, campaignRows: [{ ...f.campaignRows[0], customer: { id: '5992356722' } }] }), /INVALID_ROW/);
});

test('schema prerequisite and guard failure prevent all provider queries', async () => {
  const f = fixture();
  const models = { sequelize: { getQueryInterface: () => ({ describeTable: async name => {
    assert.equal(name, 'GoogleAdsAdInventory'); return {}; } }) } };
  await assert.rejects(repair({ ...f, models, backup: async () => {}, guard: async () => {} }), /MIGRATION_REQUIRED/);
  await assert.rejects(repair({ ...f, models, backup: async () => {}, guard: async () => { throw Error('jobs_running'); } }), /jobs_running/);
  assert.equal(f.calls.length, 0);
});

test('backup is private, hash-verified, durable and cannot overwrite prior evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ad-repair-unit-')); fs.chmodSync(dir, 0o700);
  try {
    const result = saveJson(dir, 'before.json', { fixture: true });
    assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.equal(fs.statSync(path.join(dir, result.file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, result.file), 'utf8')), { fixture: true });
    assert.throws(() => saveJson(dir, 'before.json', {}), /EEXIST/);
    assert.throws(() => saveJson(dir, '../escape.json', {}), /INVALID_EVIDENCE_FILE/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
