'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const {
  __testing: { buildRecommendations },
} = require('../../controllers/marketingReports.controller');

const connectedSources = [
  'Perfil Google',
  'Search Console',
  'Google Ads',
  'Meta Ads',
  'Facebook',
  'Instagram',
].map((source) => ({ source, connected: true }));

function healthyInput(overrides = {}) {
  return {
    businessProfile: { connected: true, unansweredReviews: 0 },
    adsCampaigns: [],
    intakeConfigCount: 1,
    firstParty: { connected: true },
    sources: connectedSources,
    seo: {
      connected: true,
      summary: { clicks: 20, impressions: 200 },
      queries: [{ query: 'clínica cerca de mí', clicks: 8, impressions: 80 }],
    },
    social: { summary: { posts: 5 } },
    channels: [
      { name: 'Google Ads', source: 'Google Ads', leads: 5, inversion: 50, cpl: 10 },
      { name: 'Meta Ads', source: 'Meta Ads', leads: 5, inversion: 50, cpl: 10 },
    ],
    range: { spanDays: 30 },
    current: { leads: 20, leadAppointments: 8, paidLeads: 10, spend: 100 },
    previous: { leads: 20, leadAppointments: 8, paidLeads: 10, spend: 100 },
    paidCoverageSummary: { hasComparableData: true },
    ...overrides,
  };
}

function testMissingFoundationsAreActionable() {
  const recommendations = buildRecommendations({
    businessProfile: { connected: false, unansweredReviews: 0 },
    adsCampaigns: [],
    intakeConfigCount: 0,
    firstParty: { connected: false },
    sources: [],
    seo: { connected: false, summary: {}, queries: [] },
    social: { summary: { posts: 0 } },
    range: { spanDays: 30 },
  });

  assert.deepEqual(
    recommendations.map((item) => item.id),
    [
      'connect-paid-media',
      'connect-gbp',
      'configure-web-measurement',
      'connect-search-console',
      'connect-social',
    ],
  );
  assert.ok(recommendations.every((item) => item.severity === 'warning'));
  assert.ok(recommendations.every((item) => item.actionRoute));
  assert.equal(new Set(recommendations.map((item) => item.id)).size, recommendations.length);
  assert.ok(!recommendations.some((item) => ['top-page', 'snippet-ok'].includes(item.id)));
}

function testHealthyInputsDoNotCreateFalseOpportunities() {
  assert.deepEqual(buildRecommendations(healthyInput()), []);
}

function testEvidenceBackedRulesAndPriority() {
  const recommendations = buildRecommendations(healthyInput({
    businessProfile: { connected: true, unansweredReviews: 3 },
    adsCampaigns: [{ name: 'Captación', alert: 'Está gastando sin registrar pacientes interesados.' }],
    seo: {
      connected: true,
      summary: { clicks: 2, impressions: 160 },
      queries: [{ query: 'clínica estética', clicks: 0, impressions: 120 }],
    },
    social: { summary: { posts: 0 } },
    current: { leads: 10, leadAppointments: 2, paidLeads: 5, spend: 200 },
    previous: { leads: 10, leadAppointments: 5, paidLeads: 5, spend: 100 },
    channels: [
      { name: 'Google Ads', source: 'Google Ads', leads: 3, inversion: 30, cpl: 10 },
      { name: 'Meta Ads', source: 'Meta Ads', leads: 3, inversion: 90, cpl: 30 },
    ],
  }));

  assert.deepEqual(
    recommendations.map((item) => item.id),
    [
      'campaign-no-leads',
      'respond-reviews',
      'paid-cpl-increase',
      'funnel-lead-to-appointment-drop',
      'seo-impressions-no-clicks',
      'paid-channel-cpl-gap',
      'social-no-posts',
    ],
  );
  assert.deepEqual(
    recommendations.map((item) => item.section),
    ['campanas', 'google-profile', 'costes', 'embudo', 'seo-ia', 'canales', 'redes'],
  );
  assert.equal(recommendations[0].severity, 'warning');
  assert.ok(recommendations.slice(1).every((item) => item.severity === 'info'));
  assert.ok(recommendations.every((item) => !Object.hasOwn(item, 'priority')));
}

function testSmallSamplesAndShortPeriodsAreIgnored() {
  const recommendations = buildRecommendations(healthyInput({
    social: { summary: { posts: 0 } },
    range: { spanDays: 13 },
    current: { leads: 9, leadAppointments: 1, paidLeads: 4, spend: 100 },
    previous: { leads: 9, leadAppointments: 5, paidLeads: 4, spend: 50 },
    channels: [
      { name: 'Google Ads', source: 'Google Ads', leads: 2, inversion: 20, cpl: 10 },
      { name: 'Meta Ads', source: 'Meta Ads', leads: 2, inversion: 60, cpl: 30 },
    ],
  }));

  assert.deepEqual(recommendations, []);
}

function testSeoSummaryFallback() {
  const recommendations = buildRecommendations(healthyInput({
    seo: {
      connected: true,
      summary: { clicks: 0, impressions: 100 },
      queries: [],
    },
  }));

  assert.deepEqual(recommendations.map((item) => item.id), ['seo-impressions-no-clicks']);
}

function testMissingConnectionsSuppressDependentDataRules() {
  const recommendations = buildRecommendations(healthyInput({
    sources: connectedSources.filter((item) => !['Perfil Google', 'Facebook', 'Instagram'].includes(item.source)),
    businessProfile: { connected: false, unansweredReviews: 10 },
    social: { summary: { posts: 0 } },
  }));

  assert.deepEqual(
    recommendations.map((item) => item.id),
    ['connect-gbp', 'connect-social'],
  );
  assert.ok(!recommendations.some((item) => ['respond-reviews', 'social-no-posts'].includes(item.id)));
}

testMissingFoundationsAreActionable();
testHealthyInputsDoNotCreateFalseOpportunities();
testEvidenceBackedRulesAndPriority();
testSmallSamplesAndShortPeriodsAreIgnored();
testSeoSummaryFallback();
testMissingConnectionsSuppressDependentDataRules();

console.log('marketing_report_recommendations.test.js: OK');
