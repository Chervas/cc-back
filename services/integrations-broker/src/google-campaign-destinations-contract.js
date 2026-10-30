'use strict';
const { fail } = require('./errors');

const MAX_ROWS = 2000;
const SECTIONS = Object.freeze(['campaign', 'ad_groups', 'campaign_forms', 'account_forms',
  'ad_group_forms', 'asset_groups', 'asset_group_forms', 'ads']);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// The caller chooses a bounded metadata section, never GAQL, a URL or a credential.
function query({ section, campaignId }, { customerId } = {}) {
  if (!SECTIONS.includes(section) || !id(campaignId) || typeof customerId !== 'string'
    || !/^[0-9]{1,20}$/.test(customerId) || /^0+$/.test(customerId)) fail('invalid_request');
  const formFields = 'asset.id, asset.name, asset.lead_form_asset.headline';
  const campaign = `campaign.id = ${campaignId}`;
  const assetGroup = `asset_group.campaign = 'customers/${customerId}/campaigns/${campaignId}'`;
  const queries = {
    campaign: `SELECT customer.id, campaign.id, campaign.advertising_channel_type, campaign.asset_automation_settings FROM campaign WHERE ${campaign} AND campaign.status != 'REMOVED'`,
    ad_groups: `SELECT customer.id, campaign.id, ad_group.id FROM ad_group WHERE ${campaign} AND ad_group.status != 'REMOVED'`,
    campaign_forms: `SELECT customer.id, campaign.id, campaign_asset.status, ${formFields} FROM campaign_asset WHERE ${campaign} AND campaign_asset.field_type = 'LEAD_FORM' AND campaign_asset.status = 'ENABLED'`,
    account_forms: `SELECT customer.id, customer_asset.status, ${formFields} FROM customer_asset WHERE customer_asset.field_type = 'LEAD_FORM' AND customer_asset.status = 'ENABLED'`,
    ad_group_forms: `SELECT customer.id, campaign.id, ad_group.id, ad_group_asset.status, ${formFields} FROM ad_group_asset WHERE ${campaign} AND ad_group_asset.field_type = 'LEAD_FORM' AND ad_group_asset.status = 'ENABLED'`,
    asset_groups: `SELECT customer.id, asset_group.id, asset_group.campaign, asset_group.final_urls, asset_group.final_mobile_urls FROM asset_group WHERE ${assetGroup} AND asset_group.status != 'REMOVED'`,
    asset_group_forms: `SELECT customer.id, asset_group.id, asset_group.campaign, asset_group_asset.status, ${formFields} FROM asset_group_asset WHERE ${assetGroup} AND asset_group_asset.field_type = 'LEAD_FORM' AND asset_group_asset.status = 'ENABLED'`,
    ads: `SELECT customer.id, campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls FROM ad_group_ad WHERE ${campaign} AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`,
  };
  return `${queries[section]} LIMIT ${MAX_ROWS + 1}`;
}

function text(value, max = 1024) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\x00-\x1f]/.test(value)) fail('provider_failed');
  return value;
}
function enumText(value) {
  const result = text(value, 100);
  if (!/^[A-Z][A-Z0-9_]*$/.test(result)) fail('provider_failed');
  return result;
}
function list(value, max, project) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail('provider_failed');
  return value.map(project);
}
function urls(value) {
  return list(value, 20, raw => {
    const value = text(raw, 4096); let url;
    try { url = new URL(value); } catch { fail('provider_failed'); }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('provider_failed');
    return value;
  });
}
function project(row, { section, campaignId }, { customerId }) {
  if (!SECTIONS.includes(section) || !plain(row) || row.customer?.id !== customerId) fail('provider_failed');
  const result = { customer: { id: customerId } };
  const assetGroupSection = ['asset_groups', 'asset_group_forms'].includes(section);
  if (section !== 'account_forms' && !assetGroupSection) {
    if (row.campaign?.id !== campaignId) fail('provider_failed');
    result.campaign = { id: campaignId };
  }
  if (section === 'campaign') {
    result.campaign.advertisingChannelType = enumText(row.campaign.advertisingChannelType);
    result.campaign.assetAutomationSettings = list(row.campaign.assetAutomationSettings, 30, item => {
      if (!plain(item)) fail('provider_failed');
      return { assetAutomationType: enumText(item.assetAutomationType), assetAutomationStatus: enumText(item.assetAutomationStatus) };
    });
  }
  if (['ad_groups', 'ad_group_forms', 'ads'].includes(section)) {
    if (!id(row.adGroup?.id)) fail('provider_failed');
    result.adGroup = { id: row.adGroup.id };
  }
  if (assetGroupSection) {
    const group = row.assetGroup;
    if (!id(group?.id) || group.campaign !== `customers/${customerId}/campaigns/${campaignId}`) fail('provider_failed');
    result.assetGroup = { id: group.id, campaign: group.campaign };
    if (section === 'asset_groups') Object.assign(result.assetGroup, { finalUrls: urls(group.finalUrls), finalMobileUrls: urls(group.finalMobileUrls) });
  }
  if (section.endsWith('_forms')) {
    const link = { campaign_forms: 'campaignAsset', account_forms: 'customerAsset', ad_group_forms: 'adGroupAsset', asset_group_forms: 'assetGroupAsset' }[section];
    if (row[link]?.status !== 'ENABLED' || !id(row.asset?.id) || !row.asset.leadFormAsset?.headline) fail('provider_failed');
    result[link] = { status: 'ENABLED' };
    result.asset = { id: row.asset.id, name: text(row.asset.name ?? ''), leadFormAsset: { headline: text(row.asset.leadFormAsset.headline) } };
  }
  if (section === 'ads') {
    const ad = row.adGroupAd?.ad;
    if (!id(ad?.id)) fail('provider_failed');
    result.adGroupAd = { ad: { id: ad.id, type: enumText(ad.type), finalUrls: urls(ad.finalUrls), finalMobileUrls: urls(ad.finalMobileUrls) } };
  }
  return result;
}

module.exports = { MAX_ROWS, SECTIONS, query, project };
