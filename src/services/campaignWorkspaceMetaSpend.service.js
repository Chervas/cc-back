'use strict';

const { externalCampaignIdentityKey } = require('./externalCampaignAssignmentTargets.service');
const { adKey } = require('./campaignAdAttribution.service');
const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const account = value => typeof value === 'string' && /^(act_)?[1-9][0-9]{0,63}$/.test(value)
  ? value.replace(/^act_/, '') : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function identity(value) {
  if (value?.provider !== 'meta_ads' || !account(value.account_id) || !graphId(value.campaign_id)) return null;
  if (value.customer_id != null && account(value.customer_id) !== account(value.account_id)) return null;
  return externalCampaignIdentityKey(value);
}

// `ads` is the server-side result of loadWorkspaceAds: account-bound ad ->
// adset -> authorized campaign joins, never a browser assignment or provider row.
// Return facts only for missing native campaign days. Keep each ad/placement
// segment so the report's existing deduplication cannot merge distinct ads.
function deriveMetaCampaignSpendFacts({ campaigns, facts = [], ads = [] }) {
  const allowed = new Set(campaigns.map(identity).filter(Boolean));
  const nativeDays = new Set();
  for (const fact of facts) {
    const key = identity(fact);
    if (key && allowed.has(key) && day(fact.date)) nativeDays.add(JSON.stringify([key, fact.date]));
  }
  const seen = new Set(); const result = [];
  for (const ad of ads) {
    const key = identity(ad);
    if (!key || !allowed.has(key) || ad.inventory === true || !day(ad.date)
      || !graphId(ad.id) || !graphId(ad.groupId)
      || typeof ad.spend !== 'number' || !Number.isFinite(ad.spend) || ad.spend < 0
      || !Array.isArray(ad.segment) || ad.segment.some(value => typeof value !== 'string')
      || nativeDays.has(JSON.stringify([key, ad.date]))) continue;
    const dedupe = JSON.stringify([key, adKey(ad), ad.date, ad.segment]);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    result.push({ provider: 'meta_ads', account_id: account(ad.account_id), campaign_id: ad.campaign_id,
      date: ad.date, segment: ['meta_ad', ad.groupId, ad.id, ...ad.segment], spend: ad.spend,
      // Never let a fresh entity inventory timestamp refresh old metric evidence.
      updatedAt: ad.metricsUpdatedAt ?? null, spendSource: 'meta_ads_ad_rollup' });
  }
  return result;
}
module.exports = { deriveMetaCampaignSpendFacts };
