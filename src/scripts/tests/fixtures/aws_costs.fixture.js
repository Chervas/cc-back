'use strict';
function snapshot(month = '2026-09', patch = {}) {
  return { version: 1, month, source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'prod',
    collectedAt: '2026-09-12T01:40:00Z', status: 'available', amount: '0.2', currency: 'USD', estimated: true,
    period: { from: month + '-01', toExclusive: month + '-03' },
    rows: [{ date: month + '-01', service: 'Amazon S3', component: 'audit', amount: '0.3', currency: 'USD' },
      { date: month + '-02', service: 'Amazon S3', component: 'audit', amount: '-0.1', currency: 'USD' }],
    forecast: { status: 'pending', amount: null, currency: null },
    budget: { status: 'available', amount: '60', currency: 'USD', scopeMatches: false, metricMatches: false, referenceMonth: '2026-09' }, ...patch };
}
module.exports = { snapshot };
