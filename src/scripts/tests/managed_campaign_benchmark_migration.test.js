'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260711014500-backfill-managed-campaign-benchmark-metrics');

async function testImmutableMetaBackfill() {
  const updates = [];
  let requestQueries = 0;
  const existingMetrics = {
    investment: 999,
    captured_at: '2026-01-01T00:00:00.000Z',
  };
  const queryInterface = {
    sequelize: {
      async query(sql, options = {}) {
        if (sql.includes('FROM ManagedCampaigns') && sql.includes('strategy_campaign_id')) {
          return [[
            {
              id: 'already-frozen',
              strategy_campaign_id: 10,
              campaign_request_id: 11,
              clinica_id: 58,
              platform_refs: {},
              review_config: { transition: { benchmark_metrics: existingMetrics } },
            },
            {
              id: 'needs-backfill',
              strategy_campaign_id: 20,
              campaign_request_id: 21,
              clinica_id: 58,
              platform_refs: {
                benchmark_external_campaigns: [{
                  provider: 'meta_ads',
                  account_id: '123',
                  external_campaign_id: '456',
                  name: 'Frozen Meta benchmark',
                  destination: { kind: 'website', urls: ['https://www.propdental.es/'] },
                }],
              },
              review_config: {
                transition: { benchmark_captured_at: '2026-07-11T12:30:00.000Z' },
              },
            },
          ]];
        }
        if (sql.includes('FROM CampaignRequests')) {
          requestQueries += 1;
          return [[{
            id: 21,
            campaign_id: 20,
            clinica_id: 58,
            solicitud: {
              kind: 'marketing_strategy',
              objective_id: 'new_patients',
              mode_snapshot: 'connect_only',
              external_targets: [{
                kind: 'generic',
                campaigns: [{
                  provider: 'meta_ads',
                  account_id: '123',
                  external_campaign_id: '999',
                  name: 'Meta Badalona',
                  destination_detection: {
                    kind: 'website',
                    urls: ['https://www.propdental.es/'],
                  },
                }],
              }],
            },
          }]];
        }
        if (sql.includes('FROM SocialAdsInsightsDaily')) {
          assert.match(sql, /insights\.level = 'ad'/);
          assert.match(sql, /INNER JOIN SocialAdsEntities ads/);
          assert.match(sql, /INNER JOIN SocialAdsEntities adsets/);
          return [[{
            ad_account_id: 'act_123',
            campaign_id: '456',
            impressions: 1000,
            clicks: 40,
            spend: 50,
          }]];
        }
        if (sql.includes('FROM SocialAdsActionsDaily')) {
          assert.match(sql, /actions\.level = 'ad'/);
          assert.match(sql, /INNER JOIN SocialAdsEntities ads/);
          assert.match(sql, /INNER JOIN SocialAdsEntities adsets/);
          assert.match(sql, /SUM\(actions\.value\)/);
          return [[
            { ad_account_id: 'act_123', campaign_id: '456', date: '2026-07-10', action_type: 'lead', value: 2 },
            { ad_account_id: 'act_123', campaign_id: '456', date: '2026-07-10', action_type: 'onsite_conversion.lead_grouped', value: 2 },
          ]];
        }
        if (sql.includes('UPDATE ManagedCampaigns')) {
          updates.push(options.replacements);
          return [[], {}];
        }
        throw new Error(`Unexpected SQL in migration test: ${sql}`);
      },
    },
  };

  await migration.up(queryInterface);

  assert.equal(requestQueries, 1, 'A frozen benchmark must be skipped before loading its source request');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'needs-backfill');
  const review = JSON.parse(updates[0].reviewConfig);
  const metrics = review.transition.benchmark_metrics;
  assert.equal(metrics.period_start, '2026-06-12');
  assert.equal(metrics.period_end, '2026-07-11');
  assert.equal(metrics.captured_at, '2026-07-11T12:30:00.000Z');
  assert.equal(metrics.investment, 50);
  assert.equal(metrics.conversions, 2, 'Compatible Meta lead aliases must not be double counted');
  assert.equal(metrics.cost_per_conversion, 25);
  assert.equal(metrics.campaigns_with_data, 1);
  const refs = JSON.parse(updates[0].platformRefs).benchmark_external_campaigns;
  assert.equal(refs[0].external_campaign_id, '456',
    'Metrics and campaign_count must use the already frozen benchmark refs, not a later source payload');
  assert.deepEqual(refs[0].destination.urls, ['https://www.propdental.es/']);
}

testImmutableMetaBackfill()
  .then(() => console.log('managed_campaign_benchmark_migration.test.js OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
