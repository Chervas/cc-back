'use strict';

const { performancePeriod, inspectGooglePerformance, inspectMetaPerformance } = require('../../../services/campaignWorkspacePerformanceSnapshot.service');

function performanceFixture(provider = 'google_ads') {
  const reference = { provider, account_id: '20', campaign_id: '30' };
  const now = new Date('2026-09-11T12:00:00Z'); const period = performancePeriod(now);
  const dates = Array.from({ length: period.days }, (_, i) => new Date(Date.parse(`${period.start}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  const state = { now, clock: 0, calls: [], owner: { id: 'act_20', account_id: '20', currency: 'EUR', timezone_name: 'Europe/Madrid' },
    campaign: { id: '30', account_id: '20', status: 'ACTIVE', effective_status: 'ACTIVE', buying_type: 'AUCTION' } };
  state.googleMeta = [{ customer: { id: '20', currencyCode: 'EUR', timeZone: 'Europe/Madrid' },
    campaign: { id: '30', status: 'ENABLED', experimentType: 'BASE', advertisingChannelType: 'SEARCH' } }];
  const googleBase = () => ({ customer: { id: '20' }, campaign: { id: '30' } });
  const metaBase = () => ({ account_id: '20', campaign_id: '30' });
  state.inventory = ['60', '61'].map(id => provider === 'google_ads'
    ? { ...googleBase(), adGroup: { id: '50', status: 'ENABLED' }, adGroupAd: { ad: { id }, status: 'ENABLED',
      primaryStatus: 'ELIGIBLE', policySummary: { approvalStatus: 'APPROVED' } } }
    : { ...metaBase(), id, adset_id: '50', status: 'ACTIVE', effective_status: 'ACTIVE' });
  state.campaignRows = dates.map(date => provider === 'google_ads'
    ? { ...googleBase(), segments: { date }, metrics: { clicks: '20', costMicros: '80000000' } }
    : { ...metaBase(), date_start: date, date_stop: date, clicks: '20', spend: '80.00' });
  state.adRows = dates.flatMap(date => ['60', '61'].map(id => provider === 'google_ads'
    ? { ...googleBase(), adGroup: { id: '50' }, adGroupAd: { ad: { id } }, segments: { date },
      metrics: { clicks: '10', costMicros: id === '60' ? '60000000' : '20000000' } }
    : { ...metaBase(), ad_id: id, adset_id: '50', date_start: date, date_stop: date, clicks: '10', spend: id === '60' ? '60.00' : '20.00' }));
  const read = async (path, options) => {
    state.calls.push(provider === 'google_ads' ? path : { path, options });
    if (state.beforeRead) await state.beforeRead(path, options);
    if (provider === 'google_ads') return structuredClone(!path.query.includes('metrics.')
      ? path.query.includes('FROM ad_group_ad') ? state.inventory : state.googleMeta
      : path.query.includes('FROM ad_group_ad') ? state.adRows : state.campaignRows);
    if (path === 'act_20') return { data: structuredClone(state.owner) };
    if (path === '30') return { data: structuredClone(state.campaign) };
    const kind = path === '30/ads' ? 'inventory' : options.params.level === 'ad' ? 'adRows' : 'campaignRows';
    if (state.pages?.[kind]) return structuredClone(state.pages[kind](options));
    return { data: { data: structuredClone(state[kind]) } };
  };
  const options = { reference, accessToken: 'fixture-only-not-a-credential', loginCustomerId: '10', now: () => new Date(state.now), clock: () => state.clock, read };
  const run = () => (provider === 'google_ads' ? inspectGooglePerformance : inspectMetaPerformance)(options);
  return { state, options, reference, period, dates, run };
}

module.exports = { performanceFixture };
