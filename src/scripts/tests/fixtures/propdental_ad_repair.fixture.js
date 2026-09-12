'use strict';

const { CUSTOMER, ACCOUNT_QUERY, periodAt, queriesFor } = require('../../repair_propdental_ad_cache');

function fixture() {
  const now = new Date('2026-09-12T12:00:00.123Z');
  const account = { id: 11, customerId: CUSTOMER, assignmentScope: 'group', grupoClinicaId: 5, clinicaId: null, googleConnectionId: 2, isActive: true };
  const period = periodAt(now); const queries = queriesFor(period); const calls = [];
  const row = (adId, date, cost) => ({ customer: { id: CUSTOMER }, campaign: { id: '456', name: 'Fixture Search', status: 'ENABLED' },
    adGroup: { id: '800', name: 'Fixture group', status: 'ENABLED' },
    adGroupAd: { status: 'ENABLED', primaryStatus: 'ELIGIBLE', policySummary: { approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' },
      ad: { id: adId, type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://fixture.invalid/appointment'],
        responsiveSearchAd: { headlines: [{ text: 'Fixture title' }], descriptions: [{ text: 'Fixture description' }] } } },
    segments: { date, device: 'MOBILE', adNetworkType: 'SEARCH' },
    metrics: { costMicros: String(cost), impressions: '100', clicks: '3', conversions: 1.23456789 } });
  const metricRows = [row('700', '2026-07-20', 1000000), row('700', '2026-09-11', 2000000), row('701', '2026-09-11', 3000000)];
  const inventoryRows = [metricRows[0], metricRows[2]];
  const campaignRows = [
    { customer: { id: CUSTOMER }, campaign: { id: '456', advertisingChannelType: 'SEARCH' }, segments: { date: '2026-07-20' }, metrics: { costMicros: '1000000' } },
    { customer: { id: CUSTOMER }, campaign: { id: '456', advertisingChannelType: 'SEARCH' }, segments: { date: '2026-09-11' }, metrics: { costMicros: '5000000' } },
    { customer: { id: CUSTOMER }, campaign: { id: '999', advertisingChannelType: 'PERFORMANCE_MAX' }, segments: { date: '2026-09-11' }, metrics: { costMicros: '7000000' } },
  ];
  const responseFor = query => {
    if (query === ACCOUNT_QUERY) return [{ customer: { id: CUSTOMER, currencyCode: 'EUR', timeZone: 'Europe/Madrid', manager: false } }];
    if (query === queries.inventory) return inventoryRows;
    if (query === queries.campaigns) return campaignRows;
    if (queries.metrics.includes(query)) {
      const [, from, until] = query.match(/segments.date BETWEEN '([^']+)' AND '([^']+)'/);
      return metricRows.filter(row => row.segments.date >= from && row.segments.date <= until);
    }
    throw Error('Unexpected fixture query');
  };
  const request = async (method, route, options) => {
    if (method !== 'POST' || route !== `customers/${CUSTOMER}/googleAds:search`) throw Error('Unexpected fixture route');
    calls.push(options.data.query); return { results: structuredClone(responseFor(options.data.query)) };
  };
  return { now, account, period, queries, calls, row, inventoryRows, metricRows, campaignRows, responseFor, request };
}

module.exports = { fixture };
