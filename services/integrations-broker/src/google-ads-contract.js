'use strict';
const { schema } = require('./contracts');
const { fail } = require('./errors');
const leads = require('./google-leads-contract');
const PROVIDER = 'google_ads';
const PREFIX = 'google.ads.';
const API_VERSION = 'v24';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/adwords']);
const FAMILIES = Object.freeze(['account', 'campaigns', 'campaign_metrics', 'adgroup_metrics',
  'publishing_campaigns', 'landing_pages', 'ads', 'ad_metrics', 'discovery', 'conversion_actions', 'conversion_settings', 'leads']);
const singleResult = name => ['account', 'discovery', 'conversion_settings'].includes(name);
const OPERATIONS = Object.freeze(FAMILIES.map(name => PREFIX + name + '.read.v1'));
const REVOKE_OPERATION = PREFIX + 'asset.revoke.v1';
const PROVIDER_PAGE_SIZE = 10000;
const PAGE_SIZE = 250;
const MAX_ROWS = 100000;
const rowLimit = name => singleResult(name) ? 1 : name === 'leads' ? leads.MAX_ROWS : ['campaigns', 'publishing_campaigns', 'conversion_actions'].includes(name) ? 5000
  : ['ads', 'ad_metrics'].includes(name) ? 200000 : MAX_ROWS;
const RESOURCE_FIELDS = ['customer.id', 'campaign.id', 'campaign.name', 'campaign.status',
  'campaign.serving_status', 'campaign.primary_status', 'campaign.primary_status_reasons'];
const METRICS = ['impressions', 'clicks', 'cost_micros', 'conversions', 'conversions_value',
  'all_conversions', 'all_conversions_value', 'interactions'];
const AD_FIELDS = ['customer.id', 'campaign.id', 'campaign.name', 'campaign.status', 'ad_group.id', 'ad_group.name',
  'ad_group.status', 'ad_group_ad.status', 'ad_group_ad.ad.id', 'ad_group_ad.ad.name', 'ad_group_ad.ad.type'];
const AD_CREATIVE_FIELDS = ['ad_group_ad.ad.final_urls', 'ad_group_ad.ad.final_mobile_urls',
  'ad_group_ad.ad.responsive_search_ad.headlines', 'ad_group_ad.ad.responsive_search_ad.descriptions',
  'ad_group_ad.primary_status', 'ad_group_ad.primary_status_reasons',
  'ad_group_ad.policy_summary.approval_status', 'ad_group_ad.policy_summary.review_status'];
const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const customer = value => typeof value === 'string' && /^[0-9]{10}$/.test(value) && value !== '0000000000';
const integerId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function resource(binding, assetRef) {
  const row = binding?.googleAdsAccounts?.find(item => item.assetRef === assetRef);
  if (!row || !customer(row.customerId) || assetRef !== 'ads:' + row.customerId
    || row.loginCustomerId !== null && !customer(row.loginCustomerId)) fail('scope_denied');
  return { customerId: row.customerId, loginCustomerId: row.loginCustomerId };
}
const cursor = { pageToken: { type: ['string', 'null'], maxLength: 4096 } };
const windowFields = { startDate: { type: 'string' }, endDate: { type: 'string' } };
const campaignFilter = { campaignId: { type: ['string', 'null'], pattern: '^[1-9][0-9]{0,19}$' } };
const validators = { account: schema({}), discovery: schema({}), conversion_settings: schema({}), campaigns: schema(cursor), conversion_actions: schema(cursor),
  leads: schema({ ...cursor, sinceDate: { type: 'string' } }),
  campaign_metrics: schema({ ...cursor, ...windowFields }), adgroup_metrics: schema({ ...cursor, ...windowFields }),
  publishing_campaigns: schema(cursor), landing_pages: schema({ ...cursor, ...windowFields }),
  ads: schema({ ...cursor, ...campaignFilter }), ad_metrics: schema({ ...cursor, ...campaignFilter, ...windowFields }) };
function family(operation) {
  const index = OPERATIONS.indexOf(operation); if (index < 0) fail('operation_denied'); return FAMILIES[index];
}
function validate(operation, payload) {
  const name = family(operation); validators[name](payload);
  if (name === 'leads' && !leads.date(payload.sinceDate)) fail('invalid_request');
  const maxDays = name === 'landing_pages' ? 30 : 15;
  if ((name.endsWith('_metrics') || name === 'landing_pages') && (!date(payload.startDate) || !date(payload.endDate)
    || payload.endDate < payload.startDate || Date.parse(payload.endDate) - Date.parse(payload.startDate) > (maxDays - 1) * 86400000)) fail('invalid_request');
  return payload;
}
function query(name, payload) {
  if (!FAMILIES.includes(name)) fail('operation_denied');
  validate(PREFIX + name + '.read.v1', payload);
  if (name === 'leads') return leads.query(payload);
  if (name === 'discovery') return 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 2';
  if (name === 'account') return 'SELECT customer.id, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 2';
  if (name === 'conversion_settings') return 'SELECT customer.id, customer.conversion_tracking_setting.accepted_customer_data_terms, customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 2';
  if (name === 'conversion_actions') return 'SELECT customer.id, conversion_action.id, conversion_action.resource_name, conversion_action.owner_customer, conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.status, conversion_action.counting_type, conversion_action.include_in_conversions_metric, conversion_action.primary_for_goal FROM conversion_action LIMIT 5001';
  if (name === 'campaigns') return `SELECT ${RESOURCE_FIELDS.join(', ')} FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED') LIMIT 5001`;
  if (name === 'publishing_campaigns') return `SELECT ${[...RESOURCE_FIELDS, 'campaign.advertising_channel_type',
    'campaign.final_url_suffix', 'campaign.asset_automation_settings'].join(', ')} FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED') LIMIT 5001`;
  if (name === 'landing_pages') return `SELECT customer.id, campaign.id, campaign.name, landing_page_view.unexpanded_final_url, metrics.clicks FROM landing_page_view WHERE segments.date BETWEEN '${payload.startDate}' AND '${payload.endDate}' LIMIT 100001`;
  if (name === 'ads' || name === 'ad_metrics') {
    const fields = [...AD_FIELDS, ...(name === 'ads' ? AD_CREATIVE_FIELDS
      : ['segments.date', 'segments.ad_network_type', 'segments.device', ...METRICS.slice(0, 4).map(key => `metrics.${key}`)])];
    const conditions = ["ad_group_ad.status IN ('ENABLED', 'PAUSED', 'REMOVED')"];
    if (payload.campaignId !== null) conditions.push(`campaign.id = ${payload.campaignId}`);
    if (name === 'ad_metrics') conditions.push(`segments.date BETWEEN '${payload.startDate}' AND '${payload.endDate}'`);
    return `SELECT ${fields.join(', ')} FROM ad_group_ad WHERE ${conditions.join(' AND ')} LIMIT 200001`;
  }
  const fields = [...RESOURCE_FIELDS, 'segments.date', 'segments.ad_network_type', 'segments.device', ...METRICS.map(key => `metrics.${key}`)];
  const groups = name === 'adgroup_metrics';
  if (groups) fields.push('ad_group.id', 'ad_group.name');
  return `SELECT ${fields.join(', ')} FROM ${groups ? 'ad_group' : 'campaign'} WHERE segments.date BETWEEN '${payload.startDate}' AND '${payload.endDate}' AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')${groups ? " AND ad_group.status IN ('ENABLED', 'PAUSED', 'REMOVED')" : ''} LIMIT 100001`;
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\x00-\x1f]/.test(value)) fail('provider_failed');
  return value;
}
function enumText(value) {
  const result = text(value, 64);
  if (result && !/^[A-Z][A-Z0-9_]*$/.test(result)) fail('provider_failed'); return result;
}
const camel = value => value.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function numeric(value, integer) {
  if (value === undefined) return 0;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value))
    || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER
    || integer && !Number.isSafeInteger(Number(value))) fail('provider_failed');
  return value;
}
function list(value, max, project) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail('provider_failed');
  return value.map(project);
}
// URLs are observation data only. They are never fetched by this service.
function urlText(value) {
  const result = text(value, 4096); let url;
  try { url = new URL(result); } catch { fail('provider_failed'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('provider_failed');
  return result;
}
function projectAd(row, payload, result, inventory) {
  const group = row.adGroup; const groupAd = row.adGroupAd; const ad = groupAd?.ad;
  if (!plain(group) || !integerId(group.id) || !plain(groupAd) || !plain(ad) || !integerId(ad.id)
    || !['ENABLED', 'PAUSED', 'REMOVED'].includes(group.status)
    || !['ENABLED', 'PAUSED', 'REMOVED'].includes(groupAd.status)
    || payload.campaignId !== null && result.campaign.id !== payload.campaignId) fail('provider_failed');
  const type = enumText(ad.type); if (!type) fail('provider_failed');
  result.adGroup = { id: group.id, name: text(group.name, 1024), status: group.status };
  result.adGroupAd = { status: groupAd.status, ad: { id: ad.id, name: text(ad.name, 1024), type } };
  if (!inventory) return;
  const rsa = ad.responsiveSearchAd; const policy = groupAd.policySummary;
  if (rsa !== undefined && !plain(rsa) || policy !== undefined && !plain(policy)) fail('provider_failed');
  const asset = item => { if (!plain(item)) fail('provider_failed'); return { text: text(item.text, 1024) }; };
  Object.assign(result.adGroupAd.ad, { finalUrls: list(ad.finalUrls, 20, urlText), finalMobileUrls: list(ad.finalMobileUrls, 20, urlText),
    responsiveSearchAd: { headlines: list(rsa?.headlines, 15, asset), descriptions: list(rsa?.descriptions, 4, asset) } });
  Object.assign(result.adGroupAd, { primaryStatus: enumText(groupAd.primaryStatus),
    primaryStatusReasons: list(groupAd.primaryStatusReasons, 50, enumText),
    policySummary: { approvalStatus: enumText(policy?.approvalStatus), reviewStatus: enumText(policy?.reviewStatus) } });
}
function rowKey(result) {
  if (result.leadFormSubmissionData) return JSON.stringify([result.customer.id, 'lead', result.leadFormSubmissionData.id]);
  if (result.conversionAction) return JSON.stringify([result.customer.id, 'conversion_action', result.conversionAction.id]);
  return JSON.stringify([result.customer.id, result.campaign?.id, result.adGroup?.id, result.adGroupAd?.ad?.id,
    result.landingPageView?.unexpandedFinalUrl, result.segments?.date, result.segments?.adNetworkType, result.segments?.device]);
}
function projectPage(name, raw, payload, account) {
  if (!FAMILIES.includes(name) || !plain(raw) || raw.error || raw.errors || raw.partialFailureError || raw.partial_failure_error
    || raw.results !== undefined && !Array.isArray(raw.results)) fail('provider_failed');
  const rows = raw.results || [];
  if (rows.length > PROVIDER_PAGE_SIZE || singleResult(name) && rows.length !== 1) fail('provider_failed');
  const results = rows.map(row => {
    if (!plain(row) || !plain(row.customer) || row.customer.id !== account.customerId) fail('provider_failed');
    if (name === 'leads') return leads.project(row, payload, account);
    if (name === 'conversion_settings') {
      const settings = row.customer.conversionTrackingSetting;
      if (settings !== undefined && !plain(settings)) fail('provider_failed');
      const flag = value => {
        if (value == null) return null;
        if (typeof value !== 'boolean') fail('provider_failed'); return value;
      };
      const owner = settings?.googleAdsConversionCustomer;
      if (owner != null && (typeof owner !== 'string' || !/^customers\/[0-9]{10}$/.test(owner)
        || !customer(owner.slice('customers/'.length)))) fail('provider_failed');
      return { customer: { id: account.customerId, conversionTrackingSetting: {
        acceptedCustomerDataTerms: flag(settings?.acceptedCustomerDataTerms),
        enhancedConversionsForLeadsEnabled: flag(settings?.enhancedConversionsForLeadsEnabled),
        googleAdsConversionCustomer: owner ?? null,
      } } };
    }
    if (name === 'conversion_actions') {
      const action = row.conversionAction;
      if (!plain(action) || !integerId(action.id) || typeof action.resourceName !== 'string'
        || !new RegExp(`^customers/[0-9]{10}/conversionActions/${action.id}$`).test(action.resourceName || '')) fail('provider_failed');
      const nullableBoolean = value => {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'boolean') fail('provider_failed'); return value;
      };
      if (action.ownerCustomer != null && (typeof action.ownerCustomer !== 'string'
        || !/^customers\/[0-9]{10}$/.test(action.ownerCustomer))) fail('provider_failed');
      // Cross-account actions retain their actual resource owner. Preparation
      // must reject a foreign owner, never reconstruct an apparently local ID.
      return { customer: { id: account.customerId }, conversionAction: {
        id: action.id, resourceName: action.resourceName, ownerCustomer: action.ownerCustomer ?? null, name: text(action.name, 1024),
        category: enumText(action.category), type: enumText(action.type), status: enumText(action.status),
        countingType: enumText(action.countingType), primaryForGoal: nullableBoolean(action.primaryForGoal),
        includeInConversionsMetric: nullableBoolean(action.includeInConversionsMetric) } };
    }
    if (['account', 'discovery'].includes(name)) {
      if (row.customer.manager !== undefined && (typeof row.customer.manager !== 'boolean' || name === 'account' && row.customer.manager !== false)
        || !/^[A-Z]{3}$/.test(row.customer.currencyCode || '')) fail('provider_failed');
      const timeZone = text(row.customer.timeZone, 128);
      try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); } catch { fail('provider_failed'); }
      if (!timeZone) fail('provider_failed');
      const summary = { id: account.customerId, manager: row.customer.manager === true, currencyCode: row.customer.currencyCode, timeZone };
      if (name === 'discovery') {
        if (!['ENABLED', 'CANCELED', 'CLOSED', 'SUSPENDED', 'UNKNOWN', 'UNSPECIFIED'].includes(row.customer.status)) fail('provider_failed');
        summary.descriptiveName = text(row.customer.descriptiveName, 1024); summary.status = row.customer.status;
      }
      return { customer: summary };
    }
    const c = row.campaign;
    if (name === 'landing_pages') {
      if (!plain(c) || !integerId(c.id) || !plain(row.landingPageView)
        || row.metrics !== undefined && !plain(row.metrics)) fail('provider_failed');
      return { customer: { id: account.customerId }, campaign: { id: c.id, name: text(c.name, 1024) },
        landingPageView: { unexpandedFinalUrl: urlText(row.landingPageView.unexpandedFinalUrl) },
        metrics: { clicks: numeric(row.metrics?.clicks, true) } };
    }
    if (!plain(c) || !integerId(c.id) || !['ENABLED', 'PAUSED', 'REMOVED'].includes(c.status)) fail('provider_failed');
    const reasons = c.primaryStatusReasons ?? [];
    if (!Array.isArray(reasons) || reasons.length > 50) fail('provider_failed');
    const result = { customer: { id: account.customerId }, campaign: { id: c.id, name: text(c.name, 1024), status: c.status,
      servingStatus: enumText(c.servingStatus), primaryStatus: enumText(c.primaryStatus), primaryStatusReasons: reasons.map(enumText) } };
    if (name === 'campaigns') return result;
    if (name === 'publishing_campaigns') {
      if (c.status === 'REMOVED') fail('provider_failed');
      const advertisingChannelType = enumText(c.advertisingChannelType); if (!advertisingChannelType) fail('provider_failed');
      Object.assign(result.campaign, { advertisingChannelType, finalUrlSuffix: text(c.finalUrlSuffix, 4096),
        assetAutomationSettings: list(c.assetAutomationSettings, 50, item => {
          if (!plain(item)) fail('provider_failed');
          const assetAutomationType = enumText(item.assetAutomationType); const assetAutomationStatus = enumText(item.assetAutomationStatus);
          if (!assetAutomationType || !assetAutomationStatus) fail('provider_failed');
          return { assetAutomationType, assetAutomationStatus };
        }) });
      return result;
    }
    if (name === 'ads' || name === 'ad_metrics') projectAd(row, payload, result, name === 'ads');
    if (name === 'ads') return result;
    if (!plain(row.segments) || !date(row.segments.date) || row.segments.date < payload.startDate || row.segments.date > payload.endDate
      || row.metrics !== undefined && !plain(row.metrics)) fail('provider_failed');
    const device = enumText(row.segments.device); const adNetworkType = enumText(row.segments.adNetworkType);
    if (!device || !adNetworkType) fail('provider_failed');
    result.segments = { date: row.segments.date, device, adNetworkType };
    result.metrics = Object.fromEntries((name === 'ad_metrics' ? METRICS.slice(0, 4) : METRICS).map(key => [camel(key), numeric(row.metrics?.[camel(key)], ['impressions', 'clicks', 'cost_micros', 'interactions'].includes(key))]));
    if (name === 'adgroup_metrics') {
      if (!plain(row.adGroup) || !integerId(row.adGroup.id)) fail('provider_failed');
      result.adGroup = { id: row.adGroup.id, name: text(row.adGroup.name, 1024) };
    }
    return result;
  });
  const seen = new Set();
  for (const result of results) {
    const key = rowKey(result);
    if (seen.has(key)) fail('provider_failed'); seen.add(key);
  }
  const nextPageToken = raw.nextPageToken === undefined || raw.nextPageToken === '' ? null : raw.nextPageToken;
  if (nextPageToken !== null && (typeof nextPageToken !== 'string' || !/^[\x21-\x7e]{1,1536}$/.test(nextPageToken)
    || !results.length || singleResult(name))) fail('provider_failed');
  if (Buffer.byteLength(JSON.stringify(results)) > 16 * 1024 * 1024) fail('provider_failed');
  return { results, nextPageToken };
}
// This metadata is added by the broker from its validated binding, never read
// from Google's response. Presence of configuration is not provider validation.
function dataManagerConfiguration(value) {
  if (!plain(value) || Object.keys(value).join(',') !== 'quotaProjectConfigured'
    || typeof value.quotaProjectConfigured !== 'boolean') fail('provider_failed');
  return { quotaProjectConfigured: value.quotaProjectConfigured };
}
module.exports = { PROVIDER, PREFIX, API_VERSION, SCOPES, FAMILIES, OPERATIONS, REVOKE_OPERATION,
  PROVIDER_PAGE_SIZE, PAGE_SIZE, MAX_ROWS, resource, customer, family, validate, query, projectPage, rowKey, rowLimit,
  singleResult, dataManagerConfiguration };
