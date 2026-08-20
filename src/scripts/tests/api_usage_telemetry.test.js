'use strict';

const assert = require('node:assert/strict');
const { __testing } = require('../../services/apiUsageTelemetry.service');

function makeCounter(overrides = {}) {
  const now = overrides.updated_at || new Date('2026-08-15T07:00:00.000Z');
  return {
    provider: 'meta_ads',
    usageDate: '2026-08-15',
    requestCount: 12,
    usagePct: 24,
    pauseUntil: null,
    updated_at: now,
    metadata: {
      lastEvent: {
        at: now.toISOString(),
        source: 'oauth_meta_assets',
        operation: 'list_ad_accounts',
        status: 'ok',
        error: null,
      },
      recentEvents: [],
      sources: {
        oauth_meta_assets: {
          requestCount: 6,
          errorCount: 0,
          lastSeenAt: now.toISOString(),
          lastStatus: 'ok',
          lastOperation: 'list_ad_accounts',
        },
      },
    },
    ...overrides,
  };
}

function testIncludesInteractiveSourcesAndProviderStatus() {
  const overview = __testing.buildApiUsageOverviewFromInputs({
    counters: [
      makeCounter({
        metadata: {
          lastEvent: {
            at: '2026-08-15T07:10:00.000Z',
            source: 'oauth_meta_callback',
            operation: 'exchange_long_lived_token',
            status: 'rate_limited',
            error: { code: '4', message: 'Application request limit reached' },
          },
          recentEvents: [],
          sources: {
            oauth_meta_callback: {
              requestCount: 2,
              errorCount: 1,
              lastSeenAt: '2026-08-15T07:10:00.000Z',
              lastStatus: 'rate_limited',
              lastOperation: 'exchange_long_lived_token',
            },
          },
        },
      }),
    ],
    metaUsage: {
      usagePct: 100,
      waiting: true,
      nextAllowedAt: new Date('2026-08-15T08:00:00.000Z').getTime(),
    },
    googleUsage: {
      requestCount: 15,
      quota: 1500,
      usagePct: 1,
      pauseUntil: null,
    },
    aiStatus: {
      checked_at: '2026-08-15T07:12:00.000Z',
      providers: {
        openai: { configured: true, status: 'ready', message: 'Operativo' },
        gemini: { configured: false, status: 'not_configured', message: 'Sin credencial' },
      },
    },
    checkedAt: '2026-08-15T07:13:00.000Z',
  });

  assert.equal(overview.success, true);
  assert.equal(overview.summary.status, 'warning');
  assert.equal(overview.summary.providerCount, 4);
  assert.equal(overview.summary.waitingCount, 1);

  const meta = overview.providers.find((provider) => provider.provider === 'meta_ads');
  assert.ok(meta);
  assert.equal(meta.status, 'warning');
  assert.equal(meta.usagePct, 100);
  assert.equal(meta.waiting, true);
  assert.equal(meta.lastError.code, '4');
  assert.equal(meta.sources[0].source, 'oauth_meta_callback');

  const google = overview.providers.find((provider) => provider.provider === 'google_ads');
  assert.ok(google);
  assert.equal(google.requestCount, 15);
  assert.equal(google.quota, 1500);
  assert.equal(google.status, 'healthy');

  const gemini = overview.providers.find((provider) => provider.provider === 'gemini');
  assert.ok(gemini);
  assert.equal(gemini.status, 'unknown');
}

function testErrorProvidersPromoteSummaryToBlocked() {
  const overview = __testing.buildApiUsageOverviewFromInputs({
    counters: [
      makeCounter({
        provider: 'whatsapp_cloud',
        usagePct: 0,
        metadata: {
          lastEvent: {
            at: '2026-08-15T07:15:00.000Z',
            source: 'whatsapp_delivery',
            operation: 'send_template',
            status: 'credentials_invalid',
            error: { code: '401', message: 'Token inválido' },
          },
          sources: {},
        },
      }),
    ],
    aiStatus: {
      checked_at: '2026-08-15T07:16:00.000Z',
      providers: {
        openai: { configured: true, status: 'ready', message: 'Operativo' },
        gemini: { configured: true, status: 'ready', message: 'Operativo' },
      },
    },
  });

  assert.equal(overview.summary.status, 'error');
  assert.equal(overview.summary.blockedCount, 1);
  const whatsapp = overview.providers.find((provider) => provider.provider === 'whatsapp_cloud');
  assert.ok(whatsapp);
  assert.equal(whatsapp.status, 'error');
  assert.equal(whatsapp.lastError.message, 'Token inválido');
}

function run() {
  testIncludesInteractiveSourcesAndProviderStatus();
  testErrorProvidersPromoteSummaryToBlocked();
  console.log('api_usage_telemetry.test.js OK');
}

run();
