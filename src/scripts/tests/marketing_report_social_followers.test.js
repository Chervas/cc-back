'use strict';

const assert = require('node:assert/strict');

const {
  __testing: { normalizeSocialFollowerDeltas },
} = require('../../controllers/marketingReports.controller');

const normalized = normalizeSocialFollowerDeltas([
  { asset_type: 'facebook_page', asset_id: 10, date: '2026-08-01', followers: 772 },
  { asset_type: 'instagram_business', asset_id: 20, date: '2026-08-01', followers: 2220 },
  { asset_type: 'facebook_page', asset_id: 10, date: '2026-08-02', followers: 0 },
  { asset_type: 'instagram_business', asset_id: 20, date: '2026-08-02', followers: 2218 },
  { asset_type: 'facebook_page', asset_id: 10, date: '2026-08-03', followers: 778 },
  { asset_type: 'instagram_business', asset_id: 20, date: '2026-08-03', followers: 2225 },
]);

assert.deepEqual(
  normalized.map((row) => ({
    asset: `${row.asset_type}:${row.asset_id}`,
    date: row.date,
    delta: row.normalizedFollowersDelta,
  })),
  [
    { asset: 'facebook_page:10', date: '2026-08-01', delta: 0 },
    { asset: 'instagram_business:20', date: '2026-08-01', delta: 0 },
    { asset: 'facebook_page:10', date: '2026-08-02', delta: 0 },
    { asset: 'instagram_business:20', date: '2026-08-02', delta: -2 },
    { asset: 'facebook_page:10', date: '2026-08-03', delta: 6 },
    { asset: 'instagram_business:20', date: '2026-08-03', delta: 7 },
  ],
);

console.log('marketing_report_social_followers.test.js: OK');
