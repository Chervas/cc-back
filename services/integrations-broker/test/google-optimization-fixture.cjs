'use strict';
const { CUSTOMER } = require('./google-ads-fixture.cjs');
function optimizationRows() {
  const identity = { customer: { id: CUSTOMER }, campaign: { id: '30' } };
  return structuredClone({
    campaign: [{ customer: { id: CUSTOMER, currencyCode: 'EUR' }, campaign: { id: '30', status: 'ENABLED',
      experimentType: 'BASE', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MANUAL_CPC' },
    campaignBudget: { resourceName: `customers/${CUSTOMER}/campaignBudgets/40`, amountMicros: '20000000',
      period: 'DAILY', explicitlyShared: false, referenceCount: '1' } }],
    ad_groups: [{ ...identity, adGroup: { id: '50', status: 'ENABLED', cpcBidMicros: '1500000' } }],
    ads: ['60', '61'].map(id => ({ ...identity, adGroup: { id: '50', status: 'ENABLED' },
      adGroupAd: { ad: { id }, status: 'ENABLED', primaryStatus: 'ELIGIBLE', policySummary: { approvalStatus: 'APPROVED' } } })),
  });
}
const sectionForQuery = query => / FROM ad_group_ad /.test(query) ? 'ads' : / FROM ad_group /.test(query) ? 'ad_groups' : 'campaign';
module.exports = { optimizationRows, sectionForQuery };
