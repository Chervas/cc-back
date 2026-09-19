'use strict';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value) ? value : null;
const WEB_AD_SOURCES = ['web', 'google_ads', 'meta_ads', 'call_click', 'seo', 'direct'];
const WEB_AD_FIELDS = ['cc_gads_ad_id', 'cc_gads_adgroup_id', 'cc_meta_account_id', 'cc_meta_campaign_id', 'cc_meta_ad_id', 'cc_meta_adset_id'];
const FIELDS = {
  google_ads: { account_id: ['cc_gads_customer_id', 'google_ads_customer_id'], campaign_id: ['cc_gads_campaign_id', 'google_ads_campaign_id'],
    ad_id: ['cc_gads_ad_id', 'google_ads_ad_id'], adgroup_id: ['cc_gads_adgroup_id', 'google_ads_adgroup_id'] },
  meta_ads: { account_id: ['cc_meta_account_id', 'meta_ads_account_id'], campaign_id: ['cc_meta_campaign_id', 'meta_ads_campaign_id'],
    ad_id: ['cc_meta_ad_id', 'meta_ads_ad_id'], adgroup_id: ['cc_meta_adset_id', 'meta_ads_adset_id'] },
};

function extractWebAdAttribution(input) {
  input = object(input);
  const sources = [input, object(input.attribution)];
  const urls = sources.flatMap(source => [source.page_url, source.landing_url]).filter(Boolean).map(value => {
    try { return new URL(value).searchParams; } catch { return null; }
  }).filter(Boolean);
  const candidates = []; let providers = 0;
  for (const [provider, fields] of Object.entries(FIELDS)) {
    const result = { provider }; let present = false;
    for (const [field, aliases] of Object.entries(fields)) {
      const raw = aliases.flatMap(name => [...sources.map(source => source[name]), ...urls.flatMap(params => params.getAll(name))])
        .filter(value => value !== undefined && value !== null && value !== '');
      if (raw.length) present = true;
      const values = [...new Set(raw.map(value => {
        if (field === 'account_id' && typeof value === 'string') value = provider === 'meta_ads' ? value.replace(/^act_/, '') : value.replace(/-/g, '');
        return field === 'account_id' && provider === 'google_ads' ? (typeof value === 'string' && /^[0-9]{10}$/.test(value) ? value : null) : id(value);
      }))];
      if (values.length > 1 || values.includes(null)) return null;
      result[field] = values[0] || null;
    }
    if (present) providers++;
    if (result.account_id && result.campaign_id && result.ad_id) candidates.push(result);
  }
  return providers === 1 && candidates.length === 1 ? candidates[0] : null;
}

function webAdAdvertisingIdentity(value, clinicId) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.version !== 1 || value.verified_by !== 'workspace_web_ad_inventory'
    || !Object.hasOwn(FIELDS, value.provider) || !Number.isSafeInteger(value.clinic_id) || value.clinic_id !== Number(clinicId) || value.clinic_id < 1
    || !id(value.account_id) || !id(value.campaign_id) || !id(value.ad_id) || !id(value.adgroup_id)
    || value.provider === 'google_ads' && !/^[0-9]{10}$/.test(value.account_id)
    || !Number.isSafeInteger(value.intake_config_id) || value.intake_config_id < 1
    || !/^[a-f0-9]{64}$/.test(value.web_fingerprint || '')
    || typeof value.verified_at !== 'string' || !Number.isFinite(+new Date(value.verified_at))) return null;
  return { version: 1, verified_by: value.verified_by, provider: value.provider, clinic_id: value.clinic_id,
    account_id: value.account_id, campaign_id: value.campaign_id, ad_id: value.ad_id, adgroup_id: value.adgroup_id,
    intake_config_id: value.intake_config_id, web_fingerprint: value.web_fingerprint, verified_at: value.verified_at };
}

module.exports = { WEB_AD_FIELDS, WEB_AD_SOURCES, extractWebAdAttribution, webAdAdvertisingIdentity };
