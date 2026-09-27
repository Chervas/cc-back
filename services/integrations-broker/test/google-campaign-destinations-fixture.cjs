'use strict';
const { CUSTOMER } = require('./google-ads-fixture.cjs');
function destinationRows() {
  const row = patch => ({ customer: { id: CUSTOMER }, campaign: { id: '30' }, ...patch });
  const form = (id, link, patch = {}) => row({ asset: { id, name: `Form ${id}`, leadFormAsset: { headline: 'Contact' } }, [link]: { status: 'ENABLED' }, ...patch });
  return {
    campaign: [row({ campaign: { id: '30', advertisingChannelType: 'SEARCH', assetAutomationSettings: [] } })],
    ad_groups: [row({ adGroup: { id: '40' } })], campaign_forms: [form('50', 'campaignAsset')],
    account_forms: [form('49', 'customerAsset')], ad_group_forms: [form('51', 'adGroupAsset', { adGroup: { id: '40' } })],
    asset_groups: [row({ assetGroup: { id: '80', campaign: `customers/${CUSTOMER}/campaigns/30`, finalUrls: ['https://clinic.example/pmax'] } })],
    asset_group_forms: [form('52', 'assetGroupAsset', { assetGroup: { id: '80', campaign: `customers/${CUSTOMER}/campaigns/30` } })],
    ads: [row({ adGroup: { id: '40' }, adGroupAd: { ad: { id: '60', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://clinic.example/visit'] } } })],
  };
}
const sectionForQuery = query => ({ campaign: 'campaign', ad_group: 'ad_groups', campaign_asset: 'campaign_forms',
  customer_asset: 'account_forms', ad_group_asset: 'ad_group_forms', asset_group: 'asset_groups',
  asset_group_asset: 'asset_group_forms', ad_group_ad: 'ads' })[query.match(/FROM (\w+)/)?.[1]];
module.exports = { destinationRows, sectionForQuery };
