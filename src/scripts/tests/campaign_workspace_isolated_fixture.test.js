'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, ACCOUNT, assertClosed, assertDatabase, digest, daysBefore, manifestPath, seed, cleanup, validateDraftCapture } = require('../qa/campaign-workspace-isolated-fixture');

test('isolated QA refuses business workers or activation, including absent worker-off flags', () => {
  const closed = { JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false' };
  assert.doesNotThrow(() => assertClosed(closed));
  assert.throws(() => assertClosed({}));
  for (const key of ['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER', 'CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED',
    'CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED', 'CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED']) {
    assert.throws(() => assertClosed({ ...closed, [key]: 'true' }));
  }
});

test('isolated QA rejects CRM, another SQL user, or a real clinic', async () => {
  const connection = (db, user, clinic) => ({ query: async sql => sql.includes('DATABASE()')
    ? [[{ db, db_user: user }]] : [[{ nombre_clinica: clinic }]] });
  await assertDatabase(connection('clinicaclick_dev_isolated', 'cc_dev_api@localhost', 'Clinica ficticia DEV'));
  for (const args of [['crm', 'cc_dev_api@localhost', 'Clinica ficticia DEV'],
    ['clinicaclick_dev_isolated', 'root@localhost', 'Clinica ficticia DEV'],
    ['clinicaclick_dev_isolated', 'cc_dev_api@localhost', 'Real clinic']]) await assert.rejects(assertDatabase(connection(...args)));
});

test('fingerprints ignore SQL JSON key order, not changed values', () => {
  assert.equal(digest({ id: 1, data: { b: 2, a: 1 } }), digest({ data: { a: 1, b: 2 }, id: 1 }));
  assert.notEqual(digest({ id: 1, status: 'original' }), digest({ id: 1, status: 'edited' }));
});

test('fixture uses completed Madrid days even around UTC midnight', () => {
  assert.equal(daysBefore(new Date('2026-09-28T23:30:00Z'), 1), '2026-09-28');
  assert.equal(daysBefore(new Date('2026-09-28T12:00:00Z'), 60), '2026-07-30');
});

test('report fixture adds only bounded inventory without fabricated investment or credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-campaign-fixture-test-')); const file = path.join(dir, 'manifest.json');
  const rows = []; let last;
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, query: async (sql, values) => {
    if (sql.includes('DATABASE() db')) return [[{ db: 'clinicaclick_dev_isolated', db_user: 'cc_dev_api@localhost' }]];
    if (sql.includes('FROM Clinicas')) return [[{ nombre_clinica: 'Clinica ficticia DEV' }]];
    if (sql.includes('COUNT(*)')) return [[{ n: 0 }]];
    if (sql.startsWith('INSERT')) { rows.push({ table: values[0], row: values[1] }); last = { id: rows.length, ...values[1] }; return [{ insertId: rows.length }]; }
    if (sql.startsWith('SELECT *')) return [[last]];
    assert.fail('Unexpected SQL');
  } };
  try {
    const result = await seed(connection, file, new Date('2026-09-28T06:00:00Z'), 'report');
    assert.equal(result.rows, 719); assert.equal(result.campaigns, 15);
    assert.equal(rows.filter(r => r.table === 'ExternalCampaignInventories').length, 15);
    assert.equal(rows.filter(r => r.table === 'GoogleAdsInsightsDaily').length, 180);
    const conn = rows.find(r => r.table === 'GoogleConnections').row;
    assert.equal(conn.accessToken, null); assert.equal(conn.refreshToken, null); assert.equal(conn.userId, null);
    assert.equal(JSON.parse(fs.readFileSync(file)).scenario, 'report');
    await assert.rejects(seed(connection, file, new Date(), 'unbounded'), /UNKNOWN_FIXTURE_SCENARIO/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('manifest requires a private owned directory and a bounded location', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-campaign-fixture-test-'));
  try {
    assert.equal(manifestPath(path.join(dir, 'manifest.json')), path.join(dir, 'manifest.json'));
    assert.throws(() => manifestPath('/tmp/unrelated/manifest.json'));
    fs.chmodSync(dir, 0o755);
    assert.throws(() => manifestPath(path.join(dir, 'manifest.json')));
  } finally { fs.rmdirSync(dir); }
});

test('cleanup refuses the entire transaction when a fixture row changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-fixture-test-'));
  const file = path.join(dir, 'manifest.json');
  const calls = [];
  fs.writeFileSync(file, JSON.stringify({ version: 1, marker: MARKER, account: ACCOUNT, state: 'seeded',
    rows: [{ table: 'LeadIntakes', id: 123, hash: digest({ id: 123, source: 'original' }) }] }), { mode: 0o600 });
  const connection = { beginTransaction: async () => calls.push('begin'), rollback: async () => calls.push('rollback'),
    commit: async () => calls.push('commit'), query: async sql => {
      calls.push(sql);
      if (sql.includes('DATABASE()')) return [[{ db: 'clinicaclick_dev_isolated', db_user: 'cc_dev_api@localhost' }]];
      if (sql.includes('Clinicas')) return [[{ nombre_clinica: 'Clinica ficticia DEV' }]];
      return [[{ id: 123, source: 'edited-by-someone' }]];
    } };
  try {
    await assert.rejects(cleanup(connection, file), /FIXTURE_ROW_CHANGED/);
    assert.ok(calls.includes('rollback'));
    assert.ok(!calls.includes('commit') && !calls.some(call => call.startsWith('DELETE')));
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

for (const hasNewDependant of [true, false]) test('cleanup protects cascading dependants: ' + hasNewDependant, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-fixture-test-'));
  const file = path.join(dir, 'manifest.json'); const calls = []; const saved = { id: 123, source: MARKER };
  fs.writeFileSync(file, JSON.stringify({ version: 1, marker: MARKER, account: ACCOUNT, state: 'seeded',
    rows: [{ table: 'LeadIntakes', id: 123, hash: digest(saved) }] }), { mode: 0o600 });
  const connection = { beginTransaction: async () => calls.push('begin'), rollback: async () => calls.push('rollback'),
    commit: async () => calls.push('commit'), query: async sql => {
      calls.push(sql);
      if (sql.includes('DATABASE() db')) return [[{ db: 'clinicaclick_dev_isolated', db_user: 'cc_dev_api@localhost' }]];
      if (sql.includes('Clinicas')) return [[{ nombre_clinica: 'Clinica ficticia DEV' }]];
      if (sql.includes('KEY_COLUMN_USAGE')) return [[{ TABLE_NAME: 'LeadAttributionAudits', COLUMN_NAME: 'lead_intake_id', REFERENCED_TABLE_NAME: 'LeadIntakes' }]];
      if (sql.includes('COUNT(*)')) return [[{ n: hasNewDependant ? 1 : 0 }]];
      if (sql.startsWith('DELETE')) return [{ affectedRows: 1 }];
      return [[saved]];
    } };
  try {
    if (hasNewDependant) {
      await assert.rejects(cleanup(connection, file), /FIXTURE_HAS_NEW_DEPENDANTS/);
      assert.ok(calls.includes('rollback') && !calls.some(call => call.startsWith('DELETE')));
    } else {
      assert.deepEqual(await cleanup(connection, file), { state: 'cleaned', rows: 1 });
      assert.ok(calls.includes('commit'));
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'cleaned');
    }
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('capture only accepts a complete audit of own unactivated drafts without signals or budgets', () => {
  const accounts = [{ provider: 'google_ads', account_id: ACCOUNT, include_future: true, campaign_ids: ['999990092801'] }];
  const preferences = { schema_version: 1, mode: 'measurement', signals: { enabled: false, events: [] }, optimization: null };
  const setting = { id: 'f9aa8c28-46c1-4ba4-aef5-4e39832998d0', scope_type: 'clinic', scope_id: 1, updated_by_user_id: 1,
    version: 2, accounts, preferences, activation: null, signal_preparation: null, created_at: '2026-09-28 07:01:00' };
  const events = [
    { setting_id: setting.id, actor_user_id: 1, version: 1, event_type: 'accounts_selected', created_at: setting.created_at,
      changes: { accounts: { before: [], after: accounts } } },
    { setting_id: setting.id, actor_user_id: 1, version: 2, event_type: 'preferences_saved', created_at: setting.created_at,
      changes: { preferences: { before: null, after: preferences } } },
  ];
  const started = '2026-09-28T07:00:00Z';
  assert.doesNotThrow(() => validateDraftCapture(setting, events, started));
  for (const change of [{ activation: {} }, { signal_preparation: {} }, { updated_by_user_id: 2 }, { scope_id: 2 }, { version: 3 },
    { created_at: '2026-09-27 01:00:00' }, { accounts: [{ ...accounts[0], account_id: '1851215478' }] },
    { preferences: { ...preferences, signals: { enabled: true, events: ['lead'] } } }]) {
    assert.throws(() => validateDraftCapture({ ...setting, ...change }, events, started));
  }
  for (const change of [{ actor_user_id: 2 }, { setting_id: 'another' }, { version: 7 }, { event_type: 'activated' },
    { changes: { preferences: { before: null, after: { ...preferences, mode: 'optimize' } } } }]) {
    assert.throws(() => validateDraftCapture(setting, [events[0], { ...events[1], ...change }], started));
  }
});
