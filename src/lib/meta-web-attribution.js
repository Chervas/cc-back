'use strict';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const id = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
const account = value => id(typeof value === 'string' ? value.trim().replace(/^act_/i, '') : value);
const WEB_LEAD_SOURCES = ['meta_ads', 'web', 'call_click', 'seo', 'direct'];

function extractMetaWebAttribution(input = {}) {
  input = object(input);
  const sources = [input, object(input.attribution), object(input.custom_data), object(input.event_data)];
  const accounts = []; const campaigns = [];
  for (const source of sources) {
    accounts.push(source.cc_meta_account_id, source.meta_ads_account_id, source.ad_account_id);
    campaigns.push(source.cc_meta_campaign_id, source.meta_ads_campaign_id);
    for (const value of [source.page_url, source.landing_url, source.event_source_url]) {
      try {
        const params = new URL(value).searchParams;
        accounts.push(params.get('cc_meta_account_id'), params.get('meta_ads_account_id'));
        campaigns.push(params.get('cc_meta_campaign_id'), params.get('meta_ads_campaign_id'));
      } catch { /* Missing URLs are not attribution. */ }
    }
  }
  const unique = (values, normalize) => [...new Set(values.filter(value => value != null && value !== '').map(normalize))];
  const accountIds = unique(accounts, account); const campaignIds = unique(campaigns, id);
  if (campaignIds.length !== 1 || !campaignIds[0] || accountIds.length > 1 || accountIds.includes(null)) return null;
  return { account_id: accountIds[0] || null, campaign_id: campaignIds[0] };
}

function metaWebAdvertisingIdentity(value, clinicId) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.version !== 2 || value.verified_by !== 'workspace_web_inventory' || value.provider !== 'meta_ads'
    || value.clinic_id !== Number(clinicId) || !Number.isSafeInteger(value.clinic_id) || value.clinic_id < 1
    || !id(value.account_id) || !id(value.campaign_id) || !Number.isSafeInteger(value.intake_config_id) || value.intake_config_id < 1
    || !/^[a-f0-9]{64}$/.test(value.web_fingerprint || '') || !/^[a-f0-9]{64}$/.test(value.campaign_binding || '')) return null;
  return { version: 2, verified_by: 'workspace_web_inventory', provider: 'meta_ads', clinic_id: value.clinic_id,
    account_id: value.account_id, campaign_id: value.campaign_id, intake_config_id: value.intake_config_id,
    web_fingerprint: value.web_fingerprint, campaign_binding: value.campaign_binding };
}

module.exports = { extractMetaWebAttribution, metaWebAdvertisingIdentity, WEB_LEAD_SOURCES };
