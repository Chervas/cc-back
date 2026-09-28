'use strict';
const { CUSTOMER } = require('./google-ads-fixture.cjs');
const dates = Array.from({ length: 28 }, (_, index) => new Date(Date.parse('2026-08-12T12:00:00Z') + index * 86400000).toISOString().slice(0, 10));
const payload = (family, section) => ({ campaignId: '30', section, startDate: family === 'optimization_performance' ? dates[0] : '2026-09-01',
  endDate: family === 'optimization_performance' ? dates.at(-1) : '2026-09-11', pageToken: null });
function evidenceRows() {
  const identity = { customer: { id: CUSTOMER }, campaign: { id: '30' } };
  return structuredClone({
    optimization_performance: {
      campaign: [{ customer: { id: CUSTOMER, currencyCode: 'EUR', timeZone: 'Europe/Madrid' },
        campaign: { id: '30', status: 'ENABLED', experimentType: 'BASE', advertisingChannelType: 'SEARCH' } }],
      inventory: ['60', '61'].map(id => ({ ...identity, adGroup: { id: '50', status: 'ENABLED' }, adGroupAd: {
        ad: { id }, status: 'ENABLED', primaryStatus: 'ELIGIBLE', policySummary: { approvalStatus: 'APPROVED' } } })),
      campaign_daily: dates.map(date => ({ ...identity, segments: { date }, metrics: { clicks: '20', costMicros: '80000000' } })),
      ad_daily: dates.flatMap(date => ['60', '61'].map(id => ({ ...identity, adGroup: { id: '50' }, adGroupAd: { ad: { id } },
        segments: { date }, metrics: { clicks: '10', costMicros: id === '60' ? '60000000' : '20000000' } }))),
    },
    optimization_budget: {
      campaign: [{ customer: { id: CUSTOMER, currencyCode: 'EUR', timeZone: 'Europe/Madrid' }, campaign: { id: '30', status: 'ENABLED' },
        campaignBudget: { resourceName: `customers/${CUSTOMER}/campaignBudgets/40`, amountMicros: '20000000',
          period: 'DAILY', explicitlyShared: false, referenceCount: '1' } }],
      month_cost: [{ ...identity, metrics: { costMicros: '100000000' } }],
    },
  });
}
module.exports = { dates, payload, evidenceRows };
