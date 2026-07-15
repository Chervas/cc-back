'use strict';

const assert = require('node:assert/strict');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const { __testing } = require('../../controllers/marketingReports.controller');

function testGoogleAdsSignalsWinOverWebContactSurface() {
  const shared = {
    source: 'web',
    channel: 'paid',
    source_detail: 'chatbot',
  };

  assert.equal(__testing.deriveChannelKey({
    ...shared,
    gclid: 'test-gclid',
  }), 'google_ads');
  assert.equal(__testing.deriveChannelKey({
    ...shared,
    google_ads_customer_id: '1851215478',
    google_ads_campaign_id: '21794037273',
  }), 'google_ads');
  assert.equal(__testing.deriveChannelKey({
    ...shared,
    gbraid: 'test-gbraid',
  }), 'google_ads');
  assert.equal(__testing.deriveChannelKey({
    ...shared,
    wbraid: 'test-wbraid',
  }), 'google_ads');
}

function testMetaAndOrganicFallbacksRemainDistinct() {
  assert.equal(__testing.deriveChannelKey({
    source: 'web',
    channel: 'paid',
    source_detail: 'web_form',
    fbclid: 'test-fbclid',
  }), 'meta_ads');
  assert.equal(__testing.deriveChannelKey({
    source: 'web',
    channel: 'organic',
    source_detail: 'chatbot',
    gclid: '   ',
  }), 'web');
  assert.equal(__testing.deriveChannelKey({
    source: 'web',
    utm_source: 'instagram',
  }), 'social_organic');
}

function testSqlAggregationUsesCanonicalPaidSignals() {
  const sql = __testing.leadAcquisitionChannelSql;
  for (const field of [
    'google_ads_customer_id',
    'google_ads_campaign_id',
    'gclid',
    'gbraid',
    'wbraid',
    'fbclid',
  ]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }
  assert.ok(
    sql.indexOf('google_ads_customer_id') < sql.indexOf("LOWER(COALESCE(source, '')) = 'google_ads'"),
    'canonical click/account signals must be evaluated before the contact-surface source'
  );
}

function run() {
  testGoogleAdsSignalsWinOverWebContactSurface();
  testMetaAndOrganicFallbacksRemainDistinct();
  testSqlAggregationUsesCanonicalPaidSignals();
  console.log('marketing_report_lead_attribution.test.js OK');
}

run();
