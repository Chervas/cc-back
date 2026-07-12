'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260711014000-backfill-managed-campaign-transition-benchmarks');

async function testCanonicalSourceRequestReplacesLegacyReference() {
  const updates = [];
  const queryInterface = {
    sequelize: {
      async query(sql, options = {}) {
        if (sql.includes('FROM ManagedCampaigns') && sql.includes('strategy_campaign_id')) {
          return [[{
            id: 'managed-1',
            strategy_campaign_id: 9,
            campaign_request_id: 999,
            clinica_id: 58,
            platform_refs: {},
            review_config: {},
          }]];
        }
        if (sql.includes('FROM CampaignRequests')) {
          return [[{
            id: 22,
            campaign_id: 9,
            clinica_id: 58,
            updated_at: '2026-07-11T00:25:20.000Z',
            solicitud: {
              kind: 'marketing_strategy',
              objective_id: 'new_patients',
              mode_snapshot: 'connect_only',
              status: 'active',
              external_targets: [{
                kind: 'generic',
                campaigns: [{
                  provider: 'google_ads',
                  account_id: '1851215478',
                  external_campaign_id: '123',
                  name: 'Badalona',
                  metrics: { spend: 999999 },
                }],
              }],
            },
          }]];
        }
        if (sql.includes('UPDATE ManagedCampaigns')) {
          updates.push(options.replacements);
          return [[], {}];
        }
        throw new Error(`Unexpected SQL in transition migration test: ${sql}`);
      },
    },
  };

  await migration.up(queryInterface);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].requestId, 22,
    'The durable FK must point to the canonical Connect-only request, not a stale legacy request');
  const review = JSON.parse(updates[0].reviewConfig);
  assert.equal(review.transition.source_campaign_request_id, 22);
  assert.equal(review.transition.previous_campaign_request_id, 999);
  assert.equal(review.transition.benchmark_refs_added_by, '20260711014000');
  const refs = JSON.parse(updates[0].platformRefs).benchmark_external_campaigns;
  assert.equal(refs.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(refs[0], 'metrics'), false);
}

async function testFrozenSourceWinsOverNewerRequest() {
  const updates = [];
  const sourcePayload = (label) => ({
    kind: 'marketing_strategy',
    objective_id: 'new_patients',
    mode_snapshot: 'connect_only',
    status: 'active',
    external_targets: [{
      kind: 'generic',
      campaigns: [{
        provider: 'google_ads',
        account_id: '1851215478',
        external_campaign_id: label,
        name: label,
      }],
    }],
  });
  const frozenTransition = {
    benchmark_preserved: true,
    source_campaign_request_id: 22,
    benchmark_captured_at: '2026-07-01T00:00:00.000Z',
  };
  const queryInterface = {
    sequelize: {
      async query(sql, options = {}) {
        if (sql.includes('FROM ManagedCampaigns') && sql.includes('strategy_campaign_id')) {
          return [[{
            id: 'managed-frozen',
            strategy_campaign_id: 9,
            campaign_request_id: 999,
            clinica_id: 58,
            platform_refs: { benchmark_external_campaigns: [{ external_campaign_id: 'frozen' }] },
            review_config: { transition: frozenTransition },
          }]];
        }
        if (sql.includes('FROM CampaignRequests')) {
          return [[
            { id: 23, campaign_id: 9, clinica_id: 58, solicitud: sourcePayload('newer'), updated_at: '2026-07-10T00:00:00.000Z' },
            { id: 22, campaign_id: 9, clinica_id: 58, solicitud: sourcePayload('frozen'), updated_at: '2026-07-01T00:00:00.000Z' },
          ]];
        }
        if (sql.includes('UPDATE ManagedCampaigns')) {
          updates.push(options.replacements);
          return [[], {}];
        }
        throw new Error(`Unexpected SQL in frozen transition test: ${sql}`);
      },
    },
  };

  await migration.up(queryInterface);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].requestId, 22,
    'An immutable snapshot source must win over a newer Connect-only request');
  assert.deepEqual(JSON.parse(updates[0].reviewConfig).transition, {
    ...frozenTransition,
    campaign_request_relinked_by: '20260711014000',
    campaign_request_relink_previous_id: 999,
  });
  assert.equal(JSON.parse(updates[0].platformRefs).benchmark_external_campaigns[0].external_campaign_id, 'frozen');

  const upResult = updates[0];
  updates.length = 0;
  const rollbackInterface = {
    sequelize: {
      async query(sql, options = {}) {
        if (sql.includes('FROM ManagedCampaigns') && sql.includes('campaign_request_id')) {
          return [[{
            id: 'managed-frozen',
            campaign_request_id: upResult.requestId,
            platform_refs: JSON.parse(upResult.platformRefs),
            review_config: JSON.parse(upResult.reviewConfig),
          }]];
        }
        if (sql.includes('UPDATE ManagedCampaigns')) {
          updates.push(options.replacements);
          return [[], {}];
        }
        throw new Error(`Unexpected SQL in frozen transition rollback test: ${sql}`);
      },
    },
  };

  await migration.down(rollbackInterface);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].previousRequestId, 999);
  assert.deepEqual(JSON.parse(updates[0].reviewConfig).transition, frozenTransition);
  assert.equal(
    JSON.parse(updates[0].platformRefs).benchmark_external_campaigns[0].external_campaign_id,
    'frozen',
  );
}

async function testRollbackPreservesPreexistingBenchmarkReferences() {
  const updates = [];
  const preexistingRefs = [{
    provider: 'google_ads',
    account_id: '1851215478',
    external_campaign_id: 'preexisting',
  }];
  const queryInterface = {
    sequelize: {
      async query(sql, options = {}) {
        if (sql.includes('FROM ManagedCampaigns') && sql.includes('campaign_request_id')) {
          return [[{
            id: 'managed-preexisting',
            campaign_request_id: 22,
            platform_refs: { benchmark_external_campaigns: preexistingRefs },
            review_config: {
              transition: {
                benchmark_preserved: true,
                source_campaign_request_id: 22,
                previous_campaign_request_id: 999,
                backfilled_by: '20260711014000',
              },
            },
          }]];
        }
        if (sql.includes('UPDATE ManagedCampaigns')) {
          updates.push(options.replacements);
          return [[], {}];
        }
        throw new Error(`Unexpected SQL in transition rollback test: ${sql}`);
      },
    },
  };

  await migration.down(queryInterface);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].previousRequestId, 999);
  assert.deepEqual(
    JSON.parse(updates[0].platformRefs).benchmark_external_campaigns,
    preexistingRefs,
    'Rollback must not delete benchmark references that were present before the migration',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(JSON.parse(updates[0].reviewConfig), 'transition'),
    false,
  );
}

async function testRollbackRemovesReferencesAddedByMigration() {
  const updates = [];
  const queryInterface = {
    sequelize: {
      async query(sql, options = {}) {
        if (sql.includes('FROM ManagedCampaigns') && sql.includes('campaign_request_id')) {
          return [[{
            id: 'managed-created',
            campaign_request_id: 22,
            platform_refs: {
              benchmark_external_campaigns: [{ external_campaign_id: 'created' }],
              unrelated: 'keep-me',
            },
            review_config: {
              transition: {
                benchmark_preserved: true,
                source_campaign_request_id: 22,
                previous_campaign_request_id: null,
                benchmark_refs_added_by: '20260711014000',
                backfilled_by: '20260711014000',
              },
            },
          }]];
        }
        if (sql.includes('UPDATE ManagedCampaigns')) {
          updates.push(options.replacements);
          return [[], {}];
        }
        throw new Error(`Unexpected SQL in transition rollback cleanup test: ${sql}`);
      },
    },
  };

  await migration.down(queryInterface);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].previousRequestId, null);
  assert.deepEqual(JSON.parse(updates[0].platformRefs), { unrelated: 'keep-me' });
}

Promise.all([
  testCanonicalSourceRequestReplacesLegacyReference(),
  testFrozenSourceWinsOverNewerRequest(),
  testRollbackPreservesPreexistingBenchmarkReferences(),
  testRollbackRemovesReferencesAddedByMigration(),
])
  .then(() => console.log('managed_campaign_transition_migration.test.js OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
