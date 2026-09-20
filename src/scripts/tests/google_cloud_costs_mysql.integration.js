'use strict';
const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { snapshot } = require('./fixtures/google_cloud_costs.fixture');
withIsolatedCampaignMysql(async ({ sql, report }) => {
  const { createService, keyFor, projectSnapshot } = require('../../services/googleCloudCosts.service');
  const migration = require('../../../migrations/20260920110000-create-google-cloud-cost-caches');
  const qi = sql.getQueryInterface();
  await migration.up(qi, DataTypes); await migration.up(qi, DataTypes);
  const model = require('../../../models/googlecloudcostcache')(sql, DataTypes);
  const read = key => model.findByPk(key, { raw: true });
  const service = () => createService({ now: () => new Date('2026-09-20T12:00:00Z'), repository: { read } });
  assert.equal((await service().getOverview({ userId: 1 })).status, 'pending');
  const value = projectSnapshot(snapshot(), '2026-09');
  await model.create({ cache_key: keyFor('2026-09'), snapshot: value, collected_at: new Date(value.collectedAt) });
  assert.equal((await service().getOverview({ userId: 44 })).snapshot.net, '0');
  await assert.rejects(model.create({ cache_key: keyFor('2026-09'), snapshot: value, collected_at: new Date(value.collectedAt) }));
  report.checks.push('idempotent additive migration, persistent JSON/credits, unique project/month and pending period');
  const { persistSnapshots, splitRows } = require('../../services/googleWeeklyBilling.service');
  const automatic = (day, amount) => splitRows([{ kind: 'billing', payload: JSON.stringify({ month: '2026-09',
    service: 'Maps', currency: 'EUR', gross: amount, credits: '0', net: amount, latestUsageDay: day }) }],
  { runKey: 'google-atc-es:2026-09-21', collectedAt: '2026-09-21T04:00:00Z' }).snapshots;
  await sql.transaction(async transaction => {
    const result = await persistSnapshots({ model, snapshots: automatic('2026-09-13', '1'), transaction });
    assert.deepEqual(result.preserved, ['2026-09']);
  });
  assert.equal((await read(keyFor('2026-09'))).snapshot.source, 'google_cloud_billing_report');
  await assert.rejects(sql.transaction(async transaction => {
    await persistSnapshots({ model, snapshots: automatic('2026-09-20', '2.123456789'), transaction });
    throw Error('later_ads_write_failed');
  }));
  assert.equal((await read(keyFor('2026-09'))).snapshot.gross, '1.53');
  await sql.transaction(transaction => persistSnapshots({ model, snapshots: automatic('2026-09-20', '2.123456789'), transaction }));
  assert.equal((await read(keyFor('2026-09'))).snapshot.gross, '2.123456789');
  await sql.transaction(transaction => persistSnapshots({ model, snapshots: [], transaction }));
  assert.equal((await read(keyFor('2026-09'))).snapshot.gross, '2.123456789');
  report.checks.push('initial backfill preserves newer report; atomic rollback, precise decimals and empty export preservation');
  await migration.down(qi); assert(!(await qi.showAllTables()).includes('GoogleCloudCostCaches'));
  report.checks.push('isolated rollback removes only its own table');
}).catch(() => { process.exitCode = 1; });
