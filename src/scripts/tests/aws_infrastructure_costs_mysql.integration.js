'use strict';
const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { snapshot, accountSnapshot, report: costReport } = require('./fixtures/aws_costs.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const { createRepository, createService, keyFor, accountKeyFor } = require('../../services/awsInfrastructureCosts.service');
  const { UPSERT_SQL } = require('../../../ops/aws-costs/sync-dev-cache.cjs');
  const migration = require('../../../migrations/20260912180000-create-aws-infrastructure-cost-caches');
  const qi = sql.getQueryInterface();
  await migration.up(qi, DataTypes); await migration.up(qi, DataTypes);
  const model = require('../../../models/awsinfrastructurecostcache')(sql, DataTypes); models.AwsInfrastructureCostCache = model;
  report.checks.push('isolated migration is repeatable');
  const repo = createRepository(model); const key = keyFor('2026-09'); const now = new Date('2026-09-12T04:00:00Z');
  await model.create({ cache_key: 'aws:integrations:prod:2026-09', snapshot: snapshot('2026-09', { version: 1 }) });
  const pending = await createService({ now: () => now, repository: repo }).getOverview({ userId: 1 });
  assert.equal(pending.snapshot, null); assert(pending.componentCoverage.every(item => item.status === 'pending'));
  report.checks.push('legacy two-component cache remains preserved and cannot imply platform coverage');
  const leases = await Promise.all(Array.from({ length: 6 }, () => repo.acquire(key, now)));
  assert.equal(leases.filter(Boolean).length, 1); report.checks.push('six concurrent collectors acquire one durable lease');
  const first = leases.find(Boolean); assert.equal(await repo.finish(key, first, costReport().attributed, null, now), true);
  const service = () => createService({ now: () => now, repository: createRepository(model) });
  assert.equal((await service().getOverview({ userId: 1 })).snapshot.amount, '0.2');
  assert.equal((await service().getOverview({ userId: 44 })).snapshot.services[0].amount, '0.2');
  assert.deepEqual((await service().getOverview({ userId: 1 })).scope.environments, ['prod', 'staging']);
  report.checks.push('JSON cache survives new repository and service with exact credits');
  const ownedConnection = await sql.connectionManager.getConnection();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = accountSnapshot();
      await ownedConnection.promise().execute(UPSERT_SQL, [accountKeyFor('2026-09'),JSON.stringify(value),new Date(value.collectedAt),now,null,now,now]);
      const [warnings] = await ownedConnection.promise().query('SHOW WARNINGS'); assert.equal(warnings.length, 0);
    }
  } finally { await sql.connectionManager.releaseConnection(ownedConnection); }
  const joined = await service().getOverview({ userId: 1 });
  assert.equal(joined.account.snapshot.amount, '1'); assert.equal(joined.reconciliation.amount, '0.8');
  assert.equal(await model.count({ where: { cache_key: accountKeyFor('2026-09') } }), 1);
  report.checks.push('genuine mysql2 execute mirror INSERT alias has zero warnings, is idempotent and binary JSON roundtrip reconciles both scopes');
  assert.equal(await repo.acquire(key, new Date(now.getTime() + 181000)), null);
  report.checks.push('same UTC day cannot reserve another CE budget after lease expiry or success');
  const oldLease = first; const later = new Date(now.getTime() + 86400000);
  const newLease = await repo.acquire(key, later); assert(newLease);
  assert.equal(await repo.finish(key, oldLease, snapshot(), null, later), false);
  assert.equal(await repo.finish(key, newLease, null, 'cost_aws_unavailable', later), true);
  const result = await service().getOverview({ userId: 1 }); assert.equal(result.status, 'stale'); assert.equal(result.snapshot.amount, '0.2');
  report.checks.push('next UTC day reserves once, old token cannot overwrite it, failure preserves saved amount');
  await migration.down(qi); assert(!(await qi.showAllTables()).includes('AwsInfrastructureCostCaches'));
  const missing = await service().getOverview({ userId: 1 }); assert.equal(missing.error, 'cost_migration_required');
  report.checks.push('own migration rollback and missing-table API state');
  await migration.up(qi, DataTypes); assert.equal(await model.count(), 0); report.checks.push('reapply creates only empty fictitious cache');
}).catch(() => { process.exitCode = 1; });
