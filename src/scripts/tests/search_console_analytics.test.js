'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../lib/searchConsoleAnalyticsContract');
const service = require('../../services/searchConsoleAnalytics.service');
const operator = require('../search_console_analytics.operator');

test('import and OFF gates never initialize production models or use SQL', async () => {
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
  assert.equal(service.isWriteEnabled({}), false); assert.equal(service.isReadEnabled({ SC_ANALYTICS_READ_ENABLED: '1' }), false);
  const repo = service.createSearchConsoleAnalytics({ sequelize: { query() { assert.fail('SQL forbidden'); }, transaction() { assert.fail('SQL forbidden'); } } });
  assert.equal((await repo.writeInterval()).skipped, true);
  await assert.rejects(repo.rawSource({}), { code: 'sc_analytics_read_disabled' });
});
test('calendar policy, leap years and old partial months are explicit', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  assert.equal(C.cutoff(now), '2024-10-01');
  assert.equal(C.monthRange('2024-02').endDate, '2024-02-29');
  assert.throws(() => C.date('2024-02-30'), { code: 'sc_analytics_invalid_date' });
  assert.throws(() => C.monthlyRange('2024-02-02', '2024-02-29', now), { code: 'sc_analytics_monthly_partial_range' });
  assert.equal(operator.retentionPlan(now).detailedFrom, '2024-10-01');
});
test('positions round once; exact weighted sums and zero-impression fallback', () => {
  const bounds = { startDate: '2024-02-01', endDate: '2024-02-29' };
  const a = C.normalize({ date: '2024-02-01', query: 'clínica 🦷', page_url: 'https://example.com/á', clicks: 1, impressions: 10, position: 1 / 3 }, bounds);
  assert.equal(a.position_weighted, '3.333333330'); assert.equal(a.query_hash.length, 64);
  const b = C.normalize({ date: '2024-02-29', query: 'zero', clicks: 0, impressions: 0, position: 4 }, bounds);
  assert.equal(C.publicMetric(b).position, 4); assert.equal(C.publicMetric(b).ctr, 0);
  assert.throws(() => C.normalize({ ...b, query: 'x', clicks: 1.5 }, bounds), { code: 'sc_analytics_invalid_metric' });
  assert.notEqual(C.hash('á'), C.hash('á')); // Preserve exact provider identity.
});
test('legacy backfill cannot run without reviewed provenance/completeness', async () => {
  await assert.rejects(operator.backfillInterval({ siteUrl: 'sc-domain:example.com', startDate: '2024-02-01', endDate: '2024-02-29' }), { code: 'sc_analytics_backfill_review_required' });
});
