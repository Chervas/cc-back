'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');
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

async function testPaidCoverageStartsAtFirstAttributableLead() {
  const scope = { scope: 'clinic', clinicIds: [58] };
  let receivedWhere = null;
  const coverage = await __testing.resolvePaidAttributionCoverage(scope, {
    LeadIntake: {
      async findAll(options) {
        receivedWhere = options.where;
        return [{
          googleAdsStart: new Date('2026-07-13T08:37:56.000Z'),
          metaAdsStart: null,
        }];
      },
    },
  });

  assert.equal(receivedWhere.archived_at, null);
  assert.equal(receivedWhere.clinica_id, 58);
  assert.deepEqual(coverage, {
    start: '2026-07-13',
    googleAdsStart: '2026-07-13',
    metaAdsStart: null,
  });
}

function testPaidSpendUsesComparableWindowWithoutClippingOtherData() {
  const range = {
    startLabel: '2026-06-16',
    endLabel: '2026-07-15',
  };
  const paidWhere = __testing.buildComparablePaidDateWhere('date', range, '2026-07-13');
  assert.deepEqual(paidWhere.date[Op.between], ['2026-07-13', '2026-07-15']);

  const summary = __testing.buildPaidAttributionCoverageSummary(range, {
    start: '2026-07-13',
  });
  assert.equal(summary.truncated, true);
  assert.equal(summary.hasComparableData, true);
  assert.equal(summary.effectiveStart, '2026-07-13');
  assert.equal(summary.basis, 'first_attributable_paid_lead');
  assert.match(summary.note, /primer día con un lead atribuible a publicidad/i);

  assert.equal(
    __testing.comparablePaidRangeStart(range, '2026-06-01'),
    '2026-06-16',
    'a coverage start before the selected period must not shorten a legitimate selected period'
  );
  assert.equal(
    __testing.comparablePaidRangeStart(range, null),
    '2026-06-16',
    'without an evidence-backed coverage start the selected period remains intact'
  );

  const historicalSummary = __testing.buildPaidAttributionCoverageSummary({
    startLabel: '2025-01-01',
    endLabel: '2025-12-31',
  }, { start: '2026-07-13' });
  assert.equal(historicalSummary.hasComparableData, false);
  assert.match(historicalSummary.note, /no mezclamos el gasto histórico/i);
}

function testCplUsesPaidLeadsAndWebLabelIsUnambiguous() {
  const channels = __testing.buildChannels(new Map([
    ['google_ads', { leads: 7, citas: 1, acudieron: 0, convertidos: 0 }],
    ['web', { leads: 2, citas: 0, acudieron: 0, convertidos: 0 }],
  ]), { google_ads: 155.39 });
  const google = channels.find((channel) => channel.name === 'Google Ads');
  const web = channels.find((channel) => channel.name.includes('Web propia'));
  assert.equal(google.cpl, 22.2);
  assert.equal(web.name, 'Web propia (sin campaña)');
  assert.match(web.helpText, /Formularios, chat o teléfono/i);

  const kpis = __testing.buildKpis(
    { leads: 9, paidLeads: 7, citas: 1, acudieron: 0, convertidos: 0, spend: 155.39 },
    { leads: 0, paidLeads: 0, citas: 0, acudieron: 0, convertidos: 0, spend: 0 },
    { leads: [9], paidLeads: [7], citas: [1], acudieron: [0], convertidos: [0], spend: [155.39] }
  );
  const cpl = kpis.find((kpi) => kpi.id === 'cpl');
  assert.equal(cpl.value, 22.2);
  assert.deepEqual(cpl.sparkline, [22.2]);
}

function testGoogleSpendDeduplicatesLocalMappingsByRemoteFact() {
  const group = __testing.googleAdsRemoteFactGroup;
  for (const field of [
    'clinicaId',
    'grupoClinicaId',
    'customerId',
    'campaignId',
    'date',
    'adGroupId',
    'network',
    'device',
  ]) {
    assert.ok(group.includes(field));
  }
  assert.ok(
    !group.includes('clinicGoogleAdsAccountId'),
    'the local mapping id must not make the same remote Google Ads fact count twice'
  );
}

async function run() {
  testGoogleAdsSignalsWinOverWebContactSurface();
  testMetaAndOrganicFallbacksRemainDistinct();
  testSqlAggregationUsesCanonicalPaidSignals();
  await testPaidCoverageStartsAtFirstAttributableLead();
  testPaidSpendUsesComparableWindowWithoutClippingOtherData();
  testCplUsesPaidLeadsAndWebLabelIsUnambiguous();
  testGoogleSpendDeduplicatesLocalMappingsByRemoteFact();
  console.log('marketing_report_lead_attribution.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
