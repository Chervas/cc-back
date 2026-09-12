'use strict';

const { qualifiedFixture } = require('./campaign_workspace_optimization_evidence.fixture');
const { inspectGoogleSearchTerms } = require('../../../services/campaignWorkspaceSearchTerms.service');
const { googleAdsSearchRows } = require('../../../lib/googleAdsSearchRows');

function searchTermsFixture(channel = 'SEARCH') {
  const f = qualifiedFixture('google_ads'); const pmax = channel === 'PERFORMANCE_MAX';
  f.input.action = 'negative_keywords'; f.state.googleMeta[0].campaign.advertisingChannelType = channel;
  const authorization = f.state.setting.activation.optimization.authorization;
  authorization.limits.actions = ['negative_keywords'];
  authorization.campaigns[0].targets = [{ action: 'negative_keywords', entity: 'campaign', id: '30',
    resource: 'customers/20/campaigns/30', field: 'keyword', match_type: 'EXACT' }];
  f.state.campaignRows.forEach(row => Object.assign(row.metrics, { conversions: 1.5, allConversions: 2 }));
  const row = (text, date = f.performance.dates[0], group = '50', metrics = {}) => ({ customer: { id: '20' }, campaign: { id: '30' },
    ...(pmax ? { campaignSearchTermView: { campaign: 'customers/20/campaigns/30', searchTerm: text,
      resourceName: `customers/20/campaignSearchTermViews/30~${Buffer.from(text).toString('base64url')}` } }
      : { adGroup: { id: group }, searchTermView: { status: 'NONE', searchTerm: text,
        resourceName: `customers/20/searchTermViews/30~${group}~${Buffer.from(text).toString('base64url')}` } }),
    segments: { date }, metrics: { clicks: '4', costMicros: '2000000', conversions: 0, allConversions: 0, ...metrics } });
  f.state.termRows = [row('ofertas de trabajo dentista'), row('implantes dentales', f.performance.dates[1], '51', { conversions: 0.25, allConversions: 0.5 })];
  const previousRequest = f.deps.googleRequest;
  f.deps.googleRequest = async (method, path, options) => {
    if (/FROM (campaign_)?search_term_view\b/.test(options.data.query)) {
      f.state.calls.push({ query: options.data.query, pageToken: options.data.pageToken });
      if (f.state.beforeRead) await f.state.beforeRead({ query: options.data.query, pageToken: options.data.pageToken });
      if (f.state.termResponse) return f.state.termResponse(options);
      const start = Number(options.data.pageToken || 0); const count = f.state.pageSize || f.state.termRows.length;
      return { results: structuredClone(f.state.termRows.slice(start, start + count)),
        ...(count && start + count < f.state.termRows.length ? { nextPageToken: String(start + count) } : {}) };
    }
    return previousRequest(method, path, options);
  };
  return { ...f, row, snapshot: () => inspectGoogleSearchTerms({ reference: f.input.reference, accessToken: 'fixture-only',
    now: f.deps.now, clock: f.deps.clock, read: options => googleAdsSearchRows({ ...options, request: f.deps.googleRequest }) }) };
}

module.exports = { searchTermsFixture };
