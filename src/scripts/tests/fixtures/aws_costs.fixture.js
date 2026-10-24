'use strict';
const { filterDigestFor, accountFilterDigestFor } = require('../../../../services/aws-cost-collector/src/costs');
const COLLECTION_ID = 'bd09e225-ff74-464e-bf30-b9fca2ef1f91';
function snapshot(month = '2026-09', patch = {}) {
  return { version: 2, month, filterDigest: filterDigestFor({ accountId: '137819318729', environment: 'prod' }), source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'platform',
    scope: { components: ['application', 'database', 'integrations', 'audit'], application: 'clinicaclick', environments: ['prod', 'staging'] }, coverage: 'tagged_resources_only',
    collectedAt: '2026-09-12T01:40:00Z', status: 'available', amount: '0.2', currency: 'USD', estimated: true,
    period: { from: month + '-01', toExclusive: month + '-03' },
    rows: [{ date: month + '-01', service: 'Amazon S3', component: 'audit', amount: '0.3', currency: 'USD' },
      { date: month + '-02', service: 'Amazon S3', component: 'audit', amount: '-0.1', currency: 'USD' }],
    forecast: { status: 'pending', amount: null, currency: null },
    budget: { status: 'available', amount: '60', currency: 'USD', scopeMatches: false, metricMatches: false, referenceMonth: '2026-09' }, ...patch };
}
function accountSnapshot(month = '2026-09', patch = {}) {
  const tagged = snapshot(month);
  return { version: 1, month, source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'platform',
    filterDigest: accountFilterDigestFor({ accountId: '137819318729', environment: 'prod' }),
    scope: { mode: 'linked_account', allServices: true, resourceTagFilter: false }, coverage: 'linked_account_reported',
    collectionId: COLLECTION_ID, collectedAt: tagged.collectedAt, period: tagged.period, status: 'available',
    amount: '1', currency: 'USD', estimated: true,
    rows: [...tagged.rows.map(({ component, ...row }) => row), { date: month + '-01', service: 'Amazon VPC', amount: '0.8', currency: 'USD' }],
    forecast: { status: 'pending', amount: null, currency: null },
    collection: { ceLogicalCalls: 5, ceOperations: { tags: 1, usage: 2, forecast: 2 }, sdkMaxAttempts: 2,
      ceRequestAttemptLimit: 10, ceRequestAttemptUpperBound: 10, ceRequestAttemptsObserved: 5, dailyBatchRequestAttemptLimit: 20 }, ...patch };
}
function report(month = '2026-09', patch = {}) {
  const attributed = { ...snapshot(month, patch), collectionId: COLLECTION_ID };
  return { version: 3, month, attributed, attributionError: null,
    account: accountSnapshot(month, attributed.status === 'pending' ? { status: 'pending', amount: null } : {}) };
}
module.exports = { snapshot, accountSnapshot, report, COLLECTION_ID };
