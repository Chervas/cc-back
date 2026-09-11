'use strict';

const { canonicalLeadAdvertisingIdentity } = require('./leadAdvertisingIdentity.service');
const numericId = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
const adKey = ad => ad.groupId ? `${ad.groupId}~${ad.advertisingId || ad.id}` : String(ad.advertisingId || ad.id);

// Attribution remains campaign/account/clinic-bound. Neither names nor free-form UTMs identify an ad.
function createLeadAdMatcher(campaigns, adsByCampaign) {
  const index = new Map(campaigns.map(campaign => [campaign.id, { campaign,
    ads: [...new Map((adsByCampaign.get(campaign.id) || []).map(ad => [adKey(ad), ad])).values()] }]));
  return (lead, campaignId) => {
    const entry = index.get(campaignId);
    if (!lead || !entry?.campaign.assigned || lead.advertising_identity_conflict || Number(lead.clinica_id) !== entry.campaign.clinicId
      || !['paid', null, undefined].includes(lead.channel)) return null;
    const identity = lead.source === 'google_ads' && lead.external_source === 'google_lead_form'
      ? lead.advertising_ad_identity : canonicalLeadAdvertisingIdentity(lead);
    if (!identity || !numericId(identity.ad_id) || identity.provider !== entry.campaign.provider
      || identity.account_id !== entry.campaign.account_id || identity.campaign_id !== entry.campaign.campaign_id) return null;
    const matches = entry.ads.filter(ad => String(ad.advertisingId || ad.id) === identity.ad_id
      && (!identity.adgroup_id || ad.groupId === identity.adgroup_id));
    return matches.length === 1 ? adKey(matches[0]) : null;
  };
}

function evaluateAdComparison(row, period, now = new Date()) {
  const result = { status: 'insufficient', minimumLeads: 10, bestAdId: null };
  if (!row.campaign.assigned) return { ...result, status: 'unassigned' };
  if (row.adAttribution.unattributed.current.leads > 0) return { ...result, status: 'incomplete_attribution' };
  const active = row.ads.filter(ad => ad.active);
  if (!row.campaign.currency) return { ...result, status: 'unknown_currency' };
  if (active.length < 2) return { ...result, status: 'no_comparison' };
  const fresh = value => value && Number.isFinite(+new Date(value)) && +new Date(value) <= +now && +now - +new Date(value) < 36 * 3600000;
  if (active.some(ad => !fresh(ad.lastSeenAt) || !fresh(ad.metricsUpdatedAt) || ad.latestMetricDate !== period.end)) return { ...result, status: 'stale' };
  if (active.some(ad => !(ad.current.leads >= result.minimumLeads) || !(ad.current.spend > 0) || !Number.isFinite(ad.currentCpl))) return result;
  const ordered = [...active].sort((a, b) => a.currentCpl - b.currentCpl);
  if (Math.round(ordered[0].currentCpl * 100) === Math.round(ordered[1].currentCpl * 100)) return { ...result, status: 'tied' };
  return { ...result, status: 'ready', bestAdId: ordered[0].id };
}

module.exports = { adKey, createLeadAdMatcher, evaluateAdComparison };
