'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260712043000-repair-google-ads-campaign-total-drift');

function buildQueryInterface({
  snapshots,
  affectedRows,
  duplicateGroups = 0,
  pendingAttribution = 0,
}) {
  const transaction = { id: 'test-transaction' };
  const calls = [];
  const state = { committed: false, rolledBack: false };
  let snapshotIndex = 0;
  let affectedIndex = 0;

  return {
    calls,
    state,
    queryInterface: {
      sequelize: {
        async transaction(callback) {
          try {
            const result = await callback(transaction);
            state.committed = true;
            return result;
          } catch (error) {
            state.rolledBack = true;
            throw error;
          }
        },
        async query(sql, options = {}) {
          assert.equal(options.transaction, transaction, 'Every repair query must share one transaction');
          const normalizedSql = sql.replace(/\s+/g, ' ').trim();
          calls.push(normalizedSql);

          if (normalizedSql.includes('AS duplicate_rows')) {
            const snapshot = snapshots[snapshotIndex++];
            assert.ok(snapshot, 'Unexpected legacy snapshot read');
            return [[{
              legacy_rows: snapshot.legacyRows,
              duplicate_rows: snapshot.duplicateRows,
            }], {}];
          }
          if (normalizedSql === 'SELECT ROW_COUNT() AS affected_rows') {
            const value = affectedRows[affectedIndex++];
            assert.notEqual(value, undefined, 'Unexpected affected-row read');
            return [[{ affected_rows: value }], {}];
          }
          if (normalizedSql.includes('AS duplicate_groups')) {
            return [[{ duplicate_groups: duplicateGroups }], {}];
          }
          if (normalizedSql.includes('AS pending_rows')) {
            return [[{ pending_rows: pendingAttribution }], {}];
          }
          if (normalizedSql.startsWith('DELETE legacy')
            || normalizedSql.startsWith('UPDATE GoogleAdsInsightsDaily')) {
            return [[], {}];
          }
          throw new Error(`Unexpected SQL in campaign-total repair test: ${normalizedSql}`);
        },
      },
    },
  };
}

async function testRepairsDriftAndChecksInvariants() {
  const fixture = buildQueryInterface({
    snapshots: [
      { legacyRows: 5, duplicateRows: 3 },
      { legacyRows: 0, duplicateRows: 0 },
    ],
    affectedRows: [3, 2, 4],
  });

  await migration.up(fixture.queryInterface);

  assert.equal(fixture.state.committed, true);
  assert.equal(fixture.state.rolledBack, false);
  assert.equal(fixture.calls.some((sql) => sql.startsWith('DELETE legacy')), true);
  assert.equal(
    fixture.calls.some((sql) => sql.includes("SET network = 'CAMPAIGN_TOTAL', device = 'CAMPAIGN_TOTAL'")),
    true
  );
  assert.equal(
    fixture.calls.some((sql) => sql.includes("clinicMatchSource = 'reviewed_campaign'")),
    true
  );
}

async function testIsIdempotentWhenAlreadyClean() {
  const fixture = buildQueryInterface({
    snapshots: [
      { legacyRows: 0, duplicateRows: 0 },
      { legacyRows: 0, duplicateRows: 0 },
    ],
    affectedRows: [0, 0, 0],
  });

  await migration.up(fixture.queryInterface);
  assert.equal(fixture.state.committed, true);
  assert.equal(fixture.state.rolledBack, false);
}

async function testRollsBackWhenDeleteCountDrifts() {
  const fixture = buildQueryInterface({
    snapshots: [{ legacyRows: 5, duplicateRows: 3 }],
    affectedRows: [2],
  });

  await assert.rejects(
    migration.up(fixture.queryInterface),
    /expected to delete 3 duplicate legacy rows, deleted 2/
  );
  assert.equal(fixture.state.committed, false);
  assert.equal(fixture.state.rolledBack, true);
  assert.equal(
    fixture.calls.some((sql) => sql.includes("SET network = 'CAMPAIGN_TOTAL', device = 'CAMPAIGN_TOTAL'")),
    false,
    'A delete mismatch must abort before normalization'
  );
}

async function testRollsBackWhenPostCheckFindsDuplicates() {
  const fixture = buildQueryInterface({
    snapshots: [
      { legacyRows: 0, duplicateRows: 0 },
      { legacyRows: 0, duplicateRows: 0 },
    ],
    affectedRows: [0, 0, 0],
    duplicateGroups: 1,
  });

  await assert.rejects(
    migration.up(fixture.queryInterface),
    /1 duplicate insight dimension groups remain/
  );
  assert.equal(fixture.state.committed, false);
  assert.equal(fixture.state.rolledBack, true);
}

Promise.all([
  testRepairsDriftAndChecksInvariants(),
  testIsIdempotentWhenAlreadyClean(),
  testRollsBackWhenDeleteCountDrifts(),
  testRollsBackWhenPostCheckFindsDuplicates(),
])
  .then(() => console.log('google_ads_campaign_total_repair_migration.test.js OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
